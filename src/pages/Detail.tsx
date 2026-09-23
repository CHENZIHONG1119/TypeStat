import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { dayWord, longDate } from "../lib/dates";
import { num, pct, shortName } from "../lib/metrics";

const sourceLabel = (s: api.AppPoint["charSource"]) =>
  s === "plugin" ? "精确（插件）" : s === "uia" ? "精确（UIA）" : "仅按键";

/**
 * 分应用对账。
 *
 * **这一页不跟口径开关走，故意的。** 顶栏那个开关管的是「一根轴用哪种单位」，
 * 而这里的两种单位各占各的列、列头写着单位，不存在混轴的问题。
 * 一页里同时摆着「按键」和「字数」，是为了让人自己看出一件事：
 * **两列数的地盘不一样**——输入按键覆盖全部应用，输入字数只覆盖有适配器的那几个。
 * 横着比这两列没有意义，竖着看各自的行才对。
 */
export function Detail({
  day,
  today,
  revision,
}: {
  day: string;
  today: string;
  revision: number;
}) {
  const [apps, setApps] = useState<api.AppPoint[] | null>(null);

  // `day` 可以是过去的日子，所以正文里不能出现写死的「今天」——用 `when`。
  const when = dayWord(day, today);

  useEffect(() => {
    // `alive` 那道闸门见 `Keys.tsx`：`day` 现在会在运行时变（跨过午夜或翻日期），
    // 而请求是并发的，迟到的那次会让对账表写着这个日期、列着另一天的数。
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

  if (!apps) return <div className="empty">正在加载…</div>;

  if (apps.length === 0) {
    return (
      <section className="page">
        <p className="eyebrow">明细 · {when}</p>
        <h2 className="sec">分应用对账</h2>
        <div className="empty">{when}还没有记录到输入</div>
      </section>
    );
  }

  const rows = [...apps].sort((a, b) => b.keyInput - a.keyInput);
  const covered = rows.filter((a) => a.charSource !== null).length;
  // 合计只把有精确字数的应用加进去——把「量不到」当 0 加进去的话，
  // 合计那一行会变成「这一天一个字都没打」，而同一张表下面明明列着几千次按键。
  const t = rows.reduce(
    (s, a) => ({
      ki: s.ki + a.keyInput,
      ci: s.ci + (a.charSource !== null ? a.charInput : 0),
      cd: s.cd + (a.charSource !== null ? a.charDelete : 0),
    }),
    { ki: 0, ci: 0, cd: 0 },
  );
  /** 这一天有没有任何一个应用报得上字数。没有的话，合计那一行的字数得写「—」。 */
  const anyChar = covered > 0;
  const bogus = t.ki > 0 && t.ci > t.ki;

  return (
    <section className="page">
      <p className="eyebrow">明细 · {longDate(day)}</p>
      <h2 className="sec">分应用对账</h2>
      <p className="sub">
        图上排不出名次的，这里都写着 · 两种单位各占各的列，所以这一页不跟口径开关走
      </p>

      <table className="data" style={{ marginTop: 26 }}>
        <thead>
          <tr>
            <th>应用</th>
            <th>输入按键</th>
            <th>输入字数</th>
            <th>删除字数</th>
            <th>删除率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.app}>
              <td>
                {shortName(a.app)}
                <span
                  className={`badge${a.charSource !== null ? " badge-precise" : ""}`}
                >
                  {sourceLabel(a.charSource)}
                </span>
              </td>
              <td className="num">{num(a.keyInput)}</td>
              <td className="num">
                {a.charSource !== null ? num(a.charInput) : "—"}
              </td>
              <td className="num">
                {a.charSource !== null ? num(a.charDelete) : "—"}
              </td>
              <td className="num">
                {a.charSource !== null
                  ? a.charInput > 0
                    ? pct(a.charDelete / a.charInput)
                    : "—"
                  : "—"}
              </td>
            </tr>
          ))}
          <tr className="total">
            <td>合计</td>
            <td className="num">{num(t.ki)}</td>
            {/* 三格都跟着 `anyChar` 走，**不能印 0**：这一行是拿来对账的，
                「0 字」和「量不到」混在一起，整张表就没法核对了。
                有字数的应用一个都没有时，这里必须是「—」。 */}
            <td className="num">{anyChar ? num(t.ci) : "—"}</td>
            <td className="num">{anyChar ? num(t.cd) : "—"}</td>
            <td className="num">{t.ci > 0 ? pct(t.cd / t.ci) : "—"}</td>
          </tr>
        </tbody>
      </table>

      <p className="caption">
        <b>「—」是「量不到」，不是 0</b>。它和旁边那个真正的 0 必须长得不一样，
        否则这张表就没法拿来对账了。
        {covered === 0 ? (
          <>
            {when}<b>一个应用的字数都没量到</b>（还没装适配器），所以字数那三列整列都是「—」，
            只有按键数是全的。
          </>
        ) : (
          <>
            两列数的<b>地盘也不一样</b>：输入按键覆盖全部 {rows.length} 个应用，
            输入字数只覆盖有适配器的那 {covered} 个
            {/* 合计那一行不是「全部应用的字数」，得说清楚它算的是哪几个，
                否则读者会拿它当这一天的总字数——正是这一页在防的误读。 */}
            {covered < rows.length && <>，合计那一行的字数也只算了这 {covered} 个</>}。
            横着比这两列没有意义，竖着看各自的行才对。
          </>
        )}
      </p>

      {bogus && (
        <p className="note">
          ⚠ <b>合计字数（{num(t.ci)}）比合计按键（{num(t.ki)}）还多。</b>
          每产生一个字符至少要有一次按键，所以这不可能，多半是某个适配器的量法不对
          （旧版 WPS 适配器取的是 <code>Range.Text.length</code>，那是覆盖区域的长度、
          不是增量，于是每按一次键字数就往上跳一大截）。这个数先别信。
        </p>
      )}
    </section>
  );
}
