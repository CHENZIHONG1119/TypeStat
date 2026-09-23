import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";

/** 把 Unix 秒转成「x 分钟前」这种人话。 */
function agoText(unixSeconds: number): string {
  const secs = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
  if (secs < 10) return "刚刚";
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
}

/**
 * 精确字数适配器。
 *
 * 装了它，「字数」这个口径才不止覆盖 WPS。适配器上报的是**字符数的变化量**，
 * 不是文档长度——这是这个项目踩过的最大的一个坑：WPS 的 `Range.Text.length`
 * 给的是覆盖区域的长度，用它会得到一个比总按键数还大的字数。
 */
export function Adapter({ day, revision }: { day: string; revision: number }) {
  const [adapter, setAdapter] = useState<api.AdapterStatus | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    api.adapterStatus().then(setAdapter).catch(console.error);
  }, [day, revision]);

  const copy = useCallback(async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1800);
    } catch {
      // 剪贴板被拒绝时退化成选中，用户还能手动 Ctrl+C。
      window.prompt("复制下面这串：", text);
    }
  }, []);

  const rotateToken = useCallback(async () => {
    setRotating(true);
    try {
      const token = await api.rotateAdapterToken();
      setAdapter((a) => (a ? { ...a, token } : a));
    } catch (e) {
      console.error(e);
    } finally {
      setRotating(false);
    }
  }, []);

  if (!adapter) return <div className="empty">正在读取…</div>;

  return (
    <section className="page">
      <p className="eyebrow">精确字数适配器</p>
      <h2 className="sec">Obsidian</h2>
      <p className="sub">
        让「字数」这个口径不止覆盖 WPS · 上报的只有「新增几个字、删掉几个字」两个整数
      </p>

      <div className="item">
        <div className="h">
          <span className={`dot ${adapter.port ? "dot-ok" : "dot-bad"}`} />
          {adapter.port
            ? `接收端正在监听 127.0.0.1:${adapter.port}`
            : "接收端未启动（42180–42189 端口全被占用）"}
        </div>
        <div className="d">
          {adapter.lastReportAt > 0
            ? `最近收到上报：${agoText(adapter.lastReportAt)}`
            : "还没收到过任何上报——插件装好并敲下第一个字之后，这里会有时间。"}
        </div>
      </div>

      <div className="item">
        <div className="h">连接令牌</div>
        <div className="field">
          <div className="field-row">
            <code className="token">{adapter.token}</code>
            <button className="btn btn-sm" onClick={() => copy(adapter.token, "token")}>
              {copied === "token" ? "已复制" : "复制"}
            </button>
            <button className="btn btn-sm" onClick={rotateToken} disabled={rotating}>
              {rotating ? "生成中…" : "重新生成"}
            </button>
          </div>
          <p className="field-hint">
            接收端要求请求带上这个令牌，免得本机其他程序往统计里灌数据。
            <b>重新生成之后，Obsidian 插件里的令牌要跟着改</b>，否则会连不上，
            而连不上的表现是「字数一直是 0」——很容易被误读成「今天没写字」。
          </p>
        </div>
        {adapter.port && (
          <div className="field">
            <div className="field-row">
              <code className="token">127.0.0.1:{adapter.port}</code>
              <button
                className="btn btn-sm"
                onClick={() => copy(String(adapter.port), "port")}
              >
                {copied === "port" ? "已复制" : "复制端口"}
              </button>
            </div>
            <p className="field-hint">插件里要填的就是这个端口号和上面的令牌。</p>
          </div>
        )}
      </div>

      <div className="item">
        <div className="h">装到 Obsidian 里</div>
        <div className="d">
          <ol className="steps">
            <li>
              把 <code>TypeStat\obsidian-plugin</code> 整个文件夹复制到你的库目录下的{" "}
              <code>.obsidian\plugins\typestat</code>
              （没有 <code>plugins</code> 目录就自己建一个）。
            </li>
            <li>
              重开 Obsidian，在「设置 → 第三方插件」里关掉安全模式，启用
              <b> TypeStat 字数上报</b>。
            </li>
            <li>
              在插件设置里粘贴上面的<b>端口</b>和<b>令牌</b>，点「测试连接」确认。
            </li>
          </ol>
          <p style={{ marginTop: 12 }}>
            插件只上报「新增几个字、删掉几个字」两个整数，<b>正文内容一个字都不出 Obsidian</b>。
          </p>
        </div>
      </div>

      <p className="caption">
        适配器上报的是<b>字符数的变化量</b>，不是文档长度。这是这个项目里踩过的最大的一个坑：
        WPS 的 <code>Range.Text.length</code> 给的是覆盖区域的长度，
        用它会得到一个比总按键数还大的字数（而且它看起来完全正常）。
        现在的量法是逐次看 <code>doc.Characters.Count</code> 变了多少。
      </p>
    </section>
  );
}
