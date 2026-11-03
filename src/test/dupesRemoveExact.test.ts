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
const { ConfirmHost } = await import("../components/Confirm");
const { useStore } = await import("../store");
const { useDupes } = await import("../dupesStore");
const { useJobs } = await import("../lib/jobs");

const pic = (k: string, size: number): MediaItem => ({ key: k, primary: "/root/" + k, files: ["/root/" + k], name: k, kind: "image", dir: "", size, modified: 1, hasRaw: false, hasVideo: false }) as MediaItem;
const sig = (size: number) => ({ size, modified: 1, fp: "same", image: { phash: "ff00ff00ff00ff00", quads: Array(4).fill("ff00ff00ff00ff00"), dhash: "0", width: 100, height: 100 } });
const button = (_scope: HTMLElement, text: RegExp) => Array.from(document.body.querySelectorAll("button")).find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement | undefined;

describe("remove exact duplicates, on the screen", () => {
  it("asks once, then trashes the copies and shows it in Activity", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const a = pic("a.jpg", 10);
    const b = pic("b.jpg", 10);
    useStore.setState({ root: "/root", screen: "dupes", allItems: [a, b], allLoaded: true, allStale: false, library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    useDupes.setState({ cache: { "a.jpg": sig(10), "b.jpg": sig(10) } as never, cacheRoot: "/root", running: false, groups: [], scope: "all", folders: null, includeVideos: true, includeAlbums: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, createElement(Dupes), createElement(ConfirmHost))));
    for (let i = 0; i < 5; i++) await act(async () => {});
    expect(useDupes.getState().groups).toHaveLength(1);

    const remove = button(host, /Remove 1 exact copy/);
    expect(remove, document.body.textContent ?? "").toBeTruthy();
    expect(remove!.disabled).toBe(false);
    await act(async () => remove!.click());
    // A proper question, not a label that changes under the mouse.
    expect(document.body.textContent).toContain("Trash 1 exact copy?");
    expect(trashed).toEqual([]); // nothing yet
    const sure = button(host, /^Trash 1 copy$/)!;
    let seenJob = false;
    const off = useJobs.subscribe((s) => (seenJob ||= s.jobs.some((j) => j.title === "Removing exact duplicates")));
    await act(async () => sure.click());
    for (let i = 0; i < 5; i++) await act(async () => {});
    off();
    expect(trashed).toEqual(["b.jpg"]);
    expect(seenJob).toBe(true);
    expect(useDupes.getState().groups).toEqual([]);
    root.unmount();
  });
});
