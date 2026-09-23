//! 前台窗口 → 进程名解析。
//!
//! 缓存策略：**以 pid 为键缓存进程名，而不是以 hwnd 为键**。
//! 窗口句柄在窗口销毁后会被系统回收复用，按 hwnd 缓存会把旧窗口的名字
//! 错误地安到新窗口头上。pid 虽然也会复用，但配合短 TTL 和容量上限，
//! 出错概率远低于 hwnd。

use std::collections::HashMap;

use windows::Win32::Foundation::{CloseHandle, FALSE};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

const MAX_CACHE_ENTRIES: usize = 256;

pub struct AppResolver {
    cache: HashMap<u32, String>,
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

        if let Some(name) = self.cache.get(&pid) {
            return name.clone();
        }

        let name = process_name(pid).unwrap_or_else(|| "unknown".to_string());

        // 简单粗暴的容量控制：满了就整体清空，避免无界增长。
        if self.cache.len() >= MAX_CACHE_ENTRIES {
            self.cache.clear();
        }
        self.cache.insert(pid, name.clone());
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
