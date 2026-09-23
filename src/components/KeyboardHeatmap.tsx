import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { num } from "../lib/metrics";
import { rampColor, Tokens } from "../theme";
import {
  displayName,
  FLAT_KEYS,
  inkFor,
  KEY_ROWS,
  normalize,
  offMapName,
  ROW_UNITS,
  slotIndex,
} from "../lib/keyboard";

/** 键帽之间留的缝。2px 是规范里相邻色块的最小间隔，再窄两块颜色就糊在一起了。 */
const GAP = 2;
/** 键高占键宽的比例。真实键帽比正方形扁一些。 */
const KEY_H_RATIO = 0.9;

interface Props {
  tokens: Tokens;
  data: api.KeyUsage[];
}

interface Aggregated {
  /** 每个界面键位的次数，索引与 FLAT_KEYS 一致。 */
  counts: number[];
  total: number;
  max: number;
  /** 有数据但不在图上（小键盘、F 区、输入法键…）。 */
  offMap: number;
  /** 图外按键的明细，按次数降序。只报总数的话用户会以为数据丢了。 */
  offMapList: { name: string; count: number }[];
  top: { name: string; count: number } | null;
}

function aggregate(data: api.KeyUsage[]): Aggregated {
  const counts = new Array<number>(FLAT_KEYS.length).fill(0);
  let total = 0;
  let offMap = 0;
  const off = new Map<string, number>();

  for (const row of data) {
    total += row.count;
    const i = slotIndex(row.vkCode, row.scanCode, row.extended);
    if (i < 0) {
      offMap += row.count;
      const name = offMapName(row.vkCode, row.scanCode);
      off.set(name, (off.get(name) ?? 0) + row.count);
    } else {
      // 同一个界面键位可能由多行数据库记录汇入：钩子上报的可能是分左右的
      // VK_LSHIFT，也可能是通用的 VK_SHIFT，两者都指向图上同一个格子。
      counts[i] += row.count;
    }
  }

  let max = 0;
  let top: Aggregated["top"] = null;
  counts.forEach((c, i) => {
    if (c > max) max = c;
    if (c > 0 && (!top || c > top.count)) top = { name: displayName(FLAT_KEYS[i]), count: c };
  });

  const offMapList = [...off.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { counts, total, max, offMap, offMapList, top };
}

export function KeyboardHeatmap({ tokens, data }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [unit, setUnit] = useState(44);
  const [useSqrt, setUseSqrt] = useState(true);
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const [showTable, setShowTable] = useState(false);

  const agg = useMemo(() => aggregate(data), [data]);

  // 键位单位宽跟随容器，整张图不用手写断点。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setUnit(w / ROW_UNITS);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const keyH = unit * KEY_H_RATIO;
  const height = KEY_ROWS.length * keyH;
  const showLabels = unit >= 26;
  const fontSize = Math.max(9, Math.min(13, unit * 0.25));

  const cells = useMemo(() => {
    const out: JSX.Element[] = [];
    let i = 0;
    KEY_ROWS.forEach((row, r) => {
      let offset = 0;
      for (const k of row.keys) {
        const idx = i++;
        const count = agg.counts[idx];
        // 有数据的键按色阶上色；没按过的键用中性灰，跟"很少但非零"区分开——
        // 都涂成最浅一档的话，"没按过"和"按了一次"看起来会一样。
        const fill = count > 0 ? rampColor(tokens, normalize(count, agg.max, useSqrt)) : tokens.grid;
        // 没按过的键用次级墨色而不是最淡的那一档：标签是要读的，
        // 淡灰压在淡灰底上看着像渲染坏了。
        const ink = count > 0 ? inkFor(fill) : tokens.textSecondary;
        out.push(
          <div
            key={idx}
            className="kb-key"
            role="img"
            aria-label={`${displayName(k)}：${count} 次`}
            style={{
              left: offset * unit + GAP / 2,
              top: r * keyH + GAP / 2,
              width: k.w * unit - GAP,
              height: keyH - GAP,
              background: fill,
              color: ink,
              fontSize,
              borderColor: tokens.border,
            }}
            onMouseEnter={(e) => setTip({ i: idx, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => setTip({ i: idx, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => setTip(null)}
          >
            {showLabels && <span>{k.label}</span>}
          </div>,
        );
        offset += k.w;
      }
    });
    return out;
  }, [unit, keyH, fontSize, agg, tokens, showLabels, useSqrt]);

  const tipKey = tip ? FLAT_KEYS[tip.i] : null;
  const tipCount = tip ? agg.counts[tip.i] : 0;

  const share = agg.total > 0 ? (tipCount / agg.total) * 100 : 0;

  const ranked = useMemo(
    () =>
      agg.counts
        .map((c, i) => ({ name: displayName(FLAT_KEYS[i]), count: c }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
    [agg],
  );

  if (agg.total === 0) {
    return (
      <div className="empty">
        这段区间还没有键位数据。敲几下键盘就会出现在这里——数据按天汇总，不需要等很久。
      </div>
    );
  }

  return (
    <div className="kbm">
      <div className="kbm-head">
        <div className="kbm-stats">
          <span>
            区间内共 <b>{num(agg.total)}</b> 次按键
          </span>
          {agg.top && (
            <span>
              按得最多的是 <b>{agg.top.name}</b>（{num(agg.top.count)} 次）
            </span>
          )}
          {agg.offMap > 0 && (
            <span
              className="kbm-offmap"
              title="方向键、F 区、小键盘等不在 60% 布局图上的按键。这些键按得再多也上不了图，所以单独列出来。"
            >
              另有 {num(agg.offMap)} 次在图外：
              {agg.offMapList
                .slice(0, 4)
                .map((r) => `${r.name} ${num(r.count)}`)
                .join("、")}
              {agg.offMapList.length > 4 && ` 等 ${agg.offMapList.length} 个键`}
            </span>
          )}
        </div>
        <div className="kbm-controls">
          <button
            className="btn btn-sm"
            onClick={() => setUseSqrt((v) => !v)}
            title="键频相差可达上百倍，线性映射会把大部分键压进最浅的一档"
          >
            缩放：{useSqrt ? "平方根" : "线性"}
          </button>
          <button className="btn btn-sm" onClick={() => setShowTable((v) => !v)}>
            {showTable ? "看键盘" : "看表格"}
          </button>
        </div>
      </div>

      {showTable ? (
        <table className="data">
          <thead>
            <tr>
              <th>键</th>
              <th className="num">次数</th>
              <th className="num">占比</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="num">{num(r.count)}</td>
                <td className="num">{((r.count / agg.total) * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="kb-wrap" ref={wrapRef}>
          <div className="kb" style={{ height }}>
            {cells}
          </div>
        </div>
      )}

      <div className="kbm-legend">
        {!showLabels && (
          <span className="kbm-legend-label">窗口太窄，键帽文字已隐藏；悬停仍可看次数</span>
        )}
        <span className="kbm-legend-label">少</span>
        <span
          className="kbm-ramp"
          style={{
            background: `linear-gradient(90deg, ${tokens.sequential.join(", ")})`,
          }}
        />
        <span className="kbm-legend-label">多（{num(agg.max)} 次）</span>
        <span className="kbm-none-swatch" style={{ background: tokens.grid }} />
        <span className="kbm-legend-label">没按过</span>
      </div>

      {tip && tipKey && (
        <Tip x={tip.x} y={tip.y} surface={tokens.surface} border={tokens.border} text={tokens.textPrimary}>
          <b>{displayName(tipKey)}</b>
          <span>
            {tipCount > 0 ? `${num(tipCount)} 次 · 占 ${share.toFixed(1)}%` : "这段区间没按过"}
          </span>
          {useSqrt && tipCount > 0 && (
            <span className="tip-sub">
              颜色档位 {Math.round(normalize(tipCount, agg.max) * (tokens.sequential.length - 1)) + 1} /{" "}
              {tokens.sequential.length}
            </span>
          )}
        </Tip>
      )}
    </div>
  );
}

/** 跟随光标的提示框。靠近视口边缘时自动翻到另一侧，免得被截断。 */
function Tip({
  x,
  y,
  surface,
  border,
  text,
  children,
}: {
  x: number;
  y: number;
  surface: string;
  border: string;
  text: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 14, top: y + 14 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = x + 14 + r.width > window.innerWidth - 8 ? x - r.width - 14 : x + 14;
    const top = y + 14 + r.height > window.innerHeight - 8 ? y - r.height - 14 : y + 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="kbm-tip"
      style={{ left: pos.left, top: pos.top, background: surface, borderColor: border, color: text }}
    >
      {children}
    </div>
  );
}
