//! 前端可调用的 Tauri 命令。
//!
//! 分三类，**动手加一个之前先分清自己要写的是哪一类**：
//!
//! - **只读查询**（大多数）：UI 轮询，或收到 `stats-updated` 事件后调用。
//! - **会写东西的**：改设置、装 WPS 加载项、导出文件、开资源管理器、改开机自启。
//!   它们写的是设置和文件，**统计数字一行都不写**——那几张表只有采集线程里的
//!   `db::write_batch` 写，这是「同一分钟只有一个写入者」的前提。
//!   （本文件里一条裸 SQL 都没有，全部走 `db::`，所以这条是能一眼查的。）
//! - **要出网的**：只有 `report_generate` 和 `report_catchup`。它们必须是 `async fn`，
//!   而且必须让开数据库锁——单次最长几十秒，持着锁等就是全界面一起卡死，
//!   而同步的 `#[tauri::command]` 在 Tauri 2 里跑在主线程上，还会把 webview 冻住。
//!   三段式的理由写在 `report_generate` 上面。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{Manager, State};

use crate::adapters::wps;
use crate::db;
use crate::export;
use crate::hook;
use crate::report;
use crate::report::llm;
use crate::report::period::{self, PeriodType};

pub struct AppState {
    /// 专门的读连接。采集线程独占写连接，两边靠 WAL 并行。
    pub db: Mutex<Connection>,
    pub hook: hook::Hook,
    /// 插件上报用的 token。启动时从设置表读出或新建。
    pub adapter_token: String,
    /// 接收端实际监听的端口。`None` 表示端口全被占用，没起来。
    pub adapter_port: Option<u16>,
    /// 正在生成的期次，键是 `"{期次类型}:{期次键}"`。见 `report::InFlight`。
    ///
    /// 和 `db` 是两把锁：生成一期时这一把只在占坑那一瞬间拿着，
    /// 所以「生成报告」不会挡住别的页面查数据。
    pub report_busy: Mutex<HashSet<String>>,
    /// 数据库文件的位置。报告页要把它写在界面上（「密钥就存在这个文件里」），
    /// 而这里是唯一知道自己是从哪个文件起来的地方。
    pub db_path: PathBuf,
}

/// 把 rusqlite 错误转成前端能读的字符串。
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// `export::export_dir` 的退路：数据库所在目录。
///
/// 只在读不到 `%USERPROFILE%` 时才用得上。抽出来是因为现在有三处要它
/// （导出数据、打开导出目录、存出适配器文件），而三份拷贝里任何一份写错
/// 都不会报错——它会在一个意外的地方建目录，且看上去一切正常。
fn export_fallback(state: &AppState) -> PathBuf {
    state
        .db_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| state.db_path.clone())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodaySummary {
    pub day: String,
    pub key_input: i64,
    pub key_delete: i64,
    pub key_other: i64,
    pub char_input: i64,
    pub char_delete: i64,
    /// 净字数 = 敲进去的 − 删掉的
    pub net_chars: i64,
    /// 删除率 = 删掉的 ÷ 敲进去的
    pub delete_rate: f64,
    /// 今天是否有任何精确字数数据。false 时 UI 应只展示按键口径。
    pub has_char_data: bool,
    /// 有精确字数的那部分按键数。除以 `key_input` 就是字数口径的覆盖率。
    ///
    /// 这个数字必须露出来：字数只覆盖装了适配器的应用，不是全部输入。
    /// 不说明覆盖率的话，用户会把「部分」当成「全部」。
    pub precise_key_input: i64,
    /// 有精确字数的应用名（按按键数降序）。
    pub precise_apps: Vec<String>,
    /// 有按键数、但拿不到精确字数的应用名。字数口径下它们只能留空，
    /// 界面要主动说出是哪些，否则用户会以为这些应用今天没打字。
    pub uncovered_apps: Vec<String>,

    /// 有输入或删除的分钟数。见 `db::TypingSpan`。
    pub active_minutes: i64,
    /// 会话时长（分钟）：相邻输入间隔不超过 `db::SESSION_GAP_MINUTES` 算同一段。
    pub session_minutes: i64,
    /// 最长的一段有多少分钟。
    pub longest_minutes: i64,
    /// 有精确字数的分钟数。算「字数速度」时分母用它，不能拿它当全部时长。
    pub precise_minutes: i64,
    /// 第一次 / 最后一次输入的分钟戳（Unix 分钟）。0 表示今天还没打过字。
    pub first_minute: i64,
    pub last_minute: i64,
}

