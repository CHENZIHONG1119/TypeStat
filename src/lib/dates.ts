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
