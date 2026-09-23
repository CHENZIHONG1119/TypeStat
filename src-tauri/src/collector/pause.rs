//! 暂停记录。
//!
//! 一个全局开关，从托盘菜单或设置页拨。**不持久化**——下次启动一定是「在记录」。
//!
//! ## 为什么不持久化
//!
//! 这个开关的用处是「我要输一会儿密码」「我在写不想被计数的东西」，
//! 是一次性的动作，不是一种长期配置。持久化之后，某天在托盘里拨了一次，
//! 第二天开机发现程序不计数了，而界面上一片太平——**这正是这个程序最怕的失败**：
//! 安静地少记，看起来和「今天没打字」一模一样。宁可每天重新拨一次。
//!
//! ## 为什么不走消息队列
//!
//! 和 [`crate::msg::request_reset`] 同一个理由：那条队列是有界的，投递走 `try_send`，
//! 队列满时直接失败。而「暂停」恰恰是在队列正堵着（打得正凶）的时候最可能需要生效的。
//! 用原子读写在采集侧看一眼，代价是一次 relaxed load，永远不会失败。

use std::sync::atomic::{AtomicBool, Ordering};

static PAUSED: AtomicBool = AtomicBool::new(false);

pub fn is_paused() -> bool {
    PAUSED.load(Ordering::Relaxed)
}

/// 拨开关。返回拨完之后的状态。
///
/// **恢复时要清一遍按键状态**，所以这里会请求 reset：暂停期间钩子仍然收得到
/// keyup，但采集侧不看——「Ctrl 还按着」这类状态于是在暂停期间和现实脱了节
/// （松开 Ctrl 的 keyup 被丢掉了）。恢复之后照旧状态继续判，第一段打字就会被
/// 当成组合键而不计入统计，而且不会自愈。走 [`crate::msg::request_reset`]
/// 这条已经验证过的路，比在这里另写一套状态同步可靠。
pub fn set_paused(paused: bool) -> bool {
    let was = PAUSED.swap(paused, Ordering::Relaxed);
    if was && !paused {
        crate::msg::request_reset();
    }
    paused
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 拨开关能来回() {
        // 这个全局量在测试之间是共享的，所以测完必须拨回去，
        // 否则后面跑到的测试会莫名其妙地「采集侧什么都不记」。
        assert!(!is_paused(), "默认必须是「在记录」");
        assert!(set_paused(true));
        assert!(is_paused());
        // 再拨一次 true：状态不变，且不该出问题
        assert!(set_paused(true));
        assert!(!set_paused(false));
        assert!(!is_paused());
    }
}
