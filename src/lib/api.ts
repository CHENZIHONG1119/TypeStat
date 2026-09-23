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

export interface HookStatus {
  alive: boolean;
  eventCount: number;
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

/** 把 YYYY-MM-DD 往前推 n 天，用于趋势图的默认区间。 */
export function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
