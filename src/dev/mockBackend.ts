/**
 * 浏览器里跑的假后端 —— **只在开发时用**。
 *
 * Tauri 的 `invoke` 是薄薄一层转发，落到 `window.__TAURI_INTERNALS__.invoke` 上。
 * 所以在浏览器里把这层垫掉，整个界面就能跑起来，不用开 Tauri 壳。
 * 这对前端调试很重要：改一个 CSS 值就开一次 Rust 编译是没法调界面的。
 *
 * 数据以 2026-09-23 这一天为准（那天四个时段有输入，其中只有 17 时拿得到字数），
 * 其余 13 天是种子固定的模拟值。**这些数字只用来验版式，不要拿来核对逻辑。**
 */

import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";
import { formatMinutes, num, pct } from "../lib/metrics";
import type {
  AppPoint,
  HourPoint,
  PeriodSlot,
  ReportDetail,
  ReportFacts,
  ReportSettings,
  TodaySummary,
} from "../lib/api";

const TODAY = "2026-09-23";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function shift(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
}

/**
 * 某个本地时刻的 Unix 分钟戳。
 *
 * `first_minute` / `last_minute` 存的是 `now.timestamp() / 60`（真 Unix 分钟），
 * 不是「当天第几分钟」。这里必须按真值造——用「当天第几分钟」的话，
 * 前端 `minuteLabel` 拿它当地元时间戳解析，在东八区会把 16:03 显示成 00:03，
 * 而且看起来只是个不太对的时间，不会报错。
 */
function unixMinute(day: string, hhmm: string): number {
  return Math.floor(new Date(`${day}T${hhmm}:00`).getTime() / 60000);
}

/** 固定种子的 PRNG：每次刷新看到的图形必须一模一样，否则没法比较两次改动。 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 今天：真实数据。 */
const TODAY_HOURS: HourPoint[] = [
  { hour: 16, keyInput: 2307, keyDelete: 73, charInput: 0, charDelete: 0, hasChar: false, charKeyInput: 0 },
  { hour: 17, keyInput: 2109, keyDelete: 146, charInput: 7415, charDelete: 118, hasChar: true, charKeyInput: 1902 },
  { hour: 19, keyInput: 200, keyDelete: 11, charInput: 0, charDelete: 0, hasChar: false, charKeyInput: 0 },
  { hour: 20, keyInput: 222, keyDelete: 10, charInput: 0, charDelete: 0, hasChar: false, charKeyInput: 0 },
];

const TODAY_APPS: AppPoint[] = [
  { app: "wps.exe", keyInput: 3340, charInput: 7415, charDelete: 118, charSource: "plugin" },
  { app: "WindowsTerminal.exe", keyInput: 1432, charInput: 0, charDelete: 0, charSource: null },
  { app: "Weixin.exe", keyInput: 57, charInput: 0, charDelete: 0, charSource: null },
  { app: "msedge.exe", keyInput: 7, charInput: 0, charDelete: 0, charSource: null },
  { app: "哔哩哔哩.exe", keyInput: 2, charInput: 0, charDelete: 0, charSource: null },
];

// ——————————————————————————————————————————————————————————————
// 单日夹具：从 `DAILY` 那一行派生
// ——————————————————————————————————————————————————————————————
//
// 日期导航要求「今天」这一组命令能回答**任何一天**。对任何一天都返回同一份固定
// 夹具是不行的：那样翻到 9/23 看到的数字和今天一模一样，既看不出页面有没有真的
// 重新取数，也和趋势图上同一天的数字对不上——而「同一份数据在不同页上必须对得上」
// 正是这个程序一直在守的事。
//
// 所以下面这几个函数都从 `DAILY` 那一行派生：量级跟着那一天走，
// 有没有字数的分界（`hasChar`）也跟着那一天走。

/**
 * 某个应用列表按比例缩放。
 *
 * 应用名、顺序、谁是适配器应用都不变，只有量级跟着走。`withChar` 为假时
 * **所有应用的 `charSource` 都置成 null**：那一天本来就没有适配器上报过，
 * 留着 `"plugin"` 会让明细页在「这天一个字都没量到」的页面上同时显示精确字数。
 */
function scaleApps(factor: number, withChar: boolean, total: number): AppPoint[] {
  const rows = TODAY_APPS.map((a) => {
    const source = withChar ? a.charSource : null;
    return {
      ...a,
      keyInput: Math.max(0, Math.round(a.keyInput * factor)),
      charSource: source,
      charInput: source === null ? 0 : Math.round(a.charInput * factor),
      charDelete: source === null ? 0 : Math.round(a.charDelete * factor),
    };
  });
  // 每一行各自取整之后，加起来和当天总数差一两个。**把零头补给最大的那一行**：
  // 明细页的「合计」和时段页的「这一天合计」印的是同一个数，
  // 差一次都会看起来像程序算错了——而这一页最要紧的事就是能对上账。
  const diff = total - rows.reduce((s, r) => s + r.keyInput, 0);
  if (diff !== 0) {
    const big = rows.reduce((m, r) => (r.keyInput > m.keyInput ? r : m), rows[0]);
    big.keyInput = Math.max(0, big.keyInput + diff);
  }
  return rows;
}

/** 今天那份手写的真值。抽出来是因为 `summaryOf` 之外还有别的调用方要它。 */
const TODAY_SUMMARY: TodaySummary = {
  day: TODAY,
  keyInput: 4838,
  keyDelete: 240,
  keyOther: 209,
  charInput: 7415,
  charDelete: 118,
  netChars: 7297,
  deleteRate: 118 / 7415,
  hasCharData: true,
  preciseKeyInput: 3340,
  preciseApps: ["wps.exe"],
  uncoveredApps: ["WindowsTerminal.exe", "Weixin.exe", "msedge.exe", "哔哩哔哩.exe"],
  activeMinutes: 82,
  sessionMinutes: 111,
  longestMinutes: 62,
  preciseMinutes: 15,
  firstMinute: unixMinute(TODAY, "16:03"),
  lastMinute: unixMinute(TODAY, "20:11"),
};

/** 不在 `DAILY` 里的日子（比 90 天还早）：什么都没有，而且**没有字数**。 */
function emptySummary(day: string): TodaySummary {
  return {
    day,
    keyInput: 0,
    keyDelete: 0,
    keyOther: 0,
    charInput: 0,
    charDelete: 0,
    netChars: 0,
    deleteRate: 0,
    hasCharData: false,
    preciseKeyInput: 0,
    preciseApps: [],
    uncoveredApps: [],
    activeMinutes: 0,
    sessionMinutes: 0,
    longestMinutes: 0,
    preciseMinutes: 0,
    firstMinute: 0,
    lastMinute: 0,
  };
}

function summaryOf(day: string): TodaySummary {
  if (day === TODAY) return TODAY_SUMMARY;
  const d = DAILY.find((x) => x.day === day);
  if (!d) return emptySummary(day);
  const hasChar = d.hasChar;
  return {
    day,
    keyInput: d.keyInput,
    keyDelete: d.keyDelete,
    keyOther: Math.round(d.keyInput * 0.043),
    charInput: d.charInput,
    charDelete: d.charDelete,
    netChars: d.charInput - d.charDelete,
    deleteRate: d.keyInput > 0 ? d.keyDelete / d.keyInput : 0,
    hasCharData: hasChar,
    // 覆盖率固定 69%：让「只覆盖一部分」这件事在每一页上都看得见。
    preciseKeyInput: hasChar ? Math.round(d.keyInput * 0.69) : 0,
    preciseApps: hasChar ? ["wps.exe"] : [],
    // 没有适配器的那几天，**wps 也是量不到的**——不能把它单独摘出去。
    uncoveredApps: hasChar
      ? ["WindowsTerminal.exe", "Weixin.exe", "msedge.exe", "哔哩哔哩.exe"]
      : ["wps.exe", "WindowsTerminal.exe", "Weixin.exe", "msedge.exe", "哔哩哔哩.exe"],
    activeMinutes: d.activeMinutes,
    sessionMinutes: d.sessionMinutes,
    // 夹具里没有分钟级明细，按一个看着合理的比例造最长的那个时段。
    longestMinutes: Math.max(1, Math.round(d.sessionMinutes * 0.45)),
    preciseMinutes: hasChar ? Math.max(1, Math.round(d.activeMinutes * 0.18)) : 0,
    firstMinute: unixMinute(day, "09:20"),
    lastMinute: unixMinute(day, "21:40"),
  };
}

