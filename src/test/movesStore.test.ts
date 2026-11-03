import { describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";

// The backend: the library, tags, index, scanner cache and snapshot as saved, and what they are told.
const be = vi.hoisted(() => ({ snapshot: null as unknown, tags: null as unknown, index: { auto: {}, indexed: {} } as unknown, cache: null as unknown, saved: {} as Record<string, unknown> }));
vi.mock("../lib/api", () => ({
  api: {
    saveLibrary: vi.fn(async (_r: string, lib: unknown) => void (be.saved.library = lib)),
    saveHistory: vi.fn(async () => {}),
    loadTags: vi.fn(async () => be.tags),
    saveTags: vi.fn(async (_r: string, d: unknown) => void (be.saved.tags = d)),
    tagsIndexLoad: vi.fn(async () => be.index),
    tagsIndexRename: vi.fn(async () => {}),
    tagsIndexRestamp: vi.fn(async (_r: string, stamps: unknown) => void (be.saved.restamp = stamps)),
    loadCache: vi.fn(async () => be.cache),
    saveCache: vi.fn(async (_r: string, c: unknown) => void (be.saved.cache = c)),
    snapshotLoad: vi.fn(async () => be.snapshot),
    snapshotSave: vi.fn(async (_r: string, s: unknown) => void (be.snapshot = s)),
    fileFingerprint: vi.fn(async () => "?"),
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

const { useStore } = await import("../store");
const { useTags } = await import("../tagsStore");
const { useDupes } = await import("../dupesStore");
const { nextSnapshot } = await import("../lib/reconcile");

const item = (key: string, size: number, modified: number, targetId?: string): MediaItem => ({ key, name: key.split("/").pop()!.replace(/\.[^.]+$/, ""), dir: key.slice(0, key.lastIndexOf("/")), primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", size, modified, hasRaw: false, hasVideo: false, targetId });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A library as it was at the last look: three rated or tagged pictures in "Phone/Trip". */
function before() {
  const was = [item("Phone/Trip/a.jpg", 100, 1), item("Phone/Trip/b.jpg", 200, 2), item("Phone/Trip/c.jpg", 300, 3), item("Phone/Trip/d.jpg", 400, 4)];
  be.snapshot = nextSnapshot(null, was, () => true, 1000);
  be.saved = {};
  be.tags = {
    version: 1,
    types: ["motives", "where"],
    // c has tags only, and nothing else known of it but the snapshot; d's tags were given before any snapshot (see below).
    tags: { "Phone/Trip/a.jpg": ["motives/sea"], "Phone/Trip/c.jpg": ["motives/cat"], "Phone/Trip/d.jpg": ["motives/dog"] },
    autoMap: {},
    albums: {},
    places: ["where"],
    exclusive: ["where"],
    placeOf: { "where/private": "p" },
  };
  be.index = { auto: {}, indexed: {} };
  be.cache = null;
  useStore.setState({
    root: "/vol",
    toasts: [],
    viewed: {},
    library: { version: 1, targets: [{ id: "p", name: "Private", path: "Private", hotkey: "1", bucket: true }], trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: { "Phone/Trip/a.jpg": 9, "Phone/Trip/b.jpg": 6 }, ids: {}, albumRatings: {} },
  } as never);
  useTags.setState({ data: null, loaded: false });
  useDupes.setState({ cacheRoot: null, cache: {} } as never);
}

/** The same four, moved by hand into a bucket (so they have a bucket tag at their new place already). */
const after = () => [item("Private/Earlier/Trip/a.jpg", 100, 1, "p"), item("Private/Earlier/Trip/b.jpg", 200, 2, "p"), item("Private/Earlier/Trip/c.jpg", 300, 3, "p"), item("Private/Earlier/Trip/d.jpg", 400, 4, "p")];

describe("a folder tidied by hand, as the app finds it", () => {
  it("ratings and tags follow every file, merged with what it has at its new place; nothing left behind", async () => {
    before();
    const now = after();
    // What happened before reconciling got to it: the bucket tags were written for the new keys,
    // the scanner fingerprinted one new key, and a picture was rated again at its new place.
    useStore.setState({ allItems: now, allLoaded: true } as never);
    await useTags.getState().load();
    expect(useTags.getState().data!.tags["Private/Earlier/Trip/a.jpg"]).toEqual(["where/private"]);
    be.cache = { version: 1, sigs: { "Private/Earlier/Trip/b.jpg": { size: 200, modified: 2, fp: "fb" } }, ignored: [] };
    useStore.setState({ library: { ...useStore.getState().library!, ratings: { ...useStore.getState().library!.ratings, "Private/Earlier/Trip/b.jpg": 8 } } });
    await useStore.getState().reconcileKeys(now);
    await settle();
    const lib = useStore.getState().library!;
    const tags = useTags.getState().data!.tags;
    expect(lib.ratings).toEqual({ "Private/Earlier/Trip/a.jpg": 9, "Private/Earlier/Trip/b.jpg": 8 });
    expect(new Set(tags["Private/Earlier/Trip/a.jpg"])).toEqual(new Set(["motives/sea", "where/private"]));
    expect(new Set(tags["Private/Earlier/Trip/c.jpg"])).toEqual(new Set(["motives/cat", "where/private"]));
    expect(new Set(tags["Private/Earlier/Trip/d.jpg"])).toEqual(new Set(["motives/dog", "where/private"]));
    expect(Object.keys(tags).filter((k) => k.startsWith("Phone/"))).toEqual([]);
    // The snapshot now has them where they are, and nothing missing.
    const snap = be.snapshot as { files: Record<string, Record<string, unknown>>; gone: Record<string, unknown> };
    expect(Object.keys(snap.files["Private/Earlier/Trip"]).sort()).toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
    expect(snap.gone).toEqual({});
  });

  it("before any snapshot (as on the first start after this): still found, by what else is known and by the folder", async () => {
    before();
    be.snapshot = null;
    // Known: a's and b's ratings' identities, c in the scanner's cache; d nothing but its tags.
    useStore.setState({ library: { ...useStore.getState().library!, ids: { "Phone/Trip/a.jpg": { s: 100, m: 1, n: "a.jpg" }, "Phone/Trip/b.jpg": { s: 200, m: 2, n: "b.jpg" } } } });
    be.cache = { version: 1, sigs: { "Phone/Trip/c.jpg": { size: 300, modified: 3, fp: "fc" } }, ignored: [] };
    const now = after();
    useStore.setState({ allItems: now, allLoaded: true } as never);
    await useTags.getState().load();
    await useStore.getState().reconcileKeys(now);
    await settle();
    const tags = useTags.getState().data!.tags;
    expect(useStore.getState().library!.ratings).toEqual({ "Private/Earlier/Trip/a.jpg": 9, "Private/Earlier/Trip/b.jpg": 6 });
    expect(tags["Private/Earlier/Trip/c.jpg"]).toContain("motives/cat");
    // d: nothing known but its key, found by name where its neighbours went.
    expect(tags["Private/Earlier/Trip/d.jpg"]).toContain("motives/dog");
    expect(be.snapshot).not.toBeNull();
  });

  it("a file deleted in Finder keeps its things (they're under its old key, waiting), and a later copy of it back finds them", async () => {
    before();
    const without = [item("Phone/Trip/b.jpg", 200, 2), item("Phone/Trip/c.jpg", 300, 3), item("Phone/Trip/d.jpg", 400, 4)];
    useStore.setState({ allItems: without, allLoaded: true } as never);
    await useTags.getState().load();
    await useStore.getState().reconcileKeys(without);
    await settle();
    expect(useStore.getState().library!.ratings["Phone/Trip/a.jpg"]).toBe(9);
    expect((be.snapshot as { gone: Record<string, unknown> }).gone["Phone/Trip/a.jpg"]).toEqual([100, 1, 1000]);
    // Put back somewhere else (from a backup, say): found.
    const back = [...without, item("Restored/a.jpg", 100, 1)];
    await useStore.getState().reconcileKeys(back);
    await settle();
    expect(useStore.getState().library!.ratings["Restored/a.jpg"]).toBe(9);
    expect(useTags.getState().data!.tags["Restored/a.jpg"]).toContain("motives/sea");
  });

  it("a bucket renamed in Finder: the bucket follows its folder, and so does everything in it", async () => {
    before();
    const was = [item("Private/2026/2026-10-28/a.jpg", 100, 1, "p"), item("Private/2026/2026-10-28/b.jpg", 200, 2, "p")];
    be.snapshot = nextSnapshot(null, was, () => true, 1000);
    useStore.setState({ library: { ...useStore.getState().library!, ratings: { "Private/2026/2026-10-28/a.jpg": 7 } } });
    be.tags = { ...(be.tags as object), tags: { "Private/2026/2026-10-28/b.jpg": ["motives/sea", "where/private"] } };
    const now = [item("Personal/2026/2026-10-28/a.jpg", 100, 1), item("Personal/2026/2026-10-28/b.jpg", 200, 2)];
    useStore.setState({ allItems: now, allLoaded: true } as never);
    await useTags.getState().load();
    await useStore.getState().reconcileKeys(now);
    await settle();
    const lib = useStore.getState().library!;
    expect(lib.targets[0].path).toBe("Personal");
    expect(lib.ratings).toEqual({ "Personal/2026/2026-10-28/a.jpg": 7 });
    expect(useTags.getState().data!.tags["Personal/2026/2026-10-28/b.jpg"]).toContain("motives/sea");
  });

  it("a video known only to the duplicate scanner (its frames, slow to make again) follows, its sidecar tidied away", async () => {
    before();
    const video = item("Phone/Trip/clip.mp4", 900_000_000 + 30_000, 1_700_000_000_777);
    be.snapshot = nextSnapshot(null, [video], () => true, 1000);
    be.cache = { version: 1, sigs: { "Phone/Trip/clip.mp4": { size: video.size, modified: video.modified, video: { frames: ["ab"], info: "1", duration: 60, width: 1920, height: 1080 } } }, ignored: [] };
    be.index = { auto: {}, indexed: { "Phone/Trip/clip.mp4": { s: video.size, m: video.modified } } };
    // Moved, without its .THM: smaller now.
    const now = [item("Videos/clip.mp4", 900_000_000, 1_700_000_000_777)];
    now[0].kind = "video";
    useStore.setState({ allItems: now, allLoaded: true } as never);
    await useTags.getState().load();
    await useStore.getState().reconcileKeys(now);
    await settle();
    const sigs = (be.saved.cache as { sigs: Record<string, { video?: unknown; size: number; modified: number }> }).sigs;
    expect(sigs["Videos/clip.mp4"]?.video).toBeTruthy();
    expect(sigs["Phone/Trip/clip.mp4"]).toBeUndefined();
    // Still good for the file as it is now: the scanner won't make its frames again.
    const { cacheValid } = await import("../lib/dupes");
    expect(cacheValid(sigs["Videos/clip.mp4"] as never, now[0])).toBe(true);
    // And the tag index is told its new size before it is renamed: it isn't indexed again either.
    expect(be.saved.restamp).toEqual([["Phone/Trip/clip.mp4", 900_000_000, 1_700_000_000_777]]);
    expect(useTags.getState().data!.indexed["Videos/clip.mp4"]).toEqual({ s: 900_000_000, m: 1_700_000_000_777 });
  });
});
