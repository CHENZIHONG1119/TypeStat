//! 调 OpenAI 兼容接口写报告正文。
//!
//! 走的是 OpenAI 的协议形状（`POST {base}/chat/completions` + bearer 鉴权 +
//! `choices[0].message.content`），所以 DeepSeek / 通义 / Kimi / 本地 Ollama
//! 都只是换个 `base_url` 和 `model`，不用改代码。
//!
//! # 失败也是一种结果，不是异常
//!
//! 模型调不通时，我们要的**不是**「报错然后界面空着」，而是「换本地模板写，
//! 并在报告上写明为什么」。所以 [`write`] 没有 `Err` 分支，返回值只有
//! 「谁写的」和「为什么不是模型」。命令层于是不会把一次网络故障包装成红色错误，
//! 用户看到的永远是一份报告。
//!
//! # 降级原因是封闭集合
//!
//! 不用 `reqwest` 的原始报错。原文里带着完整 URL——把 key 填在 query 里的人
//! （`?api_key=…`，有些服务就是这么设计的）会因此把它漏进 `note`，
//! 而 `note` 是**要落库、要上屏**的。所以每个失败都被压成 [`REASONS`] 里的某一句话。
//!
//! # 这里没有 `&str` 的密钥进日志
//!
//! 密钥只在 `bearer_auth` 那一处出现，不拼进 URL、不进 `note`、不打日志。

use std::time::Duration;

use super::text;
use super::ReportFacts;

/// 默认接口。填了 key 就能用，不用先去翻文档。
pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com/v1";
/// 默认模型。
pub const DEFAULT_MODEL: &str = "deepseek-chat";

/// 连接阶段最多等这么久。连不上要快点说，别让用户对着转圈等半分钟。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 整个请求最多等这么久。生成一次几百字，正常几秒到十几秒。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 响应体的字节上限。
///
/// `max_tokens` 已经把它压在几 KB 了，这个上限是防「对面不是一个正常的接口」：
/// 比如把地址填成了某个会回一整页 HTML 的服务。
const MAX_BODY: u64 = 64 * 1024;

/// 降级原因的封闭集合。
///
/// 列在这里不只是文档——`note` 会落库、上屏，用户会照着它去改设置。
/// 每加一条都问一遍：这句话能让人知道下一步做什么吗？
pub const REASONS: &[&str] = &[
    "未配置 API key",
    "存的 API key 解不开了",
    "接口地址不是合法的 http(s) 地址",
    "连接超时（10 秒）",
    "请求超时（30 秒）",
    "无法连接",
    "连接被重置",
    "证书校验失败",
    "服务返回 4xx（后面还会带一句为什么）",
    "响应不是合法的 JSON",
    "响应里没有正文",
    "模型返回了空正文",
    "响应过长（超过 64 KB）",
    "请求失败",
];

/// 密钥的三种状态。
///
/// **三种，不是「有 / 没有」两种。** 「没配」和「配过但解不开」在界面上是
/// 两句不同的话：前者请用户去填一个，后者请用户去重填一次。
/// 合成一个 `None`，第二种情况的用户会去翻设置页、看见一个空框、
/// 以为自己从来没填过——而问题根本不在那儿。
#[derive(Debug, Clone)]
pub enum ApiKey {
    Missing,
    Broken,
    Ready(String),
}

/// 从设置里取出来的接口配置。`api_key` 是明文，出了这个结构体的生命周期就该没了。
#[derive(Debug, Clone)]
pub struct Config {
    pub base_url: String,
    pub model: String,
    pub api_key: ApiKey,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            api_key: ApiKey::Missing,
        }
    }
}

/// 正文是谁写的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Llm,
    Template,
}

impl Source {
    /// 存进 `reports.source`，也直接发给前端。
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Llm => "llm",
            Source::Template => "template",
        }
    }
}

/// 一期的正文加上它的来历。
#[derive(Debug, Clone)]
pub struct Written {
    pub body: String,
    pub source: Source,
    /// 用的是哪个模型；降级成模板时是 `None`——那时候一个模型都没参与。
    pub model: Option<String>,
    /// 为什么没走模型；成功时是 `None`。
    pub note: Option<String>,
}

/// 本地模板写的那一份。**降级的每一条路都走这里**，所以「降级」只有一种样子。
pub fn fallback(facts: &ReportFacts, note: &str) -> Written {
    Written {
        body: text::render_template(facts),
        source: Source::Template,
        model: None,
        note: Some(note.to_string()),
    }
}

