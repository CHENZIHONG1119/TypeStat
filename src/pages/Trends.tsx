import { useEffect, useMemo, useState } from "react";
import { LinePlot, axisTick, type PlotPoint } from "../components/LinePlot";
import * as api from "../lib/api";
import { shortDate } from "../lib/dates";
import {
  isBlankCell,
  num,
  pct,
  preciseValue,
  resolveMode,
  unitOf,
  type MetricMode,
} from "../lib/metrics";

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

  /**
   * 区间按天补全。
   *
   * `daily_series` 是 `GROUP BY local_day` 出来的，**没有行等于那天一分钟都没记录**，
   * 也就是真的没打字。不补的话 x 轴会被压缩：选「近 7 天」而中间四天没打字时，
   * 图上剩三个点会挨着画，读起来像连着三天——那四天的间隔凭空消失了，
   * 曲线的时间密度是假的。补成 0 之后，横轴才是等距的日期。
   *
   * 补出来的 `hasChar: false` 不表示「量不到」：没有按键就不可能有字符，
   * 它是确定的 0，交给 `preciseValue` 去分辨（见 `metrics.ts`）。
   */
  const filled = useMemo<api.DailyPoint[]>(() => {
    const byDay = new Map((series ?? []).map((d) => [d.day, d]));
    return Array.from({ length: days }, (_, i) => {
      const key = api.shiftDay(from, i);
      return (
        byDay.get(key) ?? {
          day: key,
          keyInput: 0,
          keyDelete: 0,
          charInput: 0,
          charDelete: 0,
          netChars: 0,
          hasChar: false,
          activeMinutes: 0,
          sessionMinutes: 0,
        }
      );
    });
  }, [series, from, days]);

  const hasAnyChar = useMemo(() => filled.some((d) => d.hasChar), [filled]);
  const mode = resolveMode(metric, hasAnyChar);
  const precise = mode === "char";
  const fellBack = !precise && metric === "char";
  const unit = unitOf(mode);

  /**
   * 每一格的取值。`null` 是「量不到」，不是 0——这个区分是本项目的核心，
   * 判据集中在 `preciseValue` 一处。
   */
  const parts = useMemo(
    () =>
      filled.map((d) => ({
        d,
        input: precise ? preciseValue(d, "charInput") : d.keyInput,
        del: precise ? preciseValue(d, "charDelete") : d.keyDelete,
      })),
    [filled, precise],
  );

  const points = useMemo<PlotPoint[]>(
    () =>
      parts.map((p) => ({
        label: shortDate(p.d.day),
        values: [p.input, p.del],
        // 只有在字数口径下，质量带才有「这一格的数可不可信」这层意思。
        band: !precise
          ? undefined
          : isBlankCell(p.d)
            ? "none"
            : p.d.hasChar
              ? "exact"
              : "keys",
      })),
    [parts, precise],
  );

  if (!series) return <div className="empty">正在加载…</div>;

  const anyData = filled.some((d) => !isBlankCell(d));

  // 断线的是「在打字但字数量不到」的天。补出来的空白天**不算**：
  // 那天是真没打字，不是量不到——混进去会让这句解释本身说谎。
  const gapDays = precise
    ? filled.filter((d) => !isBlankCell(d) && !d.hasChar).length
    : 0;

  const sumIn = parts.reduce((s, p) => s + (p.input ?? 0), 0);
  const sumDel = parts.reduce((s, p) => s + (p.del ?? 0), 0);
  /**
   * 真正贡献了上面那个和的天数。
   *
   * **分母必须跟着分子走。** 字数口径下「量不到」的天不参与求和，
   * 那它也不该进分母——拿「WPS 的字数 ÷ 全部 7 天」算出来的日均，
   * 会随这一周有多少天在别的编辑器里打字而变，而你的手速没变。
   * 这和 `metrics.ts` 里 `typingSpeed` 的分子分母同源是同一条规矩。
   */
  const counted = parts.filter((p) => p.input !== null).length;
  const avg = counted > 0 ? Math.round(sumIn / counted) : null;

  const best = parts.reduce<(typeof parts)[number] | null>(
    (m, p) =>
      p.input !== null && p.input > 0 && (m === null || p.input > (m.input ?? 0)) ? p : m,
    null,
  );

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

      {!anyData ? (
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
              <div className="n">
                {counted === days
                  ? "区间内每天的量都在内"
                  : `只算量得到的 ${counted} 天`}
              </div>
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
              {/* 分母是 0 时给「—」而不是 0.0%：这一段本来就没有输入，
                  印成「删除率 0.0%」看着像量过了、发现你没删过东西。 */}
              <div className="v">{sumIn > 0 ? pct(sumDel / sumIn) : "—"}</div>
              <div className="n">删除 ÷ 输入，按合计算而不是按天平均</div>
            </div>
            <div>
              <div className="k">最猛的一天</div>
              <div className="v">{best ? shortDate(best.d.day) : "—"}</div>
              <div className="n">
                {avg === null
                  ? "这段时间没有输入"
                  : `日均 ${num(avg)} ${unit}${
                      counted === days ? "" : `（量得到的 ${counted} 天）`
                    }`}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
