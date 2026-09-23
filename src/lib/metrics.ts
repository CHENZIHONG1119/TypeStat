/**
 * 口径选择。
 *
 * 有两套数：**按键数**（全局钩子）和**精确字数**（编辑器适配器）。
 * 它们单位不同（次 / 字），而且覆盖范围也不同——按键数覆盖所有应用，
 * 字数只覆盖装了适配器的应用。这两件事决定了整个界面的口径规则：
 *
 * 1. **一根轴上只能有一种单位。** 所以口径是全局的（顶栏那个开关），
 *    不是「哪个应用有字数就用字数」——那样会把两种单位混进同一张图。
 * 2. **「没有精确数据」和「字数是 0」必须分开。** 前者是「量不到」，
 *    后者是「没打字」。把前者当 0 展示，图上就会说这个应用今天一个字
 *    没打，而下面的明细表却写着它敲了一千多次——自相矛盾。
 *    所以缺数据的点在图表里一律 `null`（留空），不画成 0。
 */

export type MetricMode = "char" | "key";

export interface MetricPair {
  input: number;
  del: number;
  /** 数值单位：精确口径是「字」，按键口径是「次」 */
  unit: string;
  /** 是否为精确字数口径 */
  precise: boolean;
}

/**
 * 实际能用的口径。
 *
 * 用户选了「字数」但这一段根本没有精确数据（一个适配器都没装）时，
 * 退回按键口径——否则整页是一片空白，看着像统计坏了。
 * 「选了字数却看到按键数」这件事必须由调用方在副标题里说出来，不能悄悄发生。
 */
export function resolveMode(mode: MetricMode, hasAnyChar: boolean): MetricMode {
  return mode === "char" && !hasAnyChar ? "key" : mode;
}

/** 单位名。图表轴标签、tooltip 都用它，避免各处写死「字」/「次」。 */
export const unitOf = (mode: MetricMode) => (mode === "char" ? "字" : "次");

export function pickMetrics(
  s: {
    charInput: number;
    charDelete: number;
    keyInput: number;
    keyDelete: number;
  },
  mode: MetricMode,
): MetricPair {
  return mode === "char"
    ? { input: s.charInput, del: s.charDelete, unit: "字", precise: true }
    : { input: s.keyInput, del: s.keyDelete, unit: "次", precise: false };
}

/**
 * 字数口径下一格的取值：`null` = **量不到**，数字 = 量到了（`0` 就是真的 0）。
 *
 * **判据是「这一格里有没有人打字」，不是 `hasChar`。** 这一条极容易写反，
 * 而且写反了界面照样好看，只是把两件事对调了：
 *
 * 后端补齐的空格子长的是 `hasChar: false, keyInput: 0`——`hour_profile` 恒定
 * 返回 24 行、`daily_series` 缺的天由调用方补上——那是一个**确定的 0**：
 * 没有按键就不可能产生字符。只看 `hasChar` 会把它印成「量不到」，
 * 于是「那一小时真的没打字」和「那一小时在打字但字数无从得知」在屏幕上一模一样。
 * **区分这两件事就是这个程序存在的理由**，在别处对、在这里反了，等于白做。
 *
 * 反过来，`keyInput > 0 && !hasChar` 才是真正的量不到：那个时段确实在敲，
 * 只是没有适配器告诉我们敲出了几个字。
 *
 * 删除键也一起看：只按了退格、没按过字母的一格，`keyInput` 是 0 但那一格有活动，
 * 不该被当成「没打字」。
 */
export function preciseValue(
  p: {
    hasChar: boolean;
    keyInput: number;
    keyDelete: number;
    charInput: number;
    charDelete: number;
  },
  field: "charInput" | "charDelete",
): number | null {
  if (p.keyInput === 0 && p.keyDelete === 0) return 0;
  return p.hasChar ? p[field] : null;
}

/** 一格完全没有任何输入（键和退格都没有）。质量带靠它决定画不画。 */
export const isBlankCell = (p: { keyInput: number; keyDelete: number }) =>
  p.keyInput === 0 && p.keyDelete === 0;

/**
 * 精确字数的覆盖率说明。
 *
 * 字数口径下最危险的误读是「这个数字就是我今天打的总字数」——它其实只
 * 覆盖了装了适配器的那几个应用。所以每一处展示字数的地方都要带上这句。
 */
export function coverageNote(preciseKeyInput: number, keyInput: number): string | null {
  if (keyInput <= 0) return null;
  const pct = Math.round((preciseKeyInput / keyInput) * 100);
  if (pct >= 100) return "覆盖今日全部按键";
  return `覆盖今日 ${pct}% 的按键`;
}

// ---------- 打字时长与速度 ----------

/**
 * 分钟数 →「2 小时 17 分」。
 *
 * 用「时 + 分」而不是小数小时：没人按「2.28 小时」想事，
 * 而「2 小时 17 分」是可以直接和记忆对上的。
 */
export function formatMinutes(m: number): string {
  if (m <= 0) return "0 分";
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h} 小时` : `${h} 小时 ${rest} 分`;
}

/** Unix 分钟戳 →「09:03」。0 表示没有数据。 */
export function minuteLabel(m: number): string | null {
  if (!m) return null;
  const d = new Date(m * 60000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 打字速度，单位/分钟。分母为 0（还没打过字）时返回 `null`。
 *
 * **分子分母必须来自同一批数据**：
 * - 字数口径 → 精确字数 ÷ **有精确字数的分钟**
 * - 按键口径 → 按键数 ÷ **有输入的分钟**
 *
 * 不能拿「WPS 的字数 ÷ 所有应用的打字时间」——那样算出来的速度会随当天
 * 是在哪个应用打字而剧烈变化：全在 WPS 打字时速度正常，去终端写代码
 * 一小时后速度就掉到几分之一，可你的手速根本没变。**混用两批数据的分母
 * 是这类指标最容易出的错**，而且它不会显示成 0 或报错，只会安静地偏小。
 */
export function typingSpeed(
  mode: MetricMode,
  s: { charInput: number; keyInput: number; preciseMinutes: number; activeMinutes: number },
): number | null {
  const [top, bottom] =
    mode === "char" ? [s.charInput, s.preciseMinutes] : [s.keyInput, s.activeMinutes];
  if (bottom <= 0) return null;
  return top / bottom;
}

/** 速度的显示单位，跟着口径走。 */
export const speedUnit = (mode: MetricMode) => (mode === "char" ? "字 / 分" : "键 / 分");

/** 速度保留一位小数——整数位分不出 30 字/分和 30.4 字/分，但差别是有的。 */
export const speedText = (v: number | null) => (v === null ? "—" : v.toFixed(1));

/** 千分位。大数字靠这个才能一眼读出量级。 */
export const num = (n: number) => n.toLocaleString("zh-CN");

/** 比例格式化成百分数。 */
export const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

// ---------- 名字的显示形式 ----------

/**
 * 应用名去掉 `.exe`。
 *
 * 原来住在 `pages/Apps.tsx`，`Detail.tsx` 再从页面 import 页面——一个纯格式化
 * 助手没有理由挂在某个页面上。挪到这儿和 `num` / `pct` 做邻居。
 *
 * 后端 `report::text::app_display_name` 做的是同一件事，**而且多做一步**
 * （去路径、超长截断），清单和存档里的应用名都是它的产物。也就是说
 * `ReportFacts.apps[].app` 到这里时已经是短名了，这一下是个空操作——
 * 两边仍然一致，模型写「wps」屏幕上就是「wps」。
 */
export const shortName = (app: string) => app.replace(/\.exe$/i, "");