/// 这次请求发不发得出去。`Some(原因)` 表示不该发。
///
/// 刻意做成同步的、而且和网络那一段分开：**这三条降级路径是唯一能在没有密钥的
/// 情况下验证的**，而它们恰恰是最容易悄悄坏掉的（比如某次改动让「解不开」退化成了
/// 「没配」）。放在异步函数里就只能靠连网才测得到，等于没测。
pub fn blocked(cfg: &Config) -> Option<&'static str> {
    match &cfg.api_key {
        ApiKey::Missing => return Some("未配置 API key"),
        ApiKey::Broken => return Some("存的 API key 解不开了"),
        ApiKey::Ready(k) if k.trim().is_empty() => return Some("未配置 API key"),
        ApiKey::Ready(_) => {}
    }
    if chat_url(&cfg.base_url).is_err() {
        return Some("接口地址不是合法的 http(s) 地址");
    }
    None
}

/// 由 `base_url` 拼出真正的端点。
///
/// 顺手容下「地址里已经带了 `/chat/completions`」的写法——不少服务的文档直接给
/// 完整端点，照抄进设置页是很自然的事，为此报一个「地址不合法」太苛刻。
pub fn chat_url(base_url: &str) -> Result<String, &'static str> {
    let trimmed = base_url.trim().trim_end_matches('/');
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| "接口地址不是合法的 http(s) 地址")?;
    match parsed.scheme() {
        "http" | "https" => {}
        // 别的协议（file:、ftp:…）直接挡住：reqwest 也不支持，
        // 但让它走到发请求那一步，用户看到的会是一句不好懂的报错。
        _ => return Err("接口地址不是合法的 http(s) 地址"),
    }
    if parsed.host_str().is_none() {
        return Err("接口地址不是合法的 http(s) 地址");
    }
    if trimmed.ends_with("/chat/completions") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/chat/completions"))
    }
}

/// 请求体。抽出来是为了能看清发了什么——**里面只有清单，没有用户输入的内容**。
pub fn payload(model: &str, sheet: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": text::SYSTEM_PROMPT },
            { "role": "user", "content": sheet },
        ],
        "temperature": 0.3,
        "max_tokens": 1200,
        "stream": false,
    })
}

/// 从响应里取出正文。
///
/// **宽松解析**：多一个没料到的字段不该让它崩，少一个字段也只是降级。
/// 所以走 `Value` 而不是一个 `#[derive(Deserialize)]` 的结构体——
/// 后者会因为对面多塞了一个字段就整个解析失败，而那正是最常见的兼容性差异。
pub fn extract_content(v: &serde_json::Value) -> Result<String, &'static str> {
    let content = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str());
    match content {
        Some(s) if !s.trim().is_empty() => Ok(s.trim().to_string()),
        Some(_) => Err("模型返回了空正文"),
        None => Err("响应里没有正文"),
    }
}

/// 把 `reqwest` 的报错压成封闭集合里的一句话。
///
/// 原始报错**只用来看**（`same_text` 里转一圈就扔），从不进 `note`。
fn classify(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        // 连接超时和请求超时是两件事：前者根本没连上，后者连上了但对面回得慢。
        // 用户要做的事也不同（一个查网络，一个查对面是不是在抽风），所以分开说。
        return if e.is_connect() {
            "连接超时（10 秒）"
        } else {
            "请求超时（30 秒）"
        };
    }
    if e.is_connect() {
        let chain = source_text(e);
        if chain.contains("certificate") || chain.contains("cert") || chain.contains("证书") {
            return "证书校验失败";
        }
        if chain.contains("reset")
            || chain.contains("forcibly closed")
            || chain.contains("10054")
        {
            return "连接被重置";
        }
        return "无法连接";
    }
    "请求失败"
}

