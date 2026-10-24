import { useEffect, useRef, useState, type MouseEvent } from "react";
import { mediaUrl, rawPreviewUrl } from "../lib/api";
import type { MediaItem } from "../lib/types";
import { useEdit } from "../editStore";
import { useFitSize, type Natural } from "./FitImage";

/**
 * Side by side: the original on the left, a live preview of the pipeline on
 * the right. Images are previewed on a canvas (rotate, flip, crop, resize);
 * videos with CSS transforms plus a crop frame and trimmed playback. The
 * crop tool draws a rectangle on the preview in normalised coordinates.
 */
export function EditStage({ item }: { item: MediaItem }) {
  return (
    <div className="edit-stage">
      <div className="edit-pane">
        <div className="label edit-pane-label">Original</div>
        <Original item={item} />
      </div>
      <div className="edit-pane">
        <div className="label edit-pane-label">Preview</div>
        <Preview item={item} />
      </div>
    </div>
  );
}

function useSourceUrl(item: MediaItem) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    (item.kind === "raw" ? rawPreviewUrl(item.primary) : Promise.resolve(mediaUrl(item))).then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [item.primary, item.kind, item.vaultId]);
  return url;
}

function Original({ item }: { item: MediaItem }) {
  const url = useSourceUrl(item);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [nat, setNat] = useState<Natural | null>(null);
  const size = useFitSize(box, nat, "fit");
  if (!url) return <div className="fitbox" />;
  return (
    <div className="fitbox" ref={setBox}>
      {item.kind === "video" ? (
        <video className={`stage-media ${size ? "sized" : ""}`} style={size ?? undefined} src={url} muted loop autoPlay playsInline onLoadedMetadata={(e) => setNat({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })} />
      ) : (
        <img className={`stage-media ${size ? "sized" : ""}`} style={size ?? undefined} src={url} alt="" draggable={false} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
      )}
    </div>
  );
}

