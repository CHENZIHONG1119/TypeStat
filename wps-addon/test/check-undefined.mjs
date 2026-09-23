/*
 * 找出「被调用但从未定义」的函数名。
 *
 * 跑法（在 wps-addon 目录下）：node test/check-undefined.mjs
 *
 * 存在的理由：`commitLearning()` 里调了 `writeTypes()`，而它从来没被定义过，
 * 一直是个 `ReferenceError`——因为那条分支在修好校准之前从没被执行到，
 * 所以既没报错也没人发现。这个脚本几秒钟就能把这一类洞全扫出来，
 * 在 WPS 里试出来的代价是一轮重启。
 *
 * 这是个启发式扫描（正则找 `名字(`），只用来兜底，不代替真跑一次。
 * `XMLHttpRequest` 这类浏览器全局会出现在结果里，属于正常噪声。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const targets = process.argv.slice(2);
if (!targets.length) {
  targets.push(
    new URL('../js/reporter.js', import.meta.url),
    new URL('../js/ribbon.js', import.meta.url),
    new URL('../ui/status.js', import.meta.url)
  );
}

// 已定义的函数/变量名
// 浏览器/宿主提供的全局。往这里加之前先想一下：它真的是全局，
// 还是「我以为它存在、其实这个项目里根本没有」——后者正是这个脚本要找的洞。
const globals = new Set(['JSON','Math','Date','String','Number','Boolean','Array','Object','parseInt','parseFloat','isNaN','Error','RegExp','encodeURI','encodeURIComponent','decodeURI','decodeURIComponent','setTimeout','clearTimeout','setInterval','clearInterval','require','Promise','Map','Set','console','XMLHttpRequest','alert','confirm','prompt']);

const KEYWORDS = /^(if|for|while|switch|catch|return|typeof|new|function|else|do|try|delete|void|in|of|case)$/;

let found = 0;

for (const target of targets) {
  // 命令行给的是普通路径，默认值给的是 file:// URL——两种都要吃得下
  const path = target instanceof URL ? fileURLToPath(target) : String(target);
  const src = fs.readFileSync(path, 'utf8');

  // 注释里的文字会被正则误当成代码（"这里**没有** flip()" 就会被扫出来），
  // 所以先把注释和字符串挖掉再扫。挖成等长空白，行号才不会跑掉。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => m.replace(/[^\n]/g, ' '));

  const defined = new Set();
  for (const m of code.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/g)) {
    if (m[1]) defined.add(m[1]);
    if (m[2]) defined.add(m[2]);
  }
  // 形参也算已定义（只为少报噪声，参数本身不会是全局函数）
  for (const m of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    for (const p of m[1].split(',')) { const t = p.trim(); if (t) defined.add(t); }
  }

  const bad = new Map();
  // 调用点：名字后面跟 (，且前面不是 .（排除方法调用）
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (defined.has(name) || globals.has(name) || KEYWORDS.test(name)) continue;
    const line = code.slice(0, m.index).split('\n').length;
    if (!bad.has(name)) bad.set(name, []);
    bad.get(name).push(line);
  }

  console.log(`--- ${path.replace(/^.*[\\/]/, '')} ---`);
  if (!bad.size) console.log('  没有未定义的调用');
  for (const [name, lines] of bad) {
    console.log(`  未定义: ${name}  行 ${lines.join(', ')}`);
    found += lines.length;
  }
}

process.exit(found ? 1 : 0);
