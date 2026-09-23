import { useEffect, useMemo, useState } from "react";
import { LinePlot, axisTick, type PlotPoint } from "../components/LinePlot";
import * as api from "../lib/api";
import { shortDate } from "../lib/dates";
import { formatMinutes, num } from "../lib/metrics";

/** 和 `db::SESSION_GAP_MINUTES` 保持一致。 */
const SESSION_GAP_MINUTES = 5;

/**
 * 写作时间。
 *
 * **这一页不分口径。** 时长就是时长，跟按了几键、打了几个字无关，
 * 所以切顶栏那个开关时它不动——那是故意的，不是没刷新。
 * 页面上必须把这件事写出来，否则用户会以为界面卡了。
 *
 * 两条线共用一根纵轴，单位都是分钟：会话时长永远 ≥ 活跃分钟数
 * （前者含段内的空隙），所以**两条线之间的差距本身就是信息**——
 * 那是坐下来想的时间。
 */
export function Duration({
  day,
  today,
  revision,
  days,
}: {
  day: string;
  today: string;
  revision: number;
  days: number;
}) {
  const [series, setSeries] = useState<api.DailyPoint[] | null>(null);

  const from = api.shiftDay(day, -(days - 1));

  useEffect(() => {
    // `alive` 那道闸门见 `Keys.tsx`：区间变化时新旧两个请求在飞，
    // 先发的可能后回来，把图换成上一个区间的数据。慢的那次越慢越容易发生。
    let alive = true;
    setSeries(null);
    api
      .daily(from, day)
      .then((r) => {
        if (alive) setSeries(r);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [from, day, revision]);

  const points = useMemo<PlotPoint[]>(
    () =>
      (series ?? []).map((d) => ({
        label: shortDate(d.day),
        values: [d.sessionMinutes, d.activeMinutes],
      })),
    [series],
  );

  if (!series) return <div className="empty">正在加载…</div>;

  const hasTime = series.some((d) => d.sessionMinutes > 0);
  /**
   * 区间最后那一格要不要排除掉。
   *
   * **只有它真的是今天时才排除**：今天天数不满一天，混进平均里会把日均拉低一截。
   * 翻到过去的日子时那一格也是完整的一天，**必须一起算进均值**——
   * 否则看 9/23 时会把 9/23 整天平白排除在外，除数少一天，均值凭空变高。
   */
  const partial = day === today;
  const full = series.filter(
    (d) => (!partial || d.day !== day) && d.sessionMinutes > 0,
  );
  const avgS = full.length ? Math.round(full.reduce((s, d) => s + d.sessionMinutes, 0) / full.length) : 0;
  const avgA = full.length ? Math.round(full.reduce((s, d) => s + d.activeMinutes, 0) / full.length) : 0;
  // 注意「最长的一段」只有今天算得出来（TodaySummary 里才有 longestMinutes）；
  // 按天汇总的表里没有这个字段，所以这里给的是「最长的一天」= 会话时长最大的那天。
  // 两者不是一回事，标签上必须说实话。
  const longestDay = series.reduce<api.DailyPoint | null>(
    (m, d) => (m === null || d.sessionMinutes > m.sessionMinutes ? d : m),
    null,
  );
  const best = series.reduce<api.DailyPoint | null>(
    (m, d) => (m === null || d.activeMinutes > m.activeMinutes ? d : m),
    null,
  );
  const totalS = series.reduce((s, d) => s + d.sessionMinutes, 0);
  const totalA = series.reduce((s, d) => s + d.activeMinutes, 0);

  return (
    <section className="page">
      <p className="eyebrow">时长 · 近 {days} 天</p>
      <h2 className="sec">写作时间</h2>
      <p className="sub">
        「坐下来多久」和「真正在敲多久」是两回事，都画出来 · 单位分钟，<b>不跟口径开关走</b>
      </p>

      {!hasTime ? (
        <div className="empty">这段时间还没有数据</div>
      ) : (
        <>
          <LinePlot
            points={points}
            unit=" 分"
            ariaLabel={`近 ${days} 天的写作时间`}
            emptyText="这段时间还没有数据"
            axisX={points.map((p, i) => (
              <span key={i}>{axisTick(i, points.length) ? p.label : ""}</span>
            ))}
            series={[
              { name: "会话时长", color: "var(--series-1)" },
              { name: "活跃分钟数", color: "var(--series-2)", area: false },
            ]}
          />

          <div className="keyline">
            <span>
              <i className="kl kl-s1" />
              坐下来的时间（含中间发呆的空隙）
            </span>
            <span>
              <i className="kl kl-s2" />
              真正在敲的分钟数
            </span>
          </div>

          <p className="caption">
            两条线一根轴，单位都是<b>分钟</b>，所以比得出高低。
            中间那段差值就是「坐着没敲」——它不该被当成偷懒，写作本来就有想的时间。
          </p>

          <div className="ledger">
            <div>
              <div className="k">日均坐下</div>
              {/* 一个完整的日子都没有时印「—」，**不印 0**：那是「算不出来」，
                  不是「平均每天坐 0 分钟」——这条线上每一格都在守同一件事。 */}
              <div className="v">
                {full.length === 0 ? (
                  "—"
                ) : (
                  <>
                    {num(avgS)}
                    <small> 分</small>
                  </>
                )}
              </div>
              {/* 分母必须印成 `full.length`——那才是上面那个数真正除的天数。
                  原来印的是「有数据的天数」但含今天，而 `full` 把今天排掉了，
                  于是说明里的天数比实际除的数大 1（今天真的有数据时）。 */}
              <div className="n">
                {full.length === 0
                  ? `这 ${days} 天里只有今天有数据，算不出日均`
                  : `按有数据的 ${full.length} 天算${partial ? "，不含今天（今天还没过完）" : ""}`}
              </div>
            </div>
            <div>
              <div className="k">日均真敲</div>
              <div className="v">
                {full.length === 0 ? (
                  "—"
                ) : (
                  <>
                    {num(avgA)}
                    <small> 分</small>
                  </>
                )}
              </div>
              <div className="n">有按键的分钟数，一分钟内敲一下也算一分钟</div>
            </div>
            <div>
              <div className="k">坐得最久的一天</div>
              <div className="v">{longestDay ? shortDate(longestDay.day) : "—"}</div>
              <div className="n">
                {longestDay
                  ? `坐下 ${formatMinutes(longestDay.sessionMinutes)}`
                  : "还没有数据"}
              </div>
            </div>
            <div>
              <div className="k">敲得最猛的一天</div>
              <div className="v">{best ? shortDate(best.day) : "—"}</div>
              <div className="n">
                {best ? `真敲 ${formatMinutes(best.activeMinutes)}` : "还没有数据"}
              </div>
            </div>
          </div>

          <p className="caption">
            这 {days} 天一共坐了 <b>{formatMinutes(totalS)}</b>，其中真正在敲{" "}
            <b>{formatMinutes(totalA)}</b>——也就是说大约{" "}
            <b>{Math.round((totalA / Math.max(totalS, 1)) * 100)}%</b> 的时间里手在键盘上。
            这个比例低不代表效率低：想清楚再写比边想边敲快。
            两段之间间隔不超过 {SESSION_GAP_MINUTES} 分钟就算同一段，段里的空隙也计入坐下的时长。
          </p>
        </>
      )}
    </section>
  );
}
