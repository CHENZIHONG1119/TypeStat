/*
 * 把 WPS 加载项装到 WPS 的加载项目录里。
 *
 * 这个脚本做三件事，都是可重复执行的（改完 token 重跑一次就行）：
 *   1. 从 TypeStat 的数据库里读出接收端端口和令牌，写进 js/config.js
 *   2. 把加载项文件复制到 %APPDATA%\kingsoft\wps\jsaddons\TypeStat_1.0.0\
 *   3. 在 %APPDATA%\kingsoft\wps\jsaddons\publish.xml 里登记这个加载项
 *
 * 目录结构、publish.xml 的字段、以及 <名字>_<版本> 这个命名约定，
 * 都取自 WPS 官方脚手架（wpsjs 包的 src/lib/build.js 里的 CreateCopyBat /
 * CreatePublishXml），不是猜的。改动这里之前先回去核对那个文件。
 *
 * 装完要**重启 WPS**：加载项只在 WPS 启动时加载一次。
 *
 * 用法：node wps-addon/install.mjs
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'TypeStat';
const VERSION = '1.0.0';
const FOLDER = `${NAME}_${VERSION}`;

const here = dirname(fileURLToPath(import.meta.url));
const appData = process.env.APPDATA;
if (!appData) {
  console.error('读不到 %APPDATA%，这个脚本只能在 Windows 上跑。');
  process.exit(1);
}

const jsaddons = join(appData, 'kingsoft', 'wps', 'jsaddons');
const dest = join(jsaddons, FOLDER);

/** 要复制过去的文件/目录。install.mjs 自己和 README 不需要装进去。 */
const PAYLOAD = ['manifest.xml', 'ribbon.xml', 'index.html', 'main.js', 'js', 'ui'];

// ---------- 1. 从数据库读端口和令牌 ----------

const dbPath = join(appData, 'com.typestat.app', 'typestat.db');

/**
 * 只读打开数据库取设置。TypeStat 正开着也没关系——WAL 模式下读写可以并行。
 */
const settings = await (async () => {
  if (!existsSync(dbPath)) return null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT key, value FROM settings').all();
    db.close();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch (e) {
    console.warn(`读数据库失败（${e.message}），改用现有 js/config.js 里的值。`);
    return null;
  }
})();

// ---------- 2. 生成 js/config.js ----------

const configPath = join(here, 'js', 'config.js');
let port = 42180;
let token = '';

if (settings && settings.adapter_token) {
  port = Number(settings.adapter_port || 42180);
  token = settings.adapter_token;
} else {
  // 数据库读不到时，沿用上一次生成的 config.js，免得把 token 清空。
  const prev = readFileSync(configPath, 'utf8');
  const pm = prev.match(/port:\s*(\d+)/);
  const tm = prev.match(/token:\s*"([^"]*)"/);
  if (pm) port = Number(pm[1]);
  if (tm) token = tm[1];
  if (!token) {
    console.error('既读不到数据库，现有 config.js 里也没有令牌。先启动一次 TypeStat 再装。');
    process.exit(1);
  }
}

writeFileSync(
  configPath,
  `/*
 * TypeStat 上报配置。
 *
 * 这个文件由 wps-addon/install.mjs 自动生成（端口和令牌从 TypeStat 的数据库里读）。
 * 手改也行，但改完必须重启 WPS 才生效——加载项页面只在 WPS 启动时加载一次。
 * 重新生成令牌后要重跑 install.mjs，否则上报会被拒（HTTP 401）。
 */
var TYPESTAT_CONFIG = {
  // TypeStat 本地接收端监听的端口。
  port: ${port},

  // 接收端令牌。TypeStat「设置」页可以看到和重新生成。
  token: "${token}",

  /*
   * 上报时用的应用名。
   *
   * 必须和键盘钩子看到的进程名一致，否则同一个 WPS 会被拆成两行统计
   * （一行只有按键数，一行只有字数）。本机上 WPS 文字的进程名实测是 wps.exe。
   * 接收端会自己补 .exe 后缀并做清洗，这里写成 "wps" 也行。
   */
  app: "wps.exe",
};
`,
  'utf8'
);

console.log(`已写入 js/config.js（端口 ${port}，令牌 ${token.slice(0, 8)}…）`);

// ---------- 3. 复制文件 ----------

mkdirSync(jsaddons, { recursive: true });
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

for (const item of PAYLOAD) {
  const src = join(here, item);
  if (!existsSync(src)) {
    console.error(`缺少 ${item}，安装中止。`);
    process.exit(1);
  }
  cpSync(src, join(dest, item), { recursive: true });
}
console.log(`已复制加载项到 ${dest}`);

// ---------- 4. 登记 publish.xml ----------

const publishPath = join(jsaddons, 'publish.xml');
const entry = `            <jsplugin name="${NAME}" type="wps" url="${FOLDER}" version="${VERSION}" enable="enable_dev" install="null" customDomain=""/>`;

/**
 * 合并而不是覆盖：机器上以后可能还装着别的加载项，
 * 直接把 publish.xml 写成只有我这一条会把别人登记的东西一并抹掉。
 */
function upsertPublish() {
  let xml = existsSync(publishPath) ? readFileSync(publishPath, 'utf8') : '';

  if (!xml.includes('<jsplugins')) {
    writeFileSync(publishPath, `<jsplugins>\n${entry}\n</jsplugins>\n`, 'utf8');
    return '新建';
  }

  // 已经有同名的条目：整条替换掉（版本号或 url 可能变了）。
  const re = new RegExp(`[^\\S\\n]*<jsplugin\\b[^>]*name="${NAME}"[^>]*/>`, 'g');
  if (re.test(xml)) {
    xml = xml.replace(re, entry);
    writeFileSync(publishPath, xml, 'utf8');
    return '更新已有条目';
  }

  if (!xml.includes('</jsplugins>')) {
    console.error('publish.xml 里没有 </jsplugins>，格式不认识，没有动它。');
    process.exit(1);
  }
  xml = xml.replace('</jsplugins>', `${entry}\n</jsplugins>`);
  writeFileSync(publishPath, xml, 'utf8');
  return '追加';
}

console.log(`publish.xml：${upsertPublish()}（${publishPath}）`);

console.log(`
装好了。接下来：

  1. 完全退出 WPS 再重新打开（加载项只在启动时加载一次）
  2. 新建或打开一个文档，看功能区有没有多出一个「TypeStat」选项卡
  3. 点「统计状态」，里面应该能看到心跳和事件计数
  4. 按几次退格，看「最近事件」里那几条记成的是「新增」还是「删除」——
     按退格应该是删除，记反了就点对话框里的翻转
  5. 再去 TypeStat 的今日看板，WPS 的精确字数应该出现了

如果功能区没有「TypeStat」选项卡，说明 JS 加载项框架没被启用。
这种情况下需要改 WPS 安装目录里的 oem.ini（加 JsApiPlugin=true），
那是唯一一处需要动 WPS 安装目录的操作，先确认后再说。
`);
