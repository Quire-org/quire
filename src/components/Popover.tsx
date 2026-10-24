import { useEffect, useRef, type ReactNode } from "react";

/** Small anchored panel that opens above its trigger (used in the bottom bar). Closes on outside click or Escape. */
export function Popover({ open, onClose, trigger, children, width = 300 }: { open: boolean; onClose: () => void; trigger: ReactNode; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
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
      {open && (
        <div className="pop panel" style={{ width }}>
          {children}
        </div>
      )}
    </div>
  );
}
