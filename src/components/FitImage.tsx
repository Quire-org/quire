import { useEffect, useLayoutEffect, useState } from "react";
import { ZoomBox } from "./ZoomBox";

export type FitMode = "fit" | "fill";
export interface Natural {
  w: number;
  h: number;
}

/**
 * Explicit pixel size for media inside `containerRef` from its natural
 * aspect ratio. Avoids percentage heights and `object-fit`, which WebKit
 * gets wrong for EXIF-rotated (portrait) photos and inside grid areas.
 */
export function useFitSize(el: HTMLElement | null, natural: Natural | null, mode: FitMode): { width: number; height: number } | null {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setBox((b) => (b && b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  if (!box || !natural || !natural.w || !natural.h || !box.w || !box.h) return null;
  const sx = box.w / natural.w;
  const sy = box.h / natural.h;
  const scale = mode === "fill" ? Math.max(sx, sy) : Math.min(sx, sy);
  return { width: Math.round(natural.w * scale), height: Math.round(natural.h * scale) };
}

/** An image fitted (or filling) its parent box, portrait or landscape. `zoomable` adds the click-to-loupe. */
export function FitImage({ src, mode = "fit", className = "", alt = "", onError, blurBackdrop, zoomable }: { src: string; mode?: FitMode; className?: string; alt?: string; onError?: () => void; blurBackdrop?: boolean; zoomable?: boolean }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  useEffect(() => setNatural(null), [src]);
  const size = useFitSize(el, natural, mode);
  const img = (
    <img
      key={src}
      className={`stage-media ${size ? "sized" : ""}`}
      src={src}
      alt={alt}
      draggable={false}
      style={size ?? undefined}
      onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      onError={onError}
    />
  );
  return (
    <div ref={setEl} className={`fitbox ${className}`}>
      {blurBackdrop && <img className="fit-backdrop" src={src} alt="" aria-hidden draggable={false} />}
      {zoomable ? (
        <ZoomBox fitted={size} natural={natural}>
          {img}
        </ZoomBox>
      ) : (
        img
      )}
    </div>
  );
}
