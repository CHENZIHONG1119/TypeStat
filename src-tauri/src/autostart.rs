//! 开机自启：在**当前用户**的 Run 键里写一条。
//!
//! ## 为什么是注册表
//!
//! 三条路都能做到「登录后自动启动」，只有这一条能让程序**自己读回状态**：
//!
//! - **启动文件夹**（`shell:startup`）里放一个快捷方式，用户可以自己在资源管理器里
//!   拖走删掉。删了之后程序看不出来——它只会以为「我开着自启」，而界面上一片太平。
//! - **任务计划程序**能延迟启动、能以管理员身份跑，但我们要的只是「登录后开始计数」，
//!   不需要提权；而 `schtasks` 的失败模式（被组策略拦、权限不足）比写一个 HKCU 值
//!   复杂得多，且同样难以回读。
//! - **Run 键**是一个值，写进去、读回来，两边都是同一份真相。
//!
//! ## 为什么是 HKCU 不是 HKLM
//!
//! 不需要管理员权限。代价是只对当前用户生效——**这正是我们要的**：统计本来就按
//! 用户算，`%APPDATA%` 里的库也是按用户分的。写 HKLM 反而会造成「这台机器上
//! 所有用户都启动一份，但只有装的人有数据」这种荒唐局面。
//!
//! ## 命令行里必须带 `--minimized`
//!
//! 开机自启的意思是「在后台开始计数」，不是「开机弹一个窗口盖住你的桌面」。
//! 这个参数由 `lib.rs` 解读：带上它就不显示主窗口，只留托盘图标。

use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
};

/// 自启项所在的键。路径固定，Windows 上一直存在。
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// 值的名字。用程序名而不是 `类型+名字` 那种花活：用户在「任务管理器 → 启动」
/// 里看到的就是这个名字，得让他认得出这是什么。
const VALUE_NAME: &str = "TypeStat";

/// 自启时附加的命令行参数。见模块头。
pub const MINIMIZED_ARG: &str = "--minimized";

/// 字符串转宽字符，补结尾的 NUL。
///
/// 注册表 API 收的是 `PCWSTR`，也就是**必须有终止符**的宽字符串。
/// `OsStr::encode_wide` 出来的不带终止符，直接传进去就是越界读——
/// 这是这类 API 最常见的一种崩法，所以统一从这里走。
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 自启项该写什么。
///
/// **路径必须带引号。** Run 键的值是按命令行解析的，而
/// `C:\Program Files\TypeStat\TypeStat.exe` 里有空格：不加引号的话，
/// Windows 会去试 `C:\Program.exe`（一个著名的提权手法就是往那儿放个同名文件），
/// 找不到就静静地什么都不启动——用户看到的现象是「自启开着，但每次开机都没反应」。
///
/// 参数放引号**外面**：放里面会被当成文件名的一部分。
fn command_for(exe: &str) -> String {
    format!("\"{exe}\" {MINIMIZED_ARG}")
}

/// 当前可执行文件的路径。
///
/// 失败（理论上不会有）时返回 `None`，而不是退回 `argv[0]`：`argv[0]` 是
/// 调用方给的，可能是个相对路径，写进注册表之后开机时的工作目录完全不同，
/// 那条自启项会永远失败，而界面显示「已开启」。
fn exe_path() -> Option<String> {
    std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// 打开（必要时创建）Run 键。
///
/// 用 `RegCreateKeyExW` 而不是 `RegOpenKeyExW`：Run 键在正常 Windows 上一直存在，
/// 但被精简过的或组策略动过手脚的机器上可能没有。这时「打不开」和「创建它」
/// 是两种做法，而后者才是用户点「开启自启」时想要的。
fn open_run_key() -> Result<HKEY, String> {
    let sub = wide(RUN_KEY);
    let mut hkey = HKEY::default();
    let rc = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            0,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
    };
    if rc == ERROR_SUCCESS {
        Ok(hkey)
    } else {
        Err(format!("打不开注册表的 Run 键（错误码 {}）", rc.0))
    }
}

/// 读回自启项，返回它记的命令行。
///
/// `Ok(None)` 是没有这一项。**「没有这一项」和「读失败」必须分开**：
/// 前者是「自启关着」，后者是「不知道」——把后者也显示成「关着」的话，
/// 用户会点一次「开启」来修，而那次写也会失败。
fn read_value(hkey: HKEY, name: &str) -> Result<Option<String>, String> {
    let name_w = wide(name);
    let mut ty = REG_SZ;
    let mut size: u32 = 0;

    // 第一遍问长度（lpdata 传 None）。注册表里是二进制，长度够不够只能这么问。
    let rc = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut ty),
            None,
            Some(&mut size),
        )
    };
    if rc == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if rc != ERROR_SUCCESS {
        return Err(format!("读取自启项失败（错误码 {}）", rc.0));
    }

    let mut buf = vec![0u8; size as usize];
    let rc = unsafe {
        RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut ty),
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(format!("读取自启项失败（错误码 {}）", rc.0));
    }
    buf.truncate(size as usize);

    // REG_SZ 是 UTF-16。按 `u16` 切而不是按字节切：长度一定是偶数，
    // 但万一不是（被别的程序写坏过），按字节切会得到一个长度不对的 `u16` 切片。
    //
    // `as_chunks` 而不是 `chunks_exact`：多出来的那个尾字节两者都是丢掉，
    // 但 `as_chunks` 给的是定长引用，没有逐块的边界检查，编译出来是一段直接的
    // 向量拷贝。
    let units: Vec<u16> = buf
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    let s = String::from_utf16_lossy(&units);
    Ok(Some(s.trim_end_matches('\0').to_string()))
}