/**
 * 这一天的小时分布。
 *
 * **各小时的合计等于当天的总按键数**：两个页面上的数对不上只说明夹具是假的，
 * 而「今天说 4,838 次、时段加起来是 4,700 次」正是最容易让人以为程序算错了的地方。
 * 字数也按当天那一行的比例派生，好让明细页和时段页讲同一件事。
 */
function hourPointsOf(day: string): HourPoint[] {
  if (day === TODAY) return TODAY_HOURS;
  const cells = CELLS.filter((c) => c.day === day);
  const d = DAILY.find((x) => x.day === day);
  if (cells.length === 0 || !d) return [];

  const rawSum = cells.reduce((s, c) => s + c.keyInput, 0);
  const charRatio = d.keyInput > 0 ? d.charInput / d.keyInput : 0;
  const delRatio = d.keyInput > 0 ? d.charDelete / d.keyInput : 0;
  const rows: HourPoint[] = cells.map((c) => {
    const keyInput = rawSum > 0 ? Math.round((c.keyInput / rawSum) * d.keyInput) : 0;
    return {
      hour: c.hour,
      keyInput,
      keyDelete: Math.round(keyInput * 0.05),
      charInput: d.hasChar ? Math.round(keyInput * charRatio) : 0,
      charDelete: d.hasChar ? Math.round(keyInput * delRatio) : 0,
      hasChar: d.hasChar,
      charKeyInput: d.hasChar ? Math.round(keyInput * 0.69) : 0,
    };
  });
  // 取整的零头补给最大的一格：不然加起来和当天的总数差几十次。
  const diff = d.keyInput - rows.reduce((s, r) => s + r.keyInput, 0);
  if (diff !== 0) {
    const big = rows.reduce((m, r) => (r.keyInput > m.keyInput ? r : m), rows[0]);
    big.keyInput += diff;
  }
  return rows.sort((a, b) => a.hour - b.hour);
}

/**
 * 键频（真实值，来自库）。
 *
 * **这一份不随区间和日期变**：键位那一页验的是版式和那几个「图外的键」，
 * 不是数字，所以日期导航到哪一天它都一样。别的几页的夹具都跟着 `day` 走，
 * 唯独这一份是常量——这是有意的，不是漏了。
 */
const VK_7D: [number, number, number, boolean][] = [
  // [vk, scan, count, extended]
  [0x49, 0x17, 512, false], [0x20, 0x39, 470, false], [0x4e, 0x31, 448, false],
  [0x41, 0x1e, 397, false], [0x48, 0x23, 297, false], [0x45, 0x12, 292, false],
  [0x47, 0x22, 254, false], [0x55, 0x16, 249, false], [0x08, 0x0e, 221, false],
  [0x4f, 0x18, 166, false], [0x5a, 0x2c, 148, false], [0x53, 0x1f, 126, false],
  [0x44, 0x20, 118, false], [0x4a, 0x24, 99, false], [0x59, 0x15, 80, false],
  [0x46, 0x21, 77, false], [0x4c, 0x26, 65, false], [0x58, 0x2d, 65, false],
  [0x0d, 0x1c, 62, false], [0x51, 0x10, 60, false], [0x43, 0x2e, 53, false],
  [0x42, 0x30, 50, false], [0x4d, 0x32, 47, false], [0x57, 0x11, 45, false],
  [0xbc, 0x33, 42, false], [0x52, 0x13, 37, false], [0x54, 0x14, 37, false],
  [0xdc, 0x2b, 30, false], [0x56, 0x2f, 26, false], [0xa2, 0x1d, 23, false],
  [0x50, 0x19, 21, false], [0xa0, 0x2a, 10, false],
  // 图外的键：扩展键的扫描码不带 E0 前缀，靠 extended 位标记。
  [0x28, 0x50, 93, true], [0x27, 0x4d, 40, true], [0x25, 0x4b, 38, true],
];

/** 90 天的按天汇总。今天用真值，其余按种子造。 */
function dailySeries() {
  const rand = mulberry32(20260923);
  const out = [];
  // 造满 90 天，而不是刚好一个屏幕：近 90 天是顶栏给得出的区间，
  // 90 个点会把轴标签挤到必须隔 9 格才放一个——只造十几天的话，
  // 这条最挤的排法在预览里根本走不到，等真数据上来才发现标签撞在一起。
  for (let i = 89; i >= 0; i--) {
    const day = shift(TODAY, -i);
    if (i === 0) {
      out.push({
        day,
        keyInput: 4838,
        keyDelete: 240,
        charInput: 7415,
        charDelete: 118,
        netChars: 7297,
        hasChar: true,
        activeMinutes: 82,
        sessionMinutes: 111,
      });
      continue;
    }
    const active = 30 + Math.round(rand() * 110);
    const keyInput = active * (40 + Math.round(rand() * 25));
    // 前 80 天假设适配器还没装 → 那些天 hasChar 为 false，折线要断开。
    const charInput = i > 9 ? 0 : Math.round(keyInput * (0.8 + rand() * 0.5));
    // 删除字数按比例派生，**不加新的 `rand()` 调用**：多加一次会把后面每一天的
    // 生成值全部挪位，趋势图和热力图的样子就跟着变了，而那不是这次要改的东西。
    const charDelete = i > 9 ? 0 : Math.round(charInput * 0.03);
    out.push({
      day,
      keyInput,
      keyDelete: Math.round(keyInput * (0.04 + rand() * 0.03)),
      charInput,
      charDelete,
      netChars: charInput - charDelete,
      hasChar: i <= 9,
      activeMinutes: active,
      sessionMinutes: active + Math.round(rand() * 45),
    });
  }
  return out;
}

const DAILY = dailySeries();

/**
 * 「日期 × 小时」网格，和 daily 大致对得上就行。
 *
 * **同一个 `(日期, 小时)` 只出一行。** 随机抽钟点时同一天里可能抽中同一个钟点两次，
 * 而真后端这两条查询（`cell_grid` / `hour_profile`）都是 `GROUP BY` 出来的，
 * 一行就是一格。留两行的话：时段页用 `find(hour)` 取，只认第一行，
 * 于是「这一天合计」比「今天」那一页的敲入按键少了 700 多次；热力图那边
 * 一个格画两遍，后一遍盖掉前一遍。屏幕上看着都正常，加起来对不上——
 * 而「同一份数据在不同页上必须对得上」正是这个程序一直在守的事。
 */
function cellSeries() {
  const rand = mulberry32(777);
  const out = [];
  for (const d of DAILY) {
    const hours = Math.min(23, Math.max(1, Math.round(d.activeMinutes / 22)));
    // 先按钟点合并，再铺出来。**`rand()` 的调用次数和顺序不变**——
    // 多加或早退一次，后面每一天的生成值全部挪位，热力图的样子就跟着变了。
    const byHour = new Map<number, number>();
    for (let k = 0; k < hours; k++) {
      const hour = Math.min(23, 8 + Math.round(rand() * 13));
      const v = Math.round((d.keyInput / hours) * (0.5 + rand()));
      byHour.set(hour, (byHour.get(hour) ?? 0) + v);
    }
    for (const [hour, keyInput] of [...byHour].sort((a, b) => a[0] - b[0])) {
      out.push({
        day: d.day,
        hour,
        keyInput,
        charInput: 0,
        charDelete: 0,
        hasChar: d.hasChar,
      });
    }
  }
  return out;
}

const CELLS = cellSeries();

// ——————————————————————————————————————————————————————————————
// 总结（周期报告）
//
// 夹具的规矩和 `report/fixtures.rs` 一样：**造出来的数字要能互相对上**——
// 按天的和等于总数、按小时的和也等于总数、列出来的应用加上没列出来的
// 还是等于总数。预览里那本账要是自己都对不上，这一页最要紧的那件事
// （正文旁边的数字可以核）在预览里就验不了了。
//
// 期次的状态是刻意排开的，浏览器里够不到的那几种都在：
//   当前期（灰着不能点）、已是模型写的、降级成模板的、整期没有记录的、
//   有数据但还没生成的。
// ——————————————————————————————————————————————————————————————

