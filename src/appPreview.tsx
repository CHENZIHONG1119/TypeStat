/**
 * 浏览器里的整套界面预览 —— **仅开发时使用**。
 *
 * 真数据来自 Tauri 后端，在浏览器里跑不起来（`invoke` 是空桥）。
 * 这个入口把桥垫成一份固定的假数据，于是改样式不用开 Tauri 壳。
 * 跑 `npm run dev` 后打开 /app-preview.html。
 *
 * 假数据只够验版式，**不要拿它核对统计逻辑**。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installMockBackend } from "./dev/mockBackend";
import "./styles.css";

installMockBackend();

// 动态 import 而不是写在顶上：App 一挂载就会打 current_day，
// 垫桥必须先跑完。这样写时这个顺序是显然的，不用去回忆 ESM 的求值顺序。
const { default: App } = await import("./App");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
