//! 接口密钥怎么存：Windows DPAPI 加密，密文进 `settings` 表。
//!
//! 密钥是用户自己掏钱买的，明文躺在 `typestat.db` 里意味着**任何能读到那个文件的
//! 东西都能直接拿去用**——备份软件、同步盘、随手拷给别人看的数据库。
//! DPAPI（`CryptProtectData`）用的是登录会话派生的密钥，换来的是两件事：
//! 换个 Windows 账户登录取不出来，把 `typestat.db` 拷到别的机器也解不开。
//!
//! 刻意**不带** `CRYPTPROTECT_LOCAL_MACHINE`：那个标志会让同一台机器上
//! 所有账户都能解开，正好把上面第二条作废。
//!
//! 代价是多一个失败模式：**解密失败要单独说**。用户换了账户之后，
//! 界面上必须写「存的密钥解不开了，请重新填一次」，而不是悄悄当成没配——
//! 后者会让人反复检查自己是不是输错了，而问题根本不在那儿。
//!
//! 存的是**十六进制**而不是计划里写的 base64：这个 crate 里没有 base64
//! （也没别的地方要用），而 `adapters::ipc::random_token` 已经在用十六进制了。
//! 为一个存进数据库、没人会看的字符串再引一个依赖不划算。
//! 密文长一倍无所谓——它是两三百字节的东西。

use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

