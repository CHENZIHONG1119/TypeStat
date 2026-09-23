//! 全局键盘钩子层：只负责把系统的原始按键事件捞出来，不做任何统计判断。

pub mod keyboard;
pub mod watchdog;

pub use keyboard::{event_count, last_event_time, spawn, Hook};
