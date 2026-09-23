//! 把库里的记录导出成 CSV / JSON 文件。
//!
//! ## 为什么要有这个
//!
//! 数据是这个程序唯一真正属于用户的东西，而它一直关在
//! `%APPDATA%\com.typestat.app\typestat.db` 里——那是个得用专门工具才打得开的
//! SQLite 文件。导出让「把我的数据拿走」变成一次点击，而不必先学会用 `sqlite3`。
//!
//! ## 两个格式各自回答什么
//!
//! · **CSV 是一张表**：一天一行。表格软件打开就能画图、透视、求和——
//!   那是这个格式唯一擅长的事，所以只放这一张表。嵌套会把它毁掉。
//! · **JSON 是这一段的全量**：按天、按小时、按应用三张表一起放。
//!   能嵌套本来就是 JSON 存在的理由。
//!
//! 两种格式**用同一套字段名**（`keyInput`、`charInput`…），换一种读法不用重新
//! 对字段。所以表头是英文的：界面上那些中文名是给人看的，这里是给程序读的。
//!
//! ## 一条不能破的线：`null` 是量不到，`0` 是记了但真的没有
//!
//! 这是整个程序一直在守的那条规矩（见 `db::Summary::has_char` 的注释）。
//! 导出文件会脱离程序单独存在，所以它必须**自己带着这个约定**：
//! JSON 里是 `null`，CSV 里是**空字段**——表格软件里空单元格和 0 长得就不一样。
//! JSON 里另有一份 `notes` 把这条和另外几条口径写清楚，免得文件过几个月
//! 变成一份谁也说不清 `0` 是什么意思的表格。

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::db::{AppPoint, HourPoint, Summary, TypingSpan};

/// 写进 JSON 的那份说明。
///
/// **不是注释，是数据。** 文件会被拷走、被别的程序读、过几个月再打开，
/// 而那时候没有人记得 `charInput: null` 是什么意思。
pub const NOTES: [&str; 6] = [
    "charInput / charDelete / netChars 为 null（CSV 里是空字段）表示「量不到」：那段时间没有任何应用上报过精确字数。它是「不知道」，不是 0。",
    "keyInput 覆盖全部应用；char* 只覆盖装了适配器的应用，所以这两类数不能直接拿来比大小。",
    "days 里只有有记录的日期。没有记录的那天不在里面——那不是打了 0 次，是没有任何数据。",
    "sessionMinutes 的算法：相邻两次输入的间隔不超过 5 分钟算同一段，段内的空隙也计入段长。activeMinutes 是有输入或删除的分钟数，两者同源。",
    "hours 和 apps 是整个区间汇总出来的，不是某一天的。",
    "应用名是可执行文件名（如 wps.exe）。界面上显示的是去掉 .exe 的短名，两者指的是同一个应用。",
];

/// 导出的两种格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Json,
}

impl Format {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "csv" => Ok(Format::Csv),
            "json" => Ok(Format::Json),
            // 把收到的值原样带回去：前端传错了要能一眼看出传的是什么，
            // 只说「格式不对」等于让人去猜。
            other => Err(format!("不认识的导出格式：{other}")),
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Json => "json",
        }
    }
}

/// 校验一个日期键。**不收下不合法的**——它会被拼进 SQL 的范围条件，
/// 也会被拼进文件名，两处都不该让一份来路不明的字符串进去。
pub fn check_day(s: &str) -> Result<String, String> {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|_| s.to_string())
        .map_err(|_| format!("不是合法的日期（要 YYYY-MM-DD）：{s}"))
}

/// 导出结果。前端要把它写在界面上：**文件去哪儿了必须说出来**，
/// 不然用户点了按钮，界面上什么都没变，只能自己去翻电脑。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    /// 文件所在目录。界面上那个「打开文件夹」按它走。
    pub dir: String,
    /// CSV 是数据行数；JSON 是「天 + 小时 + 应用」三段的行数之和。
    pub rows: usize,
    pub bytes: usize,
    pub from: String,
    pub to: String,
}

// ——————————————————————————————————————————————————————————————
// 渲染
// ——————————————————————————————————————————————————————————————

