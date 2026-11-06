import { useEffect, useRef, useState, type MouseEvent } from "react";
import { canThumb, mediaUrl, rawPreviewUrl, thumbUrl } from "../lib/api";
import { useStore } from "../store";
import { videoPoster } from "../lib/poster";
import type { MediaItem } from "../lib/types";
import { Books, Check, FilmStrip, Play, Star } from "@phosphor-icons/react";

/** An album's shape (width / height): its pages', as Albums and Scrapbook covers show it. */
export const ALBUM_RATIO = 1280 / 1817;

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
  album,
  name,
  eager,
  onAspect,
  aspect,
}: {
  item: MediaItem;
  rating?: number;
  onClick: (e: MouseEvent) => void;
  selected?: boolean;
  label?: string;
  /** An album's cover: drawn on a little stack of pages, with the Albums icon by its name (a video has its play button and film strip). */
  album?: boolean;
  /** Shown instead of the file name (an album's name, say). */
  name?: string;
  eager?: boolean;
  /** Reports width / height of the loaded media, for masonry layouts. */
  onAspect?: (key: string, ratio: number) => void;
  /** Aspect ratio to size the media box with (width / height). Default 4:3. */
  aspect?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(!!eager);
  const [url, failed] = useThumbSrc(item, () => ref.current?.clientWidth || 240, visible);

  useEffect(() => {
    if (eager) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && setVisible(true)), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [eager]);

  const ratio = aspect && aspect > 0 ? aspect : 4 / 3;
  return (
    <div ref={ref} className={`thumb ${selected ? "selected" : ""} ${album ? "album" : ""}`} onClick={onClick} title={item.primary}>
      <div className="thumb-media" style={{ paddingTop: `${100 / ratio}%` }}>
        {url ? (
          <img
            src={url}
            alt=""
            decoding="async"
            draggable={false}
            onError={failed}
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
        <span className="thumb-name mono" title={name ?? item.name}>
          {album && <Books />}
          {item.kind === "video" && <FilmStrip />}
          {name ?? item.name}
        </span>
        <span className="thumb-badges">
          {item.hasRaw && <span className="badge">RAW</span>}
          {label && (
            <span className="badge accent thumb-label" title={label}>
              {label}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * What to show of an item, small: the backend's thumbnail `width()` wide (the original when it can't
 * make one: call the second value as the image fails), a RAW's preview, a video's first frame. Null
 * until `visible`, and while it comes.
 */
function useThumbSrc(item: MediaItem, width: () => number, visible = true): [string | null, () => void] {
  const root = useStore((s) => s.root);
  const [url, setUrl] = useState<string | null>(null);
  // A thumbnail the backend couldn't make: the original instead.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setUrl(null);
    const small = !full && root && canThumb(item);
    const p = small
      ? Promise.resolve(thumbUrl(root, item, width()))
      : item.kind === "image"
        ? Promise.resolve(mediaUrl(item))
        : item.kind === "raw"
          ? rawPreviewUrl(item.primary)
          : videoPoster(mediaUrl(item));
    p.then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, item.kind, item.primary, item.modified, root, full]); // eslint-disable-line react-hooks/exhaustive-deps
  return [url, () => void (url && (url.startsWith("thumb:") || url.includes("thumb.localhost")) && setFull(true))];
}

/** An item as a small picture, `size` pixels wide at most (a video by its first frame, a RAW by its preview). */
export function Mini({ item, size, className }: { item: MediaItem; size: number; className?: string }) {
  const [src, failed] = useThumbSrc(item, () => size);
  return src ? <img className={className} src={src} alt="" draggable={false} onError={failed} /> : null;
}
