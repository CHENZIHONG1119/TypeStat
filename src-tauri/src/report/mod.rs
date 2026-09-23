//! 周期性总结报告。
//!
//! 分成三层，各自只管一件事：
//!
//! - [`period`]：周期算术。哪一天属于哪一周/哪一月，期首日期末日是什么。
//! - [`text`]：把数字渲染成中文清单和降级模板。**不碰网络。**
//! - [`llm`]：调 OpenAI 兼容接口写正文，调不通就降级到 [`text`] 的模板。
//!
//! 数字全部来自 `db`，正文全部来自模型或模板，两者永远分开渲染：
//! 界面上数字归数字、正文归正文，正文旁边标着是谁写的。
//!
//! **这个模块自己不写 SQL。** 它只调 `db` 里已有的那几个区间查询，
//! 把结果组装成一期的 [`ReportFacts`]。聚合的规矩（跨天的时长怎么合、
//! 超过 [`MAX_APPS`] 个应用怎么截）留在这里，因为那是「一期报告该长什么样」
//! 的问题，不是「怎么查库」的问题——而它恰恰是那种**写错了页面照样好看**的东西，
//! 所以它待在能跑测试的这一侧。

use chrono::{Datelike, NaiveDate};
use rusqlite::Connection;
use std::collections::HashSet;

use crate::db;
use parking_lot::Mutex;

pub mod llm;
pub mod period;
pub mod secret;
pub mod text;

/// 测试样本。`text` 和 `llm` 两边必须吃同一份 facts，
/// 否则「模板里的数字都能在清单里找到」这条不变式测的就不是真东西。
#[cfg(test)]
pub mod fixtures;

/// 一期报告的全部数字。**这里是数字的唯一来源**：
/// 页面上、清单里、提示词里出现的每一个数都出自这个结构。
///
/// **所有 `char*` 字段都是 `Option`，不是 `i64`。** 这条是整个设计里最重要的一处：
/// 一期的 `SUM(char_input)` 在没有任何适配器上报时是 0，而 `"charInput": 0`
/// 喂给一个「你在写一周总结」的模型，产出必然是「你打了 0 个字」。
/// 线格式是最后一道防线——`null` 才是量不到，`0` 是记了但真的没打。
///
/// 不设 `Default`：这个结构体的每一个字段都要有人算出来。
/// 有个默认值，就意味着「忘了填」和「真的是 0」看起来一样。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportFacts {
    /// `"week"` / `"month"`。存成 `String` 而不是 `&'static str`：
    /// 这个结构体要能被 `serde` 从 `reports.facts_json` **解回来**
    /// （见 [`detail`]），而 `&'static str` 是解不了的。
    pub period_type: String,
    pub period_key: String,
    /// 「2026 年第 39 周」
    pub heading: String,
    /// 「2026-09-21 至 2026-09-27」
    pub range_text: String,
    pub starts_on: String,
    pub ends_on: String,

    /// 这一期里有按键的天数。**0 表示这一期完全没有记录**，
    /// 界面上那句话和别处都不一样，所以它得能一眼看出来。
    pub active_days: i64,
    /// 这一期一共几天（周是 7，月是 28–31）。有了它，「5 天」才知道是五分之五
    /// 还是三十分之五。
    pub period_days: i64,

    pub key_input: i64,
    pub key_delete: i64,
    pub key_other: i64,
    /// 退格率 = 退格 ÷ 敲入按键。敲入按键是 0 时算不出来，所以是 `Option`。
    ///
    /// **这里的 `None` 和 `char_*` 的 `None` 不是一回事，界面上说法也不同**：
    /// `char_*` 的 `None` 是「量不到」（没有任何适配器上报过），写成「量不到」；
    /// 这个 `None` 是「分母是 0，算不出来」（这一期一个键都没敲），写成「—」。
    /// 把两者都印成 0，就是把「不知道」和「是零」混为一谈。
    pub key_delete_rate: Option<f64>,

    pub char_input: Option<i64>,
    pub char_delete: Option<i64>,
    /// 净字数 = 敲入字数 − 删除字数。
    pub net_chars: Option<i64>,
    pub char_delete_rate: Option<f64>,
    /// **有字数的**那部分按键数。覆盖率的分母是全部按键，不是这个。
    pub char_key_input: i64,
    /// 字数覆盖率 = `char_key_input` ÷ `key_input`。
    ///
    /// 两种 `None` 都在这里：这一期没敲过键（分母是 0，见
    /// [`ReportFacts::key_delete_rate`]），或者一个适配器都没上报过（连分子都没有）。
    /// 后一种情况里覆盖率这个概念本身不成立，界面写「量不到」。
    pub coverage: Option<f64>,

    pub session_minutes: i64,
    pub active_minutes: i64,
    /// 最长的那一段。**跨天不求和**，取各天的最大值——见 `facts_for_period`。
    pub longest_minutes: i64,
    /// 有精确字数的分钟数。字数速度的分母。
    pub precise_minutes: i64,
    /// 按键速度 = 敲入按键 ÷ 活跃分钟数。分子分母同源（都是按键口径）。
    pub keys_per_minute: Option<f64>,
    /// 字数速度 = 敲入字数 ÷ 有字数的分钟数。**分母不是活跃分钟数**——
    /// 拿「WPS 的字数」除以「所有应用的打字时间」，算出来的速度会随
    /// 当天在哪个应用打字而剧烈变化，两头都不可比。
    pub chars_per_minute: Option<f64>,

    /// 有记录的那些天，从早到晚。没有记录的天不在里面。
    pub days: Vec<DayFacts>,
    /// **永远是 24 格**（`db::hour_profile` 补满的）。补出来的 0 是真的 0。
    pub hours: Vec<HourFacts>,
    /// 按敲入按键数从多到少，最多 `MAX_APPS` 个。
    pub apps: Vec<AppFacts>,
    /// 这一期一共出现过几个应用（含没列出来的）。
    pub apps_total: i64,
    /// 没列出来的应用数，以及它们合计的按键数。
    pub apps_omitted: i64,
    pub apps_omitted_keys: i64,

    /// 按键最多的那个小时（0–23），以及它的按键数。整期没有按键时是 `None`。
    pub busiest_hour: Option<i64>,
    pub busiest_hour_keys: i64,

    /// 这一期里「字数大于按键数」的天数。
    ///
    /// 一个字至少要按一次键，所以这不可能——只会是适配器虚报（已知 WPS
    /// 的字数口径偏大）。**数出来要说出来**：不说的结果是那几天的假数字
    /// 被当成真的读，而汇报的功能一旦开始撒谎就没人再信它的其他数字了。
    pub bogus_days: i64,
}

