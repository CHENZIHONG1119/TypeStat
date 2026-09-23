import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { shortDate } from "../lib/dates";
import { num } from "../lib/metrics";
import { rampColor } from "../theme";
import { useTokens } from "../lib/useTheme";

/**
 * 热力图最多渲染这么多行。再多格子就小到看不见了，问题会变成「窗口不够宽」，
 * 而不是「数据更多」。
 */
export const HEATMAP_MAX_DAYS = 14;

/**
 * 活跃热力图：日期 × 小时。
 *
 * **这张图只用按键数，不跟口径开关走。** 理由是热力图靠深浅来比较，
 * 而深浅要成立，每一格就必须是同一种量：字数只在极少数格子里量得到，
 * 混进来之后「深」会变成两种意思（打得多的那一格 / 唯一量得到的那一格）。
 * 按键数每一格都是全的，所以它是唯一能撑起这张图的量。
 * 这件事必须在页面上写出来，否则用户会以为切开关时页面卡住了。
 */
export function Heat({ day, revision, days }: { day: string; revision: number; days: number }) {
  const t = useTokens();
  const [cells, setCells] = useState<api.CellPoint[] | null>(null);

  const showDays = Math.min(days, HEATMAP_MAX_DAYS);
  const from = api.shiftDay(day, -(showDays - 1));

  useEffect(() => {
    setCells(null);
    api.cellGrid(from, day).then(setCells).catch(console.error);
  }, [from, day, revision]);

  const view = useMemo(() => {
    const list = cells ?? [];
    // 按日期分组，缺的日期补成空行——不补的话行会错位，
    // 而错位的热力图看起来完全正常，只是每一天都标错了名字。
    const byDay = new Map<string, Map<number, number>>();
    for (const c of list) {
      if (!byDay.has(c.day)) byDay.set(c.day, new Map());
      byDay.get(c.day)!.set(c.hour, c.keyInput);
    }
    const dayList = Array.from({ length: showDays }, (_, i) => api.shiftDay(from, i));
    let max = 0;
    for (const [, hours] of byDay) for (const [, v] of hours) if (v > max) max = v;

    // 最忙的钟点：24 个钟点各自把整段区间加起来，取最大的那个。
    // **不写死**——写死的话数据一换这句话就成了错的，而它看起来还像是对的。
    let busiest = 0;
    let bestSum = -1;
    for (let h = 0; h < 24; h++) {
      let s = 0;
      for (const [, hours] of byDay) s += hours.get(h) ?? 0;
      if (s > bestSum) {
        bestSum = s;
        busiest = h;
      }
    }

    return { byDay, dayList, max, busiest, bestSum };
  }, [cells, from, showDays]);

  if (!cells) return <div className="empty">正在加载…</div>;

  const { byDay, dayList, max, busiest, bestSum } = view;
  const filledCells = cells.filter((c) => c.keyInput > 0).length;
  const hasAny = cells.some((c) => c.keyInput > 0);

  const fillOf = (v: number) =>
    v <= 0 ? t.grid : rampColor(t, v / Math.max(max, 1));

  return (
    <section className="page">
      <p className="eyebrow">热力 · 近 {showDays} 天</p>
      <h2 className="sec">你都在什么时候打字</h2>
      <p className="sub">
        一格是一小时 · 一格一天横向排开 · 颜色越深打得越多 · <b>单位是按键数</b>
      </p>

      {!hasAny ? (
        <div className="empty">这段时间还没有数据</div>
      ) : (
        <>
          <div style={{ marginTop: 26 }}>
            {dayList.map((d) => (
              <div className="heat-row" key={d}>
                <div className="heat-day">{shortDate(d)}</div>
                <div className="heat-cells">
                  {Array.from({ length: 24 }, (_, h) => {
                    const v = byDay.get(d)?.get(h) ?? 0;
                    return (
                      <i
                        key={h}
                        className="heat-cell"
                        style={{ background: fillOf(v) }}
                        title={`${shortDate(d)} ${h} 时 · ${v > 0 ? `${num(v)} 键` : "没打字"}`}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="heat-axis">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h}>{h % 3 === 0 ? h : ""}</span>
            ))}
          </div>

          <div className="ramp">
            <span>少</span>
            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((r) => (
              <i key={r} style={{ background: r === 0 ? t.grid : rampColor(t, r) }} />
            ))}
            <span>多</span>
            <span className="gap" />
            <span>
              最深的一格 = <b>{num(max)}</b> 次/时
            </span>
          </div>

          <p className="caption">
            这张图<b>只用按键数，不跟口径开关走</b>——热力靠深浅比较，
            而深浅要成立，每一格就得是同一种量。字数只在少数几格里量得到，
            混进来之后「深」会变成两种意思。空白的格子是<b>真的没打字</b>，
            不是「量不到」：按键数是全量的，这一格有没有数一目了然。
          </p>

          <div className="ledger">
            <div>
              <div className="k">最忙的钟点</div>
              <div className="v">
                {bestSum > 0 ? busiest : "—"}
                <small> 时</small>
              </div>
              <div className="n">
                {showDays} 天里这个钟点一共 {num(bestSum)} 次
              </div>
            </div>
            <div>
              <div className="k">数据天数</div>
              <div className="v">
                {showDays}
                <small> 天</small>
              </div>
              <div className="n">每行一天，缺的日期也留行</div>
            </div>
            <div>
              <div className="k">有打字的小时</div>
              <div className="v">
                {filledCells}
                <small> 格</small>
              </div>
              <div className="n">一格至少敲了一下</div>
            </div>
            <div>
              <div className="k">空白格</div>
              <div className="v">
                {showDays * 24 - filledCells}
                <small> 格</small>
              </div>
              <div className="n">没打字，不是没数据</div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
