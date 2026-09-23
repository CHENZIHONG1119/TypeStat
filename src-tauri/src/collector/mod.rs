//! 采集 worker：消费事件流 → 分类计数 → 按「分钟 × 应用」聚合 → 落库。
//!
//! 单独跑在一条线程上，独占 SQLite 写连接。钩子线程只负责把事件丢进队列，
//! 绝不碰数据库——两条线程的职责界限就是那条 300ms 的回调红线。

pub mod app;
pub mod classify;
pub mod repeat;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use chrono::Local;
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
    buckets: HashMap<(i64, String), Bucket>,
    /// 键位使用频次。键是 (日期, vkCode, scanCode, 是否扩展键)——后三项一起
    /// 才能唯一确定一个物理按键（见 schema.rs 里 `key_stats` 的注释）。
    key_counts: HashMap<(String, u32, u32, bool), i64>,
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
        match msg {
            CollectMsg::Key(ev) => self.handle_key(ev),
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
            CollectMsg::Reset => {
                // 钩子刚重建，按键状态已经不可信，全部清空。
                self.repeat.reset();
                self.classifier.reset();
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
        let day = Local::now().format("%Y-%m-%d").to_string();
        *self
            .key_counts
            .entry((day, ev.vk_code, ev.scan_code, ev.extended))
            .or_insert(0) += 1;
    }

    fn bucket_for(&mut self, app: &str) -> &mut Bucket {
        let now = Local::now();
        let minute = now.timestamp() / 60;
        let day = now.format("%Y-%m-%d").to_string();
        let hour = now.format("%H").to_string().parse::<i64>().unwrap_or(0);

        self.buckets
            .entry((minute, app.to_string()))
            .or_insert_with(|| Bucket {
                local_day: day,
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

        let keys: Vec<KeyUsageDelta> = taken_keys
            .iter()
            .map(|((day, vk, scan, ext), count)| KeyUsageDelta {
                local_day: day.clone(),
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
