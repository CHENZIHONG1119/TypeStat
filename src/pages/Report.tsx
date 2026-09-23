import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LinePlot, axisTick, type PlotPoint } from "../components/LinePlot";
import * as api from "../lib/api";
import { longDate, shortDate } from "../lib/dates";
import { formatMinutes, num, pct, shortName, speedText } from "../lib/metrics";

/**
 * 总结：把一期的数据读成一段话。
 *
 * **这一页不跟顶栏的口径开关走。** 正文是存档的，开关是活的——跟着开关走的话，
 * 一次切换就会在为另一种口径写的正文底下重新标注数字。所以折线只画按键数
 * （唯一覆盖所有应用的口径），字数和覆盖率在账目里单列，各自带单位。
 * 页面上必须把这件事写出来，否则用户会以为界面卡了（同 `Duration`）。
 *
 * 页面的契约是**可对账**：正文是模型写的，数字是算出来的，两者肉眼可分、
 * 而且可以逐句核对。所以
 *   1. 账目由前端从 `facts` 渲染，模型碰不到；
 *   2. 正文旁边挂着「谁写的」和「什么时候写的」；
 *   3. 降级必须连原因一起说出来，不能悄悄发生；
 *   4. 「模型当时看到的那张清单」原样留着，一键展开。
 */

type PeriodKind = "week" | "month";

const KIND_NAME: Record<PeriodKind, string> = { week: "周报", month: "月报" };

/** 表单里的占位符。真值由后端给（`report.base_url` 的兜底），这里只是提示长什么样。 */
const PLACEHOLDER_BASE = "https://api.deepseek.com/v1";
const PLACEHOLDER_MODEL = "deepseek-chat";

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Unix 秒 →「2026-09-24 09:12」。
 *
 * 存档是拿来几个月后翻的，所以给绝对时间，不给「9 天前」——那种说法过一天就变。
 */
function stamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function Report({ day }: { day: string }) {
  const [kind, setKind] = useState<PeriodKind>("week");
  const [slots, setSlots] = useState<api.PeriodSlot[] | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<api.ReportDetail | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSheet, setShowSheet] = useState(false);

  const [settings, setSettings] = useState<api.ReportSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; bad: boolean } | null>(null);
  // null = 还没动过，跟着「配没配好」自动定；非 null = 用户按过那个按钮，听他的。
  const [formTouched, setFormTouched] = useState<boolean | null>(null);

  /** 开程序补写的那一期落库之后，期条要跟着变一次。 */
  const [stripNonce, setStripNonce] = useState(0);

  const keyRef = useRef<string | null>(null);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);

  // 同步的闸门。`busy` 是 state，React 的更新是异步的，双击能在按钮置灰生效
  // **之前**挤进第二次调用。后端 `InFlight` 也会挡（那才是真正的防线），
  // 但那时候用户看到一句刺眼的错误——这里是第一道。
  const gate = useRef(false);

  // 期条。**不跟 revision 走**：revision 每落一次库就 +1，那样每隔几秒重拉一次，
  // 而重拉会把用户正在读的那一期换掉。
  useEffect(() => {
    let alive = true;
    api
      .reportPeriods(kind)
      .then((list) => {
        if (!alive) return;
        setSlots(list);
        // 没选过才给默认值：最近一个**已结束**的期。当前期还在往库里写，
        // 今天生成出来的话明天就对不上了，所以它不可点，这里也不会选中它。
        setKey((cur) => cur ?? [...list].reverse().find((s) => s.closed)?.periodKey ?? null);
      })
      .catch((e) => {
        if (alive) setFail(String(e));
      });
    return () => {
      alive = false;
    };
  }, [kind, stripNonce]);

  // 一期的全文。**不跟 revision 走**：已结束的期是冻结的——存档里的账目
  // 是从 `facts_json` 解出来的，现算的那份也只会给出同样的数。重新生成
  // 只在用户点按钮的时候发生。
  useEffect(() => {
    if (!key) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetail(null);
    setFail(null);
    api
      .reportGet(kind, key)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((e) => {
        if (alive) setFail(String(e));
      });
    return () => {
      alive = false;
    };
  }, [kind, key]);

  useEffect(() => {
    let alive = true;
    api
      .reportSettings()
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
      })
      .catch((e) => {
        if (alive) setFail(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  /*
   * 开程序补一期。**fire-and-forget**：用户没要求过这件事，所以它的失败
   * 一个字的提示都不给（后端那边也只往 stderr 写一行）。
   *
   * 补到了才重拉期条——那一刻期条上会多出一格「已有报告」。正看着的
   * 恰好就是补的这一期时，正文直接放上去，不再查一次。
   */
  useEffect(() => {
    let alive = true;
    api
      .reportCatchup()
      .then((d) => {
        if (!alive || !d) return;
        setStripNonce((n) => n + 1);
        if (keyRef.current === d.periodKey) setDetail(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const generate = useCallback(async () => {
    if (!key || gate.current) return;
    gate.current = true;
    setBusy(true);
    setFail(null);
    try {
      const d = await api.reportGenerate(kind, key);
      setDetail(d);
      // 期条上那一格从此有了生成时间。只改这一格，不重拉整个期条——
      // 重拉会把「没选过才给默认值」那条规则踩到，把别的期顶上来。
      setSlots(
        (list) =>
          list?.map((s) =>
            s.periodKey === d.periodKey
              ? { ...s, generatedAt: d.generatedAt, source: d.source, model: d.model }
              : s,
          ) ?? null,
      );
    } catch (e) {
      setFail(String(e));
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }, [kind, key]);

  const save = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setSaveMsg(null);
      try {
        await api.reportSaveSettings(
          baseUrl.trim(),
          model.trim(),
          apiKey.trim() === "" ? null : apiKey,
        );
        const s = await api.reportSettings();
        setSettings(s);
        setBaseUrl(s.baseUrl);
        setModel(s.model);
        setApiKey("");
        // 配好了就收起来，没配好就摊着——那正是用户要改的东西。
        setFormTouched(!s.hasKey);
        setSaveMsg({ text: "已保存", bad: false });
      } catch (err) {
        setSaveMsg({ text: String(err), bad: true });
      } finally {
        setSaving(false);
      }
    },
    [baseUrl, model, apiKey],
  );

  const f = detail?.facts ?? null;

  /*
   * 按天的那条线。
   *
   * `facts.days` 只列**有记录的天**，直接画会让 9/21 和 9/27 两个点挨在一起，
   * 看着像连着两天——而中间那几天其实是空的。所以从期首走到期末，
   * 中间补 0：那一天真的没敲，是 0 不是「量不到」。
   *
   * 循环带一个上限：`startsOn`/`endsOn` 一旦不是合法日期，`shiftDay` 会返回
   * NaN，而 `"NaN-NaN-NaN" <= endsOn` 是 false——这里本来就会停。加这个 40
   * 是防着以后有人改坏 `shiftDay`：一个在渲染里转不停的循环会把整个界面冻住。
   */
  const dayPoints = useMemo<PlotPoint[]>(() => {
    if (!f) return [];
    const byDay = new Map(f.days.map((d) => [d.day, d.keyInput]));
    const out: PlotPoint[] = [];
    for (let d = f.startsOn, i = 0; d <= f.endsOn && i < 40; d = api.shiftDay(d, 1), i++) {
      out.push({
        label: shortDate(d),
        values: [byDay.get(d) ?? 0],
        note: byDay.has(d) ? undefined : "这一天没有记录",
      });
    }
    return out;
  }, [f]);

  const hourPoints = useMemo<PlotPoint[]>(
    () => (f ? f.hours.map((h) => ({ label: `${h.hour} 时`, values: [h.keyInput] })) : []),
    [f],
  );

  const selected = slots?.find((s) => s.periodKey === key) ?? null;
  const made = slots?.filter((s) => s.generatedAt !== null).length ?? 0;
  const formOpen = formTouched ?? (settings ? !settings.hasKey || settings.keyBroken : false);

  return (
    <section className="page">
      <p className="eyebrow">总结 · {longDate(day)}</p>
      <h2 className="sec">这一期</h2>
      <p className="sub">
        数字全部来自本地记录 · 正文由模型写，数字由这里算 · <b>这一页不跟顶栏的口径开关走</b>
      </p>

      <div className="seg" role="group" aria-label="期次类型">
        {(["week", "month"] as const).map((k) => (
          <button
            key={k}
            className="seg-btn"
            aria-pressed={kind === k}
            onClick={() => {
              if (k === kind) return;
              // 换了类型旧的期次键就没意义了，先清掉——否则会拿「周」的键
              // 去查「月」，后端解不开，页面白闪一个错。
              setKey(null);
              setDetail(null);
              setShowSheet(false);
              setKind(k);
            }}
          >
            {KIND_NAME[k]}
          </button>
        ))}
      </div>

      {slots && (
        <>
          <div
            className="seg"
            role="group"
            aria-label="选择期次"
            style={{ display: "flex", flexWrap: "wrap", gap: 2, marginTop: 14 }}
          >
            {slots.map((s) => (
              <button
                key={s.periodKey}
                className="seg-btn"
                aria-pressed={s.periodKey === key}
                disabled={!s.closed}
                title={
                  s.closed
                    ? `${s.rangeText}${s.generatedAt ? ` · 已在 ${stamp(s.generatedAt)} 生成` : " · 还没生成"}`
                    : "本期还没结束"
                }
                onClick={() => setKey(s.periodKey)}
              >
                {s.label}
              </button>
            ))}
          </div>

          <p className="caption">
            {selected ? `${selected.rangeText} · ` : ""}
            这 {slots.length} 期里有 {made} 期已经生成过。
            今天所在的那一期灰着不能点——它还在往库里写，今天生成出来的话明天就对不上了。
          </p>
        </>
      )}

      {fail && <p className="note">{fail}</p>}

      {!slots ? (
        <div className="empty">正在加载…</div>
      ) : !key ? (
        <div className="empty">还没有已结束的期次</div>
      ) : !detail ? (
        fail ? null : (
          <div className="empty">正在加载…</div>
        )
      ) : detail.generatedAt === null ? (
        <>
          <p className="note" style={{ marginTop: 26 }}>
            {detail.hasData ? (
              <>
                这一期还没生成。生成一次要几秒到半分钟：把这期的数字交给模型写成一段话，
                然后连同数字一起存档。<b>数字不经过模型</b>，它只是照着清单组织语言。
              </>
            ) : (
              <>
                这一期<b>没有任何打字记录</b>——没有敲入或删除过字符。生成出来只会是一句话，
                存档里多一行，没什么可读的。
              </>
            )}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={generate} disabled={busy}>
              {busy ? "正在生成…" : detail.hasData ? "生成报告" : "仍然生成"}
            </button>
            {busy && (
              <span className="caption" style={{ margin: 0 }}>
                最多 30 秒；生成期间别的页面照常能用。
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span
              className="pill"
              title={
                detail.source === "llm"
                  ? `正文由 ${detail.model ?? "模型"} 写`
                  : "没走模型，本地按同一批数字拼的"
              }
            >
              {detail.source === "llm" ? `${detail.model ?? "模型"} 生成` : "本地模板"}
            </span>
            {detail.generatedAt !== null && (
              <span className="caption" style={{ margin: 0 }}>
                {stamp(detail.generatedAt)} 生成
              </span>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn btn-sm" onClick={generate} disabled={busy}>
              {busy ? "正在生成…" : "重新生成"}
            </button>
          </div>

          <p className="note" style={{ marginTop: 22 }}>
            {detail.source === "llm" ? (
              <>
                <b>正文是模型写的，下面每一个数字是这里算的。</b>
                模型看到的是「模型看到的事实」里那张清单，它被要求不做任何加减乘除；
                正文里哪个数字对不上账目，以账目为准。
              </>
            ) : (
              <>
                <b>这一期没走模型：{detail.note ?? "原因未知"}。</b>
                下面这段是本地按同一批数字拼出来的，所以它一定和账目对得上——
                代价是读起来像对账单。接口配好之后点「重新生成」就会换成模型写的。
              </>
            )}
          </p>

          {/*
            正文按空行切段，**纯文本渲染**：不解析 markdown，也不用
            dangerouslySetInnerHTML。模型返回的东西一律当字符串看。
          */}
          {(detail.body ?? "")
            .split(/\n{2,}/)
            .filter((p) => p.trim() !== "")
            .map((para, i) => (
              <p className="lede" key={i} style={{ marginTop: i === 0 ? 20 : 18 }}>
                {para}
              </p>
            ))}

          {f && (
            <>
              <h2 className="sec" style={{ marginTop: 52 }}>
                账目
              </h2>
              <p className="sub">
                这一期 {f.periodDays} 天，其中有记录的 {f.activeDays} 天 ·
                每个数字都能和正文逐句对上，对不上的以这里为准 ·
                时长按「相邻两次输入间隔不超过 5 分钟算同一段」算
              </p>

              <div className="ledger" style={{ marginTop: 0 }}>
                <div>
                  <div className="k">敲入按键</div>
                  <div className="v">
                    {num(f.keyInput)}
                    <small> 次</small>
                  </div>
                  <div className="n">
                    另 {num(f.keyOther)} 次其他按键（方向键、快捷键）
                  </div>
                </div>
                <div>
                  <div className="k">退格</div>
                  <div className="v">
                    {num(f.keyDelete)}
                    <small> 次</small>
                  </div>
                  <div className="n">
                    {f.keyDeleteRate === null
                      ? "这一期没敲过键，比例算不出来"
                      : `退格率 ${pct(f.keyDeleteRate)}（退格 ÷ 敲入）`}
                  </div>
                </div>
                <div>
                  <div className="k">敲入字数</div>
                  <div className="v">
                    {f.charInput === null ? (
                      "量不到"
                    ) : (
                      <>
                        {num(f.charInput)}
                        <small> 字</small>
                      </>
                    )}
                  </div>
                  <div className="n">
                    {f.charInput === null
                      ? "这一期没有任何应用上报精确字数"
                      : `删除 ${num(f.charDelete ?? 0)} 字${
                          f.charDeleteRate === null ? "（分母是 0，比例算不出来）" : `（删除率 ${pct(f.charDeleteRate)}）`
                        }`}
                  </div>
                </div>
                <div>
                  <div className="k">净字数</div>
                  <div className="v">
                    {f.netChars === null ? (
                      "量不到"
                    ) : (
                      <>
                        {num(f.netChars)}
                        <small> 字</small>
                      </>
                    )}
                  </div>
                  <div className="n">
                    {f.netChars === null
                      ? "敲入减删除——两头都得先量得到"
                      : "上面两格相减"}
                  </div>
                </div>
                <div>
                  <div className="k">字数覆盖率</div>
                  <div className="v">
                    {f.coverage !== null ? pct(f.coverage) : f.keyInput === 0 ? "—" : "量不到"}
                  </div>
                  <div className="n">
                    {f.coverage !== null
                      ? "有字数的按键 ÷ 全部按键"
                      : f.keyInput === 0
                        ? "这一期没敲过键，算不出来"
                        : "一个适配器都没上报过，覆盖率不成立"}
                  </div>
                </div>
                <div>
                  <div className="k">坐下时长</div>
                  <div className="v">{formatMinutes(f.sessionMinutes)}</div>
                  <div className="n">
                    其中真正在敲 {formatMinutes(f.activeMinutes)}
                  </div>
                </div>
                <div>
                  <div className="k">最长的一段</div>
                  <div className="v">{formatMinutes(f.longestMinutes)}</div>
                  <div className="n">取各天里最长的那段，跨天不累加</div>
                </div>
                <div>
                  <div className="k">按键速度</div>
                  <div className="v">
                    {speedText(f.keysPerMinute)}
                    <small> 键 / 分</small>
                  </div>
                  <div className="n">
                    {f.charsPerMinute === null
                      ? "字数速度量不到（没有精确字数）"
                      : `字数速度 ${speedText(f.charsPerMinute)} 字 / 分`}
                  </div>
                </div>
              </div>

              <h2 className="sec" style={{ marginTop: 52 }}>
                这些天
              </h2>
              <p className="sub">
                每天的敲入按键 · 只画按键数，因为它是唯一覆盖所有应用的口径 ·
                空着的那几天是真的没记录，不是缺数据
              </p>

              <LinePlot
                points={dayPoints}
                unit=" 次"
                ariaLabel={`${detail.heading}每天的敲入按键数`}
                emptyText="这一期没有记录"
                axisX={dayPoints.map((p, i) => (
                  <span key={i}>{axisTick(i, dayPoints.length) ? p.label : ""}</span>
                ))}
                series={[{ name: "敲入按键", color: "var(--series-1)" }]}
              />

              <h2 className="sec" style={{ marginTop: 52 }}>
                什么时候在敲
              </h2>
              <p className="sub">
                0–23 时依次的敲入按键 · 一天里的形状，和这一期有多少天无关 ·
                二十四格一个不少，没打字的小时是 0，不是缺数据
              </p>

              <LinePlot
                points={hourPoints}
                unit=" 次"
                ariaLabel={`${detail.heading}每小时的敲入按键数`}
                emptyText="这一期没有按键记录"
                axisX={hourPoints.map((_, i) => (
                  <span key={i}>{axisTick(i, hourPoints.length) ? i : ""}</span>
                ))}
                series={[{ name: "敲入按键", color: "var(--series-1)" }]}
              />

              <p className="caption">
                {f.busiestHour === null
                  ? "这一期没有敲过键，所以没有「最忙的一小时」。"
                  : `最忙的一小时是 ${f.busiestHour} 时，敲了 ${num(f.busiestHourKeys)} 次。`}
                逐格的数在点上悬停可看；二十四个数原样列在下面的「模型看到的事实」里——
                那正是模型看到的那份，可以拿来核正文。
              </p>

              <h2 className="sec" style={{ marginTop: 52 }}>
                在哪儿敲的
              </h2>
              <p className="sub">
                {`按敲入按键数从多到少，这一期一共 ${f.appsTotal} 个应用`}
                {f.appsOmitted > 0 && ` · 只列前 ${f.apps.length} 个`}
              </p>

              {f.apps.length === 0 ? (
                <div className="empty">这一期没有记录到应用</div>
              ) : (
                <div>
                  {(() => {
                    const max = Math.max(...f.apps.map((a) => a.keyInput), 1);
                    return f.apps.map((a) => (
                      <div className="wa" key={a.app}>
                        <div className="n">{shortName(a.app)}</div>
                        {/* 没有字数的那些用斜纹，和 `Apps.tsx` 同一套记号：
                            这一页老是并排放着「字数」和「按键数」，
                            光靠文字说「量不到」在扫一眼的时候是会漏掉的。 */}
                        <div
                          className={`bar${a.hasChar ? "" : " bar-h"}`}
                          style={{ width: `${(a.keyInput / max) * 100}%` }}
                        />
                        <div className="v">
                          {num(a.keyInput)} 次
                          <em>
                            {" · "}
                            {a.hasChar && a.charInput !== null
                              ? `${num(a.charInput)} 字`
                              : "字数量不到"}
                          </em>
                        </div>
                      </div>
                    ));
                  })()}
                  <p className="caption">
                    {f.appsOmitted > 0 && (
                      <>
                        另有 <b>{f.appsOmitted}</b> 个应用没排上，合计{" "}
                        <b>{num(f.appsOmittedKeys)}</b> 次——不交代的话，上面每一条加起来
                        会比总数少，而页面上没有任何地方解释差在哪。
                      </>
                    )}
                    「字数量不到」不等于 0：那些应用有按键数，只是没装适配器、
                    报不上来精确字数。
                  </p>
                </div>
              )}

              {f.bogusDays > 0 && (
                <p className="note" style={{ marginTop: 26 }}>
                  <b>这一期有 {f.bogusDays} 天字数大于按键数。</b>
                  一个字至少要按一次键，所以这不可能——只会是适配器虚报（已知 WPS 的
                  字数口径偏大）。那几天的数字不可信，正文里如果引用了它们，也是不可信的。
                </p>
              )}

              {detail.sheet && (
                <div style={{ marginTop: 30 }}>
                  <button
                    className="btn btn-sm"
                    onClick={() => setShowSheet((v) => !v)}
                    aria-expanded={showSheet}
                  >
                    {showSheet ? "收起「模型看到的事实」" : "模型看到的事实"}
                  </button>
                  {showSheet && <pre className="sheet">{detail.sheet}</pre>}
                </div>
              )}
            </>
          )}
        </>
      )}

      <h2 className="sec" style={{ marginTop: 52 }}>
        接口
      </h2>
      <p className="sub">
        走 OpenAI 兼容协议，换服务商只改这三栏 · <b>密钥不回传到这个页面</b>，只告诉你有或没有
      </p>

      {!settings ? (
        <div className="empty">正在加载…</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="pill">
              {settings.hasKey ? "已配置" : settings.keyBroken ? "密钥解不开" : "还没配"}
            </span>
            <span className="caption" style={{ margin: 0 }}>
              {settings.model} · {settings.baseUrl}
            </span>
            <button className="btn btn-sm" onClick={() => setFormTouched(!formOpen)}>
              {formOpen ? "收起" : "修改"}
            </button>
          </div>

          {/* 「已保存」得写在表单**外面**：保存成功会把表单收起来，
              写在里面就等于点完保存什么回执都没有——表单消失，
              用户分不清是成了还是塌了。失败的回执留在表单里，因为改的地方在那儿。 */}
          {saveMsg && !saveMsg.bad && (
            <p className="caption" style={{ marginTop: 12 }}>
              {saveMsg.text}
            </p>
          )}

          {settings.keyBroken && !settings.hasKey && (
            <p className="note" style={{ marginTop: 22 }}>
              <b>存的密钥解不开了，请重新填一次。</b>
              密钥是用 Windows 的 DPAPI 加密的，只有当初存它的那个 Windows 账户解得开——
              换了账户登录、或者把数据库文件拷到别的机器，就会变成这样。
              这不是你输错了。
            </p>
          )}

          {!settings.hasKey && !settings.keyBroken && (
            <p className="note" style={{ marginTop: 22 }}>
              还没配接口。不配也能用——生成的时候会走本地模板，
              数字一个不差，只是读起来像对账单。
            </p>
          )}

          {formOpen && (
            <form style={{ maxWidth: 460, marginTop: 26 }} onSubmit={save}>
              <div className="field" style={{ marginTop: 0 }}>
                <label className="field-label" htmlFor="rep-base">
                  接口地址
                </label>
                <input
                  id="rep-base"
                  type="text"
                  value={baseUrl}
                  spellCheck={false}
                  placeholder={PLACEHOLDER_BASE}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <p className="field-hint">
                  结尾的 <code>/v1</code> 要带上——程序会在它后面接{" "}
                  <code>/chat/completions</code>。地址在这里就会验，不会等到生成的时候
                  才告诉你写错了。
                </p>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="rep-model">
                  模型名
                </label>
                <input
                  id="rep-model"
                  type="text"
                  value={model}
                  spellCheck={false}
                  placeholder={PLACEHOLDER_MODEL}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>

              <div className="field">
                <label className="field-label" htmlFor="rep-key">
                  API key
                </label>
                <input
                  id="rep-key"
                  type="password"
                  value={apiKey}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={
                    settings.keyBroken
                      ? "请重新填一次"
                      : settings.hasKey
                        ? "已保存（留空则不修改）"
                        : "粘贴你的 API key"
                  }
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <p className="field-hint">
                  密钥用 Windows 的 DPAPI 加密后存在 <code>{settings.dbPath}</code> 的
                  settings 表里（键名 <code>secret.report_api_key</code>），只有当前账户解得开，
                  不会发给任何第三方。留空 = 不修改。
                </p>
                <p className="field-hint">
                  <b>TypeStat 不记录你输入的内容。</b>
                  发给模型的只有上面那张清单里的应用名和数字——没有任何一个字符是你敲的那个字。
                </p>
              </div>

              <div className="field-row" style={{ marginTop: 22 }}>
                <button className="btn" type="submit" disabled={saving}>
                  {saving ? "保存中…" : "保存"}
                </button>
                {saveMsg?.bad && (
                  <span className="field-hint" style={{ margin: 0, color: "var(--critical)" }}>
                    {saveMsg.text}
                  </span>
                )}
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
