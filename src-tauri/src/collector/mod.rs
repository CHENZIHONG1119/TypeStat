//! 采集 worker：消费事件流 → 分类计数 → 按「分钟 × 应用」聚合 → 落库。
//!
//! 单独跑在一条线程上，独占 SQLite 写连接。钩子线程只负责把事件丢进队列，
//! 绝不碰数据库——两条线程的职责界限就是那条 300ms 的回调红线。

pub mod app;
pub mod classify;
mod clock;
pub mod pause;
pub mod repeat;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError};
use rusqlite::Connection;

use crate::db::{self, KeyUsageDelta, StatDelta};
use crate::msg::{CharSource, CollectMsg, RawKeyEvent};

use self::classify::KeyKind;

/// 队列积压超过这个长度时，钩子侧会丢弃新事件而不是阻塞回调。
pub const QUEUE_CAPACITY: usize = 8192;

/// 无事件时最多等多久醒一次，用来判断「输入burst 结束，该落库了」。
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 最后一次击键之后静默多久，就把数据落库并通知 UI。
const QUIET_PERIOD: Duration = Duration::from_secs(1);

/// 单个「分钟 × 应用」的累计量。
#[derive(Debug, Default, Clone)]
pub struct Bucket {
    pub local_day: String,
    pub local_hour: i64,
    pub key_input: i64,
    pub key_delete: i64,
    pub key_other: i64,
    pub char_input: i64,
    pub char_delete: i64,
    pub char_source: Option<CharSource>,
}

impl Bucket {
    /// 落库失败时把数据合并回内存，等下一轮重试，避免丢数据。
    fn merge(&mut self, other: &Bucket) {
        self.key_input += other.key_input;
        self.key_delete += other.key_delete;
        self.key_other += other.key_other;
        self.char_input += other.char_input;
        self.char_delete += other.char_delete;
        if other.char_source.is_some() {
            self.char_source = other.char_source;
        }
    }
}

pub struct Collector {
    rx: Receiver<CollectMsg>,
    conn: Connection,
    repeat: repeat::RepeatFilter,
    classifier: classify::KeyClassifier,
    resolver: app::AppResolver,
    /// 「现在几点」只从这里走。理由（既是热路径，也是唯一能 panic 的稳态路径）
    /// 见 `clock` 模块的头注释。
    clock: clock::Clock,
    buckets: HashMap<(i64, String), Bucket>,
    /// 键位使用频次。键是 (本地纪元日, vkCode, scanCode, 是否扩展键)——后三项一起
    /// 才能唯一确定一个物理按键（见 schema.rs 里 `key_stats` 的注释）。
    ///
    /// **日期那一格存的是天数，不是 `YYYY-MM-DD` 串**：串要 `format!`，而这个 map
    /// 每次按键都要 `entry` 一次，写成串就是每次按键一次堆分配。串等到 `flush`
    /// 落库的时候再造，那时一天只造一次。
    key_counts: HashMap<(i64, u32, u32, bool), i64>,
    /// 上次收到事件的时刻。用 Instant 而不是事件里的时间戳，是为了不受系统时基影响。
    last_event_at: Option<Instant>,
    dirty_tx: crossbeam_channel::Sender<()>,
}

impl Collector {
    pub fn new(
        rx: Receiver<CollectMsg>,
        conn: Connection,
        dirty_tx: crossbeam_channel::Sender<()>,
    ) -> Self {
        Self {
            rx,
            conn,
            repeat: repeat::RepeatFilter::new(),
            classifier: classify::KeyClassifier::new(),
            resolver: app::AppResolver::new(),
            clock: clock::Clock::new(),
            buckets: HashMap::new(),
            key_counts: HashMap::new(),
            last_event_at: None,
            dirty_tx,
        }
    }

