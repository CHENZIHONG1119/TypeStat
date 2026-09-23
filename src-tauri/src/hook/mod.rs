//! 全局低级钩子层：把系统的原始按键事件捞出来，不做任何统计判断。
//!
//! `mouse` 是个例外，它不产生任何统计——只记一个时间戳给看门狗用，
//! 好让看门狗能分清「用户在动鼠标」和「钩子被系统摘了」。

pub mod keyboard;
pub mod mouse;
pub mod watchdog;

pub use keyboard::{event_count, last_event_time, spawn, Hook};
