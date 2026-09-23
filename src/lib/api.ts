import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 今日汇总。双口径：按键数（key*）与字符数（char*）。 */
export interface TodaySummary {
  day: string;
  keyInput: number;
  keyDelete: number;
  keyOther: number;
  charInput: number;
  charDelete: number;
  /** 净字数 = 敲进去的 − 删掉的 */
  netChars: number;
  /** 删除率 = 删掉的 ÷ 敲进去的 */
  deleteRate: number;
  /** 今天有没有精确字数数据（有没有适配器上报过）。false 时只能看按键口径。 */
  hasCharData: boolean;
  /** 有精确字数的那部分按键数。除以 keyInput 就是字数口径的覆盖率。 */
  preciseKeyInput: number;
  /** 有精确字数的应用名（按按键数降序）。 */
  preciseApps: string[];
  /** 有按键数、但拿不到精确字数的应用名。字数口径下它们是空的，要主动说明。 */
  uncoveredApps: string[];

  /** 有输入或删除的分钟数。 */
  activeMinutes: number;
  /** 会话时长（分钟）：相邻输入间隔不超过 5 分钟算同一段，段长求和。 */
  sessionMinutes: number;
  /** 最长的一段有多少分钟。 */
  longestMinutes: number;
  /** 有精确字数的分钟数。算字数速度时分母用它——不能拿它当全部打字时间。 */
  preciseMinutes: number;
  /** 第一次 / 最后一次输入的分钟戳（Unix 分钟）。0 表示今天还没打过字。 */
  firstMinute: number;
  lastMinute: number;
}

/** 一小时的数据点。 */
export interface HourPoint {
  hour: number;
  keyInput: number;
  keyDelete: number;
  charInput: number;
  charDelete: number;
  /** 这一小时有没有精确字数数据。false 时字数是「量不到」，图上要留空。 */
  hasChar: boolean;
  /** 这一小时里有精确字数的那部分按键数。小于 keyInput 时说明只覆盖了一部分。 */
  charKeyInput: number;
}

export interface DailyPoint {
  day: string;
  keyInput: number;
  keyDelete: number;
  charInput: number;
  charDelete: number;
  netChars: number;
  /** 这一天有没有精确字数数据。false 时字数折线要断开，不能画成 0。 */
  hasChar: boolean;
  /** 有输入的分钟数。 */
  activeMinutes: number;
  /** 会话时长（分钟）。 */
  sessionMinutes: number;
}

export interface AppPoint {
  app: string;
  keyInput: number;
  charInput: number;
  charDelete: number;
  /** "plugin" | "uia" | null。null 表示该应用拿不到精确字数。 */
  charSource: string | null;
}

/**
 * 看门狗此刻看到的输入时刻（毫秒，系统启动起算）。
 *
 * 界面暂时不显示它——打开设置页本身就要用键鼠，那个瞬间滞后必然接近 0，
 * 一个恒为 0 的读数比没有读数更误导。它是给排查用的：钩子被系统摘掉时
 * 没有任何通知，只有把「系统看见了、却没交给我们多久」直接读出来，
 * 才能把「用户没在打字」和「钩子已经死了」分开。
 */
export interface HookHealth {
  /** 系统的最后输入时刻；量不到时为 null。 */
  systemLastMs: number | null;
  keyboardLastMs: number;
  mouseLastMs: number;
  /** `systemLastMs − max(keyboardLastMs, mouseLastMs)`，超过 30 秒判定钩子失效。 */
  lagMs: number | null;
}

export interface HookStatus {
  alive: boolean;
  eventCount: number;
  health: HookHealth;
}

/** 本地日期以进程所在时区为准，前端不自己算。 */
export const currentDay = () => invoke<string>("current_day");

export const todaySummary = (day: string) =>
  invoke<TodaySummary>("today_summary", { day });

export const hourly = (day: string) => invoke<HourPoint[]>("hourly", { day });

export const daily = (from: string, to: string) =>
  invoke<DailyPoint[]>("daily", { from, to });

export const appBreakdown = (day: string) =>
  invoke<AppPoint[]>("app_breakdown", { day });

/** 「日期 × 小时」网格，供热力图使用。 */
export interface CellPoint {
  day: string;
  hour: number;
  keyInput: number;
  charInput: number;
  charDelete: number;
  /** 这一格有没有精确字数数据。false 时字数口径的热力图要留白。 */
  hasChar: boolean;
}

