//! 周期算术：把一个日期归到「周」或「月」上，并算出期首日、期末日和显示文案。
//!
//! **全在 Rust 里做，前端一行周期算术都不写。** `lib/dates.ts` 里只有日期格式化，
//! 没有周月分桶的工具；前端也没有测试运行器。而周期边界——年末那一周能跨进明年、
//! 元旦那天可能属于上一年的最后一周——恰恰是那种「写错了界面照样好看」的东西，
//! 所以它待在能跑测试的这一侧。
//!
//! 周用 ISO 8601：**周一起算**，第 1 周是含当年第一个周四的那一周。这和中国习惯
//! 一致（周一是每周第一天），也让「周」的归属有唯一答案，不用自己定规矩。

use chrono::{Datelike, Duration, NaiveDate, Weekday};

/// `reports.period_type` 的两个取值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeriodType {
    Week,
    Month,
}

impl PeriodType {
    /// 存进库、发给前端、从前端收回来，都用这两个字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            PeriodType::Week => "week",
            PeriodType::Month => "month",
        }
    }

    /// 收前端传来的 `periodType`。认不出来就是 `None`——命令层据此拒绝，
    /// 而不是猜一个默认值：猜错了就是给用户看另一期的报告。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "week" => Some(PeriodType::Week),
            "month" => Some(PeriodType::Month),
            _ => None,
        }
    }
}

/// 一期。字段全是算好的成品，调用方不需要再做日期运算。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    /// `"week"` / `"month"`。刻意存成 `&'static str` 而不是 `PeriodType`：
    /// 这个结构体要直接序列化给前端，而那两个字面量就是协议本身。
    pub period_type: &'static str,
    /// 期次键，也是 `reports` 的主键之一。周是 `2026-W39`（周数补零到两位），
    /// 月是 `2026-09`。
    ///
    /// **这两种写法都保证字符串序 = 时间序**，所以期条排序、比新旧、
    /// 判断「哪期更早」直接比字符串就行，不用解回日期。
    /// 补零不是美观问题：`2026-W9` 排在 `2026-W10` 后面。
    pub key: String,
    /// 期条上的短标签：「第 39 周」/「9 月」。
    pub label: String,
    /// 正文里用的完整说法：「2026 年第 39 周」/「2026 年 9 月」。
    ///
    /// 和 `label` 分开是因为两者的场合不同：期条要短，一排放得下 12 个；
    /// 正文要无歧义——期条跨年时会同时出现两个「第 1 周」，
    /// 而正文里说「第 1 周」而不带年份，读的人没法知道是哪一年。
    pub heading: String,
    /// 能直接贴进句子的范围：「2026-09-21 至 2026-09-27」。
    pub range_text: String,
    /// 期首日 YYYY-MM-DD。
    pub starts_on: String,
    /// 期末日 YYYY-MM-DD。
    pub ends_on: String,
}

impl Period {
    /// 这一期是否已经过完。
    ///
    /// **只允许生成已结束的期**，所以这个判断同时是「能不能存档」的闸门。
    ///
    /// `today` 是 `YYYY-MM-DD`，直接比字符串：定长 ISO 日期的字典序就是时间序，
    /// 解回 `NaiveDate` 只是多一次可能失败的转换。**期末日等于今天不算结束**——
    /// 库里还在往今天写（minute_stats 只写当前分钟），这一期的数字下一秒就可能变。
    pub fn is_closed(&self, today: &str) -> bool {
        self.ends_on.as_str() < today
    }
}

