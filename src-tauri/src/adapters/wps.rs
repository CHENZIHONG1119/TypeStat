//! 把 WPS 加载项装进 WPS，以及把两份适配器的文件存出来给人手动装。
//!
//! ## 为什么这件事在程序里做，而不是在一个 Node 脚本里
//!
//! 原来它是 `wps-addon/install.mjs`：跑起来先打开 TypeStat 的数据库，从 `settings`
//! 表里把 `adapter_port` 和 `adapter_token` 读出来，填进 `js/config.js`，再复制文件、
//! 登记 `publish.xml`。**那两步「读库」是在绕路**——端口和令牌本来就是程序启动时
//! 生成、此刻正拿在手里的东西。绕这一圈的代价有三样：
//!
//! 1. 用户要装 Node（而且得是 22.5+，`node:sqlite` 的版本），要找到加载项的目录，
//!    要在那儿开一个终端。装完还得自己抄端口和令牌去核对。
//! 2. 安装包里**根本没有** `wps-addon/` 这个目录，所以从 Releases 装了 TypeStat 的人
//!    照着文档是做不到的。把文件编进二进制，这件事就不依赖安装包带了什么。
//! 3. 同一件事有两份实现（脚本一份、程序一份），`publish.xml` 的合并规则会各改各的。
//!    这个项目里凡是「两处拼同一个东西」的地方最后都分叉过。
//!
//! 所以脚本删了，只留这一份。`wps-addon/` 目录仍然在仓库里，它是**加载项的源码**——
//! 改它、测它（`wps-addon/test/`）都要在那个目录里做；`include_str!` 会在编译期
//! 把它读进来，所以**改了源文件不重新编译，装出来的还是旧的**。
//!
//! ## 装到哪儿
//!
//! `%APPDATA%\kingsoft\wps\jsaddons\TypeStat_1.0.0\`，并在同级的 `publish.xml` 里
//! 登记一条。目录结构、`publish.xml` 的字段、以及 `<名字>_<版本>` 这个命名约定，
//! 都取自 WPS 官方脚手架（`wpsjs` 包的 `src/lib/build.js` 里的 `CreateCopyBat` /
//! `CreatePublishXml`），不是猜的。要改这里的机制，先回去核对那个文件。
//!
//! ## 这里刻意不碰什么
//!
//! **不碰 WPS 的安装目录。** 功能区里没有「TypeStat」选项卡时，唯一的路是在
//! `office6\cfgs\oem.ini` 里加 `JsApiPlugin=true`，而那个文件是签名过的 OEM 配置，
//! 改它有风险、还要管理员权限。程序只把这件事**说出来**（界面上那段），不替用户做。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// 加载项在 WPS 那边的名字和版本。`<名字>_<版本>` 是文件夹名，也是 `publish.xml`
/// 里那条记录的主键——**改版本号等于让 WPS 认成另一个加载项**，旧的那个文件夹
/// 还留在那儿，两个会同时被加载，同一次改动被上报两遍。
const NAME: &str = "TypeStat";
const VERSION: &str = "1.0.0";

/// 装进 WPS 要写过去的文件：`(相对路径, 内容)`。
///
/// 内容走 `include_str!`，路径写错**编译就过不去**——这张表和 `wps-addon/` 里
/// 实际有什么，不可能对不上。这是选 `include_str!` 而不是「运行时去资源目录里找」
/// 的主要原因：后者要处理「开发时资源目录是 `target\debug`」这类分支，而漏掉一个
/// 文件的表现是**装完的加载项少一个 js 文件**，报的错在 WPS 那边。
///
/// `config.example.js` 也装过去：它是那份模板，字段的含义写在它自己的注释里，
/// 用户去 `jsaddons` 目录里翻的时候能看到「这两个值是什么」。
const PAYLOAD: &[(&str, &str)] = &[
    ("manifest.xml", include_str!("../../../wps-addon/manifest.xml")),
    ("ribbon.xml", include_str!("../../../wps-addon/ribbon.xml")),
    ("index.html", include_str!("../../../wps-addon/index.html")),
    ("main.js", include_str!("../../../wps-addon/main.js")),
    (
        "js/config.example.js",
        include_str!("../../../wps-addon/js/config.example.js"),
    ),
    ("js/reporter.js", include_str!("../../../wps-addon/js/reporter.js")),
    ("js/ribbon.js", include_str!("../../../wps-addon/js/ribbon.js")),
    ("ui/status.html", include_str!("../../../wps-addon/ui/status.html")),
    ("ui/status.js", include_str!("../../../wps-addon/ui/status.js")),
];