/// 返回本地日期（YYYY-MM-DD）。前端不该自己算日期——时区以进程所在为准。
#[tauri::command]
pub fn current_day() -> String {
    today_str()
}

#[tauri::command]
pub fn today_summary(state: State<'_, AppState>, day: String) -> Result<TodaySummary, String> {
    let conn = state.db.lock();
    let s = db::summary_for_day(&conn, &day).map_err(err)?;
    let coverage = db::app_coverage(&conn, &day).map_err(err)?;
    let span = db::typing_span_for_day(&conn, &day).map_err(err)?;
    let mut precise_apps = Vec::new();
    let mut uncovered_apps = Vec::new();
    for (app, has_char, _keys) in coverage {
        if has_char {
            precise_apps.push(app);
        } else {
            uncovered_apps.push(app);
        }
    }
    Ok(TodaySummary {
        day,
        key_input: s.key_input,
        key_delete: s.key_delete,
        key_other: s.key_other,
        char_input: s.char_input,
        char_delete: s.char_delete,
        net_chars: s.net_chars(),
        delete_rate: s.delete_rate(),
        // 「有没有精确数据」看的是有没有适配器上报过，**不是** char_input > 0。
        // 有适配器但今天还没敲字，和一个适配器都没有，是两回事。
        has_char_data: s.has_char,
        precise_key_input: s.char_key_input,
        precise_apps,
        uncovered_apps,
        active_minutes: span.active_minutes,
        session_minutes: span.session_minutes,
        longest_minutes: span.longest_minutes,
        precise_minutes: span.precise_minutes,
        first_minute: span.first_minute,
        last_minute: span.last_minute,
    })
}

