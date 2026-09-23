//! 事件该落在哪一分钟、哪个本地小时、哪个本地日。
//!
//! 这件事看着琐碎，但它同时是**热路径**和**唯一能 panic 的稳态路径**，
//! 所以单独拿出来写，理由都留在下面。

use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;

/// 一天多少秒。用常量而不是字面量：下面几处 `div_euclid` 的除数必须和它一致，
/// 差一个零就是「日期对、小时不对」那种最难被发现的错。
const SECS_PER_DAY: i64 = 86_400;

/// 把「距 Unix 纪元的本地日数」写成 `YYYY-MM-DD`。
///
/// 日历（闰年、月末）交给 chrono，不自己推——手写闰年规则的话，错的那天是
/// 二月二十九，要等到下一个闰年才有人发现。
pub(super) fn day_string(epoch_day: i64) -> String {
    // `saturating_mul` 而不是 `*`：系统时钟被设到荒谬的年份时（真的会，
    // 主板电池没电会跳到 2099 甚至更远），乘法在 release 里静默回绕、
    // 在 debug 里直接 panic。饱和之后 `from_timestamp` 返回 `None`，
    // 走下面的兜底，两种构建的行为一致。
    chrono::DateTime::from_timestamp(epoch_day.saturating_mul(SECS_PER_DAY), 0)
        .map(|dt| dt.date_naive().to_string())
        // 只有 |天数| 超出公元前后二十几万年才会走到这里，也就是走不到。
        // 真走到了也不能 panic——release 是 `panic = "abort"`，一次 panic 就是
        // 整个程序消失（见 `query_offset_secs`）。给一个扎眼的假日期比让程序死掉强。
        .unwrap_or_else(|| "1970-01-01".to_string())
}

/// 一个时刻落在哪儿：**UTC 分钟、本地小时、本地日**（距 Unix 纪元的天数）。
///
/// `minute` 是 UTC 的，`hour` 和 `epoch_day` 是本地的——这不是笔误。库里
/// `stat_minute` 那一列一直是 UTC 分钟（原来写的是 `Local::now().timestamp() / 60`，
/// 而 `DateTime::timestamp()` 给的本来就是 UTC 秒），本地口径只体现在同一行的
/// `local_day` / `local_hour` 上。**改口径会让新旧行对不上**：同一个物理分钟
/// 在库里变成两行，而两行都会有人读。
fn locate(secs: i64, offset_secs: i32) -> (i64, i64, i64) {
    let local = secs + offset_secs as i64;
    // 除法一律 `div_euclid` / `rem_euclid`。写成 `/` 和 `%` 会在两种情况下错：
    // 西半球的偏移是负的，UTC 秒本身也可能是负的（时钟被设到 1970 年之前）。
    // 那两种情况下 `/` 向零截断——「1970-01-01 00:00 的前一秒」会被算成
    // 第 0 天 0 时，也就是**整整差一天**，而它实际是 1969-12-31 23:59:59。
    (
        secs.div_euclid(60),
        local.div_euclid(3600).rem_euclid(24),
        local.div_euclid(SECS_PER_DAY),
    )
}

/// 现在距 Unix 纪元多少秒。往 1970 年之前也认。
fn utc_secs() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        // 系统时钟被设到 1970 年之前。不是不可能（主板电池没电、手工改过表），
        // 而这里算错的话，那台机器上全部数据都会落到 1970-01-01 那一天——
        // 看上去只是「日期有点怪」，没人会往时钟上想。取个负号就对了。
        Err(e) => -(e.duration().as_secs() as i64),
    }
}

/// 问系统：本地比 UTC 快多少秒。
///
/// **热路径上只有这一处调 `Local::now()`**（命令层和适配器那边另有几处，
/// 但那些是一次用户操作才走一次，不在输入回调这条线上）。别在 `collector/`
/// 里再写第二个。两条理由，都不是洁癖：
///
/// 1. **它是真的去问系统。** Windows 上 `Local::now()` 最终走到
///    `GetTimeZoneInformationForYear`，chrono 不缓存；原先一次按键要调两遍。
/// 2. **它能 panic，而且消不掉。** 那条链最后落在 chrono 内部的
///    `MappedLocalTime::unwrap()`：时区信息取不到时（时区注册表被改坏、精简镜像、
///    Wine）返回 `MappedLocalTime::None`，于是 `panic!("No such local time")`。
///    release profile 是 `panic = "abort"`，unwind 被关掉，`catch_unwind` 拦不住——
///    **表现是「每按一个键进程就没」**，而且界面上什么都不会说。要消掉它得开 unwind，
///    为一个鲜见的机器配置付二进制体积和展开表的钱，不划算。能做的是两件：
///    让它尽可能少发生，以及让它只可能在**一处**发生。
fn query_offset_secs() -> i32 {
    Local::now().offset().local_minus_utc()
}

/// 本地时刻的缓存。
///
/// 原来 `bump_key_usage` 和 `bucket_for` 各自调一次 `Local::now()`，于是一次按键
/// 两次时区查询、三次格式化和四次堆分配，全落在输入回调那条线上。这里拆成三样：
///
/// - **偏移**是唯一真正要问系统的量。它一天之内只在夏令时切换那一刻变一次，
///   所以**跨分钟才重问**，一次按键摊到 1/60 次。
/// - **分钟**由 `SystemTime::now()` 的秒数直接除出来，**根本不需要时区**。
/// - **小时和日期**由「UTC 秒 + 偏移」的整数运算得到，**不格式化、不分配**。
///
/// 代价是偏移最多旧一分钟。这一分钟里唯一可能算错的是夏令时切换那一秒的归属，
/// 而那一刻的边界归属本来就是采样问题——原来两处各采样一次，隔得比这还远。
pub(super) struct Clock {
    /// 上次问系统时区是在哪个 UTC 分钟。
    last_minute: i64,
    /// 本地相对 UTC 的偏移（秒）。
    offset_secs: i32,
    /// 重问过系统多少次。**只给测试看**：「同一分钟内不再问」这条得能被断言，
    /// 否则它就只是一句注释，而注释不会红。
    #[cfg(test)]
    resamples: u32,
}