/// Obsidian 插件就两个文件。它没法一键装：装到哪儿取决于**用户的库在哪儿**，
/// 而程序不知道那个路径——只能把文件交出去，让他自己放进 `.obsidian/plugins/typestat`。
const OBSIDIAN_PAYLOAD: &[(&str, &str)] = &[
    ("main.js", include_str!("../../../obsidian-plugin/main.js")),
    ("manifest.json", include_str!("../../../obsidian-plugin/manifest.json")),
];

/// 加载项的完整说明。**只跟着「存出插件文件」走，不装进 WPS 的目录里**——
/// WPS 不需要读一个 17 KB 的中文文档，而 `jsaddons` 目录里多出来的东西
/// 将来排查「到底加载了哪些文件」时会碍事。
const ADDON_README: &str = include_str!("../../../wps-addon/README.md");

/// `config.js` 里真正会被写进去的那两行。写和读都用这两个前缀——
/// 分开写两遍的话，「写进去的」和「读出来的」会各自演化，而表现是状态栏说
/// 「令牌是新的」而加载项其实还在用旧的。
const PORT_KEY: &str = "port:";
const TOKEN_KEY: &str = "token:";

/// 标记一行的开始，用来判断「这行是不是我们要填的那行」。
fn placeholder_line(line: &str, key: &str, placeholder: &str) -> bool {
    let t = line.trim_start();
    t.starts_with(key) && t.contains(placeholder)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    /// 装到了哪个文件夹。
    pub dir: String,
    /// 写出来的 `config.js`（里面是这次的端口和令牌）。
    pub config_path: String,
    pub publish_path: String,
    /// `publish.xml` 这次是「新建」「追加」还是「更新已有条目」。
    pub publish_action: String,
    /// 一共写了几个文件。
    pub files: usize,
    /// 这次写进去的端口。接收端没起来时填的是兜底的 42180。
    pub port: u16,
    /// 接收端此刻没在监听——加载项装得上，但连不上。
    pub receiver_down: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonStatus {
    /// 加载项目录在不在。
    pub installed: bool,
    pub dir: String,
    /// 装过，但 `config.js` 里的令牌和现在这个对不上（多半是在界面里重新生成过）。
    /// 那时加载项上报会被拒（401），而表现是「字数一直是 0」。
    pub token_stale: bool,
    /// 装过，但文件不全（有人手动删过东西，或者装到一半失败了）。
    pub files_missing: Vec<String>,
    /// 判断这件事本身就做不成的原因（读不到 `%APPDATA%`）。`None` 是正常情况。
    /// **不合并进 `files_missing`**：那一栏会被界面印成「缺这几个文件」，
    /// 而「读不到环境变量」不是缺文件。
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonFiles {
    pub dir: String,
    /// 写出来的每一个文件。界面只说个数，但要能数得清。
    pub files: Vec<String>,
}

/// `%APPDATA%\kingsoft\wps\jsaddons`。
///
/// 取不到 `%APPDATA%` 就直接说清楚——这个 crate 只在 Windows 上编译
/// （`src/` 里没有一处 `cfg(not(windows))`），所以这是「环境变量被人清掉了」，
/// 不是移植性问题。
pub fn jsaddons_dir() -> Result<PathBuf, String> {
    let appdata = std::env::var_os("APPDATA").ok_or("读不到 %APPDATA% 环境变量")?;
    Ok(Path::new(&appdata).join("kingsoft").join("wps").join("jsaddons"))
}

fn folder_name() -> String {
    format!("{NAME}_{VERSION}")
}

fn dest_dir() -> Result<PathBuf, String> {
    Ok(jsaddons_dir()?.join(folder_name()))
}

/// 把端口和令牌填进模板。
///
/// 锚在**行首的 `port:` / `token:`** 上，而不是裸替换 `__PORT__`：模板的注释里
/// 提到过这两个占位符（「还写着 __ 包起来的下划线占位符」），裸替换会把说明文字
/// 一起改掉，读起来就成了「端口是 42180 包起来的下划线占位符」。
///
/// 接模板当参数是为了能测「模板被改坏」那条路——真模板永远是好的，
/// 而这段代码要防的恰恰是它哪天不好了。
fn fill_template(template: &str, port: u16, token: &str) -> Result<String, String> {
    let mut out = String::with_capacity(template.len() + 64);
    let mut filled_port = false;
    let mut filled_token = false;

    for line in template.lines() {
        if !filled_port && placeholder_line(line, PORT_KEY, "__PORT__") {
            out.push_str(&line.replace("__PORT__", &port.to_string()));
            filled_port = true;
        } else if !filled_token && placeholder_line(line, TOKEN_KEY, "__TOKEN__") {
            out.push_str(&line.replace("__TOKEN__", token));
            filled_token = true;
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }

    // 替换没生效说明模板被改坏了。那时写出去的是一个**语法错误的 config.js**，
    // 而 WPS 加载项报的错是「TYPESTAT_CONFIG is not defined」，离真正的原因
    // 隔了好几层——在这里拦住。宁可这里报错，也不要装出一个连不上的加载项：
    // 「连不上」在界面上和「今天没写字」长得一模一样。
    if !filled_port || !filled_token {
        return Err(format!(
            "加载项模板里的占位符没了（端口 {}、令牌 {}），js/config.example.js 可能被改坏了，安装中止。",
            if filled_port { "已填" } else { "没找到" },
            if filled_token { "已填" } else { "没找到" },
        ));
    }
    Ok(out)
}

/// 用仓库里的真模板生成 `config.js`。
pub fn render_config(port: u16, token: &str) -> Result<String, String> {
    let template = PAYLOAD
        .iter()
        .find(|(p, _)| *p == "js/config.example.js")
        .map(|(_, c)| *c)
        .ok_or("加载项模板缺失（js/config.example.js 不在 PAYLOAD 里）")?;
    fill_template(template, port, token)
}

/// 从写好的 `config.js` 里把令牌读回来，用来判断「装的那份是不是旧令牌」。
///
/// 和 `fill_template` 共用 `PORT_KEY` / `TOKEN_KEY`。**写→读的往返有一条测试守着**：
/// 谁改了写的那边而没改读的这边，测试会红。
pub fn read_token(src: &str) -> Option<String> {
    for line in src.lines() {
        let t = line.trim_start();
        if !t.starts_with(TOKEN_KEY) {
            continue;
        }
        let v = t[TOKEN_KEY.len()..].trim_start();
        // 模板里这一行的完整形状是 `token: "__TOKEN__",`——**行尾有逗号**。
        // 早先这里只把两端的引号剪掉，剪完剩下 `abc123",`，和现生成的那个永远
        // 不等：`status()` 会一直报「装的那份是旧令牌」，把人赶去重装一个本来
        // 就装对了的加载项。带上引号时按引号取，没引号时按逗号/分号断，
        // 两条路都得把行尾那个标点去掉。
        let value = if let Some(rest) = v.strip_prefix('"') {
            rest.split('"').next().unwrap_or(rest)
        } else if let Some(rest) = v.strip_prefix('\'') {
            rest.split('\'').next().unwrap_or(rest)
        } else {
            v.trim_end_matches([',', ';']).trim_end()
        };
        return Some(value.to_string());
    }
    None
}

/// 在 `publish.xml` 里登记一条 —— **合并，不是覆盖**。
///
/// 机器上可能还装着别的加载项，把文件写成只有我这一条会把别人登记的东西一并抹掉。
/// 三种情况分别返回不同的动作名，界面要把它印出来：这件事动的是 WPS 的配置文件，
/// 用户有权知道这次到底是新建了、追加了，还是改掉了已有的一条。
///
/// **认不出来就不碰。** 文件存在但不含 `<jsplugins>`（WPS 换了写法、或者这不是它），
/// 报错走人——把别人的配置覆盖成我们的，代价比装不上大得多。
pub fn upsert_publish(existing: &str, entry: &str) -> Result<(String, &'static str), String> {
    if existing.trim().is_empty() {
        return Ok((format!("<jsplugins>\n{entry}\n</jsplugins>\n"), "新建"));
    }
    if !existing.contains("<jsplugins") || !existing.contains("</jsplugins>") {
        return Err("publish.xml 里找不到 <jsplugins>…</jsplugins>，格式不认识，没有动它。".into());
    }

    // 已经有同名条目：整条替换（版本号或 url 可能变了）。逐行扫，不为了这一处
    // 引入正则依赖。缩进沿用原来那一行，否则改过一次之后它和相邻条目对不齐。
    let mut hit = false;
    let mut lines: Vec<String> = Vec::new();
    for line in existing.lines() {
        let t = line.trim_start();
        let mine = t.starts_with("<jsplugin")
            && t.contains(&format!("name=\"{NAME}\""))
            && t.ends_with("/>");
        if !hit && mine {
            hit = true;
            let indent = &line[..line.len() - t.len()];
            lines.push(format!("{indent}{}", entry.trim_start()));
        } else {
            lines.push(line.to_string());
        }
    }
    if hit {
        return Ok((format!("{}\n", lines.join("\n")), "更新已有条目"));
    }

    let mut out = existing.replace("</jsplugins>", &format!("{entry}\n</jsplugins>"));
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok((out, "追加"))
}

/// `publish.xml` 里我们那一条。缩进照抄脚手架生成的那一份（四个空格叠三层），
/// 这样它是追加进去的时候和别人的条目长得一样。
fn publish_entry() -> String {
    format!(
        "            <jsplugin name=\"{NAME}\" type=\"wps\" url=\"{}\" version=\"{VERSION}\" \
enable=\"enable_dev\" install=\"null\" customDomain=\"\"/>",
        folder_name()
    )
}

/// 把加载项装进 WPS。
///
/// 可重复执行：改完令牌再点一次就行。**会先整份删掉目标文件夹**——它是我们自己
/// 命名的（`TypeStat_1.0.0`），里面只该有我们写进去的东西；不删的话，上一版里有、
/// 这一版里没有的文件会留下来继续被加载。
pub fn install(token: &str, port: Option<u16>) -> Result<InstallResult, String> {
    let jsaddons = jsaddons_dir()?;
    let dest = jsaddons.join(folder_name());
    // 接收端没起来时不能编一个假端口混过去：加载项会一直连不上，而界面上
    // 「字数一直是 0」和「今天没写字」长得一样。用兜底的 42180 写进去，
    // 同时把 `receiver_down` 交给界面，让它把这件事说出来。
    let effective_port = port.unwrap_or(42180);

    fs::create_dir_all(&jsaddons).map_err(|e| format!("建不了 {}：{e}", jsaddons.display()))?;
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("清不掉旧目录 {}：{e}", dest.display()))?;
    }

    let mut files = 0usize;
    for (rel, content) in PAYLOAD {
        let path = dest.join(rel);
        write_into(&path, content)?;
        files += 1;
    }

    // `config.js` 要在 `config.example.js` 之后写。同一个目录里两个名字，
    // 顺序反了就会被模板盖掉——那是最难查的那种错：装完看着文件都在，
    // 加载项却报「配置里是占位符」。
    let config = dest.join("js").join("config.js");
    write_into(&config, &render_config(effective_port, token)?)?;
    files += 1;

    let publish_path = jsaddons.join("publish.xml");
    let existing = fs::read_to_string(&publish_path).unwrap_or_default();
    let (merged, action) = upsert_publish(&existing, &publish_entry())?;
    fs::write(&publish_path, merged).map_err(|e| format!("写不进 {}：{e}", publish_path.display()))?;

    Ok(InstallResult {
        dir: dest.display().to_string(),
        config_path: config.display().to_string(),
        publish_path: publish_path.display().to_string(),
        publish_action: action.to_string(),
        files,
        port: effective_port,
        receiver_down: port.is_none(),
    })
}

/// 现在装着的那一份是什么状态。**只读**，不写任何东西。
pub fn status(token: &str) -> AddonStatus {
    let dest = match dest_dir() {
        Ok(d) => d,
        Err(e) => {
            return AddonStatus {
                installed: false,
                dir: String::new(),
                token_stale: false,
                files_missing: Vec::new(),
                note: Some(e),
            }
        }
    };

    let mut missing: Vec<String> = PAYLOAD
        .iter()
        .map(|(rel, _)| rel.to_string())
        .filter(|rel| !dest.join(rel).exists())
        .collect();

    let config = dest.join("js").join("config.js");
    let token_stale = match fs::read_to_string(&config) {
        Ok(src) => match read_token(&src) {
            Some(t) => t != token,
            // 有 config.js 却读不出令牌：那是它被手改过。当作旧的处理，
            // 让用户重装一次——**这一路比谎报「一致」安全**，谎报的表现是
            // 「界面说好好的、上报一直被拒」。
            None => true,
        },
        Err(_) => {
            missing.push("js/config.js".to_string());
            // 读不到配置文件时「令牌是不是旧的」无从谈起。给 `false`，
            // 让「文件不全」那一条去说这件事——两个字段说同一件事只会互相打脸。
            false
        }
    };

    AddonStatus {
        installed: dest.exists(),
        dir: dest.display().to_string(),
        token_stale,
        files_missing: missing,
        note: None,
    }
}

/// 把两份适配器的文件存到一个文件夹里，给人手动装。
///
/// WPS 那条路一键就能走完（`install`），这个函数是**给不想让程序往 AppData 里
/// 写字的人**和 Obsidian 用的。和导出数据不同，这里**允许覆盖**：目标文件夹是
/// 我们自己命名的（`适配器\`），里面装的是程序自带的固定内容、不是用户的数据——
/// 留下一个 `main-2.js` 只会让人不知道该用哪一个。
///
/// **存出来的 `config.js` 是模板，端口和令牌还是占位符。** 令牌不写进任何落盘的
/// 文件（除非用户自己抄）：这台机器上的令牌不该因为「存一份给别人看」而多出一个副本。
/// 手动装的时候把 `config.example.js` 复制成 `config.js`，两个值在界面那一页
/// 都能复制到。
pub fn export_files(dir: &Path) -> Result<AddonFiles, String> {
    let mut files = Vec::new();
    let wps = dir.join("wps-addon");
    let obsidian = dir.join("obsidian-plugin");

    for (rel, content) in PAYLOAD {
        let path = wps.join(rel);
        write_into(&path, content)?;
        files.push(path.display().to_string());
    }
    let readme = wps.join("README.md");
    write_into(&readme, ADDON_README)?;
    files.push(readme.display().to_string());

    for (rel, content) in OBSIDIAN_PAYLOAD {
        let path = obsidian.join(rel);
        write_into(&path, content)?;
        files.push(path.display().to_string());
    }

    Ok(AddonFiles {
        dir: dir.display().to_string(),
        files,
    })
}

fn write_into(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建不了 {}：{e}", parent.display()))?;
    }
    fs::write(path, content).map_err(|e| format!("写不进 {}：{e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template() -> &'static str {
        PAYLOAD
            .iter()
            .find(|(p, _)| *p == "js/config.example.js")
            .map(|(_, c)| *c)
            .unwrap()
    }

    /// 模板里那两行确实会被填掉，而且**别的行一个字都不动**。
    #[test]
    fn 配置模板填得进去() {
        let out = fill_template(template(), 43721, "tst_deadbeefdeadbeef").unwrap();
        assert!(out.contains("port: 43721"), "端口没填：{out}");
        assert!(out.contains(r#"token: "tst_deadbeefdeadbeef""#), "令牌没填：{out}");
        // 注释里那句「还写着 __ 包起来的下划线占位符」必须原样留着——
        // 裸替换会把它改成「还写着 43721 包起来的下划线占位符」。
        assert!(out.contains("还写着 __ 包起来的下划线占位符"), "注释被改掉了：{out}");
    }

    /// 写进去的必须读得回来。这条守的是「写」和「读」两处**共用常量**这件事：
    /// 谁把 `TOKEN_KEY` 改坏而没改另一边，这里会红。
    #[test]
    fn 写进去的令牌读得回来() {
        let out = fill_template(template(), 42180, "tst_abc123").unwrap();
        assert_eq!(read_token(&out).as_deref(), Some("tst_abc123"));
    }

    /// 用户手改过的那份也要读得出来：不带引号、行尾是分号，这两种写法都有人用。
    /// 读不出来的表现不是报错，是**界面一口咬定「你装的这份是旧令牌」**，
    /// 于是人跑去重装一个本来就装对了的加载项。宽容度要钉在这里。
    #[test]
    fn 手写的令牌也读得回来() {
        assert_eq!(read_token("  token: tst_abc123,\n").as_deref(), Some("tst_abc123"));
        assert_eq!(read_token("\ttoken: 'tst_abc123';\n").as_deref(), Some("tst_abc123"));
        // 注释里出现这个词不算——认不出来就得说认不出来，猜一个错令牌当真令牌比，
        // 结果比不读还糟。
        assert_eq!(read_token("  // token: 这是注释\n"), None);
        assert_eq!(read_token("  app: \"wps.exe\",\n"), None);
    }

    /// 模板被改坏时**要报错，不能装出一个连不上的加载项**。
    #[test]
    fn 模板占位符没了就不装() {
        let broken = template().replace("__TOKEN__", "把令牌填在这里");
        let r = fill_template(&broken, 42180, "tst_abc123");
        assert!(r.is_err(), "占位符没了却照样装：{r:?}");
        // 报错要说清是哪一边没了——两边都缺和只缺一边，去修的地方不一样。
        let msg = r.unwrap_err();
        assert!(msg.contains("没找到"), "{msg}");
    }

    /// 机器上一条加载项都没登记过。
    #[test]
    fn publish_从无到有() {
        let (out, action) = upsert_publish("", &publish_entry()).unwrap();
        assert_eq!(action, "新建");
        assert!(out.starts_with("<jsplugins>"));
        assert!(out.contains("name=\"TypeStat\""));
        assert!(out.ends_with("</jsplugins>\n"));
    }

    /// 已经有别的加载项登记着——**不能被我们挤掉**。
    #[test]
    fn publish_追加不挤掉别人的() {
        let existing =
            "<jsplugins>\n  <jsplugin name=\"别人的\" url=\"other\" version=\"1\"/>\n</jsplugins>\n";
        let (out, action) = upsert_publish(existing, &publish_entry()).unwrap();
        assert_eq!(action, "追加");
        assert!(out.contains("name=\"别人的\""), "别人的条目被抹掉了：{out}");
        assert!(out.contains("name=\"TypeStat\""));
    }

    /// 已经有我们这一条（上一版装的）——整条替换，不是再追加一条。
    #[test]
    fn publish_替换自己那一条() {
        let existing = "<jsplugins>\n            <jsplugin name=\"TypeStat\" type=\"wps\" url=\"TypeStat_0.9.0\" version=\"0.9.0\" enable=\"enable_dev\" install=\"null\" customDomain=\"\"/>\n</jsplugins>\n";
        let (out, action) = upsert_publish(existing, &publish_entry()).unwrap();
        assert_eq!(action, "更新已有条目");
        assert!(!out.contains("TypeStat_0.9.0"), "旧条目还在：{out}");
        assert_eq!(out.matches("name=\"TypeStat\"").count(), 1, "留下两条：{out}");
    }

    /// 同名条目在中间时，缩进要跟着原来那一行走——不然改过一次之后
    /// `publish.xml` 里那一条就和相邻的对不齐了。
    #[test]
    fn publish_替换时沿用原来的缩进() {
        let existing =
            "<jsplugins>\n\t<jsplugin name=\"TypeStat\" url=\"x\" version=\"1\"/>\n</jsplugins>\n";
        let (out, _) = upsert_publish(existing, &publish_entry()).unwrap();
        assert!(out.contains("\n\t<jsplugin name=\"TypeStat\""), "缩进没跟过来：{out}");
    }

    /// 格式不认识时**不许动那个文件**：覆盖掉别人的配置，代价比装不上大得多。
    #[test]
    fn publish_认不出来就不碰() {
        for bad in [
            "<somethingelse><jsplugin name=\"别的\"/></somethingelse>",
            // 有开标签没闭标签：也是认不出来。
            "<jsplugins>\n  <jsplugin name=\"别的\"/>\n",
        ] {
            assert!(upsert_publish(bad, &publish_entry()).is_err(), "改了它：{bad}");
        }
    }

    /// `PAYLOAD` 里每个文件都得有内容：`include_str!` 读到一个空文件不报错，
    /// 装过去之后 WPS 那边会一声不响地不加载——那是最难查的一种「没反应」。
    #[test]
    fn 加载项文件一个都不能空() {
        for (rel, content) in PAYLOAD {
            assert!(!content.trim().is_empty(), "{rel} 是空的");
        }
        for (rel, content) in OBSIDIAN_PAYLOAD {
            assert!(!content.trim().is_empty(), "obsidian 的 {rel} 是空的");
        }
        assert!(!ADDON_README.trim().is_empty(), "说明文档是空的");
        // 路径要和文件真正所在的位置对得上（`files_missing` 会把它们印给用户看）。
        let all: Vec<&str> = PAYLOAD.iter().map(|(p, _)| *p).collect();
        assert!(all.contains(&"js/reporter.js"));
        assert!(all.contains(&"ui/status.js"));
        assert!(all.contains(&"manifest.xml"));
    }
}