#[tauri::command]
pub fn hourly(state: State<'_, AppState>, day: String) -> Result<Vec<db::HourPoint>, String> {
    let conn = state.db.lock();
    db::hourly_for_day(&conn, &day).map_err(err)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyPoint {
    pub day: String,
    pub key_input: i64,
    pub key_delete: i64,
    pub char_input: i64,
    pub char_delete: i64,
    pub net_chars: i64,
    /// 这一天有没有精确字数数据。false 时字数口径的折线必须断开，
    /// 不能画成 0——那读起来是「这天一个字没打」。
    pub has_char: bool,
    /// 有输入的分钟数。
    pub active_minutes: i64,
    /// 会话时长（分钟）。
    pub session_minutes: i64,
}

#[tauri::command]
pub fn daily(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<Vec<DailyPoint>, String> {
    let conn = state.db.lock();
    let rows = db::daily_series(&conn, &from, &to).map_err(err)?;
    let spans = db::typing_spans(&conn, &from, &to).map_err(err)?;
    Ok(rows
        .into_iter()
        .map(|(day, s)| {
            let span = spans.get(&day).copied().unwrap_or_default();
            DailyPoint {
                day,
                key_input: s.key_input,
                key_delete: s.key_delete,
                char_input: s.char_input,
                char_delete: s.char_delete,
                net_chars: s.net_chars(),
                has_char: s.has_char,
                active_minutes: span.active_minutes,
                session_minutes: span.session_minutes,
            }
        })
        .collect())
}

#[tauri::command]
pub fn app_breakdown(state: State<'_, AppState>, day: String) -> Result<Vec<db::AppPoint>, String> {
    let conn = state.db.lock();
    db::app_breakdown(&conn, &day).map_err(err)
}

/// 键位使用频次，供键盘热力图使用。区间内按物理按键汇总。
#[tauri::command]
pub fn key_usage(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<Vec<db::KeyUsage>, String> {
    let conn = state.db.lock();
    db::key_usage(&conn, &from, &to).map_err(err)
}

/// 「日期 × 小时」网格，供热力图使用。
#[tauri::command]
pub fn cell_grid(
    state: State<'_, AppState>,
    from: String,
    to: String,
) -> Result<Vec<db::CellPoint>, String> {
    let conn = state.db.lock();
    db::cell_grid(&conn, &from, &to).map_err(err)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let conn = state.db.lock();
    db::all_settings(&conn).map_err(err)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    let conn = state.db.lock();
    db::set_setting(&conn, &key, &value).map_err(err)
}

/// 钩子健康状况。调试用——尤其是验证看门狗是否在工作。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub alive: bool,
    pub event_count: u64,
    /// 看门狗此刻看到的输入时刻。**这几个数是判断钩子死活的唯一依据**，
    /// 所以跟着状态一起露出来：钩子被系统摘掉时没有任何通知，
    /// 没有它们就只剩「日志里有没有那行」这一个反证，而「没打印」是推不出结论的。
    pub health: hook::watchdog::Health,
}

#[tauri::command]
pub fn hook_status(state: State<'_, AppState>) -> HookStatus {
    HookStatus {
        alive: state.hook.is_alive(),
        event_count: hook::event_count(),
        health: hook::watchdog::health(),
    }
}

/// 手动请求重建钩子，用于排查"按键突然不统计了"。
#[tauri::command]
pub fn reinstall_hook(state: State<'_, AppState>) -> bool {
    state.hook.request_reinstall()
}

/// 插件上报通道的状态。设置页用它显示端口、token 和"最近有没有收到数据"。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStatus {
    /// None 表示接收端没起来（端口 42180-42189 全被占用）。
    pub port: Option<u16>,
    pub token: String,
    /// 最近一次成功上报的 Unix 秒。0 表示从未收到过。
    pub last_report_at: i64,
}

#[tauri::command]
pub fn adapter_status(state: State<'_, AppState>) -> AdapterStatus {
    AdapterStatus {
        port: state.adapter_port,
        // `live_adapter_token` 而不是 `state.adapter_token`——用户可能刚点过
        // 「重新生成」，那个字段从那时起就是旧的了。详见那个函数。
        token: live_adapter_token(&state),
        last_report_at: crate::adapters::ipc::last_report_at(),
    }
}

/// 重新生成 token 并持久化。已装好的插件需要同步改，所以返回新值给界面展示。
///
/// **顺序是「先生成新值 → 落库 → 最后才换内存里的值」，不能颠倒。**
/// 先换内存、后落库的写法（原来就是）在落库失败时会留下一个几乎无法倒查的状态：
/// 内存里已经是新 token，`settings` 表里还是旧的，而 `adapter_status` 优先读内存
/// ——于是界面上显示的是新 token，插件拿旧 token 上报全被拒（插件侧只是静默地
/// 不再有数据），用户重启一下又「自己好了」（那时从表里读回旧的）。
/// 落库失败就该整体失败，内存里那半截改动一步都不做。
#[tauri::command]
pub fn rotate_adapter_token(state: State<'_, AppState>) -> Result<String, String> {
    // 接收端没起来时 `set_token` 无处可写，先挡掉，别让表里的值和一个
    // 不存在的接收端对上。
    if crate::adapters::ipc::current_token().is_none() {
        return Err("接收端未启动，无法生成 token".into());
    }

    let fresh = crate::adapters::ipc::random_token();
    {
        let conn = state.db.lock();
        db::set_setting(&conn, "adapter_token", &fresh).map_err(err)?;
    } // ← 锁在这里落，和下面的赋值没有交集。

    // 到这一步落库已经成功，换内存值不会再失败。
    crate::adapters::ipc::set_token(fresh.clone());
    Ok(fresh)
}

// ——————————————————————————————————————————————————————————————
// 总结（周期报告）
//
// 命令层只做三件事：把请求翻译成 `report::period` 的期次、把期次交给
// `report::` 算和写、把结果发给前端。**这里不出现任何数字。**
//
// 一次生成可以花掉 30 秒，所以它不是普通的同步命令——见 `report_generate`。
// ——————————————————————————————————————————————————————————————

/// 接口地址存在哪儿。这一条**不进 `secret.`**：它不是密钥，用户要能看见自己填的地址。
const KEY_BASE_URL: &str = "report.base_url";
/// 模型名。
const KEY_MODEL: &str = "report.model";
/// 密钥。**这一条必须带 `secret.` 前缀**——`db::all_settings` 靠它把密钥挡在
/// `get_settings` 之外，换个名字就是明文泄露，而且不会有任何症状。
const KEY_SECRET: &str = "secret.report_api_key";

/// 今天（本地日期）。和 `current_day` 用的是同一个来源——
/// 时区以进程所在为准，前端一行日期算术都不做。
fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// 从设置表里取出接口配置。**解不开的密钥是 `Broken`，不是 `Missing`**——
/// 前者要请用户重填一次，后者要请用户填一个，界面上那两句话不一样。
fn report_config(conn: &Connection) -> Result<llm::Config, String> {
    let pick = |key: &str, fallback: &str| -> Result<String, String> {
        Ok(db::get_setting(conn, key)
            .map_err(err)?
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| fallback.to_string()))
    };
    let api_key = match db::get_setting(conn, KEY_SECRET).map_err(err)? {
        Some(s) if !s.trim().is_empty() => match report::secret::unprotect(&s) {
            Ok(k) => llm::ApiKey::Ready(k),
            // 换了 Windows 账户、或者库是从别的机器拷来的。
            Err(_) => llm::ApiKey::Broken,
        },
        _ => llm::ApiKey::Missing,
    };
    Ok(llm::Config {
        base_url: pick(KEY_BASE_URL, llm::DEFAULT_BASE_URL)?,
        model: pick(KEY_MODEL, llm::DEFAULT_MODEL)?,
        api_key,
    })
}