export const cellGrid = (from: string, to: string) =>
  invoke<CellPoint[]>("cell_grid", { from, to });

/**
 * 一个物理按键在区间内的使用次数。
 *
 * 三个字段一起才唯一确定一个键：左右 Shift 共用 vkCode，左右 Ctrl 连
 * scanCode 都一样、只有 extended 不同。丢掉任何一个都会把两个键合并。
 */
export interface KeyUsage {
  vkCode: number;
  scanCode: number;
  extended: boolean;
  count: number;
}

export const keyUsage = (from: string, to: string) =>
  invoke<KeyUsage[]>("key_usage", { from, to });

export const getSettings = () => invoke<Record<string, string>>("get_settings");

export const setSetting = (key: string, value: string) =>
  invoke<void>("set_setting", { key, value });

export const hookStatus = () => invoke<HookStatus>("hook_status");

export const reinstallHook = () => invoke<boolean>("reinstall_hook");

/** 插件上报通道的状态。 */
export interface AdapterStatus {
  /** null 表示端口 42180–42189 全被占用，接收端没起来。 */
  port: number | null;
  token: string;
  /** 最近一次成功上报的 Unix 秒。0 表示从未收到过。 */
  lastReportAt: number;
}

export const adapterStatus = () => invoke<AdapterStatus>("adapter_status");

export const rotateAdapterToken = () => invoke<string>("rotate_adapter_token");

/**
 * WPS 加载项装到哪儿了、还缺什么。**只读**，问它不会改动机器上的任何东西。
 *
 * `installed` 和 `files_missing` 要分开看：前者是那个目录在不在，后者是个别文件
 * 缺没缺（上一版装过、这一版多了个文件，就是「目录在、文件不全」）。合成一个
 * 布尔量的话，这两种情况的下一步动作不一样，而界面只能说出一句话。
 */
export interface AddonStatus {
  installed: boolean;
  /** 加载项目录的完整路径。拿不到 `%APPDATA%` 时是空串。 */
  dir: string;
  /** 装着的那份里的令牌和现在这个不一样（换过令牌之后没重装）。 */
  tokenStale: boolean;
  /** 缺哪些文件，路径是相对加载项目录的。 */
  filesMissing: string[];
  /** 查不了的原因（比如拿不到 `%APPDATA%`）。**和「缺文件」不是一件事。** */
  note: string | null;
}

export const wpsAddonStatus = () => invoke<AddonStatus>("wps_addon_status");

/** 装完之后的话：装到哪儿了、publish.xml 是新建还是追加、几个文件。 */
export interface InstallResult {
  /** 加载项目录。 */
  dir: string;
  /** 写好的配置文件（含令牌）。 */
  configPath: string;
  publishPath: string;
  /** 「新建」/「追加」/「更新已有条目」——WPS 的配置文件被动过了，要说出来。 */
  publishAction: string;
  files: number;
  /** 实际填进配置的端口。 */
  port: number;
  /** 接收端当时没起来（端口全被占），装完也连不上。 */
  receiverDown: boolean;
}

/**
 * 把加载项装进 WPS 的加载项目录。
 *
 * **端口和令牌不收参数**：后端从自己的 `AppState` 里拿，那本来就是它启动时定的。
 * 让前端传的话，界面就得先知道令牌才能装，而这一页正是用来「不知道令牌时照做」的。
 */
export const installWpsAddon = () =>
  invoke<InstallResult>("install_wps_addon");

/** 存出去的两份插件文件落在哪儿。 */
export interface AddonFiles {
  /** 那个文件夹的完整路径。里面是 `wps-addon\` 和 `obsidian-plugin\` 两份。 */
  dir: string;
  /** 写出来的每一个文件的完整路径。界面只说个数，但要数得清。 */
  files: string[];
}

/**
 * 把两份插件的文件存到一个文件夹里，给人手动装（或者拿去别的机器）。
 *
 * 存出去的 `config.js` **不含真令牌**——它和仓库里那份一样是模板。
 * 手动装的人要从这一页自己抄过去。
 */
export const exportAdapterFiles = () =>
  invoke<AddonFiles>("export_adapter_files");

/** 在资源管理器里打开加载项目录。路径由后端算，前端给不了。 */
export const openWpsAddonDir = () => invoke<string>("open_wps_addon_dir");

