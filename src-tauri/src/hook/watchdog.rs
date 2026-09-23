//! 钩子存活检测。
//!
//! 系统在回调超时累计 10 次后会静默摘除钩子，且**不提供任何通知 API**。
//! 唯一的办法是交叉验证：拿系统的「上次输入时间」和我们自己的记录对比。
//!
//! 判据就一个量：`系统最后输入时间 − 我们最新的记录`。它的含义是**「系统看见了、
//! 却没交给我们」的那段输入时长**。钩子活着时它接近零（两边看的是同一批事件，
//! 只差几十毫秒的调度延迟），钩子死了就一路增长。
//!
//! 这个量顺带解决了两件事，所以不需要再引入「当前时刻」：
//!   - 用户闲置时它恒为零——`system_last` 和 `ours` 一起停住，不增长就不会误报；
//!   - 我们也不需要判断「用户是在动鼠标还是在打字」，见下。
//!
//! 两个坑，都踩过：
//!
//! 1. **`GetLastInputInfo` 把鼠标也算作输入。** 键盘钩子只看键盘，于是
//!    「用户在翻网页、手没碰键盘」和「钩子被摘了、用户正在打字」在数字上完全
//!    一样——两者都是「系统时间在前进、我们这边没动静」。`mouse` 那个钩子就是
//!    为了分开它们：它不产生任何统计，只提供一个「鼠标动过」的时间戳。
//! 2. **时间戳是 32 位的，约 49.7 天回绕一次。** 两者同源（都是系统启动起算的
//!    毫秒数），所以 `wrapping_sub` 的模运算在回绕前后都是对的；直接相减则会
//!    在回绕处得出一个巨大的数，表现是「开机满 49.7 天之后看门狗彻底失灵」。
//!
//! 重建是幂等的——误判的代价只是几毫秒的事件空档——所以宁可敏感一点。

use std::time::Duration;

use serde::Serialize;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

use super::keyboard::{self, Hook};
use super::mouse;

/// 检查间隔。
const CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// 系统输入时间领先我们最新记录多久，才判定钩子已死。
///
/// 有了鼠标时间戳之后，这个差在正常情况下是**毫秒级**的。留 30 秒是给这些
/// 情况留的余量：触摸/笔这类不产生鼠标消息的输入、钩子回调的调度延迟、
/// 以及鼠标钩子万一没装上（那时会退回只认键盘的老行为，仍可能误报，
/// 但至少不是每分钟一次）。
///
/// 原来这里是 120 秒，纯粹靠大阈值压住鼠标造成的误报。误报的根因去掉之后
/// 就可以调敏感些：真出事时从「两分钟才发现」变成「半分钟」。
const SUSPECT_THRESHOLD_MS: u32 = 30_000;

/// 看门狗此刻看到的全部输入。**这是判断钩子死活的全套证据。**
///
/// 为什么要把它做成一个能被外面读到的值：钩子被系统摘除时没有任何通知，
/// 「钩子坏了」只能靠这几个数交叉验证。中间量一旦看不见，出问题时就只剩猜——
/// 排查「半夜每隔一分钟丢一次字」时最难的一步，正是看不见这几个数，
/// 于是「只有鼠标在动」和「钩子已经死了」在日志里长得一模一样。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// 系统的「最后输入时刻」（毫秒，系统启动起算）。`GetLastInputInfo` 失败时为 None。
    pub system_last_ms: Option<u32>,
    /// 我们最近记到的键盘事件时刻。
    pub keyboard_last_ms: u32,
    /// 我们最近记到的鼠标事件时刻。
    pub mouse_last_ms: u32,
    /// 判据本身：`system_last_ms − max(keyboard_last_ms, mouse_last_ms)`。
    ///
    /// **这是「系统看见了、却没交给我们」的那段输入时长**，看门狗唯一据以判断的量。
    /// 任一边还没收到过事件（值为 0）时为 None——那时算出来的差值是个巨大的数，
    /// 没有意义，不记成 0 是因为 0 的含义是「完全没延迟」。
    pub lag_ms: Option<u32>,
}

impl Health {
    /// 由三个时间戳拼出一次判断。**纯函数**，采样和测试走同一条路。
    ///
    /// 之所以把它和读系统状态分开：读 `GetLastInputInfo` 是没法在测试里造出
    /// 回绕和「鼠标在动、键盘停着」这两种情况的，而这恰好是这里唯一会出错的地方。
    pub fn from_parts(system_last_ms: Option<u32>, keyboard_last_ms: u32, mouse_last_ms: u32) -> Self {
        // 我们最近一次记录到的输入：键盘和鼠标取较新的那个。
        //
        // **鼠标那一半不能省。** 只拿键盘比的话，`GetLastInputInfo` 会因为
        // 鼠标移动一直前进，而我们这边纹丝不动，于是半夜每隔一分钟就重建
        // 一次钩子——每次重建都有一小段空档，那期间敲的字就丢了。
        let ours = newer_of(keyboard_last_ms, mouse_last_ms);

        let lag_ms = match system_last_ms {
            Some(sys) if ours != 0 => Some(sys.wrapping_sub(ours)),
            _ => None,
        };

        Self {
            system_last_ms,
            keyboard_last_ms,
            mouse_last_ms,
            lag_ms,
        }
    }