/// 一天。
///
/// **只有按键数，没有字数。** 这不是省事：页面上的日折线只画按键数
/// （「字」和「键」不能同轴——同一根轴上比大小必须是同一个单位），
/// 所以清单里按天也只给按键数。清单和界面对不上的那一天，就是正文开始编数字的那一天。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayFacts {
    /// `YYYY-MM-DD`
    pub day: String,
    /// 「周一」
    pub weekday: String,
    pub key_input: i64,
}

/// 一小时。同样只有按键数——理由和 [`DayFacts`] 一样。
///
/// 刻意**不带**每小时的字数覆盖率：一小时的粒度上，这个数字半真半假
/// （这一小时里十分钟在 WPS、五十分钟在终端），而 24 根柱子上再叠一层斜纹
/// 没人看得懂。要看覆盖率，账目里有整期的。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HourFacts {
    pub hour: i64,
    pub key_input: i64,
}

/// 一个应用。`app` 是**去掉 `.exe` 的短名**，和屏幕上显示的是同一个字符串——
/// 发给模型也用这个，否则模型写「wps.exe」而屏幕上写着「wps」，
/// 正文和界面对不上账，正是这个项目一直在防的事。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppFacts {
    pub app: String,
    pub key_input: i64,
    pub char_input: Option<i64>,
    pub has_char: bool,
}

/// 清单里最多列几个应用。
///
/// 和 `Apps.tsx` 的 `TOP_N` 一致。列太多的话剩下的每个都只有个位数按键，
/// 它们进不了结论，却会把提示词撑长、把注意力摊薄。
pub const MAX_APPS: usize = 10;

fn parse_day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// 「周一」…「周日」。日期解不开时给空串，理由见 [`days_between`]。
fn weekday_cn(day: &str) -> String {
    const NAMES: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    parse_day(day)
        .map(|d| NAMES[d.weekday().num_days_from_monday() as usize].to_string())
        .unwrap_or_default()
}

/// 一期一共几天。**闭区间**，所以是差值加一。
fn days_between(starts_on: &str, ends_on: &str) -> i64 {
    match (parse_day(starts_on), parse_day(ends_on)) {
        (Some(a), Some(b)) => (b - a).num_days() + 1,
        // 这两个日期是 `period::` 自己格式化出来的，解不开只可能是有人手改了库。
        // 给 0 而不是 panic：release 是 panic = "abort"，
        // 为一个显示用的数字把整个程序退掉不值得。
        _ => 0,
    }
}

