import { afterAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({
  api: new Proxy({ facesLoad: async () => ({ faces: [], scanned: {} }) } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  setCurrentRoot: () => {},
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
// The grid's box: 1000 px of tiles across, and how much of it shows.
let shownHeight = 800;
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1032 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => shownHeight });

const { Browse } = await import("../screens/Browse");
const { useStore } = await import("../store");

afterAll(() => vi.dynamicImportSettled());
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Portraits, landscapes and squares, so a column's height depends on every shape above it.
const SHAPES = [0.66, 1.5, 1, 0.75, 1.78, 0.56];
const items = Array.from({ length: 36 }, (_, i) => {
  const name = `p${String(i).padStart(2, "0")}.jpg`;
  return { key: `Pics/${name}`, primary: `/vol/Pics/${name}`, files: [`/vol/Pics/${name}`], name, kind: "image", dir: "Pics", size: 1000 + i, modified: i, hasRaw: false, hasVideo: false };
});
const shapeOf = (primary: string) => SHAPES[items.findIndex((i) => i.primary === primary) % SHAPES.length];

/** Where each tile is, by its file. */
const placed = () => new Map(Array.from(document.querySelectorAll(".mtile")).map((t) => [t.querySelector(".thumb")!.getAttribute("title")!, (t as HTMLElement).style.transform]));

async function browse(loadPictures: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Browse)));
  await act(async () => await new Promise((r) => setTimeout(r, 0)));
  if (loadPictures) {
    // Each picture tells its shape as it loads.
    for (const img of Array.from(host.querySelectorAll(".mtile img")) as HTMLImageElement[]) {
      const ratio = shapeOf(img.closest(".thumb")!.getAttribute("title")!);
      Object.defineProperty(img, "naturalWidth", { value: Math.round(600 * ratio) });
      Object.defineProperty(img, "naturalHeight", { value: 600 });
      await act(async () => void img.dispatchEvent(new Event("load")));
    }
    await act(async () => await new Promise((r) => setTimeout(r, 50)));
  }
  return { host, unmount: () => (root.unmount(), host.remove()) };
}

describe("Browse's mosaic", () => {
  it("left for the viewer, comes back as it was, before its pictures have loaded again", async () => {
    useStore.setState({ root: "/vol", screen: "browse", allItems: items, allLoaded: true, allStale: false, albums: [], viewed: {}, library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    useStore.setState((s) => ({ browseFilters: { ...s.browseFilters, layout: "masonry", zoom: 240 } }) as never);
    // Scrolled through all of it: every tile showed and told its shape.
    shownHeight = 100000;
    const first = await browse(true);
    const before = placed();
    expect(before.size).toBe(items.length);
    expect(new Set(before.values()).size).toBe(items.length);
    first.unmount();
    // Back from the viewer: only the view's worth of tiles shows, none of its pictures loaded yet.
    shownHeight = 800;
    const again = await browse(false);
    const after = placed();
    expect(after.size).toBeGreaterThan(0);
    for (const [file, where] of after) expect(where, file).toBe(before.get(file));
    again.unmount();
  });
});