fn fmt(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn month_start(d: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(d.year(), d.month(), 1).expect("每个月都有 1 号")
}

/// 按整月平移。`delta` 是月数，可正可负。
///
/// 不写成 `Duration::days(30 * n)`：那样会漂——从 1 月 31 日退一个月得到的是
/// 12 月 31 日，再退一个月就是 12 月 1 日，于是「上一期」会在某个月里跳两期。
/// 这里先归到 1 号再平移，月数才是月数。
fn shift_months(d: NaiveDate, delta: i32) -> NaiveDate {
    let mut year = d.year();
    let mut month = d.month() as i32 + delta;
    while month < 1 {
        month += 12;
        year -= 1;
    }
    while month > 12 {
        month -= 12;
        year += 1;
    }
    NaiveDate::from_ymd_opt(year, month as u32, 1).expect("归到 1 号后的年月一定合法")
}

/// `date` 落在哪一期。
pub fn of_date(period_type: PeriodType, date: NaiveDate) -> Period {
    match period_type {
        PeriodType::Week => {
            let iso = date.iso_week();
            let (year, week) = (iso.year(), iso.week());
            let start = NaiveDate::from_isoywd_opt(year, week, Weekday::Mon)
                .expect("iso_week() 自己吐出来的年周，一定拼得回日期");
            let end = start + Duration::days(6);
            Period {
                period_type: PeriodType::Week.as_str(),
                key: format!("{year}-W{week:02}"),
                label: format!("第 {week} 周"),
                heading: format!("{year} 年第 {week} 周"),
                range_text: format!("{} 至 {}", fmt(start), fmt(end)),
                starts_on: fmt(start),
                ends_on: fmt(end),
            }
        }
        PeriodType::Month => {
            let start = month_start(date);
            let end = shift_months(start, 1) - Duration::days(1);
            let (year, month) = (start.year(), start.month());
            Period {
                period_type: PeriodType::Month.as_str(),
                key: format!("{year}-{month:02}"),
                label: format!("{month} 月"),
                heading: format!("{year} 年 {month} 月"),
                range_text: format!("{} 至 {}", fmt(start), fmt(end)),
                starts_on: fmt(start),
                ends_on: fmt(end),
            }
        }
    }
}

/// 期次键里年份的合法范围。
///
/// **这道闸门是防 panic 的，不是防呆的。** `parse` 是唯一一处拿不受信任的字符串
/// 造日期的地方，而 `of_date` 里的日期算术用的是 `expect` 和 `Add`：
/// 只要进来的年份贴着 chrono 的上界，`shift_months(start, +1)`（月末那一步）
/// 就会被推到上界之外，`from_ymd_opt` 返回 `None`，接着 `.expect` 当场 panic。
///
/// **具体是哪个年份，会跟着 chrono 的版本变。** 写这条注释时锁的是 0.4.45，
/// 它的上界是 262142-12-31（`NaiveDate::MAX`）——所以现在出事的是 `"262142-12"`。
/// 更早的 0.4.x 上界是 262143，那时出事的是 `"262143-12"`。
/// **这正是不能用「贴着上界留一点余量」写法的原因**：那个数会变，
/// 而每变一次，余量就可能从「够」变成「不够」。9999 离两个上界都远得离谱。
///
/// 后果比一般 panic 重得多：这个 crate 的 release profile 是 `panic = "abort"`，
/// `main.rs` 又是 `windows_subsystem = "windows"`——用户机器上**没有控制台、
/// 没有任何提示**，进程直接消失，钩子、采集、看门狗三条线程一起死，
/// 打字统计从此刻起静默停摆，而界面上下一次重开才会发现。
/// 一个字符串参数能导致这个后果，闸门就必须卡在这里。
///
/// 上限取 9999 而不是贴着 chrono 的上界：留出余量让月末那一步
/// （`shift_months(start, +1)`，还有周键的 `+6 天`）永远够得着边界之外。
/// 下限取 Unix 纪元——这个程序不可能有比它更早的数据。
const MIN_YEAR: i32 = 1970;
const MAX_YEAR: i32 = 9999;

/// 把期次键解回一期。只认自己写出去的那种写法。
///
/// 解完再走一遍 `of_date` 核一次键是否原样回来。这一道不是多余：`2026-W1`
/// （少补一个零）和 `2026-0` 都能被 `parse::<u32>()` 吃下去，但拼回来的键
/// 是 `2026-W01`——**期条上的键必须和库里的一模一样**，对不上就当不合法，
/// 否则前端传 `2026-W1` 进来会生成一份键为 `2026-W01` 的报告，
/// 而它和用户在期条上点的那一格并不是同一个东西。
pub fn parse(period_type: PeriodType, key: &str) -> Option<Period> {
    let (year, date) = match period_type {
        PeriodType::Week => {
            let (y, w) = key.split_once("-W")?;
            let year = y.parse().ok()?;
            (year, NaiveDate::from_isoywd_opt(year, w.parse().ok()?, Weekday::Mon)?)
        }
        PeriodType::Month => {
            let (y, m) = key.split_once('-')?;
            let year = y.parse().ok()?;
            (year, NaiveDate::from_ymd_opt(year, m.parse().ok()?, 1)?)
        }
    };

    // **必须在 `of_date` 之前。** 上面那两行只保证「日期本身拼得出来」，
    // 不保证「拿它做日期算术不越界」——`from_ymd_opt(262142, 12, 1)` 是成功的，
    // 出事的是下一步的月末。见 `MIN_YEAR` 的注释。
    //
    // 比的是**键里写的那个年份**，不是解出来的日期所在年：ISO 周的归属年
    // 和它周一的自然年可以差一年（2026-W01 的周一是 2025-12-29），
    // 而键里写的就是归属年。
    if !(MIN_YEAR..=MAX_YEAR).contains(&year) {
        return None;
    }

    let p = of_date(period_type, date);
    (p.key == key).then_some(p)
}

/// 平移 `back` 期。周按 7 天退（同一天落回同一周），月按月退。
fn step_back(period_type: PeriodType, date: NaiveDate, back: usize) -> NaiveDate {
    match period_type {
        // 退 7 的整数倍，星期几不变，所以一定还在同一周里的同一天。
        PeriodType::Week => date - Duration::days(7 * back as i64),
        PeriodType::Month => shift_months(month_start(date), -(back as i32)),
    }
}

/// 截至 `today` 的最近 `count` 期，**从旧到新**，最后一项是含今天的当前期。
///
/// 当前期也在里面（期条上要占一格，只是不可点）。不放的话，用户周一打开会以为
/// 「这一周怎么没了」——期条上没有它，看起来就像程序漏了一期。
pub fn recent(period_type: PeriodType, today: NaiveDate, count: usize) -> Vec<Period> {
    (0..count)
        .rev()
        .map(|back| of_date(period_type, step_back(period_type, today, back)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn week_of(s: &str) -> String {
        of_date(PeriodType::Week, d(s)).key
    }

    /// 年末那一周可以跨到明年：2026 年第 53 周从 12 月 28 号开始，到 2027 年 1 月 3 号。
    ///
    /// 这是整个功能里最容易写错的一格——`starts_on` 在十二月、`ends_on` 在**明年**。
    /// 用「当年 12 月 31 号往前推」之类的算法写，这一周会被切成两段。
    #[test]
    fn 年末那一周跨到明年() {
        let p = of_date(PeriodType::Week, d("2026-12-28"));
        assert_eq!(p.key, "2026-W53");
        assert_eq!(p.starts_on, "2026-12-28");
        assert_eq!(p.ends_on, "2027-01-03", "跨年的那一周没有跨到明年");
        assert_eq!(p.range_text, "2026-12-28 至 2027-01-03");

        // 同一周的周中和周末必须落在同一期里。
        assert_eq!(week_of("2026-12-31"), "2026-W53");
        assert_eq!(week_of("2027-01-01"), "2026-W53");
        assert_eq!(week_of("2027-01-03"), "2026-W53", "周日被算进了下一周");
    }

    /// 十二月三十号可能是下一年的第一周：2024-12-30（周一）属于 2025-W01。
    ///
    /// 2024 是闰年，2024-12-30 开始的那一周含 2025-01-01 之前的周四（1 月 2 日），
    /// 所以它是 2025 年的第 1 周。按「年份取自然年」写的算法会给出 2024-W53，那是错的。
    #[test]
    fn 十二月三十号属于下一年的第一周() {
        let p = of_date(PeriodType::Week, d("2024-12-30"));
        assert_eq!(p.key, "2025-W01");
        assert_eq!(p.heading, "2025 年第 1 周");
        assert_eq!(p.starts_on, "2024-12-30");
        assert_eq!(p.ends_on, "2025-01-05");
    }

    /// 元旦、以及一月初的几天，都可能还属于**上一年**的最后一周。
    #[test]
    fn 元旦可能还属于上一年的最后一周() {
        // 2026-01-01（周四）：所在的那一周含 2026 年的第一个周四，所以是 2026-W01。
        assert_eq!(week_of("2026-01-01"), "2026-W01");

        // 2021-01-01（周五）：那一周整个在 2021 年，但没有周四落在 2021 年
        // （2020-12-31 是它唯一的周四，在 2020 年），所以归 2020-W53。
        let p = of_date(PeriodType::Week, d("2021-01-01"));
        assert_eq!(p.key, "2020-W53");
        assert_eq!(p.heading, "2020 年第 53 周");
        assert_eq!(p.ends_on, "2021-01-03");

        // 2027-01-04（周一）才翻到新的一年第 1 周。
        assert_eq!(week_of("2027-01-04"), "2027-W01");
    }

    /// 周数补零到两位，于是**键的字符串序就是时间序**。
    ///
    /// 不补零的话 `2026-W9` 会排在 `2026-W10` 后面——期条顺序错乱，
    /// 而且顺序这种东西没人会去核对，只会觉得「怎么怪怪的」。
    #[test]
    fn 周数补零到两位() {
        let p = of_date(PeriodType::Week, d("2026-03-02")); // 2026 年第 10 周
        assert_eq!(p.key, "2026-W10");
        assert_eq!(of_date(PeriodType::Week, d("2026-02-23")).key, "2026-W09");
        assert!(
            "2026-W09" < "2026-W10",
            "字符串序和时间序对不上，期条顺序会错"
        );
    }

    /// 月份区间的首尾：月末是大月 31、平月 28、闰年二月 29。
    #[test]
    fn 月份区间的末日在算() {
        let p = of_date(PeriodType::Month, d("2026-09-15"));
        assert_eq!(p.key, "2026-09");
        assert_eq!(p.label, "9 月");
        assert_eq!(p.heading, "2026 年 9 月");
        assert_eq!(p.starts_on, "2026-09-01");
        assert_eq!(p.ends_on, "2026-09-30");

        assert_eq!(of_date(PeriodType::Month, d("2026-02-01")).ends_on, "2026-02-28");
        assert_eq!(of_date(PeriodType::Month, d("2024-02-01")).ends_on, "2024-02-29");
        assert_eq!(of_date(PeriodType::Month, d("2026-12-31")).ends_on, "2026-12-31");
    }

    /// 期次键只有一种合法写法，别的都拒绝，而不是「尽力解释」。
    #[test]
    fn 不合法的期次键被拒绝() {
        for bad in ["2026-W1", "2026-W54", "2027-W53", "abc", "", "2026-W", "2026-W39x"] {
            assert!(
                parse(PeriodType::Week, bad).is_none(),
                "周键 {bad:?} 被当成合法了"
            );
        }
        for bad in ["2026-13", "2026-0", "2026-9", "2026", "abc", ""] {
            assert!(
                parse(PeriodType::Month, bad).is_none(),
                "月键 {bad:?} 被当成合法了"
            );
        }

        // 合法的能原样解回来——键是主键，解出来必须分毫不差。
        assert_eq!(parse(PeriodType::Week, "2026-W39").unwrap().starts_on, "2026-09-21");
        assert_eq!(parse(PeriodType::Month, "2026-09").unwrap().starts_on, "2026-09-01");
        // 类型也要对上：周键不能从月那条路解出来。
        assert!(parse(PeriodType::Month, "2026-W39").is_none());
    }

    /// 极端年份的键要被拒绝，**不能让它走到日期算术里去**。
    ///
    /// 贴着 chrono 上界的年份能过格式校验（`from_ymd_opt` / `from_isoywd_opt`
    /// 都会成功），但紧接着的月末（或周末）运算会把它推到上界之外，越界 panic。
    /// release 是 `panic = "abort"` 加窗口子系统：进程**无声消失**，
    /// 而且是从那一刻起不再记录。
    ///
    /// **那条上界是哪一年，跟着 chrono 的版本变**——0.4.45 是 262142，
    /// 更早的 0.4.x 是 262143。所以这条测试不写死年份，而是从 `NaiveDate::MAX`
    /// 现取：写死的话，上游每动一次界，测试要么无端挂掉，要么悄悄失去意义。
    /// 现在的形状是**先证明危险真的存在**（下面两条前提），再断言闸门挡住了它；
    /// 哪天上游收紧了范围、危险自己消失了，前提会先挂——那时闸门可以撤，
    /// 但得有人知道是自己撤的，而不是被上游悄悄改掉的。
    ///
    /// 这条测试盯的就是那个字符串。原来的用例只覆盖了格式非法的那一批，
    /// 「量级」这一维是空的，所以它能过。
    #[test]
    fn 极端年份的期次键被拒绝而不是崩掉() {
        let top = NaiveDate::MAX.year();

        // 前提一：上界年的 12 月 1 号拼得出来 → 这个键确实能一路走到日期算术，
        // 闸门不是「反正也拼不出来」的摆设。
        assert!(
            NaiveDate::from_ymd_opt(top, 12, 1).is_some(),
            "chrono 的上界年 {top} 连 12 月 1 号都拼不出来，这条用例的前提不成立了"
        );
        // 前提二：上界年再往后一个月就出界 → 月末那一步
        // （`of_date` 月分支里的 `shift_months(start, +1)`）真的会越界。
        // 这两条合起来才是「危险存在」的完整证据。
        assert!(
            NaiveDate::from_ymd_opt(top + 1, 1, 1).is_none(),
            "chrono 的上界年 +1 居然拼得出来，月末那一步不会越界了，重新评估这道闸门"
        );

        for bad in [
            // 现取的上界年，以及历史上曾经是上界的那两个——闸门都该拦。
            format!("{top}-W01"),
            "262143-W53".to_string(),
            "262143-W01".to_string(),
            "10000-W01".to_string(),
            "1969-W01".to_string(),
            "0000-W01".to_string(),
        ] {
            assert!(
                parse(PeriodType::Week, &bad).is_none(),
                "周键 {bad:?} 被放行了"
            );
        }
        for bad in [
            format!("{top}-12"),
            "262143-12".to_string(),
            "10000-01".to_string(),
            "1969-12".to_string(),
            "0000-01".to_string(),
        ] {
            assert!(
                parse(PeriodType::Month, &bad).is_none(),
                "月键 {bad:?} 被放行了"
            );
        }

        // 边界内的一格都不能误伤——闸门卡的是年份，不是「看着很大」。
        // 同时钉住「闸门内的年份 chrono 确实还认」：否则闸门卡的就是库的范围，
        // 而不是产品的判断，收得再紧也测不出东西来。
        assert!(
            NaiveDate::from_ymd_opt(MAX_YEAR, 12, 31).is_some(),
            "闸门内最大的那一格 chrono 已经不接受了，闸门的上界该往下挪了"
        );
        assert!(parse(PeriodType::Month, "1970-01").is_some());
        assert!(parse(PeriodType::Month, "9999-12").is_some());
        assert!(parse(PeriodType::Week, "1970-W01").is_some());
        assert!(parse(PeriodType::Week, "9999-W01").is_some());
    }

    /// 最近几期从旧到新排，最后一项是当前期，且只有它还没结束。
    #[test]
    fn 最近的期从旧到新且最后一项是当前期() {
        let today = d("2026-09-23"); // 周三
        let ps = recent(PeriodType::Week, today, 3);
        let keys: Vec<&str> = ps.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, vec!["2026-W37", "2026-W38", "2026-W39"]);
        assert_eq!(ps[0].starts_on, "2026-09-07");
        assert_eq!(ps[2].starts_on, "2026-09-21");
        assert_eq!(ps[2].ends_on, "2026-09-27");

        // 今天在最后一期里，所以它没结束；前面两期都结束了。
        let today_s = "2026-09-23";
        assert!(!ps[2].is_closed(today_s), "当前期被当成了已结束");
        assert!(ps[1].is_closed(today_s));
        assert!(ps[0].is_closed(today_s));

        // 期末日**就是今天**的那一期也还没结束：库里还在往今天写。
        let edge = parse(PeriodType::Week, "2026-W38").unwrap(); // 09-14 .. 09-20
        assert!(!edge.is_closed("2026-09-20"));
        assert!(edge.is_closed("2026-09-21"));
    }

    /// 月的最近几期要能跨年——`shift_months` 写错的话这里会漂。
    #[test]
    fn 月的最近几期跨年() {
        let ps = recent(PeriodType::Month, d("2026-02-15"), 3);
        let keys: Vec<&str> = ps.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, vec!["2025-12", "2026-01", "2026-02"]);
        assert_eq!(ps[0].ends_on, "2025-12-31");
        assert_eq!(ps[1].starts_on, "2026-01-01");
        assert_eq!(ps[2].ends_on, "2026-02-28");

        // 跨 12 个月的窗口里每一期都不同——漂了的话会出现重复或跳月。
        let year = recent(PeriodType::Month, d("2026-06-10"), 12);
        let mut keys: Vec<String> = year.iter().map(|p| p.key.clone()).collect();
        assert_eq!(keys.remove(0), "2025-07");
        assert_eq!(keys.last().unwrap(), "2026-06");
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), 11, "12 个月的窗口里出现了重复的期");
    }

    /// 周键跨年时也保持字符串序 = 时间序。
    #[test]
    fn 跨年的周键仍然有序() {
        let ps = recent(PeriodType::Week, d("2027-01-06"), 4);
        let keys: Vec<&str> = ps.iter().map(|p| p.key.as_str()).collect();
        // 2027-01-06 是周三，属于 2027-W01。往前一周是 2026-12-30，
        // 它落在 **2026-W53**——2026 有 53 周，所以这里不能想当然写成 W52。
        assert_eq!(keys, vec!["2026-W51", "2026-W52", "2026-W53", "2027-W01"]);
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(sorted, keys, "跨年的期条顺序和字符串序不一致");
    }
}
