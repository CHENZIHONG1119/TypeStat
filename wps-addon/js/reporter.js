/*
 * TypeStat 字数上报器 —— WPS 文字（Writer）加载项
 *
 * 为什么需要加载项：全局键盘钩子只数得出「按了多少次键」，数不出「打了几个字」。
 * 拼音打一个汉字在钩子看来可能是 5 次按键（逐个敲）也可能是 1 次（整句上屏），
 * 钩子无从区分。只有 WPS 自己知道这次改动往文档里塞进去了几个字符。
 *
 * 隐私边界（硬约束，改代码时不要破）：
 *   - 只上报两个整数：新增字符数、删除字符数。
 *   - Range.Text 只在内存里取一次 .length，随即丢弃；不存、不传、不落盘。
 *   - 诊断日志里记的是 changeType 和长度，**不记正文内容**。
 *
 * 数据来源：`ApiEvent` 的 `ContentChange` 事件，签名见官方声明文件
 * addon.wps.d.ts：`(Document, Range, changeType: number) => void`。
 * Range 上直接有 Text/Start/End，所以每次改动都能拿到受影响文本的长度，
 * 不需要去读整个文档——这一点很关键，读全文在大文档上会卡。
 */
var TypeStatReporter = (function () {
  'use strict';

  /**
   * 注册用的函数名。必须与下面的全局函数同名。
   *
   * 用「名字」而不是函数对象来注册，是为了能按名字精确移除：
   * 加载项页面被 WPS 重新加载后，旧的注册可能还挂在 ApiEvent 上，
   * 直接再 Add 一次会让同一次改动被上报两遍（字数翻倍，而且不易察觉）。
   * 所以注册前一律先 Remove。
   */
  var HANDLER_NAME = 'TypeStatOnContentChange';

  /** PluginStorage 的键。加载项入口页和对话框页是两个文档，内存不共享，只能靠它传。 */
  var K_STATUS = 'typestat_status';
  var K_INSERT_TYPES = 'typestat_insert_types';
  var K_DELETE_TYPES = 'typestat_delete_types';

  /**
   * WdContentChangeType 里哪几个值代表「插入」、哪几个代表「删除」。
   *
   * 官方 .d.ts 没有导出这两个值（枚举名在 `wpsapiex.dll` 的字符串表里，
   * 数值在 typeinfo 里、按字符串偏移取不到），所以**不要靠"按声明顺序推"**——
   * 推过两次都错了：先猜 1/2，真机上是 0/1。
   *
   * 这里的默认值来自**真机实测**（2026-09-23，用户读诊断对话框的「类型」列得到）：
   * `插入 = 0`、`删除 = 1`。它只在自动校准失败时兜底，正常路径是自动校准结果。
   *
   * 注意 `0` 是假值：任何对 changeType 本身做 `if (changeType)` 判断的写法都会
   * 把「插入」当成「没给类型」。判定一律走 `inList()` 的严格相等，别改成真值判断。
   *
   * 不在列表里的 changeType（改样式、改段落属性、插图片、插水印……）
   * 一律忽略——那些不改变字符数，计进去只会污染数据。
   */
  var DEFAULT_INSERT_TYPES = [0];
  var DEFAULT_DELETE_TYPES = [1];

  /**
   * 用户手动翻转过的标记。手动改过就不再自动校准——人的判断优先。
   *
   * 但这个优先权**有边界**：见 `noteUnknownType()`。真机上出过「翻转得到一个
   * 只覆盖一半的映射、然后被这个标记永久冻结」的事，所以映射若明显解释不了
   * 眼前的事件，标记会被清掉、重新学。
   */
  var K_MANUAL = 'typestat_manual';

  /**
   * 「请重新自动校准」的请求标记。
   *
   * 对话框和加载项入口页是两个文档，对话框改不了入口页里的校准状态，
   * 所以用一个标记来传话：对话框写上，入口页每秒的 tick 里看到就消费掉、
   * 重新校准一遍。这样「恢复自动校准」在界面上是一次点击，
   * 而不用让用户再去功能区按一次别的按钮。
   */
  var K_RECALIBRATE = 'typestat_recalibrate';

  /**
   * 「已经自动校准过一次」的标记。
   *
   * 光把学到的类型值写进存储还不够：那样每次 WPS 重启后都会重新学一遍，
   * 而重新学习的头两三次击键是不计数的。更要紧的是，反复重新学习等于让
   * 「学歪」的机会反复出现，所以学成之后要把这件事本身记下来。
   */
  var K_LEARNED = 'typestat_learned';

  /** 同一个类型要看这么多**次**（不要求连续）才认，避免偶发的基线错位把映射学歪。 */
  var VOTES_REQUIRED = 2;

  /** 校准最多看这么多事件；超过还没学全就放弃，退回配置值。 */
  var LEARN_GIVEUP_AFTER = 12;

  /**
   * 校准期间最多留多少条原始证据给诊断对话框看。
   *
   * 之所以要留：校准失败时「为什么失败」全在这些数字里（len 是不是始终对不上、
   * span 是不是 0），只看一句「学不会」根本没法查。12 条覆盖了完整一轮校准。
   */
  var SAMPLE_KEEP = 12;

  /** 攒多久上报一次。逐次上报会给本地接收端刷出大量无用请求。 */
  var FLUSH_INTERVAL_MS = 1000;

  /** 攒够这么多字符就立刻上报，不等定时器——粘一大段进去时能马上看到。 */
  var FLUSH_THRESHOLD = 200;

  /**
   * 待上报的积压上限。接收端长期不在（TypeStat 没开）时不能无限攒，
   * 攒到这么多说明这些数字早就没意义了，直接丢掉。
   */
  var MAX_PENDING = 200000;

  /** 单次上报的字符数上限，与接收端的 MAX_CHARS_PER_REPORT 一致。 */
  var MAX_CHARS_PER_REPORT = 100000;

  /** 诊断日志保留多少条。 */
  var LOG_SIZE = 12;

  /**
   * 单写者选举用的键与周期。
   *
   * 为什么需要选举：这份代码在加载项页面里跑，而「WPS 到底创建几个加载项页面」
   * 没有文档写清楚（可能每个文档窗口一个）。每个页面都去注册 ContentChange 的话，
   * 同一次改动会被上报 N 遍，字数直接翻倍——而且这种错非常难发现，
   * 数据看起来只是「偏大一点」。
   *
   * 所以同一时刻只允许一个实例挂监听：靠 PluginStorage 里的一份心跳互相让位。
   * 心跳过期（页面被关掉、WPS 崩溃）后其他实例会接管，不会有统计空窗。
   * 万一 PluginStorage 其实是每页独立的（心跳只看得见自己），选举会退化成
   * 「人人都是leader」，等同于没有选举——不会比不加更糟。
   */
  var K_HEARTBEAT = 'typestat_leader';
  /** 心跳跟着下面的 1 秒定时器一起走，所以超时值取 4 秒——够宽，不会因为一次节流就误判。 */
  var LEADER_TIMEOUT_MS = 4000;

  /** 本页面的身份。随机即可，只用来区分「这条心跳是不是我写的」。 */
  var myId = String(Math.random()).slice(2) + '-' + Date.now();

  /**
   * 「自动校准」这一套的状态。
   *
   * ⚠️ **现在它只是兜底**，主路是 `handleByCount()`：字符数直接取
   * `doc.Characters.Count` 的逐次变化量，增删方向也由字数的涨跌决定，
   * **根本不需要知道 changeType 的数值**。
   *
   * 这套校准机器是在「拿不到真实字数」的前提下设计的：当时以为
   * `Characters.Count` 只能用来定方向、大小还得靠 Range，于是要先花几个事件
   * 反推 `wdContentInsert`/`wdContentDelete` 到底等于几。真机证明那条路走偏了——
   * 见 `handleByCount()` 上方的注释（Range 给的不是增量）。现在它只在
   * `Characters.Count` 连读都读不到时才启用（`countMode === 'unavailable'`）。
   *
   * 保留的理由：没法保证所有 WPS 版本都给得出 `Characters.Count`。
   * 真到了那一步，按老规矩来：ContentChange 触发时读字数，**只看方向**
   * ——涨了就是插入、跌了就是删除——把当时的 changeType 记下来，
   * 同一个类型的涨跌看够 VOTES_REQUIRED 次且从不矛盾才认定它的含义。
   *
   * 「校准期间一个字符都不计」这条规矩只在这条兜底路上生效。
   */
  var learningInited = false;

  /**
   * **只在兜底路上有意义**：计数时用 'len'（`Range.Text.length`）还是
   * 'span'（`Range.End - Range.Start`）。
   *
   * 主路不用它——主路的大小取自文档字数变化量，Range 一个字段都不碰。
   * 留着的理由同上：万一哪天退回兜底路，还得有个挑字段的规矩。
   */
  var measurePref = 'len';

  /**
   * 连续多少个「改了文字却认不出类型」的事件，就认定当前映射不可信、重新校准。
   *
   * 为什么需要这个：映射可能来自**人工翻转**（对话框那个按钮），而翻转只能把两个
   * 列表对调，对调之前的列表本身可能就缺项。真机上就出过这个——打字是类型 0、
   * 删除是类型 1，用户翻转之后删除对上了、打字仍然谁也不认识，而翻转打上的
   * `typestat_manual` 标记又让自动校准跳过了。结果是一个只覆盖一半的映射被永久冻结。
   *
   * 所以「人的判断优先」要有个边界：**优先到它明显解释不了眼前发生的事为止。**
   * 要求连续 3 次、且必须是「改了文字」的事件（长度为零的样式改动不算），
   * 是为了避免连插三张图片之类的情况误触发。
   */
  var UNKNOWN_STREAK_TO_RELEARN = 3;

  var unknownStreak = 0;

  /**
   * 连续这么多次读不到文档字数，就判定这台机器上这条路走不通，退回 Range + 校准。
   *
   * 之所以不是「一次读不到就退回」：读不到可能只是这一瞬间文档正忙。
   * 之所以要有个上限：一直读不到还一直试，等于永远不计数。
   */
  var COUNT_FAIL_GIVEUP = 5;

  /** 校准期间按 changeType 累计的字数涨/跌次数，形如 `{ '0': {up: 3, down: 0} }`。 */
  var tally = {};

  var learning = {
    active: true,
    prev: null, // 上一个事件之后该文档的字数；null = 还没建立基线
    prevDoc: '', // 基线属于哪个文档（同时开两个文档时不能互相串）
    learnedIns: null,
    learnedDel: null,
    countOk: false, // 有没有成功读到过文档字数
    observed: 0,
    note: '尚未开始',
    // 校准期间的原始证据，给诊断对话框看。每条形如「类型1 涨2（len 2 span 2）」。
    // 这是唯一能事后判断「到底哪个字段不对」的东西，所以留着。
    samples: [],
    lenOk: 0, // `Text.length` 和字数变化量对上了几次
    spanOk: 0, // `End - Start` 和字数变化量对上了几次
  };

  /**
   * 字符数的量法。三态：
   *
   *   'unknown'     还没量过，第一次事件时定夺
   *   'counting'    用 `doc.Characters.Count` 的逐次变化量（**正常情况**）
   *   'unavailable' 读不到字数，退回 Range + 自动校准（老路，见 handleByRange）
   *
   * 一旦定成 counting 就不再回头：中途一次读失败只跳过那一个事件，
   * 不能两种量法混着用——混用会把两套误差叠起来，而且看不出来。
   */
  var countMode = 'unknown';

  /** 读字数连续失败的次数，攒够 COUNT_FAIL_GIVEUP 就退回老路。 */
  var countFails = 0;

  /** 上一个事件之后该文档的字数。`-1` = 还没有基线。 */
  var lastCount = -1;

  /** 上面那个基线属于哪个文档。同时开两个文档时不能互相串。 */
  var lastCountDoc = '';

  var registered = false;
  var isLeader = false;
  var lastBeatAt = 0;
  var pending = { input: 0, delete: 0 };
  var inflight = false;
  var timer = null;
  var lastStatusWrite = 0;

  /**
   * 本次会话**按分钟**记的已上报量，形如 `{'17:47': {i: 1418, d: 0, n: 3}}`。
   *
   * 存在的理由只有一个：让对话框里这个数能和 TypeStat 数据库里那一行**逐分钟对上**。
   * 对不上就说明有别的实例也在往同一个接收端上报（那库里的数就是真数的整数倍），
   * 而对得上就说明加载项只报了这些、多出来的数字另有来源。
   * 光看累计值对不了账——两边的起点不一样。
   */
  var byMinute = {};
  var BY_MINUTE_KEEP = 30;

  function noteSent(i, d) {
    var k = clock().slice(0, 5);
    var e = byMinute[k] || (byMinute[k] = { i: 0, d: 0, n: 0 });
    e.i += i;
    e.d += d;
    e.n++;
    var keys = [];
    for (var key in byMinute) {
      if (Object.prototype.hasOwnProperty.call(byMinute, key)) keys.push(key);
    }
    if (keys.length > BY_MINUTE_KEEP) {
      keys.sort();
      delete byMinute[keys[0]];
    }
  }

  function recentMinutes() {
    var out = [];
    for (var k in byMinute) {
      if (Object.prototype.hasOwnProperty.call(byMinute, k)) {
        out.push({ m: k, i: byMinute[k].i, d: byMinute[k].d, n: byMinute[k].n });
      }
    }
    out.sort(function (a, b) {
      return a.m < b.m ? 1 : -1;
    });
    return out.slice(0, 8);
  }

  var stats = {
    startedAt: Date.now(),
    events: 0, // 收到的 ContentChange 次数
    counted: 0, // 其中真正计入字符数的
    ignored: 0, // 被忽略的（changeType 不在已知列表 / 长度为 0）
    insert: 0,
    delete: 0,
    sentInput: 0,
    sentDelete: 0,
    // 单次改动的最大字符数。这是诊断「数字虚高」最直接的一个指标：
    // 如果每敲一个字它都在涨、涨到几十上百，说明拿到的不是这次改动的增量，
    // 而是整段甚至整篇的长度。正常值：敲字 1，上屏一个词 2-4，粘一段才会很大。
    maxIns: 0,
    maxDelete: 0,
    // 读 `doc.Characters.Count` 的开销。这是「用文档字数当主量法」唯一的真风险：
    // 每来一个改动就要读一次，大文档上一次读数要是几十毫秒，打字就会被拖。
    // 所以把最坏一次和平均都记下来给对话框看，别靠感觉。
    countMsMax: 0,
    countMsSum: 0,
    countCalls: 0,
    countFails: 0, // 读到 -1 的次数（含已跳过的事件）
    // 选主是否在反复横跳。**这是「同一份改动被上报好几次」的头号嫌疑**：
    // 多个加载项页面同时挂着监听时，接收端把每一份都加起来，库里就是真数的整数倍，
    // 而且比值会稳定得像一个系数（真机上见过 6–12 倍）。次数正常应该只有 1–2。
    leaderEpoch: 0,
    standDowns: 0,
    drops: 0, // 积压超限被丢掉的字符数
    ok: 0, // 上报成功的批次数
    fail: 0,
    lastError: '',
    lastErrorAt: 0,
    lastOkAt: 0
  };

  var log = [];

  // ---------- 工具 ----------

  function now() {
    return Date.now();
  }

  function clock() {
    var d = new Date();
    function p(n) {
      return (n < 10 ? '0' : '') + n;
    }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** PluginStorage 只在 Application 就绪后可用，取不到就返回 null。 */
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

  function readTypes(key, fallback) {
    var raw = getItem(key);
    if (raw === null || raw === undefined || raw === '') return fallback.slice();
    try {
      var arr = JSON.parse(raw);
      if (!arr || !arr.length) return fallback.slice();
      return arr;
    } catch (e) {
      return fallback.slice();
    }
  }

  /**
   * 把一组 changeType 写进存储。
   *
   * 存的是 JSON 数组而不是单个数字：WPS 完全可能用多个类型值表示「插入」
   * （还有一个 `DEFAULT_INSERT_TYPES`/`DEFAULT_DELETE_TYPES` 也是数组，
   * 校准对话框的翻转按钮读写的也是这两个键，格式必须一致）。
   */
  function writeTypes(key, values) {
    return setItem(key, JSON.stringify(values));
  }

  /**
   * 增删映射的缓存。
   *
   * 每次 ContentChange 都去 PluginStorage 读一遍是不行的——那是一次跨进程调用，
   * 逐次击键都付这个代价会把打字拖慢。所以只在内存里留一份，
   * 由 1 秒一次的定时器去同步（校准对话框改了映射也能在一秒内生效）。
   */
  var typesCache = null;

  function reloadTypes() {
    typesCache = {
      ins: readTypes(K_INSERT_TYPES, DEFAULT_INSERT_TYPES),
      del: readTypes(K_DELETE_TYPES, DEFAULT_DELETE_TYPES),
    };
    return typesCache;
  }

  function cached() {
    return typesCache || reloadTypes();
  }

  function insertTypes() {
    return cached().ins;
  }

  function deleteTypes() {
    return cached().del;
  }

  function inList(list, v) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === v) return true;
    }
    return false;
  }

  /**
   * 当前事件属于哪个文档。
   *
   * 由 `handle()` 每次事件读一次（`doc.Name` 只是个属性，便宜），`pushLog` 统一附上去。
   * **这是排查「切文档导致巨大假差值」唯一的线索**：基线是按文档名重建的，
   * 如果这个名字读不出来（一直是空串），切文档就不会重建基线，
   * 于是会拿 A 文档的字数去减 B 文档的字数，差出一个几千的假数字。
   */
  var logDocName = '';

  function pushLog(entry) {
    entry.doc = logDocName;
    log.push(entry);
    if (log.length > LOG_SIZE) log.shift();
  }

  // ---------- 事件处理 ----------

  /**
   * 量一下这次改动涉及多长的文本。
   *
   * 只取长度。Range.Text 可能很大（粘一整篇），取完 .length 立刻不再引用，
   * 正文不进日志、不进上报、不进 PluginStorage。
   */
  function measure(range) {
    var len = 0;
    var span = -1;
    var source = 'text';
    try {
      len = range && range.Text ? range.Text.length : 0;
    } catch (e) {
      len = 0;
    }
    // 顺带读一下 Range 自己的跨度（End − Start）。它和 Text.length 应当相等。
    // 不相等的含义是「Range 说的范围和它给的内容对不上」，那时 Text.length 就
    // 不能当成增量用。记下来是为了让这件事在诊断对话框里一眼可见，
    // 而不是变成一堆对不上的数字。多读两个字段不花钱。
    try {
      if (range && typeof range.Start === 'number' && typeof range.End === 'number') {
        span = range.End - range.Start;
      }
    } catch (e) {
      span = -1;
    }
    // Text 没给内容但 Range 自己有跨度：跨度是这里唯一可信的长度来源。
    // （WPS 在某些改动上会给出空 Text，此时只看 Text.length 会全判成「长度 0」。）
    if (len <= 0 && span > 0) {
      len = span;
      source = 'span';
    }
    return { len: len, span: span, source: source };
  }

  /**
   * 这次改动算多少个字符。
   *
   * 按校准学到的来源取（`measurePref`）。要求「该来源有值」而不是无条件取，
   * 是因为两个字段都可能缺：Text 为空时 span 是唯一来源，而 End/Start 不给时
   * span 是 -1——`measure()` 已经把「Text 空但有跨度」这种情况折进 len 了，
   * 剩下的缺口由这里的默认分支兜住。
   */
  function used(m) {
    if (measurePref === 'span' && m.span > 0) return m.span;
    return m.len;
  }

  /** 实际取的是哪个来源。只用于在诊断对话框里说明数字的来路。 */
  function usedSource(m) {
    if (measurePref === 'span' && m.span > 0) return 'span';
    return m.source;
  }

  function readDocCount(doc) {
    try {
      if (doc && doc.Characters && typeof doc.Characters.Count === 'number') {
        return doc.Characters.Count;
      }
    } catch (e) {
      /* 接口不可用，返回 -1 由调用方决定怎么办 */
    }
    return -1;
  }

  /** 高精度时钟。`performance.now()` 给不了就退回毫秒级的 Date.now()。 */
  function perfNow() {
    try {
      if (window.performance && typeof window.performance.now === 'function') {
        return window.performance.now();
      }
    } catch (e) {
      /* 没有就算了 */
    }
    return Date.now();
  }

  /**
   * 读字数并计时。
   *
   * 计时不是装饰：这是新的主量法唯一没实测过的开销，而它现在**每个改动都要付一次**
   * （比原来「只在校准期间读」频繁得多）。最坏一次和平均都要看得见，
   * 否则大文档上打字变卡时根本无从判断是谁的问题。
   */
  function readDocCountTimed(doc) {
    var t0 = perfNow();
    var c = readDocCount(doc);
    var dt = perfNow() - t0;
    if (dt > stats.countMsMax) stats.countMsMax = dt;
    stats.countMsSum += dt;
    stats.countCalls++;
    return c;
  }

  function readDocName(doc) {
    try {
      return doc && doc.Name ? String(doc.Name) : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * 真正的事件处理。三个参数都来自 WPS。
   *
   * 校准期间这里一个字符都不计，只观察。理由：映射还没确定时"计入"是瞎猜，
   * 猜错的结果是一批看起来正常、实际全错的数字，比暂时少统计几次击键糟得多
   * （用户会以为统计是准的）。
   */
  function handle(doc, range, changeType) {
    stats.events++;
    logDocName = readDocName(doc);
    var m = measure(range);
    var t = now();

    // 首选量法：文档字数的逐次变化量。见 handleByCount。
    if (countMode !== 'unavailable') {
      var c = readDocCountTimed(doc);
      if (c >= 0) {
        countFails = 0;
        enterCountMode();
        handleByCount(doc, m, changeType, t, c);
        return;
      }

      stats.countFails++;
      countFails++;
      if (countMode === 'counting') {
        // 已经建立过基线，这一次偏偏读不到：**跳过这一个事件**，不退回 Range 去量。
        // 两套量法混用会把各自的误差叠在一起，而且从最终数字上完全看不出来。
        stats.ignored++;
        pushLog({
          t: t,
          clock: clock(),
          type: changeType,
          len: m.len,
          span: m.span,
          count: -1,
          delta: null,
          verdict: '忽略（这一次读不到文档字数）',
        });
        writeStatus();
        return;
      }
      if (countFails < COUNT_FAIL_GIVEUP) {
        stats.ignored++;
        pushLog({
          t: t,
          clock: clock(),
          type: changeType,
          len: m.len,
          span: m.span,
          count: -1,
          delta: null,
          verdict: '读不到文档字数，重试中（' + countFails + '/' + COUNT_FAIL_GIVEUP + '）',
        });
        writeStatus();
        return;
      }
      // 试了这么多次都不行，判定这条路在此机器上走不通，退回 Range + 校准。
      countMode = 'unavailable';
      initLearning();
    }

    handleByRange(doc, m, changeType, t);
  }

  /** 切到「按文档字数变化量计数」这条主路。幂等。 */
  function enterCountMode() {
    if (countMode === 'counting') return;
    countMode = 'counting';
    countFails = 0;
    // 校准那一整套机器存在的唯一理由是「拿不到真实字数时反推增删方向」。
    // 现在有真实字数了，它不但没用，还会让对话框挂一条红色的
    // 「正在自动校准，此时不计字数」——那是假的，字数一直在计。
    learning.active = false;
    learning.note = '不需要校准：字符数直接取文档字数的变化量';
  }

  /**
   * 把量法状态整个归零，让下一个事件重新定夺走哪条路。
   *
   * 由「重连监听」调用——那个按钮的语义就是「推倒重来」。
   * 特意**不**放进 `resetLearning()`：那个函数在 Range 老路里也会被调（认不出
   * 类型时重学），在那里顺手把量法也重置的话，一台真读不到字数的机器会每三个
   * 事件就跑回去重试读数一次、每次白丢五个事件。
   */
  function resetCountMode() {
    countMode = 'unknown';
    countFails = 0;
    lastCount = -1;
    lastCountDoc = '';
  }

  /**
   * 主路的计数：用 `doc.Characters.Count` 的逐次变化量当字符数。
   *
   * **为什么这个量法是对的**：逐次变化量求的是望远镜和，
   * `Σ(cur − prev) = 最后一次字数 − 第一次字数`，跟中间发生了什么**无关**。
   * 所以不管 WPS 内部是输入法组合、粘贴、还是把整段重排一遍，总数永远精确。
   *
   * **为什么不能继续用 Range**：真机实测（2026-09-23 用户截图）证明
   * `Range.Text.length` 给的是「这次改动覆盖的那一片区域有多长」，不是增量——
   * 用户敲 4 个字，Range 报的是 11、13、14、15、16（整段在长），
   * 于是同一分钟记了 109 个字符而实际按键只有 14 次。删除那边更彻底：
   * 类型 1 的 Range 全是空的，全被「长度 0」挡掉，126 次退格只记到 2 个删除。
   *
   * 两个字段（`Text.length` 和 `End − Start`）在这些事件上**始终相等**，
   * 所以原来那套「哪个和字数变化量对得上就用哪个」的判据从原理上发现不了这个错。
   */
  function handleByCount(doc, m, changeType, t, c) {
    var name = readDocName(doc);

    // 第一个事件，或者换文档了：只建立基线，不计数。
    // 换文档必须重建基线，否则会拿「另一个文档的字数」去减「这个文档的字数」，
    // 差出一个巨大的假数字——同时开两个文档时最容易发生。
    if (lastCount < 0 || name !== lastCountDoc) {
      lastCount = c;
      lastCountDoc = name;
      pushLog({
        t: t,
        clock: clock(),
        type: changeType,
        len: m.len,
        span: m.span,
        count: c,
        delta: null,
        verdict: '建立基线（当前字数 ' + c + '）',
      });
      writeStatus();
      return;
    }

    var delta = c - lastCount;
    lastCount = c;

    if (delta === 0) {
      // **噪声就是在这里被挡掉的。** 输入法组合、改样式、改属性都会打出一串事件，
      // 但一个字符也没真正进文档。老量法在这种情况下会把整段的长度当增量记进去。
      stats.ignored++;
      pushLog({
        t: t,
        clock: clock(),
        type: changeType,
        len: m.len,
        span: m.span,
        count: c,
        delta: 0,
        verdict: '忽略（字数没变）',
      });
      writeStatus();
      return;
    }

    var n = delta > 0 ? delta : -delta;

    // 超过接收端上限的单次改动会被整批拒收。这里有上限地截断，
    // 总比整批被退回再重试、把后面所有数据一起堵住要好。
    var clamped = n;
    var clampedNote = '';
    if (clamped > MAX_CHARS_PER_REPORT) {
      clamped = MAX_CHARS_PER_REPORT;
      clampedNote = '（超过单次上限，已截断）';
    }

    // 方向直接取字数的涨跌，**不看 changeType**。枚举值按声明顺序猜错过两次，
    // 而字数涨跌是文档自己说的，没有猜的成分。
    if (delta > 0) {
      pending.input += clamped;
      stats.insert++;
      if (clamped > stats.maxIns) stats.maxIns = clamped;
    } else {
      pending.delete += clamped;
      stats.delete++;
      if (clamped > stats.maxDelete) stats.maxDelete = clamped;
    }
    stats.counted++;

    pushLog({
      t: t,
      clock: clock(),
      type: changeType,
      len: m.len,
      span: m.span,
      count: c,
      delta: delta,
      verdict:
        (delta > 0 ? '记为新增 +' : '记为删除 −') +
        clamped +
        clampedNote +
        '（按文档字数变化）',
    });

    settle();
  }

  /** 计完之后两路共同的那段收尾：封顶积压，然后决定是发还是只写状态。 */
  function settle() {
    if (pending.input > MAX_PENDING) {
      stats.drops += pending.input - MAX_PENDING;
      pending.input = MAX_PENDING;
    }
    if (pending.delete > MAX_PENDING) {
      stats.drops += pending.delete - MAX_PENDING;
      pending.delete = MAX_PENDING;
    }
    if (pending.input + pending.delete >= FLUSH_THRESHOLD) flush();
    else writeStatus();
  }

  /**
   * 兜底老路：拿不到文档字数时，靠自动校准定增删方向、靠 Range 量大小。
   *
   * 保留它是因为没法保证所有 WPS 版本都给得出 `Characters.Count`。
   * 但它在真机上已经被证明比不上主路（Range 不是增量），所以只在主路确实走不通时才用。
   */
  function handleByRange(doc, m, changeType, t) {
    if (learning.active) {
      observe(doc, m, changeType, t);
      writeStatus();
      return;
    }

    var ins = inList(insertTypes(), changeType);
    var del = inList(deleteTypes(), changeType);

    if (!ins && !del) {
      stats.ignored++;
      // 「改了文字，但类型认不出来」——这是映射有问题的铁证，见下面 unknownStreak。
      // 长度为零的那些（改样式、改属性）不算数：它们本来就该被忽略。
      if (m.len > 0) noteUnknownType();
      pushLog({
        t: t,
        clock: clock(),
        type: changeType,
        len: m.len,
        span: m.span,
        verdict: '忽略（未知类型）',
      });
      writeStatus();
      return;
    }
    unknownStreak = 0;
    var n = used(m);
    if (n <= 0) {
      // 长度为零说明这次改动没动到字符（改样式、改属性…），计进去会是噪声。
      stats.ignored++;
      pushLog({
        t: t,
        clock: clock(),
        type: changeType,
        len: m.len,
        span: m.span,
        verdict: '忽略（长度 0）',
      });
      writeStatus();
      return;
    }

    // 超过接收端上限的单次改动会被整批拒收。这里有上限地截断，
    // 总比整批被退回再重试、把后面所有数据一起堵住要好。
    var clamped = n;
    var clampedNote = '';
    if (clamped > MAX_CHARS_PER_REPORT) {
      clamped = MAX_CHARS_PER_REPORT;
      clampedNote = '（超过单次上限，已截断）';
    }

    if (ins) {
      pending.input += clamped;
      stats.insert++;
      stats.counted++;
      if (clamped > stats.maxIns) stats.maxIns = clamped;
    } else {
      pending.delete += clamped;
      stats.delete++;
      stats.counted++;
      if (clamped > stats.maxDelete) stats.maxDelete = clamped;
    }

    pushLog({
      t: t,
      clock: clock(),
      type: changeType,
      len: m.len,
      span: m.span,
      verdict:
        (ins ? '记为新增 +' : '记为删除 −') +
        clamped +
        clampedNote +
        (usedSource(m) === 'span' ? '（长度取自跨度）' : ''),
    });

    settle();
  }

  // ---------- 自动校准 ----------

  /**
   * 记一次「改了文字但类型认不出来」。攒够就推翻当前映射重新校准。
   *
   * 这里会清掉 `typestat_manual`：那个标记的含义是「别覆盖我设的映射」，
   * 而它已经被证伪了——继续留着只会让下次 WPS 改动后也学不了。
   * 清掉是**这个标记自己允许的**：它承诺的前提（我设的映射是对的）不成立。
   */
  function noteUnknownType() {
    unknownStreak++;
    if (unknownStreak < UNKNOWN_STREAK_TO_RELEARN) return;
    unknownStreak = 0;
    setItem(K_MANUAL, '');
    resetLearning();
    learning.note =
      '连续 ' +
      UNKNOWN_STREAK_TO_RELEARN +
      ' 次改动认不出类型，当前映射不可信，已重新开始自动校准（请打字+退格）';
  }

  /**
   * 观察一个事件，试着从字数变化里认出 changeType 的含义。
   */
  function observe(doc, m, changeType, t) {
    learning.observed++;
    var note = '';

    var cur = readDocCount(doc);
    if (cur >= 0) {
      learning.countOk = true;
      var docName = readDocName(doc);

      if (learning.prev === null || learning.prevDoc !== docName) {
        note = '建立基线';
      } else {
        // 只看方向：字数涨了就是插入，跌了就是删除。
        // 不对 len/span 提任何要求——它们只是顺便记下来的证据（见 sample）。
        var delta = cur - learning.prev;
        if (delta !== 0) {
          note = record(changeType, delta);
          sample(changeType, delta, m);
        } else {
          note = '跳过（字数没变）';
        }
      }

      learning.prev = cur;
      learning.prevDoc = docName;
    } else {
      note = '读不到文档字数';
    }

    // 学全了就收工；看太多还没学全说明此路不通，退回配置的映射。
    if (learning.learnedIns !== null && learning.learnedDel !== null) {
      commitLearning();
    } else if (learning.observed >= LEARN_GIVEUP_AFTER) {
      giveUpLearning();
    } else {
      learning.note = note;
    }

    pushLog({
      t: t,
      clock: clock(),
      type: changeType,
      len: m.len,
      span: m.span,
      verdict: learning.active ? '校准中：' + note : '校准结束：' + learning.note,
    });
  }

  /**
   * 记一条校准证据。
   *
   * `len` 和 `span` 谁等于 `|字数变化|`，就给谁加一分——学完按比分决定之后用哪个
   * 字段计数（见 `measurePref`）。一个都对不上也照记：比分不动，最后退回默认的 len，
   * 而「都对不上」本身就是要给人看的信息，不能悄悄咽掉。
   */
  function sample(changeType, d, m) {
    var mag = d < 0 ? -d : d;
    if (m.len === mag) learning.lenOk++;
    if (m.span === mag) learning.spanOk++;
    if (learning.samples.length < SAMPLE_KEEP) {
      learning.samples.push(
        '类型' +
          changeType +
          (d > 0 ? ' 涨' : ' 跌') +
          mag +
          '（len ' +
          m.len +
          ' span ' +
          m.span +
          '）'
      );
    }
  }

  /**
   * 记录一个 changeType 带来的字数变化，并试着据此定下它的含义。
   *
   * 判据是**按类型累计、且从不矛盾**：
   *   - 某个类型让字数涨过 VOTES_REQUIRED 次、且**从来没有跌过** → 它是插入
   *   - 反过来跌过 VOTES_REQUIRED 次、且从来没涨过 → 它是删除
   *
   * 一开始用的是「同一方向必须**连续**两次」，但那个判据有个真实的死角：
   * 交替改稿（打一个字、退格、再打…）时每次退格都会把插入的连续计数清零，
   * 于是永远学不会——而那正是最常见的改稿节奏。累计计数没有这个问题。
   *
   * 「从不矛盾」这一条同时把错误学习的方向堵死了：万一基线错位导致某个类型的
   * 涨跌都出现过，它就**学不出来**，最后退回配置值让人工校准，
   * 而不是学成一个反的映射。失败方向朝向「不学」比朝向「学反」安全得多。
   *
   * 一旦落定就不再改写（只在该方向还是 null 时才赋值）：字数确实涨了，
   * 这个类型就必然是个「会插入」的类型；若后续冒出另一个也会插入的类型值，
   * 改写会让先学会的那个丢掉——两个类型里的插入改动只认一个，另一种全被忽略，
   * 而且看不出来。
   */
  function record(changeType, delta) {
    var key = String(changeType);
    var e = tally[key] || (tally[key] = { up: 0, down: 0 });
    if (delta > 0) e.up++;
    else e.down++;

    if (learning.learnedIns === null && e.up >= VOTES_REQUIRED && e.down === 0) {
      learning.learnedIns = changeType;
    }
    if (learning.learnedDel === null && e.down >= VOTES_REQUIRED && e.up === 0) {
      learning.learnedDel = changeType;
    }

    return (
      '类型' +
      changeType +
      (delta > 0 ? ' 涨' : ' 跌') +
      (delta < 0 ? -delta : delta) +
      '（累计 涨' +
      e.up +
      ' 跌' +
      e.down +
      '）'
    );
  }

  function commitLearning() {
    if (learning.learnedIns === learning.learnedDel) {
      // 同一个值不可能既表示插入又表示删除。真出现说明学的过程出了问题，
      // 那就不写进存储，宁可退回配置值让人去人工校准。
      learning.note = '学到的两个类型值相同（都是 ' + learning.learnedIns + '），不可信';
      learning.active = false;
      return;
    }
    // 按校准期间的比分挑长度来源：谁和字数变化量对得上就用谁。
    // 打平或都没对上时保持 len——`Range.Text` 才是语义上的正文内容，优先信它。
    measurePref = learning.spanOk > learning.lenOk ? 'span' : 'len';

    writeTypes(K_INSERT_TYPES, [learning.learnedIns]);
    writeTypes(K_DELETE_TYPES, [learning.learnedDel]);
    setItem(K_LEARNED, '1');
    reloadTypes();
    learning.active = false;

    // 方向是从字数涨跌里直接得到的，可信；**大小**只能靠 Range 给的字段，
    // 两个字段都没和字数变化量对上时，说明这次改动到底几个字其实没人能证实。
    // 这种时候不能装作没事——数字会看起来正常但是错的，正是最难发现的那种。
    var unverified = learning.lenOk === 0 && learning.spanOk === 0;
    learning.note =
      '已自动校准：插入 = ' +
      learning.learnedIns +
      '，删除 = ' +
      learning.learnedDel +
      '，长度取' +
      (measurePref === 'span' ? ' Range 跨度' : ' Range.Text') +
      (unverified
        ? '。但字数变化量和这两个字段都对不上，这次改动到底几个字无从核实，' +
          '上报的字符数大小可能不准（增删方向是对的）'
        : '');
  }

  function giveUpLearning() {
    learning.active = false;
    learning.note = learning.countOk
      ? '自动校准失败：看了 ' + learning.observed + ' 个事件还没学全，改用已有映射'
      : '自动校准失败：读不到文档字数（doc.Characters.Count 不可用），改用已有映射';
  }

  /**
   * 清掉自动校准的结果，让它重新学一遍。
   *
   * 只清「学来的」，不清「人手动设的」（K_MANUAL）——手动校准永远优先。
   * 由功能区的「重连监听」触发：那个按钮的含义就是「推倒重来」，
   * 而重新校准要等下一个事件，所以必须在这里就把状态归零，
   * 不能只清存储里的标记（那要等 WPS 重启才生效）。
   */
  function resetLearning() {
    learning.active = true;
    learning.prev = null;
    learning.prevDoc = '';
    learning.learnedIns = null;
    learning.learnedDel = null;
    learning.countOk = false;
    learning.observed = 0;
    learning.note = '尚未开始';
    learning.samples = [];
    learning.lenOk = 0;
    learning.spanOk = 0;
    measurePref = 'len';
    unknownStreak = 0;
    tally = {};
    setItem(K_LEARNED, '');
    learningInited = true;
    initLearning();
  }

  /**
   * 决定这次会话要不要做自动校准。在收到第一个事件之前调一次。
   */
  function initLearning() {
    if (getItem(K_MANUAL)) {
      learning.active = false;
      learning.note = '已手动校准过，跳过自动校准';
      return;
    }
    if (getItem(K_LEARNED)) {
      learning.active = false;
      learning.note = '沿用上次自动校准的结果';
      return;
    }
    learning.active = true;
    learning.note = '等待第一次改动';
  }

  // ---------- 上报 ----------

  function requeue(a, b) {
    pending.input = Math.min(MAX_PENDING, pending.input + a);
    pending.delete = Math.min(MAX_PENDING, pending.delete + b);
  }

  function flush() {
    if (inflight) return; // 上一批还没回来，等它，避免请求堆叠
    if (pending.input === 0 && pending.delete === 0) return;

    var body = JSON.stringify({
      app: TYPESTAT_CONFIG.app,
      input: pending.input,
      delete: pending.delete,
    });
    var sentInput = pending.input;
    var sentDelete = pending.delete;
    // 先清零再发：失败时再补回来。这样既不会重复计数，也不会因为
    // 请求在途而把同一批数字发两遍。
    pending.input = 0;
    pending.delete = 0;
    inflight = true;

    var xhr = new XMLHttpRequest();
    var url = 'http://127.0.0.1:' + TYPESTAT_CONFIG.port + '/report';

    function done(ok, note) {
      inflight = false;
      if (ok) {
        stats.ok++;
        stats.sentInput += sentInput;
        stats.sentDelete += sentDelete;
        stats.lastOkAt = now();
        noteSent(sentInput, sentDelete);
      } else {
        stats.fail++;
        stats.lastError = note;
        stats.lastErrorAt = now();
        // 401/400 是永久性错误（token 不对 / 数据不合规），重试一万次也一样，
        // 还会把后面的数据一起堵在这个队列里。丢掉，并把错误显示出来让人去修。
        if (note.indexOf('HTTP 401') === 0 || note.indexOf('HTTP 400') === 0) {
          stats.drops += sentInput + sentDelete;
        } else {
          requeue(sentInput, sentDelete);
        }
      }
      writeStatus();
    }

    try {
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('x-typestat-token', TYPESTAT_CONFIG.token);
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) done(true, '');
        else done(false, 'HTTP ' + xhr.status);
      };
      xhr.onerror = function () {
        done(false, '网络错误（TypeStat 没在跑？）');
      };
      xhr.ontimeout = function () {
        done(false, '超时');
      };
      xhr.send(body);
    } catch (e) {
      done(false, '发送异常：' + (e && e.message ? e.message : e));
    }
  }

  /** 连通性自检：发一批全零。接收端认这个是「测试连接」，不落库。 */
  function testConnection(cb) {
    var xhr = new XMLHttpRequest();
    var url = 'http://127.0.0.1:' + TYPESTAT_CONFIG.port + '/report';
    try {
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.setRequestHeader('x-typestat-token', TYPESTAT_CONFIG.token);
      xhr.timeout = 3000;
      xhr.onload = function () {
        cb(xhr.status, xhr.status === 200 ? '通' : describe(xhr.status));
      };
      xhr.onerror = function () {
        cb(0, '连不上 127.0.0.1:' + TYPESTAT_CONFIG.port + '（TypeStat 没在跑？）');
      };
      xhr.ontimeout = function () {
        cb(0, '超时');
      };
      xhr.send(JSON.stringify({ app: TYPESTAT_CONFIG.app, input: 0, delete: 0 }));
    } catch (e) {
      cb(0, '发送异常：' + (e && e.message ? e.message : e));
    }
  }

  function describe(code) {
    if (code === 200) return '通';
    if (code === 401) return 'token 不对（在 TypeStat 设置页重新生成后要同步改 js/config.js）';
    if (code === 400) return '数据被拒（应用名不合法或字符数超限）';
    if (code === 503) return '接收端队列满';
    return 'HTTP ' + code;
  }

  // ---------- 状态快照 ----------

  /**
   * 把状态写进 PluginStorage，供「统计状态」对话框读取。
   *
   * 对话框和加载项入口页是两个不同的网页文档，内存不共享，
   * PluginStorage 是它们之间唯一的官方通道。
   *
   * 限频 500ms：写一次是一次跨进程调用，逐次事件都写会把打字拖慢。
   */
  function writeStatus(force) {
    var t = now();
    if (!force && t - lastStatusWrite < 500) return;
    // 只有当值的实例写快照。多个加载项页面共用这一个键，
    // 让闲着的那几个也写的话，对话框会随机读到一份全零的计数，
    // 看起来就像统计坏了。
    if (!isLeader) return;
    var s = storage();
    if (!s) return;
    lastStatusWrite = t;
    try {
      s.setItem(
        K_STATUS,
        JSON.stringify({
          at: t,
          startedAt: stats.startedAt,
          leader: isLeader,
          registered: registered,
          pageId: myId,
          events: stats.events,
          counted: stats.counted,
          ignored: stats.ignored,
          insert: stats.insert,
          delete: stats.delete,
          pendingInput: pending.input,
          pendingDelete: pending.delete,
          sentInput: stats.sentInput,
          sentDelete: stats.sentDelete,
          maxIns: stats.maxIns,
          maxDelete: stats.maxDelete,
          // 字符数是「怎么量出来的」，这是现在最要紧的一个状态：
          // 'counting' = 按文档字数变化量（正常）；'unavailable' = 退回 Range + 校准。
          countMode: countMode,
          countFails: stats.countFails,
          countMsMax: Math.round(stats.countMsMax * 100) / 100,
          countMsAvg:
            stats.countCalls > 0
              ? Math.round((stats.countMsSum / stats.countCalls) * 100) / 100
              : 0,
          leaderEpoch: stats.leaderEpoch,
          standDowns: stats.standDowns,
          byMinute: recentMinutes(),
          drops: stats.drops,
          ok: stats.ok,
          fail: stats.fail,
          lastError: stats.lastError,
          lastErrorAt: stats.lastErrorAt || 0,
          lastOkAt: stats.lastOkAt,
          insertTypes: insertTypes(),
          deleteTypes: deleteTypes(),
          measurePref: measurePref,
          learning: {
            active: learning.active,
            note: learning.note,
            countOk: learning.countOk,
            observed: learning.observed,
            samples: learning.samples,
            lenOk: learning.lenOk,
            spanOk: learning.spanOk,
          },
          log: log,
        })
      );
    } catch (e) {
      /* 写不进去不影响统计本身，忽略 */
    }
  }

  // ---------- 注册 ----------

  /**
   * 把监听挂上去。幂等：已经挂上就什么都不做。
   * 返回 true 表示「现在已挂上」。
   */
  function ensureRegistered() {
    var a = window.Application;
    if (!a || !a.ApiEvent) return false;
    if (registered) return true;

    try {
      // 先移除再注册，防重复（见 HANDLER_NAME 上的注释）。
      try {
        a.ApiEvent.RemoveApiEventListener('ContentChange', HANDLER_NAME);
      } catch (e) {
        /* 没注册过时移除报错是正常的 */
      }
      a.ApiEvent.AddApiEventListener('ContentChange', HANDLER_NAME);
      registered = true;
      writeStatus(true);
      return true;
    } catch (e) {
      stats.lastError = '注册 ContentChange 失败：' + (e && e.message ? e.message : e);
      return false;
    }
  }

  function removeRegistration() {
    if (!registered) return;
    try {
      window.Application.ApiEvent.RemoveApiEventListener('ContentChange', HANDLER_NAME);
    } catch (e) {
      /* 已经没了就算了 */
    }
    registered = false;
  }

  // ---------- 单写者选举 ----------

  function heartbeat() {
    var raw = getItem(K_HEARTBEAT);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function writeHeartbeat() {
    lastBeatAt = now();
    setItem(K_HEARTBEAT, JSON.stringify({ id: myId, at: lastBeatAt }));
  }

  function becomeLeader() {
    isLeader = true;
    stats.leaderEpoch++;
    writeHeartbeat();
    // 在挂监听之前定下这次会话要不要校准。放在这里而不是 start()：
    // 读 PluginStorage 需要 Application 就绪，而 Application 刚就绪正是此刻。
    if (!learningInited) {
      learningInited = true;
      initLearning();
    }
    ensureRegistered();
    // 注册失败也要写快照，否则诊断对话框只会说「没收到任何状态」，
    // 分不清是「加载项没被加载」还是「加载了但没挂上监听」。
    writeStatus(true);
  }

  function standDown() {
    isLeader = false;
    stats.standDowns++;
    removeRegistration();
  }

  /**
   * 一秒一次的心跳与让位逻辑。
   *
   * 让位规则：如果心跳不是我的、又比我写的更新，就让位。
   * 真leader的心跳一直在刷新，所以冒出来的竞争者会立刻退下；
   * 反过来，如果我是真leader，对方先让位，我保持不动。来回一次就收敛。
   */
  function tick() {
    var hb = heartbeat();
    var fresh = hb && now() - hb.at < LEADER_TIMEOUT_MS;
    var mine = hb && hb.id === myId;

    if (isLeader) {
      if (fresh && !mine && hb.at > lastBeatAt) {
        standDown();
      } else {
        writeHeartbeat();
        // 自己当值但监听没挂上（启动时 Application 还没就绪），一直重试到挂上为止。
        // 这样不用用户去点「重连监听」也能自愈。
        if (!registered) ensureRegistered();

        // 「请重新自动校准」只有**当值的实例**能消费。
        // 闲着的实例先读到就把它清掉的话，真正在计数的那个永远收不到这条请求，
        // 用户会看到自己点了按钮却什么都没发生。
        if (getItem(K_RECALIBRATE)) {
          setItem(K_RECALIBRATE, '');
          resetLearning();
        }
      }
    } else if (!fresh) {
      // 没有当值的，或者前任已经死了（页面被关、WPS 崩过），接管。
      becomeLeader();
    }
  }

  /**
   * 启动。幂等，调多少次都一样。
   *
   * 两处会调它：本文件末尾（加载项页面一加载就跑）和 ribbon 的 OnAddinLoad。
   * 两处都要，因为 window.Application 不一定在脚本执行时就注入好了
   * （官方模板里也做了判空），而 OnAddinLoad 什么时候被调用又取决于功能区
   * 何时构建——统计从加载项被加载的那一刻就该开始，不能等功能区。
   */
  function start() {
    if (timer) return;
    reloadTypes();

    // 启动阶段快速重试：window.Application 可能还没注入完，
    // 也可能别的实例正握着心跳、要等它过期。最多试 30 秒。
    var tries = 0;
    var boot = setInterval(function () {
      tries++;
      tick();
      if (registered || tries > 150) clearInterval(boot);
    }, 200);

    // 定时上报。加载项页面在后台，定时器可能被浏览器节流，
    // 所以同时还有「攒够阈值立即上报」这条路径兜着。
    timer = setInterval(function () {
      tick();
      flush();
      writeStatus();
      reloadTypes(); // 校准对话框改过映射的话，一秒内同步过来
    }, FLUSH_INTERVAL_MS);

    // 关 WPS 之前尽量把最后一批送出去。
    try {
      window.addEventListener('beforeunload', function () {
        flush();
      });
    } catch (e) {
      /* 某些文档类型下没有 window 事件，忽略 */
    }
  }

  /*
   * 这里**没有** flip()：翻转增删映射是「统计状态」对话框直接改
   * PluginStorage 里那两个键完成的，本文件下一秒的 reloadTypes() 就会同步过来。
   * 对话框和加载项入口页是两个文档，它够不到这个对象里的函数，
   * 所以再写一个 flip() 只会是一段永远没人调用的代码。
   */

  return {
    handle: handle,
    start: start,

    /**
     * 「重连监听」按钮走这里。
     *
     * 不走 ensureRegistered：那个只是把监听挂上，不管选主——
     * 在多个加载项页面同时存在时，人人都挂监听就是人人都在重复计数。
     * 这里先让位再取位，保证同一时刻只有一个实例在收事件。
     */
    reconnect: function () {
      standDown();
      // 连带把自动校准推倒重来：这个按钮的语义就是「重新来一遍」，
      // 而「增删记反了」正是需要重来的典型场景。
      resetLearning();
      // 量法状态也一起归零（换文档、切量法都从这里重新定夺）
      resetCountMode();
      becomeLeader();
      return registered;
    },

    flush: flush,
    testConnection: testConnection,
  };
})();

/**
 * 事件回调本体。**必须是全局函数**——注册时用的是这个名字，
 * ApiEvent 靠名字找到它，包在闭包里会找不到。
 */
function TypeStatOnContentChange(Document, Range, changeType) {
  try {
    TypeStatReporter.handle(Document, Range, changeType);
  } catch (e) {
    /* 单个事件出错不能让整个回调链断掉 */
  }
}

// 页面一加载就开始跑。OnAddinLoad 里还会再调一次 start()，那是幂等的。
try {
  TypeStatReporter.start();
} catch (e) {
  /* window.Application 还没注入也不影响，start 内部的定时器会继续试 */
}
