import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";

// The store talks to Tauri through lib/api; replace it with an in-memory fake.
const fake = vi.hoisted(() => ({
  cache: null as unknown,
  fingerprints: new Map<string, string>(),
  hashes: new Map<string, { phash: string; quads?: string[]; dhash: string; width: number; height: number }>(),
}));

vi.mock("../lib/api", () => ({
  api: {
    versionsLoad: vi.fn(async () => null),
    loadCache: vi.fn(async () => fake.cache),
    saveCache: vi.fn(async (_root: string, c: unknown) => {
      fake.cache = c;
    }),
    fileFingerprint: vi.fn(async (p: string) => fake.fingerprints.get(p) ?? "fp-" + p),
    imageHash: vi.fn(async (p: string) => {
      const h = fake.hashes.get(p);
      if (!h) throw new Error("decode");
      return h;
    }),
    readBenchmark: vi.fn(async () => ({ mbPerS: 100 })),
  },
  fileSrc: (p: string) => "file://" + p,
  mediaUrl: (i: { primary: string }) => "file://" + i.primary,
  rawPreviewUrl: async (p: string) => "blob:" + p,
}));

vi.mock("../lib/dupes", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/dupes")>();
  return {
    ...mod,
    // No real <video> in jsdom: pretend every video is 4 identical informative frames.
    hashVideoUrl: vi.fn(async () => ({
      frames: [mod.hexToH64("00ff00ff00ff00ff"), mod.hexToH64("0f0f0f0f0f0f0f0f"), mod.hexToH64("ff00ff00ff00ff00"), mod.hexToH64("f0f0f0f0f0f0f0f0")],
      informative: [true, true, true, true],
      duration: 4,
      width: 640,
      height: 360,
    })),
    hashImageUrl: vi.fn(async () => {
      throw new Error("no canvas in tests");
    }),
    // Counted, to see when the store matches and when it reuses what it matched before.
    matchGroups: vi.fn(mod.matchGroups),
  };
});

import { useStore } from "../store";
import { useDupes } from "../dupesStore";

function item(key: string, kind: MediaItem["kind"], size = 1000): MediaItem {
  return { key, primary: "/root/" + key, files: ["/root/" + key], kind, name: key.replace(/\.[^.]+$/, ""), dir: "", size, modified: 1, hasRaw: false, hasVideo: kind === "video" };
}

