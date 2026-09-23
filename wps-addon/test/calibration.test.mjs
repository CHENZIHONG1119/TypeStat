/*
 * 在一个假的 WPS 环境里整份跑 reporter.js，验证字符数是怎么计出来的。
 *
 * 跑法（在 wps-addon 目录下）：node test/calibration.test.mjs
 *
 * 存在的理由：这套逻辑的正确性只取决于「字数怎么变、Range 给出什么字段」，
 * 而这两件事完全可以用假数据构造。不这么做就只能真机试错，一轮要重启一次 WPS，
 * 而且改了判据之后「上次那种情况现在还对不对」没法回归。
 *
 * 两套场景：
 *   主路（J 起）—— 字符数取 `doc.Characters.Count` 的逐次变化量。正常情况，
 *                   真机上跑的就是这条。J/K/L/M 都在防同一类错：把 Range 的长度当增量。
 *   兜底路（A–I）—— 读不到文档字数时退回 Range + 自动校准。用 `forceRangeMode()`
 *                   把加载项推到那条路上再验。
 *
 * 沙箱里有三个坑，改这个脚本时注意：
 *   1. `writeStatus` 有 500ms 节流，事件全在同一毫秒里发生的话，读到的永远是
 *      开头那份快照（看起来像"没学会"）。所以时钟必须是可控的。
 *   2. 假 `Characters.Count` 必须和喂进去的事件同步变化——它是主路的唯一地面真值，
 *      不动它就等于在测一段没有输入的代码。
 *   3. 主路一旦建立就**不会退回**：读不到只会跳过那一个事件。要测兜底路必须
 *      在开头连着喂 COUNT_FAIL_GIVEUP 次读不到，见 `forceRangeMode()`。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(
  process.argv[2] || new URL('../js/reporter.js', import.meta.url),
  'utf8'
);

// 沙箱里的事件全在同一毫秒内发生，会被 writeStatus 的 500ms 节流全挡掉，
// 于是快照一直是开头那份（active=true、计数全零），看起来像"没学会"。
// 所以给沙箱一个可控时钟，每次事件往前推 600ms。
let clockMs = 1e12;
const RealDate = Date;
const FakeDate = function (v) { return new RealDate(v === undefined ? clockMs : v); };
FakeDate.now = () => clockMs;

function boot(seed) {
  const store = new Map(Object.entries(seed || {}));
  const Application = {
    PluginStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
    },
    ApiEvent: { AddApiEventListener: () => {}, RemoveApiEventListener: () => {} },
  };
  const ctx = {
    window: { Application, addEventListener: () => {} },
    // 上报一律「成功」：主路攒够 FLUSH_THRESHOLD 就会真的发一批（粘贴一大段时必然触发），
    // 让 onload 静默不回来会把 inflight 卡住、后面的数字全堵在队列里。
    // 成功了正好——断言就能按「发出去的 + 还在队列里的」一起算。
    XMLHttpRequest: function () {
      this.open = () => {};
      this.setRequestHeader = () => {};
      this.send = () => { this.status = 200; if (this.onload) this.onload(); };
    },
    // 真机上由 js/config.js 定义（TypeStat 装加载项时生成）。沙箱里给个等价的。
    TYPESTAT_CONFIG: { app: 'wps.exe', port: 42180, token: 'test-token' },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
    Date: FakeDate, JSON, Math, String, Number, Array, Object, parseInt, parseFloat, isNaN, console,
  };
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);
  vm.runInContext(src, sandbox, { filename: 'reporter.js' });
  // 选主本来由每秒的 tick 触发；手工调一次，否则 isLeader 恒 false，快照不写
  ctx.TypeStatReporter.reconnect();
  return { ctx, store };
}
const snap = (ctx) => JSON.parse(ctx.window.Application.PluginStorage.getItem('typestat_status'));

let bad = 0;
function report(fails, title) {
  if (fails) { bad += fails; console.log(`  ⚠ ${title}：${fails} 项不符`); }
}

/*
 * ---------- 主路：字符数 = 文档字数的逐次变化量 ----------
 *
 * 这一节的每一个场景都在防同一件事：**把 Range 给的长度当成「这次改了多少」**。
 * 真机上就是这么错的——用户敲 4 个字，Range 报 11、13、14、15、16（整段的长度在长），
 * 同一分钟记了 109 个字符而按键只有 14 次。
 */
