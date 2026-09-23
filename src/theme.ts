/**
 * 图表与界面配色。
 *
 * 这些值来自已验证的调色板，经 `validate_palette.js` 双模式校验通过：
 *   light  CVD ΔE 24.7 (protan) / 33.6 (normal)
 *   dark   CVD ΔE 26.8 (protan) / 31.8 (normal)
 * 远高于 8 的目标线，两色在任何色觉类型下都可区分。
 *
 * 改色前务必重跑校验，不要凭肉眼判断。
 *
 * 界面改成暖纸色之后，**只有中性色跟着换了**（surface / plane / 文字 / 网格线），
 * series1、series2 和 sequential 一个都没动：那三组是拿来编码数据的，
 * 底色换成暖白不影响它们的可分性，但**动它们就必须重跑校验**。
 */

export type Mode = "light" | "dark";

export interface Tokens {
  /** 图表画布底色 */
  surface: string;
  /** 页面底色 */
  plane: string;
  textPrimary: string;
  textSecondary: string;
  /** 坐标轴标签 */
  muted: string;
  grid: string;
  axis: string;
  border: string;
  /** 分类槽位 1（主系列） */
  series1: string;
  /** 分类槽位 2（次系列） */
  series2: string;
  /** 单色顺序色阶，索引 0 = 最小值 */
  sequential: string[];
}

export const TOKENS: Record<Mode, Tokens> = {
  light: {
    surface: "#fffefb",
    plane: "#faf8f4",
    textPrimary: "#191713",
    textSecondary: "#5a554c",
    muted: "#948d80",
    grid: "#e6e1d7",
    axis: "#d8d2c6",
    border: "rgba(25,23,19,0.10)",
    series1: "#2a78d6",
    series2: "#eb6834",
    // 浅色底：值越大颜色越深，最浅的一档贴近底色，表示"接近零"
    sequential: [
      "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7",
      "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281",
      "#0d366b",
    ],
  },
  dark: {
    surface: "#1a1816",
    plane: "#121110",
    textPrimary: "#f7f4ee",
    textSecondary: "#b8b2a6",
    muted: "#8a8478",
    grid: "#2a2724",
    axis: "#383835",
    border: "rgba(247,244,238,0.10)",
    series1: "#3987e5",
    series2: "#d95926",
    // 深色底：把色阶反转，让"接近零"的一档贴近深色画布，值越大越亮。
    // 直接沿用浅色版会让低值比高值更显眼，等于把量级读反。
    sequential: [
      "#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6",
      "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6",
      "#cde2fb",
    ],
  },
};

/** 取色阶上的一档（`t` 为 0–1）。 */
export function rampColor(t: Tokens, ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio));
  const i = Math.round(r * (t.sequential.length - 1));
  return t.sequential[i];
}

/** 各图表共用的坐标轴 / 网格 / 提示样式。 */
export function baseOption(t: Tokens) {
  return {
    backgroundColor: "transparent",
    textStyle: {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      color: t.textSecondary,
    },
    grid: { left: 44, right: 16, top: 28, bottom: 28, containLabel: true },
    tooltip: {
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      textStyle: { color: t.textPrimary, fontSize: 12 },
      extraCssText: "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.12);",
    },
    legend: {
      icon: "roundRect",
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: t.textSecondary, fontSize: 12 },
    },
  } as const;
}

/** 坐标轴的统一配置：网格线要退到背景里，基线只留一条。 */
export function axisStyle(t: Tokens) {
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
  };
}
