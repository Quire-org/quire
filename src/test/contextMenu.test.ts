import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/sounds", () => ({ useOpenSound: () => {} }));
const { ContextMenu } = await import("../components/ContextMenu");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A menu of this size (jsdom lays nothing out), at a point of an 800 × 600 window: where it sits. */
async function placed(at: { x: number; y: number }, height: number) {
  Object.assign(window, { innerWidth: 800, innerHeight: 600 });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 260, height } as DOMRect);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ContextMenu, { at, items: [{ label: "Info" }], onClose: () => {} })));
  const menu = document.querySelector(".context-menu") as HTMLElement;
  const where = { left: parseFloat(menu.style.left), top: parseFloat(menu.style.top) };
  root.unmount();
  host.remove();
  return where;
}

afterEach(() => vi.restoreAllMocks());

describe("a right-click menu", () => {
  it("opens at the pointer where it fits, and left of it or upwards where it would run off the window", async () => {
    expect(await placed({ x: 100, y: 100 }, 300)).toEqual({ left: 100, top: 100 });
    // Near the bottom right: to the left and upwards, its corner at the pointer.
    expect(await placed({ x: 790, y: 590 }, 300)).toEqual({ left: 530, top: 290 });
  });

  it("never runs past an edge: taller than the room either way, it sits as far as it goes, and a menu taller than the window starts at its top", async () => {
    expect(await placed({ x: 100, y: 300 }, 450)).toEqual({ left: 100, top: 142 });
    expect(await placed({ x: 100, y: 300 }, 700)).toEqual({ left: 100, top: 8 });
  });
});
