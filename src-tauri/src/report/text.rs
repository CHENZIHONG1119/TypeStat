//! 把数字渲染成中文。
//!
//! 两个出口，吃的是同一份 [`ReportFacts`]：
//!
//! - [`render_sheet`]：「清单」，原样喂给模型，也存进库当审计底稿。
//! - [`render_template`]：本地降级正文。模型调不通时写的就是它。
//!
//! **两者必须说同样的话。** 清单是模型看见的世界，模板是断网时用户看见的世界；
//! 它们要是对同一件事有两种说法，那「换本地模板」就成了一次静默的换源。
//! [`tests::模板里的数字都能在清单里找到`] 和
//! [`tests::模板里的比例都能在清单里找到`] 就是拿字符串对字符串在守这条线。
//!
//! 这里不碰网络，也不碰数据库——纯字符串进、纯字符串出，所以它能被单独测。

use super::{AppFacts, ReportFacts};

/// 千分位。3221 → `3,221`。
///
/// 数字连着四五位时，「24381」和「2438l」在屏幕上是分不清的，
/// 而这个功能整个的价值就在于数字可信。
fn n(v: i64) -> String {
    let neg = v < 0;
    let digits = v.abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if neg {
        format!("-{out}")
    } else {
        out
    }
}

/// 分钟数变成「9 小时 42 分」。不足一小时只写分。
fn dur(minutes: i64) -> String {
    let h = minutes / 60;
    let m = minutes % 60;
    if h > 0 {
        format!("{h} 小时 {m} 分")
    } else {
        format!("{m} 分")
    }
}

/// 比例。固定一位小数：一会儿 `4.9%` 一会儿 `83%` 会让两个数看起来不是一个量级。
fn pct(v: f64) -> String {
    format!("{:.1}%", v * 100.0)
}

fn per_min(v: f64, unit: &str) -> String {
    format!("{:.1} {unit} / 分", v)
}

/// 这一期有没有打字。「在打字」只算敲入和删除，和 `db::typing_spans` 同一把尺子——
/// 只按了 Ctrl+S 的一周不算写过东西。
pub fn has_typing(f: &ReportFacts) -> bool {
    f.key_input > 0 || f.key_delete > 0
}

