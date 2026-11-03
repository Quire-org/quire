import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { inFloating, useFloating } from "./floating";
import { useOpenSound } from "../lib/sounds";

/**
 * A small panel opened from a button: below it, or above when there is more room there (see
 * useFloating), over everything. Closes on a click outside it (a list opened from inside it counts as
 * inside) or Escape.
 */
export function Popover({ open, onClose, trigger, children, width = 300 }: { open: boolean; onClose: () => void; trigger: ReactNode; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useFloating(ref, pop, open, { gap: 8 });
  useOpenSound(open);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !inFloating(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      } else if (!(e.target instanceof HTMLInputElement)) {
        // Keep the viewer's single-key shortcuts from firing while the popover is open.
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose]);
  return (
    <div className="pop-anchor" ref={ref}>
      {trigger}
      {open &&
        createPortal(
          <div ref={pop} className="pop panel" style={{ width }}>
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}