/// 生成一期并存档，然后返回它。
///
/// **`report_generate` 和 `report_catchup` 走的是同一条路。** 两处各写一遍，
/// 迟早在某一处漏掉一个字段（比如忘了存 `sheet`），而症状是
/// 「点按钮生成的那份」和「程序自己补的那份」长得不一样。
///
/// 调用前必须已经 [`report::InFlight`] 占坑、且 `facts`/`cfg` 都已备好
/// （那两样要在持锁时算，见 `report_generate` 的三段式）。
async fn write_and_store(
    state: &AppState,
    p: &report::period::Period,
    today: &str,
    facts: &report::ReportFacts,
    cfg: &llm::Config,
) -> Result<report::ReportDetail, String> {
    // —— 第二段：不持锁。最长 30 秒。——
    let written = llm::write(cfg, facts).await;

    // —— 第三段：持锁。落库。——
    let conn = state.db.lock();
    db::upsert_report(
        &conn,
        &db::ReportRow {
            period_type: p.period_type.to_string(),
            period_key: p.key.clone(),
            starts_on: p.starts_on.clone(),
            ends_on: p.ends_on.clone(),
            generated_at: chrono::Local::now().timestamp(),
            // 存的是**同一份 facts**，不是它渲染出来的样子：页面上的账目和这里
            // 解出来的必须是同一批数字，否则「存档」两个字就没有意义。
            facts_json: serde_json::to_string(facts).map_err(err)?,
            // 清单在 `llm::write` 里也渲染过一次（拼提示词用）。同一个纯函数、
            // 同一份 facts，两次结果必然一样——这里存的是同一份东西。
            sheet: report::text::render_sheet(facts),
            body: written.body,
            source: written.source.as_str().to_string(),
            model: written.model,
            note: written.note,
        },
    )
    .map_err(err)?;

    // 刻意重新走一遍 `report_get` 用的那个 `report::detail`：
    // **同一个 DTO 有两处拼装，就是「页面上一个样、存档里另一个样」的开始。**
    report::detail(&conn, p, today)
}

/// 期条上的一格。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodSlot {
    pub period_key: String,
    pub label: String,
    pub heading: String,
    pub range_text: String,
    pub starts_on: String,
    pub ends_on: String,
    /// 这一期是否已经过完。**没结束的期不能生成**，期条上那格也就不可点。
    pub closed: bool,
    /// 这一期有没有打字记录。没记录、也没生成过的一格，点进去只有一句话可说。
    pub has_data: bool,
    pub generated_at: Option<i64>,
    /// `"llm"` / `"template"`。没生成过是 `None`。
    pub source: Option<String>,
    pub model: Option<String>,
}

