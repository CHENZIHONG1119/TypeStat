import { useId, useMemo, useState } from "react";

/** 质量带一格的状态。"none" = 那一格是真的没打字，不是缺数据。 */
export type BandState = "exact" | "keys" | "none";

export interface PlotSeries {
  /** 图例和提示框里显示的名字 */
  name: string;
  /** 线色。传 CSS 变量（如 "var(--series-1)"）即可，主题切换会自动跟上。 */
  color: string;
  width?: number;
  /** 数据点标记半径 */
  markerR?: number;
  /** 曲线下是否铺渐变面积。两条线都铺会互相盖住，默认只给第一条。 */
  area?: boolean;
}

export interface PlotPoint {
  /** 提示框标题，如「17 时」「9 月 23 日」 */
  label: string;
  /** 与 series 一一对应。**null 表示量不到，不是 0**——线在那里断开，不画成 0。 */
  values: (number | null)[];
  /** 这一格质量带的状态。不传则该格不画带。 */
  band?: BandState;
  /** 提示框里额外一行小字，如「这一小时只有按键数」 */
  note?: string;
}

interface Props {
  points: PlotPoint[];
  series: PlotSeries[];
  /** 数值单位，直接拼在数字后面，如 " 键" */
  unit?: string;
  /**
   * 是否画基线下面那条质量带。**它只在字数口径下才有意义**——
   * 按键口径下每一格都是全的，打上斜纹等于谎报缺失，所以调用方要关掉它。
   */
  band?: boolean;
  /** 轴下方的标签行（24 小时和 N 天排法不同，交给调用方） */
  axisX?: React.ReactNode;
  ariaLabel: string;
  emptyText?: string;
}

/*
 * 这套图刻意不用 ECharts。
 *
 * 三个原因，都不是审美：
 *   1. 质量带必须待在数据区域**之外**（否则高高的面积会盖住它），ECharts 的
 *      graphic 组件能画，但要跟坐标系联动就变成一堆像素换算，不如自己算。
 *   2. 设计里去掉了网格线、轴线、图例框、y 轴标签，等于把 ECharts 的皮全扒了，
 *      剩下真正在用的只有「画一条折线」这一件事。
 *   3. 缺数据要画成**断开**（null），不是 0。ECharts 用 connectNulls 能控制，
 *      但配合平滑曲线时断点位置不直观，自己拼路径反而更清楚。
 *
 * 坐标系固定 760 宽、纵向 166 高，靠 viewBox 缩放。固定宽度让曲线在所有窗口
 * 尺寸下形状一致——这是刻意的，图是拿来比形状的，不该随窗口拉伸而变陡变缓。
 */
const W = 760;
const PT = 20;
const IH = 166;

type Pt = { x: number; y: number; i: number };

/**
 * 第 i 个格子要不要写日期/小时。
 *
 * 两个约束：
 *   1. 标签之间至少留 60px 左右，否则会挤在一起。图宽固定 760，所以大约每
 *      `n / 10` 个格子标一个，间距就恒在 76px 上下——不管 n 是 7 还是 90。
 *   2. **最后一个点一定标**。90 天里每隔 9 格标一个的话，最后那个标签落在第 82 格，
 *      而数据一直到第 90 格：轴会说完「9/15」就没了，读的人会以为数据到那天为止。
 *      多出来的那一格会让末尾间距比别处小，这是标末点的常规代价，认了。
 */
export function axisTick(i: number, n: number): boolean {
  if (n <= 0) return false;
  return i % Math.ceil(n / 10) === 0 || i === n - 1;
}

/**
 * 平滑曲线穿过每一个真实点。
 *
 * 曲线是插出来的、点标记是量出来的，所以点必须留着——把点去掉之后，
 * 那张图会开始暗示一些没量到过的值。
 */
