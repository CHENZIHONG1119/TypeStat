import { useEffect, useMemo, useState } from "react";
import { LinePlot, axisTick, type PlotPoint } from "../components/LinePlot";
import * as api from "../lib/api";
import { shortDate } from "../lib/dates";
import { num, pct, resolveMode, unitOf, type MetricMode } from "../lib/metrics";

/**
 * 输入与删除的趋势。
 *
 * 两条线共用一根纵轴，单位一致——**「字」和「键」永远不会出现在同一根轴上**，
 * 所以口径是全局开关而不是「哪个应用有字数就用字数」。
 *
 * 删除线一直贴在底部是正常的：删除只有输入的百分之几。为了看清它的形状，
 * 共用一根轴是必须付出的代价——如果给删除单独一根轴，它看起来就会和输入一样高，
 * 那是骗人的。
 */
export function Trends({
  day,
  revision,
  metric,
  days,
}: {
  day: string;
  revision: number;
  metric: MetricMode;
  days: number;
}) {
  const [series, setSeries] = useState<api.DailyPoint[] | null>(null);

  const from = api.shiftDay(day, -(days - 1));

  useEffect(() => {
    setSeries(null);
    api.daily(from, day).then(setSeries).catch(console.error);
  }, [from, day, revision]);

  const hasAnyChar = useMemo(() => (series ?? []).some((d) => d.hasChar), [series]);
  const mode = resolveMode(metric, hasAnyChar);
  const precise = mode === "char";
  const fellBack = !precise && metric === "char";
  const unit = unitOf(mode);

  const points = useMemo<PlotPoint[]>(
    () =>
      (series ?? []).map((d) => ({
        label: shortDate(d.day),
        // 有精确数据的天才画点；没有的天给 null，线在那里断开。
        // **不能给 0**——0 读起来是「那天一个字没打」，而事实是量不到。
        values: precise
          ? [d.hasChar ? d.charInput : null, d.hasChar ? d.charDelete : null]
          : [d.keyInput, d.keyDelete],
        // 只有在字数口径下，质量带才有「这一格的数可不可信」这层意思。
        band: !precise ? undefined : d.keyInput === 0 ? "none" : d.hasChar ? "exact" : "keys",
      })),
    [series, precise],
  );

  if (!series) return <div className="empty">正在加载…</div>;

  const gapDays = precise ? series.filter((d) => !d.hasChar).length : 0;
  const sumIn = series.reduce((s, d) => s + (precise ? (d.hasChar ? d.charInput : 0) : d.keyInput), 0);
  const sumDel = series.reduce((s, d) => s + (precise ? (d.hasChar ? d.charDelete : 0) : d.keyDelete), 0);
  const best = series.reduce<api.DailyPoint | null>(
    (m, d) => {
      const v = (x: api.DailyPoint) => (precise ? (x.hasChar ? x.charInput : -1) : x.keyInput);
      return m === null || v(d) > v(m) ? d : m;
    },
    null,
  );
  const avg = series.length ? Math.round(sumIn / series.length) : 0;

  const inputName = precise ? "输入字数" : "输入按键";
  const delName = precise ? "删除字数" : "删除按键";

  return (
    <section className="page">
      <p className="eyebrow">趋势 · 近 {days} 天</p>
      <h2 className="sec">{precise ? "每天写了多少字" : "每天敲了多少次键"}</h2>
      <p className="sub">
        两条线同一单位，共用一根纵轴 · 「字」和「键」永远不会出现在同一根轴上
      </p>

      {fellBack && (
        <p className="note">
          这段时间还没有任何<b>精确字数</b>数据，显示的是<b>按键数</b>。
        </p>
      )}

      {series.length === 0 ? (
        <div className="empty">这段时间还没有数据</div>
      ) : (
        <>
          <LinePlot
            points={points}
            band={precise}
            unit={` ${unit}`}
            ariaLabel={`近 ${days} 天的输入与删除`}
            emptyText="这段时间还没有数据"
            axisX={points.map((p, i) => (
              <span key={i}>{axisTick(i, points.length) ? p.label : ""}</span>
            ))}
            series={[
              { name: inputName, color: "var(--series-1)" },
              { name: delName, color: "var(--series-2)", area: false },
            ]}
          />

          <div className="keyline">
            <span>
              <i className="kl kl-s1" />
              {inputName}
            </span>
            <span>
              <i className="kl kl-s2" />
              {delName}
            </span>
            {precise && (
              <>
                <span>
                  <i className="kl kl-band" />
                  那天有精确字数
                </span>
                <span>
                  <i className="kl kl-hatch" />
                  那天的字数不全（或量不到）
                </span>
              </>
            )}
          </div>

          {precise && gapDays > 0 && (
            <p className="caption">
              <b>线断开的那几天不是「没打字」，是没有精确数据</b>（那时还没装适配器）。
              {days} 天里有 {gapDays} 天是这样——切到「按键」口径能看到完整的一条线。
            </p>
          )}

          <p className="caption">
            删除线一直贴在底部是正常的——<b>删除只有输入的百分之几</b>。
            为了看清它的形状，两条线共用一根轴是必须付出的代价：
            如果给删除单独一根轴，它看起来就会和输入一样高，那是骗人的。
          </p>

          <div className="ledger">
            <div>
              <div className="k">{days} 天合计输入</div>
              <div className="v">
                {num(sumIn)}
                <small> {unit}</small>
              </div>
              <div className="n">只算量得到的天</div>
            </div>
            <div>
              <div className="k">{days} 天合计删除</div>
              <div className="v">
                {num(sumDel)}
                <small> {unit}</small>
              </div>
              <div className="n">和「输入」同一批数据</div>
            </div>
            <div>
              <div className="k">删除率</div>
              <div className="v">{pct(sumIn > 0 ? sumDel / sumIn : 0)}</div>
              <div className="n">删除 ÷ 输入，按合计算而不是按天平均</div>
            </div>
            <div>
              <div className="k">最猛的一天</div>
              <div className="v">{best ? shortDate(best.day) : "—"}</div>
              <div className="n">日均 {num(avg)} {unit}</div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