    /// 采样一次。
    pub fn sample() -> Self {
        Self::from_parts(
            system_last_input_ms(),
            keyboard::last_event_time(),
            mouse::last_event_time(),
        )
    }

    /// 超过阈值就返回那段时长（毫秒），否则 None。看门狗只在拿到 Some 时重建。
    pub fn suspicious_lag(&self) -> Option<u32> {
        self.lag_ms.filter(|&lag| lag > SUSPECT_THRESHOLD_MS)
    }

    /// 系统的最后输入时刻比 `ours` 晚多久（毫秒）。`system_last_ms` 量不到时为 0。
    fn lag_of(&self, ours: u32) -> u32 {
        self.system_last_ms
            .map_or(0, |sys| sys.wrapping_sub(ours))
    }
}

/// 采样一次。命令层用它把看门狗的判据露给界面。
pub fn health() -> Health {
    Health::sample()
}

/// 两个「自启动起算的毫秒数」里更新的那个。
///
/// **不能写成 `.max()`。** 这两个数都是 32 位、约 49.7 天绕一圈，直接比大小
/// 在回绕点上就是错的：鼠标在回绕前最后动过一次、之后再没动过（一直用键盘写作，
/// 很常见），`mouse_last_ms` 就停在一个很大的值上，`max` 会取到**它**——
/// 于是 `ours` 比真实值早了整整一圈，`lag` 算出来是个巨大的数，
/// 看门狗在开机满 49.7 天之后开始每 60 秒重建一次钩子。
///
/// 这个坑在本模块开头就写着，`keyboard.rs` 和 `mouse.rs` 里也各自写了一遍
/// 「任何比较都必须走差值」——**而唯一真的做比较的地方就是这里**。
/// 教训：把规矩写在注释里挡不住自己，得把它写成一个有名字的函数。
///
/// 判据是差值：`b - a` 落在前半圈（小于 2^31，即相差不到 24.8 天）就说明 b 更新。
/// 两个时间戳之间不可能差出半圈去，所以这个判据是准的。
fn newer_of(a: u32, b: u32) -> u32 {
    // 0 是「还没收到过事件」的哨兵值，不是时间戳——真正的回绕点要开机满
    // 49.7 天，且恰好落在那一毫秒上。这里按哨兵处理，不是时间。
    if a == 0 {
        return b;
    }
    if b == 0 {
        return a;
    }
    if b.wrapping_sub(a) < (1u32 << 31) {
        b
    } else {
        a
    }
}

pub fn spawn(hook: Hook) {
    std::thread::Builder::new()
        .name("typestat-watchdog".into())
        .spawn(move || {
            // 开工先说一句。这个线程平时只在**出事**时才打印，于是「日志里没有」
            // 同时对应两种完全不同的情况——一切正常、和它压根没跑起来，
            // 而从日志本身分不出来。有这一行，沉默才是一个有内容的结论。
            eprintln!(
                "[typestat] 看门狗已启动：每 {}s 检查一次，滞后超过 {}s 判定钩子失效",
                CHECK_INTERVAL.as_secs(),
                SUSPECT_THRESHOLD_MS / 1000
            );

            loop {
                std::thread::sleep(CHECK_INTERVAL);

                let h = health();

                if let Some(missed) = h.suspicious_lag() {
                    // 把三个分量一起打出来：单看「晚了几秒」没法区分是键盘钩子死了
                    // 还是鼠标钩子死了，而这两种情况的修法完全不同。
                    eprintln!(
                        "[typestat] 看门狗：系统最后输入比我们最新的记录晚 {}s（键盘滞后 {}s / 鼠标滞后 {}s），这中间一个事件都没收到，判定钩子已失效，请求重建",
                        missed / 1000,
                        h.lag_of(h.keyboard_last_ms) / 1000,
                        h.lag_of(h.mouse_last_ms) / 1000,
                    );
                    hook.request_reinstall();
                }
            }
        })
        .expect("spawn watchdog thread");
}

