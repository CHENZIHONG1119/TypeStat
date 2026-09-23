import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { longDate } from "../lib/dates";
import {
  coverageNote,
  formatMinutes,
  minuteLabel,
  num,
  pct,
  pickMetrics,
  resolveMode,
  speedText,
  speedUnit,
  typingSpeed,
  type MetricMode,
} from "../lib/metrics";

/** 和 `db::SESSION_GAP_MINUTES` 保持一致。界面上要写明这个阈值，否则时长无从解释。 */
const SESSION_GAP_MINUTES = 5;

/**
 * 今天。
 *
 * 整页只回答一个问题：**今天你坐下来写了多久**。所以那个数字是页面上唯一大字号的东西，
 * 其余全部降到注释的位置——没有哪个人会想知道自己「今天按了 4,838 次键」，
 * 但会想知道自己坐下来写了两个小时。
 */
export function Today({
  day,
  revision,
  metric,
}: {
  day: string;
  revision: number;
  metric: MetricMode;
}) {
  const [summary, setSummary] = useState<api.TodaySummary | null>(null);

  useEffect(() => {
    api.todaySummary(day).then(setSummary).catch(console.error);
  }, [day, revision]);

  if (!summary) return <div className="empty">正在加载…</div>;

  // 选了字数但今天一个适配器都没上报过 → 退回按键口径（否则整页空白）。
  const mode = resolveMode(metric, summary.hasCharData);
  const precise = mode === "char";
  const fellBack = !precise && metric === "char";

  const m = pickMetrics(summary, mode);
  const net = m.input - m.del;
  const rate = m.input > 0 ? m.del / m.input : 0;
  const coverage = precise ? coverageNote(summary.preciseKeyInput, summary.keyInput) : null;
  const missing = summary.uncoveredApps;
  const speed = typingSpeed(mode, summary);
  const from = minuteLabel(summary.firstMinute);
  const to = minuteLabel(summary.lastMinute);

  const sit = summary.sessionMinutes;
  const active = summary.activeMinutes;
  const idle = Math.max(0, sit - active);
  const hours = Math.floor(sit / 60);
  const mins = sit % 60;

  /**
   * 字数比按键还多的自检。
   *
   * 每个字符至少要有一次按键才产生得出来，所以「字数 > 按键数」在物理上不可能
   * （除非有粘贴）。真出现了，说明适配器的量法有问题——必须当场说出来。
   * **这不是防呆，是防把坏数字当战绩**：库里今天就有这么一行，
   * 而它看起来和正常数据一模一样。
   */
  const bogus = precise && summary.keyInput > 0 && m.input > summary.keyInput;

  return (
    <section className="page">
      <p className="eyebrow">今天</p>
      <div className="dateline">{longDate(day)}</div>

      {fellBack && (
        <p className="note">
          今天还没有任何<b>精确字数</b>数据（没装适配器，或装了还没敲过字），
          所以下面显示的是<b>按键数</b>。装好适配器后这一天会自动有字数。
        </p>
      )}

      <p className="claim">今天，你坐下来写了</p>
      <h1 className="hero">
        {hours > 0 && (
          <>
            <em>{num(hours)}</em>
            <span className="u">小时</span>
          </>
        )}
        {(mins > 0 || hours === 0) && (
          <>
            <em>{num(mins)}</em>
            <span className="u">分</span>
          </>
        )}
      </h1>

      <p className="lede">
        其中 <b>{num(active)} 分钟</b>真的在敲，剩下 <b>{num(idle)} 分钟</b>在想。
        {summary.longestMinutes > 0 && (
          <>
            {" "}
            最长一口气写了 <b>{formatMinutes(summary.longestMinutes)}</b>，
          </>
        )}{" "}
        手速 <b>{speed === null ? "—" : `${speedText(speed)} ${speedUnit(mode)}`}</b>。
      </p>

      {from && to && (
        <p className="lede">
          从 <b>{from}</b> 开始，到 <b>{to}</b> 停下。
        </p>
      )}

      <p className="lede">
        另有 <b>{num(summary.keyOther)}</b> 次方向键、快捷键之类的按键——它们产生不了字符，
        所以永远只按「次」算，不跟着口径开关走。
      </p>

      <div className="ledger">
        <div>
          <div className="k">{precise ? "敲入字数" : "敲入按键"}</div>
          <div className="v">{num(m.input)}</div>
          <div className="n">{precise ? "适配器上报的字符增量" : "每一次物理按下，含退格"}</div>
        </div>
        <div>
          <div className="k">{precise ? "删掉字数" : "删掉按键"}</div>
          <div className="v">{num(m.del)}</div>
          <div className="n">{precise ? "退格删掉的字符数" : "退格键按下的次数"}</div>
        </div>
        <div>
          <div className="k">删除率</div>
          <div className="v">{pct(rate)}</div>
          <div className="n">
            {precise ? "删掉的字 ÷ 敲入的字" : "删掉的键 ÷ 敲入的键"}
          </div>
        </div>
        <div>
          <div className="k">{precise ? "净字数" : "净按键"}</div>
          <div className="v">{num(net)}</div>
          <div className="n">
            {precise
              ? (coverage ?? "字数口径下没有可统计的按键")
              : "覆盖所有应用，但没有「字」这个概念"}
          </div>
        </div>
      </div>

      {bogus && (
        <p className="note" style={{ marginTop: 26 }}>
          ⚠ <b>今天记录的字数（{num(m.input)}）比总按键数（{num(summary.keyInput)}）还多。</b>
          每敲一个字至少要按一次键，所以这不可能——多半是某个适配器的量法不对
          （旧版 WPS 适配器取的是<code>Range.Text.length</code>，那是覆盖区域的长度，不是增量）。
          这个数先别信。
        </p>
      )}

      <p className="caption">
        这一页只回答一句话：<b>今天你写了多久</b>。
        时长不分口径——切顶栏的开关它也不动：<b>「坐下来写」跟「敲了几个字」是两件事</b>，
        后者不该改变前者。上面那句「其中 N 分钟真的在敲」用的是有按键的分钟数，
        两段之间间隔不超过 {SESSION_GAP_MINUTES} 分钟就算同一段，段里的空隙（想的时间）也计入坐下的时长。
      </p>

      {precise && (
        <p className="caption">
          <b>「{num(m.input)} 字」不是今天的总字数。</b>
          {coverage}——精确字数只覆盖装了适配器的应用
          {missing.length > 0 && <>（今天没覆盖到：{missing.join("、")}）</>}，
          其余应用在字数口径下是隐形的，切到「按键」才看得见。
        </p>
      )}
    </section>
  );
}