/// 期条：截至今天的最近 `count` 期（默认 12），从旧到新。
#[tauri::command]
pub fn report_periods(
    state: State<'_, AppState>,
    period_type: String,
    count: Option<usize>,
) -> Result<Vec<PeriodSlot>, String> {
    let pt = PeriodType::parse(&period_type).ok_or("认不出这个期次类型")?;
    let today = today_str();
    // 上限 40：往下的跨度是一次 `daily_series` 查询，而期条本来也放不下更多。
    let n = count.unwrap_or(12).clamp(1, 40);

    let conn = state.db.lock();
    let periods = period::recent(pt, chrono::Local::now().date_naive(), n);
    let index = db::report_index(&conn, pt.as_str()).map_err(err)?;

    // 一次查完整个跨度里「哪些天打过字」，而不是按期各查一次（那就是十几次查询）。
    // `local_day` 是定长的 ISO 日期，字典序就是时间序，所以后面直接拿字符串比大小。
    let busy: HashSet<String> = db::daily_series(
        &conn,
        &periods[0].starts_on,
        &periods[periods.len() - 1].ends_on,
    )
    .map_err(err)?
    .into_iter()
    .filter(|(_, s)| s.key_input > 0 || s.key_delete > 0)
    .map(|(day, _)| day)
    .collect();

    Ok(periods
        .into_iter()
        .map(|p| {
            let meta = index.get(&p.key);
            PeriodSlot {
                closed: p.is_closed(&today),
                has_data: busy
                    .iter()
                    .any(|d| d.as_str() >= p.starts_on.as_str() && d.as_str() <= p.ends_on.as_str()),
                generated_at: meta.map(|m| m.generated_at),
                source: meta.map(|m| m.source.clone()),
                model: meta.and_then(|m| m.model.clone()),
                period_key: p.key,
                label: p.label,
                heading: p.heading,
                range_text: p.range_text,
                starts_on: p.starts_on,
                ends_on: p.ends_on,
            }
        })
        .collect())
}

/// 一期的全文。没生成过也返回期次本身——页面要能说「还没生成」和「这一期没有记录」。
#[tauri::command]
pub fn report_get(
    state: State<'_, AppState>,
    period_type: String,
    period_key: String,
) -> Result<report::ReportDetail, String> {
    let pt = PeriodType::parse(&period_type).ok_or("认不出这个期次类型")?;
    let p = period::parse(pt, &period_key).ok_or("认不出这个期次")?;
    let conn = state.db.lock();
    report::detail(&conn, &p, &today_str())
}

/// 生成一期。
///
/// **必须是 `async` + 三段式，这不是风格选择。** 一次模型调用可以 30 秒，
/// 而 `commands.rs` 里每个命令都全程持有 `state.db.lock()`——持着锁去发网络请求，
/// 全界面每个页面的刷新会跟着一起卡死；而且同步的 `#[tauri::command]`
/// 在 Tauri 2 里跑在主线程上，会把 webview 冻住。
///
/// 锁在两处 `await` 之间**必然已经放下**：`parking_lot` 的 guard 不是 `Send`，
/// 跨 `await` 持锁是编译错误——所以这里不是「记得让开」，是编不过。
#[tauri::command]
pub async fn report_generate(
    state: State<'_, AppState>,
    period_type: String,
    period_key: String,
) -> Result<report::ReportDetail, String> {
    let today = today_str();
    let pt = PeriodType::parse(&period_type).ok_or("认不出这个期次类型")?;
    let p = period::parse(pt, &period_key).ok_or("认不出这个期次")?;
    if !p.is_closed(&today) {
        return Err("这一期还没结束，等它过完再生成".into());
    }

    // 先占坑再干活：界面按钮虽然会置灰，但 React 的 state 更新是异步的，
    // 双击能在置灰生效之前挤进第二次调用。放过去的话，代价是白花一次模型调用，
    // 还会把同一期覆盖成两份不同的正文。
    // 必须绑到 `_in_flight` 而不是 `_`：`let _ =` 会立刻析构，坑位当场让出去。
    let _in_flight = report::InFlight::claim(&state.report_busy, pt.as_str(), &p.key)
        .ok_or("这一期的报告正在生成中，等它结束再点")?;

    // —— 第一段：持锁。算事实、读接口设置。纯本地，微秒级。——
    let (facts, cfg) = {
        let conn = state.db.lock();
        let facts = report::facts_for_period(&conn, &p)?;
        (facts, report_config(&conn)?)
    }; // ← 锁在这里落。

    write_and_store(&state, &p, &today, &facts, &cfg).await
}

