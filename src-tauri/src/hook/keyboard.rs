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

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::OnceLock;

use crossbeam_channel::Sender;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, PostThreadMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG,
    WH_KEYBOARD_LL,
};

use super::mouse;
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

/// 最近一次键盘事件的时间戳（毫秒，系统启动起算，取自 `KBDLLHOOKSTRUCT.time`）。
///
/// 这个基准和 `GetLastInputInfo` 的 `dwTime`、以及 `mouse` 那边的时间戳是同一个，
/// 看门狗要靠它把三者放在一起比。宽度是 u32 因为源头就是 DWORD——约 49.7 天回绕
/// 一次，所以比较一律走差值，不能直接比大小。
static LAST_EVENT_TIME: AtomicU32 = AtomicU32::new(0);

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
                    LAST_EVENT_TIME.store(ev.time, Ordering::Relaxed);
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

/// 最近一次键盘事件的时间戳（毫秒，系统启动起算）。0 表示还没收到过。
pub fn last_event_time() -> u32 {
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
            let mut hooks = Installed::new(hmod);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
                if msg.message == WM_APP_REINSTALL {
                    hooks.reinstall(hmod);
                    continue;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            hooks.unhook();
            HOOK_ALIVE.store(false, Ordering::Relaxed);
        })?;

    let thread_id = id_rx.recv().unwrap_or(0);
    Ok(Hook { thread_id })
}

/// 钩子线程持有的两个低级钩子。
///
/// 它们必须共用同一个线程和消息循环：低级钩子只在**安装了它的那个线程**的消息
/// 循环里被调用，各起一个线程纯属白费；而且重建时两个要一起换掉，
/// 分成两处管迟早会漏掉一个，留下的那个就成了「看起来还在跑」的假象。
struct Installed {
    keyboard: Option<HHOOK>,
    mouse: Option<HHOOK>,
}

impl Installed {
    /// 装两个钩子。**鼠标那边失败不算错**——它只是看门狗的辅助信号，
    /// 见 `mouse::install`。
    unsafe fn new(hmod: HMODULE) -> Self {
        let keyboard = install(hmod);
        let mouse = mouse::install(hmod);
        // 这条不是在抱怨，是在解释后面会发生什么：少一个钩子不会崩，只会让
        // 看门狗退回「只认键盘」的老行为，半夜可能每隔一分钟重建一次。
        // 那种现象很难从别的线索倒推到这里，所以在这里留一句话。
        if mouse.is_none() {
            eprintln!("[typestat] 鼠标钩子没装上，看门狗退回只认键盘（鼠标活动会被误判成钩子失效）");
        }
        Self { keyboard, mouse }
    }

    /// 拆掉重装。看门狗判定钩子失效时走这条路。
    unsafe fn reinstall(&mut self, hmod: HMODULE) {
        self.unhook();
        *self = Self::new(hmod);
    }

    /// 拆掉。用 `take()` 而不是直接读字段，这样重复调用不会去 Unhook 一个野句柄。
    unsafe fn unhook(&mut self) {
        if let Some(h) = self.keyboard.take() {
            let _ = UnhookWindowsHookEx(h);
        }
        if let Some(h) = self.mouse.take() {
            let _ = UnhookWindowsHookEx(h);
        }
    }
}

unsafe fn install(hmod: HMODULE) -> Option<HHOOK> {
    // **无论成败都先请求清空按键状态。**
    //
    // 重建意味着中间漏掉了 keyup，卡住的修饰键会让后续所有输入被误判成组合键，
    // 只有清空能解——这一点成败都一样。原来只在成功分支发，等于「装失败时把
    // 『状态已不可信』这件事一起丢了」，而那时连新钩子都没有，状态只会更不可信。
    //
    // 走 `msg::request_reset` 而不是往队列里塞一条消息：那个队列是**有界**的，
    // 满的时候 `try_send` 会失败，而这一条恰恰是队列堵住时最需要送达的。
    // 详见 `msg::request_reset`。
    crate::msg::request_reset();

    match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), HINSTANCE(hmod.0), 0) {
        Ok(h) => {
            HOOK_ALIVE.store(true, Ordering::Relaxed);
            Some(h)
        }
        Err(_) => {
            HOOK_ALIVE.store(false, Ordering::Relaxed);
            None
        }
    }
}
