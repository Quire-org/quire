import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../lib/types";

const trashed = vi.hoisted(() => [] as string[]);
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      loadCache: async () => null,
      saveCache: async () => {},
      scanAll: async () => [],
      loadTags: async () => null,
      tagsIndexLoad: async () => ({ auto: {}, indexed: {}, embedded: 0 }),
      saveLibrary: async () => {},
      readBenchmark: async () => ({ mbPerS: 100 }),
      trashItem: async (_root: string, _lib: unknown, item: MediaItem) => {
        trashed.push(item.key);
        return { moved: [[item.primary, "/root/_deleted/" + item.name]], item: { ...item, primary: "/root/_deleted/" + item.name } };
      },
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  rawPreviewUrl: async () => "",
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { Dupes } = await import("../screens/Dupes");
const { useStore } = await import("../store");
const { useDupes } = await import("../dupesStore");

const pic = (k: string, size: number): MediaItem => ({ key: k, primary: "/root/" + k, files: ["/root/" + k], name: k, kind: "image", dir: "", size, modified: 1, hasRaw: false, hasVideo: false }) as MediaItem;
// Alike, not the same file: a similar group.
const sig = (size: number, fp: string) => ({ size, modified: 1, fp, image: { phash: "ff00ff00ff00ff00", quads: Array(4).fill("ff00ff00ff00ff00"), dhash: "0", width: 100, height: 100 } });
const button = (host: HTMLElement, text: RegExp) => Array.from(host.querySelectorAll("button")).find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement | undefined;

describe("a group in Duplicates, with some of it a series", () => {
  it("keeps the ticked ones together as a series and trashes the rest", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const [a, b, c] = ["a.jpg", "b.jpg", "c.jpg"].map((k) => pic(k, 10));
    useStore.setState({ root: "/root", screen: "dupes", allItems: [a, b, c], allLoaded: true, allStale: false, library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    useDupes.setState({ cache: { "a.jpg": sig(10, "1"), "b.jpg": sig(10, "2"), "c.jpg": sig(10, "3") } as never, cacheRoot: "/root", running: false, groups: [], matched: null, scope: "all", folders: null, includeVideos: true, includeAlbums: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Dupes)));
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(useDupes.getState().groups.map((g) => g.members.length)).toEqual([3]);
    // One tick is no series.
    const boxes = () => Array.from(host.querySelectorAll<HTMLInputElement>(".dupe-actions input[type=checkbox]"));
    await act(async () => boxes()[0].click());
    expect(button(host, /as a series, trash/)).toBeUndefined();
    await act(async () => boxes()[1].click());
    await act(async () => button(host, /Keep 2 as a series, trash 1/)!.click());
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(trashed).toEqual(["c.jpg"]);
    expect(useStore.getState().library!.series).toEqual([["a.jpg", "b.jpg"]]);
    expect(useDupes.getState().groups).toEqual([]);
    root.unmount();
  });

  it("shows each picture whole, at its own shape, when asked (and remembers it)", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    const tall = (fp: string) => ({ ...sig(10, fp), image: { ...sig(10, fp).image, width: 100, height: 250 } });
    const [a, b] = ["d.jpg", "e.jpg"].map((k) => pic(k, 10));
    useStore.setState({ allItems: [a, b], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    useDupes.setState({ cache: { "d.jpg": tall("4"), "e.jpg": tall("5") } as never, cacheRoot: "/root", running: false, groups: [], matched: null });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Dupes)));
    for (let i = 0; i < 5; i++) await act(async () => {});
    const box = () => host.querySelector<HTMLElement>(".dupe-members .thumb-media")!;
    expect(box().style.paddingTop).toBe("75%");
    const toggle = Array.from(host.querySelectorAll("label")).find((l) => l.textContent?.includes("Whole pictures"))!.querySelector("input")!;
    await act(async () => toggle.click());
    expect(box().style.paddingTop).toBe("250%");
    expect(host.querySelector(".dupe-members.whole")).not.toBeNull();
    expect(localStorage.getItem("quire.dupes.whole")).toBe("1");
    root.unmount();
  });
});
