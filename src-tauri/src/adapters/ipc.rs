//! 本地 HTTP 接收端，接收编辑器插件上报的精确字数。
//!
//! 为什么用插件而不是 UI Automation：
//! - Obsidian / VS Code 是 Electron 应用，UIA 树默认残缺，要用户手动开无障碍模式
//! - 插件走编辑器自己的 API，能拿到**精确的增删字符数**，比读文本做差分准得多
//! - 内容一个字都不出编辑器，插件只上报两个整数
//!
//! 监听范围严格限定 127.0.0.1，且要求 token，避免本机其他程序误报或污染数据。

use std::net::TcpListener as StdTcpListener;
use std::sync::atomic::{AtomicI64, AtomicU16, Ordering};
use std::sync::{Arc, OnceLock};

use parking_lot::RwLock;

use axum::{
    body::Body,
    extract::State,
    http::{
        header::{
            ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
            ACCESS_CONTROL_MAX_AGE,
        },
        HeaderMap, HeaderValue, Method, Request, StatusCode,
    },
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use crossbeam_channel::Sender;
use serde::Deserialize;

use crate::msg::{CharSource, CollectMsg};

/// 端口探测范围。默认端口被占用时依次顺延。
const PORT_RANGE: std::ops::RangeInclusive<u16> = 42180..=42189;

/// 单次上报的上限。超过这个数几乎可以确定是插件出错或恶意请求。
const MAX_CHARS_PER_REPORT: i64 = 100_000;

static ACTUAL_PORT: AtomicU16 = AtomicU16::new(0);
/// 最近一次成功上报的时间（Unix 秒）。0 表示从未收到过。
static LAST_REPORT_AT: AtomicI64 = AtomicI64::new(0);

/// 当前 token。用共享锁而不是把 token 拷进 handler 的状态里，
/// 是为了让"重新生成 token"能立刻生效，不必重启接收端。
static TOKEN: OnceLock<Arc<RwLock<String>>> = OnceLock::new();

#[derive(Clone)]
struct ServerState {
    tx: Sender<CollectMsg>,
    token: Arc<RwLock<String>>,
}

#[derive(Deserialize)]
struct Report {
    app: String,
    input: i64,
    #[serde(rename = "delete")]
    delete: i64,
}

/// 启动接收端，返回实际监听的端口。端口全部被占用时返回 `None`。
pub fn spawn(tx: Sender<CollectMsg>, token: String) -> Option<u16> {
    let (port, listener) = bind_first_free()?;

    if listener.set_nonblocking(true).is_err() {
        return None;
    }

    ACTUAL_PORT.store(port, Ordering::Relaxed);

    let token = TOKEN.get_or_init(|| Arc::new(RwLock::new(token))).clone();
    let state = ServerState { tx, token };

    // 自带一条单线程 tokio 运行时，而不是借用 tauri::async_runtime：
    // 后者是否启用了 I/O driver 取决于 Tauri 内部的 feature 选择，
    // 一旦没有，监听套接字会在运行时 panic 且很难查。自己建运行时彻底绕开这个不确定性，
    // 代价只是一条几乎全程阻塞在 epoll 上的线程。
    std::thread::Builder::new()
        .name("typestat-ipc".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[typestat] 接收端运行时创建失败: {e}");
                    return;
                }
            };

            rt.block_on(async move {
                // from_std 必须在 tokio 运行时上下文内调用。
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("[typestat] 接收端初始化失败: {e}");
                        return;
                    }
                };

                let app = Router::new()
                    .route("/report", post(report))
                    .route("/health", get(health))
                    .layer(middleware::from_fn(cors))
                    .with_state(state);

                if let Err(e) = axum::serve(listener, app).await {
                    eprintln!("[typestat] 接收端已停止: {e}");
                }
            });
        })
        .ok()?;

    Some(port)
}

fn bind_first_free() -> Option<(u16, StdTcpListener)> {
    for port in PORT_RANGE {
        if let Ok(l) = StdTcpListener::bind(("127.0.0.1", port)) {
            return Some((port, l));
        }
    }
    None
}

/// 实际监听的端口。0 表示未启动。
pub fn port() -> u16 {
    ACTUAL_PORT.load(Ordering::Relaxed)
}

/// 最近一次成功上报的时间（Unix 秒）。0 表示从未收到。
pub fn last_report_at() -> i64 {
    LAST_REPORT_AT.load(Ordering::Relaxed)
}

/// 健康检查。插件可以用它确认接收端是否在跑。
async fn health() -> &'static str {
    "ok"
}

/// 放行跨源请求。
///
/// 插件页面不在 http://127.0.0.1:<端口> 这个源上（WPS 的加载项页面是 file:// 或
/// WPS 自己的本地服务），而请求又带了 `x-typestat-token` 这个自定义头，浏览器会
/// 先发 OPTIONS 预检。不处理的话预检落到只注册了 POST 的路由上，回 405，插件会
/// 报"连不上"——但接收端其实是好的，这种错最难查。
///
/// 允许任意源在这里是安全的：接收端只绑 127.0.0.1，且每个请求都验 token。
/// 网页拿不到 token（它在插件的本地文件里），所以放行 CORS 并不会让任意网站
/// 能往统计里灌数据——真正的门是 token。
async fn cors(req: Request<Body>, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::NO_CONTENT;
        let h = res.headers_mut();
        h.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        h.insert(
            ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("POST, GET, OPTIONS"),
        );
        h.insert(
            ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, x-typestat-token"),
        );
        // 预检结果缓存一天，省掉每次上报前的一次往返。
        h.insert(ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
        return res;
    }

    let mut res = next.run(req).await;
    res.headers_mut()
        .insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    res
}

