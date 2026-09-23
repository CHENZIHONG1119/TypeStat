/**
 * 仅用于开发时肉眼检查键盘热力图——真实数据来自 Tauri 后端，
 * 在浏览器里跑不起来。跑 `npm run dev` 后打开 /keyboard-preview.html。
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { KeyboardHeatmap } from "./components/KeyboardHeatmap";
import { displayName, FLAT_KEYS } from "./lib/keyboard";
import { TOKENS, type Mode } from "./theme";
import type { KeyUsage } from "./lib/api";
import "./styles.css";

/** 一份近似真实中文写作的键频分布，用来把色阶铺开。 */
const WEIGHTS: Record<string, number> = {
  Space: 4200, E: 1600, T: 1350, A: 1300, O: 1250, I: 1200, N: 1150, S: 1100,
  R: 1050, H: 1000, L: 900, D: 850, U: 800, C: 750, M: 700, F: 650, P: 600,
  G: 550, W: 500, Y: 450, B: 400, V: 350, K: 300, X: 150, J: 140, Q: 120, Z: 110,
  "⌫": 900, "⏎": 300, ",": 700, ".": 650, "'": 200, ";": 120, "-": 100, "/": 80,
  "[": 40, "]": 44, "\\": 15, "`": 12, "=": 22, Tab: 120, Caps: 8,
  "1": 60, "2": 55, "3": 48, "4": 40, "5": 38, "6": 30, "7": 26, "8": 22, "9": 20, "0": 28,
};

const MOD_WEIGHTS: Record<string, number> = {
  "左 Shift": 800, "右 Shift": 90, "左 Ctrl": 300, "右 Ctrl": 20,
  "左 Alt": 60, "右 Alt": 10, "左 Win": 30, "右 Win": 5, "菜单键": 3,
};

/** 这几个键当作从来没按过，用来检查「无数据」和「很少」在视觉上分得开。 */
const NEVER = new Set(["Q", "Z", "菜单键"]);

function mock(): KeyUsage[] {
  const out: KeyUsage[] = [];
  for (const k of FLAT_KEYS) {
    const name = displayName(k);
    if (NEVER.has(k.label) || NEVER.has(name)) continue;
    const w = WEIGHTS[k.label] ?? MOD_WEIGHTS[displayName(k)] ?? 40;
    const count = Math.round(w * (0.85 + Math.random() * 0.3));
    out.push({
      vkCode: k.vk ?? 0,
      scanCode: k.scan ?? 0,
      extended: k.ext ?? false,
      count,
    });
  }

  // 同一排修饰键在库里可能同时存在通用键码和分左右键码两种记录，
  // 它们必须汇进图上同一个格子——这里故意造出来验证。
  out.push({ vkCode: 0xa0, scanCode: 0x2a, extended: false, count: 210 });
  out.push({ vkCode: 0x10, scanCode: 0x2a, extended: false, count: 590 });

  // 图外按键。用真实采集到的形式：扩展键的扫描码不带 E0 前缀，靠 extended 位标记。
  out.push({ vkCode: 0x28, scanCode: 0x50, extended: true, count: 140 }); // ↓
  out.push({ vkCode: 0x25, scanCode: 0x4b, extended: true, count: 60 }); // ←
  out.push({ vkCode: 0x24, scanCode: 0x47, extended: false, count: 18 }); // Home
  out.push({ vkCode: 0x74, scanCode: 0x3f, extended: false, count: 4 }); // F5

  return out;
}

const DATA = mock();

function Preview() {
  const [mode, setMode] = useState<Mode>("light");
  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
        <button
          className="btn"
          onClick={() => {
            const next = mode === "light" ? "dark" : "light";
            setMode(next);
            document.documentElement.dataset.theme = next;
          }}
        >
          切换到{mode === "light" ? "深色" : "浅色"}
        </button>
      </div>
      <div className="card">
        <h2 className="card-title">键位热力图</h2>
        <p className="card-sub">预览用假数据</p>
        <KeyboardHeatmap tokens={TOKENS[mode]} data={DATA} />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
