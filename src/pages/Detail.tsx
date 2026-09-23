import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { longDate } from "../lib/dates";
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
export function Detail({ day, revision }: { day: string; revision: number }) {
  const [apps, setApps] = useState<api.AppPoint[] | null>(null);

  useEffect(() => {
    api.appBreakdown(day).then(setApps).catch(console.error);
  }, [day, revision]);

  if (!apps) return <div className="empty">正在加载…</div>;

  if (apps.length === 0) {
    return (
      <section className="page">
        <p className="eyebrow">明细 · 今天</p>
        <h2 className="sec">分应用对账</h2>
        <div className="empty">今天还没有记录到输入</div>
      </section>
    );
  }

  const rows = [...apps].sort((a, b) => b.keyInput - a.keyInput);
  const t = rows.reduce(
    (s, a) => ({
      ki: s.ki + a.keyInput,
      ci: s.ci + (a.charSource !== null ? a.charInput : 0),
      cd: s.cd + (a.charSource !== null ? a.charDelete : 0),
    }),
    { ki: 0, ci: 0, cd: 0 },
  );
  const covered = rows.filter((a) => a.charSource !== null).length;
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
            <td className="num">{num(t.ci)}</td>
            <td className="num">{num(t.cd)}</td>
            <td className="num">{pct(t.ci > 0 ? t.cd / t.ci : 0)}</td>
          </tr>
        </tbody>
      </table>

      <p className="caption">
        <b>「—」是「量不到」，不是 0</b>。它和旁边那个真正的 0 必须长得不一样，
        否则这张表就没法拿来对账了。
        两列数的<b>地盘也不一样</b>：输入按键覆盖全部 {rows.length} 个应用，
        输入字数只覆盖有适配器的那 {covered} 个。横着比这两列没有意义，竖着看各自的行才对。
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