/// 开程序时补一期。**没有定时线程。**
///
/// 定时线程是**在用户没要求的时候花他的钱**（每 30 分钟一次），key 被撤销就永远重试，
/// 而这个 crate 没有任何关机路径，那个循环除了退程序停不下来。
///
/// 这里改成：每次开程序看一眼**最近一个已结束的周**，没存档、有数据就生成，
/// 否则空转返回。幂等、有界：成功也好、降级成模板也好，这次尝试都会写下一行，
/// 所以同一期永远不会被尝试第二次。最坏情况是「崩在调用和落库之间」，多花一次调用。
///
/// **只补周报。** 月报和周的期条没有交集，补一个月就真的多花一次调用——
/// 「一次只补一期」这条是为了把花费钉死。月报在总结页上点一下就有了。
///
/// 前端 fire-and-forget 调它，所以失败只写 stderr，不弹任何东西：
/// 用户没要求过这件事，不该被它的失败打扰。
#[tauri::command]
pub async fn report_catchup(state: State<'_, AppState>) -> Result<Option<report::ReportDetail>, String> {
    let today = today_str();
    let pt = PeriodType::Week;
    // `recent` 的末项是含今天的当前期，所以倒数第二项就是最近一个**已结束**的周。
    let p = period::recent(pt, chrono::Local::now().date_naive(), 2).remove(0);

    let _in_flight = match report::InFlight::claim(&state.report_busy, pt.as_str(), &p.key) {
        // 已经在生成了：让那一次去写，这里什么都不做。
        None => return Ok(None),
        Some(g) => g,
    };

    let (facts, cfg) = {
        let conn = state.db.lock();
        if db::report_row(&conn, pt.as_str(), &p.key).map_err(err)?.is_some() {
            return Ok(None); // 这一期早存过了
        }
        let facts = report::facts_for_period(&conn, &p)?;
        if !report::text::has_typing(&facts) {
            // 那一周什么都没写。不值得占一行存档，更不值得花一次调用——
            // 而且没写行，下次开程序还会再看一眼，代价只是一次本地查询。
            return Ok(None);
        }
        (facts, report_config(&conn)?)
    };

    Ok(Some(write_and_store(&state, &p, &today, &facts, &cfg).await?))
}

/// 总结页接口表单要的那些东西。**永不回传密钥本身。**
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportSettings {
    pub base_url: String,
    pub model: String,
    /// 有没有**能用的**密钥。注意这不是「填过没有」：解不开的那种不算能用。
    pub has_key: bool,
    /// 填过但解不开（换了 Windows 账户登录，或者 `typestat.db` 是从别的机器拷来的）。
    /// 界面要请用户**重填一次**，而不是当成没配——后者会让人反复检查自己是不是输错了。
    pub key_broken: bool,
    /// 数据库文件的位置。界面上要写「密钥就存在这个文件的 settings 表里」，
    /// 用户才知道备份和删除到底动了什么。
    pub db_path: String,
}

#[tauri::command]
pub fn report_settings(state: State<'_, AppState>) -> Result<ReportSettings, String> {
    let conn = state.db.lock();
    let cfg = report_config(&conn)?;
    Ok(ReportSettings {
        has_key: matches!(cfg.api_key, llm::ApiKey::Ready(_)),
        key_broken: matches!(cfg.api_key, llm::ApiKey::Broken),
        base_url: cfg.base_url,
        model: cfg.model,
        db_path: state.db_path.display().to_string(),
    })
}