/// 渲染喂给模型的清单。
///
/// **不要直接把 JSON 丢给模型。** 那样它会把 `0.8234` 写成 `0.8%`、把「次」和「字」
/// 放进同一个比较里、或者顺手把 `null` 变成 0。这里预先渲染成中文，
/// 每一行都是「数字 + 单位 + 算式」连在一起的一个字符串——
/// 模型的任务于是被压缩成组织语言，没有算术可做。
///
/// **凡是带 `%` 的行都带算式**（`（… ÷ …）`）：这样正文里出现一个比例时，
/// 它是怎么来的、能不能核对，在清单里当场就写着。
pub fn render_sheet(f: &ReportFacts) -> String {
    let mut s = String::new();
    s.push_str(&format!("期间：{}（{}），已结束\n", f.heading, f.range_text));

    if !has_typing(f) {
        s.push_str("\n这一期没有任何打字记录：没有敲入或删除过字符。\n");
        if f.key_other > 0 {
            s.push_str(&format!(
                "只按过 {} 次其他按键（方向键、快捷键等），它们产生不了字符。\n",
                n(f.key_other)
            ));
        }
        return s;
    }

    s.push_str("\n【按键】\n");
    s.push_str(&format!("敲入按键：{} 次\n", n(f.key_input)));
    s.push_str(&format!("退格：{} 次\n", n(f.key_delete)));
    if let Some(r) = f.key_delete_rate {
        s.push_str(&format!(
            "退格率：{}（退格次数 {} ÷ 敲入按键 {}）\n",
            pct(r),
            n(f.key_delete),
            n(f.key_input)
        ));
    }
    s.push_str(&format!(
        "其他按键（方向键、快捷键等，产生不了字符）：{} 次\n",
        n(f.key_other)
    ));

    s.push_str("\n【字数】\n");
    match (f.char_input, f.char_delete, f.net_chars) {
        (Some(ci), Some(cd), Some(net)) => {
            s.push_str(&format!("敲入字数：{} 字（只有装了适配器的应用报得上来）\n", n(ci)));
            s.push_str(&format!("删除字数：{} 字\n", n(cd)));
            s.push_str(&format!(
                "净字数：{} 字（敲入字数 {} − 删除字数 {}）\n",
                n(net),
                n(ci),
                n(cd)
            ));
            if let Some(r) = f.char_delete_rate {
                s.push_str(&format!(
                    "字数删除率：{}（删除字数 {} ÷ 敲入字数 {}）\n",
                    pct(r),
                    n(cd),
                    n(ci)
                ));
            }
            if let Some(cov) = f.coverage {
                s.push_str(&format!(
                    "字数覆盖率：{}（有字数的按键数 {} ÷ 敲入按键 {}）\n",
                    pct(cov),
                    n(f.char_key_input),
                    n(f.key_input)
                ));
            }
        }
        // 整块替换，不是留空也不是写 0：这一期就没有「字数」这件事。
        _ => s.push_str("字数：量不到。这一期没有任何应用上报精确字数。\n"),
    }

    s.push_str("\n【时长】\n");
    s.push_str(&format!(
        "坐下时长：{}（相邻两次输入间隔不超过 5 分钟算同一段，段内空隙也计入）\n",
        dur(f.session_minutes)
    ));
    s.push_str(&format!(
        "真正在敲：{}（{} 分钟，有按键的分钟数，一分钟内敲一下也算一分钟）\n",
        dur(f.active_minutes),
        n(f.active_minutes)
    ));
    s.push_str(&format!("最长的一段：{}\n", dur(f.longest_minutes)));
    if let Some(v) = f.keys_per_minute {
        s.push_str(&format!(
            "按键速度：{}（敲入按键 {} ÷ 真正在敲 {} 分钟）\n",
            per_min(v, "键"),
            n(f.key_input),
            n(f.active_minutes)
        ));
    }
    // 分子跟 `char_input` 绑在一起取：真出现「有速度但没字数」这种自相矛盾时，
    // 少打一行，而不是打出一个 `字数 0`。0 和「量不到」的界线就是这么被踩过去的。
    if let (Some(v), Some(ci)) = (f.chars_per_minute, f.char_input) {
        s.push_str(&format!(
            "字数速度：{}（敲入字数 {} ÷ 有字数的 {} 分钟）\n",
            per_min(v, "字"),
            n(ci),
            n(f.precise_minutes)
        ));
    }

    s.push_str("\n【记录】\n");
    s.push_str(&format!(
        "有记录的天数：{} 天（这一期共 {} 天）\n",
        n(f.active_days),
        n(f.period_days)
    ));
    if f.bogus_days > 0 {
        s.push_str(&format!(
            "字数大于按键数的天数：{} 天（不可能——一个字至少要按一次键，属适配器虚报，那几天的数字不可信）\n",
            n(f.bogus_days)
        ));
    }

    if !f.days.is_empty() {
        s.push_str("\n【按天】每天的敲入按键数\n");
        for d in &f.days {
            s.push_str(&format!("{} {}：{} 次\n", d.day, d.weekday, n(d.key_input)));
        }
    }

    if !f.hours.is_empty() {
        // 24 个数按 0–23 时依次排开。**0 也是真的 0**，所以一个都不能省——
        // 省掉的那几个小时，模型会自己解释成「你上午不工作」，
        // 而事实可能只是那几行数据不在这一期里。
        let counts: Vec<String> = f.hours.iter().map(|h| n(h.key_input)).collect();
        s.push_str(&format!(
            "\n【按小时】0 到 23 时依次的敲入按键数（共 {} 个数，按小时顺序排列）：{}\n",
            counts.len(),
            counts.join(" ")
        ));
        if let Some(h) = f.busiest_hour {
            s.push_str(&format!("最忙的一小时：{} 时，{} 次\n", h, n(f.busiest_hour_keys)));
        }
    }

    if !f.apps.is_empty() {
        s.push_str(&format!(
            "\n【应用】按敲入按键数从多到少，共 {} 个\n",
            n(f.apps_total)
        ));
        for a in &f.apps {
            s.push_str(&format!("{}：{} 次，{}\n", a.app, n(a.key_input), app_chars(a)));
        }
        if f.apps_omitted > 0 {
            s.push_str(&format!(
                "另有 {} 个应用未列出，合计 {} 次\n",
                n(f.apps_omitted),
                n(f.apps_omitted_keys)
            ));
        }
    }

    s
}

/// 一个应用的字数，或者「量不到」。
fn app_chars(a: &AppFacts) -> String {
    match (a.has_char, a.char_input) {
        (true, Some(c)) => format!("字数 {} 字（适配器上报）", n(c)),
        _ => "字数量不到".to_string(),
    }
}

