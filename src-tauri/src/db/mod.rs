//! SQLite 存储层。
//!
//! 表结构见 `schema.rs`。这一层刻意不认识 `collector` 的类型——调用方把
//! 聚合结果转成 `StatDelta` 再传进来，避免模块间循环依赖。

pub mod schema;

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, Result as SqlResult};

/// 一批要写库的增量。同一个 (minute, app) 会被累加而不是覆盖。
pub struct StatDelta {
    pub minute: i64,
    pub local_day: String,
    pub local_hour: i64,
    pub app: String,
    pub key_input: i64,
    pub key_delete: i64,
    pub key_other: i64,
    pub char_input: i64,
    pub char_delete: i64,
    pub char_source: Option<&'static str>,
}

/// 打开（必要时创建）数据库。
pub fn open(path: &Path) -> SqlResult<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;

    // 撞上写锁时重试，而不是当场失败。SQLite 默认 busy_timeout 是 0——
    // 撞上就直接返回 SQLITE_BUSY，一次都不重试。
    //
    // **必须设在 journal_mode 之前**：切 WAL 本身要写库头，那一步也会撞。
    //
    // 现在有三处写入方随时可能撞上：采集线程、命令层（set_setting 走的是读连接）、
    // 以及生成报告时那次落库。WAL 下 busy_timeout 只对「一开始就是写事务」的
    // 事务有效——`write_batch` 的第一条语句就是 INSERT，够用。
    // 以后谁写了「先读后写」的事务，会撞上它**不重试**的 SQLITE_BUSY_SNAPSHOT，
    // 那不是靠调大这个值能解决的。
    conn.pragma_update(None, "busy_timeout", 5000)?;

    // WAL 让 UI 的读连接不会阻塞采集线程的写。
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    schema::init(&conn)?;
    Ok(conn)
}

/// 一个 (日, 物理按键) 的累计次数。
pub struct KeyUsageDelta {
    pub local_day: String,
    pub vk_code: u32,
    pub scan_code: u32,
    pub extended: bool,
    pub count: i64,
}

/// 批量累加写入。用 UPSERT 保证多次 flush 到同一分钟是累加而非覆盖。
///
/// 两类数据写在同一个事务里：只成功一半的话，调用方重试会把已写入的那一半
/// 再加一遍——这些列全是累加语义，重复写就是数据翻倍。
pub fn write_batch(
    conn: &mut Connection,
    deltas: &[StatDelta],
    keys: &[KeyUsageDelta],
) -> SqlResult<()> {
    let tx = conn.transaction()?;
    {
        if !deltas.is_empty() {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO minute_stats
                    (minute, local_day, local_hour, app,
                     key_input, key_delete, key_other,
                     char_input, char_delete, char_source)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(minute, app) DO UPDATE SET
                    key_input   = key_input   + excluded.key_input,
                    key_delete  = key_delete  + excluded.key_delete,
                    key_other   = key_other   + excluded.key_other,
                    char_input  = char_input  + excluded.char_input,
                    char_delete = char_delete + excluded.char_delete,
                    char_source = COALESCE(excluded.char_source, char_source)",
            )?;

            for d in deltas {
                stmt.execute(rusqlite::params![
                    d.minute,
                    d.local_day,
                    d.local_hour,
                    d.app,
                    d.key_input,
                    d.key_delete,
                    d.key_other,
                    d.char_input,
                    d.char_delete,
                    d.char_source,
                ])?;
            }
        }

        if !keys.is_empty() {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO key_stats(local_day, vk_code, scan_code, extended, count)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(local_day, vk_code, scan_code, extended) DO UPDATE SET
                    count = count + excluded.count",
            )?;

            for k in keys {
                stmt.execute(rusqlite::params![
                    k.local_day,
                    k.vk_code,
                    k.scan_code,
                    k.extended as i64,
                    k.count,
                ])?;
            }
        }
    }
    tx.commit()
}

/// 某个键在区间内的使用次数。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyUsage {
    pub vk_code: u32,
    pub scan_code: u32,
    pub extended: bool,
    pub count: i64,
}

pub fn key_usage(conn: &Connection, from: &str, to: &str) -> SqlResult<Vec<KeyUsage>> {
    let mut stmt = conn.prepare(
        "SELECT vk_code, scan_code, extended, SUM(count)
         FROM key_stats WHERE local_day BETWEEN ?1 AND ?2
         GROUP BY vk_code, scan_code, extended",
    )?;
    let rows = stmt.query_map([from, to], |r| {
        Ok(KeyUsage {
            vk_code: r.get(0)?,
            scan_code: r.get(1)?,
            extended: r.get::<_, i64>(2)? != 0,
            count: r.get(3)?,
        })
    })?;
    rows.collect()
}