/**
 * 三个子表**从 `ReportFacts` 上取下来**，不另外定义一份——
 * 另写一份接口就有两份会漂，而夹具漂了以后是「预览对、真机不对」。
 */
type DayRow = ReportFacts["days"][number];
type HourRow = ReportFacts["hours"][number];
type AppRow = ReportFacts["apps"][number];

/** 预览里这一期是不是生成过，以及是谁写的。`null` = 没生成过。 */
type MockMade = "llm" | "template";

interface MockSlot {
  key: string;
  label: string;
  heading: string;
  start: string;
  end: string;
  closed: boolean;
  hasData: boolean;
  made: MockMade | null;
}

/** 和 Rust 侧 `llm::DEFAULT_*` 同一对值。没配过的时候显示的就是这两个。 */
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

/**
 * 控制台上的开关，见文件末尾的 `__mockReport`。
 * 默认 `hasKey: false`——**没配接口的形态是第一次打开这一页就会遇到的形态**，
 * 表单本来就该是展开的，所以默认值就该是这一个。
 */
const mockReport: { hasKey: boolean; keyBroken: boolean; baseUrl: string; model: string } = {
  hasKey: false,
  keyBroken: false,
  baseUrl: "",
  model: "",
};

/** 命令收的是字符串，夹具里收窄一次。认不出来的期次类型当周报——真后端会报错，这里不装这个。 */
const kindOf = (v: unknown): "week" | "month" => (String(v) === "month" ? "month" : "week");

/**
 * 暂停 / 开机自启的假状态。
 *
 * **真实的这两份都不在前端**：暂停是采集线程读的一个原子量，自启是 HKCU Run 键里的
 * 一个值。这里存一份，只为让浏览器能走到那些分支（顶栏的「已暂停」胶囊、自启的
 * 「指向老路径」警告）。开关在文件末尾的 `__mockRuntime`。
 *
 * `autostartError` 默认是 null：真后端在 debug 构建下**必定**拒绝写入自启
 * （`target\debug` 那条路径写进注册表，下次登录会启动一个开发版），
 * 所以在真机上这个开关现在只会失败。预览里默认给成功路径，失败路径手动造——
 * 两条都要能看见。
 */
const mockRuntime: {
  paused: boolean;
  autostart: boolean;
  stale: boolean;
  autostartError: string | null;
} = { paused: false, autostart: false, stale: false, autostartError: null };

/** 当前程序的假路径。和真机上的不一样没关系，要紧的是它**看着像个真路径**。 */
const MOCK_CURRENT_EXE = "C:\\Program Files\\TypeStat\\TypeStat.exe";

/**
 * 导出目录的假路径。
 *
 * **必须长得像真的**：这一格是页面上唯一告诉用户「文件去哪儿了」的地方，
 * 而它太长、太具体，正是那种「一眼扫过去不会细看」的文本——
 * 用 `C:\导出\a.csv` 这种占位符，换行和折行都试不出来。
 */
const MOCK_EXPORT_DIR = "C:\\Users\\27828\\Downloads\\TypeStat";

/** 程序被挪过位置之后注册表里留下的那个老路径。故意换一个盘、换一层目录。 */
const MOCK_STALE_EXE = "D:\\Users\\27828\\TypeStat\\src-tauri\\target\\release\\typestat.exe";

/**
 * WPS 加载项目录的假路径。**照真机上的形状写全**（`%APPDATA%\kingsoft\wps\jsaddons\
 * TypeStat_1.0.0`）：它是这一页里最长的一串字，正是那种「一眼扫过去不会细看、
 * 折行了也看不出来」的文本。
 */
const MOCK_ADDON_DIR =
  "C:\\Users\\27828\\AppData\\Roaming\\kingsoft\\wps\\jsaddons\\TypeStat_1.0.0";

/**
 * `wps::PAYLOAD` 里那九个文件，一个不多一个不少——**这份名单是照着 Rust 那张表
 * 抄的，改那边就要改这里**。它同时当两件事用：装完之后写的文件（`config.js` 是
 * 另外单独写的一个，不在这张表里），和「缺文件」时能缺的那几个。
 *
 * 数量必须对得上：页面会把个数印出来（「装好了……10 个文件」），
 * 夹具多算一个，预览上看着一切正常而真机上是另一个数——那还不如不印。
 */
const MOCK_ADDON_FILES = [
  "manifest.xml",
  "ribbon.xml",
  "index.html",
  "main.js",
  "js/config.example.js",
  "js/reporter.js",
  "js/ribbon.js",
  "ui/status.html",
  "ui/status.js",
];

/**
 * 加载项的假状态。默认 `installed: false`——**没装过是第一次打开这一页就会遇到的
 * 形态**，和 `mockReport` 默认没配接口是同一个道理。
 *
 * 这里多一个 `installError`，真后端上造不出来（写 AppData 失败要先把那个目录的
 * 权限弄坏）：而「装不上」是这一页最要紧的一条失败路径，必须能看见。
 * 开关在文件末尾的 `__mockRuntime`。
 */
const mockAddon: {
  installed: boolean;
  tokenStale: boolean;
  filesMissing: string[];
  note: string | null;
  receiverDown: boolean;
  publishAction: string;
  installError: string | null;
  exportError: string | null;
} = {
  installed: false,
  tokenStale: false,
  filesMissing: [],
  note: null,
  receiverDown: false,
  publishAction: "新建",
  installError: null,
  exportError: null,
};

function autostartOf() {
  const on = mockRuntime.autostart;
  return {
    enabled: on,
    // 没有这一项时是 null，不是空串——界面要能分辨「没有」和「读到了个空的」。
    path: on ? (mockRuntime.stale ? MOCK_STALE_EXE : MOCK_CURRENT_EXE) : null,
    stale: on && mockRuntime.stale,
    current: MOCK_CURRENT_EXE,
  };
}

/** `report_generate` 临时改掉的状态：会话内有效，刷新就回去了。 */
const MADE = new Map<string, MockMade>();

/** 和 `report::weekday_cn` 同一件事，预览里只为了看着像。 */
function weekdayCn(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return "周" + "日一二三四五六"[new Date(y, m - 1, d).getDay()];
}

function dayCount(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00`).getTime();
  const b = new Date(`${end}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000) + 1;
}

/** 2026-09-21 是 2026 年第 39 周的周一，`TODAY` 就在这一周里。 */
const WEEK_39_MON = "2026-09-21";

const WEEKS: MockSlot[] = Array.from({ length: 12 }, (_, i) => {
  const wk = 28 + i; // 第 28 周 … 第 39 周（最后一期含今天）
  const start = shift(WEEK_39_MON, (wk - 39) * 7);
  return {
    key: `2026-W${pad(wk)}`,
    label: `第 ${wk} 周`,
    heading: `2026 年第 ${wk} 周`,
    start,
    end: shift(start, 6),
    closed: wk < 39,
    hasData: true,
    made: null,
  };
});