/// 应用名的显示形式：去掉 `.exe`，太长就截断。
///
/// 和前端 `lib/metrics.ts` 的 `shortName` 是同一件事，两边必须一致——
/// 模型写「wps」而屏幕上写着「wps.exe」，正文和界面就开始对不上账了。
/// 截断是为了提示词：`…\WeChat\WeChat.exe` 这种名字进不了结论，只会把清单撑长。
fn short_app(app: &str) -> String {
    let base = app.rsplit(['\\', '/']).next().unwrap_or(app);
    let base = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(base);
    if base.chars().count() > 24 {
        let head: String = base.chars().take(23).collect();
        format!("{head}…")
    } else {
        base.to_string()
    }
}

/// 应用清单里的一行，供调用方拼 facts 时用同一个短名。
pub fn app_display_name(app: &str) -> String {
    short_app(app)
}

/// 本地降级正文。
///
/// 刻意做到：**不鼓励、不评价、不出现事实里没有的数字。**
/// 这个程序量的是「敲了多少」，它不知道你写的是什么，所以它没有资格点评。
///
/// 「量不到」那句是**独立的一段，不是脚注**——它是这一期最需要被知道的事，
/// 埋进括号里就等于没说。
pub fn render_template(f: &ReportFacts) -> String {
    let mut paras: Vec<String> = Vec::new();
    let head = format!("这一期（{}，{}）", f.heading, f.range_text);

    if !has_typing(f) {
        let mut p = format!("{head}没有任何打字记录：没有敲入或删除过字符。");
        if f.key_other > 0 {
            p.push_str(&format!(
                "这一期只按过 {} 次其他按键（方向键、快捷键等），它们产生不了字符。",
                n(f.key_other)
            ));
        }
        return p;
    }

    let mut p1 = format!(
        "{head}有记录的天数 {} 天，其中敲入按键 {} 次，退格 {} 次",
        n(f.active_days),
        n(f.key_input),
        n(f.key_delete)
    );
    if let Some(r) = f.key_delete_rate {
        p1.push_str(&format!("，退格率 {}", pct(r)));
    }
    p1.push_str(&format!("，另有 {} 次其他按键。", n(f.key_other)));
    paras.push(p1);

    let mut p2 = format!(
        "坐下时长 {}，其中真正在敲 {}，最长的一段 {}。",
        dur(f.session_minutes),
        dur(f.active_minutes),
        dur(f.longest_minutes)
    );
    if let Some(v) = f.keys_per_minute {
        p2.push_str(&format!("按键速度 {}。", per_min(v, "键")));
    }
    paras.push(p2);

    match (f.char_input, f.char_delete, f.net_chars) {
        (Some(ci), Some(cd), Some(net)) => {
            let mut p3 = format!("敲入字数 {} 字，删除 {} 字，净字数 {} 字。", n(ci), n(cd), n(net));
            if let Some(cov) = f.coverage {
                p3.push_str(&format!("字数覆盖率 {}。", pct(cov)));
            }
            if let Some(v) = f.chars_per_minute {
                p3.push_str(&format!("字数速度 {}。", per_min(v, "字")));
            }
            paras.push(p3);
        }
        _ => paras.push(
            "这一期的字数量不到：没有任何应用上报精确字数，所以上面只有按键数。".to_string(),
        ),
    }

    // 每天 / 每小时的极值。只在有数据时出现。
    let mut p4 = String::new();
    if let Some(top) = f.days.iter().max_by_key(|d| d.key_input) {
        p4.push_str(&format!("打得最多的一天是 {}，敲入 {} 次。", top.day, n(top.key_input)));
    }
    if let Some(h) = f.busiest_hour {
        p4.push_str(&format!(
            "最忙的一小时是 {} 时，{} 次。",
            h,
            n(f.busiest_hour_keys)
        ));
    }
    if !p4.is_empty() {
        paras.push(p4);
    }

    if !f.apps.is_empty() {
        let listed: Vec<String> = f
            .apps
            .iter()
            .map(|a| format!("{} {} 次（{}）", a.app, n(a.key_input), app_chars(a)))
            .collect();
        let mut p5 = format!(
            "按敲入按键数排，前 {} 个应用是：{}。",
            n(f.apps.len() as i64),
            listed.join("、")
        );
        if f.apps_omitted > 0 {
            p5.push_str(&format!(
                "另有 {} 个应用未列出，合计 {} 次。",
                n(f.apps_omitted),
                n(f.apps_omitted_keys)
            ));
        }
        paras.push(p5);
    }

    if f.bogus_days > 0 {
        paras.push(format!(
            "这一期有 {} 天的字数大于按键数，那几天的数字不可信：一个字至少要按一次键，字数不可能比按键还多，这是适配器虚报。",
            n(f.bogus_days)
        ));
    }

    paras.join("\n\n")
}

