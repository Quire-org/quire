import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";

const fake = vi.hoisted(() => ({ cache: null as unknown, views: null as unknown, fingerprints: new Map<string, string>(), gate: null as null | Promise<void> }));
vi.mock("../lib/api", () => ({
  api: {
    versionsLoad: vi.fn(async () => null),
    viewsLoad: vi.fn(async () => fake.views),
    viewsSave: vi.fn(async (_root: string, v: unknown) => void (fake.views = v)),
    loadCache: vi.fn(async () => fake.cache),
    saveCache: vi.fn(async (_root: string, c: unknown) => void (fake.cache = c)),
    fileFingerprint: vi.fn(async (p: string) => {
      if (fake.gate) await fake.gate;
      return fake.fingerprints.get(p) ?? "fp-" + p;
    }),
    imageHash: vi.fn(async () => {
      throw new Error("decode");
    }),
    readBenchmark: vi.fn(async () => ({ mbPerS: 100 })),
  },
  fileSrc: (p: string) => "file://" + p,
  mediaUrl: (i: { primary: string }) => "file://" + i.primary,
  rawPreviewUrl: async (p: string) => "blob:" + p,
}));
vi.mock("../lib/dupes", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/dupes")>();
  return { ...mod, hashImageUrl: vi.fn(async () => { throw new Error("no canvas"); }) };
});

import { useStore } from "../store";
import { useDupes } from "../dupesStore";

const item = (key: string): MediaItem => ({ key, primary: "/root/" + key, files: ["/root/" + key], kind: "image", name: key, dir: key.slice(0, key.lastIndexOf("/")), size: 1000, modified: 1, hasRaw: false, hasVideo: false });
const groupDirs = () => useDupes.getState().groups.map((g) => g.members.map((m) => m.item.dir).join(","));

describe("the duplicate check's folders", () => {
  beforeEach(() => {
    fake.cache = null;
    fake.gate = null;
    fake.fingerprints = new Map([["/root/A/1.jpg", "a"], ["/root/A/2.jpg", "a"], ["/root/B/1.jpg", "b"], ["/root/B/2.jpg", "b"]]);
    useStore.setState({ root: "/root", library: { version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, autoDecodeAlbumNames: false, ids: {} } as never, allItems: ["A/1.jpg", "A/2.jpg", "B/1.jpg", "B/2.jpg"].map(item), allLoaded: true, allStale: false });
    useDupes.setState({ groups: [], entries: [], running: false, includeVideos: false, cacheRoot: null, cache: {}, matched: null, folders: null, foldersKnown: null, scope: "all", sensitivity: "normal" });
    localStorage.clear();
  });

  it("leave out what is in the folders taken out, after a scan", async () => {
    await useDupes.getState().scan();
    expect(groupDirs().sort()).toEqual(["A,A", "B,B"]);
    useDupes.getState().set({ folders: new Set(["", "A"]) });
    await vi.waitFor(() => expect(groupDirs()).toEqual(["A,A"]));
  });

  it("leave out what is in the folders taken out while a scan runs", async () => {
    let open = () => {};
    fake.gate = new Promise<void>((r) => (open = r));
    const scan = useDupes.getState().scan();
    await new Promise((r) => setTimeout(r, 10));
    useDupes.getState().set({ folders: new Set(["", "A"]) });
    open();
    await scan;
    await vi.waitFor(() => expect(groupDirs()).toEqual(["A,A"]));
  });

  it("are kept for the library, and a folder that came since takes its parent's choice", async () => {
    const { loadViews } = await import("../lib/views");
    const { flushAll } = await import("../lib/pending");
    await loadViews("/root");
    useDupes.getState().set({ folders: new Set(["", "A"]), foldersKnown: new Set(["", "A", "B"]), sensitivity: "strict" });
    // Kept with the library; opened again later, with new folders in both.
    await flushAll();
    await loadViews("/root");
    useDupes.setState({ cacheRoot: null, folders: null, foldersKnown: null, sensitivity: "normal" });
    for (const k of ["A/new/1.jpg", "A/new/2.jpg", "B/new/1.jpg", "B/new/2.jpg"]) fake.fingerprints.set("/root/" + k, k.slice(0, 5));
    useStore.setState({ allItems: [...useStore.getState().allItems, ...["A/new/1.jpg", "A/new/2.jpg", "B/new/1.jpg", "B/new/2.jpg"].map(item)] });
    await useDupes.getState().scan();
    expect(useDupes.getState().sensitivity).toBe("strict");
    expect(groupDirs().sort()).toEqual(["A,A", "A/new,A/new"]);
    expect([...useDupes.getState().folders!].sort()).toEqual(["", "A", "A/new"]);
  });
});