const MONTHS: MockSlot[] = Array.from({ length: 12 }, (_, i) => {
  const first = new Date(2026, 8 - (11 - i), 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const label = `${first.getFullYear()} 年 ${first.getMonth() + 1} 月`;
  return {
    key: `${first.getFullYear()}-${pad(first.getMonth() + 1)}`,
    label,
    heading: label,
    start: iso(first),
    end: iso(last),
    closed: (11 - i) > 0,
    hasData: true,
    made: null,
  };
});

/** 期次 → 这一期在预览里长什么样。**每种状态至少有一期**。 */
const SLOT_STATE: Record<string, { hasData?: boolean; made?: MockMade }> = {
  "2026-W38": { made: "llm" },
  "2026-W37": { made: "template" },
  "2026-W36": { hasData: false }, // 一整周什么都没写
  // W35：有数据、没生成过——「还没生成」那个状态，也是 catchup 会去补的那一期
  "2026-W34": { made: "llm" },
  "2026-08": { made: "llm" },
  // 2026-07：有数据、没生成过（月报这一侧不用 catchup，靠用户点）
  "2026-06": { hasData: false },
  "2026-04": { made: "llm" },
};

for (const s of [...WEEKS, ...MONTHS]) {
  const st = SLOT_STATE[s.key];
  s.hasData = st?.hasData ?? s.hasData;
  s.made = st?.made ?? null;
}

function slotOf(kind: "week" | "month", key: string): MockSlot | undefined {
  return (kind === "week" ? WEEKS : MONTHS).find((s) => s.key === key);
}

const madeOf = (s: MockSlot): MockMade | null => MADE.get(s.key) ?? s.made;

/** 存档时间：期末那天 20:30。固定值，刷新之后看到的还是同一串字。 */
const madeAt = (s: MockSlot): number =>
  Math.floor(new Date(`${s.end}T20:30:00`).getTime() / 1000);

function baseFacts(): ReportFacts {
  return {
    periodType: "week",
    periodKey: "",
    heading: "",
    rangeText: "",
    startsOn: "",
    endsOn: "",
    activeDays: 0,
    periodDays: 7,
    keyInput: 0,
    keyDelete: 0,
    keyOther: 0,
    keyDeleteRate: null,
    charInput: null,
    charDelete: null,
    netChars: null,
    charDeleteRate: null,
    charKeyInput: 0,
    coverage: null,
    sessionMinutes: 0,
    activeMinutes: 0,
    longestMinutes: 0,
    preciseMinutes: 0,
    keysPerMinute: null,
    charsPerMinute: null,
    days: [],
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, keyInput: 0 })),
    apps: [],
    appsTotal: 0,
    appsOmitted: 0,
    appsOmittedKeys: 0,
    busiestHour: null,
    busiestHourKeys: 0,
    bogusDays: 0,
  };
}

/** 有记录的那些天：隔一天有一天，按键数循环用一串固定值。 */
const DAY_KEYS = [4838, 3102, 6020, 2415, 1240, 3380, 4210, 2760];

function daysIn(s: MockSlot): DayRow[] {
  const out: DayRow[] = [];
  for (let d = s.start, i = 0; d <= s.end && i < 40; d = shift(d, 1), i++) {
    if (i % 2 === 0) {
      out.push({ day: d, weekday: weekdayCn(d), keyInput: DAY_KEYS[(i / 2) % DAY_KEYS.length] });
    }
  }
  return out;
}

/** 把这些按键摊到一天里。**和必须等于 `total`**，余数补给最高的那一格。 */
const HOUR_PLAN: [number, number][] = [
  [9, 0.05], [10, 0.09], [11, 0.06], [14, 0.11], [15, 0.13],
  [16, 0.16], [17, 0.12], [20, 0.09], [21, 0.11], [22, 0.08],
];

function hoursOf(total: number): HourRow[] {
  const out: HourRow[] = Array.from({ length: 24 }, (_, hour) => ({ hour, keyInput: 0 }));
  let rest = total;
  let top = 0;
  for (const [h, share] of HOUR_PLAN) {
    out[h].keyInput = Math.round(total * share);
    rest -= out[h].keyInput;
    if (out[h].keyInput > out[top].keyInput) top = h;
  }
  out[top].keyInput += rest;
  return out;
}

/** 应用：**名字已经是短名**（后端那一侧去掉了 `.exe`），列表和界面才是同一个字符串。 */
const APP_SHARE: [string, number, boolean][] = [
  ["wps", 0.69, true],
  ["WindowsTerminal", 0.296, false],
  ["Weixin", 0.012, false],
  ["msedge", 0.0015, false],
  ["哔哩哔哩", 0.0005, false],
];

/**
 * 分摊按键数。份额乘的是**池子**（总数先扣掉没列出的），前面几条一律 `floor`，
 * 最后一条拿余数。
 *
 * 两个坑都是预览里真踩到的：
 *   · 用 `Math.round` 分摊，`Σ` 会盖过池子，最后一条拿到负数（「哔哩哔哩 -21 次」）；
 *   · 份额乘**剩下的**池子，份额就不再合成 1，最后一条把大头全吃了
 *     （同一条变成 3,521 次，还排在末尾——而页面上写着「从多到少」）。
 * 最后再排一次序：真实那份是 `ORDER BY SUM(key_input) DESC` 出来的，
 * 夹具不排的话，「从多到少」这句话在预览里就是假的。
 */
function appsOf(total: number, withChar: boolean): { apps: AppRow[]; omittedKeys: number } {
  const omittedKeys = Math.round(total * 0.0017);
  const pool = total - omittedKeys;
  let used = 0;
  const apps = APP_SHARE.map(([app, share, canChar], i) => {
    const keyInput =
      i === APP_SHARE.length - 1 ? pool - used : Math.floor(pool * share);
    used += keyInput;
    const hasChar = withChar && canChar;
    return {
      app,
      keyInput,
      charInput: hasChar ? Math.round(keyInput * 0.64) : null,
      hasChar,
    };
  });
  apps.sort((a, b) => b.keyInput - a.keyInput);
  return { apps, omittedKeys };
}

function factsFor(variant: "full" | "keyonly" | "empty", s: MockSlot): ReportFacts {
  const f = baseFacts();
  f.periodType = s.key.startsWith("20") && s.key.includes("W") ? "week" : "month";
  f.periodKey = s.key;
  f.heading = s.heading;
  f.rangeText = `${s.start} 至 ${s.end}`;
  f.startsOn = s.start;
  f.endsOn = s.end;
  f.periodDays = dayCount(s.start, s.end);
  if (variant === "empty") return f;

  f.days = daysIn(s);
  f.activeDays = f.days.length;
  f.keyInput = f.days.reduce((n, d) => n + d.keyInput, 0);
  f.keyDelete = Math.round(f.keyInput * 0.049);
  f.keyOther = Math.round(f.keyInput * 0.041);
  f.keyDeleteRate = f.keyDelete / f.keyInput;
  f.hours = hoursOf(f.keyInput);
  const top = f.hours.reduce((best, h) => (h.keyInput > best.keyInput ? h : best), f.hours[0]);
  f.busiestHour = top.keyInput > 0 ? top.hour : null;
  f.busiestHourKeys = top.keyInput;

  const { apps, omittedKeys } = appsOf(f.keyInput, variant === "full");
  f.apps = apps;
  f.appsTotal = apps.length + 3;
  f.appsOmitted = 3;
  f.appsOmittedKeys = omittedKeys;

  f.sessionMinutes = 582;
  f.activeMinutes = 371;
  f.longestMinutes = 68;
  f.keysPerMinute = f.keyInput / f.activeMinutes;

  if (variant === "full") {
    f.charInput = Math.round(f.keyInput * 0.747);
    f.charDelete = Math.round(f.charInput * 0.073);
    f.netChars = f.charInput - f.charDelete;
    f.charDeleteRate = f.charDelete / f.charInput;
    f.charKeyInput = Math.round(f.keyInput * 0.823);
    f.coverage = f.charKeyInput / f.keyInput;
    f.preciseMinutes = 336;
    f.charsPerMinute = f.charInput / f.preciseMinutes;
    // WPS 的字数口径已知偏大，这里留一天虚报的——那条警告要在预览里看得见。
    f.bogusDays = 1;
  }
  checkReconciles(f, s.key);
  return f;
}

/**
 * 夹具的自我核对：**这个功能最要紧的一条是「正文旁边的数字可以核」**，
 * 而夹具要是自己都对不上，预览就验不了这件事，还会把「预览里看着没问题」
 * 变成一次假阳性。
 *
 * 所以宁可吵：对不上就抛，页面会显示一句错误，而不是安静地给出一本假账。
 * （真数字由 Rust 那边的测试守，这一份只守夹具。）
 */
