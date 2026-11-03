import { useEffect, useRef, type ReactNode } from "react";
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

/** A right-click menu at the cursor. Closes on a click elsewhere, Escape, or after an entry is chosen. */
export function ContextMenu({ at, items, onClose }: { at: { x: number; y: number } | null; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useOpenSound(!!at);
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
  // Kept on screen: flipped to the left or up when it would run off the edge.
  const w = 260;
  const left = Math.min(at.x, window.innerWidth - w - 8);
  const top = Math.min(at.y, window.innerHeight - 8 - Math.min(400, items.length * 34 + 12));
  return createPortal(
    <div ref={ref} className="context-menu panel" style={{ left, top, width: w }} onContextMenu={(e) => e.preventDefault()}>
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