/// 某个本地日期（YYYY-MM-DD）的汇总。
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub key_input: i64,
    pub key_delete: i64,
    pub key_other: i64,
    pub char_input: i64,
    pub char_delete: i64,
    /// 这一段里有没有任何精确字数数据（有适配器上报过）。
    ///
    /// **必须和 `char_input == 0` 区分开**：没有适配器的应用/时段，字数是
    /// 「量不到」而不是「没打字」。把后者当 0 展示，界面就会自相矛盾——
    /// 条形图上说这个应用今天一个字没打，下面的明细表却写着它敲了一千多次。
    pub has_char: bool,
    /// 有精确字数的那部分行里的按键数。用来算「精确字数覆盖了多少按键」。
    pub char_key_input: i64,
}

impl Summary {
    /// 净字数：敲进去的字减去删掉的字。
    pub fn net_chars(&self) -> i64 {
        self.char_input - self.char_delete
    }

    /// 删除率 = 删掉的字 / 敲进去的字。反映"反复修改"的程度。
    pub fn delete_rate(&self) -> f64 {
        if self.char_input <= 0 {
            0.0
        } else {
            self.char_delete as f64 / self.char_input as f64
        }
    }
}

pub fn summary_for_range(conn: &Connection, from: &str, to: &str) -> SqlResult<Summary> {
    conn.query_row(
        "SELECT COALESCE(SUM(key_input),0), COALESCE(SUM(key_delete),0),
                COALESCE(SUM(key_other),0), COALESCE(SUM(char_input),0),
                COALESCE(SUM(char_delete),0),
                MAX(char_source) IS NOT NULL,
                COALESCE(SUM(CASE WHEN char_source IS NOT NULL THEN key_input ELSE 0 END),0)
         FROM minute_stats WHERE local_day BETWEEN ?1 AND ?2",
        [from, to],
        |r| {
            Ok(Summary {
                key_input: r.get(0)?,
                key_delete: r.get(1)?,
                key_other: r.get(2)?,
                char_input: r.get(3)?,
                char_delete: r.get(4)?,
                has_char: r.get(5)?,
                char_key_input: r.get(6)?,
            })
        },
    )
}

/// 单日版本。区间版的特例，不再单独写一遍那段投影。
pub fn summary_for_day(conn: &Connection, day: &str) -> SqlResult<Summary> {
    summary_for_range(conn, day, day)
}

/// 一天内每小时的汇总，用于小时柱状图 / 热力图。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourPoint {
    pub hour: i64,
    pub key_input: i64,
    pub key_delete: i64,
    pub char_input: i64,
    pub char_delete: i64,
    /// 这一小时有没有精确字数数据。false 时 `char_input` 是「量不到」，
    /// UI 必须留空而不是画一根 0 的柱子。
    pub has_char: bool,
    /// 这一小时里**有精确字数的那部分按键数**。
    ///
    /// 和 `key_input` 一起看才知道这一小时的字数全不全：同一个小时里很可能
    /// 一半时间在 WPS（有适配器）、一半在终端（没有）。只标 `has_char` 的话，
    /// 这种「半覆盖」的小时会显得和全覆盖一样完整。
    pub char_key_input: i64,
}

/// 区间内按小时汇总，**永远返回 24 行**（0–23 时）。
///
/// 补齐空小时是有意的：报告和小时候条带都按 0–23 摆格子，
/// 让每一层各自去 `find` 或者补零，迟早有一层忘了补，
/// 于是「23 时」凭空消失而没人发现。这里补齐一次，下游就不必再想这件事。
///
/// 补齐的空格子是真正的 0（那小时确实没打字），不是「量不到」——
/// 「量不到」是 `has_char` 那件事，两者不能混。
pub fn hour_profile(conn: &Connection, from: &str, to: &str) -> SqlResult<Vec<HourPoint>> {
    let mut stmt = conn.prepare(
        "SELECT local_hour,
                COALESCE(SUM(key_input),0), COALESCE(SUM(key_delete),0),
                COALESCE(SUM(char_input),0), COALESCE(SUM(char_delete),0),
                MAX(char_source) IS NOT NULL,
                COALESCE(SUM(CASE WHEN char_source IS NOT NULL THEN key_input ELSE 0 END),0)
         FROM minute_stats WHERE local_day BETWEEN ?1 AND ?2
         GROUP BY local_hour ORDER BY local_hour",
    )?;
    let rows = stmt.query_map([from, to], |r| {
        Ok(HourPoint {
            hour: r.get(0)?,
            key_input: r.get(1)?,
            key_delete: r.get(2)?,
            char_input: r.get(3)?,
            char_delete: r.get(4)?,
            has_char: r.get(5)?,
            char_key_input: r.get(6)?,
        })
    })?;

    let mut out = vec![
        HourPoint {
            hour: 0,
            key_input: 0,
            key_delete: 0,
            char_input: 0,
            char_delete: 0,
            has_char: false,
            char_key_input: 0,
        };
        24
    ];
    for (i, p) in out.iter_mut().enumerate() {
        p.hour = i as i64;
    }
    for row in rows {
        let row = row?;
        // 越界不可能出现（local_hour 是 minute / 60），但真出现了宁可丢掉这一行，
        // 也不能直接下标——release 是 panic = "abort"，一个坏数就是整个程序退出。
        let h = row.hour;
        if (0..24).contains(&h) {
            out[h as usize] = row;
        }
    }
    Ok(out)
}