/// CSV 的一个字段。
///
/// **目前的几列（日期、纯数字）都不会触发引号**，但列是会加的——写一个
/// 「只在今天安全」的 CSV 是给自己埋雷，而 CSV 里的引号一旦写错，
/// 表现是整张表从那一行开始错位，看起来像数据本身坏了。
fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 一天里那三个字数格子。量不到时是**空串**，不是 `"0"`。
fn chars_cells(s: &Summary) -> [String; 3] {
    if s.has_char {
        [
            s.char_input.to_string(),
            s.char_delete.to_string(),
            s.net_chars().to_string(),
        ]
    } else {
        [String::new(), String::new(), String::new()]
    }
}

/// CSV 的表头。和 JSON 的键一一对应，见模块头。
pub const CSV_HEADER: [&str; 10] = [
    "day",
    "keyInput",
    "keyDelete",
    "keyOther",
    "charInput",
    "charDelete",
    "netChars",
    "charKeyInput",
    "sessionMinutes",
    "activeMinutes",
];

/// 按天一张表。**只有有记录的日子才有行**：没有记录的那天既不是 0
/// 也不是任何测量结果，补一行 0 就是替用户编了一天出来。
pub fn csv_days(days: &[(String, Summary)], spans: &HashMap<String, TypingSpan>) -> String {
    // 开头那个 BOM 是给 Excel 的：没有它，双击打开会把 UTF-8 当成本地代码页，
    // 应用名和日期里的中文就成了乱码，而乱码看起来像数据坏了。
    // 程序读这份文件时要记得跳过它（`utf-8-sig` / `encoding="utf-8-sig"`）。
    let mut out = String::from("\u{feff}");
    out.push_str(&CSV_HEADER.join(","));
    // CRLF：RFC 4180 就是这么定的，也是 Excel 最省事的那一种。
    out.push_str("\r\n");

    for (day, s) in days {
        let span = spans.get(day).copied().unwrap_or_default();
        let [ci, cd, net] = chars_cells(s);
        let cols: Vec<String> = vec![
            day.clone(),
            s.key_input.to_string(),
            s.key_delete.to_string(),
            s.key_other.to_string(),
            ci,
            cd,
            net,
            s.char_key_input.to_string(),
            span.session_minutes.to_string(),
            span.active_minutes.to_string(),
        ];
        out.push_str(&cols.iter().map(|c| csv_field(c)).collect::<Vec<_>>().join(","));
        out.push_str("\r\n");
    }
    out
}

/// 量不到就是 `null`，不是 0。**整个导出里只有这一个地方做这个判断**，
/// 三个调用点（天、小时、应用）都走它，免得哪个地方漏写一次就多出一堆假 0。
fn opt(v: i64, has: bool) -> Value {
    if has {
        json!(v)
    } else {
        Value::Null
    }
}

/// 这一段的全量。返回 `Result` 而不是 `String`：序列化理论上不会失败
/// （这里只有整数、字符串和 null），但真失败了要能报出来——
/// 悄悄写出去一份空文件，比报个错难查得多。
pub fn json_dump(
    from: &str,
    to: &str,
    generated_at: &str,
    days: &[(String, Summary)],
    spans: &HashMap<String, TypingSpan>,
    hours: &[HourPoint],
    apps: &[AppPoint],
) -> Result<String, String> {
    let day_values: Vec<Value> = days
        .iter()
        .map(|(day, s)| {
            let span = spans.get(day).copied().unwrap_or_default();
            json!({
                "day": day,
                "keyInput": s.key_input,
                "keyDelete": s.key_delete,
                "keyOther": s.key_other,
                "charInput": opt(s.char_input, s.has_char),
                "charDelete": opt(s.char_delete, s.has_char),
                "netChars": opt(s.net_chars(), s.has_char),
                "charKeyInput": s.char_key_input,
                // 时长跟口径无关，所以这两个没有 null 这一说。
                "sessionMinutes": span.session_minutes,
                "activeMinutes": span.active_minutes,
                "longestMinutes": span.longest_minutes,
            })
        })
        .collect();

    let hour_values: Vec<Value> = hours
        .iter()
        .map(|h| {
            json!({
                "hour": h.hour,
                "keyInput": h.key_input,
                "keyDelete": h.key_delete,
                "charInput": opt(h.char_input, h.has_char),
                "charDelete": opt(h.char_delete, h.has_char),
                "charKeyInput": h.char_key_input,
            })
        })
        .collect();

    let app_values: Vec<Value> = apps
        .iter()
        .map(|a| {
            let has = a.char_source.is_some();
            json!({
                "app": a.app,
                "keyInput": a.key_input,
                "charInput": opt(a.char_input, has),
                "charDelete": opt(a.char_delete, has),
                // null = 这个应用从来没报过精确字数。它和「报了但是 0」不是一回事，
                // 而这一列正是两者的分界，所以它必须留在文件里。
                "charSource": a.char_source,
            })
        })
        .collect();

    let doc = json!({
        "app": "TypeStat",
        "version": env!("CARGO_PKG_VERSION"),
        "generatedAt": generated_at,
        "from": from,
        "to": to,
        "notes": NOTES,
        "days": day_values,
        "hours": hour_values,
        "apps": app_values,
    });

    serde_json::to_string_pretty(&doc).map_err(|e| format!("生成 JSON 失败：{e}"))
}

