// 发布版不弹控制台窗口；debug 版保留，方便看诊断输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(e) = typestat_lib::run() {
        fatal(&e);
    }
}

/// 启动失败时说一句人话。
///
/// 这件事在这一版里才成为必需。之前 `run()` 结尾是
/// `.expect("TypeStat 启动失败")`，而发布版是**窗口子系统 + `panic = "abort"`**：
/// 没有控制台可以打，panic 不展开也不写崩溃报告，进程只会静静地消失。
/// 用户看到的因此是「双击图标，什么都没发生」——装没装上、是不是坏了、
/// 坏了为什么，他一样都判断不了。
///
/// 主窗口现在是 `visible: false` 建的（由 setup 决定露不露面），
/// 这样一来「启动失败」就彻底没有出口了：连那个空窗口都不会出现。
/// 所以错误必须一路交到 `main`，在这里落成一个系统对话框。
///
/// debug 构建下同时也打一份到 stderr：开发时看控制台比看对话框方便。
/// 用 `MessageBoxW` 而不是 `tauri` 的对话框插件：这一刻 Tauri 应用根本没建起来，
/// 能用的只有裸 Win32。
fn fatal(msg: &str) {
    eprintln!("[typestat] 启动失败: {msg}");

    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

        // 加一句「怎么办」：只有错误码的对话框等于没说话。
        let text = format!(
            "{msg}\n\n\
             常见原因：数据目录 %APPDATA%\\com.typestat.app 不可写，\
             或数据库文件被另一个 TypeStat 进程占用。\n\
             把这个文件删掉重试通常能解决（会丢掉历史统计）：\
             %APPDATA%\\com.typestat.app\\typestat.db"
        );
        unsafe {
            MessageBoxW(
                None,
                &HSTRING::from(text),
                &HSTRING::from("TypeStat 启动失败"),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}