/// 从库里把一期的全部数字算出来。
///
/// **跨天聚合的两条规矩都在这里**，而且都是那种「写错了页面照样好看」的地方：
///
/// - `longest_minutes` 取各天的**最大值**，不是求和。`db::typing_spans` 是按天
///   分段的（跨午夜的段会在 24:00 断开），把各天的段长加起来得到的是「一段很长的段」，
///   那是编出来的、不是量出来的。
/// - `first_minute` / `last_minute` 直接丢掉：它们是「当天第几分钟」的分钟戳，
///   跨天没有意义。要看时段，有小时分布。
///
/// `char_*` 一律由 `Summary::has_char` 把关，**不是看 `char_input > 0`**：
/// 适配器报过 0 个字，那也是量到了。见 [`ReportFacts`] 的文档。
pub fn facts_for_period(conn: &Connection, p: &period::Period) -> Result<ReportFacts, String> {
    let e = |err: rusqlite::Error| err.to_string();
    let (from, to) = (p.starts_on.as_str(), p.ends_on.as_str());

    let summary = db::summary_for_range(conn, from, to).map_err(e)?;
    let spans = db::typing_spans(conn, from, to).map_err(e)?;
    let daily = db::daily_series(conn, from, to).map_err(e)?;
    let hourly = db::hour_profile(conn, from, to).map_err(e)?;
    let apps = db::app_breakdown_range(conn, from, to).map_err(e)?;

    // 只有真打过字的天进清单。「一天只按过 Ctrl+S」不算写过东西——
    // 和 `text::has_typing`、`db::typing_spans` 用同一把尺子。
    let mut days = Vec::new();
    let mut bogus_days = 0i64;
    for (day, s) in &daily {
        if s.key_input == 0 && s.key_delete == 0 {
            continue;
        }
        // 一个字至少要按一次键，所以字数大于按键数不可能——只会是适配器虚报
        // （已知 WPS 的字数口径偏大）。**数出来要说出来**：不说的结果是那几天的
        // 假数字被当成真的读。
        if s.has_char && s.char_input > s.key_input {
            bogus_days += 1;
        }
        days.push(DayFacts {
            day: day.clone(),
            weekday: weekday_cn(day),
            key_input: s.key_input,
        });
    }

    let mut active_minutes = 0i64;
    let mut session_minutes = 0i64;
    let mut precise_minutes = 0i64;
    let mut longest_minutes = 0i64;
    for s in spans.values() {
        active_minutes += s.active_minutes;
        session_minutes += s.session_minutes;
        precise_minutes += s.precise_minutes;
        longest_minutes = longest_minutes.max(s.longest_minutes);
    }

    // `hour_profile` 已经补满 24 格，这里只挑出页面上要的两个数。
    // 排序是 0→23，而 `>` 是严格比较，所以并列时取的是**更早的那个小时**。
    let mut hours = Vec::with_capacity(hourly.len());
    let mut busiest: Option<(i64, i64)> = None;
    for h in &hourly {
        if h.key_input > 0 && busiest.map_or(true, |(_, k)| h.key_input > k) {
            busiest = Some((h.hour, h.key_input));
        }
        hours.push(HourFacts {
            hour: h.hour,
            key_input: h.key_input,
        });
    }

    // 超过 `MAX_APPS` 个的部分不列出来，但**要把它们有多少、敲了多少次说出来**：
    // 只截断不交代，账目就不平了——应用们的按键数加起来小于总数，而页面上没有解释。
    let apps_total = apps.len() as i64;
    let mut listed = Vec::with_capacity(apps.len().min(MAX_APPS));
    let mut apps_omitted = 0i64;
    let mut apps_omitted_keys = 0i64;
    for (i, a) in apps.into_iter().enumerate() {
        if i >= MAX_APPS {
            apps_omitted += 1;
            apps_omitted_keys += a.key_input;
            continue;
        }
        listed.push(AppFacts {
            // 和屏幕上显示的是同一个短名，否则模型写「wps.exe」而界面写「wps」。
            app: text::app_display_name(&a.app),
            key_input: a.key_input,
            char_input: a.char_source.is_some().then_some(a.char_input),
            has_char: a.char_source.is_some(),
        });
    }

    let has_char = summary.has_char;
    Ok(ReportFacts {
        period_type: p.period_type.to_string(),
        period_key: p.key.clone(),
        heading: p.heading.clone(),
        range_text: p.range_text.clone(),
        starts_on: p.starts_on.clone(),
        ends_on: p.ends_on.clone(),

        active_days: days.len() as i64,
        period_days: days_between(&p.starts_on, &p.ends_on),

        key_input: summary.key_input,
        key_delete: summary.key_delete,
        key_other: summary.key_other,
        // 分母是 0 → `None`（界面写「—」），不是 0（界面会写成「退格率 0%」）。
        key_delete_rate: (summary.key_input > 0)
            .then(|| summary.key_delete as f64 / summary.key_input as f64),

        char_input: has_char.then_some(summary.char_input),
        char_delete: has_char.then_some(summary.char_delete),
        net_chars: has_char.then(|| summary.net_chars()),
        char_delete_rate: (has_char && summary.char_input > 0)
            .then(|| summary.char_delete as f64 / summary.char_input as f64),
        char_key_input: summary.char_key_input,
        // 一个适配器都没报过字数时，覆盖率这个概念本身不成立（连分子都不存在）。
        coverage: (has_char && summary.key_input > 0)
            .then(|| summary.char_key_input as f64 / summary.key_input as f64),

        session_minutes,
        active_minutes,
        longest_minutes,
        precise_minutes,
        keys_per_minute: (active_minutes > 0)
            .then(|| summary.key_input as f64 / active_minutes as f64),
        // 分子分母同源：分子是适配器报的字数，分母就是**有字数的那些分钟**。
        chars_per_minute: (has_char && precise_minutes > 0)
            .then(|| summary.char_input as f64 / precise_minutes as f64),

        days,
        hours,
        apps: listed,
        apps_total,
        apps_omitted,
        apps_omitted_keys,

        busiest_hour: busiest.map(|(h, _)| h),
        busiest_hour_keys: busiest.map_or(0, |(_, k)| k),
        bogus_days,
    })
}