function countScenario(title, { steps, expect, note }) {
  const { ctx } = boot();
  let fails = 0;
  const ok = (cond, what) => {
    if (!cond) { fails++; console.log('  ✗ ' + what); } else console.log('  ✓ ' + what);
  };

  console.log(`\n=== ${title} ===`);
  if (note) console.log('  ' + note);

  // 每个 step 直接给出「这次事件之后文档有多少字」和「Range 报多长」，
  // 两者刻意解耦——主路只许看前者。
  for (const s of steps) {
    clockMs += 600;
    const doc = s.noCount ? { Name: 't.docx' }
                          : { Name: s.docName || 't.docx', Characters: { Count: s.count } };
    const len = s.len === undefined ? 1 : s.len;
    const span = s.span === undefined ? len : s.span;
    ctx.TypeStatReporter.handle(doc, { Text: 'x'.repeat(Math.max(0, len)), Start: 1000, End: 1000 + span }, s.type === undefined ? 0 : s.type);
  }

  const s = snap(ctx);
  console.log('  最近几条:', s.log.slice(-4).map((e) => `字数${e.count}→${e.verdict}`).join(' | '));
  // 攒够 FLUSH_THRESHOLD 就发出去了，所以「计了多少」要按发出去的 + 还在队列里的算。
  expect(ok, s, {
    input: s.sentInput + s.pendingInput,
    del: s.sentDelete + s.pendingDelete,
  });
  return fails;
}

// J：最小可用路径——敲字 +1、退格 −1，方向由字数涨跌定，跟 changeType 无关
report(countScenario('J  主路：打字 +1、退格 −1', {
  note: '故意把 changeType 全给成 0（真机上插入是 0、删除是 1）：主路不看它。',
  steps: [
    { count: 10, len: 5 },            // 基线
    { count: 11, len: 5, type: 0 },   // 打字（Range 报整段长度 5，不该采信）
    { count: 12, len: 6, type: 0 },   // 又打一个
    { count: 11, len: 6, type: 0 },   // 退格（类型故意还是 0）
  ],
  expect: (ok, s, sum) => {
    ok(s.countMode === 'counting', `走的是主路（countMode=${s.countMode}）`);
    ok(sum.input === 2, `新增 2 个字符（实际 ${sum.input}）`);
    ok(sum.del === 1, `删除 1 个字符（实际 ${sum.del}）`);
    // 关键：单次增量取的是字数变化量，不是 Range 的 5/6
    ok(s.maxIns === 1, `单次最大新增 = 1（不是 Range 的长度 5/6，实际 ${s.maxIns}）`);
  },
}), 'J');

// K：**真机复现** —— 输入法上屏，12 条事件里只有一条真正往文档里放了字
report(countScenario('K  真机复现：一串事件里只有一条真的动了字符', {
  note: 'Range 各报 11/13/14/15/16（整段在长），字数一直卡在 100，最后才跳到 104。',
  steps: [
    { count: 100, len: 10 },                                  // 基线
    { count: 100, len: 11 }, { count: 100, len: 13 },         // 组合输入：Range 在长、
    { count: 100, len: 14 }, { count: 100, len: 15 },         // 文档字数一个字没动
    { count: 100, len: 16 },
    { count: 104, len: 4 },                                   // 上屏：真放进 4 个字
  ],
  expect: (ok, s, sum) => {
    ok(sum.input === 4, `只记 4 个字符（老量法会记成 11+13+14+15+16+4=73，实际 ${sum.input}）`);
    ok(s.maxIns === 4, `单次最大新增 = 4（不是 16，实际 ${s.maxIns}）`);
    ok(s.ignored === 5, `5 条「字数没变」被忽略（实际 ${s.ignored}）`);
    ok(s.insert === 1, `只认了 1 条新增事件（实际 ${s.insert}）`);
  },
}), 'K');

// L：粘贴一大段——该大的时候就得大，别把正常的大改动也压掉
report(countScenario('L  粘贴一段：该大的时候要大', {
  steps: [
    { count: 0, len: 0 },              // 基线
    { count: 800, len: 800 },          // 粘 800 字
  ],
  expect: (ok, s, sum) => {
    ok(sum.input === 800, `新增 800 个字符（实际 ${sum.input}）`);
    ok(s.maxIns === 800, `单次最大新增 = 800（实际 ${s.maxIns}）`);
  },
}), 'L');

