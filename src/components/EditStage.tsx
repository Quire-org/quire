import { useEffect, useRef, useState, type MouseEvent } from "react";
import { mediaUrl, rawPreviewUrl } from "../lib/api";
import type { MediaItem } from "../lib/types";
import { useEdit } from "../editStore";
import { useFitSize, type Natural } from "./FitImage";

type Rect = [number, number, number, number];
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const MIN = 0.05;

/**
 * Side by side: the original on the left, a live preview of the pipeline on
 * the right. Images are previewed on a canvas (rotate, flip, crop); videos
 * with CSS transforms, a crop frame and trimmed playback. Cropping works like
 * iOS: the window is always there, drag its edges, corners or middle.
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
  const [nat, setNat] = useState<Natural | null>(null); // size of what is displayed in the frame
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rotated = p.rotate === 90 || p.rotate === 270;
  const isVideo = item.kind === "video";
  // While cropping an image, the whole (uncropped) frame is shown with the window on top.
  const showWhole = isVideo || cropping;

  /* ---------- image preview on a canvas ---------- */
  const draw = () => {
    const img = imgRef.current;
    const c = canvasRef.current;
    if (!img || !c) return;
    const rw = rotated ? img.naturalHeight : img.naturalWidth;
    const rh = rotated ? img.naturalWidth : img.naturalHeight;
    const [cx, cy, cw, ch] = showWhole ? [0, 0, 1, 1] : (p.crop ?? [0, 0, 1, 1]);
    const scale = Math.min(1, 1600 / Math.max(rw * cw, rh * ch));
    c.width = Math.max(1, Math.round(rw * cw * scale));
    c.height = Math.max(1, Math.round(rh * ch * scale));
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
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

  useEffect(() => {
    if (isVideo || !url) return;
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
  }, [url, isVideo]);

  useEffect(() => {
    if (!isVideo) draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.rotate, p.flipH, p.flipV, p.crop, showWhole]);

  /* ---------- video preview: transforms + trimmed looping ---------- */
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

  // Frame the content is fitted into (video: rotated natural size).
  const frameNat: Natural | null = nat && isVideo && rotated ? { w: nat.h, h: nat.w } : nat;
  const size = useFitSize(box, frameNat, "fit");
  const frameAspect = size ? size.width / size.height : 1;

  /* ---------- crop window ---------- */
  const cropRect: Rect = p.crop ?? [0, 0, 1, 1];
  const [dragging, setDragging] = useState<{ handle: Handle; startX: number; startY: number; rect: Rect } | null>(null);

  const clampRect = (r: Rect): Rect => {
    let [x, y, w, h] = r;
    w = Math.max(MIN, Math.min(1, w));
    h = Math.max(MIN, Math.min(1, h));
    if (cropAspect) {
      const k = frameAspect / cropAspect; // h = w * k in fractions
      if (h > 1) {
        h = 1;
        w = h / k;
      }
      if (w > 1) {
        w = 1;
        h = w * k;
      }
    }
    x = Math.min(Math.max(0, x), 1 - w);
    y = Math.min(Math.max(0, y), 1 - h);
    return [x, y, w, h];
  };
  const withAspect = (r: Rect, handle: Handle, anchorRight: boolean, anchorBottom: boolean): Rect => {
    if (!cropAspect) return r;
    let [x, y, w, h] = r;
    const k = frameAspect / cropAspect;
    if (handle === "n" || handle === "s") w = h / k;
    else h = w * k;
    if (anchorRight) x = r[0] + r[2] - w;
    if (anchorBottom) y = r[1] + r[3] - h;
    return [x, y, w, h];
  };
  const beginDrag = (e: MouseEvent, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging({ handle, startX: e.clientX, startY: e.clientY, rect: cropRect });
  };
  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: globalThis.MouseEvent) => {
      const fr = frameRef.current;
      if (!fr) return;
      const b = fr.getBoundingClientRect();
      const dx = (ev.clientX - dragging.startX) / b.width;
      const dy = (ev.clientY - dragging.startY) / b.height;
      let [x, y, w, h] = dragging.rect;
      const hdl = dragging.handle;
      if (hdl === "move") {
        setP({ crop: clampRect([x + dx, y + dy, w, h]) });
        return;
      }
      if (hdl.includes("e")) w = Math.max(MIN, w + dx);
      if (hdl.includes("s")) h = Math.max(MIN, h + dy);
      if (hdl.includes("w")) {
        const nx = Math.min(x + dx, x + w - MIN);
        w = x + w - nx;
        x = nx;
      }
      if (hdl.includes("n")) {
        const ny = Math.min(y + dy, y + h - MIN);
        h = y + h - ny;
        y = ny;
      }
      setP({ crop: clampRect(withAspect([x, y, w, h], hdl, hdl.includes("w"), hdl.includes("n"))) });
    };
    const onUp = () => setDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, cropAspect, frameAspect]);

  // Arming the tool: start from the whole frame (or keep the existing crop). A fixed aspect
  // snaps to the largest centred window of that shape.
  useEffect(() => {
    if (!cropping) return;
    if (cropAspect) {
      const k = frameAspect / cropAspect;
      let w = 1;
      let h = k;
      if (h > 1) {
        h = 1;
        w = 1 / k;
      }
      setP({ crop: [(1 - w) / 2, (1 - h) / 2, w, h] });
    } else if (!p.crop) {
      setP({ crop: [0, 0, 1, 1] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropping, cropAspect]);

  // Leaving the tool with a full-frame window means "no crop".
  useEffect(() => {
    if (!cropping && p.crop && p.crop[0] <= 0.001 && p.crop[1] <= 0.001 && p.crop[2] >= 0.999 && p.crop[3] >= 0.999) setP({ crop: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropping]);

  const rect: Rect | null = showWhole ? p.crop : null;
  const dim = rect ? `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${rect[0] * 100}% ${rect[1] * 100}%, ${rect[0] * 100}% ${(rect[1] + rect[3]) * 100}%, ${(rect[0] + rect[2]) * 100}% ${(rect[1] + rect[3]) * 100}%, ${(rect[0] + rect[2]) * 100}% ${rect[1] * 100}%, ${rect[0] * 100}% ${rect[1] * 100}%)` : undefined;

  return (
    <div className="fitbox" ref={setBox}>
      <div ref={frameRef} className={`edit-frame ${cropping ? "cropping" : ""}`} style={size ? { width: size.width, height: size.height } : undefined}>
        {isVideo ? (
          <video
            ref={videoRef}
            className="stage-media sized edit-video"
            style={{
              width: size ? (rotated ? size.height : size.width) : undefined,
              height: size ? (rotated ? size.width : size.height) : undefined,
              transform: `rotate(${p.rotate}deg) scale(${p.flipH ? -1 : 1}, ${p.flipV ? -1 : 1})`,
            }}
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
        {rect && <div className="crop-dim" style={{ clipPath: dim }} />}
        {rect && (
          <div className={`crop-rect ${cropping ? "live" : ""}`} style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }} onMouseDown={(e) => cropping && beginDrag(e, "move")}>
            {cropping && (
              <>
                <div className="crop-grid" />
                {HANDLES.map((h) => (
                  <div key={h} className={`crop-handle ${h}`} onMouseDown={(e) => beginDrag(e, h)} />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