/** 采集线程每次落库后触发，前端据此刷新。 */
export const onStatsUpdated = (cb: () => void) =>
  listen("stats-updated", () => cb());

// ——————————————————————————————————————————————————————————————
// 总结（周期报告）
// ——————————————————————————————————————————————————————————————

/**
 * 一期报告里的全部数字。**前端一个数都不算**，只负责把它们摆出来——
 * 正文旁边那些数字必须能对得上账，而算两遍就是两套答案的开始。
 *
 * `char*` 一律是 `number | null`，这是整个功能里最要紧的一条：
 * `null` 是**量不到**（这一期没有任何适配器上报过），`0` 是记了但真的没打。
 * 界面上这两句是不同的话——「0 字」是结论，「量不到」是不知道。
 */
export interface ReportFacts {
  periodType: string;
  periodKey: string;
  /** 「2026 年第 39 周」 */
  heading: string;
  /** 「2026-09-21 至 2026-09-27」 */
  rangeText: string;
  startsOn: string;
  endsOn: string;

  /** 这一期里有按键的天数。0 表示这一期完全没有记录。 */
  activeDays: number;
  /** 这一期一共几天（周 7，月 28–31）。 */
  periodDays: number;

  keyInput: number;
  keyDelete: number;
  keyOther: number;
  /** **这个 null 不是「量不到」**，是「分母是 0，算不出来」，界面写「—」。 */
  keyDeleteRate: number | null;

  charInput: number | null;
  charDelete: number | null;
  netChars: number | null;
  charDeleteRate: number | null;
  /** 有字数的那部分按键数。覆盖率的分母是全部按键，不是这个。 */
  charKeyInput: number;
  coverage: number | null;

  sessionMinutes: number;
  activeMinutes: number;
  /** 跨天取各天最大值，不求和。 */
  longestMinutes: number;
  /** 有精确字数的分钟数。字数速度的分母。 */
  preciseMinutes: number;
  keysPerMinute: number | null;
  charsPerMinute: number | null;

  /** 有记录的那些天，从早到晚。没有记录的天不在里面。 */
  days: { day: string; weekday: string; keyInput: number }[];
  /** **永远是 24 格。** 补出来的 0 是真的 0。 */
  hours: { hour: number; keyInput: number }[];
  /** 按敲入按键数从多到少，最多 10 个。 */
  apps: { app: string; keyInput: number; charInput: number | null; hasChar: boolean }[];
  appsTotal: number;
  appsOmitted: number;
  appsOmittedKeys: number;

  busiestHour: number | null;
  busiestHourKeys: number;
  /** 字数大于按键数的天数（不可能，属适配器虚报）。大于 0 时页面要说出来。 */
  bogusDays: number;
}

/** 期条上的一格。 */
export interface PeriodSlot {
  periodKey: string;
  label: string;
  heading: string;
  rangeText: string;
  startsOn: string;
  endsOn: string;
  /** 这一期是否已经过完。**没结束的期不能生成**，那格也就不可点。 */
  closed: boolean;
  /** 这一期有没有打字记录。没记录也没生成过的一格，点进去只有一句话可说。 */
  hasData: boolean;
  generatedAt: number | null;
  /** `"llm"` / `"template"`。没生成过是 null。 */
  source: string | null;
  model: string | null;
}

/**
 * 一期的全文。没生成过也回得来——页面要能说「还没生成」和「这一期没有记录」，
 * 那是两句不同的话。
 */
export interface ReportDetail {
  periodType: string;
  periodKey: string;
  /** 「第 39 周」「2026 年 9 月」 */
  label: string;
  heading: string;
  rangeText: string;
  startsOn: string;
  endsOn: string;
  closed: boolean;
  hasData: boolean;
  generatedAt: number | null;
  /** 正文。没生成过是 null。 */
  body: string | null;
  source: string | null;
  model: string | null;
  /** 降级原因。成功时为 null。 */
  note: string | null;
  /** **模型当时看到的清单**，存档里的原件。展开能离线核对每一句话。 */
  sheet: string | null;
  /** 账目。没生成过是 null——没有账目可看，也没有账目可算。 */
  facts: ReportFacts | null;
}

/** 接口表单。**密钥本身永远不会回传到前端。** */
export interface ReportSettings {
  baseUrl: string;
  model: string;
  /** 有没有**能用的**密钥。解不开的那种不算。 */
  hasKey: boolean;
  /** 填过但解不开（换了 Windows 账户，或者库是从别的机器拷来的）。要请用户重填。 */
  keyBroken: boolean;
  dbPath: string;
}