/// 单日版本。区间版的特例。
pub fn hourly_for_day(conn: &Connection, day: &str) -> SqlResult<Vec<HourPoint>> {
    hour_profile(conn, day, day)
}

/// 每个本地日期的汇总，用于趋势折线。
pub fn daily_series(conn: &Connection, from: &str, to: &str) -> SqlResult<Vec<(String, Summary)>> {
    let mut stmt = conn.prepare(
        "SELECT local_day,
                COALESCE(SUM(key_input),0), COALESCE(SUM(key_delete),0),
                COALESCE(SUM(key_other),0), COALESCE(SUM(char_input),0),
                COALESCE(SUM(char_delete),0),
                MAX(char_source) IS NOT NULL,
                COALESCE(SUM(CASE WHEN char_source IS NOT NULL THEN key_input ELSE 0 END),0)
         FROM minute_stats WHERE local_day BETWEEN ?1 AND ?2
         GROUP BY local_day ORDER BY local_day",
    )?;
    let rows = stmt.query_map([from, to], |r| {
        Ok((
            r.get::<_, String>(0)?,
            Summary {
                key_input: r.get(1)?,
                key_delete: r.get(2)?,
                key_other: r.get(3)?,
                char_input: r.get(4)?,
                char_delete: r.get(5)?,
                has_char: r.get(6)?,
                char_key_input: r.get(7)?,
            },
        ))
    })?;
    rows.collect()
}

/// 分应用汇总，用于应用排行。附带精度来源，让 UI 能标注哪些应用只有按键数。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPoint {
    pub app: String,
    pub key_input: i64,
    pub char_input: i64,
    pub char_delete: i64,
    /// "plugin" / "uia" / null —— null 表示这个应用拿不到精确字数
    pub char_source: Option<String>,
}