/// 把整条错误链的文字拼起来，**只用于分类**。
fn source_text(e: &reqwest::Error) -> String {
    use std::error::Error;
    let mut out = e.to_string().to_lowercase();
    let mut cur: Option<&(dyn Error + 'static)> = e.source();
    // 链子理论上有限，但坏掉的实现可能有环。给个上限，别在这儿转死。
    let mut hops = 0;
    while let Some(err) = cur {
        out.push(' ');
        out.push_str(&err.to_string().to_lowercase());
        cur = err.source();
        hops += 1;
        if hops > 8 {
            break;
        }
    }
    out
}

/// 写一期的正文。**永远返回一份写好的正文**，失败就换模板。
pub async fn write(cfg: &Config, facts: &ReportFacts) -> Written {
    if let Some(why) = blocked(cfg) {
        return fallback(facts, why);
    }
    let key = match &cfg.api_key {
        ApiKey::Ready(k) => k.trim().to_string(),
        // `blocked` 已经把另外两种挡住了，这里是兜底。
        _ => return fallback(facts, "未配置 API key"),
    };
    // `blocked` 已经验过一次地址，这里 unwrap 是安全的；真出意外也只是降级。
    let Ok(url) = chat_url(&cfg.base_url) else {
        return fallback(facts, "接口地址不是合法的 http(s) 地址");
    };
    let model = if cfg.model.trim().is_empty() {
        DEFAULT_MODEL.to_string()
    } else {
        cfg.model.trim().to_string()
    };

    let sheet = text::render_sheet(facts);

    // Client 每次现建。一周生成几次，连接池省不下什么；
    // 而 `static` 是一个永不析构的东西，这个 crate 里没有任何关机路径。
    let client = match reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return fallback(facts, "无法连接"),
    };

    let resp = match client
        .post(&url)
        .bearer_auth(&key)
        .json(&payload(&model, &sheet))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return fallback(facts, classify(&e)),
    };

    if !resp.status().is_success() {
        // 只报状态码，**不报响应体**：对面回什么都有可能（有些网关会把请求头
        // 原样回显，那里面就有 Authorization），而这句话是要落库上屏的。
        return fallback(facts, &status_reason(resp.status().as_u16()));
    }
    // 读之前先看一眼长度。分块传输时这里会是 None，读完再核一次字节数。
    if resp.content_length().is_some_and(|len| len > MAX_BODY) {
        return fallback(facts, "响应过长（超过 64 KB）");
    }
    let body = match resp.text().await {
        Ok(t) => t,
        Err(e) => return fallback(facts, classify(&e)),
    };
    if body.len() as u64 > MAX_BODY {
        return fallback(facts, "响应过长（超过 64 KB）");
    }

    let value: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => return fallback(facts, "响应不是合法的 JSON"),
    };
    match extract_content(&value) {
        Ok(body) => Written {
            body,
            source: Source::Llm,
            model: Some(model),
            note: None,
        },
        Err(why) => fallback(facts, why),
    }
}

