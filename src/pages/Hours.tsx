import { useEffect, useMemo, useState } from "react";
import { LinePlot, axisTick, type BandState, type PlotPoint } from "../components/LinePlot";
import * as api from "../lib/api";
import { dayWord, longDate } from "../lib/dates";
import {
  coverageNote,
  isBlankCell,
  num,
  preciseValue,
  resolveMode,
  unitOf,
  type MetricMode,
} from "../lib/metrics";

/**
 * 后端 `hour_profile` 恒定返回 24 行，所以 `find` 不到只可能是数据还没到。
 * 这时按「这一格没打字」算，而不是让它变成 `undefined` 往下传。
 */
const EMPTY_HOUR: api.HourPoint = {
  hour: 0,
  keyInput: 0,
  keyDelete: 0,
  charInput: 0,
  charDelete: 0,
  hasChar: false,
  charKeyInput: 0,
};

/**
 * 这一天的小时曲线。一个页面就这一张图。
 *
 * 这张图最容易出的错，是把「量不到」画成 0：在字数口径下，没有精确数据的那一小时
 * 如果画成 0，线上会出现一个谷底，看着像「那一小时没打字」——而事实是那时段在打字，
 * 只是没人告诉我们打了几个字。所以那些点一律给 `null`（线在那里断开），
 * 并在基线下面用一条细带标出「这个数是从哪儿来的」。
 *
 * `day` 可以是过去的日子，所以页面上不能出现写死的「今天」——用 `when`。
 */
