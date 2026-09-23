//! 全局低级鼠标钩子（WH_MOUSE_LL）。
//!
//! **这个钩子不为统计服务**——TypeStat 一个鼠标动作都不记，不进数据库，
//! 不进任何一张图。它只有一个用途：给看门狗一个「鼠标动过」的信号。
//!
//! 为什么非要有它：`GetLastInputInfo` 把键盘和鼠标算在一起，而键盘钩子只看
//! 得见键盘。于是下面两件事在数字上长得一模一样——系统最后输入时间一直在前进，
//! 我们这边一直没动静：
//!
//!   (a) 用户在翻网页，敲键盘的手歇着；
//!   (b) 钩子被系统摘掉了，用户正在打字。
//!
//! 分不开就只能把阈值调得很大来压误报，代价是真出事时半天发现不了。实测过：
//! 深夜挂着程序、只有鼠标在动，lag 会一路涨到 355s → 449s → 513s，每 60 秒
//! 触发一次重建，每次重建都有一小段钩子空档，正好那时打的字就丢了。
//!
//! 回调里只存一个时间戳。**这是整个程序里被调用得最频繁的函数**——鼠标快速
//! 移动时每秒能上千次——所以里面不能有任何比一次原子写更重的东西。

use std::sync::atomic::{AtomicU32, Ordering};

use windows::Win32::Foundation::{HINSTANCE, HMODULE, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, SetWindowsHookExW, HHOOK, LLMHF_INJECTED, LLMHF_LOWER_IL_INJECTED,
    MSLLHOOKSTRUCT, WH_MOUSE_LL,
};

/// 最近一次鼠标事件的时间戳（毫秒，**系统启动起算**）。
///
/// 基准必须和 `GetLastInputInfo` 的 `dwTime` 一致，否则看门狗拿两者相比就没
/// 意义——`MSLLHOOKSTRUCT.time` 正好也是那个基准。
///
/// 类型是 u32，因为源头就是 DWORD。它约 49.7 天回绕一次，所以**任何比较都
/// 必须走差值**，不能直接比大小（见 `watchdog`）。0 表示还没收到过。
static LAST_EVENT_TIME: AtomicU32 = AtomicU32::new(0);

/// 最近一次鼠标事件的时间戳（毫秒，系统启动起算）。0 表示还没收到过。
pub fn last_event_time() -> u32 {
    LAST_EVENT_TIME.load(Ordering::Relaxed)
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // code < 0 时必须原样传递，不做任何处理（HC_ACTION == 0）。
    if code >= 0 {
        let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        // **注入的鼠标事件不记。** 键盘侧同样过滤（`keyboard.rs` 的 `injected`），
        // 这里的理由比那边硬：看门狗比的是 `GetLastInputInfo`，而它**把注入的
        // 输入也算作输入**。于是鼠标抖动器（防锁屏工具、自动化脚本、某些远程
        // 桌面的输入注入）会让两边一起往前走，滞后恒为 0——钩子真被系统摘掉了
        // 也永远发现不了，键盘事件静默丢到本次会话结束，
        // 而「发现钩子已死」是这个钩子唯一的用途。
        //
        // 代价是抖动器从此会变成**误报**（我们这边不动、系统时间在动）。
        // 这个交换是划算的：误报的代价是重建时几毫秒的空档，
        // 漏报的代价是整段数据没了。
        if ms.flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED) == 0 {
            LAST_EVENT_TIME.store(ms.time, Ordering::Relaxed);
        }
    }
    CallNextHookEx(HHOOK::default(), code, wparam, lparam)
}

/// 装上鼠标钩子。
///
/// **失败只返回 None，不报错也不影响键盘钩子**：少了它，看门狗退回「只认键盘」
/// 的老行为（会误报，但功能还在）。为了一条辅助信号把正经的键盘钩子一起搭进去
/// 是不划算的。
///
/// # Safety
///
/// `hmod` 必须是**装着 `hook_proc` 那个模块**的句柄，而且要在钩子卸下之前一直
/// 保持加载。系统记下的是 `hook_proc` 的地址，每次鼠标事件都跳到那儿去——
/// 模块先被卸掉的话，那就是跳到已经释放的代码上。
/// 调用方传的是自己的 `HMODULE`（见 `Installed::new`），进程活着它就在。
pub unsafe fn install(hmod: HMODULE) -> Option<HHOOK> {
    SetWindowsHookExW(WH_MOUSE_LL, Some(hook_proc), HINSTANCE(hmod.0), 0).ok()
}