/// 一期报告的完整内容。`report_get` 和 `report_generate` **拼的是同一个 DTO**：
/// 两处各拼一份，就是「刚生成完看到的」和「再点进来看到的」不一样的开始。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportDetail {
    pub period_type: &'static str,
    pub period_key: String,
    pub label: String,
    pub heading: String,
    pub range_text: String,
    pub starts_on: String,
    pub ends_on: String,
    /// 这一期是否已经结束。没结束的期不能生成——数字还在变。
    pub closed: bool,
    /// 这一期有没有打字记录。**没生成过的期也要给**：
    /// 「这一期没有任何记录」和「还没生成」在页面上是两句不同的话，
    /// 前者不该劝用户去点生成（生成出来也只有一句话）。
    pub has_data: bool,

    /// 生成时间（Unix 秒）。没生成过就是 `None`。
    pub generated_at: Option<i64>,
    pub body: Option<String>,
    /// `"llm"` / `"template"`，即正文是谁写的。
    pub source: Option<String>,
    /// 走模型时是模型名；降级时是 `None`（那时候一个模型都没参与）。
    pub model: Option<String>,
    /// 降级原因；走了模型时是 `None`。
    pub note: Option<String>,
    /// 原样喂给模型的那张清单。页面上给一个「模型看到的事实」的展开按钮——
    /// 正文里任何一句话都能对着它离线核对。
    pub sheet: Option<String>,
    /// 存档的账目。
    ///
    /// **从 `reports.facts_json` 解回来，不是现算的。** 这正是存档的意义：
    /// 正文是冻结的，数字要是每次重算，某天改了聚合逻辑就会让**存档的正文
    /// 和它旁边的账目对不上**——这个功能最不能出的事。两者要么一起变，要么一起不变。
    pub facts: Option<ReportFacts>,
}

/// 一期的全部内容，给 `report_get` / `report_generate` 用。
pub fn detail(conn: &Connection, p: &period::Period, today: &str) -> Result<ReportDetail, String> {
    let row = db::report_row(conn, p.period_type, &p.key).map_err(|e| e.to_string())?;

    let mut out = ReportDetail {
        period_type: p.period_type,
        period_key: p.key.clone(),
        label: p.label.clone(),
        heading: p.heading.clone(),
        range_text: p.range_text.clone(),
        starts_on: p.starts_on.clone(),
        ends_on: p.ends_on.clone(),
        closed: p.is_closed(today),
        // 下面按需要覆盖。
        has_data: false,
        generated_at: None,
        body: None,
        source: None,
        model: None,
        note: None,
        sheet: None,
        facts: None,
    };

    if let Some(r) = &row {
        // 解不开就报错，**不要退回去现算**：那样页面上的数字是新的、正文还是旧的，
        // 而且没有任何迹象。宁可让这一期打不开。
        let facts: ReportFacts = serde_json::from_str(&r.facts_json)
            .map_err(|e| format!("这一期的存档读不出来了（{e}）"))?;
        out.has_data = text::has_typing(&facts);
        out.generated_at = Some(r.generated_at);
        out.body = Some(r.body.clone());
        out.source = Some(r.source.clone());
        out.model = r.model.clone();
        out.note = r.note.clone();
        out.sheet = Some(r.sheet.clone());
        out.facts = Some(facts);
        return Ok(out);
    }

    // 没生成过的期：现查一次，好让页面能说「这一期没有任何记录」而不是只给一个
    // 生成按钮——这两件事要做的事不一样。
    let s = db::summary_for_range(conn, &p.starts_on, &p.ends_on).map_err(|e| e.to_string())?;
    out.has_data = s.key_input > 0 || s.key_delete > 0;
    Ok(out)
}