// M：切文档必须重建基线，否则会拿两个文档的字数相减，差出一个巨大的假数字
report(countScenario('M  切文档：重建基线，不产生巨大假删除', {
  steps: [
    { count: 500, docName: 'a.docx' },   // a 的基线
    { count: 501, docName: 'a.docx' },   // a 里打一个字
    { count: 5, docName: 'b.docx' },     // 切到只有 5 个字的 b
    { count: 6, docName: 'b.docx' },     // b 里打一个字
  ],
  expect: (ok, s, sum) => {
    ok(sum.del === 0, `没有凭空多出删除（实际 ${sum.del}）`);
    ok(sum.input === 2, `两个文档各记 1 个新增，共 2（实际 ${sum.input}）`);
    ok(s.log[s.log.length - 2].verdict.indexOf('建立基线') === 0,
       `切文档那一条记的是「建立基线」（实际「${s.log[s.log.length - 2].verdict}」）`);
  },
}), 'M');

/*
 * ---------- 兜底路：读不到文档字数时退回 Range + 自动校准 ----------
 *
 * 主路要靠 `doc.Characters.Count`。万一某个 WPS 版本给不出这个值（或者启动时
 * 一时读不到），就退回老路：靠自动校准反推哪个 changeType 是插入、靠 Range 量大小。
 * 老路在真机上已经被证明比不上主路（Range 给的不是增量），所以只作兜底。
 */
function forceRangeMode(ctx, mkDoc) {
  // 连着喂 COUNT_FAIL_GIVEUP 次「读不到字数」，加载项才会判定这条路走不通。
  for (let i = 0; i < 5; i++) {
    clockMs += 600;
    ctx.TypeStatReporter.handle(mkDoc(), { Text: '', Start: 0, End: 0 }, -1);
  }
  const s = snap(ctx);
  if (s.countMode !== 'unavailable') {
    throw new Error(`没能退回兜底路（countMode=${s.countMode}）——COUNT_FAIL_GIVEUP 改了吗？`);
  }
}

/**
 * `knownLimit` 的场景只打印结果、不计入失败。
 *
 * 标成「已知限制」而不是「失败」是有意的：一个永远红的测试就不再是信号了，
 * 下次真出问题时会淹在噪声里。这些场景记录的是**当前实现做不到什么**，
 * 以及要修它得往哪个方向走——见 E 的注释。
 */
function scenario(title, { lenOf, spanOf, insType, delType, knownLimit }) {
  const { ctx, store } = boot();
  let n = 0, fails = 0;
  let countReadable = false;   // 兜底路本身要靠 Range；校准还是要读字数才能定方向
  const mkDoc = () => ({ Name: 't.docx', Characters: countReadable ? { Count: n } : undefined });
  const step = (kind, type) => {
    clockMs += 600;
    n += kind === 'ins' ? 1 : -1;
    const len = lenOf(kind), span = spanOf(kind);
    ctx.TypeStatReporter.handle(
      mkDoc(),
      { Text: 'x'.repeat(Math.max(0, len)), Start: 1000, End: 1000 + span },
      type
    );
  };
  const ok = (cond, what) => {
    if (knownLimit) { console.log((cond ? '  ✓（已知限制内）' : '  ✗（已知限制内）') + what); return; }
    if (!cond) { fails++; console.log('  ✗ ' + what); } else console.log('  ✓ ' + what);
  };

  // 先退回兜底路。注意：第 5 次失败的那一条同时会被 observe() 当成第一个观察
  // （此时还读不到字数），所以后面 `observed` 从 1 起算。
  forceRangeMode(ctx, mkDoc);
  countReadable = true;

  step('ins', insType); step('ins', insType); step('ins', insType);
  step('del', delType); step('del', delType);

  const s = snap(ctx);
  console.log(`\n=== ${title} ===`);
  console.log('  证据:', s.learning.samples.join(' ; ') || '(空)');
  ok(!s.learning.active, '校准完成，不再处于校准中');
  ok(store.get('typestat_insert_types') === JSON.stringify([insType]),
     `学会插入 = ${insType}（实际 ${store.get('typestat_insert_types')}）`);
  ok(store.get('typestat_delete_types') === JSON.stringify([delType]),
     `学会删除 = ${delType}（实际 ${store.get('typestat_delete_types')}）`);
  console.log('  长度来源:', s.measurePref, `(len 对得上 ${s.learning.lenOk} 次 / span 对得上 ${s.learning.spanOk} 次)`);
  if (s.learning.active) { console.log('  → 没学会，跳过计数测试'); return fails; }

  // 学会之后：打一个字、按一次退格，看计了多少
  const b = { i: s.pendingInput, d: s.pendingDelete };
  step('ins', insType); step('del', delType);
  const s2 = snap(ctx);
  console.log('  最近两条:', s2.log.slice(-2).map(e => `类型${e.type}→${e.verdict}`).join(' | '));
  ok(s2.pendingInput - b.i === 1, `打字计入 1 个字符（实际 ${s2.pendingInput - b.i}）`);
  ok(s2.pendingDelete - b.d === 1, `退格计入 1 个字符（实际 ${s2.pendingDelete - b.d}）`);
  return fails;
}

