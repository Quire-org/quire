import { useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * A list screen comes back as it was left: each scroller's position is kept
 * under a key (the screen, plus what it was showing) and put back when the
 * element mounts again. The element given scrolls itself, or the first
 * scrolling descendant does.
 */
const positions = new Map<string, number>();

function scroller(el: HTMLElement): HTMLElement {
  const own = getComputedStyle(el).overflowY;
  if (own === "auto" || own === "scroll") return el;
  for (const child of Array.from(el.querySelectorAll<HTMLElement>("*"))) {
    const o = getComputedStyle(child).overflowY;
    if ((o === "auto" || o === "scroll") && child.scrollHeight > child.clientHeight) return child;
  }
  return el;
}

export function useScrollMemory(key: string, ref: RefObject<HTMLElement | null>, ready = true) {
  // Put back as soon as the content is there (layout effect: before the frame paints).
  useLayoutEffect(() => {
    if (!ready) return;
    const el = ref.current;
    if (!el) return;
    const saved = positions.get(key);
    if (!saved) return;
    const target = scroller(el);
    target.scrollTop = saved;
    // Content that lays out a moment later (thumbnails measuring) can shift; try once more.
    const t = setTimeout(() => {
      if (Math.abs(target.scrollTop - saved) > 2) target.scrollTop = saved;
    }, 60);
    return () => clearTimeout(t);
  }, [key, ref, ready]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    const target = scroller(el);
    const onScroll = () => positions.set(key, target.scrollTop);
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [key, ref, ready]);
}
