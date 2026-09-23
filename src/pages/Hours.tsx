import { useEffect, useMemo, useState } from "react";
import { LinePlot, axisTick, type BandState, type PlotPoint } from "../components/LinePlot";
import * as api from "../lib/api";
import { longDate } from "../lib/dates";
import { coverageNote, num, resolveMode, unitOf, type MetricMode } from "../lib/metrics";

/**
 * 今天的小时曲线。一个页面就这一张图。
 *
 * 这张图最容易出的错，是把「量不到」画成 0：在字数口径下，没有精确数据的那一小时
 * 如果画成 0，线上会出现一个谷底，看着像「那一小时没打字」——而事实是那时段在打字，
 * 只是没人告诉我们打了几个字。所以那些点一律给 `null`（线在那里断开），
 * 并在基线下面用一条细带标出「这个数是从哪儿来的」。
 */
export function Hours({
  day,
  revision,
  metric,
}: {
  day: string;
  revision: number;
  metric: MetricMode;
}) {
  const [hours, setHours] = useState<api.HourPoint[] | null>(null);

  useEffect(() => {
    api.hourly(day).then(setHours).catch(console.error);
  }, [day, revision]);

  const hasAnyChar = useMemo(
    () => (hours ?? []).some((h) => h.hasChar),
    [hours],
  );
  const mode = resolveMode(metric, hasAnyChar);
  const precise = mode === "char";
  const fellBack = !precise && metric === "char";
  const unit = unitOf(mode);

  const cells = useMemo(
    () =>
      Array.from({ length: 24 }, (_, h) => {
        const p = (hours ?? []).find((x) => x.hour === h);
        return {
          h,
          p,
          input: precise ? (p?.hasChar ? p.charInput : null) : (p?.keyInput ?? 0),
          del: precise ? (p?.hasChar ? p.charDelete : null) : (p?.keyDelete ?? 0),
        };
      }),
    [hours, precise],
  );

  if (!hours) return <div className="empty">正在加载…</div>;

  const points: PlotPoint[] = cells.map((c) => {
    const p = c.p;
    // 质量带：实心 = 这一小时有精确字数，斜纹 = 只有按键数，不画 = 真的没打字。
    // **只在字数口径下才有意义**——按键口径下每一格都是全的，打斜纹等于谎报缺失。
    const band: BandState =
      p && p.keyInput > 0 ? (p.hasChar && p.charInput > 0 ? "exact" : "keys") : "none";

    // 半覆盖的小时要说出来：同一小时里可能一半时间在 WPS（有适配器）、
    // 一半在终端（没有）。不标的话，它看起来和全覆盖一样完整。
    let note: string | undefined;
    if (precise && p) {
      if (!p.hasChar && p.keyInput > 0) {
        note = "这一小时没有精确数据";
      } else if (p.hasChar && p.charKeyInput < p.keyInput && p.keyInput > 0) {
        note = `该小时仅 ${Math.round((p.charKeyInput / p.keyInput) * 100)}% 的按键有精确字数`;
      }
    }

    return { label: `${c.h} 时`, values: [c.input, c.del], band, note };
  });

  const peak = cells.reduce<(typeof cells)[number] | null>(
    (best, c) => ((c.p?.keyInput ?? 0) > (best?.p?.keyInput ?? 0) ? c : best),
    null,
  );
  const busyHours = cells.filter((c) => (c.p?.keyInput ?? 0) > 0).length;
  const gapHours = precise ? cells.filter((c) => c.p && !c.p.hasChar && c.p.keyInput > 0).length : 0;
  const coverage = precise ? coverageNote(
    hours.reduce((s, h) => s + h.charKeyInput, 0),
    hours.reduce((s, h) => s + h.keyInput, 0),
  ) : null;
  const totalInput = cells.reduce((s, c) => s + (c.input ?? 0), 0);
  const charHours = cells.filter((c) => c.p?.hasChar && c.p.charInput > 0).length;

  const inputName = precise ? "输入字数" : "输入按键";
  const delName = precise ? "删除字数" : "删除按键";

  return (
    <section className="page">
      <p className="eyebrow">时段 · {longDate(day)}</p>
      <h2 className="sec">每小时的输入量</h2>
      <p className="sub">
        {busyHours === 0
          ? "这天没有记录到输入"
          : `这天你只在这 ${busyHours} 个钟头里动过键盘`}
        {/*
          字数量不到的那些钟头，图上只有一个孤零零的点（曲线要两个点才画得出来）。
          这句话得放在图**前面**——不然读者先看到的是一大片空白，再往下读到解释，
          中间那一下会以为图坏了。
        */}
        {precise && charHours < busyHours && `，其中只有 ${charHours} 个拿得到精确字数`}
        {" · "}
        {precise ? "精确字数口径" : "按键口径"}
      </p>

      {fellBack && (
        <p className="note">
          今天还没有任何<b>精确字数</b>数据，这里显示的是<b>按键数</b>。
        </p>
      )}

      <LinePlot
        points={points}
        band={precise}
        unit={` ${unit}`}
        ariaLabel={`${longDate(day)}每小时的输入与删除`}
        emptyText="这天没有记录到输入"
        axisX={
          <>
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h}>{axisTick(h, 24) ? h : ""}</span>
            ))}
          </>
        }
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
              那一小时有精确字数
            </span>
            <span>
              <i className="kl kl-hatch" />
              只有按键数，字数量不到
            </span>
          </>
        )}
      </div>

      <p className="caption">
        {precise ? (
          <>
            <b>线断开的地方不是「没打字」，是「画不出来」</b>——
            {gapHours > 0 && <>今天有 {gapHours} 个钟头是这样，</>}
            那些小时里你在敲键盘，只是没人告诉我们敲了几个字。
            基线下面那条细带标的就是这件事：实心是有精确字数，斜纹是只有按键数，
            空白是真的没打字。切到「按键」口径能看到完整的一条线。
          </>
        ) : (
          <>
            按键口径下每一格都是全的，所以没有「量不到」这回事——
            这正是它比字数口径可靠的地方，代价是它只知道你按了几下，
            不知道输入法最后出了几个字（打「你好」要按六下）。
          </>
        )}
      </p>

      <div className="ledger">
        <div>
          <div className="k">有输入的时段</div>
          <div className="v">
            {busyHours}
            <small> 个</small>
          </div>
          <div className="n">0–23 时里敲过键的钟头数</div>
        </div>
        <div>
          <div className="k">最忙的一小时</div>
          <div className="v">
            {peak && (peak.p?.keyInput ?? 0) > 0 ? peak.h : "—"}
            <small> 时</small>
          </div>
          <div className="n">按按键数排，不跟口径走</div>
        </div>
        <div>
          <div className="k">那一小时</div>
          <div className="v">
            {num(peak?.p?.keyInput ?? 0)}
            <small> 次按键</small>
          </div>
          <div className="n">按键是唯一在两种口径下都量得到的量</div>
        </div>
        <div>
          <div className="k">这一天合计</div>
          <div className="v">
            {num(totalInput)}
            <small> {unit}</small>
          </div>
          <div className="n">{coverage ?? "覆盖全部应用"}</div>
        </div>
      </div>

      <h2 className="sec" style={{ marginTop: 52 }}>
        逐时段
      </h2>
      <p className="sub">图上只有「在打字的钟头」，这里把 0–23 时每一格都写出来</p>

      {cells.map((c) => {
        const v = c.input;
        const hasData = (c.p?.keyInput ?? 0) > 0;
        return (
          <div className="kv" key={c.h}>
            <span>
              {c.h} 时
              {c.p?.hasChar && !precise && (
                <span className="badge badge-precise">有精确字数</span>
              )}
            </span>
            <b className={hasData ? undefined : "muted"}>
              {v === null ? "量不到" : `${num(v)} ${unit}`}
            </b>
          </div>
        );
      })}

      <p className="caption">
        「量不到」和「0」是两件事，所以这张表里它们长得不一样：
        <b>0 {unit}是那一小时真的没打字，「量不到」是那一小时在打字但字数无从得知</b>。
        两者混起来，这张表就没法拿来核对了。
      </p>
    </section>
  );
}