export function Hours({
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
  const [hours, setHours] = useState<api.HourPoint[] | null>(null);

  const when = dayWord(day, today);

  useEffect(() => {
    // `alive` 那道闸门见 `Keys.tsx`：`day` 现在会在运行时变（跨过午夜或翻日期），
    // 而请求是并发的，先发的可能后回来，把这一天的小时曲线画成另一天的。
    let alive = true;
    api
      .hourly(day)
      .then((r) => {
        if (alive) setHours(r);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
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
        const p = (hours ?? []).find((x) => x.hour === h) ?? EMPTY_HOUR;
        return {
          h,
          p,
          // 取值走 `preciseValue`，**不能直接看 `hasChar`**：补齐的空格子
          // （`hasChar: false`）是确定的 0，不是「量不到」。这个区分写在
          // `metrics.ts` 那一个地方，这里和其它页共用同一份判据。
          input: precise ? preciseValue(p, "charInput") : p.keyInput,
          del: precise ? preciseValue(p, "charDelete") : p.keyDelete,
        };
      }),
    [hours, precise],
  );

  /** 有输入的钟头数。**放在这里**是因为下面那个「这天没有记录到输入」的早退要用它——
   *  原来它定义在 `points` 之后，位置不对。 */
  const busyHours = cells.filter((c) => c.p.keyInput > 0).length;

  if (!hours) return <div className="empty">正在加载…</div>;

  /**
   * 这一天一个小时都没动过。
   *
   * 判据和下面 `<p className="sub">` 里那句「这天没有记录到输入」**是同一个**
   * （都是 `busyHours === 0`），这一点是要紧的：分开写两遍，就会出现
   * 「标题说没有记录、底下却列着 24 行 0」这种自己打自己的局面。
   *
   * 整页收成一句话，跟着 应用 / 明细 那两页的做法。为什么不照常画出那张空图和
   * 那 24 行「0 次」：那些 0 不是量出来的，是**没有行**求和得到的结果，
   * 它和「那天没开机」长得一模一样，而这一页没有任何办法把两者分开
   * （`HourPoint` 里没有 `keyOther`，所以这一天只按过方向键时这里同样是 0——
   * 那也一样是「没有记录到输入」，上面那句本来就是这么写的）。
   */
  if (busyHours === 0) {
    return (
      <section className="page">
        <p className="eyebrow">时段 · {longDate(day)}</p>
        <h2 className="sec">每小时的输入量</h2>
        <div className="empty">{when}还没有记录到输入</div>
      </section>
    );
  }

  const points: PlotPoint[] = cells.map((c) => {
    const p = c.p;
    // 质量带：实心 = 这一小时有精确字数，斜纹 = 只有按键数，不画 = 真的没打字。
    // **只在字数口径下才有意义**——按键口径下每一格都是全的，打斜纹等于谎报缺失。
    //
    // 判据只能是 `hasChar`（**有没有适配器报过数**），不能加 `charInput > 0`：
    // 只删不增的一小时净字数是 0，加了那个条件就会把它画成斜纹＝「量不到」，
    // 而下面那张表里同一格写着「0 字」——同一页自己打自己。
    const band: BandState = isBlankCell(p) ? "none" : p.hasChar ? "exact" : "keys";

    // 半覆盖的小时要说出来：同一小时里可能一半时间在 WPS（有适配器）、
    // 一半在终端（没有）。不标的话，它看起来和全覆盖一样完整。
    let note: string | undefined;
    if (precise) {
      if (!p.hasChar && p.keyInput > 0) {
        note = "这一小时没有精确数据";
      } else if (p.hasChar && p.charKeyInput < p.keyInput && p.keyInput > 0) {
        note = `该小时仅 ${Math.round((p.charKeyInput / p.keyInput) * 100)}% 的按键有精确字数`;
      }
    }

    return { label: `${c.h} 时`, values: [c.input, c.del], band, note };
  });

  const peak = cells.reduce<(typeof cells)[number] | null>(
    (best, c) => (c.p.keyInput > (best?.p.keyInput ?? 0) ? c : best),
    null,
  );
  // 和上面 `band` 用的是同一个判据，所以这句「有 N 个钟头是这样」和图上的斜纹
  // 数量一定对得上。分开写两遍迟早会分叉，而分叉的表现是「说法和图形对不上」。
  const gapHours = precise ? cells.filter((c) => !isBlankCell(c.p) && !c.p.hasChar).length : 0;
  const coverage = precise ? coverageNote(
    hours.reduce((s, h) => s + h.charKeyInput, 0),
    hours.reduce((s, h) => s + h.keyInput, 0),
  ) : null;
  const totalInput = cells.reduce((s, c) => s + (c.input ?? 0), 0);
  // 只数 `hasChar`，**不加 `charInput > 0`**：只删不增的一小时也有精确数据，
  // 它该算进「拿得到精确字数」里，只是那个数字恰好是 0。
  const charHours = cells.filter((c) => c.p.hasChar).length;

  const inputName = precise ? "输入字数" : "输入按键";
  const delName = precise ? "删除字数" : "删除按键";

  return (
    <section className="page">
      <p className="eyebrow">时段 · {longDate(day)}</p>
      <h2 className="sec">每小时的输入量</h2>
      <p className="sub">
        {/* 空日子在上面就早退了，所以这里 `busyHours` 一定大于 0——原来那个
            「这天没有记录到输入」的分支已经走不到，不能再留在这看着像还在用。 */}
        {`这天你只在这 ${busyHours} 个钟头里动过键盘`}
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
          {when}还没有任何<b>精确字数</b>数据，这里显示的是<b>按键数</b>。
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
            {gapHours > 0 && <>{when}有 {gapHours} 个钟头是这样，</>}
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
            {peak && peak.p.keyInput > 0 ? peak.h : "—"}
            <small> 时</small>
          </div>
          <div className="n">按按键数排，不跟口径走</div>
        </div>
        <div>
          <div className="k">那一小时</div>
          <div className="v">
            {num(peak?.p.keyInput ?? 0)}
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
        // 「这一格有没有动过」——按键和退格都算。只按了退格的一小时不该被标灰。
        const hasData = !isBlankCell(c.p);
        return (
          <div className="kv" key={c.h}>
            <span>
              {c.h} 时
              {c.p.hasChar && !precise && (
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