/// 自启现在的状态。
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Autostart {
    /// 注册表里有没有这一项。
    pub enabled: bool,
    /// 记的是哪个路径。`None` 表示没有这一项。
    ///
    /// 界面要拿它和**当前**程序路径比一比：程序被挪过位置（或换了安装目录）之后，
    /// 注册表里那条还指着老路径，开机时会静静地什么都不启动。这种情况要能报出来，
    /// 而不是简单显示「已开启」。
    pub path: Option<String>,
    /// 注册表里记的路径和当前程序不一致（或拿不到当前路径）。
    pub stale: bool,
    /// 当前程序路径。界面上要显示它，用户才知道自启开起来的是哪个 exe。
    pub current: Option<String>,
}

/// 读当前状态。任何一步失败都当「开着但状态不明」处理吗？不——见下面注释。
pub fn status() -> Result<Autostart, String> {
    let hkey = open_run_key()?;
    let value = read_value(hkey, VALUE_NAME);
    // 关句柄失败没有补救办法，也不影响结论：这个进程马上就不再用它了。
    // 吞掉返回值是明确的，不是忘了处理。
    let _ = unsafe { RegCloseKey(hkey) };

    let current = exe_path();
    match value? {
        None => Ok(Autostart {
            enabled: false,
            path: None,
            stale: false,
            current,
        }),
        Some(cmd) => {
            let path = parse_path(&cmd);
            // `stale` 只在**两边都拿得到**路径时才有意义。拿不到当前路径时给 false：
            // 报一个自己都确认不了的警告，比不报更糟——用户会去修不存在的问题。
            let stale = match (&path, &current) {
                (Some(a), Some(b)) => !a.eq_ignore_ascii_case(b),
                _ => false,
            };
            Ok(Autostart {
                enabled: true,
                path,
                stale,
                current,
            })
        }
    }
}

/// 从 Run 值里抠出 exe 路径。
///
/// 值是命令行，可能带引号也可能不带（别的程序写的、或老版本写的）。带引号时
/// 取引号里的部分，不带引号时取到第一个空格为止——这是 Windows 解析 Run 值的
/// 实际规则，照它来才不会把一个正确的项误判成「路径不对」。
fn parse_path(cmd: &str) -> Option<String> {
    let s = cmd.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(rest) = s.strip_prefix('"') {
        return rest.split('"').next().map(|p| p.to_string());
    }
    Some(s.split(' ').next().unwrap_or(s).to_string())
}

/// 开 / 关自启。
///
/// **开发模式（debug 构建）下拒绝写入。** 这时 `current_exe()` 是
/// `target\debug\typestat.exe`——写进去的话，下次登录会启动一个开发版，
/// 而它一旦被重新编译或清理掉就再也起不来了，用户看到的还是「自启开着」。
/// 一个只在开发机上错的功能，不如当场说清楚它不适用。
pub fn set(enabled: bool) -> Result<Autostart, String> {
    if cfg!(debug_assertions) {
        return Err("开发模式下不写开机自启（会把 target\\debug 里的程序写进去）".into());
    }

    let hkey = open_run_key()?;
    let name = wide(VALUE_NAME);
    let rc = if enabled {
        let exe = exe_path().ok_or("拿不到当前程序路径，无法设置自启")?;
        let data = wide(&command_for(&exe));
        // 长度按**字节**算。`utf16` 的字节数是元素数的两倍，这是 `lpdata` 要的长度；
        // 这里把结尾的 NUL 也算进去了，多算无害，少算会被写成一个没有终止符的字符串。
        let bytes: &[u8] =
            unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2) };
        unsafe { RegSetValueExW(hkey, PCWSTR(name.as_ptr()), 0, REG_SZ, Some(bytes)) }
    } else {
        unsafe { RegDeleteValueW(hkey, PCWSTR(name.as_ptr())) }
    };
    // 关句柄失败没有补救办法，也不影响结论：这个进程马上就不再用它了。
    // 吞掉返回值是明确的，不是忘了处理。
    let _ = unsafe { RegCloseKey(hkey) };

    // 删除一个本来就不存在的项会返回 ERROR_FILE_NOT_FOUND——那是「已经是关着的」，
    // 正是调用方想要的结果，不该当成失败报出来。
    let ok = rc == ERROR_SUCCESS || (!enabled && rc == ERROR_FILE_NOT_FOUND);
    if !ok {
        return Err(format!(
            "{}自启失败（错误码 {}）",
            if enabled { "开启" } else { "关闭" },
            rc.0
        ));
    }
    status()
}