/// 系统最近一次输入的时间戳（毫秒，系统启动起算）。
///
/// 返回 u32 而不是 u64：`dwTime` 本来就是 DWORD，转成 u64 只会掩盖回绕这件事。
fn system_last_input_ms() -> Option<u32> {
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info).as_bool() {
            Some(info.dwTime)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「回绕点前 n 毫秒」。
    ///
    /// 时间戳是 32 位毫秒、从系统启动起算，所以 0 这个值就是回绕点本身——
    /// `0u32.wrapping_sub(n)` 读起来正好是「回绕点往前 n 毫秒」，比写
    /// `u32::MAX - n + 1` 少一层换算。**别把 `u32::MAX - n` 当成这个意思**：
    /// `u32::MAX` 只比回绕点早 1 毫秒，减掉十万反而只是回绕前 1 秒。
    fn 回绕点前(ms: u32) -> u32 {
        0u32.wrapping_sub(ms)
    }

    #[test]
    fn 只有鼠标在动时不判钩子失效() {
        // **这条就是那个 bug 本身。** 键盘停在 200 秒前，鼠标刚动过，系统的最后
        // 输入跟着鼠标走。只看键盘的话，这里算出来是 200 秒的滞后，远超阈值——
        // 于是深夜挂着程序、只有鼠标在动时，看门狗会每 60 秒重建一次钩子。
        let h = Health::from_parts(Some(1_000_000), 800_000, 1_000_000);
        assert_eq!(h.lag_ms, Some(0));
        assert_eq!(h.suspicious_lag(), None);
    }

    #[test]
    fn 键鼠都停住时才判失效() {
        // 两边都停在 60 秒前，系统 30 秒前还有输入：那之后的事件我们一个没收到。
        let h = Health::from_parts(Some(1_000_000), 940_000, 940_000);
        assert_eq!(h.lag_ms, Some(60_000));
        assert_eq!(h.suspicious_lag(), Some(60_000));
    }

    #[test]
    fn 滞后恰好等于阈值不算失效() {
        let 阈值 = SUSPECT_THRESHOLD_MS;
        let 刚好等于 = Health::from_parts(Some(1_000_000), 1_000_000 - 阈值, 0);
        assert_eq!(刚好等于.lag_ms, Some(阈值));
        assert_eq!(刚好等于.suspicious_lag(), None, "判据是严格大于，等于不算");

        let 超过一毫秒 = Health::from_parts(Some(1_000_000), 1_000_000 - 阈值 - 1, 0);
        assert_eq!(超过一毫秒.suspicious_lag(), Some(阈值 + 1));
    }

    #[test]
    fn 还没收到过任何事件时不做判断() {
        // 程序刚起来、或者用户还没碰过键鼠。这时 `system_last - 0` 是个巨大的数，
        // 不挡住必然误触发。
        let h = Health::from_parts(Some(1_000_000), 0, 0);
        assert_eq!(h.lag_ms, None);
        assert_eq!(h.suspicious_lag(), None);
    }

    #[test]
    fn 系统时间读不到时不做判断() {
        let h = Health::from_parts(None, 900_000, 0);
        assert_eq!(h.lag_ms, None);
        assert_eq!(h.suspicious_lag(), None);
    }

    #[test]
    fn 时间戳回绕之后算出来还是差值() {
        // 49.7 天绕一圈之后，`system_last` 比 `ours` 小。当成有符号数直接相减会得到
        // 一个巨大的负值，表现是「开机满 49.7 天之后看门狗彻底失灵」。差值其实只有 2 秒。
        let h = Health::from_parts(Some(1_000), 回绕点前(1_000), 0);
        assert_eq!(h.lag_ms, Some(2_000));
        assert_eq!(h.suspicious_lag(), None);
    }

    #[test]
    fn 回绕点上取较新的时间戳不能直接比大小() {
        // **这条是 `.max()` 留下的坑。** 鼠标在回绕前最后动过一次、之后一直没动，
        // 于是它停在回绕前的大值上；键盘的事件全在回绕之后，是小值。
        // `max` 会取到那个陈旧的大值，`ours` 凭空早了一整圈——算出来的滞后远超
        // 阈值，看门狗从此每 60 秒重建一次钩子。开机满 49.7 天才会碰上，
        // 而那时候没人会想到是这里。
        let 键盘 = 40_000; // 已经绕过一圈
        let 鼠标 = 回绕点前(100_000); // 停在回绕之前，早就不动了
        let h = Health::from_parts(Some(键盘 + 3_000), 键盘, 鼠标);
        assert_eq!(
            h.lag_ms,
            Some(3_000),
            "取到了回绕之前那个陈旧的时间戳，回绕之后看门狗会一直误判"
        );
        assert_eq!(h.suspicious_lag(), None);
    }

    #[test]
    fn 两个时间戳哪个新都取得对() {
        // 常规：数字大的更新。
        assert_eq!(newer_of(800_000, 1_000_000), 1_000_000);
        assert_eq!(newer_of(1_000_000, 800_000), 1_000_000);
        // 「还没收到过事件」的哨兵值不能把另一边的真时间戳挤掉。
        assert_eq!(newer_of(0, 1_000_000), 1_000_000);
        assert_eq!(newer_of(1_000_000, 0), 1_000_000);
        assert_eq!(newer_of(0, 0), 0);
        // 跨过回绕点：数字小的那个反而更新（5000 在绕圈之后，比「绕圈前 10ms」新）。
        // 两个方向都得对——`max` 之所以错，就是因为它只会往数字大的那边倒。
        assert_eq!(newer_of(回绕点前(10), 5_000), 5_000);
        assert_eq!(newer_of(5_000, 回绕点前(10)), 5_000);
    }

    #[test]
    fn 回绕点附近真失效也判得出来() {
        // 同一个回绕点上，如果那 100 秒里真的一个事件都没收到，照样要判失效——
        // 回绕不是「这段时间不检查」，只是「换一种算法照样准」。
        let h = Health::from_parts(Some(40_000), 回绕点前(100_000), 0);
        assert_eq!(h.lag_ms, Some(140_000));
        assert_eq!(h.suspicious_lag(), Some(140_000));
    }
}