/// 「某一期正在生成」的坑位。
///
/// **RAII**：`Drop` 里让位，所以中途 return、报错、panic 展开都不会把一期永久锁死。
/// 按「期次」占而不是一个 bool——生成第 38 周的同时生成第 39 周是合理的。
pub struct InFlight<'a> {
    set: &'a Mutex<HashSet<String>>,
    key: String,
}

impl<'a> InFlight<'a> {
    /// 占坑。`None` 表示这一期已经在生成了。
    ///
    /// 界面按钮虽然会置灰，但 React 的 state 更新是异步的，**双击能在置灰生效
    /// 之前挤进第二次调用**。放过去的话，代价是白花一次模型调用，
    /// 还会把同一期覆盖成两份不同的正文。
    ///
    /// 拿到的 guard 在函数里就落，不跟着 `InFlight` 出去——它不是 `Send`，
    /// 跨 `await` 持有会让命令的 future 编不过。
    pub fn claim(
        set: &'a Mutex<HashSet<String>>,
        period_type: &str,
        period_key: &str,
    ) -> Option<Self> {
        let key = format!("{period_type}:{period_key}");
        if !set.lock().insert(key.clone()) {
            return None;
        }
        Some(InFlight { set, key })
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.set.lock().remove(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{schema, write_batch, ReportRow, StatDelta};

    fn d(s: &str) -> NaiveDate {
        parse_day(s).unwrap()
    }

    fn 空库() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        conn
    }

    /// 往里写若干行：`(日, 当天第几分钟, 应用, 有字数, 按键数)`。
    ///
    /// 第二个字段是**当天的分钟偏移**，不是库里那个全局分钟戳：偏移同时定出
    /// 小时（`偏移 / 60`）和会话分段（相邻行的差值），跨天聚合的测试才写得顺手。
    /// 换算成库里的主键时按「第几天 × 1440」错开——`minute` 是主键的一部分，
    /// 两天的同一个偏移直接存进去会撞成同一行，而症状是**第一天整整齐齐地不见了**。
    ///
    /// 这个 helper 表达不了两件事——`char_input` 大于 `key_input`（虚报），
    /// 以及一行一行地造应用名。那两种测试自己拼 `StatDelta`。
    fn 写入(conn: &mut Connection, rows: &[(&str, i64, &str, bool, i64)]) {
        let deltas: Vec<StatDelta> = rows
            .iter()
            .map(|(day, offset, app, has_char, count)| {
                let base = parse_day(day).map_or(0, |d| d.num_days_from_ce() as i64 * 1440);
                StatDelta {
                    minute: base + offset,
                    local_day: (*day).to_string(),
                    local_hour: offset / 60,
                    app: (*app).to_string(),
                    key_input: *count,
                    key_delete: 0,
                    key_other: 0,
                    char_input: if *has_char { *count } else { 0 },
                    char_delete: 0,
                    char_source: if *has_char { Some("plugin") } else { None },
                }
            })
            .collect();
        write_batch(conn, &deltas, &[]).unwrap();
    }

    fn 建库(rows: &[(&str, i64, &str, bool, i64)]) -> Connection {
        let mut conn = 空库();
        写入(&mut conn, rows);
        conn
    }

    fn 那一周() -> period::Period {
        period::of_date(period::PeriodType::Week, d("2026-09-23"))
    }

    /// **最长的那一段跨天取最大值，不是求和。**
    ///
    /// `db::typing_spans` 是按天分段的，跨午夜的段在 24:00 断开。两天各坐了 11 分钟，
    /// 说「最长的一段 22 分钟」是编出来的——没有任何一天出现过那样一段。
    /// 「坐下时长」求和是对的（确实是两天一共坐了这么久），两者不能混。
    #[test]
    fn 最长的一段跨天取最大值() {
        let rows: Vec<(&str, i64, &str, bool, i64)> = ["2026-09-21", "2026-09-22"]
            .iter()
            .flat_map(|day| {
                (600..=610).map(move |m| (*day, m, "wps.exe", false, 4))
            })
            .collect();
        let conn = 建库(&rows);
        let f = facts_for_period(&conn, &那一周()).unwrap();

        assert_eq!(f.active_days, 2);
        assert_eq!(f.active_minutes, 22, "两天的活跃分钟数应该求和");
        assert_eq!(f.session_minutes, 22, "坐下时长跨天求和是对的");
        assert_eq!(
            f.longest_minutes, 11,
            "最长的一段把两天加起来了——那一段在库里不存在"
        );
    }

    /// **虚报的天数要被数出来。**
    ///
    /// 一个字至少要按一次键，所以「字数 > 按键数」不可能。WPS 的适配器已知口径偏大，
    /// 而这里数出来是为了让页面主动说「那几天不可信」——不说的结果是假数字被当成真的读。
    #[test]
    fn 字数大于按键数的天被数出来() {
        let mut conn = 空库();
        write_batch(
            &mut conn,
            &[
                StatDelta {
                    minute: 100,
                    local_day: "2026-09-21".into(),
                    local_hour: 1,
                    app: "wps.exe".into(),
                    key_input: 10,
                    key_delete: 0,
                    key_other: 0,
                    char_input: 25, // 敲了 10 次键，报了 25 个字
                    char_delete: 0,
                    char_source: Some("plugin"),
                },
                StatDelta {
                    minute: 200,
                    local_day: "2026-09-22".into(),
                    local_hour: 3,
                    app: "wps.exe".into(),
                    key_input: 30,
                    key_delete: 0,
                    key_other: 0,
                    char_input: 30, // 正好相等：字比键多不了，不算虚报
                    char_delete: 0,
                    char_source: Some("plugin"),
                },
            ],
            &[],
        )
        .unwrap();

        let f = facts_for_period(&conn, &那一周()).unwrap();
        assert_eq!(f.bogus_days, 1, "虚报的天数数错了");
    }

    /// **应用只列前十个，但要把被省掉的交代清楚。**
    ///
    /// 只截断不交代，账目就不平：列出来的应用按键数加起来小于总数，而页面上
    /// 没有任何地方解释差在哪。少掉的那部分必须自己说出「有几个、合计多少次」。
    #[test]
    fn 应用超过十个只列十个并交代剩下多少() {
        let names: Vec<String> = (0..11).map(|i| format!("app{i:02}.exe")).collect();
        let rows: Vec<(&str, i64, &str, bool, i64)> = names
            .iter()
            .enumerate()
            .map(|(i, name)| ("2026-09-21", 100 + i as i64, name.as_str(), false, 1_000 - i as i64))
            .collect();
        let conn = 建库(&rows);

        let f = facts_for_period(&conn, &那一周()).unwrap();
        assert_eq!(f.apps_total, 11);
        assert_eq!(f.apps.len(), MAX_APPS, "列出来的应用数不对");
        assert_eq!(f.apps_omitted, 1);
        // 排最后的那一个（1,000 − 10）被省掉了。
        assert_eq!(f.apps_omitted_keys, 990);
        // 应用名去掉 `.exe`，和屏幕上显示的是同一个字符串。
        assert_eq!(f.apps[0].app, "app00");
        assert_eq!(f.apps[9].app, "app09");
    }

    /// **一个适配器都没上报过时，字数是 `None`，不是 0。**
    ///
    /// 这是整个功能里最重要的一处：`0` 喂给一个「你在写一周总结」的模型，
    /// 产出必然是「你打了 0 个字」。而按键数照常有——它不依赖任何适配器。
    #[test]
    fn 没有适配器时字数量不到不是零() {
        let conn = 建库(&[("2026-09-21", 100, "WindowsTerminal.exe", false, 300)]);
        let f = facts_for_period(&conn, &那一周()).unwrap();

        assert_eq!(f.key_input, 300);
        assert_eq!(f.char_input, None, "量不到被写成了 0");
        assert_eq!(f.char_delete, None);
        assert_eq!(f.net_chars, None);
        assert_eq!(f.char_delete_rate, None);
        assert_eq!(f.coverage, None, "连分子都没有，覆盖率不成立");
        assert_eq!(f.chars_per_minute, None);
        assert_eq!(f.char_key_input, 0);
        // 按键口径的两样照常有，它们不依赖适配器。
        assert!(f.key_delete_rate.is_some());
        assert!(f.keys_per_minute.is_some());
        assert_eq!(f.apps[0].char_input, None);
        assert!(!f.apps[0].has_char);
    }

    /// 适配器报过（哪怕报的是 0 个字），那就是「量到了」——删除率仍然是算不出来的，
    /// 因为分母是 0。两种 `None` 的来路不同，界面上写的话也不同。
    #[test]
    fn 报了零个字也算量到了() {
        let mut conn = 空库();
        write_batch(
            &mut conn,
            &[StatDelta {
                minute: 100,
                local_day: "2026-09-21".into(),
                local_hour: 1,
                app: "wps.exe".into(),
                key_input: 5,
                key_delete: 0,
                key_other: 0,
                char_input: 0,
                char_delete: 0,
                char_source: Some("plugin"),
            }],
            &[],
        )
        .unwrap();

        let f = facts_for_period(&conn, &那一周()).unwrap();
        assert_eq!(f.char_input, Some(0), "报过 0 个字就是量到了 0 个字");
        assert_eq!(f.net_chars, Some(0));
        // 但删除率算不出来——分母是 0。
        assert_eq!(f.char_delete_rate, None);
        assert!(f.coverage.is_some());
    }

    /// 小时分布**永远二十四格**，而且最忙的那个小时只在真有按键时才给。
    #[test]
    fn 小时分布是二十四格且最忙的小时是算出来的() {
        let conn = 建库(&[
            ("2026-09-21", 9 * 60 + 30, "wps.exe", false, 20), // 9 时
            ("2026-09-22", 21 * 60 + 5, "wps.exe", false, 200), // 21 时
        ]);
        let f = facts_for_period(&conn, &那一周()).unwrap();

        assert_eq!(f.hours.len(), 24, "小时数不是二十四格");
        assert_eq!(f.hours[9].key_input, 20);
        assert_eq!(f.hours[21].key_input, 200);
        assert_eq!(f.hours[23].key_input, 0, "没打字的小时补的是真的 0");
        assert_eq!(f.busiest_hour, Some(21));
        assert_eq!(f.busiest_hour_keys, 200);

        // 一整期都没有按键时，最忙的小时是「没有」而不是 0 时。
        let empty = facts_for_period(&conn, &period::of_date(period::PeriodType::Week, d("2026-08-03"))).unwrap();
        assert_eq!(empty.hours.len(), 24, "空的一期也要给满二十四格");
        assert_eq!(empty.busiest_hour, None, "没有按键时最忙的小时不存在，0 时是编的");
        assert_eq!(empty.active_days, 0);
        assert_eq!(empty.period_days, 7);
        assert!(empty.days.is_empty());
        assert!(!text::has_typing(&empty));
    }

    /// 按天清单只在真打过字的天里出现，星期几和屏幕上写的一样。
    #[test]
    fn 按天清单只列打过字的天() {
        let mut conn = 空库();
        write_batch(
            &mut conn,
            &[
                // 只按了 Ctrl+S 的一天：不算写过东西，不进清单。
                StatDelta {
                    minute: 100,
                    local_day: "2026-09-21".into(),
                    local_hour: 1,
                    app: "wps.exe".into(),
                    key_input: 0,
                    key_delete: 0,
                    key_other: 12,
                    char_input: 0,
                    char_delete: 0,
                    char_source: None,
                },
                // 真打过字的一天。
                StatDelta {
                    minute: 200,
                    local_day: "2026-09-22".into(),
                    local_hour: 3,
                    app: "wps.exe".into(),
                    key_input: 40,
                    key_delete: 0,
                    key_other: 0,
                    char_input: 0,
                    char_delete: 0,
                    char_source: None,
                },
            ],
            &[],
        )
        .unwrap();

        let f = facts_for_period(&conn, &那一周()).unwrap();
        assert_eq!(f.active_days, 1, "只按快捷键的一天被算成了「在打字」");
        assert_eq!(f.days.len(), 1);
        assert_eq!(f.days[0].day, "2026-09-22");
        assert_eq!(f.days[0].weekday, "周二");
        assert_eq!(f.days[0].key_input, 40);
        assert_eq!(f.key_other, 12, "其他键仍然要报出来，只是不算打字");
    }

    /// **正文是冻结的，数字也必须冻结。**
    ///
    /// 存档之后又往那一期补了行（现实中不会发生——只生成已结束的期——这里正是要
    /// 证明「不会重算」）。要是现算，就会出现「正文写 7 次、旁边的账目写着 507 次」
    /// 这种自相矛盾，而且页面上没有任何迹象。
    #[test]
    fn 存档的账目不会跟着库重算() {
        let mut conn = 建库(&[("2026-09-21", 100, "wps.exe", true, 7)]);
        let p = 那一周();
        let facts = facts_for_period(&conn, &p).unwrap();
        assert_eq!(facts.key_input, 7);

        db::upsert_report(
            &conn,
            &ReportRow {
                period_type: p.period_type.to_string(),
                period_key: p.key.clone(),
                starts_on: p.starts_on.clone(),
                ends_on: p.ends_on.clone(),
                generated_at: 1_700_000_000,
                facts_json: serde_json::to_string(&facts).unwrap(),
                sheet: text::render_sheet(&facts),
                body: "这一期你敲了 7 次。".into(),
                source: "llm".into(),
                model: Some("deepseek-chat".into()),
                note: None,
            },
        )
        .unwrap();

        // 库里又多了 500 次。
        write_batch(
            &mut conn,
            &[StatDelta {
                minute: 200,
                local_day: "2026-09-22".into(),
                local_hour: 3,
                app: "wps.exe".into(),
                key_input: 500,
                key_delete: 0,
                key_other: 0,
                char_input: 500,
                char_delete: 0,
                char_source: Some("plugin"),
            }],
            &[],
        )
        .unwrap();

        let got = detail(&conn, &p, "2026-09-28").unwrap();
        assert!(got.closed);
        assert_eq!(
            got.facts.unwrap().key_input,
            7,
            "账目是现算的——正文和它旁边的数字已经开始各说各话了"
        );
        assert_eq!(got.body.as_deref(), Some("这一期你敲了 7 次。"));
        assert_eq!(got.source.as_deref(), Some("llm"));
        assert_eq!(got.model.as_deref(), Some("deepseek-chat"));
        assert!(got.note.is_none());
        assert!(got.sheet.is_some());
        assert!(got.has_data);
    }

    /// 没生成过的期：给的是期次本身和「有没有记录」，没有账目也没有正文。
    ///
    /// 「这一期没有任何记录」和「还没生成」在页面上是两句不同的话——前者不该
    /// 劝用户去点生成（生成出来也只有一句话），所以 `has_data` 没生成过也要给。
    #[test]
    fn 没生成过的期给的是有没有记录() {
        let conn = 建库(&[("2026-09-21", 100, "wps.exe", false, 3)]);
        let p = 那一周();

        let got = detail(&conn, &p, "2026-09-28").unwrap();
        assert!(got.closed);
        assert!(got.has_data, "有按键却说没有记录，页面会劝用户什么都别做");
        assert!(got.facts.is_none(), "没生成过就不该有账目");
        assert!(got.body.is_none());
        assert!(got.source.is_none());
        assert!(got.generated_at.is_none());
        assert_eq!(got.period_key, "2026-W39");
        assert_eq!(got.label, "第 39 周");
        assert_eq!(got.heading, "2026 年第 39 周");
        assert_eq!(got.range_text, "2026-09-21 至 2026-09-27");

        // 期末日等于今天不算结束：库里还在往今天写，数字下一秒就可能变。
        assert!(!detail(&conn, &p, "2026-09-27").unwrap().closed);
        assert!(!detail(&conn, &p, "2026-09-23").unwrap().closed);

        // 完全没有记录的一期。
        let empty = period::of_date(period::PeriodType::Week, d("2026-08-03"));
        let e = detail(&conn, &empty, "2026-09-28").unwrap();
        assert!(!e.has_data);
        assert!(e.closed);
    }

    /// 存档的 JSON 解不开时**报错，不退回现算**。
    ///
    /// 退回去现算最坏：页面上的数字是新的、正文还是旧的，而且没有任何迹象。
    /// 宁可让这一期打不开——那是看得见的。
    #[test]
    fn 存档解不开就报错不退回现算() {
        let conn = 建库(&[("2026-09-21", 100, "wps.exe", false, 3)]);
        let p = 那一周();
        db::upsert_report(
            &conn,
            &ReportRow {
                period_type: "week".into(),
                period_key: p.key.clone(),
                starts_on: p.starts_on.clone(),
                ends_on: p.ends_on.clone(),
                generated_at: 1,
                facts_json: "{ 这不是 JSON".into(),
                sheet: String::new(),
                body: "正文".into(),
                source: "template".into(),
                model: None,
                note: None,
            },
        )
        .unwrap();

        let e = detail(&conn, &p, "2026-09-28").unwrap_err();
        assert!(e.contains("存档读不出来"), "报的错说不清是什么事：{e}");
    }

    /// 占坑：同一期同时只能有一个，别人占着的时候要让位之后才能再占。
    ///
    /// 界面按钮虽然会置灰，但 React 的 state 更新是异步的，**双击能在置灰生效
    /// 之前挤进第二次调用**——放过去的话，代价是白花一次模型调用，
    /// 还会把同一期覆盖成两份不同的正文。
    #[test]
    fn 同一期不能同时占两次坑() {
        let set = Mutex::new(HashSet::new());

        let first = InFlight::claim(&set, "week", "2026-W39").expect("第一次占坑该成功");
        assert!(
            InFlight::claim(&set, "week", "2026-W39").is_none(),
            "同一期被占了两次"
        );

        // 别的期不受影响：生成第 38 周的同时生成第 39 周是合理的。
        let other = InFlight::claim(&set, "week", "2026-W38").expect("不同的期不该互相挡");
        drop(other);
        assert!(
            InFlight::claim(&set, "week", "2026-W38").is_some(),
            "让位之后应该能再占"
        );

        // 坑位的键带着期次类型：周和月即使期次键长得一样也是两件事。
        assert!(
            InFlight::claim(&set, "month", "2026-W39").is_some(),
            "个月和个周被当成了同一期"
        );

        drop(first);
        assert!(
            InFlight::claim(&set, "week", "2026-W39").is_some(),
            "让位之后应该能再占"
        );
    }
}
