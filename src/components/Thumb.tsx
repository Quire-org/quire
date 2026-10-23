import { useEffect, useRef, useState } from "react";
import { fileSrc, rawPreviewUrl } from "../lib/api";
import { videoPoster } from "../lib/poster";
import type { MediaItem } from "../lib/types";

/** Grid tile. RAW previews and video posters are fetched once the tile scrolls into view. */
export function Thumb({
  item,
  rating,
  onClick,
  selected,
  label,
  scanned,
}: {
  item: MediaItem;
  rating?: number;
  onClick: () => void;
  selected?: boolean;
  label?: string;
  /** Known to the duplicate scanner (fingerprinted and not a duplicate so far). */
  scanned?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setUrl(null);
    const p = item.kind === "image" ? Promise.resolve(fileSrc(item.primary)) : item.kind === "raw" ? rawPreviewUrl(item.primary) : videoPoster(fileSrc(item.primary));
    p.then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, item.kind, item.primary]);

  return (
    <div ref={ref} className={`thumb ${selected ? "selected" : ""}`} onClick={onClick} title={item.primary}>
      <div className="thumb-media">
        {url ? (
          <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          visible && <div className="thumb-ph mono">{item.kind === "video" ? "▶" : item.kind.toUpperCase()}</div>
        )}
        {item.kind === "video" && url && <span className="thumb-play">▶</span>}
        {rating != null && <span className="badge accent tile-rating">★ {rating}</span>}
      </div>
      <div className="thumb-meta">
        <span className="thumb-name mono">{item.name}</span>
        <span className="thumb-badges">
          {scanned && (
            <span className="badge ok" title="Fingerprinted by the duplicate scanner">
              ✓
            </span>
          )}
          {item.kind === "video" && <span className="badge accent2">VID</span>}
          {item.hasRaw && <span className="badge">RAW</span>}
          {label && <span className="badge accent">{label}</span>}
        </span>
      </div>
    </div>
  );
}
