import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { dayWord, shortDate } from "../lib/dates";
import { useTokens } from "../lib/useTheme";
import { KeyboardHeatmap } from "../components/KeyboardHeatmap";

/**
 * 键位热力图。这一页不跟口径开关走——它数的本来就是按键，
 * 而按键是「每一次物理按下」，没有「字」这个概念。
 */
export function Keys({
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
  const tokens = useTokens();
  const [rows, setRows] = useState<api.KeyUsage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isToday = day === today;
  const when = dayWord(day, today);

  // 区间含最后一天，所以要往前推 days-1 天，否则「近 7 天」会变成 8 天。
  const from = days === 1 ? day : api.shiftDay(day, -(days - 1));

  useEffect(() => {
    let alive = true;
    setRows(null);
    api
      .keyUsage(from, day)
      .then((r) => {
        if (alive) {
          setRows(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [from, day, revision]);

  return (
    <section className="page">
      <p className="eyebrow">
        键位 · {days === 1 ? when : `近 ${days} 天`}
      </p>
      <h2 className="sec">你按的是哪些键</h2>
      <p className="sub">
        60% 布局 · 颜色按次数取平方根缩放，否则高低差两个数量级会糊成一片
      </p>

      {error ? (
        <div className="empty">读取失败：{error}</div>
      ) : !rows ? (
        <div className="empty">正在加载…</div>
      ) : (
        <KeyboardHeatmap tokens={tokens} data={rows} />
      )}

      <h2 className="sec" style={{ marginTop: 52 }}>
        这张图算的是什么
      </h2>
      <p className="sub">五条口径，写出来免得跟别的数字对不上</p>

      <div className="item">
        <div className="d">
          <ul>
            <li>
              统计<b>每一次物理按下</b>，包括修饰键和快捷键组合。按一下 Ctrl+C，Ctrl 和 C
              各记一次——这张图回答的是「哪个键被我按得最多」，不是「哪个键产出了字符」。
            </li>
            <li>长按不重复计数。自动重复已经过滤掉，按住不放三秒也只算一次。</li>
            <li>
              左右修饰键分开算。左右 Shift、左右 Ctrl、左右 Alt 在系统里共用同一个键码，
              只有扫描码能把它们分开，所以采集时把键码、扫描码、扩展位三个字段都存了。
            </li>
            <li>
              图上画的是 60% 布局，没有方向键、F 区和小键盘。这些键的次数单独列在标题栏
              （会写明是哪个键），<b>不会静默丢掉</b>。
            </li>
            <li>
              数据按天汇总存储，所以这一页的日期都是<b>自然日</b>，不是「最近 24 小时」：
              {days === 1
                ? isToday
                  ? "看今天就是从零点到现在。"
                  : `这里指的是 ${when} 一整天。`
                : `近 ${days} 天就是从 ${shortDate(from)} 到 ${shortDate(day)} 这几个自然日。`}
              本页 <b>不跟顶栏的口径开关走</b>——这里数的是按键，没有「字」这个概念。
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
