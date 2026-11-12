import React, { useRef, type ReactNode, type MouseEvent } from "react";
import { useStore } from "../store";
import { IS_MOBILE } from "../lib/platform";

/** How long two taps are apart at most, to be a double tap. */
const DOUBLE_TAP_MS = 260;

/**
 * Lightroom-style loupe. Wraps a fitted media element: a click zooms to the
 * chosen level at the cursor (focal point kept under it), another click
 * returns to fit; drag to pan while zoomed. Zoom state lives in the store so
 * the two edit panes move together.
 */
export function ZoomBox({ children, fitted, natural, className = "", enabled = true, clickToggles = true }: { children: ReactNode; fitted: { width: number; height: number } | null; natural: { w: number; h: number } | null; className?: string; enabled?: boolean; clickToggles?: boolean }) {
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);

  // Scale relative to the fitted size so that `level` image pixels show per CSS pixel.
  const scale = fitted && natural && zoom.level > 0 ? (natural.w * zoom.level) / fitted.width : 1;
  const active = enabled && scale > 1.001;

  // Keep the pan within the image bounds (with the fitted box as viewport).
  const clampPan = (px: number, py: number) => {
    if (!fitted) return { px, py };
    const w = fitted.width * scale;
    const h = fitted.height * scale;
    const maxX = Math.max(0, (w - fitted.width) / 2);
    const maxY = Math.max(0, (h - fitted.height) / 2);
    return { px: Math.min(maxX, Math.max(-maxX, px)), py: Math.min(maxY, Math.max(-maxY, py)) };
  };

  // A click that closes an open menu or list (a bar's dropdown, say) only closes it: no zoom. Seen at
  // mousedown, before the menu's own listener closes it.
  const closing = useRef(false);
  // Listeners are attached at mousedown (a ref change does not re-render, so an effect would miss it).
  const onMouseDown = (e: MouseEvent) => {
    closing.current = !!document.querySelector(".pop, .sel-pop, .context-menu");
    if (!enabled || !active) return;
    e.preventDefault();
    const base = useStore.getState().zoom.pan;
    drag.current = { x: e.clientX, y: e.clientY, px: base.px, py: base.py, moved: false };
    const onMove = (ev: globalThis.MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      const dy = ev.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      const z = useStore.getState().zoom;
      setZoom({ ...z, pan: clampPan(d.px + dx, d.py + dy) });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      // Leave `moved` readable for the click that follows a drag, then clear.
      setTimeout(() => {
        drag.current = null;
      }, 0);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onClick = (e: MouseEvent) => {
    if (closing.current) return void (closing.current = false);
    if (!enabled || !fitted || !clickToggles) return;
    if (drag.current?.moved) return;
    // On a phone it takes a double tap: one tap is the bars'.
    if (IS_MOBILE && Date.now() - lastTap.current > DOUBLE_TAP_MS) return void (lastTap.current = Date.now());
    lastTap.current = 0;
    if (active) {
      setZoom({ level: 0, focal: { x: 0.5, y: 0.5 }, pan: { px: 0, py: 0 } });
      return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const level = zoom.preferredLevel;
    // Pan so the focal point stays under the cursor after scaling about the centre.
    const s = natural ? (natural.w * level) / fitted.width : 2;
    const px = (0.5 - fx) * fitted.width * (s - 1);
    const py = (0.5 - fy) * fitted.height * (s - 1);
    setZoom({ level, focal: { x: fx, y: fy }, pan: { px, py } });
  };

  /** Zoomed to `level` (image pixels per CSS pixel; fit up to 8:1) with the image point at a place on screen staying there. */
  const zoomAt = (r: DOMRect, clientX: number, clientY: number, wanted: number) => {
    if (!fitted || !natural) return;
    const z = useStore.getState().zoom;
    const fit = fitted.width / natural.w;
    const current = z.level > 0 ? z.level : fit;
    const qx = clientX - (r.left + r.width / 2);
    const qy = clientY - (r.top + r.height / 2);
    const next = Math.min(8, Math.max(fit, wanted));
    if (next <= fit * 1.001) {
      setZoom({ level: 0, focal: { x: 0.5, y: 0.5 }, pan: { px: 0, py: 0 } });
      return;
    }
    const s0 = (natural.w * current) / fitted.width;
    const s1 = (natural.w * next) / fitted.width;
    const ux = (qx - z.pan.px) / s0;
    const uy = (qy - z.pan.py) / s0;
    const w = fitted.width * s1;
    const h = fitted.height * s1;
    const maxX = Math.max(0, (w - fitted.width) / 2);
    const maxY = Math.max(0, (h - fitted.height) / 2);
    setZoom({ level: next, focal: { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height }, pan: { px: Math.min(maxX, Math.max(-maxX, qx - s1 * ux)), py: Math.min(maxY, Math.max(-maxY, qy - s1 * uy)) } });
  };

  // Fingers: two pinch about their middle, one pans while zoomed.
  const touch = useRef<{ dist: number; level: number } | { x: number; y: number; px: number; py: number } | null>(null);
  const lastTap = useRef(0);
  const spread = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onTouchStart = (e: React.TouchEvent) => {
    if (!enabled || !fitted || !natural) return;
    const z = useStore.getState().zoom;
    if (e.touches.length === 2) touch.current = { dist: spread(e.touches), level: z.level > 0 ? z.level : fitted.width / natural.w };
    else if (e.touches.length === 1 && active) touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, px: z.pan.px, py: z.pan.py };
    else touch.current = null;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const t = touch.current;
    if (!t) return;
    if ("dist" in t && e.touches.length === 2) {
      zoomAt((e.currentTarget as HTMLElement).getBoundingClientRect(), (e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2, t.level * (spread(e.touches) / t.dist));
    } else if ("x" in t && e.touches.length === 1) {
      lastTap.current = 0;
      setZoom({ ...useStore.getState().zoom, pan: clampPan(t.px + e.touches[0].clientX - t.x, t.py + e.touches[0].clientY - t.y) });
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) touch.current = null;
  };

  // Pinch (a wheel with ctrl, as trackpads send it) zooms about the cursor, from fit up to 8:1; a plain
  // two-finger scroll pans while zoomed. Both work while a plugin's brush has the clicks.
  const onWheel = (e: React.WheelEvent) => {
    if (!enabled || !fitted || !natural) return;
    const z = useStore.getState().zoom;
    const fit = fitted.width / natural.w;
    const current = z.level > 0 ? z.level : fit;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt((e.currentTarget as HTMLElement).getBoundingClientRect(), e.clientX, e.clientY, current * Math.exp(-e.deltaY * 0.01));
    } else if (active) {
      e.preventDefault();
      setZoom({ ...z, pan: clampPan(z.pan.px - e.deltaX, z.pan.py - e.deltaY) });
    }
  };

  const style = active ? { transform: `translate(${zoom.pan.px}px, ${zoom.pan.py}px) scale(${scale})`, transformOrigin: "50% 50%" } : undefined;
  return (
    <div className={`zoombox ${active ? "zoomed" : enabled && clickToggles ? "zoomable" : ""} ${className}`} onMouseDown={onMouseDown} onClick={onClick} onWheel={onWheel} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div className="zoom-inner" style={style}>
        {children}
      </div>
      {active && (
        <div className="zoom-badge mono">
          {Math.round(zoom.level * 100)}%
        </div>
      )}
    </div>
  );
}
