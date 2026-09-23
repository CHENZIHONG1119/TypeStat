interface Props {
  label: string;
  value: string;
  /** 补充说明，例如"其中删除 320 次" */
  hint?: string;
  /** 作为主指标时放大显示 */
  hero?: boolean;
}

/**
 * 指标卡。
 *
 * 单个数值不该画成只有一根柱子的柱状图——直接用数字。
 */
export function StatTile({ label, value, hint, hero }: Props) {
  return (
    <div className={`tile${hero ? " tile-hero" : ""}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {hint && <div className="tile-hint">{hint}</div>}
    </div>
  );
}
