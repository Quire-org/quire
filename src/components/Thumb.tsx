import { useEffect, useRef, useState, type MouseEvent } from "react";
import { fileSrc, rawPreviewUrl } from "../lib/api";
import { videoPoster } from "../lib/poster";
import type { MediaItem } from "../lib/types";
import { Check, Play, Star } from "@phosphor-icons/react";

/**
 * Grid tile. Media loads once the tile is near the viewport (or immediately
 * when `eager`, for virtualised grids that only mount what is visible).
 */
export function Thumb({
  item,
  rating,
  onClick,
  selected,
  label,
  scanned,
  eager,
  onAspect,
  aspect,
}: {
  item: MediaItem;
  rating?: number;
  onClick: (e: MouseEvent) => void;
  selected?: boolean;
  label?: string;
  /** Known to the duplicate scanner (fingerprinted and not a duplicate so far). */
  scanned?: boolean;
  eager?: boolean;
  /** Reports width / height of the loaded media, for masonry layouts. */
  onAspect?: (key: string, ratio: number) => void;
  /** Aspect ratio to size the media box with (width / height). Default 4:3. */
  aspect?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!!eager);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (eager) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [eager]);

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

  const ratio = aspect && aspect > 0 ? aspect : 4 / 3;
  return (
    <div ref={ref} className={`thumb ${selected ? "selected" : ""}`} onClick={onClick} title={item.primary}>
      <div className="thumb-media" style={{ paddingTop: `${100 / ratio}%` }}>
        {url ? (
          <img
            src={url}
            alt=""
            decoding="async"
            draggable={false}
            onLoad={(e) => {
              const im = e.currentTarget;
              if (onAspect && im.naturalWidth && im.naturalHeight) onAspect(item.key, im.naturalWidth / im.naturalHeight);
            }}
          />
        ) : (
          visible && <div className="thumb-ph mono">{item.kind === "video" ? <Play /> : item.kind.toUpperCase()}</div>
        )}
        {item.kind === "video" && url && (
          <span className="thumb-play">
            <Play />
          </span>
        )}
        {rating != null && (
          <span className="badge accent tile-rating">
            <Star /> {rating}
          </span>
        )}
        {selected && (
          <span className="tile-check">
            <Check />
          </span>
        )}
      </div>
      <div className="thumb-meta">
        <span className="thumb-name mono">{item.name}</span>
        <span className="thumb-badges">
          {scanned && (
            <span className="badge ok" title="Fingerprinted by the duplicate scanner">
              <Check />
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