// A：Text 里带段落标记（最可能的真机情况）——插入时 len=2、删除时 len=1，而字数只变 1
report(scenario('A  兜底路 · Text 带 \\r（len 比字数变化多 1）', {
  lenOf: (k) => (k === 'ins' ? 2 : 1), spanOf: () => 1, insType: 1, delType: 2 }), 'A');
// B：Text 就是受影响文本（理想情况，故意让 len 和 span 打平，验证打平时优先 len）
report(scenario('B  兜底路 · Text 就是受影响文本（理想）', {
  lenOf: () => 1, spanOf: () => 1, insType: 1, delType: 2 }), 'B');
// C：Text 给的是全文（len 恒定不变，偏差不是常数而是随文档增长）
report(scenario('C  兜底路 · Text 是全文（len 恒定不变）', {
  lenOf: () => 3, spanOf: () => 1, insType: 1, delType: 2 }), 'C');
// D：真机枚举值其实是别的数，且 Text 带 \r —— 验证学的是实际看到的类型值，不是 1/2
report(scenario('D  兜底路 · 枚举是 3/4 而非 1/2，Text 带 \\r', {
  lenOf: (k) => (k === 'ins' ? 2 : 1), spanOf: () => 1, insType: 3, delType: 4 }), 'D');
// F：**真机实测的那一组**（2026-09-23，用户读对话框「类型」列得到）：插入 = 0、删除 = 1。
// 这条必须留着：`0` 是假值，任何 `if (changeType)` 之类的写法都会把插入当成「没给类型」，
// 而且症状是「打字全不计、删除正常」，看起来像 WPS 没发事件。是最容易复发的一类 bug。
report(scenario('F  兜底路 · 真机实测：插入 = 0、删除 = 1（0 是假值）', {
  lenOf: (k) => (k === 'ins' ? 2 : 1), spanOf: () => 1, insType: 0, delType: 1 }), 'F');
// G：同上但 span 也和字数对得上（验证 0 在「len 胜出」那条路上也不出问题）
report(scenario('G  兜底路 · 真机实测 + len/span 都对得上', {
  lenOf: () => 1, spanOf: () => 1, insType: 0, delType: 1 }), 'G');
// E（已知限制）：End/Start 也取不到，只剩一个偏大的 Text。
// 这时没有任何字段能反映真实字数，长度无从还原——方向照样学对，大小会偏大。
// **主路已经解决了这个问题**（大小取自文档字数变化量），所以这条限制只在兜底路上成立。
report(scenario('E  兜底路 · span 取不到（-1），Text 带 \\r —— 已知限制', {
  lenOf: (k) => (k === 'ins' ? 2 : 1), spanOf: () => -1, insType: 1, delType: 2,
  knownLimit: true }), 'E');

/*
 * H：**手动设过的半残映射要能自愈。**
 *
 * 这是真机上出过的事：对话框的「翻转增删映射」只能把两个列表对调，
 * 而对调前的列表本身可能缺项（打字是类型 0、删除是类型 1 时，翻转得到
 * 插入=[2]、删除=[1]，删除对了、打字仍然谁也不认识），偏偏翻转还打上
 * `typestat_manual` 让自动校准跳过——一个只覆盖一半的映射就被永久冻结了。
 *
 * 期望：连续 3 次「改了文字却认不出类型」之后自行推翻，重新学会正确的 0/1。
 */