describe("duplicate scan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.cache = null;
    fake.fingerprints.clear();
    fake.hashes.clear();
    useStore.setState({
      root: "/root",
      library: { version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, autoDecodeAlbumNames: false, backupDest: null, lastBackup: null, ids: {} },
      allItems: [],
      allLoaded: true,
      allStale: false,
      toasts: [],
    });
    useDupes.setState({ groups: [], entries: [], running: false, progress: { stage: "idle", done: 0, total: 0, eta: null }, includeVideos: true, cacheRoot: null, cache: {}, folders: null, scope: "all", sensitivity: "normal" });
  });

  it("does not crash on videos when video analysis is off, and still finds exact video copies", async () => {
    const a = item("a.mp4", "video");
    const b = item("b.mp4", "video");
    fake.fingerprints.set(a.primary, "same");
    fake.fingerprints.set(b.primary, "same");
    useStore.setState({ allItems: [a, b, item("c.jpg", "image")] });
    fake.hashes.set("/root/c.jpg", { phash: "0000000000000000", quads: ["0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000"], dhash: "0", width: 10, height: 10 });
    useDupes.setState({ includeVideos: false });

    await expect(useDupes.getState().scan()).resolves.toBeUndefined();
    const { groups, entries, progress } = useDupes.getState();
    expect(progress.stage).toBe("done");
    expect(entries).toHaveLength(3);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("exact");
    expect(groups[0].members.map((m) => m.item.key).sort()).toEqual(["a.mp4", "b.mp4"]);
  });

  it("shows the groups found before when the folder is opened again, without scanning", async () => {
    const a = item("a.jpg", "image");
    const b = item("b.jpg", "image");
    const c = item("c.jpg", "image");
    fake.fingerprints.set(a.primary, "same");
    fake.fingerprints.set(b.primary, "same");
    for (const x of [a, b, c]) fake.hashes.set(x.primary, { phash: x === c ? "0000000000000000" : "ff00ff00ff00ff00", quads: Array(4).fill(x === c ? "0000000000000000" : "ff00ff00ff00ff00"), dhash: "0", width: 10, height: 10 });
    useStore.setState({ allItems: [a, b, c] });
    await useDupes.getState().scan();
    expect(useDupes.getState().groups).toHaveLength(1);

    // The card taken out and put back (or the app restarted): nothing in memory but the saved cache.
    useDupes.setState({ groups: [], entries: [], cache: {}, cacheRoot: null, scanned: 0, progress: { stage: "idle", done: 0, total: 0, eta: null } });
    const { api } = await import("../lib/api");
    vi.mocked(api.imageHash).mockClear();
    vi.mocked(api.fileFingerprint).mockClear();
    await useDupes.getState().loadCache();
    await useDupes.getState().refreshCandidates();
    const st = useDupes.getState();
    expect(st.groups).toHaveLength(1);
    expect(st.groups[0].kind).toBe("exact");
    expect(st.groups[0].members.map((m) => m.item.key).sort()).toEqual(["a.jpg", "b.jpg"]);
    expect(st.progress.stage).toBe("done");
    expect(vi.mocked(api.imageHash)).not.toHaveBeenCalled();
    expect(vi.mocked(api.fileFingerprint)).not.toHaveBeenCalled();

    // A file changed since its scan is left out until it is scanned again.
    useStore.setState({ allItems: [a, { ...b, size: 2000 }, c] });
    await useDupes.getState().refreshCandidates();
    expect(useDupes.getState().groups).toEqual([]);
    expect(useDupes.getState().estimate.newStills).toBe(1);
  });

  it("matches once when the screen opens twice, and not at all when nothing changed (restart included)", async () => {
    const files = ["a", "b", "c", "d"].map((k) => item(`${k}.jpg`, "image"));
    for (const f of files) {
      fake.fingerprints.set(f.primary, f.key < "c" ? "pair1" : "pair2");
      fake.hashes.set(f.primary, { phash: "ff00ff00ff00ff00", quads: Array(4).fill("ff00ff00ff00ff00"), dhash: "0", width: 10, height: 10 });
    }
    useStore.setState({ allItems: files });
    await useDupes.getState().scan();
    expect(useDupes.getState().groups).toHaveLength(2);
    const { matchGroups } = await import("../lib/dupes");
    const matches = vi.mocked(matchGroups);

    // Restart: only the saved cache. The screen opens twice at once (React does so in development).
    const fresh = () => useDupes.setState({ groups: [], entries: [], cache: {}, cacheRoot: null, matched: null, scanned: 0, progress: { stage: "idle", done: 0, total: 0, eta: null } });
    // As the screen does: the saved cache read first, then what is in scope matched (or shown as kept).
    const open = async () => {
      await useDupes.getState().loadCache();
      await useDupes.getState().refreshCandidates();
    };
    fresh();
    matches.mockClear();
    await Promise.all([open(), open()]);
    expect(matches).not.toHaveBeenCalled(); // the scan's match, kept in the cache file
    expect(useDupes.getState().groups).toHaveLength(2);

    // Opened again, nothing changed: shown as it was.
    await open();
    expect(matches).not.toHaveBeenCalled();
    expect(useDupes.getState().groups).toHaveLength(2);

    // A copy trashed from the screen: the kept match follows, still nothing to match again.
    useDupes.getState().removeItem("d.jpg");
    useStore.setState({ allItems: files.slice(0, 3) });
    await useDupes.getState().refreshCandidates();
    expect(matches).not.toHaveBeenCalled();
    expect(useDupes.getState().groups.map((g) => g.members.map((m) => m.item.key).sort())).toEqual([["a.jpg", "b.jpg"]]);

    // Without a kept match, two opens at once match once, and its groups show.
    fresh();
    fake.cache = { ...(fake.cache as object), matched: undefined };
    await Promise.all([open(), open()]);
    expect(matches).toHaveBeenCalledTimes(1);
    expect(useDupes.getState().groups).toHaveLength(1);
  });

  it("uses the cache for unchanged files and only hashes new ones", async () => {
    const a = item("a.jpg", "image");
    const b = item("b.jpg", "image");
    fake.hashes.set(a.primary, { phash: "ff00ff00ff00ff00", quads: ["ff00ff00ff00ff00", "ff00ff00ff00ff00", "ff00ff00ff00ff00", "ff00ff00ff00ff00"], dhash: "0", width: 10, height: 10 });
    fake.hashes.set(b.primary, { phash: "ff00ff00ff00ff01", quads: ["ff00ff00ff00ff01", "ff00ff00ff00ff01", "ff00ff00ff00ff01", "ff00ff00ff00ff01"], dhash: "0", width: 10, height: 10 });
    useStore.setState({ allItems: [a, b] });

    await useDupes.getState().scan();
    const { api } = await import("../lib/api");
    expect(vi.mocked(api.imageHash)).toHaveBeenCalledTimes(2);
    expect(useDupes.getState().groups).toHaveLength(1); // d=1

    // Second scan with one new file: only the new one is hashed.
    const c = item("c.jpg", "image");
    fake.hashes.set(c.primary, { phash: "0000000000000000", quads: ["0000000000000000", "0000000000000000", "0000000000000000", "0000000000000000"], dhash: "0", width: 10, height: 10 });
    useStore.setState({ allItems: [a, b, c] });
    vi.mocked(api.imageHash).mockClear();
    await useDupes.getState().scan();
    expect(vi.mocked(api.imageHash)).toHaveBeenCalledTimes(1);
    expect(useDupes.getState().estimate.cached).toBe(3);
  });

  it("detects a clip contained in a longer video", async () => {
    const { matchVideos, hexToH64, SENSITIVITY } = await import("../lib/dupes");
    const seq = ["00ff00ff00ff00ff", "0f0f0f0f0f0f0f0f", "ff00ff00ff00ff00", "f0f0f0f0f0f0f0f0", "aaaaaaaaaaaaaaaa", "5555555555555555", "123456789abcdef0", "0fedcba987654321"].map(hexToH64);
    const long = { frames: seq, informative: seq.map(() => true), duration: 8, width: 1, height: 1 };
    const clip = { frames: seq.slice(3, 8), informative: [true, true, true, true, true], duration: 5, width: 1, height: 1 };
    const m = matchVideos(long, clip, SENSITIVITY.normal);
    expect(m?.kind).toBe("contained");
    expect(m?.offset).toBe(3);
    // Four seconds alike are too few to call it a clip inside (the timeline couldn't place it either).
    expect(matchVideos(long, { ...clip, frames: seq.slice(3, 7), informative: [true, true, true, true], duration: 4 }, SENSITIVITY.normal)).toBeNull();
    const other = { frames: seq.map((h) => [~h[0] >>> 0, ~h[1] >>> 0] as const), informative: seq.map(() => true), duration: 8, width: 1, height: 1 };
    expect(matchVideos(long, other, SENSITIVITY.normal)).toBeNull();
  });
});
