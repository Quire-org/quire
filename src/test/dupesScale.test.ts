import { describe, expect, it } from "vitest";
import { findGroups, hamming, matchVideos, quadsAlike, SENSITIVITY, type DupeEntry, type MatchOptions } from "../lib/dupes";
import type { MediaItem } from "../lib/types";

type H = readonly [number, number];
// Repeatable randomness.
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const item = (k: string) => ({ key: k, name: k, primary: k, files: [k], kind: "image", dir: "", size: 1, modified: 0 }) as MediaItem;

function makers(seed: number) {
  const r = rng(seed);
  const u32 = () => Math.floor(r() * 4294967296) >>> 0;
  const hash = (): H => [u32(), u32()];
  // `bits` distinct bits flipped.
  const flip = (h: H, bits: number): H => {
    const out: [number, number] = [h[0], h[1]];
    const done = new Set<number>();
    while (done.size < bits) {
      const b = Math.floor(r() * 64);
      if (done.has(b)) continue;
      done.add(b);
      if (b < 32) out[0] = (out[0] ^ (1 << b)) >>> 0;
      else out[1] = (out[1] ^ (1 << (b - 32))) >>> 0;
    }
    return out;
  };
  return { r, hash, flip };
}

/** Pictures: random ones, and near copies of some, close in the whole hash or only in most quarters. */
function pictures(n: number, seed: number): DupeEntry[] {
  const { r, hash, flip } = makers(seed);
  const out: DupeEntry[] = [];
  for (let i = 0; i < n; i++) {
    const base = out.length && r() < 0.2 ? out[Math.floor(r() * out.length)].image! : null;
    const image = base
      ? r() < 0.5
        ? { phash: flip(base.phash, Math.floor(r() * 14)), quads: base.quads!.map((q) => flip(q, Math.floor(r() * 8))), dhash: hash(), width: 1, height: 1 }
        : { phash: flip(base.phash, 14 + Math.floor(r() * 10)), quads: base.quads!.map((q, k) => (k === Math.floor(r() * 4) ? hash() : flip(q, Math.floor(r() * 7)))), dhash: hash(), width: 1, height: 1 }
      : { phash: hash(), quads: [hash(), hash(), hash(), hash()], dhash: hash(), width: 1, height: 1 };
    out.push({ item: item(`p${i}`), image } as unknown as DupeEntry);
  }
  return out;
}

/** What comparing every pair gives (the old way), as sorted key lists. */
function everyPair(entries: DupeEntry[], opts: MatchOptions, videos = false): string[][] {
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      const [a, b] = [entries[i], entries[j]];
      const alike = videos
        ? !!matchVideos(a.video!, b.video!, opts)
        : hamming(a.image!.phash, b.image!.phash) <= opts.imageThreshold || quadsAlike(a.image!, b.image!, opts.quadThreshold) >= opts.quadsNeeded;
      if (alike) parent[find(i)] = find(j);
    }
  const groups = new Map<number, string[]>();
  entries.forEach((e, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), e.item.key]));
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
}
const keys = (gs: ReturnType<typeof findGroups>) => gs.map((g) => g.members.map((m) => m.item.key).sort()).sort((a, b) => a[0].localeCompare(b[0]));

describe("matching at scale", () => {
  it("finds exactly the picture groups that comparing every pair finds, at every sensitivity", () => {
    for (const [name, opts] of Object.entries(SENSITIVITY)) {
      for (const seed of [1, 2, 3]) {
        const entries = pictures(1500, seed * 7 + name.length);
        const want = everyPair(entries, opts);
        expect(want.length).toBeGreaterThan(20); // the planted copies are there to find
        expect(keys(findGroups(entries, opts)), `${name}, seed ${seed}`).toEqual(want);
      }
    }
  });

  it("finds copies and clips among many videos, as comparing every pair does", () => {
    const { r, hash, flip } = makers(42);
    const entries: DupeEntry[] = [];
    const video = (frames: H[]) => ({ frames, informative: frames.map(() => true), duration: frames.length, width: 1, height: 1 });
    for (let i = 0; i < 220; i++) {
      const base = entries.length > 10 && r() < 0.25 ? entries[Math.floor(r() * entries.length)].video! : null;
      let frames: H[];
      if (!base) frames = Array.from({ length: 10 + Math.floor(r() * 50) }, hash);
      else if (r() < 0.5) frames = base.frames.map((h) => flip(h, Math.floor(r() * 6))); // a re-encoded copy
      else {
        const from = Math.floor(r() * Math.max(1, base.frames.length - 8));
        frames = base.frames.slice(from, from + 8 + Math.floor(r() * 10)).map((h) => flip(h, Math.floor(r() * 6))); // a clip
      }
      entries.push({ item: { ...item(`v${i}`), kind: "video" }, video: video(frames) } as unknown as DupeEntry);
    }
    const opts = SENSITIVITY.normal;
    const want = everyPair(entries, opts, true);
    expect(want.length).toBeGreaterThan(10);
    expect(keys(findGroups(entries, opts))).toEqual(want);
  });

  it("matches a big library in seconds, and says how far it is", () => {
    const entries = pictures(40000, 99);
    const shares: number[] = [];
    const t0 = performance.now();
    const groups = findGroups(entries, SENSITIVITY.normal, (f) => shares.push(f));
    const ms = performance.now() - t0;
    expect(groups.length).toBeGreaterThan(1000);
    // About a second on a laptop, several on a shared CI runner; comparing every pair took minutes.
    expect(ms).toBeLessThan(20000);
    expect(shares.length).toBeGreaterThan(10);
    expect(shares.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= shares[i - 1]))).toBe(true);
  });
});
