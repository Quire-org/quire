import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// Ten made-up files in one folder.
const entries = Array.from({ length: 10 }, (_, i) => ({ name: `note${i}.txt`, path: `/vol/Docs/note${i}.txt`, isDir: false, size: 10, modified: 0, count: 0, encrypted: false }));

vi.mock("../lib/api", () => ({
  api: new Proxy({ listDir: async () => entries, tagsLoad: async () => ({}) } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  setCurrentRoot: () => {},
  pickFolder: async () => null,
  storedPath: (_r: string, p: string) => p,
  fileSrc: (p: string) => p,
  mediaUrl: (i: { primary: string }) => `media:${i.primary}`,
  thumbUrl: (_r: string, i: { primary: string }) => `thumb:${i.primary}`,
  faceUrl: () => "face:",
  canThumb: () => true,
  rawPreviewUrl: async () => "",
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));
for (const name of ["ResizeObserver", "IntersectionObserver"])
  (globalThis as Record<string, unknown>)[name] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
globalThis.requestAnimationFrame = (f: FrameRequestCallback) => setTimeout(() => f(performance.now()), 5) as unknown as number;
globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);

const { Files } = await import("../screens/Files");
const { useStore } = await import("../store");

afterAll(() => vi.dynamicImportSettled());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wait = (ms = 0) => act(async () => await new Promise((r) => setTimeout(r, ms)));

async function files(view: "icons" | "list") {
  localStorage.setItem("quire.filesView", view);
  useStore.setState({ root: "/vol", screen: "files", allItems: [], allLoaded: true, allStale: false, albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Files)));
  await wait();
  return { host, unmount: () => (root.unmount(), host.remove()) };
}

/** The names of what is selected, in the folder's order. */
const picked = () => Array.from(document.querySelectorAll("[data-path].selected")).map((n) => n.getAttribute("data-path")!.split("/").pop()!.replace(/^note|\.txt$/g, "")).join(",");
const at = (i: number) => document.querySelector(`[data-path="/vol/Docs/note${i}.txt"]`) as HTMLElement;
type Keys = { shiftKey?: boolean; metaKey?: boolean };
const mouse = (type: string, el: EventTarget, x = 0, y = 0, keys: Keys = {}) => act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, ...keys })));
/** A click as a hand makes it: pressed, let go, clicked. */
const click = async (el: Element, keys: Keys = {}) => {
  for (const type of ["mousedown", "mouseup", "click"]) await mouse(type, el, 0, 0, keys);
};

describe("Files: picking several", () => {
  beforeEach(() => localStorage.clear());

  it("⇧-click selects everything from the last one clicked, ⌘⇧ keeps what was picked besides", async () => {
    const f = await files("list");
    await click(at(1));
    await click(at(4), { shiftKey: true });
    expect(picked()).toBe("1,2,3,4");
    // From the same one again: the range shrinks to the new end, as in Finder.
    await click(at(2), { shiftKey: true });
    expect(picked()).toBe("1,2");
    // ⌘ adds one and starts there; ⇧ from it keeps the first ones.
    await click(at(6), { metaKey: true });
    await click(at(8), { shiftKey: true });
    expect(picked()).toBe("1,2,6,7,8");
    // Upwards works the same.
    await click(at(5));
    await click(at(3), { shiftKey: true });
    expect(picked()).toBe("3,4,5");
    // A list row is moved by its icon and name; the row itself is not a drag handle.
    expect(at(0).getAttribute("draggable")).toBeNull();
    expect(at(0).querySelector(".file-grab")!.getAttribute("draggable")).toBe("true");
    f.unmount();
  });

  it("dragging over empty space draws a box that selects what it touches; ⇧ adds, ⌘ flips", async () => {
    const f = await files("icons");
    // Laid out three across: 180 × 160 tiles, 10 apart, inside a 600 × 400 view.
    const grid = document.querySelector(".file-icons") as HTMLElement;
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0, toJSON() {} });
    Object.defineProperty(grid, "clientWidth", { value: 600 });
    Object.defineProperty(grid, "scrollHeight", { value: 700 });
    for (let i = 0; i < entries.length; i++) {
      const [c, r] = [i % 3, Math.floor(i / 3)];
      const [left, top] = [16 + c * 190, 14 + r * 170];
      at(i).getBoundingClientRect = () => ({ left, top, right: left + 180, bottom: top + 160, width: 180, height: 160, x: left, y: top, toJSON() {} });
    }
    const drag = async (from: [number, number], to: [number, number], keys: Keys = {}) => {
      await mouse("mousedown", grid, ...from, keys);
      await mouse("mousemove", window, ...to);
      await wait(30);
      const box = grid.querySelector(".file-box") as HTMLElement;
      const drawn = box.style.display;
      // Let go over a tile: the click that makes picks nothing of its own.
      await mouse("mouseup", window, ...to);
      await mouse("click", at(0));
      return drawn;
    };
    // Top left to the middle: the first two of the first two rows.
    expect(await drag([5, 5], [300, 200])).toBe("block");
    expect(picked()).toBe("0,1,3,4");
    expect((grid.querySelector(".file-box") as HTMLElement).style.display).toBe("");
    // ⇧ adds the third of the first row.
    await drag([590, 5], [560, 30], { shiftKey: true });
    expect(picked()).toBe("0,1,2,3,4");
    // ⌘ flips: over the second column, the picked ones go, the one below comes in.
    await drag([300, 5], [310, 380], { metaKey: true });
    expect(picked()).toBe("0,2,3,7");
    // Then ⇧-click goes on from the box: from the first it touched to the one clicked.
    await click(at(9), { shiftKey: true });
    expect(picked()).toBe("0,1,2,3,4,5,6,7,8,9");
    // A plain click on nothing clears it; a press on a tile is for moving it, no box.
    await mouse("mousedown", grid, 595, 690);
    await mouse("mouseup", window, 595, 690);
    expect(picked()).toBe("");
    await mouse("mousedown", at(0), 30, 30);
    await mouse("mousemove", window, 300, 300);
    await wait(30);
    expect((grid.querySelector(".file-box") as HTMLElement).style.display).toBe("");
    await mouse("mouseup", window, 300, 300);
    expect(picked()).toBe("");
    f.unmount();
  });
});

describe("Files: a file shown from elsewhere", () => {
  it("opens at the file's folder with the file selected (Show in Files); a PDF's page shows the PDF", async () => {
    const { api } = await import("../lib/api");
    const asked: string[] = [];
    const was = api.listDir;
    (api as { listDir: unknown }).listDir = async (_root: string, dir: string) => (asked.push(dir), entries);
    try {
      useStore.setState({ root: "/vol" } as never);
      useStore.getState().showInFiles("/vol/Docs/book.pdf#3");
      expect(useStore.getState().filesShow).toBe("/vol/Docs/book.pdf");
      useStore.getState().showInFiles("/vol/Docs/note7.txt");
      expect(useStore.getState().screen).toBe("files");
      const f = await files("list");
      await wait(20);
      expect(asked[asked.length - 1]).toBe("/vol/Docs");
      expect(picked()).toBe("7");
      expect(useStore.getState().filesShow).toBeNull();
      f.unmount();
    } finally {
      (api as { listDir: unknown }).listDir = was;
    }
  });
});
