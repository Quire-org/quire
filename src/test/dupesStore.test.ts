import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";

// The store talks to Tauri through lib/api; replace it with an in-memory fake.
const fake = vi.hoisted(() => ({
  cache: null as unknown,
  fingerprints: new Map<string, string>(),
  hashes: new Map<string, { phash: string; dhash: string; width: number; height: number }>(),
}));

vi.mock("../lib/api", () => ({
  api: {
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
      library: { version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} },
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
    fake.hashes.set("/root/c.jpg", { phash: "0000000000000000", dhash: "0", width: 10, height: 10 });
    useDupes.setState({ includeVideos: false });

    await expect(useDupes.getState().scan()).resolves.toBeUndefined();
    const { groups, entries, progress } = useDupes.getState();
    expect(progress.stage).toBe("done");
    expect(entries).toHaveLength(3);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("exact");
    expect(groups[0].members.map((m) => m.item.key).sort()).toEqual(["a.mp4", "b.mp4"]);
  });

  it("uses the cache for unchanged files and only hashes new ones", async () => {
    const a = item("a.jpg", "image");
    const b = item("b.jpg", "image");
    fake.hashes.set(a.primary, { phash: "ff00ff00ff00ff00", dhash: "0", width: 10, height: 10 });
    fake.hashes.set(b.primary, { phash: "ff00ff00ff00ff01", dhash: "0", width: 10, height: 10 });
    useStore.setState({ allItems: [a, b] });

    await useDupes.getState().scan();
    const { api } = await import("../lib/api");
    expect(vi.mocked(api.imageHash)).toHaveBeenCalledTimes(2);
    expect(useDupes.getState().groups).toHaveLength(1); // d=1

    // Second scan with one new file: only the new one is hashed.
    const c = item("c.jpg", "image");
    fake.hashes.set(c.primary, { phash: "0000000000000000", dhash: "0", width: 10, height: 10 });
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
    const clip = { frames: seq.slice(3, 7), informative: [true, true, true, true], duration: 4, width: 1, height: 1 };
    const m = matchVideos(long, clip, SENSITIVITY.normal);
    expect(m?.kind).toBe("contained");
    expect(m?.offset).toBe(3);
    const other = { frames: seq.map((h) => [~h[0] >>> 0, ~h[1] >>> 0] as const), informative: seq.map(() => true), duration: 8, width: 1, height: 1 };
    expect(matchVideos(long, other, SENSITIVITY.normal)).toBeNull();
  });
});