// ——————————————————————————————————————————————————————————————
// 落盘
// ——————————————————————————————————————————————————————————————

/// 导出目录：`%USERPROFILE%\Downloads\TypeStat`。
///
/// 拿不到 `USERPROFILE`（极少见）时退到 `fallback`——调用方给的是数据库所在目录。
/// **绝不悄悄退到临时目录**：临时目录里的文件用户找不着，而界面上写着「已导出」。
pub fn export_dir(fallback: &Path) -> PathBuf {
    match std::env::var_os("USERPROFILE") {
        Some(home) if !home.is_empty() => Path::new(&home).join("Downloads").join("TypeStat"),
        _ => fallback.to_path_buf(),
    }
}

/// 写文件，**同名就顺延 `-2`、`-3`，绝不覆盖**。
///
/// 导出的文件用户可能已经改过、正开着、或者拿去做别的了，而覆盖是不可逆的。
/// 「再点一次导出」是个太容易发生的动作，不该有这种后果。
pub fn write_unique(dir: &Path, stem: &str, ext: &str, data: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 1u32;
    while path.exists() {
        n += 1;
        path = dir.join(format!("{stem}-{n}.{ext}"));
    }
    fs::write(&path, data)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day_of(key_input: i64, has_char: bool) -> Summary {
        Summary {
            key_input,
            key_delete: 10,
            key_other: 3,
            char_input: if has_char { 250 } else { 0 },
            char_delete: if has_char { 5 } else { 0 },
            has_char,
            char_key_input: if has_char { key_input } else { 0 },
        }
    }

    fn spans_of(pairs: &[(&str, i64)]) -> HashMap<String, TypingSpan> {
        pairs
            .iter()
            .map(|(d, m)| {
                (
                    d.to_string(),
                    TypingSpan {
                        active_minutes: *m,
                        session_minutes: *m + 5,
                        ..Default::default()
                    },
                )
            })
            .collect()
    }

    /// 这一条就是模块头里那条规矩的执行者。
    #[test]
    fn csv_里量不到的字数是空字段而不是零() {
        let days = vec![
            ("2026-09-01".to_string(), day_of(100, false)),
            ("2026-09-02".to_string(), day_of(200, true)),
        ];
        let csv = csv_days(&days, &spans_of(&[("2026-09-01", 5), ("2026-09-02", 9)]));
        let lines: Vec<&str> = csv.lines().collect();

        let missing: Vec<&str> = lines[1].split(',').collect();
        // keyInput, keyDelete, keyOther 是真的数字（那几天确实在打字）……
        assert_eq!(missing[1], "100");
        // ……但三个字数格子必须是空的。「0 字」是结论，「量不到」是不知道。
        assert_eq!(missing[4], "", "量不到的字数被写成了 {}", missing[4]);
        assert_eq!(missing[5], "");
        assert_eq!(missing[6], "");

        // 有字数的那一天照常写数字——不能为了「空」把所有天都空掉。
        let present: Vec<&str> = lines[2].split(',').collect();
        assert_eq!(present[4], "250");
        assert_eq!(present[6], "245");
    }

    #[test]
    fn csv_开头是_bom_加表头() {
        let csv = csv_days(&[("2026-09-01".to_string(), day_of(1, true))], &spans_of(&[]));
        assert!(csv.starts_with('\u{feff}'), "少了 BOM，Excel 会把中文读成乱码");
        let header = csv.lines().next().unwrap();
        assert_eq!(header.trim_start_matches('\u{feff}'), CSV_HEADER.join(","));
        // 表头和数据之间是 CRLF，不是裸 \n。
        assert!(csv.contains(&format!("{}\r\n", CSV_HEADER.join(","))));
    }

    #[test]
    fn csv_的字段该引号时才引号() {
        assert_eq!(csv_field("wps.exe"), "wps.exe");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("two\nlines"), "\"two\nlines\"");
    }

    #[test]
    fn csv_里没有记录的日子不出现在表里() {
        // 只有一天有记录，表格就只有一行数据。补一行 0 上去等于替用户编了一天。
        let csv = csv_days(&[("2026-09-01".to_string(), day_of(1, true))], &spans_of(&[]));
        assert_eq!(csv.lines().count(), 2, "表头一行 + 数据一行");
    }

    #[test]
    fn json_里量不到的字数是_null_而不是零() {
        let days = vec![
            ("2026-09-01".to_string(), day_of(100, false)),
            ("2026-09-02".to_string(), day_of(200, true)),
        ];
        let text = json_dump(
            "2026-09-01",
            "2026-09-02",
            "2026-09-24 21:00:00 +08:00",
            &days,
            &spans_of(&[("2026-09-02", 9)]),
            &[],
            &[],
        )
        .unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();

        let first = &v["days"][0];
        assert!(first["charInput"].is_null(), "量不到被写成了 0");
        assert!(first["charDelete"].is_null());
        assert!(first["netChars"].is_null());
        // 按键数是全量口径，任何一天都不该是 null。
        assert_eq!(first["keyInput"], 100);

        let second = &v["days"][1];
        assert_eq!(second["charInput"], 250);
        assert_eq!(second["netChars"], 245);
        assert_eq!(second["sessionMinutes"], 14);
    }

    #[test]
    fn json_带着那份说明自己解释自己() {
        let text = json_dump("2026-09-01", "2026-09-01", "now", &[], &HashMap::new(), &[], &[])
            .unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["notes"].as_array().unwrap().len(), NOTES.len());
        // 那份说明必须真的说出「null 不是 0」，否则它就只是一堆漂亮话。
        assert!(NOTES.iter().any(|n| n.contains("量不到")));
    }

    #[test]
    fn json_里没有字数的应用_char_source_是_null() {
        let apps = vec![
            AppPoint {
                app: "wps.exe".into(),
                key_input: 900,
                char_input: 1800,
                char_delete: 20,
                char_source: Some("plugin".into()),
            },
            AppPoint {
                app: "Obsidian.exe".into(),
                key_input: 300,
                char_input: 0,
                char_delete: 0,
                char_source: None,
            },
        ];
        let text = json_dump(
            "2026-09-01",
            "2026-09-01",
            "now",
            &[],
            &HashMap::new(),
            &[],
            &apps,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["apps"][0]["charInput"], 1800);
        assert!(v["apps"][1]["charSource"].is_null());
        // 那个应用敲了 300 次键，字数却是「量不到」——这一格不能是 0，
        // 否则求和的人会把「不知道」加进总数里。
        assert!(v["apps"][1]["charInput"].is_null());
        assert_eq!(v["apps"][1]["keyInput"], 300);
    }

    #[test]
    fn 格式名认不出来时把收到的值原样报出来() {
        assert_eq!(Format::parse("csv").unwrap(), Format::Csv);
        assert_eq!(Format::parse("json").unwrap(), Format::Json);
        assert!(Format::parse("xlsx").unwrap_err().contains("xlsx"));
    }

    #[test]
    fn 日期不合法就不放行() {
        assert!(check_day("2026-09-01").is_ok());
        assert!(check_day("2026-13-01").is_err());
        assert!(check_day("").is_err());
        // 这一条是关键：拼进 SQL 和文件名的字符串不能是任意的。
        assert!(check_day("2026-09-01' OR 1=1 --").is_err());
    }

    #[test]
    fn 同名文件顺延而不是覆盖() {
        // 用进程号隔开：测试是并行跑的，不能共用一个目录。
        let dir = std::env::temp_dir().join(format!("typestat-export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let a = write_unique(&dir, "typestat-x", "csv", "first").unwrap();
        let b = write_unique(&dir, "typestat-x", "csv", "second").unwrap();

        assert_ne!(a, b, "第二次导出把第一次的文件盖掉了");
        assert!(a.ends_with("typestat-x.csv"));
        assert!(b.ends_with("typestat-x-2.csv"));
        assert_eq!(fs::read_to_string(&a).unwrap(), "first");

        let _ = fs::remove_dir_all(&dir);
    }
}