/// 存接口设置。`api_key` 留空或为 `null` 表示**不修改**——
/// 把密钥框清空多半是想改地址，不该顺手把密钥删掉。
#[tauri::command]
pub fn report_save_settings(
    state: State<'_, AppState>,
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<(), String> {
    // 地址当场验，不要等到生成时才说。那时候用户在等一份报告，
    // 拿到的是一句「接口地址不是合法的 http(s) 地址」，而这一步本来就该在这里挡住。
    llm::chat_url(&base_url).map_err(|e| e.to_string())?;
    let model = model.trim();
    if model.is_empty() {
        return Err("模型名不能为空".into());
    }

    let conn = state.db.lock();
    db::set_setting(&conn, KEY_BASE_URL, base_url.trim()).map_err(err)?;
    db::set_setting(&conn, KEY_MODEL, model).map_err(err)?;
    if let Some(k) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        // 加密这一步失败就整个失败：**绝不能退回去存明文**。
        // 用户以为密钥是加密存的，而它正以明文躺在可以被随手拷走的文件里——
        // 这种「静默降级」比直接报错糟得多。
        let stored = report::secret::protect(k).map_err(|e| e.to_string())?;
        db::set_setting(&conn, KEY_SECRET, &stored).map_err(err)?;
    }
    Ok(())
}

// ---------- 导出 ----------

/// 把一段区间的数据写成文件，返回它的位置。
///
/// `from` / `to` 传 `None` 表示「库里最早的一天」/「今天」——让用户自己去想
/// 「我第一天用是什么时候」是荒唐的，而拿一个固定日期当起点会让区间看着像假的。
#[tauri::command]
pub fn export_data(
    state: State<'_, AppState>,
    format: String,
    from: Option<String>,
    to: Option<String>,
) -> Result<export::ExportResult, String> {
    let fmt = export::Format::parse(&format)?;
    let to = match to {
        Some(t) => export::check_day(&t)?,
        None => today_str(),
    };
    let from = match from {
        Some(f) => export::check_day(&f)?,
        None => {
            let conn = state.db.lock();
            db::first_day(&conn)
                .map_err(err)?
                .ok_or("库里还没有任何记录，没有可导出的东西")?
        }
    };
    // 反着的区间查出来是空的，但报出来的是一个「这段没有记录」——
    // 那和「你把日期填反了」是两回事，得说清楚是哪一件。
    if from > to {
        return Err(format!("起始日期 {from} 排在结束日期 {to} 后面"));
    }

    let (days, spans, hours, apps) = {
        let conn = state.db.lock();
        (
            db::daily_series(&conn, &from, &to).map_err(err)?,
            db::typing_spans(&conn, &from, &to).map_err(err)?,
            db::hour_profile(&conn, &from, &to).map_err(err)?,
            db::app_breakdown_range(&conn, &from, &to).map_err(err)?,
        )
    }; // ← 锁在这里落。写文件不持锁。

    if days.is_empty() {
        return Err(format!("{from} 到 {to} 之间没有任何记录"));
    }

    let (text, rows) = match fmt {
        export::Format::Csv => (export::csv_days(&days, &spans), days.len()),
        export::Format::Json => {
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S %:z").to_string();
            let text = export::json_dump(&from, &to, &now, &days, &spans, &hours, &apps)?;
            (text, days.len() + hours.len() + apps.len())
        }
    };

    let dir = export::export_dir(&export_fallback(&state));
    let stem = format!("typestat-{from}_{to}");
    let path = export::write_unique(&dir, &stem, fmt.ext(), &text)
        .map_err(|e| format!("写文件失败：{e}"))?;

    Ok(export::ExportResult {
        path: path.display().to_string(),
        dir: dir.display().to_string(),
        rows,
        // 字节数是**写出去的那份文本**的长度，不是文件元数据——
        // 里面含 BOM 和 CRLF，正好是用户实际拿到的那个大小。
        bytes: text.len(),
        from,
        to,
    })
}

/// 在资源管理器里打开导出目录。
///
/// **不收参数，目录由后端自己算。** 这个命令会启动一个外部程序，而参数来自
/// webview——虽然这个 webview 只加载本地页面，但「能打开任意路径」是一个
/// 没有任何用处的额外能力，不给它就没有被滥用的余地。
#[tauri::command]
pub fn open_export_dir(state: State<'_, AppState>) -> Result<String, String> {
    let dir = export::export_dir(&export_fallback(&state));
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    // 不等它结束（explorer.exe 的退出码本来就是 1），只确认能起来。
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("打不开资源管理器：{e}"))?;
    Ok(dir.display().to_string())
}

// ---------- 适配器安装 ----------

