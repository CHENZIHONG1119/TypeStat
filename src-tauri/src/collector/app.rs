//! 前台窗口 → 进程名解析。
//!
//! 缓存策略：**以 pid 为键缓存进程名，而不是以 hwnd 为键**。
//! 窗口句柄在窗口销毁后会被系统回收复用，按 hwnd 缓存会把旧窗口的名字
//! 错误地安到新窗口头上。pid 虽然也会复用，但配合短 TTL 和容量上限，
//! 出错概率远低于 hwnd。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, FALSE};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

const MAX_CACHE_ENTRIES: usize = 256;

/// 缓存条目的存活时间。超过就重新解析一次。
///
/// **没有 TTL 的 pid 缓存是错的**，而这个模块开头从第一天起就写着「配合短 TTL」——
/// 只是没实现，只有容量上限。pid 会被系统回收复用：某个进程退出后它的 pid 分给了
/// 另一个程序，而缓存里那条映射永不失效，于是新程序里敲的每一个键都记到
/// **旧应用名下**。它不报错、数字看着也合理，只是张冠李戴——
/// 正是这个程序最不肯放过的那种错。
///
/// 5 分钟是个折中：解析一次要开进程句柄，而前台应用一换就要解析一次，
/// 缓存本身是必要的；另一方面用户不会对「5 分钟前的应用名」有异议。
const ENTRY_TTL: Duration = Duration::from_secs(300);

pub struct AppResolver {
    /// pid → （进程名，记下来的时刻）。
    cache: HashMap<u32, (String, Instant)>,
}

impl Default for AppResolver {
    fn default() -> Self {
        Self::new()
    }
}

impl AppResolver {
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
        }
    }

    /// 把前台窗口解析成进程名（如 `Obsidian.exe`）。
    /// 解析不出来时返回 `unknown`，绝不让上层因此丢事件。
    pub fn resolve(&mut self, hwnd: isize) -> String {
        let pid = match pid_of_window(hwnd) {
            Some(p) => p,
            None => return "unknown".to_string(),
        };

        let now = Instant::now();
        if let Some((name, at)) = self.cache.get(&pid) {
            // 过期就当作没有，往下走去重新解析并覆盖。见 `ENTRY_TTL`。
            if now.duration_since(*at) < ENTRY_TTL {
                return name.clone();
            }
        }

        let name = process_name(pid).unwrap_or_else(|| "unknown".to_string());

        // 简单粗暴的容量控制：满了就整体清空，避免无界增长。
        if self.cache.len() >= MAX_CACHE_ENTRIES {
            self.cache.clear();
        }
        self.cache.insert(pid, (name.clone(), now));
        name
    }
}

fn pid_of_window(hwnd: isize) -> Option<u32> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(
            windows::Win32::Foundation::HWND(hwnd as *mut _),
            Some(&mut pid as *mut u32),
        );
        if pid == 0 {
            None
        } else {
            Some(pid)
        }
    }
}

fn process_name(pid: u32) -> Option<String> {
    unsafe {
        // PROCESS_QUERY_LIMITED_INFORMATION 是能拿到提权进程名字的最低权限，
        // 用更高的权限会在普通用户下直接失败。
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid).ok()?;

        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);

        result.ok()?;
        let full = String::from_utf16_lossy(&buf[..len as usize]);

        // 只保留文件名部分：C:\...\Obsidian.exe → Obsidian.exe
        Some(
            full.rsplit(['\\', '/'])
                .next()
                .unwrap_or(&full)
                .to_string(),
        )
    }
}
