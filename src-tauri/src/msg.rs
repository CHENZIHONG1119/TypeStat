//! 采集端与 worker 之间的消息类型。
//!
//! 放在独立模块里，是为了让 `hook` 和 `collector` 都不必依赖对方——
//! 钩子只管产出按键事件，字符差分（插件 / UIA 适配器）产出另一类消息，
//! 两者汇入同一个 worker 做聚合。

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
    /// 钩子（重）建后要求清空按键状态。
    ///
    /// 必要性：如果钩子重建的那一刻恰好有修饰键按着，那个 keyup 就永远收不到了，
    /// 「Ctrl 还按着」的状态会一直卡在分类器里——此后**每一次普通打字都会被
    /// 当成组合键而不计入统计**，且无法自愈。重建时主动清空是唯一可靠的时机。
    Reset,
}
