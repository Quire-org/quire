import { createContext, useContext, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";
import { cue } from "../lib/sounds";

/** Inside a Settings page, a dialog shows as the page's body: no backdrop, title or Esc of its own. */
export const AsPage = createContext(false);

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const asPage = useContext(AsPage);
  // A dialog opening and closing (one shown as a Settings page is part of it, so isn't heard).
  useEffect(() => {
    if (asPage) return;
    cue("open");
    return () => cue("close");
  }, [asPage]);
  // Modals close on Escape regardless of which screen is behind them.
  useEffect(() => {
    if (asPage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Only the modal reacts; screen-level Escape handlers on window must not fire too.
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, asPage]);

  // A dialog it opens is a dialog again.
  if (asPage) return <AsPage.Provider value={false}><div className="modal-body settings-embed">{children}</div></AsPage.Provider>;
  // Drawn over everything, not where it is opened: a panel it opens from (a person's suggested
  // faces, say) may clip what is inside it to its own shape, as the themes with cut corners do.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal panel ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose}>
            <X /> <kbd className="kbd">Esc</kbd>
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