export const reportPeriods = (periodType: string, count?: number) =>
  invoke<PeriodSlot[]>("report_periods", { periodType, count });

export const reportGet = (periodType: string, periodKey: string) =>
  invoke<ReportDetail>("report_get", { periodType, periodKey });

export const reportGenerate = (periodType: string, periodKey: string) =>
  invoke<ReportDetail>("report_generate", { periodType, periodKey });

/** 开程序时补一期。没补到东西时回 null。前端 fire-and-forget，别为它的失败打扰用户。 */
export const reportCatchup = () => invoke<ReportDetail | null>("report_catchup");

export const reportSettings = () => invoke<ReportSettings>("report_settings");

/** `apiKey` 传 null 表示**不修改**：留空多半是想改地址，不该顺手把密钥删掉。 */
export const reportSaveSettings = (
  baseUrl: string,
  model: string,
  apiKey: string | null,
) => invoke<void>("report_save_settings", { baseUrl, model, apiKey });

// ——————————————————————————————————————————————————————————————
// 数据导出
// ——————————————————————————————————————————————————————————————

/** 一次导出的结果。**文件位置必须回到界面**，否则用户点了按钮只看到一片安静。 */
export interface ExportResult {
  path: string;
  /** 文件所在目录。那个「打开文件夹」按它走。 */
  dir: string;
  /** CSV 是数据行数；JSON 是「天 + 小时 + 应用」三段的行数之和。 */
  rows: number;
  bytes: number;
  from: string;
  to: string;
}

/**
 * 把一段区间导成文件，返回它落在哪儿。
 *
 * `from` / `to` 传 `null` 表示「库里最早的一天」/「今天」——这两个默认值由
 * 后端算，前端不猜：日期以进程所在时区为准，那是后端的知识。
 */
export const exportData = (
  format: "csv" | "json",
  from: string | null,
  to: string | null,
) => invoke<ExportResult>("export_data", { format, from, to });

/** 在资源管理器里打开导出目录。目录由后端算，前端给不了路径。 */
export const openExportDir = () => invoke<string>("open_export_dir");

// ——————————————————————————————————————————————————————————————
// 托盘 / 暂停 / 开机自启
// ——————————————————————————————————————————————————————————————

/**
 * 现在是不是暂停记录。
 *
 * **这个状态不在前端。** 托盘菜单拨的是同一个开关，所以真相只有一份，
 * 存在 Rust 侧的原子量里；前端读它、改它，但**不自己维护一份**——
 * 存两份的话，用托盘暂停、界面上的开关还亮着「正在记录」。
 */
export const pauseStatus = () => invoke<boolean>("pause_status");

/** 拨暂停开关，返回拨完之后的状态。 */
export const setPaused = (paused: boolean) =>
  invoke<boolean>("set_paused", { paused });

/** 开机自启的状态。注意 `stale`：注册表里可能指的是一个已经不在那儿的路径。 */
export interface Autostart {
  enabled: boolean;
  /** 注册表里记的路径。`null` 表示没有这一项。 */
  path: string | null;
  /** 注册表里记的路径和当前程序不一致（程序被挪过位置、或换了安装目录）。 */
  stale: boolean;
  /** 当前程序路径。`null` 表示拿不到。 */
  current: string | null;
}

export const autostartStatus = () => invoke<Autostart>("autostart_status");

/** 开 / 关自启，返回**写完重新读到的**状态，不是把入参回传。 */
export const setAutostart = (enabled: boolean) =>
  invoke<Autostart>("set_autostart", { enabled });

/** 托盘菜单拨了暂停开关时触发，带上拨完之后的状态。 */
export const onPauseChanged = (cb: (paused: boolean) => void) =>
  listen<boolean>("pause-changed", (e) => cb(e.payload));

/**
 * 点窗口的 X 收进托盘时触发。
 *
 * 前端只在**第一次**时提示一句「还在后台计数」——安静地把程序留在后台运行
 * 而不告诉用户，是这个项目一直在防的那种「界面和事实不符」。
 * 「是不是第一次」跟着用户而不是跟着进程，所以判断留在前端。
 */
export const onWindowHidden = (cb: () => void) =>
  listen("window-hidden", () => cb());

/** 把 YYYY-MM-DD 往前推 n 天，用于趋势图的默认区间。 */
export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
