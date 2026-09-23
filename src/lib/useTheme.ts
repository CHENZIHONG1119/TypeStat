import { createContext, useContext, useEffect, useState } from "react";
import { TOKENS, type Mode, type Tokens } from "../theme";

/** 由 App 提供当前主题，页面从这里取色，避免各页面各存一份主题状态。 */
export const ThemeContext = createContext<Mode>("light");

/** 取当前主题的配色令牌。 */
export function useTokens(): Tokens {
  return TOKENS[useContext(ThemeContext)];
}

/**
 * 解析当前主题。
 *
 * 优先级：用户手动选择 > 系统偏好。
 * 与 palette 规范一致——手动切换必须能同时压过系统的深色和浅色。
 */
export function useTheme(): [Mode, (m: Mode | null) => void] {
  const [override, setOverride] = useState<Mode | null>(() => {
    const saved = localStorage.getItem("typestat-theme");
    return saved === "light" || saved === "dark" ? saved : null;
  });
  const [system, setSystem] = useState<Mode>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (override) {
      localStorage.setItem("typestat-theme", override);
      document.documentElement.dataset.theme = override;
    } else {
      localStorage.removeItem("typestat-theme");
      delete document.documentElement.dataset.theme;
    }
  }, [override]);

  return [override ?? system, setOverride];
}
