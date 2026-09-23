import { useCallback, useEffect, useState } from "react";
import { ThemeContext, useTheme } from "./lib/useTheme";
import type { MetricMode } from "./lib/metrics";
import * as api from "./lib/api";
import { DayBar } from "./components/DayBar";
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

/**
 * 哪些页面跟着日期导航走。
 *
 * 其余三页**刻意不跟**：总结有自己的期次条（周/月），再叠一层日期会让
 * 「当前期」的含义跟着变；适配器和设置讲的是程序本身，没有日期这回事。
 * 它们始终看真正的今天。
 */
const DAY_PAGES = new Set<PageId>([
  "today",
  "hours",
  "duration",
  "trends",
  "heat",
  "keys",
  "apps",
  "detail",
]);

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
  /**
   * 正在看哪一天。`null` 是「跟着今天走」。
   *
   * **刻意不存成字符串**：存一个具体日期的话，选的是「今天」这件事会在跨过午夜
   * 之后悄悄变成「昨天」，而用户没有选过昨天。`null` 让「看着今天」变成一种状态，
   * 而不是一个会被时间改写的值。
   */
  const [viewDay, setViewDay] = useState<string | null>(null);
  // 暂停状态。**存在这里而不是设置页里**：托盘菜单能随时改它，
  // 而顶栏必须跟着变——正在记录还是没在记录，是这一屏最要紧的一件事。
  // `null` 是「还没读到」，此时顶栏照常显示钩子状态（保守的那一面）。
  const [paused, setPaused] = useState<boolean | null>(null);
  // 第一次收进托盘时那条说明。只出现一次，见下面 `window-hidden` 的订阅。
  const [trayHint, setTrayHint] = useState(false);

  useEffect(() => {
    // 「今天」是个会过期的值。只在挂载时取一次的话，程序一直开着跨过午夜之后
    // 会继续显示昨天，而且**永远不会自己纠正**——那一页会一直停在前一天，
    // 用户看到的「今天」是假的。每分钟对一次，顺带把时区调整也带上。
    const sync = () => api.currentDay().then(setDay).catch(console.error);
    sync();
    const id = setInterval(sync, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const poll = () => api.hookStatus().then(setStatus).catch(console.error);
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const unlisten = api.onStatsUpdated(() => {
      setRevision((r) => r + 1);
      // 顺手对一次日期：午夜过后第一批数据落库时就能立刻翻页，不用等下一分钟的轮询。
      // 值没变时 React 会直接跳过重渲染，所以这条不是热路径上的负担。
      api.currentDay().then(setDay).catch(console.error);
    });
    return () => {
      // 订阅失败要看得出来。真失败了这条链是断的——界面会一直停在旧数据上
      // 却不报错，那比抛出来难查得多。
      unlisten.then((f) => f()).catch(console.error);
    };
  }, []);

  useEffect(() => {
    // 托盘菜单拨的开关。窗口没收起来时（正开着设置页）这一屏要跟着动，
    // 否则菜单里打着勾、页面上写着「记录中」，而用户没有别的办法判断哪个是真的。
    api.pauseStatus().then(setPaused).catch(console.error);
    const unlisten = api.onPauseChanged(setPaused);
    return () => {
      unlisten.then((f) => f()).catch(console.error);
    };
  }, []);

  useEffect(() => {
    // 点 X 收进托盘。**只在第一次**说一句：安静地把程序留在后台运行而不告诉
    // 用户，是这个项目一直在防的那种「界面和事实不符」。之后不再啰嗦——
    // 「是不是第一次」跟着人走，所以判断留在前端，不写进注册表。
    const ONCE_KEY = "typestat.tray-hint-seen";
    const unlisten = api.onWindowHidden(() => {
      let seen = false;
      try {
        seen = localStorage.getItem(ONCE_KEY) === "1";
      } catch {
        /* 读不到就当没看过，最多多提示一次 */
      }
      if (seen) return;
      try {
        localStorage.setItem(ONCE_KEY, "1");
      } catch {
        /* 存不上不影响这次提示 */
      }
      setTrayHint(true);
    });
    return () => {
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
  const navigable = DAY_PAGES.has(page);
  // 正在看的那一天。`day` 是真正的今天，`viewDay` 是用户翻过去的那个日子。
  const dataDay = navigable && viewDay !== null ? viewDay : (day ?? "");

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
        {/* 暂停时把这一格换成「已暂停」而不是再加一格：这一格回答的是
            「现在敲的会不会被记下来」，而暂停时答案就是「不会」——
            并排摆两个胶囊的话，最要紧的那个反而要用户自己去找。
            钩子本身还在跑，所以标题里把事件数留着。 */}
        {paused === true ? (
          <span className="pill" title={`已暂停。本次运行仍捕获了 ${num(status?.eventCount ?? 0)} 个按键事件，但暂停期间的不会入库`}>
            <span className="dot dot-warn" />
            已暂停记录
          </span>
        ) : (
          status && (
            <span
              className="pill"
              title={`本次运行已捕获 ${num(status.eventCount)} 个按键事件`}
            >
              <span className={`dot ${status.alive ? "dot-ok" : "dot-bad"}`} />
              {status.alive ? "钩子运行中" : "钩子未运行"}
            </span>
          )
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

      {/* 第一次收进托盘时的一条说明。它只出现一次，而且**必须出现**：
          窗口消失而程序还在跑，不说明白就等于界面和事实不符。 */}
      {trayHint && (
        <div className="banner">
          <span className="lbl">已收进托盘</span>
          <span className="txt">
            窗口关掉了，但 <b>TypeStat 还在后台计数</b>。
            左键点托盘图标把窗口叫回来，右键出菜单（打开 / 暂停 / 退出）。
          </span>
          <button className="tog" onClick={() => setTrayHint(false)}>
            知道了
          </button>
        </div>
      )}

      {/* 日期导航。位置和区间栏一样在顶栏外面——它管的也是页面内容。
          只在跟着日期走的页面上出现：总结有自己的期次条，适配器和设置没有日期。 */}
      {day && navigable && (
        <DayBar day={dataDay} today={day} onPick={setViewDay} />
      )}

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
            <Today day={dataDay} today={day} revision={revision} metric={metric} />
          ) : page === "hours" ? (
            <Hours day={dataDay} today={day} revision={revision} metric={metric} />
          ) : page === "duration" ? (
            <Duration day={dataDay} today={day} revision={revision} days={range} />
          ) : page === "trends" ? (
            <Trends day={dataDay} revision={revision} metric={metric} days={range} />
          ) : page === "heat" ? (
            <Heat day={dataDay} revision={revision} days={range} />
          ) : page === "keys" ? (
            <Keys day={dataDay} today={day} revision={revision} days={keyRange} />
          ) : page === "apps" ? (
            <Apps day={dataDay} today={day} revision={revision} metric={metric} />
          ) : page === "detail" ? (
            <Detail day={dataDay} today={day} revision={revision} />
          ) : page === "report" ? (
            // **只给 `day`。** 口径不传：正文是存档的，跟着开关走会在为另一种
            // 口径写的正文底下重新标注数字（见 Report.tsx 开头）。
            // `revision` 也不传：已结束的期是冻结的，没有任何东西会变。
            <Report day={day} />
          ) : page === "adapter" ? (
            <Adapter day={day} revision={revision} />
          ) : (
            // **`today` 不是 `dataDay`。** 设置页不在 `DAY_PAGES` 里、没有日期导航，
            // 所以「近 7 天」这种话在这里只有一个可能的读法：到今天为止。
            // 传 `dataDay` 的话，导出的区间会跟着一个**这一页上看不见的**选择走，
            // 而按下去之前谁也看不出拿到的是哪七天。
            // 名字叫 `today` 而不是 `day`：别的页面 `day` 一律是「正在看的那天」，
            // 沿用那个名字，下次想加个跟导航走的字段时会拿到今天而不会报错。
            <Settings
              today={day}
              revision={revision}
              paused={paused}
              setPaused={setPaused}
            />
          )}
        </ThemeContext.Provider>
      </main>
    </div>
  );
}
