import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { dayWord, longDate, shortDate } from "../lib/dates";
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
 * 这一天的详情。
 *
 * 整页只回答一个问题：**这一天你坐下来写了多久**。所以那个数字是页面上唯一大字号的东西，
 * 其余全部降到注释的位置——没有哪个人会想知道自己「今天按了 4,838 次键」，
 * 但会想知道自己坐下来写了两个小时。
 *
 * `day` 可以是过去的日子（日期导航翻过来的），所以**这一页里不能出现写死的「今天」**：
 * 每个句子用的都是 `when` / `thatDay` 这两个词。看 9 月 23 号还说「今天」，
 * 那就是这一页在骗人。
 */
export function Today({
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
  const [summary, setSummary] = useState<api.TodaySummary | null>(null);

  // 看的是今天就写「今天」，看的是别的日子就写「9/23 周三」/「9/23 那天」。
  const isToday = day === today;
  const when = dayWord(day, today);
  const thatDay = isToday ? "今天" : `${shortDate(day)} 那天`;

  useEffect(() => {
    // `alive` 那道闸门见 `Keys.tsx`：`day` 现在会在运行时变（跨过午夜），
    // 而请求是并发的——迟到的那次会把「今天」整页换回昨天。
    let alive = true;
    api
      .todaySummary(day)
      .then((r) => {
        if (alive) setSummary(r);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
  }, [day, revision]);

  if (!summary) return <div className="empty">正在加载…</div>;

  // 选了字数但这一天一个适配器都没上报过 → 退回按键口径（否则整页空白）。
  const mode = resolveMode(metric, summary.hasCharData);
  const precise = mode === "char";
  const fellBack = !precise && metric === "char";

  const m = pickMetrics(summary, mode);
  const net = m.input - m.del;
  /**
   * 删除率。分母是 0 时给 `null`，**不给 0**——这一天压根没敲过字，
   * 印成「删除率 0.0%」看着像量过了、发现你没删东西。量不到和 0 要分开，
   * 这条规矩在这一页同样成立，不能只在图表上守。
   */
  const rate = m.input > 0 ? m.del / m.input : null;
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
   * **这不是防呆，是防把坏数字当战绩**：库里就有这么一行，
   * 而它看起来和正常数据一模一样。
   */
  const bogus = precise && summary.keyInput > 0 && m.input > summary.keyInput;

  /**
   * 这一天**一点记录都没有**。
   *
   * 原来这里会照常渲染出「你坐下来写了 0分／其中 0 分钟真的在敲」——那是一句
   * 关于行为的结论，而真相是这一天什么都没记到。日期导航能翻到任意一个空日子
   * （从前只能看今天，这种日子几乎撞不上），「0 和量不到是两件事」这条规矩
   * 在这一页也必须成立。
   */
  const noRecords =
    summary.keyInput === 0 && summary.keyDelete === 0 && summary.keyOther === 0;

  /**
   * 下面那张账里的数字，这一天该不该印出来。
   *
   * 空日子印 `0` 和印 `—` 是两句不同的话：`0` 是「记了，你一次都没敲」，
   * `—` 是「什么都没记到」。翻回去的空日子属于后者——**它和 hero 那句话
   * 必须是一个说法**，否则标题上写着「分不出没打字和没开机」，
   * 紧下面四格却把其中一个可能印成了结论。删除率那格早就这么处理了
   * （`rate === null` 给「—」），这里只是把同一条规矩补齐。
   *
   * 今天不在此列：今天还在跑，没有记录就是「还没开始敲」，那是真的 0。
   */
  const unknown = noRecords && !isToday;

  return (
    <section className="page">
      <p className="eyebrow">{isToday ? "今天" : "这一天"}</p>
      <div className="dateline">{longDate(day)}</div>

      {/* 一点记录都没有的日子不弹这条：那时「所以下面显示的是按键数」指向的
          是一张全空的账，说出来只是噪音。 */}
      {fellBack && !noRecords && (
        <p className="note">
          {when}还没有任何<b>精确字数</b>数据（没装适配器，或装了还没敲过字），
          所以下面显示的是<b>按键数</b>。装好适配器后这一天会自动有字数。
        </p>
      )}

      {noRecords ? (
        <>
          <p className="claim">{thatDay}没有记录</p>
          <p className="lede" style={{ marginTop: 14 }}>
            没有敲入，没有删除，也没有按过方向键之类的其他键。
          </p>
          {/*
            今天和过去的日子**不是同一件事**：今天正在跑，没有记录就是「还没开始敲」；
            翻回去的那些日子，库里分不出「没打字」和「没开机」——两种情况留下的都是空。
            把后面那句放到今天头上会是错的。
          */}
          {!isToday && (
            <p className="lede">
              <b>库里分不出「那天没打字」和「那天没开机」</b>——两种情况留下的都是空。
              所以这里只说「没有记录」，不说「你只坐了 0 分钟」。
            </p>
          )}
        </>
      ) : (
        <>
          <p className="claim">{thatDay}，你坐下来写了</p>
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
        </>
      )}

      <div className="ledger">
        <div>
          <div className="k">{precise ? "敲入字数" : "敲入按键"}</div>
          <div className="v">{unknown ? "—" : num(m.input)}</div>
          <div className="n">{precise ? "适配器上报的字符增量" : "每一次物理按下，含退格"}</div>
        </div>
        <div>
          <div className="k">{precise ? "删掉字数" : "删掉按键"}</div>
          <div className="v">{unknown ? "—" : num(m.del)}</div>
          <div className="n">{precise ? "退格删掉的字符数" : "退格键按下的次数"}</div>
        </div>
        <div>
          <div className="k">删除率</div>
          <div className="v">{rate === null ? "—" : pct(rate)}</div>
          <div className="n">
            {rate === null
              ? unknown
                ? `${when}没有记录`
                : `${when}还没有输入，算不出比例`
              : precise
                ? "删掉的字 ÷ 敲入的字"
                : "删掉的键 ÷ 敲入的键"}
          </div>
        </div>
        <div>
          <div className="k">{precise ? "净字数" : "净按键"}</div>
          <div className="v">{unknown ? "—" : num(net)}</div>
          <div className="n">
            {precise
              ? (coverage ?? "字数口径下没有可统计的按键")
              : "覆盖所有应用，但没有「字」这个概念"}
          </div>
        </div>
      </div>

      {bogus && (
        <p className="note" style={{ marginTop: 26 }}>
          ⚠ <b>{when}记录的字数（{num(m.input)}）比总按键数（{num(summary.keyInput)}）还多。</b>
          每敲一个字至少要按一次键，所以这不可能——多半是某个适配器的量法不对
          （旧版 WPS 适配器取的是<code>Range.Text.length</code>，那是覆盖区域的长度，不是增量）。
          这个数先别信。
        </p>
      )}

      <p className="caption">
        这一页只回答一句话：<b>{thatDay}你写了多久</b>。
        时长不分口径——切顶栏的开关它也不动：<b>「坐下来写」跟「敲了几个字」是两件事</b>，
        后者不该改变前者。
        {!noRecords && (
          <>
            上面那句「其中 N 分钟真的在敲」用的是有按键的分钟数，
            两段之间间隔不超过 {SESSION_GAP_MINUTES} 分钟就算同一段，段里的空隙（想的时间）也计入坐下的时长。
          </>
        )}
      </p>

      {precise && (
        <p className="caption">
          <b>「{num(m.input)} 字」不是{when}的总字数。</b>
          {coverage}——精确字数只覆盖装了适配器的应用
          {missing.length > 0 && <>（{when}没覆盖到：{missing.join("、")}）</>}，
          其余应用在字数口径下是隐形的，切到「按键」才看得见。
        </p>
      )}
    </section>
  );
}