function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const mx = ((a.x + b.x) / 2).toFixed(1);
    d += ` C ${mx} ${a.y.toFixed(1)}, ${mx} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  }
  return d;
}

/** 把一串值切成若干**连续段**：null 处断开，两侧各自成段，绝不跨过缺口连线。 */
function runsOf(vals: (number | null)[], xAt: (i: number) => number, yAt: (v: number) => number): Pt[][] {
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  vals.forEach((v, i) => {
    if (v === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else {
      cur.push({ x: xAt(i), y: yAt(v), i });
    }
  });
  if (cur.length) runs.push(cur);
  return runs;
}

const fmtNum = (v: number) =>
  v.toLocaleString("zh-CN", { maximumFractionDigits: 1 });

export function LinePlot({
  points,
  series,
  unit = "",
  band = false,
  axisX,
  ariaLabel,
  emptyText = "这段时间没有数据",
}: Props) {
  // useId 会带冒号（:r1:），直接塞进 url(#…) 虽然能跑，但 id 里带标点的东西
  // 迟早会在某个地方被当成选择器解析，洗掉更省心
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hover, setHover] = useState<number | null>(null);

  const n = points.length;
  const slot = n > 0 ? W / n : W;
  const xAt = (i: number) => (i + 0.5) * slot;
  const base = PT + IH;
  const H = PT + IH + (band ? 26 : 16);

  const { runs, yAt } = useMemo(() => {
    let max = 0;
    for (const p of points) {
      for (const v of p.values) if (v !== null && v > max) max = v;
    }
    // 全为空或全为 0 时给一根假刻度，避免除零把点画到 NaN 上
    const top = max > 0 ? max * 1.15 : 1;
    const y = (v: number) => base - (v / top) * IH;
    return {
      yAt: y,
      runs: series.map((_, si) => runsOf(points.map((p) => p.values[si] ?? null), xAt, y)),
    };
  }, [points, series, slot]);

  if (n === 0) return <div className="empty">{emptyText}</div>;

  // 十字准线：竖直一条，加各系列在该点的放大的空心点
  const cross = hover !== null ? xAt(hover) : 0;
  const hovered = hover !== null ? points[hover] : null;
  const hoveredHasValue = hovered?.values.some((v) => v !== null) ?? false;

  // 提示框贴着光标，往容器较宽敞的一侧展开。用百分比定位，不需要测量宽度。
  const ratio = hover !== null ? xAt(hover) / W : 0;
  const tipStyle: React.CSSProperties =
    ratio > 0.5
      ? { right: `${(1 - ratio) * 100}%`, marginRight: 14, top: 0 }
      : { left: `${ratio * 100}%`, marginLeft: 14, top: 0 };

  const move = (clientX: number, rect: DOMRect) => {
    if (!rect.width) return;
    const sx = ((clientX - rect.left) / rect.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.floor(sx / slot))));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = e.key === "ArrowLeft" ? -1 : 1;
      setHover((h) => Math.max(0, Math.min(n - 1, h === null ? (step > 0 ? 0 : n - 1) : h + step)));
    } else if (e.key === "Escape") {
      setHover(null);
    }
  };

  return (
    <div
      className="plot"
      role="img"
      tabIndex={0}
      aria-label={`${ariaLabel}。可用左右方向键逐点查看`}
      onKeyDown={onKeyDown}
      onBlur={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        aria-hidden="true"
        onMouseMove={(e) => move(e.clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          {/* 斜纹 = 「这个数我们量不到」。它是注释，所以永远不跟主题色沾边。 */}
          <pattern
            id={`hx-${uid}`}
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="5" height="5" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--hatch)" strokeWidth="2.4" />
          </pattern>
          {series.map((s, si) => (
            <linearGradient key={si} id={`gr-${uid}-${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity=".16" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        <line x1="0" y1={base} x2={W} y2={base} stroke="var(--rule)" />

        {/* 面积先铺，折线后压——顺序反了曲线会被自己的渐变糊掉 */}
        {series.map((s, si) =>
          (s.area ?? si === 0)
            ? runs[si]
                .filter((r) => r.length > 1)
                .map((r, ri) => (
                  <path
                    key={`a${si}-${ri}`}
                    d={`${smoothPath(r)} L ${r[r.length - 1].x.toFixed(1)} ${base} L ${r[0].x.toFixed(1)} ${base} Z`}
                    fill={`url(#gr-${uid}-${si})`}
                  />
                ))
            : null,
        )}

        {/* 后面的系列先画，第一条压在最上面：主角不该被配角盖住 */}
        {[...series].reverse().map((s, revIdx) => {
          const si = series.length - 1 - revIdx;
          return runs[si].map((r, ri) => (
            <path
              key={`l${si}-${ri}`}
              d={smoothPath(r)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width ?? (si === 0 ? 2.5 : 2)}
              strokeLinecap="round"
            />
          ));
        })}

        {/*
          真实数据点。**曲线只是引导线，点才是量出来的那个数。**
          唯一的例外是 0：yAt(0) 正好落在基线上，那个点和基线本身重合，
          画出来不增加任何信息，只会让一整排没打字的格子变成一串挤在底线上的圆点。
          线照样穿过 0（0 是真实的量），只是不给它画标记。
        */}
        {[...series].reverse().map((s, revIdx) => {
          const si = series.length - 1 - revIdx;
          const r = s.markerR ?? (si === 0 ? 3.2 : 2.6);
          return runs[si].map((run) =>
            run
              .filter((p) => p.y < base - 0.5)
              .map((p) => (
                <circle
                  key={`m${si}-${p.i}`}
                  cx={p.x.toFixed(1)}
                  cy={p.y.toFixed(1)}
                  r={r}
                  fill="var(--paper)"
                  stroke={s.color}
                  strokeWidth={si === 0 ? 2 : 1.6}
                />
              )),
          );
        })}

        {/* 质量带：基线**下面**。放在数据区域之外，才不会被面积盖住 */}
        {band &&
          points.map((p, i) => {
            if (!p.band || p.band === "none") return null;
            const w = Math.max(slot - 3, 2);
            return (
              <rect
                key={`b${i}`}
                x={i * slot + 1.5}
                y={base + 11}
                width={w}
                height={6}
                rx={2}
                fill={p.band === "exact" ? "var(--band)" : `url(#hx-${uid})`}
              />
            );
          })}

        {hover !== null && (
          <>
            <line
              x1={cross}
              y1={PT - 6}
              x2={cross}
              y2={base}
              stroke="var(--axis)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {series.map((s, si) => {
              const v = points[hover].values[si] ?? null;
              if (v === null) return null;
              return (
                <circle
                  key={`h${si}`}
                  cx={cross}
                  cy={yAt(v)}
                  r={(s.markerR ?? (si === 0 ? 3.2 : 2.6)) + 2.6}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="1.5"
                  opacity=".75"
                />
              );
            })}
          </>
        )}
      </svg>

      {axisX && (
        <div className="axisgrid" style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}>
          {axisX}
        </div>
      )}

      {hovered && hoveredHasValue && (
        <div className="plot-tip" style={tipStyle}>
          <div className="tip-head">{hovered.label}</div>
          {series.map((s, si) => {
            const v = hovered.values[si] ?? null;
            return (
              <div className="tip-row" key={si}>
                <i
                  className="kl"
                  style={{ background: s.color, width: 8, height: 8, borderRadius: 2 }}
                />
                <span>{s.name}</span>
                <b style={v === null ? { color: "var(--muted)", fontWeight: 400 } : undefined}>
                  {v === null ? "量不到" : fmtNum(v) + unit}
                </b>
              </div>
            );
          })}
          {hovered.note && <div className="tip-sub">{hovered.note}</div>}
        </div>
      )}
    </div>
  );
}
