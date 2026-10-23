import { useState } from "react";

export function RatingBar({ value, onChange, label = "Rating" }: { value: number | undefined; onChange: (r: number | null) => void; label?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className="rating" onMouseLeave={() => setHover(null)}>
      <span className="label">{label}</span>
      <div className="rating-segs">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            className={`rating-seg ${n <= shown ? "on" : ""} ${n <= shown && shown >= 9 ? "hot" : ""} ${hover != null && n <= hover ? "preview" : ""}`}
            title={`Rate ${n} (key ${n % 10})`}
            onMouseEnter={() => setHover(n)}
            onClick={() => onChange(value === n ? null : n)}
          >
            <span className="rating-key">{n % 10}</span>
          </button>
        ))}
      </div>
      <span className="rating-value mono">{value != null ? `${value}/10` : "—"}</span>
      <button className="btn ghost sm" title="Clear rating (U)" onClick={() => onChange(null)} disabled={value == null}>
        Clear <kbd className="kbd">U</kbd>
      </button>
    </div>
  );
}
