import { describe, expect, it, vi } from "vitest";
import type { MediaItem, TagData } from "../lib/types";

// The backend, as far as moving keys goes: what the stores load, and what they save or are told.
const be = vi.hoisted(() => ({
  snapshot: null as unknown,
  tags: null as unknown,
  index: { auto: {}, indexed: {} } as unknown,
  cache: null as unknown,
  saved: {} as Record<string, unknown>,
  renamed: [] as [string, string][],
}));
vi.mock("../lib/api", () => ({
  api: {
    saveLibrary: vi.fn(async (_r: string, lib: unknown) => void (be.saved.library = lib)),
    saveHistory: vi.fn(async () => {}),
    loadTags: vi.fn(async () => be.tags),
    saveTags: vi.fn(async (_r: string, d: unknown) => void (be.saved.tags = d)),
    tagsIndexLoad: vi.fn(async () => be.index),
    tagsIndexRename: vi.fn(async (_r: string, pairs: [string, string][]) => void be.renamed.push(...pairs)),
    loadCache: vi.fn(async () => be.cache),
    snapshotLoad: vi.fn(async () => be.snapshot ?? null),
    snapshotSave: vi.fn(async (_r: string, snap: unknown) => void (be.snapshot = snap)),
    saveCache: vi.fn(async (_r: string, c: unknown) => void (be.saved.cache = c)),
    fileFingerprint: vi.fn(async () => "x"),
    scanDir: vi.fn(async () => []),
  },
  storedPath: (root: string, p: string) => p.slice(root.length + 1),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { useStore, followMoves } = await import("../store");
const { useTags } = await import("../tagsStore");
const { useDupes } = await import("../dupesStore");
const { useJobs } = await import("../lib/jobs");
const { mover } = await import("../lib/moves");

const item = (key: string, size = 100, modified = 7): MediaItem => {
  const name = key.split("/").pop()!.replace(/\.[^.]+$/, "");
  return { key, name, dir: key.slice(0, key.lastIndexOf("/")), primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", size, modified, hasRaw: false, hasVideo: false } as MediaItem;
};
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup() {
  be.saved = {};
  be.renamed = [];
  const tags: Partial<TagData> = {
    version: 1,
    types: ["motives"],
    tags: { "Albums/Trip/p1.jpg": ["motives/sea"], "album:Albums/Trip": ["motives/travel"], "DCIM/x.jpg": ["motives/cat"] },
    autoMap: {},
    albums: { "Albums/Trip": ["Albums/Trip/p1.jpg", "Albums/Trip/p2.jpg"] },
    denied: { "motives/cat": ["Albums/Trip/p2.jpg"] },
  };
  be.tags = tags;
  be.index = { auto: { "Albums/Trip/p1.jpg": [[0, 0.9]] }, indexed: { "Albums/Trip/p1.jpg": { s: 100, m: 7 }, "Albums/Trip/p2.jpg": { s: 200, m: 7 } } };
  be.cache = { version: 1, sigs: { "Albums/Trip/p1.jpg": { size: 100, modified: 7, fp: "fp1" }, "Albums/Trip/p2.jpg": { size: 200, modified: 7, fp: "fp2" } }, ignored: [{ keys: ["Albums/Trip/p2.jpg", "DCIM/x.jpg"], fps: [] }] };
  useStore.setState({
    root: "/vol",
    toasts: [],
    viewed: { "Albums/Trip/p1.jpg": 5 },
    library: {
      version: 1, targets: [], trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false,
      ratings: { "Albums/Trip/p1.jpg": 9 },
      ids: { "Albums/Trip/p1.jpg": { s: 100, m: 7, n: "p1.jpg" } },
      albumRatings: { "Albums/Trip": 8 },
      albumLanguages: { "Albums/Trip": "ja" },
      albumTranslations: { "Albums/Trip": "Albums/Trip EN" },
    },
  } as never);
  useTags.setState({ data: null, loaded: false });
  useDupes.setState({ cacheRoot: null, cache: {}, ignored: [], matched: null });
}

const expectFollowed = () => {
  const lib = useStore.getState().library!;
  expect(lib.ratings).toEqual({ "Albums/Iceland/p1.jpg": 9 });
  expect(Object.keys(lib.ids)).toEqual(["Albums/Iceland/p1.jpg"]);
  expect(lib.albumRatings).toEqual({ "Albums/Iceland": 8 });
  expect(lib.albumLanguages).toEqual({ "Albums/Iceland": "ja" });
  expect(lib.albumTranslations).toEqual({ "Albums/Iceland": "Albums/Trip EN" });
  expect(useStore.getState().viewed).toEqual({ "Albums/Iceland/p1.jpg": 5 });
  const d = useTags.getState().data!;
  expect(d.tags).toEqual({ "Albums/Iceland/p1.jpg": ["motives/sea"], "album:Albums/Iceland": ["motives/travel"], "DCIM/x.jpg": ["motives/cat"] });
  expect(d.albums).toEqual({ "Albums/Iceland": ["Albums/Iceland/p1.jpg", "Albums/Iceland/p2.jpg"] });
  expect(d.denied).toEqual({ "motives/cat": ["Albums/Iceland/p2.jpg"] });
  expect(Object.keys(d.indexed).sort()).toEqual(["Albums/Iceland/p1.jpg", "Albums/Iceland/p2.jpg"]);
  expect(be.renamed.sort()).toEqual([["Albums/Trip/p1.jpg", "Albums/Iceland/p1.jpg"], ["Albums/Trip/p2.jpg", "Albums/Iceland/p2.jpg"]]);
  expect(Object.keys(useDupes.getState().cache).sort()).toEqual(["Albums/Iceland/p1.jpg", "Albums/Iceland/p2.jpg"]);
  expect(useDupes.getState().ignored[0].keys).toEqual(["Albums/Iceland/p2.jpg", "DCIM/x.jpg"]);
  expect((be.saved.cache as { sigs: object }).sigs).toHaveProperty(["Albums/Iceland/p1.jpg"]);
};

describe("what is kept about files goes with them", () => {
  it("an album folder renamed in the app: its rating, language, link and tags, and its pages' ratings, history, tags, index and fingerprints", async () => {
    setup();
    followMoves([["Albums/Trip", "Albums/Iceland"]]);
    await settle();
    expectFollowed();
  });

  it("the same done in Finder: found again by what is known of the files, the folder read from them", async () => {
    setup();
    await useStore.getState().reconcileKeys([item("Albums/Iceland/p1.jpg", 100, 7), item("Albums/Iceland/p2.jpg", 200, 7), item("DCIM/x.jpg", 50, 3)]);
    await settle();
    expectFollowed();
  });

  it("a trashed file's tags stay for Undo, and a new file of the same name elsewhere doesn't take them", async () => {
    setup();
    be.index = { auto: {}, indexed: {} };
    be.cache = null;
    useStore.setState({ library: { ...useStore.getState().library!, ratings: {}, ids: {} }, viewed: {} });
    await useStore.getState().reconcileKeys([item("Elsewhere/p1.jpg", 999, 1), item("DCIM/x.jpg", 50, 3)]);
    await settle();
    expect(useTags.getState().data!.tags["Albums/Trip/p1.jpg"]).toEqual(["motives/sea"]);
    expect(useTags.getState().data!.tags["Elsewhere/p1.jpg"]).toBeUndefined();
  });

  it("moved in the Files screen (absolute paths): kept data follows, and a sort target in the folder points at its new place", async () => {
    setup();
    useStore.setState({ library: { ...useStore.getState().library!, targets: [{ id: "t1", name: "Trip", path: "/vol/Albums/Trip/best" }] } } as never);
    useStore.getState().relocatePaths([["/vol/Albums/Trip", "/vol/Albums/Iceland"]]);
    await settle();
    expectFollowed();
    expect(useStore.getState().library!.targets[0].path).toBe("/vol/Albums/Iceland/best");
  });

  it("a copy kept when its exact twin was trashed doesn't take the twin's data, and looking for moves starts no matching", async () => {
    setup();
    // The trashed twin's fingerprint is left under its old key; the kept copy has its own, same size, time and content.
    be.cache = { version: 1, sigs: { "DCIM/copy.jpg": { size: 50, modified: 3, fp: "same" }, "DCIM/x.jpg": { size: 50, modified: 3, fp: "same" } }, ignored: [] };
    be.index = { auto: {}, indexed: {} };
    useStore.setState({ library: { ...useStore.getState().library!, ratings: {}, ids: {} }, viewed: {} });
    await useStore.getState().reconcileKeys([item("DCIM/x.jpg", 50, 3), item("Albums/Trip/p1.jpg"), item("Albums/Trip/p2.jpg", 200)]);
    await settle();
    expect(Object.keys(useDupes.getState().cache).sort()).toEqual(["DCIM/copy.jpg", "DCIM/x.jpg"]);
    expect(useStore.getState().toasts.some((t) => t.text.includes("moved outside the app"))).toBe(false);
    expect(useJobs.getState().jobs).toEqual([]);
    expect(useDupes.getState().matchingCache ?? null).toBeNull();
  });

  it("thousands of moves over tens of thousands of keys take a moment, not minutes", () => {
    const pairs: [string, string][] = Array.from({ length: 5000 }, (_, i) => [`Old/${i}.jpg`, `New/${i}.jpg`]);
    pairs.push(["Albums/A", "Albums/B"]);
    const move = mover(pairs);
    const t0 = performance.now();
    let moved = 0;
    for (let i = 0; i < 50000; i++) if (move(i % 2 ? `Old/${i % 5000}.jpg` : `Albums/A/sub/${i}.jpg`) != null) moved++;
    expect(moved).toBe(50000);
    expect(move("Albums/AB/x.jpg")).toBeNull();
    expect(performance.now() - t0).toBeLessThan(500);
  });
});