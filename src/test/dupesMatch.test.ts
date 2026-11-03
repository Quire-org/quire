import { describe, expect, it } from "vitest";
import { alignVideos, findGroups, hamming, matchVideos, planExact, type DupeGroup, type DupeMember, type DupeEntry, type H64, type MatchOptions, type VideoSig } from "../lib/dupes";
import { SENSITIVITY } from "../lib/dupes";
import type { MediaItem } from "../lib/types";

const opts: MatchOptions = SENSITIVITY.normal;
const item = (name: string): MediaItem => ({ key: name, primary: `/r/${name}`, files: [`/r/${name}`], name, kind: "image", dir: "", size: 1, modified: 0, hasRaw: false, hasVideo: false }) as MediaItem;
const img = (name: string, fp: string, phash: [number, number]) => ({ item: item(name), fp, image: { phash, quads: [phash, phash, phash, phash], dhash: phash, width: 10, height: 10 } }) as unknown as DupeEntry;

describe("exact copies keep to themselves", () => {
  it("two pairs of copies that look alike stay two groups", () => {
    const a = img("a1", "fpA", [0, 0]);
    const a2 = img("a2", "fpA", [0, 0]);
    const b = img("b1", "fpB", [1, 0]); // one bit away: similar
    const b2 = img("b2", "fpB", [1, 0]);
    const groups = findGroups([a, a2, b, b2], opts);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === "exact" && g.members.length === 2)).toBe(true);
  });
});

describe("video alignment", () => {
  const sig = (frames: number[], duration = frames.length): VideoSig => ({ frames: frames.map((f) => [f, 0] as [number, number]), informative: frames.map(() => true), duration, width: 1, height: 1 });
  it("finds a clip that starts before the base and runs past it", () => {
    const base = sig([10, 11, 12, 13, 14, 15, 16, 17]);
    const other = sig([1, 2, 10, 11, 12, 13, 14, 15, 16, 17, 30, 31]); // 2s before, 2s after
    const al = alignVideos(base, other, opts, 3)!;
    expect(al.offset).toBe(-2);
    expect(al.ratio).toBe(1);
  });
  it("finds a clip inside the base", () => {
    const base = sig([10, 11, 12, 13, 14, 15, 16, 17]);
    const al = alignVideos(base, sig([13, 14, 15]), opts, 3)!;
    expect(al.offset).toBe(3);
  });
  it("gives up when nothing matches", () => {
    // Every frame 32 bits away: far past any threshold.
    expect(alignVideos(sig([0, 0, 0, 0, 0]), sig([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]), opts, 3)).toBeNull();
  });
});

describe("videos sharing identical frames are exact", () => {
  const vid = (name: string, frames: number[]) =>
    ({ item: { ...item(name), kind: "video" }, fp: name, video: { frames: frames.map((f) => [f, 7] as [number, number]), informative: frames.map(() => true), duration: frames.length, width: 1, height: 1 } }) as unknown as DupeEntry;
  it("a longer cut with more footage before and after groups as exact", () => {
    const a = vid("short.mp4", [101, 102, 103, 104, 105]);
    const b = vid("long.mp4", [1, 2, 101, 102, 103, 104, 105, 9, 8]);
    const groups = findGroups([a, b], opts);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("exact");
  });
  it("a shared intro is not the same footage", () => {
    const a = vid("a.mp4", [101, 102, 103, 0xffffff, 0, 0xffffff]);
    const b = vid("b.mp4", [101, 102, 103, 0, 0xffffff, 0]);
    expect(findGroups([a, b], opts).filter((g) => g.kind === "exact")).toHaveLength(0);
  });
  it("two shared frames are not enough", () => {
    const a = vid("a.mp4", [101, 102, 50, 51, 52]);
    const b = vid("b.mp4", [101, 102, 0xffffff, 0xfffff0, 0xffff00]);
    expect(findGroups([a, b], opts).filter((g) => g.kind === "exact")).toHaveLength(0);
  });
});

describe("clips inside longer videos", () => {
  // Frames that look nothing alike: random 64-bit hashes (about 32 bits apart, far past any threshold).
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed);
  const frames = (n: number) => Array.from({ length: n }, () => [rnd(), rnd()] as [number, number]);
  const vid = (name: string, f: [number, number][]) => ({ item: { ...item(name), kind: "video", size: f.length }, video: { frames: f, informative: f.map(() => true), duration: f.length, width: 1, height: 1 } }) as unknown as DupeEntry;
  const names = (gs: DupeGroup[]) => gs.map((g) => g.members.map((m) => m.item.name).sort()).sort();

  it("a clip in two different videos shows with each, and doesn't put them in one group", () => {
    const clip = frames(8);
    const a = vid("a.mp4", [...frames(10), ...clip, ...frames(10)]);
    const b = vid("b.mp4", [...frames(15), ...clip, ...frames(12)]);
    const c = vid("clip.mp4", clip);
    expect(names(findGroups([a, b, c], SENSITIVITY.strict))).toEqual([
      ["a.mp4", "clip.mp4"],
      ["b.mp4", "clip.mp4"],
    ]);
  });

  it("the same video twice still groups, with the clips inside either", () => {
    const clip = frames(8);
    const body = [...frames(10), ...clip, ...frames(10)];
    const a = vid("a.mp4", body);
    const again = vid("a copy.mp4", [...body.slice(0, 27), ...frames(1)]);
    const c = vid("clip.mp4", clip);
    expect(names(findGroups([a, again, c], opts))).toEqual([["a copy.mp4", "a.mp4", "clip.mp4"]]);
  });

  it("a few seconds alike are not a clip inside", () => {
    const bit = frames(3);
    const a = vid("a.mp4", [...frames(20), ...bit, ...frames(20)]);
    expect(findGroups([a, vid("bit.mp4", bit)], opts)).toEqual([]);
  });
});

