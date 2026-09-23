//! 全局低级键盘钩子（WH_KEYBOARD_LL）。
//!
//! 三条硬约束来自调研，代码结构都是围绕它们设计的：
//!
//! 1. **回调必须在 LowLevelHooksTimeout（默认 300ms）内返回。** 超时累计 10 次后，
//!    系统会把钩子从链上静默摘除，而且没有任何 API 能感知。所以回调里只做
//!    「读字段 → 入队 → 返回」，绝不查 UIA、绝不写数据库。
//! 2. **KBDLLHOOKSTRUCT 没有重复计数字段，也不存在 LLKHF_REPEAT 标志。**
//!    低级钩子在输入管线最早期被调用，那时系统的重复计数器还不存在。
//!    自动重复判定交给 `collector::repeat` 的状态机。
//! 3. **必须跑在专属线程 + 自己的消息循环里。** 挂在 Tauri/tao 主线程上会和
//!    tao 自己的消息泵打架。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;

use crossbeam_channel::Sender;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, PostThreadMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG,
    WH_KEYBOARD_LL,
};

use crate::msg::{CollectMsg, RawKeyEvent};

const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_SYSKEYDOWN: u32 = 0x0104;
const WM_SYSKEYUP: u32 = 0x0105;

const LLKHF_EXTENDED: u32 = 0x0000_0001;
const LLKHF_INJECTED: u32 = 0x0000_0010;
const LLKHF_LOWER_IL_INJECTED: u32 = 0x0000_0002;

/// 自定义消息：要求钩子线程重建钩子（看门狗用）。
const WM_APP_REINSTALL: u32 = 0x8000 + 1;

/// 回调在钩子线程上跑，拿不到闭包捕获，所以用 static 传递。
static TX: OnceLock<Sender<CollectMsg>> = OnceLock::new();

/// 累计入队事件数，看门狗用它交叉验证钩子是否还活着。
static EVENT_COUNT: AtomicU64 = AtomicU64::new(0);

/// 最近一次键盘事件的时间戳（毫秒，KBDLLHOOKSTRUCT.time）。
static LAST_EVENT_TIME: AtomicU64 = AtomicU64::new(0);

/// 钩子当前是否处于已安装状态。
static HOOK_ALIVE: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // code < 0 时必须原样传递，不做任何处理（HC_ACTION == 0）。
    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let msg = wparam.0 as u32;
        let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

        if is_down || is_up {
            let flags = kb.flags.0;
            let injected = flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED) != 0;

            if let Some(tx) = TX.get() {
                let ev = RawKeyEvent {
                    vk_code: kb.vkCode,
                    scan_code: kb.scanCode,
                    extended: flags & LLKHF_EXTENDED != 0,
                    is_down,
                    injected,
                    time: kb.time,
                    hwnd: GetForegroundWindow().0 as isize,
                };
                // try_send：队列满时宁可丢事件，也绝不在回调里阻塞。
                if tx.try_send(CollectMsg::Key(ev)).is_ok() {
                    EVENT_COUNT.fetch_add(1, Ordering::Relaxed);
                    LAST_EVENT_TIME.store(ev.time as u64, Ordering::Relaxed);
                }
            }
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// 钩子线程的句柄，用于请求重建。
/// 内部只有一个线程 ID，克隆它是安全的——看门狗和 AppState 各持一份。
#[derive(Clone)]
pub struct Hook {
    thread_id: u32,
}

impl Hook {
    /// 请求钩子线程重建钩子。重建是幂等的，误判的代价只是几毫秒的事件空档。
    pub fn request_reinstall(&self) -> bool {
        unsafe {
            PostThreadMessageW(self.thread_id, WM_APP_REINSTALL, WPARAM(0), LPARAM(0)).is_ok()
        }
    }

    pub fn is_alive(&self) -> bool {
        HOOK_ALIVE.load(Ordering::Relaxed)
    }
}

/// 最近一次键盘事件的时间戳（毫秒，系统启动起算）。
pub fn last_event_time() -> u64 {
    LAST_EVENT_TIME.load(Ordering::Relaxed)
}

/// 累计入队事件数。
pub fn event_count() -> u64 {
    EVENT_COUNT.load(Ordering::Relaxed)
}

/// 启动钩子线程。线程内部建立自己的消息循环，直到收到 WM_QUIT。
pub fn spawn(tx: Sender<CollectMsg>) -> std::io::Result<Hook> {
    let (id_tx, id_rx) = std::sync::mpsc::channel::<u32>();

    std::thread::Builder::new()
        .name("typestat-hook".into())
        .spawn(move || unsafe {
            TX.set(tx).ok();
            let _ = id_tx.send(GetCurrentThreadId());

            // hMod 传当前模块句柄，低级钩子不要求是 DLL，但传了更稳。
            let hmod = GetModuleHandleW(PCWSTR::null()).unwrap_or_default();
            let mut hook = install(hmod);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                if msg.message == WM_APP_REINSTALL {
                    if let Some(h) = hook.take() {
                        let _ = UnhookWindowsHookEx(h);
                    }
                    hook = install(hmod);
                    continue;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            if let Some(h) = hook.take() {
                let _ = UnhookWindowsHookEx(h);
            }
            HOOK_ALIVE.store(false, Ordering::Relaxed);
        })?;

    let thread_id = id_rx.recv().unwrap_or(0);
    Ok(Hook { thread_id })
}

unsafe fn install(hmod: windows::Win32::Foundation::HMODULE) -> Option<HHOOK> {
    match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), HINSTANCE(hmod.0), 0) {
        Ok(h) => {
            HOOK_ALIVE.store(true, Ordering::Relaxed);
            // 重建意味着中间可能漏掉了 keyup，通知 worker 清空按键状态，
            // 否则卡住的修饰键会让后续所有输入被误判成组合键。
            if let Some(tx) = TX.get() {
                let _ = tx.try_send(CollectMsg::Reset);
            }
            Some(h)
        }
        Err(_) => {
            HOOK_ALIVE.store(false, Ordering::Relaxed);
            None
        }
    }
}