function staleMappingTest() {
  const { ctx, store } = boot({
    typestat_insert_types: '[2]', // 翻转后的样子：插入 = 2
    typestat_delete_types: '[1]',
    typestat_manual: '1',         // 而且是"人工设的"，按老规则不许自动改
  });
  let n = 0, fails = 0;
  let countReadable = false;
  const mkDoc = () => ({ Name: 't.docx', Characters: countReadable ? { Count: n } : undefined });
  const step = (kind, type) => {
    clockMs += 600;
    n += kind === 'ins' ? 1 : -1;
    ctx.TypeStatReporter.handle(
      mkDoc(),
      { Text: 'x'.repeat(kind === 'ins' ? 2 : 1), Start: 1000, End: 1001 },
      type
    );
  };
  const ok = (cond, what) => { if (!cond) { fails++; console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); };

  console.log('\n=== H  兜底路 · 手动设的半残映射能自愈 ===');
  console.log('  起始:', '插入=[2] 删除=[1] manual=1（删除能计、打字全漏）');

  forceRangeMode(ctx, mkDoc);
  countReadable = true;
  ok(JSON.parse(store.get('typestat_insert_types') || 'null')?.join() === '2',
     '确认起手就是那份半残映射');

  step('ins', 0); step('ins', 0); step('ins', 0);   // 三次认不出 → 应当触发重学
  const afterTrigger = snap(ctx);
  ok(store.get('typestat_manual') === '' || store.get('typestat_manual') === null,
     'manual 标记已被清掉（因为它承诺的前提被证伪了）');
  ok(afterTrigger.learning.active, '已经进入重新校准状态');
  console.log('  触发原因:', afterTrigger.learning.note);

  // 重学：第一次观察只建立基线、不投票，所以插入要给 3 次（1 基线 + 2 票）
  step('ins', 0); step('ins', 0); step('ins', 0);
  step('del', 1); step('del', 1);

  const s = snap(ctx);
  ok(store.get('typestat_insert_types') === '[0]', `学会了插入 = 0（实际 ${store.get('typestat_insert_types')}）`);
  ok(store.get('typestat_delete_types') === '[1]', `学会了删除 = 1（实际 ${store.get('typestat_delete_types')}）`);

  const b = { i: s.pendingInput, d: s.pendingDelete };
  step('ins', 0); step('del', 1);
  const s2 = snap(ctx);
  ok(s2.pendingInput - b.i === 1, `打字计入 1 个字符（实际 ${s2.pendingInput - b.i}）`);
  ok(s2.pendingDelete - b.d === 1, `退格计入 1 个字符（实际 ${s2.pendingDelete - b.d}）`);
  return fails;
}
report(staleMappingTest(), 'H');

/*
 * I：**交替改稿也要学得会。**
 *
 * 打一个字、退格、再打……这是写东西时的常见节奏，也曾经是校准的死角：
 * 早先的判据要求「同一方向连续两次」，而每次退格都会把插入的连续计数清零，
 * 于是永远学不会、12 个事件后放弃。现在改成按类型累计，这条必须过。
 */
report((() => {
  const { ctx, store } = boot();
  let n = 0, fails = 0;
  let countReadable = false;
  const mkDoc = () => ({ Name: 't.docx', Characters: countReadable ? { Count: n } : undefined });
  const step = (kind, type) => {
    clockMs += 600;
    n += kind === 'ins' ? 1 : -1;
    ctx.TypeStatReporter.handle(
      mkDoc(),
      { Text: 'x'.repeat(kind === 'ins' ? 2 : 1), Start: 1000, End: 1001 },
      type
    );
  };
  const ok = (cond, what) => { if (!cond) { fails++; console.log('  ✗ ' + what); } else console.log('  ✓ ' + what); };

  console.log('\n=== I  兜底路 · 交替改稿（打一个字→退格→打…）也能学会 ===');
  forceRangeMode(ctx, mkDoc);
  countReadable = true;
  step('ins', 0);                                              // 基线
  step('ins', 0); step('del', 1); step('ins', 0); step('del', 1);  // 交替

  const s = snap(ctx);
  console.log('  证据:', s.learning.samples.join(' ; '));
  ok(!s.learning.active, '校准完成');
  ok(store.get('typestat_insert_types') === '[0]', `学会插入 = 0（实际 ${store.get('typestat_insert_types')}）`);
  ok(store.get('typestat_delete_types') === '[1]', `学会删除 = 1（实际 ${store.get('typestat_delete_types')}）`);
  return fails;
})(), 'I');

console.log(bad === 0
  ? '\n通过（主路 J–M，兜底路 A–I；E 为已记录的已知限制）'
  : `\n有 ${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);
