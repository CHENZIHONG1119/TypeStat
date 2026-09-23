/**
 * 键盘布局与「物理按键 ↔ 界面键位」的映射。
 *
 * 布局是 ANSI 60%，5 行每行合计 15 个键位单位宽，所以各行共用同一套网格、
 * 竖列能对齐——这是选定的方案 B（正交网格）的关键，去掉真实键盘的逐行错位
 * 换来列可比：同一根手指负责的那一列一眼可辨。
 *
 * 关于匹配左右修饰键：左右 Shift 共用 vkCode 0x10、左右 Ctrl 共用 0x11，
 * 左右 Ctrl/Alt 甚至连 scanCode 都一样，只有 E0 扩展位不同。
 * 所以修饰键一律按 (scanCode, 扩展位) 匹配，普通键按 vkCode 匹配。
 */

export interface KeySlot {
  label: string;
  /** 键宽，单位是键位单位（1 = 字母键宽）。 */
  w: number;
  /** 普通键：虚拟键码。 */
  vk?: number;
  /** 修饰键：扫描码 + 是否扩展键。 */
  scan?: number;
  ext?: boolean;
  /** 备选虚拟键码。有的环境钩子上报的是 VK_LSHIFT / VK_RCONTROL 这类分左右的值。 */
  altVk?: number;
}

export interface KeyRow {
  keys: KeySlot[];
}

/** 每行合计的键位单位数，用于算缩放。 */
export const ROW_UNITS = 15;

export const KEY_ROWS: KeyRow[] = [
  {
    keys: [
      { label: "`", w: 1, vk: 0xc0 },
      { label: "1", w: 1, vk: 0x31 },
      { label: "2", w: 1, vk: 0x32 },
      { label: "3", w: 1, vk: 0x33 },
      { label: "4", w: 1, vk: 0x34 },
      { label: "5", w: 1, vk: 0x35 },
      { label: "6", w: 1, vk: 0x36 },
      { label: "7", w: 1, vk: 0x37 },
      { label: "8", w: 1, vk: 0x38 },
      { label: "9", w: 1, vk: 0x39 },
      { label: "0", w: 1, vk: 0x30 },
      { label: "-", w: 1, vk: 0xbd },
      { label: "=", w: 1, vk: 0xbb },
      { label: "⌫", w: 2, vk: 0x08 },
    ],
  },
  {
    keys: [
      { label: "Tab", w: 1.5, vk: 0x09 },
      { label: "Q", w: 1, vk: 0x51 },
      { label: "W", w: 1, vk: 0x57 },
      { label: "E", w: 1, vk: 0x45 },
      { label: "R", w: 1, vk: 0x52 },
      { label: "T", w: 1, vk: 0x54 },
      { label: "Y", w: 1, vk: 0x59 },
      { label: "U", w: 1, vk: 0x55 },
      { label: "I", w: 1, vk: 0x49 },
      { label: "O", w: 1, vk: 0x4f },
      { label: "P", w: 1, vk: 0x50 },
      { label: "[", w: 1, vk: 0xdb },
      { label: "]", w: 1, vk: 0xdd },
      { label: "\\", w: 1.5, vk: 0xdc },
    ],
  },
  {
    keys: [
      { label: "Caps", w: 1.75, vk: 0x14 },
      { label: "A", w: 1, vk: 0x41 },
      { label: "S", w: 1, vk: 0x53 },
      { label: "D", w: 1, vk: 0x44 },
      { label: "F", w: 1, vk: 0x46 },
      { label: "G", w: 1, vk: 0x47 },
      { label: "H", w: 1, vk: 0x48 },
      { label: "J", w: 1, vk: 0x4a },
      { label: "K", w: 1, vk: 0x4b },
      { label: "L", w: 1, vk: 0x4c },
      { label: ";", w: 1, vk: 0xba },
      { label: "'", w: 1, vk: 0xde },
      { label: "⏎", w: 2.25, vk: 0x0d },
    ],
  },
  {
    keys: [
      // 右 Alt 在主键盘区；这里两个 Shift 用扫描码区分：0x2A 左、0x36 右
      { label: "Shift", w: 2.25, scan: 0x2a, ext: false, altVk: 0xa0 },
      { label: "Z", w: 1, vk: 0x5a },
      { label: "X", w: 1, vk: 0x58 },
      { label: "C", w: 1, vk: 0x43 },
      { label: "V", w: 1, vk: 0x56 },
      { label: "B", w: 1, vk: 0x42 },
      { label: "N", w: 1, vk: 0x4e },
      { label: "M", w: 1, vk: 0x4d },
      { label: ",", w: 1, vk: 0xbc },
      { label: ".", w: 1, vk: 0xbe },
      { label: "/", w: 1, vk: 0xbf },
      { label: "Shift", w: 2.75, scan: 0x36, ext: false, altVk: 0xa1 },
    ],
  },
  {
    keys: [
      { label: "Ctrl", w: 1.25, scan: 0x1d, ext: false, altVk: 0xa2 },
      { label: "Win", w: 1.25, scan: 0x5b, ext: true, altVk: 0x5b },
      { label: "Alt", w: 1.25, scan: 0x38, ext: false, altVk: 0xa4 },
      { label: "Space", w: 6.25, vk: 0x20 },
      { label: "Alt", w: 1.25, scan: 0x38, ext: true, altVk: 0xa5 },
      { label: "Win", w: 1.25, scan: 0x5c, ext: true, altVk: 0x5c },
      { label: "Menu", w: 1.25, scan: 0x5d, ext: true, vk: 0x5d },
      { label: "Ctrl", w: 1.25, scan: 0x1d, ext: true, altVk: 0xa3 },
    ],
  },
];