/// 系统提示词。
///
/// 每一条都对应一种**已经出现过**的失败形态，不是泛泛的「请准确」：
///
/// - 「不许自己算」——模型编数字最常见的样子不是凭空捏造，而是**把两个真数字
///   算一算**。算出来的东西看起来完全合理，却没有哪个字段能对上。
/// - 「量不到是正式取值」——清单里写着「量不到」时，模型很自然地把 0 填进去。
/// - 「不做评价」——这个程序只看得见击键次数，看不见内容。让它点评作息，
///   就是让一个只读得到「你半夜敲了一千次键」的东西对人下判断。
pub const SYSTEM_PROMPT: &str = "\
你在为一个人写他的打字统计总结。用户自己运行了一个本地程序，记录他每天敲了多少键盘。

你会收到一份中文清单，里面是这一期的全部数字，每个数字都带着单位和来源。

严格遵守下面几条：

1. 只能用清单里出现过的数字。清单里没有的数字，一个都不要写——包括日期、天数、比例。
2. 不要做任何加减乘除。清单里的合计数、比例、速度都已经算好了，直接引用即可。
   把两个数字拿来算一算，得到的是一个看起来合理、却没有任何地方能核对的数——那比凭空编造更糟。
3. 「量不到」是一个正式取值，意思是这一期没有采集到这类数据，不等于 0。
   看到「量不到」就照实说量不到，不要写成 0，也不要绕开不提。
4. 单位跟着清单走：次、字、分钟、小时。不要把「次」和「字」放在一起比大小。
5. 不做评价，不给建议，不谈效率高低，不猜用户写的是什么、写得怎么样，也不评价他的作息。
   你只知道他敲了多少次键，不知道他写了什么。陈述事实，把判断留给读的人。
6. 不要标题，不要列表，不要 Markdown 标记（不要 #、*、-）。就是几段通顺的中文。
7. 分成 3 到 5 段，段与段之间空一行，全文 300 到 600 字。
8. 「有记录的天数」少于「这一期共几天」时，可以直接说出这个事实，但不要替用户解释原因。