/// 解密解不开的两种原因，分开说。
///
/// **不能合成一个 `None`**：`None` 的含义是「还没配」，而这里的两种情况
/// 都是「配过，但现在读不出来」。界面上那两句话完全不同——
/// 一句是「请填一个」，另一句是「你填过的那个读不出来了，请重填」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
    /// 存进去的不是合法的十六进制。多半是有人手改过 `settings` 表，
    /// 或者那一行的值被别的东西覆盖了。
    NotHex,
    /// DPAPI 解不开：换了 Windows 账户登录，或者 `typestat.db` 是从别的机器拷来的。
    /// 里面是系统报的原文，只用来写日志。
    Broken(String),
    /// 加密这一步就失败了。极少见，通常是内存不够。
    Protect(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::NotHex => write!(f, "存的密钥不是合法的密文"),
            SecretError::Broken(e) => write!(f, "存的密钥解不开了（{e}）"),
            SecretError::Protect(e) => write!(f, "密钥加密失败（{e}）"),
        }
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 一位十六进制字符。**只认小写和数字**——不做「顺手也接受大写」的宽容：
/// 这里唯一的写入方是我们自己，读到不合格式的值就说明它被人动过了，
/// 那正是该被拦下来的情况。
fn hexval(c: char) -> Option<u32> {
    match c {
        '0'..='9' => Some(c as u32 - '0' as u32),
        'a'..='f' => Some(c as u32 - 'a' as u32 + 10),
        _ => None,
    }
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    (0..bytes.len() / 2)
        .map(|i| {
            let hi = hexval(bytes[2 * i] as char)?;
            let lo = hexval(bytes[2 * i + 1] as char)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

/// 取出系统调用吐出来的那块内存，然后把它还回去。
///
/// DPAPI 用 `LocalAlloc` 分配，**只能 `LocalFree` 释放**——Rust 的分配器不认识
/// 这块内存，忘掉它就是一次内存泄漏（每次生成报告都漏一次）。
/// 先拷贝再释放，拷贝这一步不能省：`LocalFree` 之后那块内存就不归我们了。
unsafe fn take_blob(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let bytes = if out.cbData == 0 || out.pbData.is_null() {
        Vec::new()
    } else {
        std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec()
    };
    if !out.pbData.is_null() {
        let _ = LocalFree(HLOCAL(out.pbData as *mut core::ffi::c_void));
    }
    bytes
}

fn empty_blob() -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    }
}

/// 加密。返回可以存进 `settings` 表的十六进制字符串。
pub fn protect(plain: &str) -> Result<String, SecretError> {
    // 空串会被 DPAPI 直接顶回来（E_INVALIDARG），先在这里拦住——
    // 调用方的本意应该是「不修改」，而不是「存一个空的」。
    if plain.is_empty() {
        return Err(SecretError::Protect("密钥是空的".into()));
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_bytes().as_ptr().cast_mut(),
    };
    let mut out = empty_blob();
    unsafe {
        // UI_FORBIDDEN：万一这台机器上的策略要求弹窗确认，我们要的是失败，
        // 而不是在一个没有界面的线程上弹出一个没人看得见的对话框。
        // 第二个参数是描述文字，只有界面上展示密文时才用得到，这里给 NULL。
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .map_err(|e| SecretError::Protect(e.message().to_string()))?;
    }
    Ok(to_hex(&unsafe { take_blob(out) }))
}

/// 解密。`stored` 是 [`protect`] 写出去的那串十六进制。
pub fn unprotect(stored: &str) -> Result<String, SecretError> {
    let raw = from_hex(stored).ok_or(SecretError::NotHex)?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: raw.len() as u32,
        pbData: raw.as_ptr().cast_mut(),
    };
    let mut out = empty_blob();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            .map_err(|e| SecretError::Broken(e.message().to_string()))?;
    }
    let bytes = unsafe { take_blob(out) };
    // 解出来的字节是当初 `protect` 收到的那个字符串，所以一定还是 UTF-8。
    // 真解出别的，说明存的是别人塞的密文，当成解不开处理。
    String::from_utf8(bytes).map_err(|_| SecretError::Broken("解出来的不是文字".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 存进去、拿出来，必须一模一样。中文和符号都要过一遍——
    /// 密钥里有 `+`、`/`、`=` 是很常见的（base64 形态的 key 到处都是）。
    #[test]
    fn 加密再解密回到原文() {
        let long = "x".repeat(4096);
        for plain in [
            "sk-1234567890abcdef",
            "sk-proj-AbCd+/=_-中文密钥也要能存",
            long.as_str(),
            "带空格 的 密钥",
        ] {
            let stored = protect(plain).expect("加密失败");
            assert_eq!(unprotect(&stored).expect("解密失败"), plain);
        }
    }

    /// 存下去的是密文，不是明文。
    ///
    /// 这条要是挂了，说明 DPAPI 那一步没生效，密钥正以明文躺在库里——
    /// 而库文件是可以被随手拷走的。
    #[test]
    fn 密文里看不到明文() {
        let plain = "sk-1234567890abcdef";
        let stored = protect(plain).unwrap();
        assert!(!stored.contains(plain), "密文里出现了明文");
        assert!(stored.chars().all(|c| c.is_ascii_hexdigit()), "不是十六进制：{stored}");
        assert_ne!(stored.len(), plain.len() * 2, "密文和明文一样长，不像是加密过的");
    }

    /// 改过一位就解不开。**这是这个方案的价值所在**：
    /// 密文是可校验的，不是「读不出来就用空的顶上」。
    #[test]
    fn 改过一位的密文解不开() {
        let stored = protect("sk-1234567890abcdef").unwrap();
        // 把最后一个字符换掉（换个不同的十六进制数字）。
        let mut chars: Vec<char> = stored.chars().collect();
        let last = chars.len() - 1;
        chars[last] = if chars[last] == '0' { '1' } else { '0' };
        let tampered: String = chars.into_iter().collect();
        assert_ne!(tampered, stored);
        assert!(unprotect(&tampered).is_err(), "改过的密文被解开了");
    }

    /// 不是密文的值要说「不是密文」，不要说「解不开」。
    ///
    /// 这两句在界面上不一样：前者是「这个值被人动过了」，
    /// 后者是「换账户了，重填一次」。合成一句会让人查错方向。
    #[test]
    fn 不是密文的值单独报错() {
        assert_eq!(unprotect(""), Err(SecretError::NotHex));
        assert_eq!(unprotect("abc"), Err(SecretError::NotHex), "奇数长度没被拦住");
        assert_eq!(unprotect("zzzz"), Err(SecretError::NotHex), "非十六进制字符没被拦住");
        assert_eq!(unprotect("sk-1234"), Err(SecretError::NotHex));
    }

    /// 一段随机数据是合法十六进制，但解不开——必须是 `Broken` 而不是 `NotHex`。
    #[test]
    fn 合法十六进制但解不开的报解不开() {
        let garbage = "ab".repeat(64);
        match unprotect(&garbage) {
            Err(SecretError::Broken(_)) => {}
            other => panic!("期望解不开，得到 {other:?}"),
        }
    }

    /// 空密钥直接拒绝：调用方的本意应该是「不修改」，而不是「存一个空的」。
    #[test]
    fn 空密钥拒绝加密() {
        assert!(protect("").is_err());
    }

    /// 十六进制是往返的，且大小写敏感。
    #[test]
    fn 十六进制往返() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        let hex = to_hex(&bytes);
        assert_eq!(hex.len(), 512);
        assert_eq!(from_hex(&hex).unwrap(), bytes);
        assert_eq!(to_hex(b"\x00\x0f\xff"), "000fff");
        // 大写不接受：唯一的写入方是我们自己，大写说明这个值被人动过。
        assert_eq!(from_hex("AB"), None);
    }
}
