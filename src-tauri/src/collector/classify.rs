//! 按键分类与修饰键组合过滤。
//!
//! 最容易写错的地方：**Shift 组合是正常文字输入**（Shift+A 打出大写 A，
//! Shift+1 打出 `!`），只有 Ctrl / Alt / Win 组合才不是文字输入。
//! 一刀切地把"有修饰键按下"全部排除，会丢掉所有大写字母和上档符号。

use std::collections::HashSet;

pub const VK_BACK: u32 = 0x08;
pub const VK_RETURN: u32 = 0x0D;
pub const VK_SPACE: u32 = 0x20;
pub const VK_DELETE: u32 = 0x2E;

fn is_shift(vk: u32) -> bool {
    matches!(vk, 0x10 | 0xA0 | 0xA1)
}

fn is_ctrl(vk: u32) -> bool {
    matches!(vk, 0x11 | 0xA2 | 0xA3)
}

fn is_alt(vk: u32) -> bool {
    matches!(vk, 0x12 | 0xA4 | 0xA5)
}

fn is_win(vk: u32) -> bool {
    matches!(vk, 0x5B | 0x5C)
}

/// 纯修饰键的按下本身不产生任何字符，不计入任何口径。
pub fn is_modifier(vk: u32) -> bool {
    is_shift(vk) || is_ctrl(vk) || is_alt(vk) || is_win(vk)
}

/// 会破坏文字的按键。这两个键的按下次数就是「删除次数」（按键口径）。
pub fn is_delete_key(vk: u32) -> bool {
    vk == VK_BACK || vk == VK_DELETE
}

/// 会产生字符的键：字母、数字、符号、空格、回车、小键盘。
///
/// 刻意排除的：F1–F24、方向键 / Home / End / PgUp / PgDn、Insert、Esc、
/// CapsLock / NumLock / ScrollLock、PrintScreen 等。它们不产生文字。
pub fn is_input_key(vk: u32) -> bool {
    matches!(vk,
        0x30..=0x39 |   // 0-9
        0x41..=0x5A |   // A-Z
        0x60..=0x6F |   // 小键盘数字与运算符
        VK_SPACE | VK_RETURN |
        0xBA..=0xC0 |   // OEM_1..OEM_3   ; = , - . / `
        0xDB..=0xDE     // OEM_4..OEM_7   [ \ ] '
    )
}

/// 一次按下被归入哪一类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// 产生字符的键（字母/数字/符号/空格/回车）
    Input,
    /// Backspace / Delete
    Delete,
    /// 功能键、导航键、组合键等——不计入任何口径
    Other,
}

#[derive(Default)]
pub struct KeyClassifier {
    /// 当前按下的、会"取消文字输入"语义的修饰键。
    /// 只放 Ctrl / Alt / Win —— Shift 不在其中，见模块注释。
    blocking_mods: HashSet<u32>,
}

impl KeyClassifier {
    pub fn new() -> Self {
        Self::default()
    }

    /// 处理一次按下。返回 `None` 表示这是修饰键本身，不产生事件。
    pub fn on_key_down(&mut self, vk: u32) -> Option<KeyKind> {
        if is_modifier(vk) {
            if is_ctrl(vk) || is_alt(vk) || is_win(vk) {
                self.blocking_mods.insert(vk);
            }
            // Shift 也要记录，但它不影响判定，所以不入 blocking_mods。
            return None;
        }

        // Ctrl+C / Alt+Tab / Win+R 这类组合键不是文字输入。
        if !self.blocking_mods.is_empty() {
            return Some(KeyKind::Other);
        }

        if is_delete_key(vk) {
            return Some(KeyKind::Delete);
        }
        if is_input_key(vk) {
            return Some(KeyKind::Input);
        }
        Some(KeyKind::Other)
    }

    pub fn on_key_up(&mut self, vk: u32) {
        if is_modifier(vk) {
            self.blocking_mods.remove(&vk);
        }
    }

    /// 失焦时清空，避免修饰键状态卡住导致后续输入被全部判为组合键。
    pub fn reset(&mut self) {
        self.blocking_mods.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VK_A: u32 = 0x41;
    const VK_SHIFT: u32 = 0x10;
    const VK_CTRL: u32 = 0x11;

    #[test]
    fn 普通字母算输入() {
        let mut c = KeyClassifier::new();
        assert_eq!(c.on_key_down(VK_A), Some(KeyKind::Input));
    }

    #[test]
    fn shift_组合仍算输入() {
        // Shift+A 打出大写 A，是实打实的文字输入，不能被过滤掉。
        let mut c = KeyClassifier::new();
        c.on_key_down(VK_SHIFT);
        assert_eq!(c.on_key_down(VK_A), Some(KeyKind::Input));
    }

    #[test]
    fn ctrl_组合不算输入() {
        let mut c = KeyClassifier::new();
        c.on_key_down(VK_CTRL);
        assert_eq!(c.on_key_down(0x43), Some(KeyKind::Other), "Ctrl+C 复制");
    }

    #[test]
    fn ctrl_抬起后恢复正常() {
        let mut c = KeyClassifier::new();
        c.on_key_down(VK_CTRL);
        assert_eq!(c.on_key_down(0x43), Some(KeyKind::Other));
        c.on_key_up(VK_CTRL);
        assert_eq!(c.on_key_down(0x43), Some(KeyKind::Input));
    }

    #[test]
    fn 删除键被单独归类() {
        let mut c = KeyClassifier::new();
        assert_eq!(c.on_key_down(VK_BACK), Some(KeyKind::Delete));
        assert_eq!(c.on_key_down(VK_DELETE), Some(KeyKind::Delete));
    }

    #[test]
    fn 方向键不算输入也不算删除() {
        let mut c = KeyClassifier::new();
        assert_eq!(c.on_key_down(0x25), Some(KeyKind::Other), "VK_LEFT");
        assert_eq!(c.on_key_down(0x70), Some(KeyKind::Other), "VK_F1");
    }

    #[test]
    fn 修饰键本身不产生事件() {
        let mut c = KeyClassifier::new();
        assert_eq!(c.on_key_down(VK_SHIFT), None);
        assert_eq!(c.on_key_down(VK_CTRL), None);
    }

    #[test]
    fn reset_解救卡住的修饰键() {
        // 场景：钩子重建时 Ctrl 正按着，它的 keyup 永远收不到。
        // 若不 reset，此后每次打字都会被当成组合键，统计彻底停摆。
        let mut c = KeyClassifier::new();
        c.on_key_down(VK_CTRL);
        assert_eq!(c.on_key_down(VK_A), Some(KeyKind::Other));

        c.reset();
        assert_eq!(c.on_key_down(VK_A), Some(KeyKind::Input), "reset 后应恢复正常统计");
    }
}
