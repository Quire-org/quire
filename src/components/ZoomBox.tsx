import React, { useRef, type ReactNode, type MouseEvent } from "react";
import { useStore } from "../store";

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

  // Pinch (a wheel with ctrl, as trackpads send it) zooms about the cursor, from fit up to 8:1; a plain
  // two-finger scroll pans while zoomed. Both work while a plugin's brush has the clicks.
  const onWheel = (e: React.WheelEvent) => {
    if (!enabled || !fitted || !natural) return;
    const z = useStore.getState().zoom;
    const fit = fitted.width / natural.w;
    const current = z.level > 0 ? z.level : fit;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const qx = e.clientX - (r.left + r.width / 2);
      const qy = e.clientY - (r.top + r.height / 2);
      const next = Math.min(8, Math.max(fit, current * Math.exp(-e.deltaY * 0.01)));
      if (next <= fit * 1.001) {
        setZoom({ level: 0, focal: { x: 0.5, y: 0.5 }, pan: { px: 0, py: 0 } });
        return;
      }
      const s0 = (natural.w * current) / fitted.width;
      const s1 = (natural.w * next) / fitted.width;
      // The image point under the cursor stays under it.
      const ux = (qx - z.pan.px) / s0;
      const uy = (qy - z.pan.py) / s0;
      const w = fitted.width * s1;
      const h = fitted.height * s1;
      const maxX = Math.max(0, (w - fitted.width) / 2);
      const maxY = Math.max(0, (h - fitted.height) / 2);
      setZoom({ level: next, focal: { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, pan: { px: Math.min(maxX, Math.max(-maxX, qx - s1 * ux)), py: Math.min(maxY, Math.max(-maxY, qy - s1 * uy)) } });
    } else if (active) {
      e.preventDefault();
      setZoom({ ...z, pan: clampPan(z.pan.px - e.deltaX, z.pan.py - e.deltaY) });
    }
  };

  const style = active ? { transform: `translate(${zoom.pan.px}px, ${zoom.pan.py}px) scale(${scale})`, transformOrigin: "50% 50%" } : undefined;
  return (
    <div className={`zoombox ${active ? "zoomed" : enabled && clickToggles ? "zoomable" : ""} ${className}`} onMouseDown={onMouseDown} onClick={onClick} onWheel={onWheel}>
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