/// 非 2xx 的原因。
///
/// 和 [`REASONS`] 里那条「服务返回错误状态码」是同一件事的两种精度：
/// 状态码本身要留着（401 是 key 不对、429 是花超了、503 是那边挂了，
/// 用户要做的事完全不同），但**不区分 1xx–5xx 之外的东西**——
/// 别让对面能凭一个状态码往我们的界面上写任意数字。
fn status_reason(code: u16) -> String {
    let hint = match code {
        401 => "（key 不对或已失效）",
        402 => "（账户余额不足）",
        403 => "（没有权限，可能是模型名不对）",
        404 => "（接口地址或模型名不对）",
        429 => "（请求太频繁或额度用尽）",
        500..=599 => "（对面服务出错）",
        _ => "",
    };
    // 中文括号前不留空格，所以 hint 是直接贴上去的。
    format!("服务返回 {code}{hint}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼端点：默认地址、带尾斜杠、已经带了端点、以及各种不合法。
    #[test]
    fn 端点拼接() {
        assert_eq!(
            chat_url("https://api.deepseek.com/v1").unwrap(),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            chat_url("  https://api.deepseek.com/v1/  ").unwrap(),
            "https://api.deepseek.com/v1/chat/completions"
        );
        // 文档里直接抄完整端点是很自然的事，不该为此报错。
        assert_eq!(
            chat_url("https://api.deepseek.com/v1/chat/completions").unwrap(),
            "https://api.deepseek.com/v1/chat/completions"
        );
        // 本地 Ollama。
        assert_eq!(
            chat_url("http://127.0.0.1:11434/v1").unwrap(),
            "http://127.0.0.1:11434/v1/chat/completions"
        );

        for bad in [
            "",
            "api.deepseek.com/v1",
            "ftp://example.com/v1",
            "file:///c:/keys.txt",
            "https://",
        ] {
            assert!(chat_url(bad).is_err(), "{bad:?} 被当成了合法地址");
        }
    }

    /// **这三条是唯一能在没有密钥的情况下验证的降级路径。**
    ///
    /// 尤其是「解不开」——它最容易被某次改动悄悄并进「没配」里，
    /// 而两者的界面文案完全不同，用户要做的事也不同。
    #[test]
    fn 不该发的情况都被挡住了() {
        let missing = Config::default();
        assert_eq!(blocked(&missing), Some("未配置 API key"));

        let broken = Config {
            api_key: ApiKey::Broken,
            ..Config::default()
        };
        assert_eq!(blocked(&broken), Some("存的 API key 解不开了"));

        let blank = Config {
            api_key: ApiKey::Ready("   ".into()),
            ..Config::default()
        };
        assert_eq!(blocked(&blank), Some("未配置 API key"));

        let bad_url = Config {
            base_url: "不是网址".into(),
            api_key: ApiKey::Ready("sk-x".into()),
            ..Config::default()
        };
        assert_eq!(blocked(&bad_url), Some("接口地址不是合法的 http(s) 地址"));

        // 配齐了就放行。
        let ok = Config {
            api_key: ApiKey::Ready("sk-x".into()),
            ..Config::default()
        };
        assert_eq!(blocked(&ok), None);
    }

    /// 每一条降级原因都在封闭集合里。**加新的原因必须同时加进 `REASONS`**——
    /// 否则那句话会绕开这份清单直接上屏，而这份清单是唯一能一眼看全
    /// 「用户可能读到哪些话」的地方。
    #[test]
    fn 降级原因都在封闭集合里() {
        for why in [
            "未配置 API key",
            "存的 API key 解不开了",
            "接口地址不是合法的 http(s) 地址",
            "连接超时（10 秒）",
            "请求超时（30 秒）",
            "无法连接",
            "连接被重置",
            "证书校验失败",
            "响应不是合法的 JSON",
            "响应里没有正文",
            "模型返回了空正文",
            "响应过长（超过 64 KB）",
            "请求失败",
        ] {
            assert!(REASONS.contains(&why), "「{why}」不在封闭集合里");
        }
        // 状态码那条是带参数的，单独核一遍格式。
        assert!(status_reason(401).starts_with("服务返回 401"));
        assert!(status_reason(503).contains("对面服务出错"));
        // 不认识的码也要落在同一句话里。
        assert!(status_reason(302).starts_with("服务返回 302"));
    }

    /// 响应解析：多一个字段不该崩，少一个字段就该降级。
    #[test]
    fn 从响应里取正文() {
        let ok: serde_json::Value = serde_json::json!({
            "id": "x", "model": "deepseek-chat", "usage": { "total_tokens": 900 },
            "choices": [ { "index": 0, "finish_reason": "stop",
                           "message": { "role": "assistant", "content": "  这一期你敲了很多。  " } } ]
        });
        assert_eq!(extract_content(&ok).unwrap(), "这一期你敲了很多。");

        // 空正文和没有正文是两种情况：前者是模型的问题，后者是接口形状的问题。
        let empty = serde_json::json!({ "choices": [ { "message": { "content": "   " } } ] });
        assert_eq!(extract_content(&empty), Err("模型返回了空正文"));

        let no_message = serde_json::json!({ "choices": [ { "index": 0 } ] });
        assert_eq!(extract_content(&no_message), Err("响应里没有正文"));

        let no_choices = serde_json::json!({ "error": { "message": "invalid key" } });
        assert_eq!(extract_content(&no_choices), Err("响应里没有正文"));

        // content 不是字符串（有的接口会回一个分段数组）：也算没有正文，
        // 不能 panic，也不能把整个数组塞进正文。
        let array_content = serde_json::json!({
            "choices": [ { "message": { "content": [ { "type": "text", "text": "hi" } ] } } ]
        });
        assert_eq!(extract_content(&array_content), Err("响应里没有正文"));
    }

    /// 请求体里只有清单，没有别的东西。
    #[test]
    fn 请求体只带清单和提示词() {
        let p = payload("deepseek-chat", "期间：2026 年第 39 周");
        assert_eq!(p["model"], "deepseek-chat");
        assert_eq!(p["stream"], false);
        assert_eq!(p["max_tokens"], 1200);
        assert_eq!(p["messages"][0]["role"], "system");
        assert_eq!(p["messages"][1]["content"], "期间：2026 年第 39 周");
        // 提示词得真的在里头。
        assert!(p["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("不要做任何加减乘除"));
    }

    /// 降级写的正文，必须和直接渲染模板一字不差。
    ///
    /// 「降级」只能有一种样子。要是这里另写一份，那么「断网时看到的报告」
    /// 和「界面上那张清单」就开始各说各话了——而这正是这个功能最不能出的事。
    #[test]
    fn 降级正文就是模板正文() {
        let facts = crate::report::fixtures::有字数();
        let w = fallback(&facts, "未配置 API key");
        assert_eq!(w.body, text::render_template(&facts));
        assert_eq!(w.source, Source::Template);
        assert_eq!(w.source.as_str(), "template");
        assert_eq!(w.model, None, "降级了却还挂着模型名");
        assert_eq!(w.note.as_deref(), Some("未配置 API key"));
    }
}