async fn report(
    State(st): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Report>,
) -> StatusCode {
    // token 校验：本机其他程序不该能往统计里灌数据。
    let provided = headers
        .get("x-typestat-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    // 先比长度再比内容，纯粹是为了让比较本身不依赖短路时机；
    // 这里不是密码学场景，不做恒定时间比较。
    let expected = st.token.read();
    if provided.len() != expected.len() || provided != expected.as_str() {
        return StatusCode::UNAUTHORIZED;
    }
    drop(expected);

    if body.input < 0 || body.delete < 0 {
        return StatusCode::BAD_REQUEST;
    }
    if body.input > MAX_CHARS_PER_REPORT || body.delete > MAX_CHARS_PER_REPORT {
        return StatusCode::BAD_REQUEST;
    }

    // 全零上报是插件的"测试连接"用的：token 已经验过了，
    // 直接回 200 让它确认通路，但不落库、也不刷新 last_report_at。
    if body.input == 0 && body.delete == 0 {
        return StatusCode::OK;
    }

    let app = sanitize_app_name(&body.app);
    if app.is_empty() {
        return StatusCode::BAD_REQUEST;
    }

    let msg = CollectMsg::Chars {
        app,
        input: body.input,
        delete: body.delete,
        source: CharSource::Plugin,
    };

    // 用 try_send：接收端绝不能被队列反压卡住，否则插件侧会一直等待。
    match st.tx.try_send(msg) {
        Ok(()) => {
            LAST_REPORT_AT.store(chrono::Local::now().timestamp(), Ordering::Relaxed);
            StatusCode::OK
        }
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}

/// 清洗应用名：只保留文件名，去掉路径和可疑字符。
///
/// 插件上报的名字会直接进数据库并显示在界面上，必须当成不可信输入处理——
/// 否则一个带路径分隔符或控制字符的名字就能污染整个分应用统计。
fn sanitize_app_name(raw: &str) -> String {
    let name = raw
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches(".exe")
        .trim();

    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\'')
        .take(64)
        .collect();

    // 要求至少有一个字母或数字。真实进程名一定有，而 "."、"---" 这种
    // 只有标点的名字只可能是伪造或出错，放进去只会污染分应用统计。
    if !cleaned.chars().any(|c| c.is_alphanumeric()) {
        return String::new();
    }
    // 统一带上 .exe 后缀，与钩子侧从进程名拿到的格式对齐，
    // 否则同一个应用会被拆成两行统计。
    format!("{cleaned}.exe")
}

/// 当前生效的 token。接收端未启动时返回 `None`。
pub fn current_token() -> Option<String> {
    TOKEN.get().map(|l| l.read().clone())
}

/// 重新生成 token，立即生效。用于用户怀疑 token 外泄时。
/// 返回新 token；接收端从未启动过时返回 `None`。
pub fn rotate_token() -> Option<String> {
    let lock = TOKEN.get()?;
    let fresh = random_token();
    *lock.write() = fresh.clone();
    Some(fresh)
}

/// 生成随机 token。不需要密码学强度，但必须不可预测，
/// 免得本机其他程序碰巧撞上。
pub fn random_token() -> String {
    let mut buf = [0u8; 16];
    if getrandom::getrandom(&mut buf).is_err() {
        // 理论上不会发生；退化成时间种子也比空 token 强。
        let t = chrono::Local::now().timestamp_nanos_opt().unwrap_or(0);
        return format!("{t:016x}");
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 应用名清洗去掉路径与控制字符() {
        assert_eq!(sanitize_app_name("Obsidian.exe"), "Obsidian.exe");
        assert_eq!(sanitize_app_name("C:\\App\\Obsidian.exe"), "Obsidian.exe");
        assert_eq!(sanitize_app_name("obsidian"), "obsidian.exe");
        assert_eq!(sanitize_app_name("  Obsidian  "), "Obsidian.exe");
        assert_eq!(sanitize_app_name("Bad\u{0007}Name"), "BadName.exe");
    }

    #[test]
    fn 空名字被拒绝() {
        assert_eq!(sanitize_app_name(""), "");
        assert_eq!(sanitize_app_name("   "), "");
        assert_eq!(sanitize_app_name("..exe"), "");
    }

    #[test]
    fn 应用名长度有上限() {
        let long = "a".repeat(500);
        let out = sanitize_app_name(&long);
        assert!(out.len() <= 68, "名字应被截断，实际长度 {}", out.len());
    }

    #[test]
    fn token_每次不同且长度固定() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b, "两次生成的 token 不应相同");
    }
}
