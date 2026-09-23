import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { num } from "../lib/metrics";

/**
 * 导出区间。**没有「今天」**：导出是拿来存档或分析的，
 * 单独导出一天不如直接看页面上的那一天。
 * `null` 是「全部」——起点由后端取库里最早的那一天，前端不猜。
 */
const EXPORT_RANGES: { days: number | null; label: string }[] = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
  { days: null, label: "全部" },
];

/** 文件大小。导出的是文本，一份几十天的记录通常在几十 KB。 */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} 字节`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 设置与说明。
 *
 * 这一页不画图，只报事实。它承担了一件事：把「哪些数不是全部」写清楚。
 * 这个程序里几乎每个数字都只覆盖一部分（按键只在非管理员窗口、字数只覆盖装了
 * 适配器的应用、时长只在有输入的时刻），这些边界写出来才不会变成误读。
 *
 * 它也是**唯一一处能改程序行为的地方**（暂停、开机自启）。这些开关都不属于
 * 「展示」，所以不放进顶栏；而它们的状态又都可能被别处改（托盘菜单），
 * 所以暂停那个状态由 `App` 持有、这里只是其中一个入口——存两份的话，
 * 用托盘暂停之后这一页还会写着「记录中」。
 */
export function Settings({
  today,
  revision,
  paused,
  setPaused,
}: {
  /** 真正的今天（后端给的，跟着时区走）。**不是**日期导航翻到的那一天——
   *  导出区间以它为准，理由见 `App.tsx` 里传参处。 */
  today: string;
  revision: number;
  paused: boolean | null;
  setPaused: (paused: boolean) => void;
}) {
  const [status, setStatus] = useState<api.HookStatus | null>(null);
  const [reinstalling, setReinstalling] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [auto, setAuto] = useState<api.Autostart | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  const [exportRange, setExportRange] = useState<number | null>(90);
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const [exported, setExported] = useState<api.ExportResult | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);

  useEffect(() => {
    api.hookStatus().then(setStatus).catch(console.error);
  }, [today, revision]);

  // 自启状态不跟数据走，但要**跟着窗口焦点**重新读：它可能在别处被改——
  // 任务管理器 →「启动」那一栏里就能关掉它，组策略也能。只在挂载时读一次的话，
  // 用户去别处改完回到这一页，看到的还是离开时的样子，而这里正是他回来核实的地方。
  useEffect(() => {
    const read = () =>
      api.autostartStatus().then(setAuto).catch((e) => setAutoError(String(e)));
    read();
    const onFocus = () => {
      read();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const reinstall = useCallback(async () => {
    setReinstalling(true);
    try {
      await api.reinstallHook();
      // 给钩子线程一点时间完成重建再读状态。
      await new Promise((r) => setTimeout(r, 300));
      setStatus(await api.hookStatus());
    } finally {
      setReinstalling(false);
    }
  }, []);

  const togglePause = useCallback(
    async (next: boolean) => {
      setPauseError(null);
      try {
        // 用**返回的状态**而不是入参：拨过去可能被拒（比如它已经是那样了），
        // 拿入参上屏的话，界面会显示一个并不成立的状态。
        setPaused(await api.setPaused(next));
      } catch (e) {
        // 不能只 console.error：那样开关闪一下又弹回原样，用户不知道发生了什么。
        setPauseError(String(e));
      }
    },
    [setPaused],
  );

  const doExport = useCallback(
    async (format: "csv" | "json") => {
      setExportError(null);
      // 上一次的结果也清掉。失败时留着它，那行「已写入 90 行…」就压在
      // 「没能导出」下面，看着像同一次的结果——它说的那个文件是真的，
      // 但这一格说的是**最近这一次按下去了什么**，那个是失败。
      setExported(null);
      setDirError(null);
      setExporting(format);
      try {
        // 区间含首尾两天，所以往前推 `days - 1` 天——推 `days` 天会多导一天。
        const from =
          exportRange === null ? null : api.shiftDay(today, -(exportRange - 1));
        // 终点**永远是今天**，不是日期导航翻到的那一天（这一页也没有那个控件）。
        const r = await api.exportData(format, from, today);
        setExported(r);
      } catch (e) {
        // 「这一段没有记录」「日期反了」「写不进去」都是要说给用户听的话。
        setExportError(String(e));
      } finally {
        setExporting(null);
      }
    },
    [today, exportRange],
  );

  const openDir = useCallback(async () => {
    setDirError(null);
    try {
      await api.openExportDir();
    } catch (e) {
      setDirError(String(e));
    }
  }, []);

  const toggleAuto = useCallback(async (next: boolean) => {
    setAutoError(null);
    setAutoBusy(true);
    try {
      setAuto(await api.setAutostart(next));
    } catch (e) {
      // 开不起来的原因必须说出来。写注册表可能被组策略拦；开发模式下是
      // 程序自己拒绝的（会把 target\debug 写进去）——那也是一句人话。
      setAutoError(String(e));
    } finally {
      setAutoBusy(false);
    }
  }, []);

  return (
    <section className="page">
      <p className="eyebrow">设置</p>
      <h2 className="sec">采集状态</h2>
      <p className="sub">这部分不画图，只报事实</p>

      <div className="item">
        {status ? (
          <>
            <div className="h">
              <span className={`dot ${status.alive ? "dot-ok" : "dot-bad"}`} />
              {status.alive ? "钩子运行中" : "钩子未运行"}
            </div>
            <div className="d">
              本次运行已捕获 <b>{num(status.eventCount)}</b> 个按键事件。
              如果发现打字不再被统计，可以先点下面的按钮手动重建——
              系统在钩子回调超时后会把钩子<b>悄悄摘掉且不作任何提示</b>，
              程序内置了看门狗（每 60 秒交叉校验一次）会自动处理，
              这个按钮是给它失手时兜底的。
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="btn" onClick={reinstall} disabled={reinstalling}>
                {reinstalling ? "重建中…" : "重建钩子"}
              </button>
            </div>
          </>
        ) : (
          <div className="empty">正在读取…</div>
        )}
      </div>

      <h2 className="sec" style={{ marginTop: 52 }}>
        运行方式
      </h2>
      <p className="sub">改的是程序的行为，不是数据</p>

      <div className="item">
        <div className="h">暂停记录</div>
        <div className="d">
          暂停期间按键<b>完全不入库</b>，所以那段时间在库里是<b>空白，不是 0</b>——
          和「坐在电脑前没打字」长得一模一样，恢复之后也补不回来。
          要统计别人的屏幕、或者不想让某段输入进入统计时用它。
          托盘右键菜单里是同一个开关。
        </div>
        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="seg" role="group" aria-label="暂停记录">
            <button
              className="seg-btn"
              aria-pressed={paused === false}
              onClick={() => togglePause(false)}
            >
              记录中
            </button>
            <button
              className="seg-btn"
              aria-pressed={paused === true}
              onClick={() => togglePause(true)}
            >
              已暂停
            </button>
          </div>
          {paused === null && <span className="field-hint" style={{ margin: 0 }}>正在读取…</span>}
        </div>
        {pauseError && (
          <p className="note" style={{ marginTop: 10 }}>
            <b>没能切换：</b>
            {pauseError}。上面显示的还是实际状态。
          </p>
        )}
      </div>

      <div className="item">
        <div className="h">开机自启</div>
        <div className="d">
          在当前用户的 Run 键里写一条，登录后自动开始计数。<b>不需要管理员权限</b>，
          也不用常驻服务——代价是只对当前 Windows 账户生效（统计本来就按账户算）。
          启动时带 <code>--minimized</code>：只在托盘里出现，不弹窗口盖住桌面。
        </div>
        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="seg" role="group" aria-label="开机自启">
            {/* 注册表里指的是老路径时两个都不算「开着」：那条项确实在，
                但它指向一个不在那儿的程序，开机时不会启动任何东西。 */}
            <button
              className="seg-btn"
              aria-pressed={auto?.enabled === true && !auto.stale}
              disabled={autoBusy}
              onClick={() => toggleAuto(true)}
            >
              开启
            </button>
            <button
              className="seg-btn"
              aria-pressed={auto?.enabled === false}
              disabled={autoBusy}
              onClick={() => toggleAuto(false)}
            >
              关闭
            </button>
          </div>
          {autoBusy && <span className="field-hint" style={{ margin: 0 }}>写入中…</span>}
        </div>
        {auto?.stale && (
          <p className="note" style={{ marginTop: 10 }}>
            <b>注册表里确实有这一项，但它指的是另一个路径：</b>
            <code>{auto.path}</code>
            <br />
            开机时它会去找这个文件，找不到就<b>静静地什么都不启动</b>——
            所以上面两个都不算「已开启」。点「开启」可以把它改成当前程序
            （<code>{auto.current ?? "拿不到当前路径"}</code>）。
          </p>
        )}
        {auto?.enabled && !auto.stale && (
          <p className="field-hint">
            开机时启动的是 <code>{auto.current ?? auto.path}</code>
          </p>
        )}
        {autoError && (
          <p className="note" style={{ marginTop: 10 }}>
            <b>没能设置：</b>
            {autoError}
          </p>
        )}
      </div>

      <div className="item">
        <div className="h">点窗口的 X 是收起来，不是退出</div>
        <div className="d">
          这个程序是个常驻的采集器：钩子和接收端都在这个进程里，窗口只是个前端。
          所以关掉窗口＝收进托盘，<b>计数继续</b>。
          左键点托盘图标把窗口叫回来，右键出菜单（打开 / 暂停 / 退出）。
          真要停下来，用托盘菜单里的「退出」——它会先把手上那点数据写完再退。
        </div>
      </div>

      <h2 className="sec" style={{ marginTop: 52 }}>
        已知限制
      </h2>
      <p className="sub">这些不是 bug，是 Windows 的规矩，写出来免得你以为漏记了</p>

      <div className="item">
        <div className="h">管理员窗口里的输入收不到</div>
        <div className="d">
          程序未提权时，Windows 的 UIPI 机制会阻止钩子收到发往更高完整性级别进程的输入
          （任务管理器、以管理员身份运行的程序等）。以管理员身份运行 TypeStat 才能覆盖它们。
        </div>
      </div>
      <div className="item">
        <div className="h">部分游戏和安全软件会屏蔽钩子</div>
        <div className="d">
          反作弊系统、DRM 播放器、银行网银控件会主动拦截全局键盘钩子，
          这通常是它们的设计要求，绕不过去。
        </div>
      </div>
      <div className="item">
        <div className="h">密码框里的按键不统计</div>
        <div className="d">
          系统标记为「安全输入」的输入框不给读。这是故意的，也不打算绕。
        </div>
      </div>
      <div className="item">
        <div className="h">中文字数需要适配器</div>
        <div className="d">
          键盘层面只知道你按了几次键，<b>不知道输入法最后出了几个字</b>——
          打「你好」要按六下键，只出来两个字。
          精确到汉字要靠编辑器侧的适配器：<b>WPS 和 Obsidian 现在就有</b>，
          都在「适配器」页里装；其余应用要等 UI Automation。
        </div>
      </div>

      <h2 className="sec" style={{ marginTop: 52 }}>
        关于数据
      </h2>
      <p className="sub">这份数据是什么，不是什么</p>

      <div className="item">
        <div className="h">不记录你写了什么</div>
        <div className="d">
          只计数量，不留内容。数据库里存的是「某分钟某应用敲了多少次」，
          <b>没有任何一个字段能还原出你打的字</b>。
        </div>
      </div>
      <div className="item">
        <div className="h">「按键数」和「字数」是两个量</div>
        <div className="d">
          按键数是物理按键的次数（含退格），字数是实际产生、删除的字符数。
          中文输入法下两者差距很大，所以它们永远不共用一根轴——
          顶栏那个 <b>「字数 / 按键」开关</b>切换的就是这个，所有页面一起切。
        </div>
      </div>
      <div className="item">
        <div className="h">两个口径的覆盖面也不一样</div>
        <div className="d">
          按键数来自全局钩子，所有应用都有；字数来自编辑器适配器，
          只有 WPS、Obsidian 这类装得上的应用才有，
          所以字数口径下的数字更小，那是<b>地盘更小，不是打得少了</b>。
          没有适配器的应用在字数口径下是「量不到」而不是 0——
          界面上会留空、标出覆盖率，绝不显示成 0。
        </div>
      </div>
      <div className="item">
        <div className="h">数据库位置</div>
        <div className="d">
          <code>%APPDATA%\com.typestat.app\typestat.db</code>
          <div style={{ color: "var(--muted)", marginTop: 6 }}>
            SQLite，分钟级明细，可自行备份或删除。总结页的接口 key 也在这张表里
            （DPAPI 加密，只有当前 Windows 账户解得开）——删掉这个文件，密钥要重填一次。
          </div>
        </div>
      </div>

      <div className="item">
        <div className="h">导出数据</div>
        <div className="d">
          把记录写成文件，落在 <code>下载\TypeStat\</code> 里。
          <b>CSV</b> 是一张表、一天一行，表格软件打开就能画图和透视；
          <b>JSON</b> 是这一段的全量，按天、按小时、按应用三张表一起，
          里面还带一段说明解释每个字段。
          <div style={{ color: "var(--muted)", marginTop: 6 }}>
            两种格式的字段名是一样的。字数<b>量不到</b>的那几天在 CSV 里是
            <b>空字段</b>、在 JSON 里是 <code>null</code>——<b>不是 0</b>，
            所以拿去求和之前先看一眼有没有空格子。
            另外这个操作<b>不会覆盖</b>已有的文件，同名就顺延成 <code>-2</code>、<code>-3</code>。
          </div>
          <div style={{ color: "var(--muted)", marginTop: 6 }}>
            区间<b>一律到今天为止</b>：「近 7 天」是「最近这七天」，
            和你在别的页面翻到了哪一天无关。导完那行会写出实际起止日期。
          </div>
        </div>
        <div className="field-row" style={{ marginTop: 12 }}>
          <div className="seg" role="group" aria-label="导出区间">
            {EXPORT_RANGES.map((r) => (
              <button
                key={r.label}
                className="seg-btn"
                aria-pressed={exportRange === r.days}
                onClick={() => setExportRange(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div style={{ marginLeft: 12 }}>
            <button
              className="btn"
              disabled={exporting !== null}
              onClick={() => doExport("csv")}
            >
              导出 CSV
            </button>
            <button
              className="btn"
              style={{ marginLeft: 8 }}
              disabled={exporting !== null}
              onClick={() => doExport("json")}
            >
              导出 JSON
            </button>
          </div>
          {exporting !== null && (
            <span className="field-hint" style={{ margin: 0 }}>
              正在导出…
            </span>
          )}
        </div>
        {exportError && (
          <p className="note" style={{ marginTop: 10 }}>
            <b>没能导出：</b>
            {exportError}
          </p>
        )}
        {exported && (
          <p className="field-hint" style={{ marginTop: 10 }}>
            已写入 <b>{num(exported.rows)}</b> 行、{humanBytes(exported.bytes)}（
            {exported.from} 至 {exported.to}）：
            <br />
            <code style={{ wordBreak: "break-all" }}>{exported.path}</code>
            <br />
            <button
              className="btn btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => openDir()}
            >
              打开文件夹
            </button>
            {dirError && <span className="field-hint">　打不开：{dirError}</span>}
          </p>
        )}
      </div>

      <h2 className="sec" style={{ marginTop: 52 }}>
        还没覆盖到的
      </h2>
      <p className="sub">下一个要做的</p>

      <div className="item">
        <div className="h">Word / 浏览器网页</div>
        <div className="d">
          这些还没有适配器，之后会走 UI Automation：读取光标附近一小段文本做差分。
          精度和响应速度都不如适配器，而且需要采样，所以排在适配器之后做。
          在它就位之前，这些应用只有按键口径——汉字数会明显偏低。
          <p className="caption" style={{ marginTop: 10 }}>
            WPS 原来也在这张名单上，现在不在了：它的加载项在「适配器」页点一下就能装。
            那份走的是 WPS 自己的 JS 加载项框架，所以 Word 用不上它。
          </p>
        </div>
      </div>
    </section>
  );
}
