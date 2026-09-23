import { shiftDay } from "../lib/api";
import { longDate } from "../lib/dates";

/**
 * 日期导航：把「今天」从一个固定的事实变成一个可以往后翻的位置。
 *
 * ## 为什么需要一个「回到今天」而不只是一个日期框
 *
 * 翻到上周三之后，用户最容易卡住的一步是「怎么回去」。日期框里填回今天
 * 是个纯手工动作，而**跨过午夜之后「今天」还会变**——昨天填的那个日期当时是今天，
 * 现在不是了。所以回今天是**一个按钮**，点了就回到「跟着今天走」那个状态
 * （`App` 里 `viewDay === null`），而不是把它当成一个填进去的日期。
 *
 * ## 为什么不能翻到未来
 *
 * 「明天」在库里必然什么都没有，翻过去只会看到一屏「还没有记录」——
 * 那看起来像程序坏了。所以后一天在今天就禁用。
 *
 * ## 为什么用 `type="date"`
 *
 * 它自带一个能按年月跳的日历（键盘也能用），比自己拼一个日期选择器省事，
 * 而且用户认得出这是什么。`max` 顶到今天，浏览器自己就会挡住未来的日期。
 *
 * 日期框里显示的是**当前正在看的这一天**，不是「今天」——它是个位置指示器，
 * 不然翻到 9/23 之后框里还写着 9/24，用户会以为没翻过去。
 */
export function DayBar({
  day,
  today,
  onPick,
}: {
  /** 当前正在看的那一天。 */
  day: string;
  /** 真正的今天（后端给的，跟着时区走）。 */
  today: string;
  /** 选一个具体的日子；传 `null` 表示「回到跟今天走」。 */
  onPick: (day: string | null) => void;
}) {
  const isToday = day === today;
  const step = (n: number) => {
    // 用 `api.shiftDay`，不在这里另写一遍：两处日期算术迟早会在月末或夏令时上分叉。
    const next = shiftDay(day, n);
    // 翻到今天就不再是「选了一个日子」，回到跟今天走的状态——
    // 否则今天过完变成昨天时，这一页会停在一个用户并没有选过的日子上。
    onPick(next >= today ? null : next);
  };

  return (
    <div className="rangebar" role="group" aria-label="日期">
      <span className="lbl">日期</span>
      <div className="seg">
        <button className="seg-btn" onClick={() => step(-1)} title="前一天">
          ‹ 前一天
        </button>
        <button
          className="seg-btn"
          onClick={() => step(1)}
          disabled={isToday}
          title={isToday ? "今天是一格，后面还没有发生" : "后一天"}
        >
          后一天 ›
        </button>
      </div>
      <input
        type="date"
        className="daypick"
        aria-label="选择日期"
        value={day}
        max={today}
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          onPick(v >= today ? null : v);
        }}
      />
      <span className="spacer" />
      <span className="dayword">{longDate(day)}</span>
      {isToday ? (
        <span className="pill">今天</span>
      ) : (
        <button className="btn btn-sm" onClick={() => onPick(null)}>
          回到今天
        </button>
      )}
    </div>
  );
}

