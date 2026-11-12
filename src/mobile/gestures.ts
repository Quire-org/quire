/** How long a finger stays down before it counts as a long press, and how far it may wander. */
const HOLD_MS = 450;
const WANDER = 10;

/**
 * A long press is a right-click: whatever the app offers on a right-click (a tile's menu, a work's,
 * an album's) is a long press away, with nothing written twice. The finger's lifting isn't a tap then.
 */
export function longPressIsRightClick() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let held = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  window.addEventListener(
    "touchstart",
    (e) => {
      clear();
      held = false;
      if (e.touches.length !== 1) return;
      const { clientX: x, clientY: y, target } = e.touches[0];
      start = { x, y };
      timer = setTimeout(() => {
        held = true;
        clear();
        target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
      }, HOLD_MS);
    },
    { capture: true, passive: true },
  );
  window.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > WANDER) clear();
    },
    { capture: true, passive: true },
  );
  window.addEventListener("touchend", clear, { capture: true, passive: true });
  window.addEventListener("touchcancel", clear, { capture: true, passive: true });
  window.addEventListener(
    "click",
    (e) => {
      if (!held) return;
      held = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
}
