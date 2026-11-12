import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { longPressIsRightClick } from "../mobile/gestures";

const touch = (type: string, target: EventTarget, x: number, y: number, fingers = 1) => {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: unknown[] };
  e.touches = Array.from({ length: fingers }, () => ({ clientX: x, clientY: y, target }));
  target.dispatchEvent(e);
};

describe("a long press", () => {
  let tile: HTMLDivElement;
  let menus: MouseEvent[];
  installOnce();
  beforeEach(() => {
    vi.useFakeTimers();
    tile = document.createElement("div");
    document.body.append(tile);
    menus = [];
    tile.addEventListener("contextmenu", (e) => menus.push(e as MouseEvent));
  });
  afterEach(() => {
    touch("touchend", tile, 0, 0, 0);
    tile.remove();
    vi.useRealTimers();
  });

  it("is a right-click where the finger is, and its lifting isn't a tap", () => {
    touch("touchstart", tile, 40, 60);
    vi.advanceTimersByTime(500);
    expect(menus).toHaveLength(1);
    expect([menus[0].clientX, menus[0].clientY]).toEqual([40, 60]);
    const clicked = vi.fn();
    tile.addEventListener("click", clicked);
    touch("touchend", tile, 40, 60, 0);
    tile.click();
    expect(clicked).not.toHaveBeenCalled();
    tile.click();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("isn't a short tap, a scroll, or two fingers", () => {
    touch("touchstart", tile, 40, 60);
    vi.advanceTimersByTime(100);
    touch("touchend", tile, 40, 60, 0);
    vi.advanceTimersByTime(600);
    touch("touchstart", tile, 40, 60);
    touch("touchmove", tile, 40, 90);
    vi.advanceTimersByTime(600);
    touch("touchstart", tile, 40, 60, 2);
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(0);
  });
});

function installOnce() {
  if (!(window as unknown as { __longPress?: boolean }).__longPress) {
    (window as unknown as { __longPress?: boolean }).__longPress = true;
    longPressIsRightClick();
  }
}
