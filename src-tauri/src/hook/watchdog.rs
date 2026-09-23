//! 钩子存活检测。
//!
//! 系统在回调超时累计 10 次后会静默摘除钩子，且**不提供任何通知 API**。
//! 唯一的办法是交叉验证：拿系统的「上次输入时间」和我们自己的事件计数对比。
//! 若系统显示刚有输入、我们却长时间没收到任何事件，说明钩子已经掉了。
//!
//! 注意 GetLastInputInfo 把鼠标也计入，所以它比我们"新"是正常的。只有差距
//! 大到无法用鼠标活动解释时才触发重建，而且**重建是幂等的**——误判的代价
//! 只是几毫秒的事件空档，所以宁可激进一点。

use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

use super::keyboard::{self, Hook};

/// 检查间隔。
const CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// 系统输入时间领先我们最近一次键盘事件多久，才判定钩子已死。
/// 取 120 秒是为了稳稳盖过"纯鼠标操作"造成的正常偏差。
const SUSPECT_THRESHOLD_MS: u64 = 120_000;

pub fn spawn(hook: Hook) {
    std::thread::Builder::new()
        .name("typestat-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(CHECK_INTERVAL);

            let system_last = match system_last_input_ms() {
                Some(t) => t,
                None => continue,
            };

            let ours = keyboard::last_event_time();

            // 我们从来没收到过事件（ours == 0）时不做判断，避免启动初期误触发。
            if ours == 0 {
                continue;
            }

            let lag = system_last.saturating_sub(ours);
            if lag > SUSPECT_THRESHOLD_MS {
                eprintln!(
                    "[typestat] 看门狗：系统最后输入领先本地记录 {}s，判定钩子已失效，请求重建",
                    lag / 1000
                );
                hook.request_reinstall();
            }
        })
        .expect("spawn watchdog thread");
}

/// 系统最近一次输入的时间戳（毫秒，系统启动起算）。
fn system_last_input_ms() -> Option<u64> {
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info).as_bool() {
            Some(info.dwTime as u64)
        } else {
            None
        }
    }
}
