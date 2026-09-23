import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { dayWord, shortDate } from "../lib/dates";
import { num, resolveMode, shortName, unitOf, type MetricMode } from "../lib/metrics";

/** 排行榜最多显示这么多条，超出的折进「其他」而不是继续堆颜色。 */
export const TOP_N = 10;

/**
 * 这一天在哪儿打得多。
 *
 * 字数口径下最危险的一件事，是把没有适配器的应用显示成 0——
 * 那不是「没打字」，是「量不到」。从图里排除掉，并在正文里点名，
 * 明细页里则完整列出（那里显示「—」）。
 *
 * `day` 可以是过去的日子，所以页面上不能出现写死的「今天」——用 `when` / `thatDay`。
 */
export function Apps({
  day,
  today,
  revision,
  metric,
}: {
  day: string;
  today: string;
  revision: number;
  metric: MetricMode;
}) {
  const [apps, setApps] = useState<api.AppPoint[] | null>(null);

  const isToday = day === today;
  const when = dayWord(day, today);
  const thatDay = isToday ? "今天" : `${shortDate(day)} 那天`;

  useEffect(() => {
    // `alive` 那道闸门见 `Keys.tsx`：`day` 现在会在运行时变（跨过午夜或翻日期），
    // 而请求是并发的，迟到的那次会让排行榜排的是另一天。
    let alive = true;
    api
      .appBreakdown(day)
      .then((r) => {
        if (alive) setApps(r);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [day, revision]);

  /**
   * 判定标准必须是「有没有适配器上报过」，**不是 `charInput > 0`**。
   * 用后者的话，某天最早那几行还来不及产生字数时整页会走按键口径，
   * 敲下第一个字之后又跳回字数口径——数据没变，界面却整个换了一套数字。
   */
  const hasAnyChar = (apps ?? []).some((a) => a.charSource !== null);
  const mode = resolveMode(metric, hasAnyChar);
  const precise = mode === "char";
  const fellBack = !precise && metric === "char";
  const unit = unitOf(mode);

  const view = useMemo(() => {
    const list = apps ?? [];
    const value = (a: api.AppPoint) => (precise ? a.charInput : a.keyInput);
    const covered = precise ? list.filter((a) => a.charSource !== null) : list;
    const excluded = precise ? list.filter((a) => a.charSource === null) : [];
    const sorted = [...covered].sort((a, b) => value(b) - value(a));
    const top = sorted.slice(0, TOP_N);
    const max = Math.max(...top.map(value), 1);
    return { covered, excluded, top, max, rest: Math.max(0, sorted.length - top.length), value };
  }, [apps, precise]);

  if (!apps) return <div className="empty">正在加载…</div>;

  const { covered, excluded, top, max, rest, value } = view;

  if (apps.length === 0) {
    return (
      <section className="page">
        <p className="eyebrow">应用 · {when}</p>
        <h2 className="sec">{thatDay}在哪儿打得多</h2>
        <div className="empty">{when}还没有记录到输入</div>
      </section>
    );
  }

  return (
    <section className="page">
      <p className="eyebrow">应用 · {when}</p>
      <h2 className="sec">{precise ? "字数都写在哪儿了" : "按键都敲在哪儿了"}</h2>
      <p className="sub">
        {precise
          ? "只有装了适配器的应用才拿得到字数，其余的应用在字数口径下是隐形的"
          : "按键数覆盖所有应用，所以它才是那张完整的图"}
        {covered.length > TOP_N && ` · 仅显示前 ${TOP_N} 个`}
      </p>

      {fellBack && (
        <p className="note">
          {when}还没有任何<b>精确字数</b>数据（没装适配器，或装了还没敲过字），
          下面显示的是<b>按键数</b>。
        </p>
      )}

      <div style={{ marginTop: 26 }}>
        {top.map((a) => {
          const v = value(a);
          const lacks = precise && a.charSource === null;
          return (
            <div className="wa" key={a.app}>
              <div className="n">{shortName(a.app)}</div>
              <div className={`bar${lacks ? " bar-h" : ""}`} style={{ width: `${(v / max) * 100}%` }} />
              <div className="v">
                {num(v)} {unit}
                {lacks && <em> · 无字数</em>}
              </div>
            </div>
          );
        })}
        {rest > 0 && (
          <p className="caption" style={{ marginTop: 14 }}>
            另有 <b>{rest}</b> 个应用没排上——明细页里有全部。
          </p>
        )}
      </div>

      <div className="keyline" style={{ marginTop: 20 }}>
        <span>
          <i className="kl kl-s1" />
          {precise ? "有精确字数（适配器上报）" : "输入按键数"}
        </span>
        {precise && (
          <span>
            <i className="kl kl-hatch" />
            只有按键数，字数量不到
          </span>
        )}
      </div>

      {precise && excluded.length > 0 && (
        <p className="caption">
          <b>已排除 {excluded.length} 个只有按键数的应用</b>：
          {excluded.map((a) => shortName(a.app)).join("、")}。
          <b>排除不等于没写</b>——它们{when}也有输入，只是拿不到精确字数。
          把它们画进这张图，要么得写 0（谎话），要么得混进另一种单位（读不了）。
          切到「按键」口径能看到全部。
        </p>
      )}

      <p className="caption">
        判定一个应用「有没有精确字数」，看的是<b>有没有适配器上报过</b>，
        不是「字数大于 0」。一个装了适配器但{when}没写字的应用，
        和另一个没装适配器的应用，是两件不同的事——
        前者是 0，后者是量不到。
      </p>
    </section>
  );
}
