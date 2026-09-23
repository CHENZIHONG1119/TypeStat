// 发布版不弹控制台窗口；debug 版保留，方便看诊断输出。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    typestat_lib::run()
}
