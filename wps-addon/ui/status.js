/*
 * 「统计状态」对话框。
 *
 * 这个页面和加载项入口页是两个**不同的网页文档**，内存不共享，
 * 拿不到 TypeStatReporter 这个对象。两边唯一的通道是 Application.PluginStorage：
 * 入口页每秒往里面写一份状态快照，这里每秒读一次。
 *
 * 所以这里不需要（也不能）加载 reporter.js——那样会在这个文档里造出第二个
 * 上报器实例，是纯粹的混乱来源。
 */

/** 快照超过这个年龄就认为入口页已经不在跑了。入口页每秒写一次。 */
var STALE_MS = 5000;

/**
 * 「单次改动最多几个字」超过这个数就标红。
 *
 * 正常一次改动的上限取决于行为：敲一个汉字是 1，粘一大段可能是几千。
 * 这里要抓的不是「大」而是「**不该大却大**」——如果每敲一个字这个数都在涨、
 * 涨到几十上百，说明拿到的是整段甚至整篇文本的长度，而不是这次改动的增量。
 */
var MAX_SANE_ONE_SHOT = 10;

var K_STATUS = 'typestat_status';
var K_INSERT_TYPES = 'typestat_insert_types';
var K_DELETE_TYPES = 'typestat_delete_types';

/** 用户手动校准过的标记。写上去之后加载项就不再自动校准了——人的判断优先。 */
var K_MANUAL = 'typestat_manual';

/** 「已经自动校准过一次」的标记。清掉它才能重新学。 */
var K_LEARNED = 'typestat_learned';

/** 「请重新自动校准」的请求标记，由加载项入口页消费。 */
var K_RECALIBRATE = 'typestat_recalibrate';

function storage() {
  try {
    var a = window.Application;
    return a && a.PluginStorage ? a.PluginStorage : null;
  } catch (e) {
    return null;
  }
}

function getItem(key) {
  var s = storage();
  if (!s) return null;
  try {
    return s.getItem(key);
  } catch (e) {
    return null;
  }
}

