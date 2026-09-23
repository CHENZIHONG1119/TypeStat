//! 测试用的 `ReportFacts` 样本。
//!
//! 单独一个文件而不是塞进某个 `mod tests`：渲染（`text`）和接口（`llm`）
//! 两边都要用同一批样本，而**样本一旦有两份，两边测的就不是同一件事了**——
//! 「模板里的数字都能在清单里找到」这条正是靠「两边吃同一份 facts」才有意义。
//!
//! 样本里的数字和计划里那张清单的例子一致，人眼核对时不用来回换脑子。

#![cfg(test)]

use super::period::{of_date, PeriodType};
use super::{weekday_cn, AppFacts, DayFacts, HourFacts, ReportFacts};

pub fn day(s: &str) -> chrono::NaiveDate {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

/// 一天。星期几走 `mod.rs` 里那个唯一的实现，**不在这里另写一份**：
/// 两份「周一…周日」迟早在某个地方分叉，而分叉出来的那天是看不见的。
pub fn day_facts(s: &str, keys: i64) -> DayFacts {
    DayFacts {
        day: s.to_string(),
        weekday: weekday_cn(s),
        key_input: keys,
    }
}

/// 有字数、有记录的一期。
pub fn 有字数() -> ReportFacts {
    let p = of_date(PeriodType::Week, day("2026-09-23"));
    ReportFacts {
        period_type: p.period_type.to_string(),
        period_key: p.key,
        heading: p.heading,
        range_text: p.range_text,
        starts_on: p.starts_on,
        ends_on: p.ends_on,
        active_days: 5,
        period_days: 7,
        key_input: 24_381,
        key_delete: 1_204,
        key_other: 993,
        key_delete_rate: Some(1_204.0 / 24_381.0),
        char_input: Some(18_204),
        char_delete: Some(1_338),
        net_chars: Some(16_866),
        char_delete_rate: Some(1_338.0 / 18_204.0),
        char_key_input: 20_067,
        coverage: Some(20_067.0 / 24_381.0),
        session_minutes: 582,
        active_minutes: 371,
        longest_minutes: 68,
        precise_minutes: 336,
        keys_per_minute: Some(24_381.0 / 371.0),
        chars_per_minute: Some(18_204.0 / 336.0),
        days: vec![
            day_facts("2026-09-21", 4_838),
            day_facts("2026-09-22", 3_102),
            day_facts("2026-09-23", 6_020),
            day_facts("2026-09-24", 2_415),
            day_facts("2026-09-25", 8_006),
        ],
        hours: (0..24)
            .map(|h| HourFacts {
                hour: h,
                key_input: if h == 21 { 2_109 } else { 0 },
            })
            .collect(),
        apps: vec![
            AppFacts {
                app: "wps".into(),
                key_input: 3_340,
                char_input: Some(7_415),
                has_char: true,
            },
            AppFacts {
                app: "WindowsTerminal".into(),
                key_input: 1_432,
                char_input: None,
                has_char: false,
            },
        ],
        apps_total: 5,
        apps_omitted: 3,
        apps_omitted_keys: 41,
        busiest_hour: Some(21),
        busiest_hour_keys: 2_109,
        bogus_days: 0,
    }
}

/// 同一期，但一个适配器都没上报过字数——「量不到」在浏览器里可达的那个状态。
pub fn 无字数() -> ReportFacts {
    ReportFacts {
        char_input: None,
        char_delete: None,
        net_chars: None,
        char_delete_rate: None,
        char_key_input: 0,
        coverage: None,
        precise_minutes: 0,
        chars_per_minute: None,
        apps: vec![AppFacts {
            app: "WindowsTerminal".into(),
            key_input: 1_432,
            char_input: None,
            has_char: false,
        }],
        apps_total: 1,
        apps_omitted: 0,
        apps_omitted_keys: 0,
        ..有字数()
    }
}

/// 一期完全没有记录。
pub fn 无记录() -> ReportFacts {
    ReportFacts {
        active_days: 0,
        key_input: 0,
        key_delete: 0,
        key_other: 0,
        key_delete_rate: None,
        session_minutes: 0,
        active_minutes: 0,
        longest_minutes: 0,
        precise_minutes: 0,
        keys_per_minute: None,
        days: vec![],
        // **二十四格，全是 0。** 真实的 `hour_profile` 永远返回 24 行，
        // 样本要是给个空数组，就测不到「0 也必须写出来」这件事——
        // 而「模型把缺失的小时解释成你上午不工作」正是要靠它挡住的。
        hours: (0..24).map(|hour| HourFacts { hour, key_input: 0 }).collect(),
        apps: vec![],
        apps_total: 0,
        apps_omitted: 0,
        apps_omitted_keys: 0,
        busiest_hour: None,
        busiest_hour_keys: 0,
        bogus_days: 0,
        ..无字数()
    }
}
