import { useCallback, useEffect, useState } from "react";
import { ThemeContext, useTheme } from "./lib/useTheme";
import type { MetricMode } from "./lib/metrics";
import * as api from "./lib/api";
import { Today } from "./pages/Today";
import { Hours } from "./pages/Hours";
import { Duration } from "./pages/Duration";
import { Trends } from "./pages/Trends";
import { Heat } from "./pages/Heat";
import { Keys } from "./pages/Keys";
import { Apps } from "./pages/Apps";
import { Detail } from "./pages/Detail";
import { Report } from "./pages/Report";
import { Adapter } from "./pages/Adapter";
import { Settings } from "./pages/Settings";
import { num } from "./lib/metrics";

/**
 * 一页只做一件事。原来五页里的功能一个没少，只是拆开了：
 * 今日的时长独立成一页、小时图独立成一页、应用分布和明细表各一页、
 * 设置里的适配器和未覆盖应用也单独成页。
 */
const PAGES = [
  { id: "today", label: "今天", range: null },
  { id: "hours", label: "时段", range: null },
  { id: "duration", label: "时长", range: "day" },
  { id: "trends", label: "趋势", range: "day" },
  { id: "heat", label: "热力", range: "day" },
  { id: "keys", label: "键位", range: "key" },
  { id: "apps", label: "应用", range: null },
  { id: "detail", label: "明细", range: null },
  // 汇总阅读页，不是图表页：`range: null` 让顶栏那条区间栏不出现——
  // 周/月怎么分是这个页面自己的事，和「近 7 天」不是一回事。
  { id: "report", label: "总结", range: null },
  { id: "adapter", label: "适配器", range: null },
  { id: "settings", label: "设置", range: null },
] as const;

type PageId = (typeof PAGES)[number]["id"];

/** 键位的区间多一个「今天」——看键位时通常就是想看今天按了什么。 */
const RANGE_DAY = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
] as const;

const RANGE_KEY = [
  { days: 1, label: "今天" },
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
] as const;

/** 口径偏好存在本地：这是个人习惯，不该每次开窗都重新选一遍。 */
const METRIC_KEY = "typestat.metric";

function loadMetric(): MetricMode {
  try {
    return localStorage.getItem(METRIC_KEY) === "key" ? "key" : "char";
  } catch {
    return "char";
  }
}

export default function App() {
  const [mode, setMode] = useTheme();
  const [page, setPage] = useState<PageId>("today");
  const [day, setDay] = useState<string | null>(null);
  const [status, setStatus] = useState<api.HookStatus | null>(null);
  // 统计口径：'char' 精确字数 / 'key' 按键数。全局一致，所有页面同时切换——
  // 不能一页一个口径，否则同一份数据在两页显示成不同的数，没法互相印证。
  const [metric, setMetric] = useState<MetricMode>(loadMetric);
  // 区间也全局一份：在「时长」里选了 30 天，切到「趋势」还是 30 天，
  // 否则每换一页都要重选一次，而那正是你想对比的上下文。
  const [range, setRange] = useState<number>(7);
  const [keyRange, setKeyRange] = useState<number>(7);
  // 采集线程每次落库都会递增它，各页面据此重新拉数据。
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    api.currentDay().then(setDay).catch(console.error);
  }, []);

  useEffect(() => {
    const poll = () => api.hookStatus().then(setStatus).catch(console.error);
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unlisten = api.onStatsUpdated(() => setRevision((r) => r + 1));
    return () => {
      // 订阅失败要看得出来。真失败了这条链是断的——界面会一直停在旧数据上
      // 却不报错，那比抛出来难查得多。
      unlisten.then((f) => f()).catch(console.error);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setMode(mode === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  const changeMetric = useCallback((m: MetricMode) => {
    setMetric(m);
    try {
      localStorage.setItem(METRIC_KEY, m);
    } catch {
      /* 存不上不影响本次使用 */
    }
  }, []);

  const meta = PAGES.find((p) => p.id === page)!;
  const rangeKind = meta.range;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">TypeStat</span>
        <nav className="nav" aria-label="页面">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className="nav-item"
              aria-current={page === p.id ? "page" : undefined}
              onClick={() => setPage(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {status && (
          <span
            className="pill"
            title={`本次运行已捕获 ${num(status.eventCount)} 个按键事件`}
          >
            <span className={`dot ${status.alive ? "dot-ok" : "dot-bad"}`} />
            {status.alive ? "钩子运行中" : "钩子未运行"}
          </span>
        )}
        {/* 口径开关。放顶栏而不是各页里：口径必须全局一致，
            否则同一份数据在「今天」和「应用」两页会显示成不同的数。 */}
        <div className="seg" role="group" aria-label="统计口径">
          <button
            className="seg-btn"
            aria-pressed={metric === "char"}
            title="精确字数——只覆盖装了适配器的应用"
            onClick={() => changeMetric("char")}
          >
            字数
          </button>
          <button
            className="seg-btn"
            aria-pressed={metric === "key"}
            title="按键数——覆盖所有应用，但粒度是「键」不是「字」"
            onClick={() => changeMetric("key")}
          >
            按键
          </button>
        </div>
        <button className="tog" onClick={toggleTheme}>
          {mode === "dark" ? "浅色" : "深色"}
        </button>
      </header>

      {/* 区间只对用到它的页面出现。放在顶栏外面，因为它管的是页面内容，
          不是全局状态——而口径开关是全局的，所以它留在顶栏里。 */}
      {rangeKind && (
        <div className="rangebar">
          <span className="lbl">区间</span>
          <div className="seg" role="group" aria-label="时间区间">
            {(rangeKind === "key" ? RANGE_KEY : RANGE_DAY).map((r) => {
              const active = (rangeKind === "key" ? keyRange : range) === r.days;
              return (
                <button
                  key={r.days}
                  className="seg-btn"
                  aria-pressed={active}
                  onClick={() =>
                    rangeKind === "key" ? setKeyRange(r.days) : setRange(r.days)
                  }
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <main className="content">
        <ThemeContext.Provider value={mode}>
          {!day ? (
            <div className="empty">正在加载…</div>
          ) : page === "today" ? (
            <Today day={day} revision={revision} metric={metric} />
          ) : page === "hours" ? (
            <Hours day={day} revision={revision} metric={metric} />
          ) : page === "duration" ? (
            <Duration day={day} revision={revision} days={range} />
          ) : page === "trends" ? (
            <Trends day={day} revision={revision} metric={metric} days={range} />
          ) : page === "heat" ? (
            <Heat day={day} revision={revision} days={range} />
          ) : page === "keys" ? (
            <Keys day={day} revision={revision} days={keyRange} />
          ) : page === "apps" ? (
            <Apps day={day} revision={revision} metric={metric} />
          ) : page === "detail" ? (
            <Detail day={day} revision={revision} />
          ) : page === "report" ? (
            // **只给 `day`。** 口径不传：正文是存档的，跟着开关走会在为另一种
            // 口径写的正文底下重新标注数字（见 Report.tsx 开头）。
            // `revision` 也不传：已结束的期是冻结的，没有任何东西会变。
            <Report day={day} />
          ) : page === "adapter" ? (
            <Adapter day={day} revision={revision} />
          ) : (
            <Settings day={day} revision={revision} />
          )}
        </ThemeContext.Provider>
      </main>
    </div>
  );
}
