/**
 * 日期显示。
 *
 * 后端一律用 `YYYY-MM-DD` 的本地日期字符串，所以解析时**必须补上 T00:00:00**：
 * `new Date("2026-09-23")` 按 ECMAScript 规定走 UTC，在 UTC+8 会变成前一天早上八点，
 * 于是「星期三」显示成「星期二」。这个坑只在时区为正的地方出现，
 * 在 UTC 上测是测不出来的。
 */

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function parse(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** 「2026 年 9 月 23 日 · 星期三」 */
export function longDate(iso: string): string {
  const d = parse(iso);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${WEEKDAYS[d.getDay()]}`;
}

/** 「9/23」。轴上只放得下这个长度。 */
export function shortDate(iso: string): string {
  const d = parse(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 「周三」。 */
export function weekdayCn(iso: string): string {
  return `周${WEEKDAYS[parse(iso).getDay()]}`;
}

/**
 * 日期导航里那个词：看的是今天就写「今天」，看的是别的日子就写「9/23 周三」。
 *
 * **不能一律写「今天」。** 翻到 9 月 23 号还说「今天你坐下来写了」，
 * 那就是这一页在骗人——而这个项目从头到尾在防的就是这种事。
 * 各处措辞不同（有的地方要「那一天」而不是「9/23」），所以这里只提供零件，
 * 由页面自己拼句子。
 */
export function dayWord(iso: string, today: string): string {
  return iso === today ? "今天" : `${shortDate(iso)} ${weekdayCn(iso)}`;
}
