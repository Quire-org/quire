import { useLayoutEffect, type RefObject } from "react";

/** How close a floating layer comes to the window's edges. */
const EDGE = 8;

/**
 * A menu or panel opened from a button (`anchor`), drawn over everything (in a portal, so the panel
 * it was opened in can't clip it): below the button when it fits there or there is more room below
 * than above, else above it; its left edge at the button's, moved in to stay inside the window; no
 * taller than the room it has. `matchWidth`: at least as wide as the button. Placed again as the
 * window resizes or anything scrolls.
 */
export function useFloating(anchor: RefObject<HTMLElement | null>, pop: RefObject<HTMLElement | null>, open: boolean, { gap = 4, matchWidth = false } = {}) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current;
      const p = pop.current;
      if (!a || !p) return;
      const r = a.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (matchWidth) p.style.minWidth = `${r.width}px`;
      const below = vh - r.bottom - gap - EDGE;
      const above = r.top - gap - EDGE;
      const down = p.scrollHeight <= below || below >= above;
      const w = p.offsetWidth;
      Object.assign(p.style, {
        position: "fixed",
        top: down ? `${r.bottom + gap}px` : "auto",
        bottom: down ? "auto" : `${vh - r.top + gap}px`,
        left: `${Math.max(EDGE, Math.min(r.left, vw - w - EDGE))}px`,
        right: "auto",
        maxHeight: `${Math.max(120, down ? below : above)}px`,
        overflowY: "auto",
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, pop, gap, matchWidth]);
}

/** A press inside a floating menu or panel: not outside whatever opened it (a list opened from a popover, say). */
export const inFloating = (t: EventTarget | null) => t instanceof Element && !!t.closest(".sel-pop, .pop");