function setItem(key, value) {
  var s = storage();
  if (!s) return false;
  try {
    s.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function readSnapshot() {
  var raw = getItem(K_STATUS);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function num(n) {
  return (n || 0).toLocaleString('en-US');
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function ago(ms) {
  if (!ms) return '—';
  var d = Date.now() - ms;
  if (d < 0) d = 0;
  if (d < 1000) return '刚刚';
  if (d < 60000) return Math.round(d / 1000) + ' 秒前';
  if (d < 3600000) return Math.round(d / 60000) + ' 分钟前';
  return Math.round(d / 3600000) + ' 小时前';
}

// ---------- 渲染 ----------

function renderAlive(snap) {
  var el = document.getElementById('alive');
  el.className = 'banner';

  if (!snap) {
    el.className = 'banner bad';
    el.innerHTML =
      '还没收到加载项的任何状态。<br>' +
      '说明入口页没跑起来——要么加载项没被 WPS 加载，要么 reporter.js 没执行到。<br>' +
      '先点功能区的「重连监听」，再不行就重启 WPS。';
    return;
  }

  var age = Date.now() - (snap.at || 0);
  if (age > STALE_MS) {
    el.className = 'banner bad';
    el.innerHTML =
      '加载项<b>曾经</b>在跑，但快照停在 ' +
      ago(snap.at) +
      '——入口页可能已经被 WPS 关掉了，现在收到的改动没人在统计。<br>' +
      '点功能区的「重连监听」可以重新挂上。';
    return;
  }

  if (!snap.registered) {
    // 心跳在但没挂上监听：这时事件计数会一直是 0，看起来像「WPS 没发事件」，
    // 得说清楚是加载项自己没挂上，而不是 WPS 没事件可发。
    el.className = 'banner bad';
    el.innerHTML =
      '加载项在跑，但<b>ContentChange 监听没挂上</b>，收到的改动不会被统计。<br>' +
      '多半是 window.Application 还没就绪。点功能区的「重连监听」再试；不行就重启 WPS。';
    return;
  }

  el.className = 'banner good';
  el.innerHTML =
    '监听中。上次心跳 ' +
    ago(snap.at) +
    '，本次 WPS 进程内已启动 ' +
    ago(snap.startedAt) +
    '。';
}

/** 毫秒数，保留两位小数——读一次字数通常是零点几毫秒，整数位看不出差别。 */
function ms(v) {
  if (!v) return '0';
  return (Math.round(v * 100) / 100).toString();
}

/**
 * 「字符数是拿什么量出来的」。
 *
 * 这是现在最要紧的一个状态，所以要占一行、要显眼：正常情况下是
 * `Characters.Count` 的逐次变化量；退回老路（读不到字数）时数字会明显变差，
 * 用户看到数字不对时第一眼该看的就是这一行。
 */
function modeLabel(snap) {
  if (snap.countMode === 'counting') return '按文档字数的变化量（正常）';
  if (snap.countMode === 'unavailable') return '读不到文档字数，退回 Range + 自动校准';
  return '还没量过（下一个改动时定夺）';
}

/**
 * 计数面板。
 *
 * **单位必须写出来**（条 / 个）：上面几行是「事件条数」，下面几行才是「字符个数」。
 * 不写单位会被读成同一个东西——真机上就发生过：用户看到「其中计入字符数」涨得
 * 跟拼音按键一样多，以为字数统计按拼音算了。其实那一行是事件**条数**，
 * 拼音上屏时一次改动可能触发多条事件，条数和字数本来就不是一回事。
 */
function renderCounters(snap) {
  // 读一次字数超过这个毫秒数就认为偏慢，值得标出来。
  // 主路每个改动都要读一次，真慢起来会直接拖累打字。
  var SLOW_READ_MS = 20;

  var rows = [
    ['收到的 ContentChange 事件（条）', num(snap.events), ''],
    ['其中计上的事件（条）', num(snap.counted), ''],
    ['忽略的事件（条，改样式等不动字符的改动）', num(snap.ignored), ''],
    ['新增事件 / 删除事件（条）', num(snap.insert) + ' / ' + num(snap.delete), ''],
    ['字符数的量法', modeLabel(snap), snap.countMode === 'unavailable' ? 'del' : ''],
    [
      '读文档字数的耗时（平均 / 最大，毫秒）',
      ms(snap.countMsAvg) + ' / ' + ms(snap.countMsMax),
      snap.countMsMax > SLOW_READ_MS ? 'del' : '',
    ],
    [
      '单次最大新增 / 删除（个）',
      num(snap.maxIns) + ' / ' + num(snap.maxDelete),
      // 一次改动最多几个字。**这是「数字虚高」最直接的哨兵**：总数虚高时
      // 看着甚至更「好看」，但「敲一个字单次最大却是 200」一眼就是错的。
      // 正常值：敲字 1，上屏一个词 2–4，粘一段才会很大。
      snap.maxIns > MAX_SANE_ONE_SHOT ? 'del' : '',
    ],
    ['已上报新增字符数（个）', num(snap.sentInput), 'ins'],
    ['已上报删除字符数（个）', num(snap.sentDelete), 'del'],
    ['待上报字符数（个）', num(snap.pendingInput) + ' / ' + num(snap.pendingDelete), ''],
    ['上报成功 / 失败批次', num(snap.ok) + ' / ' + num(snap.fail), snap.fail > 0 ? 'del' : ''],
    ['上次成功上报', snap.lastOkAt ? ago(snap.lastOkAt) : '从未', ''],
    // 选主是不是在反复横跳。**这是「同一份改动被上报好几遍」的头号嫌疑**：
    // 每次换 leader 都可能让新 leader 从零开始建基线、把老 leader 已经报过的
    // 那一截再报一遍。正常情况下整个 WPS 进程活一次只该有 1 次（最多 2 次）。
    [
      '选主次数 / 让位次数',
      num(snap.leaderEpoch) + ' / ' + num(snap.standDowns),
      snap.leaderEpoch > 5 ? 'del' : '',
    ],
  ];

  if (snap.countFails > 0) {
    // 读不到字数是真丢数据（那些事件被跳过了），不能悄悄发生。
    rows.push(['跳过的「读不到字数」事件（条）', num(snap.countFails), 'del']);
  }

  if (snap.drops > 0) {
    // 丢弃是真实的数据缺口，必须显式说出来，不能让它悄悄发生。
    rows.push([
      '已丢弃的字符数',
      num(snap.drops),
      'del',
    ]);
  }

  var html = '';
  for (var i = 0; i < rows.length; i++) {
    html +=
      '<tr><td>' +
      esc(rows[i][0]) +
      '</td><td class="num ' +
      rows[i][2] +
      '">' +
      esc(rows[i][1]) +
      '</td></tr>';
  }
  if (snap.lastError) {
    html +=
      '<tr><td>最近一次错误</td><td class="del">' +
      esc(snap.lastError) +
      '（' +
      ago(snap.lastErrorAt) +
      '）</td></tr>';
  }
  document.getElementById('counters').innerHTML = html;
}

/**
 * 自动校准的状态。
 *
 * 这一段要有，因为「校准中」时一个字符都不计——不明说的话，用户看到
 * 事件在涨、字数不动，会以为又坏了。这里要讲清楚「这是故意的，再打两个字就好」。
 *
 * 下面那张「校准证据」表是校准失败时唯一的线索来源：判据只看字数涨跌，
 * len/span 不参与判定、只作证据，所以「为什么没学会」全都在这几行里。
 */
function renderLearn(snap) {
  var el = document.getElementById('learnBox');
  var l = snap.learning;
  if (!l) {
    el.className = 'banner';
    el.innerHTML = '这条快照来自旧版加载项，没有校准信息。重启 WPS 后即可看到。';
    return;
  }

  // 主路：字符数取自文档字数的变化量，压根没有「方向认不认得出来」这回事，
  // 所以校准这一整段都不适用。这里必须明确说「不需要」，否则用户会去找
  // 那个根本不存在的校准状态。
  if (snap.countMode === 'counting') {
    el.className = 'banner good';
    el.innerHTML =
      '<b>不需要校准。</b>字符数直接取<b>文档字数的变化量</b>，' +
      '增删方向也由字数的涨跌决定——跟 WPS 的枚举值等于几无关，' +
      '所以下面那两个按钮在主路上不起作用。';
    return;
  }
  if (snap.countMode === 'unknown') {
    el.className = 'banner';
    el.innerHTML = '还没量过：下一个改动会定夺走哪条路（首选「按文档字数的变化量」）。';
    return;
  }

  // 以下是兜底老路（读不到文档字数）：靠映射认方向、靠 Range 量大小，
  // 校准这一段才重新变成主角。
  var ev = renderSamples(l, snap);

  if (l.active) {
    el.className = 'banner bad';
    el.innerHTML =
      '<b>正在自动校准，此时不计字数（故意的）。</b><br>' +
      '请回到文档：<b>打两个字，再按两次退格</b>。' +
      '加载项会看「文档字数涨了还是跌了」来反推哪个类型值是插入、哪个是删除，' +
      '不需要知道 WPS 内部枚举的数值。<br>' +
      '已观察 ' +
      esc(l.observed) +
      ' 个事件。' +
      ev;
    return;
  }

  // 长度来源一个都没和字数变化量对上 = 方向对了但大小没人能证实。
  // 这种情况必须标红，不能给绿色的「已校准」——数字会看着正常但是错的。
  var unverified = l.lenOk === 0 && l.spanOk === 0 && !l.active;
  el.className = unverified ? 'banner bad' : 'banner good';
  el.innerHTML = esc(l.note) + '。' + ev;
  if (!l.countOk) {
    // 读不到字数 = 唯一的地面真值没了，只能人工介入。这一支必须说清楚。
    el.className = 'banner bad';
    el.innerHTML +=
      '<br>读不到文档字数（<code>doc.Characters.Count</code> 不可用），' +
      '自动校准无从判断方向，只能靠人工指定：请按一次退格，看下面「最近事件」里' +
      '那一条被记成什么，再用下面的翻转按钮改正。';
  }
}

/**
 * 校准证据。
 *
 * 每一行是「这个 changeType 让字数涨/跌了几个（而 Range 说 len 是多少、span 是多少）」。
 * 两件事一眼可查：
 *   - 字数涨跌和 len/span 对不对得上——对不上就说明 len 不是增量
 *     （比如 Text 里带了段落标记），那就该改用 span
 *   - span 是不是 0 或负数——如果是，说明 Range 根本没给范围，只剩 len 可用
 */
function renderSamples(l, snap) {
  var rows = l.samples || [];
  if (!rows.length) return '';

  var html = '<div class="samples"><b>校准证据</b>';
  html +=
    '<div class="hint">「len 对得上 ' +
    esc(l.lenOk) +
    ' 次 / span 对得上 ' +
    esc(l.spanOk) +
    ' 次」——学完按比分挑长度来源。当前用的是 <code>' +
    esc(snap.measurePref === 'span' ? 'Range.End − Range.Start' : 'Range.Text.length') +
    '</code>。</div><ol>';
  for (var i = 0; i < rows.length; i++) {
    html += '<li>' + esc(rows[i]) + '</li>';
  }
  html += '</ol></div>';
  return html;
}

function renderMap(snap) {
  document.getElementById('mapHint').innerHTML =
    '插入类型 = <code>' +
    esc(JSON.stringify(snap.insertTypes)) +
    '</code>，删除类型 = <code>' +
    esc(JSON.stringify(snap.deleteTypes)) +
    '</code>。' +
    (snap.counted === 0 && !(snap.learning && snap.learning.active)
      ? '<br><b class="err">还没有任何改动被计入过。</b>如果「收到的 ContentChange 事件」在涨、这里一直是 0，' +
        '说明 changeType 的实际取值不在上面这两个列表里——把「最近事件」里显示的原始类型值记下来，' +
        '填进 js/config.js 的 DEFAULT_INSERT_TYPES / DEFAULT_DELETE_TYPES，' +
        '或者用下面的翻转按钮人工指定。'
      : '');
}

function renderEvents(snap) {
  var body = document.querySelector('#events tbody');
  var list = (snap.log || []).slice().reverse(); // 最新的在最上面
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="7" class="hint">还没有事件。去文档里敲几个字。</td></tr>';
    return;
  }
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var cls = 'ign';
    if (e.verdict.indexOf('新增') === 0) cls = 'ins';
    else if (e.verdict.indexOf('删除') === 0) cls = 'del';

    // 长度和跨度对不上时，跨度这一格报「≠」并标红。取不到（老快照或接口没给）
    // 就留空——不能默默显示成 0，那会让人以为跨度真的是 0。
    var spanCell = '<span class="muted">—</span>';
    if (typeof e.span === 'number' && e.span >= 0) {
      spanCell =
        e.span === e.len
          ? String(e.span)
          : '<span class="del">≠ ' + esc(e.span) + '</span>';
    }

    // 文档字数。**这一列才是被计入的那个数**——计数用的是它和上一条的差，
    // 所以它旁边的「判定」里那个 +N / −N 应当等于它减去上一行。
    // 读不到（-1 或老快照没有这个字段）就留空，不能显示成 0。
    var countCell = '<span class="muted">—</span>';
    if (typeof e.count === 'number' && e.count >= 0) {
      var cCls = e.delta > 0 ? 'ins' : e.delta < 0 ? 'del' : 'ign';
      countCell = '<span class="' + cCls + '">' + esc(e.count) + '</span>';
    }

    // 文档名。基线是按它重建的，所以这一列一变就该看到「建立基线」，
    // 看不到就说明名字读不出来（或两个文档同名），基线会串。
    var docCell = e.doc
      ? '<span class="docname">' + esc(e.doc) + '</span>'
      : '<span class="del">（空）</span>';

    html +=
      '<tr><td>' +
      esc(e.clock) +
      '</td><td class="num">' +
      esc(e.type) +
      '</td><td class="num">' +
      esc(e.len) +
      '</td><td class="num">' +
      spanCell +
      '</td><td class="num">' +
      countCell +
      '</td><td>' +
      docCell +
      '</td><td class="' +
      cls +
      '">' +
      esc(e.verdict) +
      '</td></tr>';
  }
  body.innerHTML = html;
}

/**
 * 本次会话每分钟已上报。
 *
 * **这张表唯一的用途是和 TypeStat 数据库对账。** 两边同一分钟的数应该相等；
 * 如果库里明显更大、而且大致是这里的整数倍，说明有别的加载项实例也在往
 * 同一个接收端上报——库里的数就成了「真数 × 实例数」，而这里显示的才是
 * 这一次会话真正发出去的。这就把「量法错了」和「重复上报」区分开了。
 *
 * 表里只有 leader 写进来的数（非 leader 不收事件），所以它天然就是
 * 「这一个实例发了多少」。
 */
function renderByMinute(snap) {
  var el = document.getElementById('byMinute');
  var rows = snap.byMinute || [];
  if (!rows.length) {
    el.innerHTML =
      '<tr><td class="hint">还没有成功上报过的分钟。' +
      '（上报是攒够一批才发一次，刚敲几个字可能还没到。）</td></tr>';
    return;
  }

  var html =
    '<thead><tr><th>分钟</th><th class="num">新增（个）</th>' +
    '<th class="num">删除（个）</th><th class="num">批次数</th></tr></thead><tbody>';
  var ti = 0;
  var td = 0;
  var tn = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    ti += r.i || 0;
    td += r.d || 0;
    tn += r.n || 0;
    html +=
      '<tr><td class="num">' +
      esc(r.m) +
      '</td><td class="num ins">' +
      num(r.i) +
      '</td><td class="num del">' +
      num(r.d) +
      '</td><td class="num">' +
      num(r.n) +
      '</td></tr>';
  }
  html +=
    '<tr><td>合计（最近 ' +
    esc(rows.length) +
    ' 分钟）</td><td class="num ins">' +
    num(ti) +
    '</td><td class="num del">' +
    num(td) +
    '</td><td class="num">' +
    num(tn) +
    '</td></tr></tbody>';
  el.innerHTML = html;
}

function render() {
  var snap = readSnapshot();
  renderAlive(snap);
  if (!snap) {
    document.getElementById('counters').innerHTML = '';
    document.getElementById('mapHint').innerHTML = '';
    document.getElementById('learnBox').innerHTML = '';
    document.querySelector('#events tbody').innerHTML = '';
    renderByMinute({});
    return;
  }
  renderCounters(snap);
  renderLearn(snap);
  renderMap(snap);
  renderEvents(snap);
  renderByMinute(snap);
}

// ---------- 动作 ----------

/**
 * 翻转增删映射。
 *
 * 直接改 PluginStorage 里的那两个键——入口页每秒会同步一次，
 * 所以这里写完一秒内就会生效（入口页的 reloadTypes）。
 */
function flip() {
  var snap = readSnapshot();
  if (!snap) {
    document.getElementById('flipMsg').className = 'err';
    document.getElementById('flipMsg').textContent = '读不到状态，先让加载项跑起来。';
    return;
  }
  var ins = snap.insertTypes || [];
  var del = snap.deleteTypes || [];
  if (ins.length === 0 && del.length === 0) {
    document.getElementById('flipMsg').className = 'err';
    document.getElementById('flipMsg').textContent = '两个列表都是空的，没法翻。';
    return;
  }
  var ok1 = setItem(K_INSERT_TYPES, JSON.stringify(del));
  var ok2 = setItem(K_DELETE_TYPES, JSON.stringify(ins));
  // 打上「人工指定」标记：加载项看到它就不再自动校准了。否则下一次 WPS 重启时
  // 自动校准会把这里的判断覆盖掉，用户会以为自己的修正"失效了"。
  var ok3 = setItem(K_MANUAL, '1');
  var msg = document.getElementById('flipMsg');
  if (ok1 && ok2 && ok3) {
    msg.className = 'ok';
    msg.textContent =
      '已手动指定：' +
      JSON.stringify(del) +
      ' 算新增、' +
      JSON.stringify(ins) +
      ' 算删除。一秒内生效，再按一次退格看看。手动指定后不再自动校准。';
  } else {
    msg.className = 'err';
    msg.textContent = '写入失败。';
  }
}

/**
 * 恢复自动校准。
 *
 * 这里只把三个标记写进 PluginStorage 就返回了——真正的重置动作在加载项入口页
 * 里（它才是持有校准状态的地方），入口页每秒的 tick 会看到这个请求并执行。
 * 两个文档之间只能这样传话。
 */
function recalibrate() {
  setItem(K_MANUAL, '');
  setItem(K_LEARNED, '');
  setItem(K_RECALIBRATE, '1');
  var msg = document.getElementById('flipMsg');
  msg.className = 'ok';
  msg.textContent =
    '已请求重新自动校准。回到文档打两个字、再按两次退格，' +
    '这里会重新显示「正在自动校准」。';
}

function test() {
  var msg = document.getElementById('testMsg');
  msg.className = '';
  msg.textContent = '测试中…';

  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'http://127.0.0.1:' + TYPESTAT_CONFIG.port + '/report', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('x-typestat-token', TYPESTAT_CONFIG.token);
  xhr.timeout = 3000;
  xhr.onload = function () {
    if (xhr.status === 200) {
      msg.className = 'ok';
      msg.textContent = '通。接收端在线，令牌有效。（空上报不会写进统计）';
    } else if (xhr.status === 401) {
      msg.className = 'err';
      msg.textContent =
        '令牌不对。TypeStat「适配器」页重新生成过令牌的话，' +
        '在那里点一下「重新装一次」，再重启 WPS。';
    } else if (xhr.status === 400) {
      msg.className = 'err';
      msg.textContent = '数据被拒（HTTP 400）。检查 js/config.js 里的 app 名是不是合法。';
    } else {
      msg.className = 'err';
      msg.textContent = 'HTTP ' + xhr.status;
    }
  };
  xhr.onerror = function () {
    msg.className = 'err';
    msg.textContent = '连不上 127.0.0.1:' + TYPESTAT_CONFIG.port + '。TypeStat 是不是没在跑？';
  };
  xhr.ontimeout = function () {
    msg.className = 'err';
    msg.textContent = '超时。';
  };
  xhr.send(JSON.stringify({ app: TYPESTAT_CONFIG.app, input: 0, delete: 0 }));
}