/// 当前有效的上报令牌。
///
/// **不能直接读 `state.adapter_token`。** 那个字段是启动时从设置表读出来的，
/// 而「重新生成」换掉的是接收端内存里的那一份和表里的那一份——`AppState` 是共享
/// 引用，改不了它，于是它从换过那一刻起就是**旧的**。谁直接读它，谁就会拿着一个
/// 已经被接收端拒掉的令牌去装加载项，装完还在界面上报「已经装好了」。
/// （这个 bug 真的写出来过一次：`adapter_status` 记得优先读实时值，
/// 而新加的这两个命令忘了——同一个知识点散在几处，就一定会有人漏。）
///
/// 接收端没起来时 `current_token()` 是 `None`，退回启动时那份：那种情况下
/// 上报本来就不通，装进去的那个值只影响「接收端起来之后要不要重装」。
fn live_adapter_token(state: &AppState) -> String {
    crate::adapters::ipc::current_token().unwrap_or_else(|| state.adapter_token.clone())
}

/// WPS 加载项现在装着没有、装的那份令牌是不是当前这个。
#[tauri::command]
pub fn wps_addon_status(state: State<'_, AppState>) -> wps::AddonStatus {
    wps::status(&live_adapter_token(&state))
}

/// 把 WPS 加载项装进 WPS 的加载项目录。
///
/// **端口和令牌由程序自己拿，不收参数。** 它们是程序启动时生成、此刻正在用的
/// 那两个值，让前端传的话就多了一条「界面上的值可能不是真的值」的路——而这条路上
/// 出错的表现是「装好了、上报一直被拒」，界面上和「今天没写字」长得一模一样。
///
/// 这是这个程序里**第二处会写程序自己以外的地方**（第一处是开机自启写注册表）。
/// 两处都只在用户明确按下按钮时发生，而且都不碰 WPS 的安装目录。
#[tauri::command]
pub fn install_wps_addon(state: State<'_, AppState>) -> Result<wps::InstallResult, String> {
    // 端口不受「重新生成」影响：接收端只在启动时绑一次，中途不会换。
    wps::install(&live_adapter_token(&state), state.adapter_port)
}

/// 把两份适配器的文件存到导出目录下的 `适配器\` 里，给人手动装。
#[tauri::command]
pub fn export_adapter_files(state: State<'_, AppState>) -> Result<wps::AddonFiles, String> {
    let dir = export::export_dir(&export_fallback(&state)).join("适配器");
    wps::export_files(&dir)
}

/// 在资源管理器里打开 WPS 的加载项目录。
///
/// 和 `open_export_dir` 一样**不收参数**，理由见那里。
#[tauri::command]
pub fn open_wps_addon_dir() -> Result<String, String> {
    let dir = wps::jsaddons_dir()?;
    // 没装过时这个目录还不存在。建出来：它是加载项自己的家，而「点开文件夹看看
    // 装到哪儿了」正是判断「到底装没装」的最直接办法——空着也是一种回答。
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("打不开资源管理器：{e}"))?;
    Ok(dir.display().to_string())
}

// ---------- 托盘与开机自启 ----------

/// 现在是不是暂停记录。托盘菜单的勾和设置页的开关都看它。
#[tauri::command]
pub fn pause_status() -> bool {
    crate::collector::pause::is_paused()
}

/// 拨暂停开关，返回拨完之后的状态。
///
/// 界面和托盘菜单拨的是同一个开关，所以这里**顺手把托盘那边刷一遍**：
/// 两处显示的是同一件事，不同步的话会出现「菜单里打着勾、页面上写着正在记录」，
/// 而用户没有别的办法判断哪个是真的。
#[tauri::command]
pub fn set_paused(app: tauri::AppHandle, paused: bool) -> bool {
    let now = crate::collector::pause::set_paused(paused);
    if let Some(t) = app.try_state::<crate::tray::Tray>() {
        t.apply_pause(now);
    }
    now
}

/// 开机自启现在的状态：开没开、注册表里指的是哪个路径、那个路径还是不是当前程序。
#[tauri::command]
pub fn autostart_status() -> Result<crate::autostart::Autostart, String> {
    crate::autostart::status()
}

/// 开 / 关开机自启。返回写完之后重新读到的状态——**不是把入参原样回传**：
/// 写注册表可能被拦（组策略、权限），回传入参的话界面会显示一个并不成立的状态。
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<crate::autostart::Autostart, String> {
    crate::autostart::set(enabled)
}
