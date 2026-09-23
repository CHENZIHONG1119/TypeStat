//! 采集端与 worker 之间的消息类型。
//!
//! 放在独立模块里，是为了让 `hook` 和 `collector` 都不必依赖对方——
//! 钩子只管产出按键事件，字符差分（插件 / UIA 适配器）产出另一类消息，
//! 两者汇入同一个 worker 做聚合。
//!
//! 除了消息本身，这里还放一个**开关**：钩子要求清空按键状态的请求。
//! 它不能走消息队列，理由见 [`request_reset`]。

use std::sync::atomic::{AtomicBool, Ordering};

/// 一条原始按键事件。定长、无堆分配，可安全穿过队列。
#[derive(Debug, Clone, Copy)]
pub struct RawKeyEvent {
    pub vk_code: u32,
    pub scan_code: u32,
    /// 扩展键（E0 前缀）。左右 Ctrl / Alt 共用同一个 vkCode 和 scanCode，
    /// 只有这一位不同——不带上它就没法把两个物理键分开。
    pub extended: bool,
    pub is_down: bool,
    /// 由 SendInput / 宏 / 自动化脚本注入。统计时必须丢弃，否则测试脚本会污染数据。
    pub injected: bool,
    /// 来自 KBDLLHOOKSTRUCT.time，毫秒，与 GetLastInputInfo 同一时基。
    pub time: u32,
    /// 事件发生瞬间的前台窗口。必须在回调里采样——焦点随时会变，事后补不回来。
    pub hwnd: isize,
}

/// 字符差分的来源。写进数据库用于在 UI 上标注这一格数据的精度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharSource {
    /// 编辑器配套插件上报，精确到字。
    Plugin,
    /// UI Automation 差分，次精确。
    Uia,
}

impl CharSource {
    pub fn as_str(self) -> &'static str {
        match self {
            CharSource::Plugin => "plugin",
            CharSource::Uia => "uia",
        }
    }
}

/// worker 的输入消息。
#[derive(Debug, Clone)]
pub enum CollectMsg {
    /// 来自全局钩子的按键事件（按键口径）。
    Key(RawKeyEvent),
    /// 来自适配器的精确字符增减（字符口径）。
    Chars {
        app: String,
        input: i64,
        delete: i64,
        source: CharSource,
    },
    /// 立刻落库，别等「静默 1 秒」那个判据。
    ///
    /// 只给退出用：点托盘里的「退出」时进程直接结束，而采集侧手上可能还攥着
    /// 最后不到 1.5 秒的按键（`QUIET_PERIOD` + 轮询间隔）。不冲一次的话，
    /// 那几下就永远丢了——丢得不多，但它是**安静的**，和「那几秒我没打字」
    /// 长得一模一样。退出路径上多这一步，把那点不确定去掉。
    Flush,
}

/// 请求采集侧清空按键状态。**这是一个开关，不是一条消息。**
///
/// 为什么不能把它做成 `CollectMsg` 的一个变体：那条队列是**有界**的
/// （`collector::QUEUE_CAPACITY`），钩子侧投递走 `try_send`——队列满时直接失败。
/// 而这个请求丢掉的后果和丢一条按键事件完全不是一个量级：
///
/// 钩子重建的那一刻若恰好有修饰键按着，那个 keyup 就永远收不到了，
/// 「Ctrl 还按着」会一直卡在分类器里——此后**每一次普通打字都被当成组合键
/// 而不计入统计**，`key_input` 从此不再增长，且不会自愈，
/// 只有清空状态能解。它本来就是「队列可能正堵着」的时候最需要送达的那一条，
/// 却偏偏只有它会被队列状态决定成败。所以它改走原子标志：置位不会失败。
///
/// 代价是「最迟在下一条事件被处理前生效」——采集侧收到任何事件都先看它一眼，
/// 所以实际上就是即时生效。
static RESET_PENDING: AtomicBool = AtomicBool::new(false);

/// 请求采集侧清空按键状态。置位是幂等的，重复请求不会出问题。
pub fn request_reset() {
    RESET_PENDING.store(true, Ordering::Relaxed);
}

/// 取走一次清空请求：有待处理的返回 true，并顺手把标志清掉。
pub fn take_reset() -> bool {
    RESET_PENDING.swap(false, Ordering::Relaxed)
}