    pub fn run(mut self) {
        loop {
            match self.rx.recv_timeout(POLL_INTERVAL) {
                Ok(msg) => {
                    self.last_event_at = Some(Instant::now());
                    self.handle(msg);
                }
                Err(RecvTimeoutError::Timeout) => {
                    // 输入停下来之后尽快落库，UI 才能近实时刷新。
                    if self.should_flush() {
                        self.flush();
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.flush();
                    break;
                }
            }
        }
    }

    fn should_flush(&self) -> bool {
        // 两个累加器都要看：只按住 Shift 不放时 buckets 是空的（修饰键不产生
        // 字符口径的事件），但 key_counts 有数据，漏判会导致键位频次一直不落库。
        if self.buckets.is_empty() && self.key_counts.is_empty() {
            return false;
        }
        match self.last_event_at {
            Some(t) => t.elapsed() >= QUIET_PERIOD,
            None => true,
        }
    }

    fn handle(&mut self, msg: CollectMsg) {
        // 钩子侧的清空请求优先于一切，而且必须在**处理这一条之前**生效：
        // 请求的含义是「中间丢过 keyup，按键状态已经不可信」，
        // 而手上这一条正是拿那份不可信状态去判的第一条。
        //
        // 放在这里而不是放到循环的等待分支上，也是为了让重建后的第一个事件
        // 就落在干净状态上——重建一直在持续打字的时候发生。
        if crate::msg::take_reset() {
            self.repeat.reset();
            self.classifier.reset();
        }

        // 暂停期间什么都不记，**但 reset 请求照收**（在上面）：暂停时收到的那次
        // 清空请求如果被跳过，恢复之后就会拿着脱节的状态继续判。
        if pause::is_paused() {
            return;
        }

        match msg {
            CollectMsg::Key(ev) => self.handle_key(ev),
            // 落库。手上没东西时 `flush` 自己会早退。
            CollectMsg::Flush => self.flush(),
            CollectMsg::Chars {
                app,
                input,
                delete,
                source,
            } => {
                let b = self.bucket_for(&app);
                b.char_input += input;
                b.char_delete += delete;
                b.char_source = Some(source);
            }
        }
    }

    fn handle_key(&mut self, ev: RawKeyEvent) {
        // 注入事件（SendInput / 宏 / 自动化脚本）一律丢弃，
        // 否则自己的测试脚本会把数据污染掉。
        if ev.injected {
            return;
        }

        if ev.is_down {
            // 自动重复过滤必须跑在**所有**键上，包括修饰键。
            // 长按 Shift 系统会持续补发 keydown，不过滤就会把一次长按
            // 记成几百次键位使用。
            if !self.repeat.on_key_down(ev.vk_code, ev.scan_code) {
                return;
            }

            let kind = self.classifier.on_key_down(ev.vk_code);

            // 键位频次记每一个真实按下的物理键，修饰键和 Ctrl 组合也算——
            // 这张图回答的是"哪个键被我按得最多"，不是"哪个键产出了字符"，
            // 所以刻意不复用 KeyKind 那套过滤。
            self.bump_key_usage(&ev);

            let kind = match kind {
                Some(k) => k,
                // 纯修饰键不产生字符，字符口径不入账。
                None => return,
            };

            let app = self.resolver.resolve(ev.hwnd);
            let b = self.bucket_for(&app);
            match kind {
                KeyKind::Input => b.key_input += 1,
                KeyKind::Delete => b.key_delete += 1,
                KeyKind::Other => b.key_other += 1,
            }
        } else {
            self.repeat.on_key_up(ev.vk_code, ev.scan_code);
            self.classifier.on_key_up(ev.vk_code);
        }
    }

    fn bump_key_usage(&mut self, ev: &RawKeyEvent) {
        let (_, _, epoch_day) = self.clock.stamp();
        *self
            .key_counts
            .entry((epoch_day, ev.vk_code, ev.scan_code, ev.extended))
            .or_insert(0) += 1;
    }

    fn bucket_for(&mut self, app: &str) -> &mut Bucket {
        let (minute, hour, epoch_day) = self.clock.stamp();

        self.buckets
            .entry((minute, app.to_string()))
            .or_insert_with(|| Bucket {
                // 日期串只在这一分钟第一次碰到这个应用时才造一次，不是每次按键。
                local_day: clock::day_string(epoch_day),
                local_hour: hour,
                ..Default::default()
            })
    }

    fn flush(&mut self) {
        if self.buckets.is_empty() && self.key_counts.is_empty() {
            return;
        }

        let taken = std::mem::take(&mut self.buckets);
        let taken_keys = std::mem::take(&mut self.key_counts);

        let deltas: Vec<StatDelta> = taken
            .iter()
            .map(|((minute, app), b)| StatDelta {
                minute: *minute,
                local_day: b.local_day.clone(),
                local_hour: b.local_hour,
                app: app.clone(),
                key_input: b.key_input,
                key_delete: b.key_delete,
                key_other: b.key_other,
                char_input: b.char_input,
                char_delete: b.char_delete,
                char_source: b.char_source.map(|s| s.as_str()),
            })
            .collect();

        // 纪元日 → `YYYY-MM-DD`。备忘一份：`local_day` 是 String，每个键位一行都要
        // 一份，而一次落库动辄几十个键位、日期通常只有一个。日历算一次就够，
        // 别一个键位算一次。
        let mut days: HashMap<i64, String> = HashMap::new();
        let keys: Vec<KeyUsageDelta> = taken_keys
            .iter()
            .map(|((epoch_day, vk, scan, ext), count)| KeyUsageDelta {
                local_day: days
                    .entry(*epoch_day)
                    .or_insert_with(|| clock::day_string(*epoch_day))
                    .clone(),
                vk_code: *vk,
                scan_code: *scan,
                extended: *ext,
                count: *count,
            })
            .collect();

        match db::write_batch(&mut self.conn, &deltas, &keys) {
            Ok(()) => {
                // 通知 UI 有新数据。UI 收到后自己去查库，不在这里拼装。
                let _ = self.dirty_tx.try_send(());
            }
            Err(e) => {
                eprintln!("[typestat] 落库失败，数据保留待重试: {e}");
                for ((minute, app), b) in taken {
                    self.buckets
                        .entry((minute, app))
                        .or_insert_with(|| Bucket {
                            local_day: b.local_day.clone(),
                            local_hour: b.local_hour,
                            ..Default::default()
                        })
                        .merge(&b);
                }
                for (k, count) in taken_keys {
                    *self.key_counts.entry(k).or_insert(0) += count;
                }
            }
        }
    }
}

/// 启动采集线程。
pub fn spawn(
    rx: Receiver<CollectMsg>,
    conn: Connection,
    dirty_tx: crossbeam_channel::Sender<()>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("typestat-collector".into())
        .spawn(move || Collector::new(rx, conn, dirty_tx).run())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    /// 采集器写进库的日期和小时，必须**就是这台机器此刻的本地时间**。
    ///
    /// 这是守 `clock` 那次改动的：日期和小时从「每次按键都问 chrono 要一个格式化
    /// 好的串」改成了「自己拿秒数加偏移算」。算错了不会报错——只会安静地记到别的
    /// 日子或别的小时上，翻半天看不出来。而 `clock` 自己的单元测试只验了算式，
    /// 验不了「采集器真的把那个结果写进了库」。
    ///
    /// 走的是真路径：造一个真按键事件、落库、再从库里读回来比。用内存库，
    /// 不碰用户的数据。
    #[test]
    fn 落库的日期和小时就是本机的本地时间() {
        let conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        let (_tx, rx) = crossbeam_channel::unbounded();
        let (dirty_tx, _dirty_rx) = crossbeam_channel::unbounded();
        let mut collector = Collector::new(rx, conn, dirty_tx);

        // 直接调 `handle_key` 而不是 `handle`：绕开那个全局的暂停开关。
        // 它是进程级的，`pause.rs` 自己的测试会在别的线程上把它拨来拨去，
        // 于是「有没有落库」就成了一个看运气的断言。暂停那条分支不是这里要验的。
        collector.handle_key(RawKeyEvent {
            vk_code: 0x41, // A
            scan_code: 0x1e,
            extended: false,
            is_down: true,
            injected: false,
            time: 0,
            // 0 号窗口解析不出进程，应用名会是 `unknown`——正好，
            // 不依赖跑测试时前台开着什么。
            hwnd: 0,
        });
        collector.flush();

        let now = chrono::Local::now();
        let want_day = now.format("%Y-%m-%d").to_string();
        let want_hour: i64 = now.format("%H").to_string().parse().unwrap();

        let (day, hour): (String, i64) = collector
            .conn
            .query_row("SELECT local_day, local_hour FROM minute_stats", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .expect("那一下按键应当落了一行");
        assert_eq!(day, want_day, "日期记到别的日子上了");
        assert_eq!(hour, want_hour, "小时记错了");

        // 键位那张表走的是另一条路（内存里存的是纪元日，落库那一刻才变成串），
        // 两条路都得对上——界面上它们是两张不同的图，各自读各自的列。
        let key_day: String = collector
            .conn
            .query_row("SELECT local_day FROM key_stats", [], |r| r.get(0))
            .expect("键位频次也应当落了一行");
        assert_eq!(key_day, want_day, "键位那张表记到别的日子上了");
    }
}
