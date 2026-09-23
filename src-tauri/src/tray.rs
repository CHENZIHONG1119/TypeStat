//! 托盘图标：收起来之后程序还在不在、怎么叫回来、怎么真的退出。
//!
//! ## 为什么这个程序必须有托盘
//!
//! 它是个常驻的采集器，不是一个「用完就关」的窗口。没有托盘的话只有两条路：
//! 关掉窗口＝停止统计（用户会以为还在记），或者关不掉窗口（用户会烦）。
//! 托盘把第三选项摆出来：**窗口收起来，计数继续，退出得明说**。
//!
//! ## 关窗口 = 收进托盘，这是刻意的
//!
//! 点 X 的行为是「把界面收起来」，不是「退出程序」。这是所有常驻统计类程序的
//! 惯例，但**惯例不等于用户知道**——所以第一次收起来时会往界面发一条
//! `window-hidden`，让前端说一句「还在后台计数」。安静地把程序留在后台运行
//! 而不告诉用户，和这个项目其它地方的毛病是同一种：界面上的状态和事实不符。
//!
//! ## 左键点图标 = 打开窗口，右键 = 出菜单
//!
//! `show_menu_on_left_click(false)`。左键是最顺手的动作，它该做最常做的事。

use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::collector::pause;
use crate::msg::CollectMsg;

const ID_OPEN: &str = "typestat-open";
const ID_PAUSE: &str = "typestat-pause";
const ID_QUIT: &str = "typestat-quit";

const TOOLTIP_ON: &str = "TypeStat — 正在记录";
const TOOLTIP_PAUSED: &str = "TypeStat — 已暂停，现在敲的不会被记";

/// 托盘的把手。留着它是为了能在别处（设置页那个开关）把菜单状态同步过来。
///
/// 菜单上的勾和 `pause` 里那个原子量是**同一件事的两种呈现**，所以必须有一处
/// 负责让它们一致。这里是那唯一一处：任何改暂停状态的地方，最后都要走到
/// [`Tray::apply_pause`]。
pub struct Tray {
    icon: tauri::tray::TrayIcon<tauri::Wry>,
    pause_item: CheckMenuItem<tauri::Wry>,
}

impl Tray {
    /// 把暂停状态刷到菜单勾选和悬停提示上。
    pub fn apply_pause(&self, paused: bool) {
        // 失败就算了：菜单勾选和提示文字是装饰，改不了也不影响记录本身
        // （真正的开关是那个原子量）。为它弹错误反而会让人以为记录出了问题。
        let _ = self.pause_item.set_checked(paused);
        let _ = self
            .icon
            .set_tooltip(Some(if paused { TOOLTIP_PAUSED } else { TOOLTIP_ON }));
    }
}

/// 把主窗口叫回来。三个动作都要做，少一个都会留下怪状态：
/// `show` 之外不 `unminimize` 的话，窗口是最小化的、叫出来还是个条；
/// 不 `set_focus` 的话它显示在别的窗口下面，用户以为没反应。
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 建托盘，并在主窗口上装「关窗口＝收起来」。
///
/// `tx` 是给「退出」用的：退出前先让采集侧把手上那点数据落库，见
/// [`CollectMsg::Flush`]。
pub fn spawn(
    app: &AppHandle,
    tx: crossbeam_channel::Sender<CollectMsg>,
) -> tauri::Result<Tray> {
    let open = MenuItem::with_id(app, ID_OPEN, "打开 TypeStat", true, None::<&str>)?;
    let paused = pause::is_paused();
    let pause_item = CheckMenuItem::new(app, "暂停记录", true, paused, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause_item, &sep, &quit])?;

    let icon = TrayIconBuilder::with_id("typestat-tray")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            // 没有图标就不要硬建一个空白托盘项：那会让用户看到一个看不见但占着
            // 位置的图标，右键也点不出来。宁可整个托盘没有，其它功能照常。
            tauri::Error::AssetNotFound("托盘图标缺失（打包时没带上 icons）".into())
        })?)
        .tooltip(if paused { TOOLTIP_PAUSED } else { TOOLTIP_ON })
        .menu(&menu)
        // 左键留给「打开窗口」，菜单只在右键出。见模块头。
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            ID_OPEN => show_main(app),
            ID_PAUSE => {
                let now = pause::set_paused(!pause::is_paused());
                // 顺手把勾刷新一遍：菜单自己会翻，但悬停提示不会——
                // 那个只有我们知道要改。
                if let Some(t) = app.try_state::<Tray>() {
                    t.apply_pause(now);
                }
                // 让界面上的开关跟着动。窗口可能没收起来，正开着设置页。
                let _ = app.emit("pause-changed", now);
            }
            ID_QUIT => {
                // 先冲一次库再退：采集侧手上可能还攥着最后不到 1.5 秒的按键，
                // 直接退就是把它们丢掉，而且丢得无声无息。
                let _ = tx.try_send(CollectMsg::Flush);
                // 给它一点时间写完。这个 sleep 是在**退出路径**上的，
                // 慢 200 毫秒没人会察觉；不 sleep 的话大多数时候也来得及，
                // 但那成了「看运气」。
                std::thread::sleep(Duration::from_millis(200));
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 只认「左键松开」这一种：按下就响应的话，想拖一下图标位置也会把窗口叫出来。
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    install_close_to_tray(app);

    Ok(Tray {
        icon,
        pause_item,
    })
}

/// 关窗口改成收进托盘。
fn install_close_to_tray(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let w = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // 不让它关。程序得留着——事件来源（钩子、接收端）都在这个进程里，
            // 窗口只是个前端。
            api.prevent_close();
            let _ = w.hide();
            // 告诉界面「你被收起来了」。前端只在**第一次**时提示一句，
            // 之后不再啰嗦（那个只出现一次的判断在前端，因为「是不是第一次」
            // 是跟着用户而不是跟着进程的）。
            let _ = w.app_handle().emit("window-hidden", ());
        }
    });
}