/// 启动参数里有没有 `--minimized`。
///
/// 用 `args_os` 而不是 `args`：参数是程序自己写进去的 ASCII，但同一个进程也可能
/// 被用户用别的（带非 UTF-8 的）命令行启动，那一下 `args()` 会 panic。
pub fn start_minimized() -> bool {
    std::env::args_os().any(|a| a == MINIMIZED_ARG)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的值名。**绝不能用 `VALUE_NAME`**：那会改到用户真正的自启项上，
    /// 一次 `cargo test` 就把人家的开机启动设置改了。
    const TEST_VALUE: &str = "TypeStat__测试用__可以删";

    /// 兜底的清理：断言失败会 panic，panic 之后函数体剩下的部分不执行，
    /// 脏值就留在用户的注册表里了。Drop 保证它一定被删掉。
    struct Cleanup;
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if let Ok(hkey) = open_run_key() {
                let name = wide(TEST_VALUE);
                let _ = unsafe {
                    // 清理路径：删不掉也不该在这里炸，Drop 里不能 panic。
                    let _ = RegDeleteValueW(hkey, PCWSTR(name.as_ptr()));
                    RegCloseKey(hkey)
                };
            }
        }
    }

    #[test]
    fn 路径带空格时必须加引号() {
        // 这是 Run 键最容易踩的坑：不加引号，Windows 会去试 C:\Program.exe
        assert_eq!(
            command_for(r"C:\Program Files\TypeStat\TypeStat.exe"),
            r#""C:\Program Files\TypeStat\TypeStat.exe" --minimized"#
        );
    }

    #[test]
    fn 读回命令行时只取引号里的路径() {
        assert_eq!(
            parse_path(r#""C:\Program Files\TypeStat\TypeStat.exe" --minimized"#).as_deref(),
            Some(r"C:\Program Files\TypeStat\TypeStat.exe")
        );
        // 没加引号的（别的程序写的）取到第一个空格为止
        assert_eq!(
            parse_path(r"C:\TypeStat\TypeStat.exe --minimized").as_deref(),
            Some(r"C:\TypeStat\TypeStat.exe")
        );
        assert_eq!(parse_path("").as_deref(), None);
    }

    #[test]
    fn 注册表的读写删走通一遍() {
        let _cleanup = Cleanup;
        let hkey = open_run_key().expect("打不开 Run 键");

        // 起点：不该有这一项
        assert_eq!(read_value(hkey, TEST_VALUE).unwrap(), None, "测试值名被占了，换个名字");

        let name = wide(TEST_VALUE);
        let data = wide(&command_for(r"C:\Program Files\A B\typestat.exe"));
        let bytes: &[u8] =
            unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2) };
        let rc = unsafe {
            RegSetValueExW(hkey, PCWSTR(name.as_ptr()), 0, REG_SZ, Some(bytes))
        };
        assert_eq!(rc, ERROR_SUCCESS, "写自启项失败");

        let back = read_value(hkey, TEST_VALUE).unwrap();
        assert_eq!(
            back.as_deref(),
            Some(r#""C:\Program Files\A B\typestat.exe" --minimized"#),
            "读回来的和写进去的不一样"
        );
        assert_eq!(
            parse_path(back.as_deref().unwrap()).as_deref(),
            Some(r"C:\Program Files\A B\typestat.exe")
        );

        let rc = unsafe { RegDeleteValueW(hkey, PCWSTR(name.as_ptr())) };
        assert_eq!(rc, ERROR_SUCCESS, "删自启项失败");
        assert_eq!(read_value(hkey, TEST_VALUE).unwrap(), None, "删完还在");
        // 删一个不存在的项：这是「已经是关着的」，不是错误
        let rc = unsafe { RegDeleteValueW(hkey, PCWSTR(name.as_ptr())) };
        assert_eq!(rc, ERROR_FILE_NOT_FOUND);

        // 关句柄失败没有补救办法，也不影响结论：这个进程马上就不再用它了。
    // 吞掉返回值是明确的，不是忘了处理。
    let _ = unsafe { RegCloseKey(hkey) };
    }

    /// 这个测试**只在 debug 下编出来**。
    ///
    /// release 构建里 `set(true)` 会真的往用户的 Run 键里写东西——
    /// 一个 `cargo test --release` 就把人家的开机启动改了。整条测试不存在更省心。
    #[cfg(debug_assertions)]
    #[test]
    fn 开发模式下不写自启() {
        assert!(set(true).is_err(), "debug 构建下不该去碰真正的自启项");
    }
}