impl Clock {
    /// 在采集线程启动时先问一次。
    ///
    /// 放在这儿而不是等第一个按键，是有意的：`query_offset_secs()` 能 panic，
    /// 而它在这里炸掉的话，是「程序一起来采集线程就没了」——比「用户打了三小时字
    /// 之后按下一个键，整个窗口凭空消失」好收拾得多，也更容易被报上来。
    pub(super) fn new() -> Self {
        Self {
            last_minute: utc_secs().div_euclid(60),
            offset_secs: query_offset_secs(),
            #[cfg(test)]
            resamples: 0,
        }
    }

    /// 热路径：这一下事件落在哪一分钟、哪个本地小时、哪个本地日。
    ///
    /// 每次调用只有一次 `SystemTime::now()` 和几条整数运算——不分配、不格式化、
    /// 不碰时区。
    pub(super) fn stamp(&mut self) -> (i64, i64, i64) {
        let secs = utc_secs();
        let minute = secs.div_euclid(60);
        if minute != self.last_minute {
            self.last_minute = minute;
            self.offset_secs = query_offset_secs();
            #[cfg(test)]
            {
                self.resamples += 1;
            }
        }
        locate(secs, self.offset_secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 西半球的偏移会把本地日退到前一天，而且**一天都不能差**。
    /// 把 `div_euclid` 写成 `/` 的话，UTC 零点会算成「本地第 0 天 16 时」，
    /// 也就是 1970-01-01，而它实际是 1969-12-31 16 时。
    #[test]
    fn 西半球的偏移退到前一天() {
        let (minute, hour, day) = locate(0, -8 * 3600);
        assert_eq!(minute, 0, "分钟是 UTC 的，不受偏移影响");
        assert_eq!(hour, 16);
        assert_eq!(day, -1);
        assert_eq!(day_string(day), "1969-12-31");
    }

    /// 东八区：UTC 16:00 已经是本地的第二天 0 点。
    /// 这是「跨本地午夜换日」那一下，也是 `local_day` 唯一会变的位置。
    #[test]
    fn 东半球跨过本地午夜就换日() {
        let (_, hour, day) = locate(16 * 3600, 8 * 3600);
        assert_eq!((hour, day), (0, 1));
        assert_eq!(day_string(day), "1970-01-02");

        // 前一秒还在昨天 23 点。这一秒之差必须跨得过去。
        let (_, hour, day) = locate(16 * 3600 - 1, 8 * 3600);
        assert_eq!((hour, day), (23, 0));
    }

    /// 小时得绕回 0–23，不能出现 24 或 -1。原来用 `format("%H")`，天然就绕；
    /// 换成算术之后得自己保证，而「晚上 24 点」这种值进了库不会报错，
    /// 只会在 24 小时图上多出一格空柱子。
    #[test]
    fn 小时永远落在零到二十三() {
        let offsets = [
            -12 * 3600,
            -8 * 3600,
            0,
            5 * 3600 + 45 * 60, // 加德满都那种半时区，顺带证明不假设整小时
            8 * 3600,
            14 * 3600,
        ];
        // 头几个是 1970 年前后的边界（负秒），最后一个是真日子。
        let times = [0i64, 1, 3599, 3600, 86_399, 1_700_000_000, -1, -86_400];
        for offset in offsets {
            for secs in times {
                let (minute, hour, day) = locate(secs, offset);
                assert!(
                    (0..24).contains(&hour),
                    "offset={offset} secs={secs} 算出来 hour={hour}"
                );
                assert_eq!(day_string(day).len(), 10, "日期串得是 YYYY-MM-DD");
                assert_eq!(minute, secs.div_euclid(60), "分钟和偏移无关");
            }
        }
    }

    /// 日期串的**约定**要钉住：`epoch_day` 是「距 1970-01-01 的天数」。
    /// 差一天就是整天记错日子，而且错得很安静——日期看起来完全正常。
    #[test]
    fn 日期串按距一九七零年的天数算() {
        assert_eq!(day_string(0), "1970-01-01");
        assert_eq!(day_string(-1), "1969-12-31");

        let base = chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
        let leap = chrono::NaiveDate::from_ymd_opt(2028, 2, 29).unwrap();
        assert_eq!(
            day_string(leap.signed_duration_since(base).num_days()),
            "2028-02-29"
        );
    }

    /// **这次改动的全部意义**：热路径上不再每次按键都问系统时区。
    ///
    /// 一千次 `stamp()` 用不到一毫秒，所以至多跨一次分钟边界；跨了就至多重问一次。
    /// 要是有人把那个 `if` 去掉或写反（`!=` 写成 `==`），这里会数到上千，
    /// 而那个错误在别处**看不出来**——数字全对，只是每个按键多问了一次系统。
    #[test]
    fn 同一分钟内不重复问系统时区() {
        let mut clock = Clock::new();
        for _ in 0..1000 {
            clock.stamp();
        }
        assert!(
            clock.resamples <= 1,
            "一千次按键重问了 {} 次系统时区",
            clock.resamples
        );
    }
}
