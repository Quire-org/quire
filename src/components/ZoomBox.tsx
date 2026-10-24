import { useRef, type ReactNode, type MouseEvent } from "react";
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

  // Listeners are attached at mousedown (a ref change does not re-render, so an effect would miss it).
  const onMouseDown = (e: MouseEvent) => {
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

  const style = active ? { transform: `translate(${zoom.pan.px}px, ${zoom.pan.py}px) scale(${scale})`, transformOrigin: "50% 50%" } : undefined;
  return (
    <div className={`zoombox ${active ? "zoomed" : enabled && clickToggles ? "zoomable" : ""} ${className}`} onMouseDown={onMouseDown} onClick={onClick}>
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