function checkReconciles(f: ReportFacts, key: string): void {
  const bad: string[] = [];
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  if (sum(f.days.map((d) => d.keyInput)) !== f.keyInput) bad.push("按天的和 ≠ 敲入按键");
  if (sum(f.hours.map((h) => h.keyInput)) !== f.keyInput) bad.push("按小时的和 ≠ 敲入按键");
  if (sum(f.apps.map((a) => a.keyInput)) + f.appsOmittedKeys !== f.keyInput) {
    bad.push("列出的 + 没列出的 ≠ 敲入按键");
  }
  const nums = [
    f.keyInput, f.keyDelete, f.keyOther, f.charKeyInput,
    ...f.days.map((d) => d.keyInput),
    ...f.hours.map((h) => h.keyInput),
    ...f.apps.map((a) => a.keyInput),
    ...f.apps.map((a) => a.charInput ?? 0),
    f.charInput ?? 0, f.charDelete ?? 0, f.netChars ?? 0,
  ];
  if (nums.some((n) => !Number.isFinite(n))) bad.push("有 NaN / Infinity");
  if (nums.some((n) => n < 0)) bad.push("有负数");
  if (f.hours.length !== 24) bad.push("小于时不是 24 格");
  if (f.activeDays !== f.days.length) bad.push("activeDays ≠ 有记录的天数");
  if (bad.length > 0) throw new Error(`[mock] ${key} 的夹具对不上账：${bad.join("；")}`);
}

/** 打得最多的那一天。正文和模板都要用它，所以算一次。 */
function topDay(f: ReportFacts): DayRow | null {
  return f.days.reduce<DayRow | null>(
    (best, d) => (best === null || d.keyInput > best.keyInput ? d : best),
    null,
  );
}

/*
 * 正文。**数字全部从 `facts` 里取**，一个都不手写——手写的那些迟早会和
 * 旁边的账目对不上，而这一页的整个卖点就是「对得上」。
 * 内容照着 `report::text` 的语气写：不评价、不给建议、只用清单里有的数。
 */
function llmBody(f: ReportFacts): string {
  const top = topDay(f);
  const cov = f.coverage === null ? "覆盖率算不出来" : `覆盖率 ${pct(f.coverage)}`;
  return [
    `这一期你有 ${f.activeDays} 天敲过键盘，一共敲入 ${num(f.keyInput)} 次按键，其中退格 ${num(f.keyDelete)} 次。` +
      (f.charInput === null
        ? ""
        : `字数只覆盖了一部分应用：敲入 ${num(f.charInput)} 字，${cov}——剩下的按键来自没装适配器的应用，它们敲了多少字量不到。`),
    `真正坐下来打字的时间是 ${formatMinutes(f.sessionMinutes)}，其中在敲的有 ${formatMinutes(f.activeMinutes)}，最长的一段 ${formatMinutes(f.longestMinutes)}。`,
    top === null ? "" : `打得最多的一天是 ${top.day}（${top.weekday}）。`,
  ]
    .filter((p) => p !== "")
    .join("\n\n");
}

function templateBody(f: ReportFacts): string {
  const head = `这一期（${f.heading}，${f.rangeText}）`;
  if (f.keyInput === 0 && f.keyDelete === 0) {
    return (
      `${head}没有任何打字记录：没有敲入或删除过字符。` +
      (f.keyOther > 0
        ? `这一期只按过 ${num(f.keyOther)} 次其他按键（方向键、快捷键等），它们产生不了字符。`
        : "")
    );
  }
  const parts = [
    `${head}有记录的天数 ${num(f.activeDays)} 天，其中敲入按键 ${num(f.keyInput)} 次，退格 ${num(f.keyDelete)} 次` +
      (f.keyDeleteRate === null ? "" : `，退格率 ${pct(f.keyDeleteRate)}`) +
      `，另有 ${num(f.keyOther)} 次其他按键。`,
    `坐下时长 ${formatMinutes(f.sessionMinutes)}，其中真正在敲 ${formatMinutes(f.activeMinutes)}，最长的一段 ${formatMinutes(f.longestMinutes)}。` +
      (f.keysPerMinute === null ? "" : `按键速度 ${f.keysPerMinute.toFixed(1)} 键 / 分。`),
  ];
  if (f.charInput !== null) {
    parts.push(
      `敲入字数 ${num(f.charInput)} 字，删除 ${num(f.charDelete ?? 0)} 字，净字数 ${num(f.netChars ?? 0)} 字。` +
        (f.coverage === null ? "" : `字数覆盖率 ${pct(f.coverage)}。`) +
        (f.charsPerMinute === null ? "" : `字数速度 ${f.charsPerMinute.toFixed(1)} 字 / 分。`),
    );
  } else {
    parts.push("这一期的字数量不到：没有任何应用上报精确字数，所以上面只有按键数。");
  }
  const top = topDay(f);
  const extreme =
    (top === null ? "" : `打得最多的一天是 ${top.day}，敲入 ${num(top.keyInput)} 次。`) +
    (f.busiestHour === null ? "" : `最忙的一小时是 ${f.busiestHour} 时，${num(f.busiestHourKeys)} 次。`);
  if (extreme !== "") parts.push(extreme);
  if (f.apps.length > 0) {
    const listed = f.apps
      .map((a) => `${a.app} ${num(a.keyInput)} 次（${a.hasChar && a.charInput !== null ? `字数 ${num(a.charInput)} 字（适配器上报）` : "字数量不到"}）`)
      .join("、");
    parts.push(
      `按敲入按键数排，前 ${num(f.apps.length)} 个应用是：${listed}。` +
        (f.appsOmitted > 0
          ? `另有 ${num(f.appsOmitted)} 个应用未列出，合计 ${num(f.appsOmittedKeys)} 次。`
          : ""),
    );
  }
  return parts.join("\n\n");
}

/**
 * 「模型看到的事实」。
 *
 * **格式是照着 `report::text::render_sheet` 抄的**，只为了让预览里那个折叠块
 * 长得像真的，而且数字和页面上的一致。真的那份在 Rust 里，有自己的测试；
 * 这一份哪天跟不上了，坏的只是预览。
 */
