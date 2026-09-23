import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { num } from "../lib/metrics";

/**
 * 设置与说明。
 *
 * 这一页不画图，只报事实。它承担了一件事：把「哪些数不是全部」写清楚。
 * 这个程序里几乎每个数字都只覆盖一部分（按键只在非管理员窗口、字数只覆盖装了
 * 适配器的应用、时长只在有输入的时刻），这些边界写出来才不会变成误读。
 */
export function Settings({ day, revision }: { day: string; revision: number }) {
  const [status, setStatus] = useState<api.HookStatus | null>(null);
  const [reinstalling, setReinstalling] = useState(false);

  useEffect(() => {
    api.hookStatus().then(setStatus).catch(console.error);
  }, [day, revision]);

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
          精确到汉字要靠编辑器侧的适配器（Obsidian 插件 / 之后的 UI Automation）。
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

      <h2 className="sec" style={{ marginTop: 52 }}>
        还没覆盖到的
      </h2>
      <p className="sub">下一个要做的</p>

      <div className="item">
        <div className="h">Word / WPS / 浏览器网页</div>
        <div className="d">
          这些应用装不了插件，之后会走 UI Automation：读取光标附近一小段文本做差分。
          精度和响应速度都不如插件，而且需要采样，所以排在插件之后做。
          在它就位之前，这些应用只有按键口径——汉字数会明显偏低。
        </div>
      </div>
    </section>
  );
}
