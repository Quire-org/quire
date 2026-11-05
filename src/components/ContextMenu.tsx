import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useOpenSound } from "../lib/sounds";
import { inFloating } from "./floating";
import { createPortal } from "react-dom";

export interface MenuItem {
  label?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A line of controls instead of a plain entry (a picker, say). */
  content?: ReactNode;
  separator?: boolean;
}

/** The least room kept between a menu and the window's edge. */
const EDGE = 8;

/** A right-click menu at the cursor. Closes on a click elsewhere, Escape, or after an entry is chosen. */
export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number } | null; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Where it sits, from its own size once it is there (a tag editor in it makes it taller than its entries).
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useOpenSound(!!at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!at || !el) return setPlace(null);
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      const [vw, vh] = [window.innerWidth, window.innerHeight];
      // At the pointer, opening right and down; else left of it or upwards; with room for neither, moved
      // in just far enough; taller than the window, from its top (it scrolls).
      const along = (p: number, size: number, room: number) => (p + size + EDGE <= room ? p : p - size >= EDGE ? p - size : Math.max(EDGE, room - size - EDGE));
      setPlace({ left: along(at.x, width, vw), top: along(at.y, height, vh) });
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [at]);
  useEffect(() => {
    if (!at) return;
    // Seen before anything else handles the press (capture), so a tile or a canvas that stops
    // propagation can't keep the menu open; scrolling and leaving the window close it too.
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !inFloating(e.target)) onClose();
    };
    const onBlur = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", onDown, { capture: true, passive: true });
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", onDown, { capture: true });
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [at, onClose]);
  if (!at) return null;
  return createPortal(
    <div ref={ref} className="context-menu panel" style={{ left: place?.left ?? at.x, top: place?.top ?? at.y, width: 260, maxHeight: `calc(100vh - ${EDGE * 2}px)` }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <hr key={i} className="rule" />
        ) : it.content ? (
          <div key={i} className="context-row">
            {it.content}
          </div>
        ) : (
          <button
            key={i}
            className={`context-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
          >
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
