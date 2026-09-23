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
 * 这一页要同时讲清三件事，所以分三层写：**两个插件共用的那一半**（接收端和令牌，
 * 两边填的是同一对值）、**WPS**（程序能替你装完）、**Obsidian**（装到哪儿取决于
 * 你的库在哪儿，程序不知道那个路径，只能把文件交出去）。
 *
 * 把共用部分提到前面是有原因的：原来这一页只讲 Obsidian，端口和令牌那两栏夹在
 * 「装到 Obsidian 里」上面，看上去像是插件的设置项。它们是**接收端**的设置，
 * 装第二个插件时要填的是同一个值。
 *
 * 适配器上报的是**字符数的变化量**，不是文档长度——这是这个项目踩过的最大的一个坑：
 * WPS 的 `Range.Text.length` 给的是覆盖区域的长度，用它会得到一个比总按键数还大的字数。
 */
export function Adapter({ day, revision }: { day: string; revision: number }) {
  const [adapter, setAdapter] = useState<api.AdapterStatus | null>(null);
  const [addon, setAddon] = useState<api.AddonStatus | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** 换令牌失败的原因。吞掉它的话，按钮点下去看起来什么都没发生。 */
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installed, setInstalled] = useState<api.InstallResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exported, setExported] = useState<api.AddonFiles | null>(null);

  /**
   * 重新读一遍「装到哪儿了」。
   *
   * 装完、以及换过令牌之后都要走一次，而且**不能拿按钮那一次的结果去猜**：
   * 「装过」和「装成了」不是一件事，写盘可能停在半路。所以状态永远重新问后端，
   * 那个函数是只读的，问一次没有代价。
   */
  const refreshAddon = useCallback(() => {
    api
      .wpsAddonStatus()
      .then(setAddon)
      .catch(console.error);
  }, []);

  useEffect(() => {
    // `alive` 那道闸门见 `Keys.tsx`。这一页还多一层：上报计数在涨，
    // 迟到的响应会让「最近收到上报」那一行显示成更早的时间。
    let alive = true;
    api
      .adapterStatus()
      .then((r) => {
        if (alive) setAdapter(r);
      })
      .catch(console.error);
    api
      .wpsAddonStatus()
      .then((r) => {
        if (alive) setAddon(r);
      })
      .catch(console.error);
    return () => {
      alive = false;
    };
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
    setRotateError(null);
    try {
      const token = await api.rotateAdapterToken();
      setAdapter((a) => (a ? { ...a, token } : a));
      // 换完令牌，装在 WPS 里的那一份当场就旧了。**这一句不能省**：
      // 不重读的话，上面令牌已经是新的、下面 WPS 那一节还写着「一切正常」，
      // 而事实是它的上报会被拒（401），表现是「字数一直是 0」。
      refreshAddon();
    } catch (e) {
      // **不能只 `console.error`。** 那句报错落在 webview 的控制台里，用户看不到，
      // 他只看到按钮亮了一下又恢复原样——而「令牌没换成」和「换成了但界面没刷新」
      // 在屏幕上完全一样，于是他多半会再点一次。把原因摆在按钮下面，
      // 顺便说明旧令牌还有效，免得他去改插件的配置。
      setRotateError(String(e));
    } finally {
      setRotating(false);
    }
  }, [refreshAddon]);

  const doInstall = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    // 上一次的结果也清掉。失败时留着它，那行「已装到 …」就压在「没能装」下面，
    // 看着像同一次的结果——它说的那个文件是真的，但这一格说的是**最近这一次
    // 按下去了什么**，那个是失败。和设置页导出是同一个道理。
    setInstalled(null);
    try {
      const r = await api.installWpsAddon();
      setInstalled(r);
      refreshAddon();
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  }, [refreshAddon]);

  const doExport = useCallback(async () => {
    setExporting(true);
    setExportError(null);
    setExported(null);
    try {
      setExported(await api.exportAdapterFiles());
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }, []);

  const openAddonDir = useCallback(async () => {
    try {
      await api.openWpsAddonDir();
    } catch (e) {
      setInstallError(String(e));
    }
  }, []);

  if (!adapter) return <div className="empty">正在读取…</div>;

  /**
   * 那一行状态该说什么。三种情况按「先说更要紧的」排序：
   * 没装 → 装了但缺文件 → 装了但令牌是旧的 → 好了。
   *
   * `note` 单独一路（读不到 `%APPDATA%`）——它不是「缺文件」，
   * 合成一句话说会指向一个不存在的修法。
   */
  const addonLine = (() => {
    if (!addon) return { dot: "dot-warn", text: "正在读取…" };
    if (addon.note) return { dot: "dot-bad", text: `查不了：${addon.note}` };
    if (!addon.installed) {
      return { dot: "dot-warn", text: "还没装进 WPS" };
    }
    if (addon.filesMissing.length > 0) {
      return {
        dot: "dot-bad",
        text: `装着，但少了 ${addon.filesMissing.length} 个文件（${addon.filesMissing.join("、")}）`,
      };
    }
    if (addon.tokenStale) {
      return {
        dot: "dot-bad",
        text: "装着，但里面的令牌是旧的——重新装一次就好",
      };
    }
    return { dot: "dot-ok", text: "已经装好了" };
  })();

  return (
    <section className="page">
      <p className="eyebrow">精确字数适配器</p>
      <p className="sub">
        全局钩子只数得出<b>按键次数</b>，数不出「一次按键打出了几个字」——
        打「你好」要按六下。要知道确切字数，只能问应用自己。
      </p>

      <h2 className="sec">两个插件共用的</h2>
      <p className="sub">
        下面这两样是<b>接收端</b>的，不是某个插件的：两个插件填的是同一对值
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
            <b>重新生成之后，两个插件里的令牌都要跟着换</b>，否则会连不上，
            而连不上的表现是「字数一直是 0」——很容易被误读成「今天没写字」。
            WPS 那份点上面的「重新装一次」就行；Obsidian 那份要自己改。
          </p>
          {rotateError && (
            <p className="note">
              <b>没能重新生成：</b>
              {rotateError}。上面这个令牌<b>还是有效的</b>，插件不用改。
            </p>
          )}
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

      <h2 className="sec" style={{ marginTop: 52 }}>
        WPS
      </h2>
      <p className="sub">
        程序可以直接装进去——端口和令牌它本来就知道，不用你抄
      </p>

      <div className="item">
        <div className="h">
          <span className={`dot ${addonLine.dot}`} />
          {addonLine.text}
        </div>
        <div className="d">
          <div className="field-row">
            <button className="btn btn-sm" onClick={doInstall} disabled={installing}>
              {installing ? "正在装…" : addon?.installed ? "重新装一次" : "装进 WPS"}
            </button>
            <button className="btn btn-sm" onClick={openAddonDir}>
              打开加载项目录
            </button>
          </div>
          {installed && (
            <p className="field-hint" style={{ marginTop: 10 }}>
              装好了：<code>{installed.dir}</code>（{installed.files} 个文件）。
              WPS 的加载项清单是<b>{installed.publishAction}</b>——
              机器上别的加载项没有被挤掉。
            </p>
          )}
          {installed?.receiverDown && (
            <p className="note">
              <b>但接收端当时没起来</b>（42180–42189 全被占用），所以配置里填的是兜底的
              42180，可能连不上。先看上面那条状态，接收端起来之后重新装一次。
            </p>
          )}
          {installError && (
            <p className="note">
              <b>没能装进 WPS：</b>
              {installError}
            </p>
          )}
          <p className="field-hint" style={{ marginTop: 12 }}>
            <b>装完必须完全退出 WPS 再打开</b>——加载项只在 WPS 启动时加载一次，
            开着 WPS 装是看不到效果的。
          </p>
        </div>
      </div>

      <div className="item">
        <div className="h">功能区里没有 TypeStat 选项卡</div>
        <div className="d">
          <p style={{ margin: 0 }}>
            那说明 WPS 的 JS 加载项框架没被启用。唯一的路是在 WPS 安装目录的{" "}
            <code>office6\cfgs\oem.ini</code> 里加一行 <code>JsApiPlugin=true</code>。
          </p>
          <p className="note" style={{ marginTop: 10 }}>
            <b>这一条程序不替你做，是有意的。</b>
            那个 <code>oem.ini</code> 是 WPS 签名过的配置，改它有风险、还要管理员权限，
            而它属于 WPS 不属于 TypeStat——先备份，确认之后再动。
          </p>
          <p className="caption" style={{ marginTop: 10 }}>
            其余常见情况：横幅说「还没收到加载项的任何状态」是加载项没被加载；
            说「监听没挂上」在功能区点一次「重连监听」；
            打字计上了但删除计成新增，点一次「恢复自动校准」。
            完整对照表在 <code>wps-addon\README.md</code> 里——
            点下面的「存出插件文件」会把它一起存出来（从安装包装的机器上没有这个
            文件夹，仓库里那份才是它的出处）。
          </p>
        </div>
      </div>

      <h2 className="sec" style={{ marginTop: 52 }}>
        Obsidian
      </h2>
      <p className="sub">
        这个没法一键装：装到哪儿取决于<b>你的库在哪儿</b>，程序不知道那个路径
      </p>

      <div className="item">
        <div className="h">装到 Obsidian 里</div>
        <div className="d">
          <ol className="steps">
            <li>
              点下面的「存出插件文件」，拿到 <code>obsidian-plugin</code> 这个文件夹。
            </li>
            <li>
              把它整个复制到你的库目录下的 <code>.obsidian\plugins\typestat</code>
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

      <h2 className="sec" style={{ marginTop: 52 }}>
        存出插件文件
      </h2>
      <p className="sub">
        给不想让程序往 AppData 里写字的人，或者要装到另一台机器上
      </p>

      <div className="item">
        <div className="h">两份插件都存出来</div>
        <div className="d">
          <div className="field-row">
            <button className="btn btn-sm" onClick={doExport} disabled={exporting}>
              {exporting ? "正在存…" : "存出插件文件"}
            </button>
          </div>
          {exported && (
            <p className="field-hint" style={{ marginTop: 10 }}>
              存到了 <code>{exported.dir}</code>，一共 {exported.files.length} 个文件
              （<code>wps-addon</code> 与 <code>obsidian-plugin</code> 两份）。
            </p>
          )}
          {exportError && (
            <p className="note">
              <b>没能存出来：</b>
              {exportError}
            </p>
          )}
          <p className="field-hint" style={{ marginTop: 12 }}>
            {/* 说的是 **`config.example.js`**，不是 `config.js`——存出去的那一份里
                根本没有 `config.js`。写成后者的话，翻文件夹的人会找不到这个文件，
                而正确的下一步（复制模板）就在他那句话里被说反了。 */}
            手动装的话，把 <code>js\config.example.js</code> 复制成{" "}
            <code>js\config.js</code>，端口和令牌从上面那一节抄过去——
            <b>存出去的模板里没有真令牌</b>，真令牌不落在这个文件夹里。
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