describe("the same footage, not look-alike footage", () => {
  let seed = 11;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed);
  const random = (): H64 => [rnd(), rnd()];
  // A hash with `bits` random bits flipped.
  const flip = (h: H64, bits: number): H64 => {
    const out: [number, number] = [h[0], h[1]];
    const done = new Set<number>();
    while (done.size < bits) done.add(rnd() >>> 26);
    for (const b of done) out[b >> 5] = (out[b >> 5] ^ (1 << (b & 31))) >>> 0;
    return out;
  };
  const sig = (frames: H64[]): VideoSig => ({ frames, informative: frames.map(() => true), duration: frames.length, width: 1, height: 1 });

  it("two different videos that look alike throughout (the same room, the same light) don't match", () => {
    const look = random();
    const a = sig(Array.from({ length: 60 }, () => flip(look, 5)));
    const b = sig(Array.from({ length: 60 }, () => flip(look, 5)));
    // Frame for frame they are close enough for every sensitivity's frame threshold, which used to match them.
    const close = a.frames.filter((f, i) => hamming(f, b.frames[i]) <= SENSITIVITY.normal.frameThreshold).length;
    expect(close / 60).toBeGreaterThan(0.9);
    for (const opts of Object.values(SENSITIVITY)) expect(matchVideos(a, b, opts)).toBeNull();
    // Nor is a stretch of one taken for a clip inside the other.
    expect(matchVideos(sig([...a.frames, ...a.frames]), sig(b.frames.slice(10, 30)), SENSITIVITY.loose)).toBeNull();
  });

  it("a re-encoded copy of moving footage matches, even with noisy frames, and a clip of it is found inside", () => {
    const a = sig(Array.from({ length: 60 }, random));
    const copy = sig(a.frames.map((f) => flip(f, 6)));
    for (const opts of Object.values(SENSITIVITY)) expect(matchVideos(a, copy, opts)?.kind).toBe("duplicate");
    const clip = sig(a.frames.slice(20, 32).map((f) => flip(f, 3)));
    expect(matchVideos(a, clip, SENSITIVITY.strict)).toMatchObject({ kind: "contained", offset: 20 });
  });

  it("a copy of footage that barely moves matches when its frames are near identical", () => {
    const look = random();
    const a = sig(Array.from({ length: 40 }, () => flip(look, 2)));
    const copy = sig(a.frames.map((f, i) => (i % 3 ? f : flip(f, 1))));
    expect(matchVideos(a, copy, SENSITIVITY.strict)?.kind).toBe("duplicate");
  });
});

describe("removing exact copies", () => {
  const mem = (name: string, w: number, extra: Partial<MediaItem> = {}): DupeMember => ({ item: { ...item(name), ...extra }, notes: [], image: { phash: [0, 0], dhash: [0, 0], width: w, height: w } as never });
  const group = (...members: DupeMember[]): DupeGroup => ({ id: members.map((m) => m.item.key).join("-"), kind: "exact", members });
  const vsig = (frames: number[]): VideoSig => ({ frames: frames.map((f) => [f, 0] as [number, number]), informative: frames.map(() => true), duration: frames.length, width: 10, height: 10 });
  const vmem = (name: string, frames: number[], w = 10): DupeMember => ({ item: { ...item(name), kind: "video" } as MediaItem, notes: [], video: { ...vsig(frames), width: w, height: w } });

  it("keeps the larger copy and moves the smaller one's tags onto it", () => {
    const big = mem("big", 2000);
    const small = mem("small", 1000);
    const tags: Record<string, string[]> = { small: ["people/ann", "tags/beach"], big: ["tags/beach"] };
    const [p] = planExact([group(small, big)], (m) => ({ tags: tags[m.item.key] ?? [] }));
    expect(p.keep).toBe(big);
    expect(p.drop).toEqual([small]);
    expect(p.tags).toEqual(["people/ann"]);
  });

  it("on equal size keeps the tagged copy, and fills in a size it never measured from its byte twin", () => {
    const a = mem("a", 1000);
    const b = { ...mem("b", 0), image: undefined };
    const [p] = planExact([group(a, b)], (m) => ({ tags: m.item.key === "b" ? ["tags/x"] : [], fp: "same" }));
    expect(p.keep).toBe(b);
    expect(p.drop).toEqual([a]);
    expect(p.tags).toEqual([]);
  });

  it("never trashes an album page", () => {
    const loose = mem("loose", 2000);
    const page = mem("page", 1000, { albumKey: "A" });
    expect(planExact([group(loose, page)], () => ({ tags: [] }))).toEqual([]);
  });

  it("leaves videos alone, even byte-identical copies", () => {
    expect(planExact([group(vmem("a", [1, 2, 3, 4]), vmem("b", [1, 2, 3, 4]))], () => ({ tags: [], fp: "same" }))).toEqual([]);
  });
});
