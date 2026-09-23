//! 建表与迁移。

use rusqlite::{Connection, Result as SqlResult};

/// 当前 schema 版本。加字段时递增并在 `migrate` 里补对应的迁移。
///
/// v2：新增 `key_stats`（键位使用频次）。
/// v3：新增 `reports`（周期性总结报告的存档）。
pub const SCHEMA_VERSION: i64 = 3;

pub fn init(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS minute_stats (
            minute      INTEGER NOT NULL,
            local_day   TEXT    NOT NULL,
            local_hour  INTEGER NOT NULL,
            app         TEXT    NOT NULL,
            key_input   INTEGER NOT NULL DEFAULT 0,
            key_delete  INTEGER NOT NULL DEFAULT 0,
            key_other   INTEGER NOT NULL DEFAULT 0,
            char_input  INTEGER NOT NULL DEFAULT 0,
            char_delete INTEGER NOT NULL DEFAULT 0,
            char_source TEXT,
            PRIMARY KEY (minute, app)
        );

        CREATE INDEX IF NOT EXISTS idx_minute_stats_day
            ON minute_stats(local_day);

        -- 键位使用频次：每个物理按键按了多少次，供键盘热力图使用。
        --
        -- 粒度是「日 × 按键」而不是「分钟 × 按键」：
        --   日粒度   约 80 行/天  →  3 万行/年，可行
        --   分钟粒度 约 8 万行/天 →  3000 万行/年，不可行
        -- 按日存，任意区间（周/月/年）都能聚合出来，够用。
        --
        -- 主键带上 scan_code 和 extended 是为了区分左右修饰键：
        -- 左右 Shift 共用 vkCode 0x10、左右 Ctrl 共用 0x11，只有 scanCode 不同；
        -- 左右 Ctrl/Alt 连 scanCode 都相同，只有扩展位不同。
        -- 这三个字段都必须存——少一个就永久丢失了区分左右键的能力，且补不回来。
        CREATE TABLE IF NOT EXISTS key_stats (
            local_day TEXT    NOT NULL,
            vk_code   INTEGER NOT NULL,
            scan_code INTEGER NOT NULL,
            extended  INTEGER NOT NULL DEFAULT 0,
            count     INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (local_day, vk_code, scan_code, extended)
        );

        CREATE INDEX IF NOT EXISTS idx_key_stats_day
            ON key_stats(local_day);

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- 记录每个应用是否支持精确字数，避免每次都重新探测。
        CREATE TABLE IF NOT EXISTS adapters (
            app        TEXT PRIMARY KEY,
            capability TEXT    NOT NULL,
            last_seen  INTEGER NOT NULL
        );

        -- 周期性总结报告的存档。一期一行，主键是（期次类型, 期次键），
        -- 例如 ('week', '2026-W39')。
        --
        -- 为什么要存下来而不是每次重算：**数字可以重算，模型的正文不能。**
        -- 同一个提示词，今天和下周问出来的不是同一段话；接口没了、key 撤了、
        -- 换了模型，就更拿不回来。所以正文和它当时依据的事实一起落库。
        --
        -- `facts_json` 是前端画账目用的那份数字，`sheet` 是原样喂给模型的清单。
        -- 存了这两样，正文里任何一句提到的数字都能离线核对——对着页面核，
        -- 或者对着模型当时看到的那张清单核。
        --
        -- 只允许生成**已经结束**的期，所以这里没有「生成时是否已结束」这类字段：
        -- 一旦落库，它依据的数据就再也不会变了（minute_stats 只写当前分钟）。
        CREATE TABLE IF NOT EXISTS reports (
            period_type  TEXT    NOT NULL,   -- 'week' | 'month'
            period_key   TEXT    NOT NULL,   -- '2026-W39' | '2026-09'
            starts_on    TEXT    NOT NULL,   -- 期首日 YYYY-MM-DD
            ends_on      TEXT    NOT NULL,   -- 期末日 YYYY-MM-DD
            generated_at INTEGER NOT NULL,   -- 生成时刻，Unix 秒
            facts_json   TEXT    NOT NULL,
            sheet        TEXT    NOT NULL,
            body         TEXT    NOT NULL,   -- 正文（模型写的，或本地模板写的）
            source       TEXT    NOT NULL,   -- 'llm' | 'template'
            model        TEXT,               -- 生成用的模型名；source='template' 时为 NULL
            note         TEXT,               -- 降级的解释；成功时为 NULL
            PRIMARY KEY (period_type, period_key)
        );
        ",
    )?;

    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current < SCHEMA_VERSION {
        migrate(conn, current)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    Ok(())
}

/// 从 `from` 版本迁移到 `SCHEMA_VERSION`。
///
/// v1 → v2 和 v2 → v3 都不需要额外动作：`key_stats` 和 `reports` 都是全新表，
/// 上面 `init` 里的 `CREATE TABLE IF NOT EXISTS` 已经建好了。只有**改动已有表结构**
/// （加列、改类型、回填数据）才需要在这里写迁移。
fn migrate(_conn: &Connection, _from: i64) -> SqlResult<()> {
    Ok(())
}