/** 归一化后的物理按键标识。 */
export interface PhysicalKey {
  scan: number;
  ext: boolean;
}

/**
 * 把上报的扫描码统一成 (低字节, 是否扩展)。
 *
 * 不同来源对扩展键的表示不一致：有的把 E0 前缀并进 scanCode（0xE01D），
 * 有的只用 flags 里的扩展位。两种都归一化到同一形式，映射表才写得下去。
 */
export function normalizeScan(scanCode: number, extended: boolean): PhysicalKey {
  return { scan: scanCode & 0xff, ext: extended || scanCode > 0xff };
}

const BY_VK = new Map<number, number>(); // vkCode → 扁平索引
const BY_SCAN = new Map<string, number>(); // "scan:ext" → 扁平索引
const BY_SCAN_LOOSE = new Map<number, number>(); // scan（忽略扩展位）→ 扁平索引

(function buildIndex() {
  let i = 0;
  for (const row of KEY_ROWS) {
    for (const k of row.keys) {
      if (k.vk !== undefined) BY_VK.set(k.vk, i);
      if (k.altVk !== undefined && !BY_VK.has(k.altVk)) BY_VK.set(k.altVk, i);
      if (k.scan !== undefined) {
        const ext = k.ext ?? false;
        const key = `${k.scan}:${ext ? 1 : 0}`;
        // 扩展位未知时按 scan 兜底，先登记不覆盖
        if (!BY_SCAN.has(key)) BY_SCAN.set(key, i);
        if (!BY_SCAN_LOOSE.has(k.scan)) BY_SCAN_LOOSE.set(k.scan, i);
      }
      i++;
    }
  }
})();

/** 扁平索引 → 键位。用于把数据库里的一行映射回界面上的某个键。 */
export const FLAT_KEYS: KeySlot[] = KEY_ROWS.flatMap((r) => r.keys);

/** 界面短标签用了缩写，悬停时给出完整名字。 */
const FULL_NAMES: Record<string, string> = {
  "`": "反引号",
  "-": "减号",
  "=": "等号",
  "[": "左方括号",
  "]": "右方括号",
  "\\": "反斜杠",
  ";": "分号",
  "'": "单引号",
  ",": "逗号",
  ".": "句号",
  "/": "斜杠",
  "⌫": "退格",
  "⏎": "回车",
  Tab: "Tab",
  Caps: "Caps Lock",
  Space: "空格",
  Menu: "菜单键",
};

/**
 * 键位的完整名字。修饰键要标出左右——图上左右 Shift 是两个格子，
 * 只说 "Shift" 会让人分不清悬停的是哪一个。
 */
