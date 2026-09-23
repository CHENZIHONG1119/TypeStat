import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 要求 dev server 端口固定，且不要监听 src-tauri 的变化（否则改 Rust 会触发前端重载）。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome110",
    sourcemap: false,
  },
});
