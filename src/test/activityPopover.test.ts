import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      trashItem: async (_root: string, _lib: unknown, item: MediaItem) => ({ moved: [[item.primary, "/root/_deleted/" + item.name]], item: { ...item, primary: "/root/_deleted/" + item.name } }),
      loadCache: async () => null,
      scanAll: async () => [],
      tagsIndexLoad: async () => ({ auto: {}, indexed: {}, embedded: 0 }),
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
  disconnect() {}
};
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const { Dupes } = await import("../screens/Dupes");
const { Toasts } = await import("../components/Toasts");
const { useStore } = await import("../store");
const { steppedJob } = await import("../lib/jobs");

const pic = (k: string): MediaItem => ({ key: k, primary: "/root/" + k, files: ["/root/" + k], name: k, kind: "image", dir: "", size: 1, modified: 1, hasRaw: false, hasVideo: false }) as MediaItem;

describe("the Activity drop-down", () => {
  it("stays open while files are trashed and notices come and go", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const items = ["a.jpg", "b.jpg", "c.jpg"].map(pic);
    useStore.setState({ root: "/root", screen: "dupes", allItems: items, allLoaded: true, allStale: false, library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, createElement(Dupes), createElement(Toasts))));
    const { job } = steppedJob({ title: "Removing exact duplicates", source: "Duplicates", total: 3 });
    await act(async () => {});
    const ring = document.querySelector<HTMLButtonElement>(".activity-btn")!;
    expect(ring).toBeTruthy();
    await act(async () => ring.click());
    expect(document.querySelector(".activity-pop")).toBeTruthy();
    for (const it of items) {
      await act(async () => void (await useStore.getState().trashItem(it)));
      job.update({ done: items.indexOf(it) + 1 });
      await act(async () => {});
      expect(document.querySelector(".activity-pop"), `after trashing ${it.key}`).toBeTruthy();
    }
    // The job ends while the list is open: it stays, marked done, until closed.
    await act(async () => job.finish());
    expect(document.querySelector(".activity-pop")).toBeTruthy();
    expect(document.querySelector(".activity-row.ended")?.textContent).toContain("Removing exact duplicates");
    expect(document.querySelector(".activity-pop")?.textContent).toContain("Nothing running now");
    await act(async () => document.querySelector<HTMLButtonElement>(".activity-btn")!.click());
    expect(document.querySelector(".activity-pop")).toBeNull();
    expect(document.querySelector(".activity-btn")).toBeNull(); // nothing running, closed: no ring
    root.unmount();
  });
});