function renderSheet(f: ReportFacts): string {
  if (f.keyInput === 0 && f.keyDelete === 0) {
    let s = `期间：${f.heading}（${f.rangeText}），已结束\n\n这一期没有任何打字记录：没有敲入或删除过字符。\n`;
    // 「只按过一些快捷键」和「完全没碰键盘」是两句不同的话，别合成一句。
    if (f.keyOther > 0) {
      s += `只按过 ${num(f.keyOther)} 次其他按键（方向键、快捷键等），它们产生不了字符。\n`;
    }
    return s;
  }
  const L: string[] = [`期间：${f.heading}（${f.rangeText}），已结束`, "", "【按键】"];
  L.push(`敲入按键：${num(f.keyInput)} 次`);
  L.push(`退格：${num(f.keyDelete)} 次`);
  if (f.keyDeleteRate !== null) {
    L.push(`退格率：${pct(f.keyDeleteRate)}（退格次数 ${num(f.keyDelete)} ÷ 敲入按键 ${num(f.keyInput)}）`);
  }
  L.push(`其他按键（方向键、快捷键等，产生不了字符）：${num(f.keyOther)} 次`);
  L.push("", "【字数】");
  if (f.charInput === null) {
    L.push("字数：量不到。这一期没有任何应用上报精确字数。");
  } else {
    L.push(`敲入字数：${num(f.charInput)} 字（只有装了适配器的应用报得上来）`);
    L.push(`删除字数：${num(f.charDelete ?? 0)} 字`);
    L.push(`净字数：${num(f.netChars ?? 0)} 字（敲入字数 ${num(f.charInput)} − 删除字数 ${num(f.charDelete ?? 0)}）`);
    if (f.charDeleteRate !== null) {
      L.push(`字数删除率：${pct(f.charDeleteRate)}（删除字数 ${num(f.charDelete ?? 0)} ÷ 敲入字数 ${num(f.charInput)}）`);
    }
    if (f.coverage !== null) {
      L.push(`字数覆盖率：${pct(f.coverage)}（有字数的按键数 ${num(f.charKeyInput)} ÷ 敲入按键 ${num(f.keyInput)}）`);
    }
  }
  L.push("", "【时长】");
  L.push(`坐下时长：${formatMinutes(f.sessionMinutes)}（相邻两次输入间隔不超过 5 分钟算同一段，段内空隙也计入）`);
  L.push(
    `真正在敲：${formatMinutes(f.activeMinutes)}（${num(f.activeMinutes)} 分钟，有按键的分钟数，一分钟内敲一下也算一分钟）`,
  );
  L.push(`最长的一段：${formatMinutes(f.longestMinutes)}`);
  if (f.keysPerMinute !== null) {
    L.push(`按键速度：${f.keysPerMinute.toFixed(1)} 键 / 分（敲入按键 ${num(f.keyInput)} ÷ 真正在敲 ${num(f.activeMinutes)} 分钟）`);
  }
  if (f.charsPerMinute !== null && f.charInput !== null) {
    L.push(`字数速度：${f.charsPerMinute.toFixed(1)} 字 / 分（敲入字数 ${num(f.charInput)} ÷ 有字数的 ${num(f.preciseMinutes)} 分钟）`);
  }
  L.push("", "【记录】", `有记录的天数：${num(f.activeDays)} 天（这一期共 ${num(f.periodDays)} 天）`);
  if (f.bogusDays > 0) {
    L.push(`字数大于按键数的天数：${num(f.bogusDays)} 天（不可能——一个字至少要按一次键，属适配器虚报，那几天的数字不可信）`);
  }
  if (f.days.length > 0) {
    L.push("", "【按天】每天的敲入按键数");
    for (const d of f.days) L.push(`${d.day} ${d.weekday}：${num(d.keyInput)} 次`);
  }
  if (f.hours.length > 0) {
    // 24 个数按 0–23 时依次排开。**0 也是真的 0**，一个都不能省——
    // 省掉的那几个小时，模型会自己解释成「你上午不工作」。
    L.push(
      "",
      `【按小时】0 到 23 时依次的敲入按键数（共 ${f.hours.length} 个数，按小时顺序排列）：${f.hours.map((h) => num(h.keyInput)).join(" ")}`,
    );
    if (f.busiestHour !== null) {
      L.push(`最忙的一小时：${f.busiestHour} 时，${num(f.busiestHourKeys)} 次`);
    }
  }
  if (f.apps.length > 0) {
    L.push("", `【应用】按敲入按键数从多到少，共 ${num(f.appsTotal)} 个`);
    for (const a of f.apps) {
      const chars = a.hasChar && a.charInput !== null ? `字数 ${num(a.charInput)} 字（适配器上报）` : "字数量不到";
      L.push(`${a.app}：${num(a.keyInput)} 次，${chars}`);
    }
    if (f.appsOmitted > 0) {
      L.push(`另有 ${num(f.appsOmitted)} 个应用未列出，合计 ${num(f.appsOmittedKeys)} 次`);
    }
  }
  return L.join("\n") + "\n";
}

function toSlot(s: MockSlot): PeriodSlot {
  const made = madeOf(s);
  return {
    periodKey: s.key,
    label: s.label,
    heading: s.heading,
    rangeText: `${s.start} 至 ${s.end}`,
    startsOn: s.start,
    endsOn: s.end,
    closed: s.closed,
    hasData: s.hasData,
    generatedAt: made === null ? null : madeAt(s),
    source: made,
    model: made === "llm" ? "deepseek-chat" : null,
  };
}

function detailOf(kind: "week" | "month", key: string): ReportDetail {
  const s = slotOf(kind, key);
  if (!s) throw new Error(`[mock] 没有这一期：${key}`);
  const made = madeOf(s);
  const common = {
    periodType: kind,
    periodKey: s.key,
    label: s.label,
    heading: s.heading,
    rangeText: `${s.start} 至 ${s.end}`,
    startsOn: s.start,
    endsOn: s.end,
    closed: s.closed,
    hasData: s.hasData,
  };
  if (made === null) {
    return {
      ...common,
      generatedAt: null,
      body: null,
      source: null,
      model: null,
      note: null,
      sheet: null,
      facts: null,
    };
  }
  // 降级的那些期只有按键数——**「量不到」要能在预览里走到**，所以字数整块缺席。
  const facts = factsFor(s.hasData ? (made === "llm" ? "full" : "keyonly") : "empty", s);
  return {
    ...common,
    generatedAt: madeAt(s),
    // 空期的正文就是模板那一句：真实情况下模型拿到的清单也只有那一行，
    // 写不出别的东西来。不为它另编一段。
    body: made === "llm" && s.hasData ? llmBody(facts) : templateBody(facts),
    source: made,
    model: made === "llm" ? "deepseek-chat" : null,
    // 降级的原因是**封闭集合里的一句**（`llm::REASONS`），不是原始报错——
    // 原始报错会带上地址，而这句话是要上屏、要进存档的。
    note: made === "template" ? "未配置 API key" : null,
    sheet: renderSheet(facts),
    facts,
  };
}

const HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  current_day: () => TODAY,

  today_summary: (a) => summaryOf(String(a.day)),

  hourly: (a) => hourPointsOf(String(a.day)),
  daily: (a) => DAILY.filter((d) => d.day >= String(a.from) && d.day <= String(a.to)),

  /**
   * 按天变化的排行榜。今天那天的量级是 `TODAY_APPS` 的原值，别的日子按当天
   * 按键数和今天的比例缩放。**不在 `DAILY` 里的日子回空数组**——页面会写
   * 「这一天还没有记录到输入」，那是真话；给一份编出来的数据就不是了。
   */
  app_breakdown: (a) => {
    const day = String(a.day);
    if (day === TODAY) return TODAY_APPS;
    const d = DAILY.find((x) => x.day === day);
    if (!d) return [];
    return scaleApps(d.keyInput / TODAY_SUMMARY.keyInput, d.hasChar, d.keyInput);
  },
  cell_grid: (a) => CELLS.filter((c) => c.day >= String(a.from) && c.day <= String(a.to)),
  key_usage: () => VK_7D.map(([vkCode, scanCode, count, extended]) => ({ vkCode, scanCode, extended, count })),

  hook_status: () => ({
    alive: true,
    eventCount: 6412,
    // 正常的形状：鼠标是最近一次输入，所以 systemLastMs 正好等于 mouseLastMs，
    // lagMs 是 0。夹具要照着「健康」的样子造，不然拿它对照真机时会看错。
    health: {
      systemLastMs: 8_642_310,
      keyboardLastMs: 8_630_115,
      mouseLastMs: 8_642_310,
      lagMs: 0,
    },
  }),
  reinstall_hook: () => true,
  adapter_status: () => ({
    port: 43617,
    token: "tst_7f3a91c4e08b52d6",
    lastReportAt: Math.floor(Date.now() / 1000) - 180,
  }),
  rotate_adapter_token: () => {
    // 真后端换完令牌，装在 WPS 里的那一份就旧了。夹具里也要跟着翻这个状态，
    // 否则「换完令牌 → WPS 那一节立刻变成红点」这条**跨两节**的联动在预览里
    // 永远看不到——而那条正是最容易漏掉、漏掉时后果最坏的一条。
    mockAddon.tokenStale = mockAddon.installed;
    return `tst_${Math.random().toString(16).slice(2, 18)}`;
  },

  // —— WPS 加载项 ——
  // 真命令会往 `%APPDATA%\kingsoft\wps\jsaddons` 里真写文件，浏览器里写不了，
  // 所以这里只改内存里那份假状态、回一个形状正确的结果。**状态是跟着改的**：
  // 装完再读要变，不然「装好了」那一行永远出不来。
  wps_addon_status: () => ({
    installed: mockAddon.installed,
    dir: MOCK_ADDON_DIR,
    tokenStale: mockAddon.tokenStale,
    filesMissing: [...mockAddon.filesMissing],
    note: mockAddon.note,
  }),

  install_wps_addon: () => {
    if (mockAddon.installError !== null) throw new Error(mockAddon.installError);
    // 装一次就等于把目录重写一遍：令牌是新的，缺的文件补上。
    const first = !mockAddon.installed;
    mockAddon.installed = true;
    mockAddon.tokenStale = false;
    mockAddon.filesMissing = [];
    // 第一次装是「新建」，之后是覆盖已有那一条——真后端也回这两个词。
    mockAddon.publishAction = first ? "新建" : "更新已有条目";
    return {
      dir: MOCK_ADDON_DIR,
      configPath: `${MOCK_ADDON_DIR}\\js\\config.js`,
      publishPath:
        "C:\\Users\\27828\\AppData\\Roaming\\kingsoft\\wps\\jsaddons\\publish.xml",
      publishAction: mockAddon.publishAction,
      // 那张表里的九个，加上单独写出来的 `js/config.js`。
      files: MOCK_ADDON_FILES.length + 1,
      port: mockAddon.receiverDown ? 42180 : 43617,
      receiverDown: mockAddon.receiverDown,
    };
  },

  export_adapter_files: () => {
    if (mockAddon.exportError !== null) throw new Error(mockAddon.exportError);
    const dir = `${MOCK_EXPORT_DIR}\\适配器`;
    return {
      dir,
      // 和真的一样：那份表 + README + Obsidian 两个，**不含 `config.js`**——
      // 存出去的配置是模板，真令牌不落到这个文件夹里。
      files: [
        ...MOCK_ADDON_FILES.map((f) => `${dir}\\wps-addon\\${f}`),
        `${dir}\\wps-addon\\README.md`,
        `${dir}\\obsidian-plugin\\main.js`,
        `${dir}\\obsidian-plugin\\manifest.json`,
      ],
    };
  },

  open_wps_addon_dir: () => MOCK_ADDON_DIR,

  get_settings: () => ({}),
  set_setting: () => null,

  // —— 导出 ——
  // 真命令会真的往「下载」里写一个文件，浏览器里写不了也不该写，所以这里只回一个
  // **形状正确**的结果。行数和字节数是从夹具自己算的，好让「已写入 N 行」
  // 和页面上那几天对得上——夹具编出来的数字对不上，预览验的就是假东西。
  export_data: (a) => {
    const fmt = String(a.format);
    if (fmt !== "csv" && fmt !== "json") throw new Error(`不认识的导出格式：${fmt}`);
    // `from` 为 null 时后端取库里最早的一天，夹具里就是 `DAILY` 的头一天。
    const from = a.from == null || a.from === "" ? DAILY[0].day : String(a.from);
    const to = a.to == null || a.to === "" ? TODAY : String(a.to);
    if (from > to) throw new Error(`起始日期 ${from} 排在结束日期 ${to} 后面`);
    const days = DAILY.filter((d) => d.day >= from && d.day <= to);
    if (days.length === 0) throw new Error(`${from} 到 ${to} 之间没有任何记录`);
    return {
      path: `${MOCK_EXPORT_DIR}\\typestat-${from}_${to}.${fmt}`,
      dir: MOCK_EXPORT_DIR,
      // CSV 一天一行；JSON 还带 24 格小时分布和每个应用一行。
      rows: fmt === "csv" ? days.length : days.length + 24 + TODAY_APPS.length,
      bytes: fmt === "csv" ? 200 + days.length * 104 : 6200 + days.length * 430,
      from,
      to,
    };
  },

  open_export_dir: () => MOCK_EXPORT_DIR,

  // —— 暂停 / 开机自启 ——
  // 真实的那一份状态在 Rust 里：暂停是采集线程读的一个原子量，自启是注册表里的一个值。
  // 这里存一份假的，只为让浏览器能走到那些分支。
  pause_status: () => mockRuntime.paused,

  set_paused: (a) => {
    mockRuntime.paused = a.paused === true;
    // 返回**拨完之后的状态**，和真命令一致。真命令另外会把托盘菜单的勾刷一遍，
    // 那一步界面上看不见（托盘不在 webview 里），所以这里不用假装。
    return mockRuntime.paused;
  },

  autostart_status: () => autostartOf(),

  set_autostart: (a) => {
    // 真后端在 debug 构建下会拒绝写入（会把 target\debug 写进去），
    // 浏览器预览里没有这个概念——但那条**失败路径**得能看见，
    // 所以留了 `__mockRuntime({ autostartError })` 手动造。
    if (mockRuntime.autostartError !== null) throw new Error(mockRuntime.autostartError);
    mockRuntime.autostart = a.enabled === true;
    // 写一次就把「指向老路径」这个毛病治好了——正是用户点「开启」想干的事。
    mockRuntime.stale = false;
    return autostartOf();
  },

  report_periods: (a) => (String(a.periodType) === "month" ? MONTHS : WEEKS).map(toSlot),

  report_get: (a) => detailOf(kindOf(a.periodType), String(a.periodKey)),

  report_generate: (a) => {
    const kind = kindOf(a.periodType);
    const key = String(a.periodKey);
    const s = slotOf(kind, key);
    // 当前期不能生成。期条上那一格是灰的、点不到，但命令本身可以直接调，
    // 真后端也会挡（存档要不可变）。
    if (!s || !s.closed) throw new Error(`[mock] 这一期还没结束，不能生成：${key}`);
    MADE.set(key, "llm");
    return detailOf(kind, key);
  },

  report_catchup: () => {
    // 照真实逻辑：**只看最近一个已结束的期**，已经有存档就空转（返回 null）。
    const s = WEEKS[WEEKS.length - 2];
    if (!s || madeOf(s) !== null) return null;
    // 真相是「没生成过的那一期已经存了一行」——MADE 也一起写，
    // 否则正文显示已生成、期条那格还写着没生成，两处对不上。
    MADE.set(s.key, "llm");
    return detailOf("week", s.key);
  },

  report_settings: (): ReportSettings => ({
    // 和 `report_config` 一样：没存过就是预设值，不是空字符串。
    baseUrl: mockReport.baseUrl || DEFAULT_BASE_URL,
    model: mockReport.model || DEFAULT_MODEL,
    hasKey: mockReport.hasKey,
    keyBroken: mockReport.keyBroken,
    dbPath: "%APPDATA%\\com.typestat.app\\typestat.db",
  }),

  report_save_settings: (a) => {
    const baseUrl = String(a.baseUrl).trim();
    if (!/^https?:\/\/[^/]/i.test(baseUrl)) throw new Error("[mock] 接口地址不是合法的 http(s) 地址");
    const model = String(a.model).trim();
    if (model === "") throw new Error("[mock] 模型名不能为空");
    mockReport.baseUrl = baseUrl;
    mockReport.model = model;
    // 留空 = 不修改，和真后端一致：清空密钥框多半只是想改地址，
    // 不该顺手把密钥删掉，也不该把 `keyBroken` 洗白成「已配好」。
    const k = typeof a.apiKey === "string" ? a.apiKey.trim() : "";
    if (k !== "") {
      mockReport.hasKey = true;
      mockReport.keyBroken = false;
    }
    return null;
  },
};

/**
 * 把 Tauri 的桥垫掉。
 *
 * 必须在 import App 之前调用——`invoke` 是在调用时读 `window.__TAURI_INTERNALS__`
 * 的，所以只要在第一次渲染前放好就行。
 *
 * 用官方的 `mockIPC` 而不是自己拼一个 `window.__TAURI_INTERNALS__`：事件系统
 * （`listen`）还会去读 `window.__TAURI_EVENT_PLUGIN_INTERNALS__`，只垫 invoke 的话
 * 它会在取消订阅时炸掉。`shouldMockEvents` 顺手把事件桥也接上，于是
 * `emit("stats-updated")` 能真的把界面刷新一遍——这条「后端落库 → 前端重取」
 * 的链路本来在浏览器里是测不到的。
 *
 * 已知的上游毛病（`@tauri-apps/api` 2.11.1，不是这边写错了）：`event.js` 取消订阅时
 * 传的字段名是 `eventId`，而 `mocks.js` 的 `handleRemoveListener` 读的是 `id`，
 * 对不上，于是监听器**永远摘不掉**。表现是每 emit 一次，界面就重取两次，
 * 控制台还会留一条「Couldn't find callback id」——两条都只在浏览器预览里有，
 * 真机上 `plugin:event|unlisten` 是 Rust 处理的，没有这个问题。别去追它。
 */