/// 区间内分应用汇总，按敲入按键数从多到少。
///
/// **`ORDER BY SUM(key_input)` 里的 `SUM` 是有分量的，别顺手简化成 `key_input`。**
/// 写成裸列名看着对，其实是错的：`key_input` 是 `minute_stats` 的列，
/// 而这条查询里有 `MAX(char_source)` 这个聚合——按 SQLite 的规矩，
/// 裸列取的是「提供那个最大值的那一行」的值。于是排序实际上跟着 `char_source` 走，
/// 一个敲了一千次的应用可能排在只敲了七次的应用后面。
/// 同文件的 `app_coverage` 一直是正确写法，这里曾经不是。
pub fn app_breakdown_range(conn: &Connection, from: &str, to: &str) -> SqlResult<Vec<AppPoint>> {
    let mut stmt = conn.prepare(
        "SELECT app,
                COALESCE(SUM(key_input),0), COALESCE(SUM(char_input),0),
                COALESCE(SUM(char_delete),0), MAX(char_source)
         FROM minute_stats WHERE local_day BETWEEN ?1 AND ?2
         GROUP BY app ORDER BY SUM(key_input) DESC",
    )?;
    let rows = stmt.query_map([from, to], |r| {
        Ok(AppPoint {
            app: r.get(0)?,
            key_input: r.get(1)?,
            char_input: r.get(2)?,
            char_delete: r.get(3)?,
            char_source: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// 单日版本。区间版的特例。
pub fn app_breakdown(conn: &Connection, day: &str) -> SqlResult<Vec<AppPoint>> {
    app_breakdown_range(conn, day, day)
}

/// 「日期 × 小时」网格，供热力图使用。一次查完整个区间，避免按天循环查库。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellPoint {
    pub day: String,
    pub hour: i64,
    pub key_input: i64,
    pub char_input: i64,
    pub char_delete: i64,
    /// 这一格有没有精确字数数据。false 时热量图的字数口径要留白。
    pub has_char: bool,
}

pub fn cell_grid(conn: &Connection, from: &str, to: &str) -> SqlResult<Vec<CellPoint>> {
    let mut stmt = conn.prepare(
        "SELECT local_day, local_hour,
                COALESCE(SUM(key_input),0), COALESCE(SUM(char_input),0),
                COALESCE(SUM(char_delete),0),
                MAX(char_source) IS NOT NULL
         FROM minute_stats WHERE local_day BETWEEN ?1 AND ?2
         GROUP BY local_day, local_hour
         ORDER BY local_day, local_hour",
    )?;
    let rows = stmt.query_map([from, to], |r| {
        Ok(CellPoint {
            day: r.get(0)?,
            hour: r.get(1)?,
            key_input: r.get(2)?,
            char_input: r.get(3)?,
            char_delete: r.get(4)?,
            has_char: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// 打字时长。
///
/// **不需要新增采集**——分钟级明细里已经有「哪一分钟在打字」这件事了，
/// 时长是从它推出来的。这也是为什么时长没有「字数/按键」两种口径：
/// 时长就是时长，跟按了几个键、打了几个字无关。
#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypingSpan {
    /// 有输入或删除的分钟数。最保守、最可核对的「打字时长」——
    /// 直接数数据库里有多少行。代价是一分钟内只敲一下也算一分钟。
    pub active_minutes: i64,
    /// 会话时长：相邻输入分钟间隔不超过 `SESSION_GAP_MINUTES` 就算同一段，
    /// 段长（含中间的空隙）求和。更接近「坐下来写了多久」。
    pub session_minutes: i64,
    /// 最长的一段有多少分钟。
    pub longest_minutes: i64,
    /// 这一分钟里**有精确字数**的分钟数。算字数速度时当分母用。
    ///
    /// 为什么速度的分母不能直接用 `active_minutes`：字数只覆盖装了适配器的应用，
    /// 拿「WPS 的字数」除以「所有应用的打字时间」，算出来的速度会随当天在哪个
    /// 应用打字而剧烈变化，两头都不可比。**分子分母必须来自同一批数据**。
    pub precise_minutes: i64,
    /// 第一次 / 最后一次输入的分钟戳（Unix 分钟）。没有输入时为 0。
    /// 用来显示「从 9:00 打到 15:30」，不是时长本身。
    pub first_minute: i64,
    pub last_minute: i64,
}

/// 相邻两次输入隔多久还算「同一段」。
///
/// 打完一句停下来想几秒、查个资料再回来，不该被切成两段；但阈值太大
/// （比如 30 分钟）会把午休也串进去，那样「打字时长」就变成「在电脑前坐了多久」，
/// 是另一个指标了。5 分钟是这两个方向的折中，界面上会写明。
pub const SESSION_GAP_MINUTES: i64 = 5;

/// 按本地日期算打字时长。返回每个日期的 `TypingSpan`。
///
/// 「在打字」只算 `key_input` 和 `key_delete`：Ctrl+S、方向键这类（`key_other`）
/// 不是打字；只看输入的话又会漏掉「一直在删改」的时段——那显然也算在写东西。
///
/// 只取有输入的分钟（不是整天），一天最多 1440 行，遍历一遍的开销可以忽略。
pub fn typing_spans(conn: &Connection, from: &str, to: &str) -> SqlResult<HashMap<String, TypingSpan>> {
    // **按 (日, 分钟) 分组**：同一分钟可能有好几个应用各一行，
    // 不分组的话那一分钟会被数好几遍，「打字时长」直接虚高。
    // has_char 取这一分钟所有应用里的最大值：只要有一个应用给了精确字数，
    // 这一分钟就算「有精确数据」。
    let mut stmt = conn.prepare(
        "SELECT local_day, minute, MAX(char_source) IS NOT NULL
         FROM minute_stats
         WHERE local_day BETWEEN ?1 AND ?2 AND (key_input > 0 OR key_delete > 0)
         GROUP BY local_day, minute
         ORDER BY local_day, minute",
    )?;
    let rows = stmt.query_map([from, to], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, bool>(2)?))
    })?;

    let mut out: HashMap<String, TypingSpan> = HashMap::new();
    // 当前正在累计的那一段。跨行要保留，所以放在循环外面。
    let mut cur_day = String::new();
    let mut seg_start = 0i64;
    let mut seg_end = 0i64;
    let mut has_seg = false;

    for row in rows {
        let (day, minute, has_char) = row?;
        // 换天了就把上一段结算掉——否则跨午夜的那一段会串到第二天。
        if day != cur_day {
            if has_seg {
                if let Some(s) = out.get_mut(&cur_day) {
                    s.session_minutes += seg_end - seg_start + 1;
                    s.longest_minutes = s.longest_minutes.max(seg_end - seg_start + 1);
                }
            }
            cur_day = day.clone();
            has_seg = false;
        }

        let s = out.entry(day).or_default();
        s.active_minutes += 1;
        if has_char {
            s.precise_minutes += 1;
        }
        if s.first_minute == 0 {
            s.first_minute = minute;
        }
        s.last_minute = minute;

        if has_seg && minute - seg_end <= SESSION_GAP_MINUTES {
            // 接得上：把这一段的尾巴延到这里。中间的空隙也算进段长——
            // 「坐下来写了 43 分钟」里的那两分钟发呆本来就该算。
            seg_end = minute;
        } else {
            // 接不上：结算上一段，从这里另起一段。
            if has_seg {
                let len = seg_end - seg_start + 1;
                if let Some(prev) = out.get_mut(&cur_day) {
                    prev.session_minutes += len;
                    prev.longest_minutes = prev.longest_minutes.max(len);
                }
            }
            seg_start = minute;
            seg_end = minute;
            has_seg = true;
        }
    }
    // 收尾：最后一段还没结算。
    if has_seg {
        let len = seg_end - seg_start + 1;
        if let Some(s) = out.get_mut(&cur_day) {
            s.session_minutes += len;
            s.longest_minutes = s.longest_minutes.max(len);
        }
    }
    Ok(out)
}

/// 单日版本，给「今日看板」用。
pub fn typing_span_for_day(conn: &Connection, day: &str) -> SqlResult<TypingSpan> {
    Ok(typing_spans(conn, day, day)?.remove(day).unwrap_or_default())
}

/// 每个应用「有没有精确字数」——用来在界面上说清楚字数口径覆盖了谁、漏了谁。
/// 返回 (应用名, 有没有精确字数, 按键数)，按按键数降序。
pub fn app_coverage(conn: &Connection, day: &str) -> SqlResult<Vec<(String, bool, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT app, MAX(char_source) IS NOT NULL, COALESCE(SUM(key_input),0)
         FROM minute_stats WHERE local_day = ?1
         GROUP BY app ORDER BY SUM(key_input) DESC",
    )?;
    let rows = stmt.query_map([day], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.collect()
}

/// 读取设置项。
pub fn get_setting(conn: &Connection, key: &str) -> SqlResult<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

/// 一次性读取全部设置，UI 初始化时用。
///
/// **`secret.` 开头的键一律不外发。** 这张表的全部内容会经 `get_settings`
/// 原样交给前端，而接口的 API key 就存在这里——它一旦跟着出去，
/// 任何一个调用 `api.getSettings()` 的页面都能拿到。
///
/// 过滤放在这一层而不是调用方：调用方以后会变多，漏掉一个就是凭据泄露，
/// 而漏掉这件事不会有任何症状。
pub fn all_settings(conn: &Connection) -> SqlResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'secret.%'")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// 一期报告的存档行。
pub struct ReportRow {
    pub period_type: String,
    pub period_key: String,
    pub starts_on: String,
    pub ends_on: String,
    pub generated_at: i64,
    pub facts_json: String,
    pub sheet: String,
    pub body: String,
    pub source: String,
    pub model: Option<String>,
    pub note: Option<String>,
}

/// 写入一期报告。同一期再生成即覆盖——所以「重新生成」不需要先删。
pub fn upsert_report(conn: &Connection, r: &ReportRow) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO reports
            (period_type, period_key, starts_on, ends_on, generated_at,
             facts_json, sheet, body, source, model, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(period_type, period_key) DO UPDATE SET
             starts_on    = excluded.starts_on,
             ends_on      = excluded.ends_on,
             generated_at = excluded.generated_at,
             facts_json   = excluded.facts_json,
             sheet        = excluded.sheet,
             body         = excluded.body,
             source       = excluded.source,
             model        = excluded.model,
             note         = excluded.note",
        rusqlite::params![
            r.period_type,
            r.period_key,
            r.starts_on,
            r.ends_on,
            r.generated_at,
            r.facts_json,
            r.sheet,
            r.body,
            r.source,
            r.model,
            r.note,
        ],
    )?;
    Ok(())
}

pub fn report_row(
    conn: &Connection,
    period_type: &str,
    period_key: &str,
) -> SqlResult<Option<ReportRow>> {
    conn.query_row(
        "SELECT period_type, period_key, starts_on, ends_on, generated_at,
                facts_json, sheet, body, source, model, note
         FROM reports WHERE period_type = ?1 AND period_key = ?2",
        [period_type, period_key],
        |r| {
            Ok(ReportRow {
                period_type: r.get(0)?,
                period_key: r.get(1)?,
                starts_on: r.get(2)?,
                ends_on: r.get(3)?,
                generated_at: r.get(4)?,
                facts_json: r.get(5)?,
                sheet: r.get(6)?,
                body: r.get(7)?,
                source: r.get(8)?,
                model: r.get(9)?,
                note: r.get(10)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

/// 某一期类型下已存档的期次。期条用——**不读正文**，一次查完。
///
/// 日期范围不在这里返回：它由 `report::period` 从期次键算出来，
/// 两边各存一份就会出现「存档里写 9/21–9/27、期条上说 9/28–10/4」这种自相矛盾。
pub struct ReportMeta {
    pub generated_at: i64,
    pub source: String,
    pub model: Option<String>,
}

pub fn report_index(
    conn: &Connection,
    period_type: &str,
) -> SqlResult<HashMap<String, ReportMeta>> {
    let mut stmt = conn.prepare(
        "SELECT period_key, generated_at, source, model FROM reports WHERE period_type = ?1",
    )?;
    let rows = stmt.query_map([period_type], |r| {
        Ok((
            r.get::<_, String>(0)?,
            ReportMeta {
                generated_at: r.get(1)?,
                source: r.get(2)?,
                model: r.get(3)?,
            },
        ))
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个内存库，塞进给定的 (日, 分钟, 应用, 有精确字数) 行。
    fn db_with(rows: &[(&str, i64, &str, bool)]) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        let deltas: Vec<StatDelta> = rows
            .iter()
            .map(|(day, minute, app, has_char)| StatDelta {
                minute: *minute,
                local_day: (*day).to_string(),
                local_hour: 0,
                app: (*app).to_string(),
                key_input: 1,
                key_delete: 0,
                key_other: 0,
                char_input: if *has_char { 1 } else { 0 },
                char_delete: 0,
                char_source: if *has_char { Some("plugin") } else { None },
            })
            .collect();
        write_batch(&mut conn, &deltas, &[]).unwrap();
        conn
    }

    /// 建库，每行的按键数自己指定。
    ///
    /// 单独一个 helper 而不是给 `db_with` 加参数：那个被五个测试用着，
    /// 而它们的意图是「有这么一行」——把计数塞进去会让那些测试多读一层。
    /// 这里所有行的 `local_hour` 都是 0，需要跨小时的测试另建。
    fn db_with_counts(rows: &[(&str, i64, &str, bool, i64)]) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        let deltas: Vec<StatDelta> = rows
            .iter()
            .map(|(day, minute, app, has_char, count)| StatDelta {
                minute: *minute,
                local_day: (*day).to_string(),
                local_hour: 0,
                app: (*app).to_string(),
                key_input: *count,
                key_delete: 0,
                key_other: 0,
                char_input: if *has_char { *count } else { 0 },
                char_delete: 0,
                char_source: if *has_char { Some("plugin") } else { None },
            })
            .collect();
        write_batch(&mut conn, &deltas, &[]).unwrap();
        conn
    }

    /// **同一分钟里两个应用各一行，只能算一分钟。**
    ///
    /// 这是 `typing_spans` 最容易出的错：直接逐行遍历 `minute_stats` 的话，
    /// 同一分钟会被数两遍，「打字时长」凭空翻倍——而且不会报错，只是数字偏大。
    #[test]
    fn 同一分钟多应用只算一分钟() {
        let conn = db_with(&[
            ("2026-01-01", 100, "wps.exe", false),
            ("2026-01-01", 100, "msedge.exe", false),
            ("2026-01-01", 100, "notepad.exe", false),
        ]);
        let s = typing_span_for_day(&conn, "2026-01-01").unwrap();
        assert_eq!(s.active_minutes, 1, "同一分钟的三个应用被数成了几分钟");
        assert_eq!(s.session_minutes, 1);
        assert_eq!(s.longest_minutes, 1);
    }

    /// 间隔阈值是「≤ 5 分钟算同一段」，所以 5 和 6 分界必须分得清。
    #[test]
    fn 会话按五分钟间隔切段() {
        let conn = db_with(&[
            ("2026-01-01", 200, "a.exe", false),
            ("2026-01-01", 205, "a.exe", false), // 间隔 5 → 接得上
            ("2026-01-01", 212, "a.exe", false), // 间隔 7 → 断开
            ("2026-01-01", 214, "a.exe", false), // 间隔 2 → 接上第二段
        ]);
        let s = typing_span_for_day(&conn, "2026-01-01").unwrap();
        assert_eq!(s.active_minutes, 4);
        // 200–205 共 6 分钟（中间的空隙也算），212–214 共 3 分钟。
        assert_eq!(s.session_minutes, 9);
        assert_eq!(s.longest_minutes, 6);
        assert_eq!(s.first_minute, 200);
        assert_eq!(s.last_minute, 214);
    }

    /// 跨午夜的那一段不能串到第二天去。
    #[test]
    fn 跨天分段() {
        let conn = db_with(&[
            ("2026-01-01", 1439, "a.exe", false),
            ("2026-01-02", 1440, "a.exe", false), // 紧挨着，但已经是第二天
        ]);
        let d1 = typing_span_for_day(&conn, "2026-01-01").unwrap();
        let d2 = typing_span_for_day(&conn, "2026-01-02").unwrap();
        assert_eq!(d1.session_minutes, 1);
        assert_eq!(d2.session_minutes, 1);
    }

    /// 速度的分母：同一分钟里只要有一个应用给了精确字数，这一分钟就算数。
    #[test]
    fn 精确分钟数按分钟去重() {
        let conn = db_with(&[
            ("2026-01-01", 300, "wps.exe", true),
            ("2026-01-01", 300, "msedge.exe", false),
            ("2026-01-01", 301, "msedge.exe", false),
        ]);
        let s = typing_span_for_day(&conn, "2026-01-01").unwrap();
        assert_eq!(s.active_minutes, 2);
        // 300 这一分钟有精确字数（wps 给的），301 没有 → 分母是 1，不是 2。
        assert_eq!(s.precise_minutes, 1);
    }

    /// 只有 `key_other`（方向键、快捷键）的分钟不算在打字——Ctrl+S 不是写作。
    #[test]
    fn 其他键不算打字() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        write_batch(
            &mut conn,
            &[StatDelta {
                minute: 400,
                local_day: "2026-01-01".into(),
                local_hour: 0,
                app: "a.exe".into(),
                key_input: 0,
                key_delete: 0,
                key_other: 12,
                char_input: 0,
                char_delete: 0,
                char_source: None,
            }],
            &[],
        )
        .unwrap();
        let s = typing_span_for_day(&conn, "2026-01-01").unwrap();
        assert_eq!(s.active_minutes, 0);
        assert_eq!(s.session_minutes, 0);
    }

    /// **区间是闭区间，首尾两天都要算进来。**
    ///
    /// 周报的期首日 / 期末日直接就是这里传进来的两个字符串（`report::period` 算好），
    /// 所以差一天就是整整报错一天的数据：末尾少一天，或把下期的第一天算进本期。
    #[test]
    fn 区间首尾两天都算在内() {
        let conn = db_with_counts(&[
            ("2026-09-20", 100, "a.exe", false, 5),  // 期前
            ("2026-09-21", 101, "a.exe", false, 7),  // 期首日
            ("2026-09-27", 102, "a.exe", false, 11), // 期末日
            ("2026-09-28", 103, "a.exe", false, 13), // 期后
        ]);
        let s = summary_for_range(&conn, "2026-09-21", "2026-09-27").unwrap();
        assert_eq!(s.key_input, 18, "首尾有一端没算进来");
    }

    /// 覆盖率的分母是**全部**按键，分子只算有适配器上报的那部分。
    ///
    /// 这也是「量不到 ≠ 0」在汇总层的形态：`char_key_input` 是 300 而不是 0，
    /// 因为另外那 700 次按键所在的时段**根本没人报过字数**，不是报了 0 个字。
    #[test]
    fn 区间汇总的覆盖率分子只算有字数的按键() {
        let conn = db_with_counts(&[
            ("2026-09-21", 100, "wps.exe", true, 300),   // 有适配器
            ("2026-09-22", 200, "msedge.exe", false, 700), // 没有
        ]);
        let s = summary_for_range(&conn, "2026-09-21", "2026-09-27").unwrap();
        assert_eq!(s.key_input, 1000);
        assert_eq!(s.char_input, 300);
        assert!(s.has_char, "有应用报过字数，这一段就不是「量不到」");
        assert_eq!(
            s.char_key_input, 300,
            "分子被当成了全部按键，覆盖率会虚报成 100%"
        );
    }

    /// **分应用排行必须按合计排，不能按某一行的值排。**
    ///
    /// 夹具是照着那个 bug 的形状搭的：`big.exe` 有两行，带 `char_source` 的那行
    /// 只有 1 次，不带的那行有 1000 次。`ORDER BY key_input`（裸列名）配
    /// `MAX(char_source)` 时，裸列取的是「提供那个最大值的那一行」的值 ——
    /// 于是排序跟着 `char_source` 走，合计 1001 次的 `big.exe` 掉到了 7 次的后面。
    #[test]
    fn 分应用排行按合计排序() {
        let conn = db_with_counts(&[
            ("2026-09-21", 100, "big.exe", false, 1000),
            ("2026-09-21", 101, "big.exe", true, 1),
            ("2026-09-21", 102, "small.exe", false, 7),
        ]);
        let apps = app_breakdown_range(&conn, "2026-09-21", "2026-09-21").unwrap();
        assert_eq!(apps.len(), 2);
        assert_eq!(
            apps[0].app, "big.exe",
            "合计 1001 次的应用排到了 7 次的应用后面——排序跟着 char_source 走了"
        );
        assert_eq!(apps[0].key_input, 1001, "同一个应用的多行没有合计起来");
        assert_eq!(apps[1].app, "small.exe");
    }

    /// **小时分布永远返回 24 格**，没有记录的小时补 0。
    ///
    /// 补出来的 0 是真的 0（那一小时确实没人打字），和 `has_char: false`
    /// 的「量不到」是两件事。不补满的话柱状图会缺格子，横轴跟着行数走，
    /// 图上「晚上 9 点」那一根会跑到「下午 3 点」的位置——而且看不出来。
    #[test]
    fn 小时分布永远补满二十四格() {
        // helper 把每行都写在 local_hour 0，所以两行会落进同一格。
        let conn = db_with_counts(&[
            ("2026-09-21", 100, "a.exe", false, 3),
            ("2026-09-21", 101, "b.exe", false, 9),
        ]);
        let hs = hour_profile(&conn, "2026-09-21", "2026-09-21").unwrap();
        assert_eq!(hs.len(), 24, "小时数被漏掉了");
        assert_eq!(hs[0].hour, 0);
        assert_eq!(hs[23].hour, 23);
        assert_eq!(hs[0].key_input, 12);
        assert_eq!(hs[9].key_input, 0);
    }

    /// **密钥不能跟着 `get_settings` 出去。**
    ///
    /// `commands::get_settings` 把这张表整个交给 webview，所以只要有一个页面
    /// 调它，没过滤的 key 就是明文泄露 —— 而且不会有任何症状：一切照常显示，
    /// 没人会发现。过滤必须在这一层，不能指望每个调用方自己记得剥掉。
    #[test]
    fn 设置表里的密钥不外发() {
        let conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        set_setting(&conn, "adapter_port", "42180").unwrap();
        set_setting(&conn, "secret.report_api_key", "看起来像明文").unwrap();

        let all = all_settings(&conn).unwrap();
        assert_eq!(all.get("adapter_port").map(String::as_str), Some("42180"));
        assert!(
            !all.contains_key("secret.report_api_key"),
            "密钥跟着设置表外发了"
        );

        // 过滤只挡住「整表外发」这一条路：报告自己要取密钥，取不到就生成不了。
        assert_eq!(
            get_setting(&conn, "secret.report_api_key")
                .unwrap()
                .as_deref(),
            Some("看起来像明文")
        );
    }

    /// **重新生成同一期只覆盖，不新增行。**
    ///
    /// 主键是（期次类型, 期次键），所以「生成了两次」在库里必须还是一期。
    /// 真多出一行的话，期条上会出现两个「第 39 周」，点哪个看运气。
    #[test]
    fn 重新生成同一期只覆盖原来那行() {
        let conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();

        let mut r = ReportRow {
            period_type: "week".into(),
            period_key: "2026-W39".into(),
            starts_on: "2026-09-21".into(),
            ends_on: "2026-09-27".into(),
            generated_at: 1_700_000_000,
            facts_json: "{}".into(),
            sheet: "清单".into(),
            body: "第一版".into(),
            source: "llm".into(),
            model: Some("deepseek-chat".into()),
            note: None,
        };
        upsert_report(&conn, &r).unwrap();

        // 第二次：降级成模板，正文和归因都变了。
        r.generated_at = 1_700_000_500;
        r.body = "第二版".into();
        r.source = "template".into();
        r.model = None;
        r.note = Some("未配置 API key".into());
        upsert_report(&conn, &r).unwrap();

        let idx = report_index(&conn, "week").unwrap();
        assert_eq!(idx.len(), 1, "同一期被存成了两行");
        let meta = &idx["2026-W39"];
        assert_eq!(meta.generated_at, 1_700_000_500, "覆盖没有写到 generated_at");
        assert_eq!(meta.source, "template");
        assert_eq!(meta.model, None, "降级后模型名没有清掉");

        let stored = report_row(&conn, "week", "2026-W39").unwrap().unwrap();
        assert_eq!(stored.body, "第二版");
        assert_eq!(stored.note.as_deref(), Some("未配置 API key"));
    }

    /// 没生成过的期返回 `None` 而不是报错——期条上大部分格子都是这个状态。
    #[test]
    fn 没存档的期返回空() {
        let conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        assert!(report_row(&conn, "week", "2026-W01").unwrap().is_none());
        assert!(report_index(&conn, "week").unwrap().is_empty());
    }
}