function Preview({ item }: { item: MediaItem }) {
  const url = useSourceUrl(item);
  const p = useEdit((s) => s.pipeline);
  const cropping = useEdit((s) => s.cropping);
  const cropAspect = useEdit((s) => s.cropAspect);
  const setP = useEdit((s) => s.set);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [nat, setNat] = useState<Natural | null>(null); // natural size AFTER rotation
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  // Rotated/flipped frame size: what crop fractions refer to.
  const rotated = p.rotate === 90 || p.rotate === 270;

  // Image preview: draw rotate/flip/crop onto the canvas.
  useEffect(() => {
    if (item.kind === "video" || !url) return;
    let alive = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!alive) return;
      imgRef.current = img;
      draw();
    };
    img.src = url;
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, item.kind]);

  const draw = () => {
    const img = imgRef.current;
    const c = canvasRef.current;
    if (!img || !c) return;
    const rw = rotated ? img.naturalHeight : img.naturalWidth;
    const rh = rotated ? img.naturalWidth : img.naturalHeight;
    const [cx, cy, cw, ch] = p.crop ?? [0, 0, 1, 1];
    // Keep the preview canvas modest; the real result is computed in Rust.
    const scale = Math.min(1, 1600 / Math.max(rw * cw, rh * ch));
    c.width = Math.max(1, Math.round(rw * cw * scale));
    c.height = Math.max(1, Math.round(rh * ch * scale));
    const ctx = c.getContext("2d")!;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(-cx * rw, -cy * rh);
    ctx.translate(rw / 2, rh / 2);
    ctx.rotate((p.rotate * Math.PI) / 180);
    ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    ctx.restore();
    setNat({ w: c.width, h: c.height });
  };
  useEffect(draw, [p.rotate, p.flipH, p.flipV, p.crop]); // eslint-disable-line react-hooks/exhaustive-deps

  // Video preview: transforms + trimmed looping.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = true;
    v.playbackRate = Math.min(4, Math.max(0.25, p.speed ?? 1));
    const onTime = () => {
      if (p.trim && (v.currentTime < p.trim[0] - 0.05 || v.currentTime > p.trim[1])) v.currentTime = p.trim[0];
    };
    v.addEventListener("timeupdate", onTime);
    if (p.trim) v.currentTime = p.trim[0];
    return () => v.removeEventListener("timeupdate", onTime);
  }, [p.trim, p.speed, url]);

  // The box the (uncropped, rotated) frame is fitted into, for crop dragging.
  const frameNat: Natural | null = nat && item.kind === "video" ? (rotated ? { w: nat.h, h: nat.w } : nat) : nat;
  const size = useFitSize(box, item.kind === "video" ? frameNat : nat, "fit");

  const toFrac = (e: MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const rectFrom = (d: { x0: number; y0: number; x1: number; y1: number }): [number, number, number, number] => {
    let x = Math.min(d.x0, d.x1);
    let y = Math.min(d.y0, d.y1);
    let w = Math.abs(d.x1 - d.x0);
    let h = Math.abs(d.y1 - d.y0);
    if (cropAspect && size) {
      // Aspect in pixels of the displayed frame; convert to fractions.
      const frameAspect = size.width / size.height;
      const targetH = (w * frameAspect) / cropAspect;
      if (targetH <= 1 - y) h = targetH;
      else {
        h = 1 - y;
        w = (h * cropAspect) / frameAspect;
      }
      if (d.x1 < d.x0) x = d.x0 - w;
      if (d.y1 < d.y0) y = d.y0 - h;
      x = Math.max(0, x);
      y = Math.max(0, y);
    }
    return [x, y, Math.max(0.02, w), Math.max(0.02, h)];
  };

  // While cropping, show the whole frame with the rectangle; otherwise the cropped canvas.
  const showWhole = cropping && item.kind !== "video";
  const wholeCrop = p.crop;
  useEffect(() => {
    if (showWhole && wholeCrop) {
      // Temporarily draw uncropped for the overlay.
      const img = imgRef.current;
      const c = canvasRef.current;
      if (!img || !c) return;
      const rw = rotated ? img.naturalHeight : img.naturalWidth;
      const rh = rotated ? img.naturalWidth : img.naturalHeight;
      const scale = Math.min(1, 1600 / Math.max(rw, rh));
      c.width = Math.round(rw * scale);
      c.height = Math.round(rh * scale);
      const ctx = c.getContext("2d")!;
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(rw / 2, rh / 2);
      ctx.rotate((p.rotate * Math.PI) / 180);
      ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      ctx.restore();
      setNat({ w: c.width, h: c.height });
    } else if (!showWhole) draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWhole]);

  const rect = drag ? rectFrom(drag) : cropping || item.kind === "video" ? p.crop : null;

  return (
    <div className="fitbox" ref={setBox}>
      <div
        className={`edit-frame ${cropping ? "cropping" : ""}`}
        style={size ? { width: size.width, height: size.height } : undefined}
        onMouseDown={(e) => {
          if (!cropping) return;
          const f = toFrac(e);
          setDrag({ x0: f.x, y0: f.y, x1: f.x, y1: f.y });
        }}
        onMouseMove={(e) => {
          if (!drag) return;
          const f = toFrac(e);
          setDrag({ ...drag, x1: f.x, y1: f.y });
        }}
        onMouseUp={() => {
          if (!drag) return;
          const r = rectFrom(drag);
          setDrag(null);
          if (r[2] > 0.03 && r[3] > 0.03) setP({ crop: r });
        }}
        onMouseLeave={() => drag && setDrag(null)}
      >
        {item.kind === "video" ? (
          <video
            ref={videoRef}
            className="stage-media sized edit-video"
            style={{ width: size ? (rotated ? size.height : size.width) : undefined, height: size ? (rotated ? size.width : size.height) : undefined, transform: `rotate(${p.rotate}deg) scale(${p.flipH ? -1 : 1}, ${p.flipV ? -1 : 1})` }}
            src={url ?? undefined}
            autoPlay
            loop
            muted
            playsInline
            onLoadedMetadata={(e) => setNat({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
          />
        ) : (
          <canvas ref={canvasRef} className="stage-media sized" style={size ? { width: size.width, height: size.height } : undefined} />
        )}
        {rect && (
          <div className="crop-rect" style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }} />
        )}
        {rect && <div className="crop-dim" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${rect[0] * 100}% ${rect[1] * 100}%, ${rect[0] * 100}% ${(rect[1] + rect[3]) * 100}%, ${(rect[0] + rect[2]) * 100}% ${(rect[1] + rect[3]) * 100}%, ${(rect[0] + rect[2]) * 100}% ${rect[1] * 100}%, ${rect[0] * 100}% ${rect[1] * 100}%)` }} />}
      </div>
    </div>
  );
}