如果清单里说这一期没有任何打字记录，就照实写这一期没有记录，不要编造趋势或对比。";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::fixtures::{无字数, 无记录, 有字数};

    /// 把一段文字里所有「三位以上」的数字抠出来，去掉逗号和前导零。
    ///
    /// 门槛定在三位是**故意的**：一位两位的数会从日期（`2026-09-23` 里的 9 和 23）
    /// 和比例（`4.9%` 里的 4 和 9）里冒出来，几乎在任何文本里都能找到，
    /// 那样这条测试就永远通过、也永远没用。三位以上的才是真正承重的量。
    fn 大数字(text: &str) -> Vec<String> {
        let mut out = Vec::new();
        let chars: Vec<char> = text.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i].is_ascii_digit() {
                let start = i;
                while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == ',') {
                    i += 1;
                }
                let raw: String = chars[start..i].iter().collect();
                let digits: String = raw.chars().filter(|c| *c != ',').collect();
                let trimmed = digits.trim_start_matches('0');
                if trimmed.len() >= 3 {
                    out.push(trimmed.to_string());
                }
            } else {
                i += 1;
            }
        }
        out
    }

    /// 把一段文字里所有的百分比原样抠出来（含小数点）。
    fn 比例(text: &str) -> Vec<String> {
        text.split('%')
            .filter_map(|head| {
                let tail: String = head
                    .chars()
                    .rev()
                    .take_while(|c| c.is_ascii_digit() || *c == '.')
                    .collect();
                let num: String = tail.chars().rev().collect();
                (!num.is_empty()).then_some(num)
            })
            .collect()
    }

    /// **没有字数数据时必须说出来「量不到」，而且绝不能写成 0。**
    ///
    /// 这是整个功能里最容易犯、后果最重的一个错：`SUM(char_input)` 在没适配器时
    /// 就是 0，顺手印出来就是「你这一期打了 0 个字」——一个彻头彻尾的假话，
    /// 而且它看起来完全正常。
    #[test]
    fn 模板在完全没有字数时说出来量不到() {
        let f = 无字数();
        let out = render_template(&f);
        assert!(out.contains("量不到"), "没有字数数据，但模板里没说量不到：{out}");
        assert!(
            !out.contains("0 字"),
            "把量不到印成了「0 字」，这是假话：{out}"
        );
        assert!(!out.contains("0.0%"), "没有字数还算出了比例：{out}");

        // 清单那边同样：整块换成「量不到」，不留一个 0。
        let sheet = render_sheet(&f);
        assert!(sheet.contains("量不到"));
        assert!(!sheet.contains("0 字"), "清单里把量不到印成了 0：{sheet}");
        assert!(sheet.contains("【字数】"));
    }

    /// 一期完全没有记录时，说的是「没有记录」，不是「敲了 0 次」。
    ///
    /// 「这周敲了 0 次」和「这周没记录」在数据上是两回事（后者可能只是程序没跑），
    /// 而且在**这一期**这个语境里，只有后者是事实——前者的意思是「你坐在这儿一个字没打」。
    #[test]
    fn 模板在完全没有记录时不说零次() {
        let f = 无记录();
        let out = render_template(&f);
        assert!(out.contains("没有任何打字记录"), "没说出没有记录：{out}");
        assert!(!out.contains("0 次"), "把没有记录说成了 0 次：{out}");
        assert!(!out.contains("0 字"), "把没有记录说成了 0 字：{out}");
        assert!(!out.contains("0.0%"), "没有记录还算出了比例：{out}");
        // 一段就够，不要为了凑段落把「无」说三遍。
        assert_eq!(out.split("\n\n").count(), 1, "空期的正文不该分成多段");

        let sheet = render_sheet(&f);
        assert!(sheet.contains("没有任何打字记录"));
        assert!(!sheet.contains("0 次"));
    }

    /// 只按了其他键（Ctrl+S、方向键）的一期：不算打字，但不能装作没发生。
    #[test]
    fn 只有其他键时不说敲了零次() {
        let f = ReportFacts { key_other: 993, ..无记录() };
        let out = render_template(&f);
        assert!(out.contains("没有任何打字记录"));
        assert!(out.contains("993"), "其他按键被吞掉了：{out}");
        assert!(!out.contains("0 次"), "{out}");
    }

    /// **展示集不变式，执行版**：正文里每个数字都要能在清单里找到。
    ///
    /// 这就是「清单里每个数字都要在页面上看得见、页面上每个数字都要在清单里」
    /// 那条线在「模板 ↔ 清单」这一段上的形式。降级正文是页面内容的一部分，
    /// 所以它不能出现清单里没有的数字——**否则断网那一刻，用户看到的就是一份
    /// 谁也核对不了的东西**，而这正是模型正文最需要防的事。
    #[test]
    fn 模板里的数字都能在清单里找到() {
        for f in [有字数(), 无字数(), 无记录()] {
            let sheet = render_sheet(&f);
            let body = render_template(&f);
            let allowed = 大数字(&sheet);
            for v in 大数字(&body) {
                assert!(
                    allowed.contains(&v),
                    "正文里的 {v} 在清单里找不到。\n--- 正文 ---\n{body}\n--- 清单 ---\n{sheet}"
                );
            }
        }
    }

    /// 比例也要对得上：正文里的每个百分比都得是清单里出现过的整值。
    ///
    /// 上面那条测试对比例是漏的——`4.9%` 抠出来是 `4` 和 `9`，两位数，够不着门槛。
    /// 而比例恰恰最容易写错（分子分母一换，`4.9%` 变成 `95%`，看起来一样合理）。
    #[test]
    fn 模板里的比例都能在清单里找到() {
        for f in [有字数(), 无字数()] {
            let sheet = render_sheet(&f);
            let body = render_template(&f);
            let allowed = 比例(&sheet);
            assert!(!allowed.is_empty(), "清单里一个比例都没有，测试白测了");
            for v in 比例(&body) {
                assert!(
                    allowed.contains(&v),
                    "正文里的 {v}% 在清单里找不到。\n--- 正文 ---\n{body}\n--- 清单 ---\n{sheet}"
                );
            }
        }
    }

    /// **清单里每个比例都带着算式。**
    ///
    /// 不写算式的话，「覆盖率 82.3%」是一个无法核对的断言；写上
    /// 「（有字数的按键数 20,067 ÷ 敲入按键 24,381）」，它当场就变成了可验算的一行。
    /// 模型也更容易照抄而不是自己算。
    #[test]
    fn 清单里的比例都带算式() {
        let sheet = render_sheet(&有字数());
        let mut seen = 0;
        for line in sheet.lines() {
            if line.contains('%') {
                seen += 1;
                assert!(line.contains('（') && line.contains('÷'), "这一行没有算式：{line}");
                assert!(line.contains('）'), "算式没有收尾：{line}");
            }
        }
        assert!(seen >= 3, "带算式的比例只有 {seen} 个，太少了");
    }

    /// 清单必须说清「共 24 个数」，且一个不少——少一个数，模型就会把那小时的缺当成零，
    /// 而它和「0 次」在清单里是同一个样子。
    #[test]
    fn 清单的小时数是齐全的二十四个() {
        let sheet = render_sheet(&有字数());
        let line = sheet.lines().find(|l| l.starts_with("【按小时】")).unwrap();
        assert!(line.contains("共 24 个数"), "没说清是 24 个数：{line}");
        let nums = line.split('：').nth(1).unwrap();
        assert_eq!(nums.split_whitespace().count(), 24, "小时的个数对不上：{line}");
        assert!(sheet.contains("最忙的一小时：21 时"));
    }

    /// 适配器没上报过的应用写「字数量不到」，不能写 0。
    #[test]
    fn 应用清单里没有字数的写量不到() {
        let sheet = render_sheet(&无字数());
        assert!(sheet.contains("WindowsTerminal：1,432 次，字数量不到"), "{sheet}");
        assert!(!sheet.contains("WindowsTerminal：1,432 次，字数 0"), "{sheet}");
    }

    /// 期次标题和范围必须原样出现——正文里的日期就是从这里抄的。
    #[test]
    fn 清单的头一行写清朝和期次() {
        let sheet = render_sheet(&有字数());
        assert!(sheet.starts_with("期间：2026 年第 39 周（2026-09-21 至 2026-09-27），已结束"));
    }

    /// 应用名的显示形式和前端一致：去掉路径和 `.exe`，太长截断。
    #[test]
    fn 应用名去掉路径和扩展名() {
        assert_eq!(app_display_name("wps.exe"), "wps");
        assert_eq!(app_display_name(r"C:\Program Files\WPS Office\wps.exe"), "wps");
        assert_eq!(app_display_name("WindowsTerminal.exe"), "WindowsTerminal");
        let long = app_display_name("这是一个特别特别特别特别特别长的应用名字用来看看截断.exe");
        assert!(long.ends_with('…'), "{long}");
        assert_eq!(long.chars().count(), 24, "截断后的宽度不是 24：{long}");
    }

    /// 千分位：数字连着四五位时，`24381` 和 `2438l` 在屏幕上分不清。
    #[test]
    fn 千分位加对了() {
        assert_eq!(n(0), "0");
        assert_eq!(n(7), "7");
        assert_eq!(n(999), "999");
        assert_eq!(n(1_000), "1,000");
        assert_eq!(n(24_381), "24,381");
        assert_eq!(n(1_234_567), "1,234,567");
    }

    /// 时长：不足一小时只写分。
    #[test]
    fn 时长的写法() {
        assert_eq!(dur(42), "42 分");
        assert_eq!(dur(60), "1 小时 0 分");
        assert_eq!(dur(582), "9 小时 42 分");
    }

    /// 提示词里那几条硬约束不能丢——它们各自对应一种已经见过的失败。
    #[test]
    fn 系统提示词把关键的几条都说了() {
        for needle in ["只能用清单里出现过的数字", "不要做任何加减乘除", "量不到", "不做评价", "不要标题"] {
            assert!(SYSTEM_PROMPT.contains(needle), "提示词里少了「{needle}」");
        }
        // 段落数要写进提示词：不写的话模型会吐一大段。
        assert!(SYSTEM_PROMPT.contains("300 到 600 字"));
    }

    /// 正文里不该出现 Markdown 记号的要求，是提示词里唯一一条「格式」约束，
    /// 它得说清不要什么，而不是「请用纯文本」这种会被忽略的说法。
    #[test]
    fn 提示词明确禁止了_markdown() {
        assert!(SYSTEM_PROMPT.contains("Markdown"));
        assert!(SYSTEM_PROMPT.contains("不要 #"));
    }
}
