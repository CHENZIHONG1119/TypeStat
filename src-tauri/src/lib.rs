//! TypeStat —— 打字统计。
//!
//! 装配顺序很重要：钩子线程先起来开始往队列里灌事件，采集线程随即启动消费，
//! 两者通过有界队列解耦。钩子回调只做入队，绝不做任何 IO。

pub mod adapters;
pub mod collector;
pub mod commands;
pub mod db;
pub mod hook;
pub mod msg;
pub mod report;

use tauri::{Emitter, Manager};

use collector::QUEUE_CAPACITY;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("typestat.db");

            // 写连接交给采集线程独占，读连接交给命令层。
            let write_conn = db::open(&db_path)?;
            let read_conn = db::open(&db_path)?;

            let (tx, rx) = crossbeam_channel::bounded(QUEUE_CAPACITY);
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
            let ipc_port = match adapters::ipc::spawn(tx, token.clone()) {
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
        ])
        .run(tauri::generate_context!())
        .expect("TypeStat 启动失败");
}
