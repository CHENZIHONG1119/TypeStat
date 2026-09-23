import { useEffect, useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import { Chart } from "../components/Chart";
import { StatTile } from "../components/StatTile";
import { useTokens } from "../lib/useTheme";
import { axisStyle, baseOption } from "../theme";
import * as api from "../lib/api";
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
  unitOf,
  type MetricMode,
} from "../lib/metrics";

/** 和 `db::SESSION_GAP_MINUTES` 保持一致。界面上要写明这个阈值，否则时长无从解释。 */
const SESSION_GAP_MINUTES = 5;

export function Dashboard({
  day,
  revision,
  metric,
}: {
  day: string;
  revision: number;
  metric: MetricMode;
}) {
  const t = useTokens();
  const [summary, setSummary] = useState<api.TodaySummary | null>(null);
  const [hours, setHours] = useState<api.HourPoint[]>([]);

  useEffect(() => {
    api.todaySummary(day).then(setSummary).catch(console.error);
    api.hourly(day).then(setHours).catch(console.error);
  }, [day, revision]);

  // 选了字数但今天一个适配器都没上报过 → 退回按键口径（否则整页空白）。
  const mode = resolveMode(metric, summary?.hasCharData ?? false);
  const precise = mode === "char";
  const fellBack = !precise && metric === "char";

  const option = useMemo<EChartsOption>(() => {
    // 补齐 0 点–23 点，否则柱子会错位。
    //
    // 关键区别：**按键口径下缺的小时就是 0**（没打字），
    // **字数口径下没有精确数据的小时要给 `null`**（量不到），
    // ECharts 收到 null 会留空。给 0 就是「这一小时一个字没打」——
    // 那是谎话，正是它让小时图和看板上的按键数对不上。
    const cells = Array.from({ length: 24 }, (_, h) => {
      const p = hours.find((x) => x.hour === h);
      return {
        h,
        p,
        input: precise ? (p?.hasChar ? p.charInput : null) : (p?.keyInput ?? 0),
        del: precise ? (p?.hasChar ? p.charDelete : null) : (p?.keyDelete ?? 0),
      };
    });

    const base = baseOption(t);
    const ax = axisStyle(t);
    const unit = unitOf(mode);

    return {
      ...base,
      grid: { left: 8, right: 8, top: 40, bottom: 8, containLabel: true },
      legend: { ...base.legend, top: 0, left: 0 },
      tooltip: {
        ...base.tooltip,
        trigger: "axis",
        // 折线图用竖线指示器，不用柱状图那种阴影块。
        axisPointer: { type: "line" },
        // 自定义 formatter 而不是 valueFormatter：这一小时「全不全」也要说出来。
        // 同一个小时里可能一半时间在 WPS（有适配器）、一半在终端（没有），
        // 那种半覆盖的小时如果不标注，会显得和全覆盖一样完整。
        formatter: (ps: any) => {
          const arr = Array.isArray(ps) ? ps : [ps];
          if (!arr.length) return "";
          const cell = cells[arr[0].dataIndex];
          const p = cell.p;
          const head = `${cell.h} 时`;
          if (precise && (!p || !p.hasChar)) {
            return `${head}<br/><span style="color:${t.muted}">这一小时没有精确数据</span>`;
          }
          const lines = arr.map(
            (s: any) =>
              `${s.marker}${s.seriesName}　<b>${num(Number(s.value))}</b> ${unit}`,
          );
          if (precise && p && p.charKeyInput < p.keyInput) {
            const cover = Math.round((p.charKeyInput / p.keyInput) * 100);
            lines.push(
              `<span style="color:${t.muted}">该小时仅 ${cover}% 的按键有精确字数</span>`,
            );
          }
          return `${head}<br/>${lines.join("<br/>")}`;
        },
      },
      xAxis: {
        type: "category",
        // 折线要贴到左右边缘，不能像柱状图那样在两端留半个类目的空。
        boundaryGap: false,
        data: cells.map((c) => `${c.h}`),
        ...ax,
        splitLine: { show: false },
        // 24 个刻度太密，隔一个显示。
        axisLabel: { ...ax.axisLabel, interval: 1, formatter: "{value}时" },
      },
      yAxis: {
        type: "value",
        ...ax,
        axisLine: { show: false },
      },
      series: [
        {
          name: precise ? "输入字数" : "输入按键",
          type: "line",
          // 圆滑曲线。**代价是它会画出一条数据里没有的路径**——两个点之间
          // 是插出来的，不代表那半小时真的匀速。所以点标记一律留着
          // （showSymbol），真实数据点必须能一眼看见，曲线只当引导线。
          smooth: true,
          data: cells.map((c) => c.input),
          lineStyle: { width: 2, color: t.series1 },
          itemStyle: { color: t.series1 },
          symbol: "circle",
          symbolSize: 7,
          showSymbol: true,
          connectNulls: false,
        },
        {
          name: precise ? "删除字数" : "删除按键",
          type: "line",
          smooth: true,
          data: cells.map((c) => c.del),
          lineStyle: { width: 2, color: t.series2 },
          itemStyle: { color: t.series2 },
          symbol: "circle",
          symbolSize: 7,
          showSymbol: true,
          connectNulls: false,
        },
      ],
    };
  }, [hours, precise, mode, t]);

  if (!summary) return <div className="empty">正在加载…</div>;

  const m = pickMetrics(summary, mode);
  const net = m.input - m.del;
  const rate = m.input > 0 ? m.del / m.input : 0;
  const active = [...hours].sort(
    (a, b) => b.charInput + b.keyInput - (a.charInput + a.keyInput),
  )[0];
  // 覆盖率只在字数口径下才要说明——按键口径本来就是全量的，没有覆盖问题。
  const coverage = precise ? coverageNote(summary.preciseKeyInput, summary.keyInput) : null;
  const missing = summary.uncoveredApps;
  // 字数口径下有没有整块时段是空的——有就要在图上说清楚那是什么意思。
  const gapHours = precise ? hours.filter((h) => !h.hasChar && h.keyInput > 0).length : 0;

  // 打字时长与速度。时长**不分口径**——时长就是时长，跟按了几键、打了几个字无关。
  const speed = typingSpeed(mode, summary);
  const from = minuteLabel(summary.firstMinute);
  const to = minuteLabel(summary.lastMinute);
  // 速度的分母跟着口径走，所以那个分母是什么必须写出来，否则「30 字/分」是算不清的。
  const speedBasis = precise
    ? `精确字数 ÷ 有精确字数的 ${num(summary.preciseMinutes)} 分钟`
    : `按键数 ÷ 有输入的 ${num(summary.activeMinutes)} 分钟`;

  return (
    <>
      {fellBack && (
        <p className="note">
          今天还没有任何<b>精确字数</b>数据（没装适配器，或装了还没敲过字），
          所以下面显示的是<b>按键数</b>。装好适配器后这一天会自动有字数。
        </p>
      )}

      {/* 整个看板领读的那个数字——用大字号，不画成只有一根柱子的图 */}
      <div className="tiles">
        <StatTile
          label={precise ? "今日净字数" : "今日净按键"}
          value={num(net)}
          hint={
            precise
              ? `敲入 ${num(m.input)} 字，删掉 ${num(m.del)} 字` +
                (coverage ? ` · ${coverage}` : "") +
                (missing.length ? `（未覆盖：${missing.join("、")}）` : "")
              : "按键口径：覆盖所有应用，但粒度是「键」不是「字」"
          }
          hero
        />
        <StatTile label={precise ? "输入字数" : "输入按键"} value={num(m.input)} />
        <StatTile label={precise ? "删除字数" : "删除按键"} value={num(m.del)} />
        <StatTile
          label="删除率"
          value={pct(rate)}
          hint={precise ? "删掉的字 ÷ 敲入的字" : "删掉的键 ÷ 敲入的键"}
        />
        {/* 时长那两个不分口径：时长就是时长，按了几个键、打了几个字都不改变它。
            所以切「字数 / 按键」时这两个数不动——那是故意的，不是没刷新。 */}
        <StatTile
          label="今日写作时间"
          value={formatMinutes(summary.sessionMinutes)}
          hint={
            `间隔 ≤ ${SESSION_GAP_MINUTES} 分钟算一段` +
            (summary.longestMinutes > 0 ? ` · 最长一段 ${formatMinutes(summary.longestMinutes)}` : "")
          }
        />
        <StatTile
          label="其中真正在敲的"
          value={formatMinutes(summary.activeMinutes)}
          hint={
            (from && to ? `${from} – ${to} 之间 · ` : "") +
            "有按键的分钟数（一分钟内敲一下也算一分钟，所以它偏大）"
          }
        />
        <StatTile
          label="打字速度"
          value={speed === null ? "—" : `${speedText(speed)} ${speedUnit(mode)}`}
          hint={speedBasis}
        />
        <StatTile
          label="其他按键"
          value={num(summary.keyOther)}
          hint="方向键、快捷键等（按键单位，没有字数概念）"
        />
      </div>

      <div className="card">
        <h2 className="card-title">今日每小时输入</h2>
        <p className="card-sub">
          {precise ? "精确字数口径" : "按键口径"}
          {coverage && ` · ${coverage}`}
          {active && active.charInput + active.keyInput > 0 && <> · 高峰在 {active.hour} 时</>}
        </p>
        {precise && gapHours > 0 && (
          <p className="note">
            <b>空白的小时不是「没打字」，是那时段没有精确数据</b>（当时用的应用没有适配器）。
            今天有 {gapHours} 个小时是这样——切到「按键」口径能看到那些时段。
          </p>
        )}
        <Chart option={option} height={300} />
      </div>
    </>
  );
}
