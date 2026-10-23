import { useEffect, useRef, useState } from "react";
import { fileSrc, rawPreviewUrl } from "../lib/api";
import type { MediaItem } from "../lib/types";

/** Grid tile. RAW previews are fetched only once the tile scrolls into view. */
export function Thumb({
  item,
  rating,
  onClick,
  selected,
  label,
}: {
  item: MediaItem;
  rating?: number;
  onClick: () => void;
  selected?: boolean;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rawUrl, setRawUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)),
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || item.kind !== "raw") return;
    let alive = true;
    rawPreviewUrl(item.primary).then((u) => alive && setRawUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, item.kind, item.primary]);

  return (
    <div ref={ref} className={`thumb ${selected ? "selected" : ""}`} onClick={onClick} title={item.primary}>
      <div className="thumb-media">
        {visible && item.kind === "image" && <img src={fileSrc(item.primary)} alt="" loading="lazy" decoding="async" draggable={false} />}
        {visible && item.kind === "raw" && (rawUrl ? <img src={rawUrl} alt="" draggable={false} /> : <div className="thumb-ph mono">RAW</div>)}
        {visible && item.kind === "video" && <video src={fileSrc(item.primary)} muted preload="metadata" />}
      </div>
      <div className="thumb-meta">
        <span className="thumb-name mono">{item.name}</span>
        <span className="thumb-badges">
          {item.kind === "video" && <span className="badge accent2">VID</span>}
          {item.hasRaw && <span className="badge">RAW</span>}
          {label && <span className="badge accent">{label}</span>}
          {rating != null && <span className="badge accent">★ {rating}</span>}
        </span>
      </div>
    </div>
  );
}
