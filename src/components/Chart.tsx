import { useEffect, useRef } from "react";
import * as echarts from "echarts";

interface Props {
  option: echarts.EChartsOption;
  height?: number;
}

/**
 * 极简 ECharts 包装。
 *
 * 刻意不引入 echarts-for-react —— 那层抽象在多主题切换时容易漏掉
 * dispose / resize，直接管理实例更可控。
 */
export function Chart({ option, height = 280 }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!holder.current) return;
    const instance = echarts.init(holder.current, undefined, { renderer: "canvas" });
    chart.current = instance;

    // 窗口尺寸变化时重绘。用 ResizeObserver 而不是 window.resize，
    // 因为侧边栏折叠之类不触发 window 事件。
    const ro = new ResizeObserver(() => instance.resize());
    ro.observe(holder.current);

    return () => {
      ro.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    // notMerge = true：主题切换时必须整体替换，否则残留旧配色。
    chart.current?.setOption(option, true);
  }, [option]);

  return <div ref={holder} style={{ height, width: "100%" }} />;
}
