//! 自动重复（长按）判定。
//!
//! KBDLLHOOKSTRUCT 里既没有重复计数字段，也不存在 `LLKHF_REPEAT` 标志——
//! 低级钩子在输入管线最早期被调用，那时系统的重复计数器还不存在。
//! （"用 flags & LLKHF_REPEAT 过滤长按"是网上流传的错误说法。）
//!
//! 所以必须自己维护状态。这里用**按下集合**而不是「只记上一次按下的 vkCode」：
//! 多键滚键时（按住 Shift 连按字母、游戏操作）后者会把真实按键误判成重复。

use std::collections::HashSet;

#[derive(Default)]
pub struct RepeatFilter {
    /// (vkCode, scanCode)。带上 scanCode 是为了区分共用同一 vkCode 的左右键
    /// （左右 Shift / Ctrl / Alt）。
    pressed: HashSet<(u32, u32)>,
}

impl RepeatFilter {
    pub fn new() -> Self {
        Self::default()
    }

    /// 返回 `true` 表示这是一次真实的新按下，应当计数；
    /// 长按产生的自动重复返回 `false`。
    pub fn on_key_down(&mut self, vk_code: u32, scan_code: u32) -> bool {
        // HashSet::insert 返回 false 说明集合里已经有了 —— 即自动重复。
        self.pressed.insert((vk_code, scan_code))
    }

    pub fn on_key_up(&mut self, vk_code: u32, scan_code: u32) {
        self.pressed.remove(&(vk_code, scan_code));
    }

    /// 窗口失去焦点、或检测到事件断流时清空。
    /// 否则按键状态会卡住，导致后续的真实按键被误判成自动重复而永久丢失。
    pub fn reset(&mut self) {
        self.pressed.clear();
    }

    pub fn pressed_count(&self) -> usize {
        self.pressed.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VK_A: u32 = 0x41;
    const VK_SHIFT: u32 = 0x10;

    #[test]
    fn 长按只算第一次() {
        let mut f = RepeatFilter::new();
        assert!(f.on_key_down(VK_A, 30), "首次按下应计数");
        // 系统在长按期间会持续补发 keydown，这些都不该计数。
        for _ in 0..20 {
            assert!(!f.on_key_down(VK_A, 30), "自动重复不应计数");
        }
        f.on_key_up(VK_A, 30);
        assert!(f.on_key_down(VK_A, 30), "抬起后再次按下应重新计数");
    }

    #[test]
    fn 多键滚键不误判() {
        // 按住 Shift 连按字母：Shift 一直没抬起，但每个字母都是真实按键。
        let mut f = RepeatFilter::new();
        f.on_key_down(VK_SHIFT, 42);
        assert!(f.on_key_down(VK_A, 30));
        assert!(f.on_key_down(0x42, 48), "B 是不同键，不能因 Shift 未抬起而被吞");
        assert!(f.on_key_down(0x43, 46));
        assert_eq!(f.pressed_count(), 4);
    }

    #[test]
    fn 左右修饰键靠_scan_code_区分() {
        // 左右 Shift 共用 vkCode 0x10，只有 scanCode 不同。
        let mut f = RepeatFilter::new();
        assert!(f.on_key_down(VK_SHIFT, 42), "左 Shift");
        assert!(f.on_key_down(VK_SHIFT, 54), "右 Shift 是另一个物理键");
        assert!(!f.on_key_down(VK_SHIFT, 42), "左 Shift 重复");
    }

    #[test]
    fn reset_清空卡住的按键() {
        let mut f = RepeatFilter::new();
        f.on_key_down(VK_A, 30);
        assert_eq!(f.pressed_count(), 1);
        f.reset();
        assert_eq!(f.pressed_count(), 0);
        assert!(f.on_key_down(VK_A, 30), "reset 后应能重新计数");
    }
}
