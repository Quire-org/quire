import type { ReactNode } from "react";

/** A number with a caption, for compact dashboards in sidebars and dialogs. */
export function Stat({ value, label, accent, wide, onClick, hint }: { value: ReactNode; label: string; accent?: boolean; wide?: boolean; onClick?: () => void; hint?: string }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={`stat ${accent ? "accent" : ""} ${wide ? "wide" : ""} ${onClick ? "clickable" : ""}`} onClick={onClick} title={hint} type={onClick ? "button" : undefined}>
      <div className="stat-v mono">{value}</div>
      <div className="stat-k">{label}</div>
    </Tag>
  );
}