export function displayName(k: KeySlot): string {
  if (k.scan !== undefined) {
    if (k.scan === 0x5d) return "菜单键";
    const right =
      k.scan === 0x36 || k.scan === 0x5c || (k.ext === true && (k.scan === 0x1d || k.scan === 0x38));
    const base = k.scan === 0x1d ? "Ctrl" : k.scan === 0x38 ? "Alt" : k.scan === 0x36 || k.scan === 0x2a ? "Shift" : "Win";
    return `${right ? "右" : "左"} ${base}`;
  }
  return FULL_NAMES[k.label] ?? k.label;
}

/**
 * 不在 60% 布局图上的键的名字。
 *
 * 60% 键盘本来就没有方向键、F 区和小键盘，但用户会按——这些次数必须能报出
 * 名字来，只给一个总数的话用户没法判断是自己按错了还是程序漏了。
 */
const VK_OFF_MAP: Record<number, string> = {
  0x25: "←", 0x26: "↑", 0x27: "→", 0x28: "↓",
  0x21: "Page Up", 0x22: "Page Down", 0x23: "End", 0x24: "Home",
  0x2d: "Insert", 0x2e: "Delete",
  0x13: "Pause", 0x2c: "Print Screen", 0x90: "Num Lock", 0x91: "Scroll Lock",
  0x6a: "小键盘 *", 0x6b: "小键盘 +", 0x6d: "小键盘 -",
  0x6e: "小键盘 .", 0x6f: "小键盘 /",
};

for (let i = 0; i < 12; i++) VK_OFF_MAP[0x70 + i] = `F${i + 1}`;
for (let i = 0; i < 10; i++) VK_OFF_MAP[0x60 + i] = `小键盘 ${i}`;

/** 图外按键的显示名。认不出来就退回键码，至少能让人去查。 */
export function offMapName(vkCode: number, scanCode: number): string {
  return VK_OFF_MAP[vkCode] ?? `键码 0x${vkCode.toString(16).padStart(2, "0")}（扫描码 ${scanCode}）`;
}

/**
 * 物理按键 → 界面键位索引。匹配不到返回 -1（比如小键盘、F 区、多媒体键——
 * 这些键不在 60% 布局图上）。
 */
export function slotIndex(vkCode: number, scanCode: number, extended: boolean): number {
  const { scan, ext } = normalizeScan(scanCode, extended);

  // 修饰键优先按扫描码匹配：左右 Shift/Ctrl/Alt 的 vkCode 是共用的，
  // 只有扫描码（和扩展位）能分开。
  const byScan = BY_SCAN.get(`${scan}:${ext ? 1 : 0}`);
  if (byScan !== undefined) return byScan;

  const byVk = BY_VK.get(vkCode);
  if (byVk !== undefined) return byVk;

  // 扩展位来源不可靠时，退一步只按扫描码匹配。
  const loose = BY_SCAN_LOOSE.get(scan);
  if (loose !== undefined) return loose;

  return -1;
}

/**
 * 归一化到 [0, 1]，用平方根而不是线性。
 *
 * 空格可能上万次、`` ` `` 只有几十次，差两个数量级。线性映射会把绝大多数键
 * 挤进取色阶最浅的一小段里，整张图糊成一片（把缩放开关切成线性就直观了）。
 * 平方根把比值压到个位数倍，低值区的层次才出得来。
 */
export function normalize(count: number, max: number, sqrt = true): number {
  if (max <= 0 || count <= 0) return 0;
  const f = sqrt ? Math.sqrt : (v: number) => v;
  return f(count) / f(max);
}

/* ---------- 文字墨色 ---------- */

function relativeLuminance(hex: string): number {
  const c = hex.replace("#", "");
  const ch = [0, 2, 4]
    .map((i) => parseInt(c.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_INK = "#0b0b0b";

/**
 * 键帽文字用黑还是白，取决于填充色的亮度。
 * 用对比度算而不是拍一个阈值——深蓝底配黑字会糊成一团。
 */
export function inkFor(fill: string): string {
  const L = relativeLuminance(fill);
  return contrastRatio(L, 1) >= contrastRatio(L, relativeLuminance(DARK_INK))
    ? "#ffffff"
    : DARK_INK;
}
