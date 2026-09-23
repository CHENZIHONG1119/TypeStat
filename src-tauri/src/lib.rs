//! TypeStat —— 打字统计。
//!
//! 装配顺序很重要：钩子线程先起来开始往队列里灌事件，采集线程随即启动消费，
//! 两者通过有界队列解耦。钩子回调只做入队，绝不做任何 IO。

pub mod adapters;
pub mod autostart;
pub mod collector;
pub mod commands;
pub mod db;
pub mod export;
pub mod hook;
pub mod msg;
pub mod report;
pub mod tray;

use tauri::{Emitter, Manager};

use collector::QUEUE_CAPACITY;

/// 带返回值：启动失败时要能让调用方（`main.rs`）把原因说出来。
///
/// 这件事在这里不是风格问题。`release` 是 `panic = "abort"` + 窗口子系统，
/// 一旦 setup 里出错又没人接住，进程当场消失，**用户双击图标什么都不会发生**，
/// 连一句「为什么」都没有。把错误交回去，才有地方弹那个对话框。
pub fn run() -> Result<(), String> {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("typestat.db");

            // 写连接交给采集线程独占，读连接交给命令层。
            let write_conn = db::open(&db_path)?;
            let read_conn = db::open(&db_path)?;

            let (tx, rx) = crossbeam_channel::bounded(QUEUE_CAPACITY);
            // 托盘菜单的「退出」要拿它冲一次库，所以留一份在手里。
            // 容量 1：UI 只需要知道"有新数据了"，不需要知道有几次。
            let (dirty_tx, dirty_rx) = crossbeam_channel::bounded(1);

            let hook = hook::spawn(tx.clone())?;
            // 看门狗拿一份句柄，AppState 拿另一份供 UI 查询状态。
            hook::watchdog::spawn(hook.clone());
            collector::spawn(rx, write_conn, dirty_tx)?;

            // 插件上报通道。token 首次运行时生成并持久化，
            // 之后固定不变——否则用户每次重装插件都要重新抄一遍。
            let token = match db::get_setting(&read_conn, "adapter_token")? {
                Some(t) if !t.is_empty() => t,
                _ => {
                    let t = adapters::ipc::random_token();
                    db::set_setting(&read_conn, "adapter_token", &t)?;
                    t
                }
            };
            // 留一份 tx 给托盘里的「退出」用（退出前要冲一次库）。
            let ipc_port = match adapters::ipc::spawn(tx.clone(), token.clone()) {
                Some(p) => {
                    db::set_setting(&read_conn, "adapter_port", &p.to_string())?;
                    Some(p)
                }
                None => {
                    eprintln!("[typestat] 42180-42189 全部被占用，插件上报通道未启用");
                    None
                }
            };

            // 采集线程每次落库后通知 UI 主动刷新。
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("typestat-notify".into())
                .spawn(move || {
                    while dirty_rx.recv().is_ok() {
                        let _ = handle.emit("stats-updated", ());
                    }
                })?;

            app.manage(commands::AppState {
                db: parking_lot::Mutex::new(read_conn),
                hook,
                adapter_token: token,
                adapter_port: ipc_port,
                // 空的：没有任何一期正在生成。期次坑位见 `report::InFlight`。
                report_busy: parking_lot::Mutex::new(std::collections::HashSet::new()),
                db_path,
            });

            // 托盘。放在最后：它要读 `pause` 的当前状态、要拿 `tx`，
            // 而且它建的窗口事件钩子引用的是已经建好的主窗口。
            let t = tray::spawn(app.handle(), tx)?;
            app.manage(t);

            // 窗口是 `visible: false` 建的（见 tauri.conf.json），这里决定要不要露面。
            //
            // **任何一条提前返回的路径都会让窗口永远不出现**，所以这一句必须放在
            // 所有可能失败的步骤之后；而 `main.rs` 会在 setup 出错时弹对话框兜底，
            // 不让用户面对「双击了没反应」。
            //
            // 开机自启带 `--minimized`：那时只留托盘图标，不弹窗口盖住桌面。
            if !autostart::start_minimized() {
                tray::show_main(app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::current_day,
            commands::today_summary,
            commands::hourly,
            commands::daily,
            commands::app_breakdown,
            commands::cell_grid,
            commands::key_usage,
            commands::get_settings,
            commands::set_setting,
            commands::hook_status,
            commands::reinstall_hook,
            commands::adapter_status,
            commands::rotate_adapter_token,
            commands::report_periods,
            commands::report_get,
            commands::report_generate,
            commands::report_catchup,
            commands::report_settings,
            commands::report_save_settings,
            commands::export_data,
            commands::open_export_dir,
            commands::wps_addon_status,
            commands::install_wps_addon,
            commands::export_adapter_files,
            commands::open_wps_addon_dir,
            commands::pause_status,
            commands::set_paused,
            commands::autostart_status,
            commands::set_autostart,
        ])
        .run(tauri::generate_context!())
        .map_err(|e| format!("{e}"))
}