export function installMockBackend() {
  mockIPC(
    (cmd: string, payload?: InvokeArgs) => {
      const args = (payload ?? {}) as Record<string, unknown>;
      const h = HANDLERS[cmd];
      if (!h) return Promise.reject(new Error(`[mock] 没有这个命令：${cmd}`));
      // 故意留一点延迟：界面在「正在加载」和「有数据」两种状态下的样子都要能看到。
      return new Promise((res, rej) =>
        setTimeout(() => {
          // 夹具自己抛出来的错要变成**被拒绝的 invoke**，不能就这么在定时器里炸掉：
          // 那样这个 promise 永远不落定，页面停在「正在加载…」上，
          // 而控制台里只有一条和调用点对不上的未捕获异常。
          //
          // 拒绝的是 `e.message` 这个**字符串**，不是 `Error` 本身：真后端
          // `#[tauri::command] -> Result<_, String>` 拒绝的就是那句人话，
          // 页面 `String(err)` 拿到的也因此是干净的一句。传 Error 上来的话
          // 界面上会多一个 `Error: ` 前缀——那是只在预览里才有的东西。
          try {
            res(h(args));
          } catch (e) {
            rej(e instanceof Error ? e.message : String(e));
          }
        }, 60),
      );
    },
    { shouldMockEvents: true },
  );
}

/**
 * 浏览器里够不到的那几种状态，从这里开。**只在预览里有**，真后端由 DPAPI 和数据库决定。
 *
 * ```js
 * __mockReport({ keyBroken: true })      // 换了 Windows 账户，存的密钥解不开了
 * __mockReport({ hasKey: true })         // 已配好接口（表单默认折叠起来）
 * __mockReport({ forget: "2026-W38" })   // 删掉最近一期的存档 —— 刷新看 catchup 会不会补
 * __mockReport({ reset: true })          // 回到默认（没配接口）
 * ```
 *
 * 改完刷新页面才看得到：期条是挂载时拉的。
 */
(window as unknown as Record<string, unknown>).__mockReport = (o: {
  hasKey?: boolean;
  keyBroken?: boolean;
  baseUrl?: string;
  model?: string;
  forget?: string;
  reset?: boolean;
}) => {
  if (o.reset) {
    mockReport.hasKey = false;
    mockReport.keyBroken = false;
    mockReport.baseUrl = "";
    mockReport.model = "";
  }
  if (o.hasKey !== undefined) mockReport.hasKey = o.hasKey;
  if (o.keyBroken !== undefined) mockReport.keyBroken = o.keyBroken;
  if (o.baseUrl !== undefined) mockReport.baseUrl = o.baseUrl;
  if (o.model !== undefined) mockReport.model = o.model;
  // 「删掉存档」有两种意思，两种都要能造：
  //   · 只让它看起来没生成过——期条上那格回到「点一下生成」的样子
  //   · 连这条记忆一起去掉——`report_catchup` 才会真的去补它
  // 这里两样都做，因为想看的就是「开程序补一次」那条路。
  if (o.forget !== undefined) {
    MADE.delete(o.forget);
    const s = [...WEEKS, ...MONTHS].find((x) => x.key === o.forget);
    if (s) s.made = null;
  }
  return { ...mockReport };
};

/**
 * 暂停 / 自启 / 托盘事件，浏览器里够不到的那几个分支从这里开。
 *
 * ```js
 * __mockRuntime({ paused: true })        // 顶栏换成「已暂停记录」胶囊
 * __mockRuntime({ autostart: true })     // 设置页：自启开着，指向当前程序
 * __mockRuntime({ stale: true })         // 设置页：自启指着老路径的警告
 * __mockRuntime({ autostartError: "写注册表被组策略拦了" })   // 失败路径
 * __mockRuntime({ addon: "installed" })         // 适配器页：WPS 已装好（绿点）
 * __mockRuntime({ addon: "stale" })             // 适配器页：令牌是旧的
 * __mockRuntime({ addon: "incomplete" })        // 适配器页：少了两个文件
 * __mockRuntime({ addon: "nopath" })            // 适配器页：读不到 %APPDATA%
 * __mockRuntime({ addon: "receiverDown" })      // 适配器页：装上了但接收端没起来
 * __mockRuntime({ addonError: "拒绝访问" })      // 适配器页：装不上的失败路径
 * __mockRuntime({ addonExportError: "磁盘满了" }) // 适配器页：存不出文件的失败路径
 * __mockRuntime({ reset: true })         // 回到默认（没暂停、没自启、没装过）
 * __mockTrayHide()                       // 造「点 X 收进托盘」，看那条只出一次的说明
 * ```
 *
 * `paused` 会**真的 emit 一条 `pause-changed`**，走的正是托盘菜单那条路
 * （`tray.rs` 里菜单拨开关时发的就是它）——顶栏是听这个事件变的，
 * 不是每 5 秒轮询出来的，所以只改状态不发事件是测不到的。
 *
 * 设置页本身不用刷新：自启是挂载时读的，暂停是从顶栏一路传下来的。
 * 适配器页同理（`addon` 那几档要重新点进那一页才看得到）。
 */
(window as unknown as Record<string, unknown>).__mockRuntime = (o: {
  paused?: boolean;
  autostart?: boolean;
  stale?: boolean;
  autostartError?: string | null;
  addon?: "none" | "installed" | "stale" | "incomplete" | "nopath" | "receiverDown";
  addonError?: string | null;
  addonExportError?: string | null;
  reset?: boolean;
}) => {
  // **`reset` 一定在最前面**，后面那些 `if` 才是「这次要改成什么」——
  // 顺序反过来的话，`{ reset: true, addonError: "…" }` 会被 reset 擦掉，
  // 而症状是「照着文档敲进控制台，界面上什么都没变」：最容易被当成
  // 「这个开关坏了」而不是「我的开关写错了」。
  if (o.reset) {
    mockRuntime.paused = false;
    mockRuntime.autostart = false;
    mockRuntime.stale = false;
    mockRuntime.autostartError = null;
    mockAddon.installed = false;
    mockAddon.tokenStale = false;
    mockAddon.filesMissing = [];
    mockAddon.note = null;
    mockAddon.receiverDown = false;
    mockAddon.installError = null;
    mockAddon.exportError = null;
  }
  if (o.addon !== undefined) {
    // 一次说清「这一档下那几件事各是什么」，而不是留几个别的开关要自己拼——
    // 拼出来的组合（比如「没装 + 缺文件」）在真机上不可能出现，
    // 而照着它调界面会调出一些没有意义的中间态。
    mockAddon.installed = o.addon !== "none";
    mockAddon.tokenStale = o.addon === "stale";
    mockAddon.filesMissing =
      o.addon === "incomplete" ? ["js/config.js", "ui/status.js"] : [];
    mockAddon.note = o.addon === "nopath" ? "读不到 %APPDATA% 环境变量" : null;
    mockAddon.receiverDown = o.addon === "receiverDown";
  }
  if (o.addonError !== undefined) mockAddon.installError = o.addonError;
  if (o.addonExportError !== undefined) mockAddon.exportError = o.addonExportError;
  if (o.autostartError !== undefined) mockRuntime.autostartError = o.autostartError;
  if (o.autostart !== undefined) mockRuntime.autostart = o.autostart;
  if (o.stale !== undefined) mockRuntime.stale = o.stale;
  if (o.paused !== undefined) {
    mockRuntime.paused = o.paused;
    // 失败就算了：这条只影响预览，不该在控制台上多抛一个没人接的 promise。
    void emit("pause-changed", mockRuntime.paused).catch(() => {});
  }
  return { ...mockRuntime };
};

/**
 * 造一次「点 X 收进托盘」。
 *
 * `window-hidden` 是 Rust 侧 `install_close_to_tray` 在真的关窗口时发的，
 * 浏览器里点不到那个事件——而它触发的那条说明**只出一次**（靠 localStorage 记），
 * 不造出来就永远测不到。想再看一遍：先清掉那个键再调。
 *
 * ```js
 * localStorage.removeItem("typestat.tray-hint-seen"); __mockTrayHide()
 * ```
 */
(window as unknown as Record<string, unknown>).__mockTrayHide = () => {
  void emit("window-hidden", {}).catch(() => {});
};
