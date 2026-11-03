/**
 * Duplicate detection primitives.
 *
 * Hashes are 64 bits, held as two uint32 words so hamming distance is cheap.
 * Images: pHash (DCT) + dHash, computed in Rust when possible and here on a
 * canvas as a fallback (HEIC and other formats only the webview can decode).
 * Videos: one dHash per second of footage, taken from frames drawn to a
 * canvas; a clip whose frame sequence appears inside a longer video's
 * sequence is reported as contained in it.
 */
import type { MediaItem } from "./types";

export type H64 = readonly [number, number];

export function hexToH64(hex: string): H64 {
  return [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];
}
export function h64ToHex(h: H64): string {
  return h[0].toString(16).padStart(8, "0") + h[1].toString(16).padStart(8, "0");
}

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export function hamming(a: H64, b: H64): number {
  return popcount32((a[0] ^ b[0]) >>> 0) + popcount32((a[1] ^ b[1]) >>> 0);
}

/** Bits are numbered 0..63 from the most significant, as in the Rust code. */
function bitsToH64(bits: boolean[]): H64 {
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 64; i++) {
    if (!bits[i]) continue;
    if (i < 32) hi |= 1 << (31 - i);
    else lo |= 1 << (63 - i);
  }
  return [hi >>> 0, lo >>> 0];
}

/* ---------- canvas hashing ---------- */

type Drawable = HTMLImageElement | HTMLVideoElement;

function luma(ctx: CanvasRenderingContext2D, w: number, h: number): Float64Array {
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  return out;
}

const canvases = new Map<string, [HTMLCanvasElement, CanvasRenderingContext2D]>();
function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const key = `${w}x${h}`;
  let c = canvases.get(key);
  if (!c) {
    const el = document.createElement("canvas");
    el.width = w;
    el.height = h;
    c = [el, el.getContext("2d", { willReadFrequently: true })!];
    canvases.set(key, c);
  }
  return c;
}

let cosTable: Float64Array | null = null;
function cosines(): Float64Array {
  if (cosTable) return cosTable;
  const N = 32;
  cosTable = new Float64Array(N * N);
  for (let u = 0; u < N; u++) for (let x = 0; x < N; x++) cosTable[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  return cosTable;
}

export function phashOf(src: Drawable): H64 {
  const N = 32;
  const [el, ctx] = canvas(N, N);
  ctx.drawImage(src, 0, 0, N, N);
  void el;
  const px = luma(ctx, N, N);
  const cos = cosines();
  const rows = new Float64Array(N * 8);
  for (let y = 0; y < N; y++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += px[y * N + x] * cos[u * N + x];
      rows[y * 8 + u] = s;
    }
  const dct = new Float64Array(64);
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[y * 8 + u] * cos[v * N + y];
      dct[v * 8 + u] = s;
    }
  const vals = Array.from(dct.subarray(1)).sort((a, b) => a - b);
  const median = (vals[31] + vals[32]) / 2;
  const bits = new Array<boolean>(64).fill(false);
  for (let i = 1; i < 64; i++) bits[i] = dct[i] > median;
  return bitsToH64(bits);
}

/** dHash plus a flag telling whether the frame has enough detail to be meaningful. */
export function dhashOf(src: Drawable): { hash: H64; informative: boolean } {
  const [, ctx] = canvas(9, 8);
  ctx.drawImage(src, 0, 0, 9, 8);
  const px = luma(ctx, 9, 8);
  const bits = new Array<boolean>(64).fill(false);
  let mean = 0;
  for (let i = 0; i < 72; i++) mean += px[i];
  mean /= 72;
  let varsum = 0;
  for (let i = 0; i < 72; i++) varsum += (px[i] - mean) ** 2;
  let k = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits[k++] = px[y * 9 + x] > px[y * 9 + x + 1];
  return { hash: bitsToH64(bits), informative: Math.sqrt(varsum / 72) > 6 };
}

export interface ImageSig {
  phash: H64;
  /** pHash of each quarter, when the Rust hasher made it (the canvas fallback has none). */
  quads?: H64[];
  dhash: H64;
  width: number;
  height: number;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Media comes from another origin (asset protocol / dev server); without this the canvas is tainted.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = url;
  });
}

export async function hashImageUrl(url: string): Promise<ImageSig> {
  const img = await loadImage(url);
  return { phash: phashOf(img), dhash: dhashOf(img).hash, width: img.naturalWidth, height: img.naturalHeight };
}

export interface VideoSig {
  /** One dHash per sampled second, starting at t = 0.5s. */
  frames: H64[];
  informative: boolean[];
  duration: number;
  width: number;
  height: number;
}

export const VIDEO_MAX_FRAMES = 600;

export async function hashVideoUrl(url: string, isCancelled: () => boolean, onFrame?: (i: number, n: number) => void): Promise<VideoSig> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  v.src = url;
  await new Promise<void>((resolve, reject) => {
    v.onloadedmetadata = () => resolve();
    v.onerror = () => reject(new Error("video decode failed"));
  });
  const duration = isFinite(v.duration) ? v.duration : 0;
  const n = Math.min(VIDEO_MAX_FRAMES, Math.max(1, Math.floor(duration)));
  const frames: H64[] = [];
  const informative: boolean[] = [];
  for (let i = 0; i < n; i++) {
    if (isCancelled()) break;
    await seek(v, Math.min(i + 0.5, Math.max(0, duration - 0.05)));
    const { hash, informative: inf } = dhashOf(v);
    frames.push(hash);
    informative.push(inf);
    onFrame?.(i + 1, n);
  }
  const sig = { frames, informative, duration, width: v.videoWidth, height: v.videoHeight };
  v.removeAttribute("src");
  v.load();
  return sig;
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error("seek failed"));
    };
    const cleanup = () => {
      v.removeEventListener("seeked", done);
      v.removeEventListener("error", fail);
      clearTimeout(timer);
    };
    const timer = setTimeout(done, 4000); // never hang on a stuck decoder
    v.addEventListener("seeked", done);
    v.addEventListener("error", fail);
    v.currentTime = t;
  });
}

/* ---------- cache ---------- */

export interface CachedSig {
  size: number;
  modified: number;
  fp?: string;
  image?: { phash: string; quads?: string[]; dhash: string; width: number; height: number };
  video?: { frames: string[]; info: string; duration: number; width: number; height: number };
  error?: string;
}
export type SigCache = Record<string, CachedSig>;

export function cacheValid(c: CachedSig | undefined, item: MediaItem): c is CachedSig {
  // Hashes from before the quarters were kept are made again, once.
  return !!c && c.size === item.size && c.modified === item.modified && (!c.image || c.image.quads?.length === 4);
}

/* ---------- matching ---------- */

export interface DupeEntry {
  item: MediaItem;
  fp?: string;
  image?: ImageSig;
  video?: VideoSig;
}

export interface DupeMember {
  item: MediaItem;
  notes: string[];
  image?: ImageSig;
  video?: VideoSig;
}

export interface DupeGroup {
  id: string;
  kind: "exact" | "image" | "video";
  members: DupeMember[];
}

export interface MatchOptions {
  /** Max pHash hamming distance for images (64-bit). */
  imageThreshold: number;
  /**
   * Or: at least `quadsNeeded` of the four quarters within `quadThreshold` of each other. A copy with a
   * local change (a part painted over, a watermark, a crop of one corner) keeps most quarters alike,
   * where two different pictures with a similar layout don't.
   */
  quadThreshold: number;
  quadsNeeded: number;
  /** Max dHash distance for a video frame to count as matching. */
  frameThreshold: number;
  /** Fraction of informative frames of the shorter video that must match. */
  minMatchRatio: number;
  /**
   * How far the matched moment must stand out: its frames' distance at most this share of the
   * distance to the other video's other moments. Look-alike footage (the same room, the same light)
   * is about as close anywhere; the same footage is far closer where it lines up.
   */
  distinct: number;
  /** Versions of pictures a plugin made (cleaned-up pages, say), when the check for them is on. */
  versions?: VersionHint[];
  /** Versions the app knows were made from a picture (an edit, a plugin's result), by both fingerprints. */
  links?: VersionPair[];
}

/** A version and the picture it was made from, by fingerprint, called `note` ("edited"). */
export interface VersionPair {
  made: string;
  from: string;
  note: string;
}

/**
 * Pictures a plugin made from others: a page it painted over differs from its original where it
 * painted, more than copies usually do. One named `prefix` + a picture's name, beside that
 * picture ("Cleaned 012.png" next to "012.jpg"), belongs with it outright; with every other
 * picture a version is matched at the loose sensitivity's distances. `keys` are versions written
 * in place of their original, so only known by key.
 */
export interface VersionHint {
  prefix?: string;
  keys?: string[];
  /** What a version is called in the groups: "cleaned", say. */
  note: string;
}

/** Which hint, if any, makes an item a version (for its badge). */
export function versionOf(item: { key: string; name: string }, hints: readonly VersionHint[]): VersionHint | undefined {
  const name = item.name.toLowerCase();
  return hints.find((v) => (!!v.prefix && name.startsWith(v.prefix.toLowerCase()) && name.length > v.prefix.length) || !!v.keys?.includes(item.key));
}

// Measured on 53 pairs of a page and the same page partly redrawn, against 120 unrelated pages: pHash alone needs 16 to
// catch every pair, which also pulls in 1 in 120 strangers; three quarters within 6 catches all but
// one pair with no stranger at 12.
export const SENSITIVITY: Record<"strict" | "normal" | "loose", MatchOptions> = {
  strict: { imageThreshold: 4, quadThreshold: 2, quadsNeeded: 4, frameThreshold: 10, minMatchRatio: 0.9, distinct: 0.35 },
  normal: { imageThreshold: 10, quadThreshold: 4, quadsNeeded: 3, frameThreshold: 14, minMatchRatio: 0.8, distinct: 0.5 },
  loose: { imageThreshold: 12, quadThreshold: 6, quadsNeeded: 3, frameThreshold: 18, minMatchRatio: 0.7, distinct: 0.65 },
};

/** How many of the quarters are within `threshold`; none when either side has no quarters (an older cache). */
export function quadsAlike(a: ImageSig, b: ImageSig, threshold: number): number {
  if (!a.quads || !b.quads || a.quads.length !== 4 || b.quads.length !== 4) return 0;
  let n = 0;
  for (let i = 0; i < 4; i++) if (hamming(a.quads[i], b.quads[i]) <= threshold) n++;
  return n;
}

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}

export interface VideoMatch {
  kind: "duplicate" | "contained";
  ratio: number;
  /** Offset in seconds of the shorter video inside the longer one. */
  offset: number;
  /** Index of the shorter entry (the contained one). */
  shorter: 0 | 1;
}

/**
 * Where `other` sits against `base` on a timeline, in seconds (one hash per second): a negative
 * offset means `other` starts before `base`, and it may run past the end. The best overlap of at
 * least `minOverlap` informative seconds with enough matching frames, or null.
 */
export function alignVideos(base: VideoSig, other: VideoSig, opts: MatchOptions, minOverlap = 5): { offset: number; ratio: number; overlap: number } | null {
  const L = base.frames.length;
  const S = other.frames.length;
  let best: { offset: number; ratio: number; overlap: number; dist: number } | null = null;
  for (let off = -(S - minOverlap); off <= L - minOverlap; off++) {
    let seen = 0;
    let hits = 0;
    let dist = 0;
    for (let k = 0; k < S; k++) {
      const j = off + k;
      if (j < 0 || j >= L) continue;
      if (!other.informative[k] || !base.informative[j]) continue;
      seen++;
      const d = hamming(other.frames[k], base.frames[j]);
      dist += d;
      if (d <= opts.frameThreshold) hits++;
    }
    if (seen < minOverlap) continue;
    const ratio = hits / seen;
    if (ratio >= opts.minMatchRatio && (!best || ratio > best.ratio || (ratio === best.ratio && (seen > best.overlap || dist < best.dist)))) best = { offset: off, ratio, overlap: seen, dist };
  }
  return best && { offset: best.offset, ratio: best.ratio, overlap: best.overlap };
}

export function matchVideos(a: VideoSig, b: VideoSig, opts: MatchOptions): VideoMatch | null {
  const [L, S, shorter] = a.frames.length >= b.frames.length ? [a, b, 1 as const] : [b, a, 0 as const];
  const informativeTotal = S.informative.filter(Boolean).length;
  if (S.frames.length < 3 || informativeTotal < 3) return null;
  const allowedMisses = Math.floor((1 - opts.minMatchRatio) * informativeTotal);
  let best: { ratio: number; offset: number; dist: number } | null = null;
  for (let off = 0; off + S.frames.length <= L.frames.length; off++) {
    let matched = 0;
    let misses = 0;
    let dist = 0; // distance at the exact alignment, used to break ties between neighbouring offsets
    for (let i = 0; i < S.frames.length; i++) {
      if (!S.informative[i]) continue;
      let d = 64;
      for (let j = Math.max(0, off + i - 1); j <= Math.min(L.frames.length - 1, off + i + 1); j++) {
        d = Math.min(d, hamming(S.frames[i], L.frames[j]));
      }
      dist += hamming(S.frames[i], L.frames[off + i]);
      if (d <= opts.frameThreshold) matched++;
      else if (++misses > allowedMisses) break;
    }
    const ratio = matched / informativeTotal;
    // Best ratio wins; on ties the closest alignment (smallest summed distance).
    if (ratio >= opts.minMatchRatio && (!best || ratio > best.ratio || (ratio === best.ratio && dist < best.dist))) best = { ratio, offset: off, dist };
  }
  if (!best) return null;
  if (!standsOut(S, L, best.offset, opts.distinct)) return null;
  const kind = sameLength(L.frames.length, S.frames.length) ? "duplicate" : "contained";
  // A clip inside a longer video needs as much footage as the timeline shows (a few seconds of
  // look-alike frames turn up in long videos by chance).
  if (kind === "contained" && informativeTotal < 5) return null;
  return { kind, ratio: best.ratio, offset: best.offset, shorter };
}

/**
 * Whether `S` lined up at `off` in `L` is the same footage rather than look-alike footage: its
 * frames' mean distance there is at most `share` of their mean distance to other moments of `L`
 * (L shifted round by a few amounts, the median taken). Two copies of one video are far closer
 * where they line up than anywhere else; two videos of the same room under the same light are
 * about as close everywhere. Frames nearly identical throughout (a mean under 1.5 bits) are the
 * same whatever the rest.
 */
function standsOut(S: VideoSig, L: VideoSig, off: number, share: number): boolean {
  const n = L.frames.length;
  const meanAt = (shift: number) => {
    let sum = 0;
    let seen = 0;
    for (let i = 0; i < S.frames.length; i++) {
      if (!S.informative[i]) continue;
      // Where it lines up, a second either side may be the closer one (a clip cut mid-second).
      const at = (((off + i + shift) % n) + n) % n;
      let d = 64;
      for (let j = at - 1; j <= at + 1; j++) if (j >= 0 && j < n && L.informative[j]) d = Math.min(d, hamming(S.frames[i], L.frames[j]));
      if (d === 64) continue;
      sum += d;
      seen++;
    }
    return seen ? sum / seen : 64;
  };
  const here = meanAt(0);
  if (here < 1.5) return true;
  // Other moments: shifted round by a few amounts, none within 3 seconds of where it lines up.
  const shifts = [...new Set([7, 13, 29, Math.floor(n / 2), Math.floor(n / 3), n - 7, n - 13].map((x) => ((x % n) + n) % n))].filter((x) => x >= 3 && x <= n - 3).slice(0, 6);
  if (!shifts.length) return false; // too short to tell look-alike from the same
  const elsewhere = shifts.map(meanAt).sort((a, b) => a - b)[Math.floor(shifts.length / 2)];
  return here <= share * elsewhere;
}

/** Within a tenth of each other (in sampled seconds): the same video, not one inside the other. */
const sameLength = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, 0.1 * Math.max(a, b));

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/**
 * Pairs of videos (indices into `entries`, lower first, as "i|j") that share at least `minFrames`
 * identical frame hashes at one consistent offset: the same footage, frame for frame. Found by
 * bucketing hashes, so it stays fast on a big library; hashes shared by very many frames (a
 * title card, say) are left out.
 */
export function identicalFrames(entries: DupeEntry[], vids: number[], opts?: MatchOptions, minFrames = 3): Map<string, { count: number; offset: number }> {
  const buckets = new Map<string, [number, number][]>();
  for (const v of vids) {
    const sig = entries[v].video!;
    sig.frames.forEach((h, pos) => {
      if (!sig.informative[pos]) return;
      const k = `${h[0]}:${h[1]}`;
      const list = buckets.get(k) ?? [];
      list.push([v, pos]);
      buckets.set(k, list);
    });
  }
  const counts = new Map<string, number>();
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 16) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        let [vi, pi] = list[a];
        let [vj, pj] = list[b];
        if (vi === vj) continue;
        if (vi > vj) [vi, pi, vj, pj] = [vj, pj, vi, pi];
        const key = `${vi}|${vj}|${pj - pi}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  // A few shared frames (a studio intro, a title card) are not the same footage: at that offset the
  // whole overlap has to agree, most of it frame for frame.
  const thr = opts?.frameThreshold ?? 8;
  const verify = (vi: number, vj: number, off: number): number => {
    const A = entries[vi].video!;
    const B = entries[vj].video!;
    let seen = 0;
    let near = 0;
    let same = 0;
    for (let k = 0; k < A.frames.length; k++) {
      const j = k + off;
      if (j < 0 || j >= B.frames.length || !A.informative[k] || !B.informative[j]) continue;
      seen++;
      const dd = hamming(A.frames[k], B.frames[j]);
      if (dd <= thr) near++;
      if (dd === 0) same++;
    }
    return seen >= 5 && near >= 0.9 * seen && same >= Math.max(minFrames, 0.3 * seen) ? same : 0;
  };
  const out = new Map<string, { count: number; offset: number }>();
  for (const [key, count] of counts) {
    if (count < minFrames) continue;
    const [vi, vj, off] = key.split("|").map(Number);
    const pair = `${vi}|${vj}`;
    if ((out.get(pair)?.count ?? 0) >= count) continue;
    const same = verify(vi, vj, off);
    if (same) out.set(pair, { count: same, offset: off });
  }
  return out;
}

/* ---------- candidate pairs, without comparing every pair ---------- */

/** Every 16-bit mask with at most `r` bits set. */
const maskCache = new Map<number, Uint16Array>();
function masks16(r: number): Uint16Array {
  let m = maskCache.get(r);
  if (!m) {
    const out: number[] = [];
    for (let x = 0; x < 0x10000; x++) if (popcount32(x) <= r) out.push(x);
    maskCache.set(r, (m = Uint16Array.from(out)));
  }
  return m;
}

/**
 * Hashes by their four 16-bit blocks. Two hashes within distance d share a block within distance
 * floor(d / 4) (if every block differed by more, the whole would differ by more than d), so
 * looking up each block and its near neighbours finds every hash within d, and few others.
 */
class BlockIndex {
  // Per block and value, the newest entry; each entry points to the one added before it with the
  // same block value (-1 ends). Typed arrays throughout: the lookups are the hot path.
  private heads = [0, 1, 2, 3].map(() => new Int32Array(0x10000).fill(-1));
  private ids: number[] = [];
  private next: number[] = [];
  add(h: H64, id: number) {
    const parts = [h[0] >>> 16, h[0] & 0xffff, h[1] >>> 16, h[1] & 0xffff];
    for (let k = 0; k < 4; k++) {
      const head = this.heads[k];
      this.ids.push(id);
      this.next.push(head[parts[k]]);
      head[parts[k]] = this.ids.length - 1;
    }
  }
  /** Every id whose hash may be within `d` of `h` (each block looked up within floor(d / 4)); some more than once. */
  near(h: H64, d: number, visit: (id: number) => void) {
    const masks = masks16(Math.floor(d / 4));
    const parts = [h[0] >>> 16, h[0] & 0xffff, h[1] >>> 16, h[1] & 0xffff];
    const { ids, next } = this;
    for (let k = 0; k < 4; k++) {
      const head = this.heads[k];
      const v = parts[k];
      for (let x = 0; x < masks.length; x++) {
        for (let e = head[v ^ masks[x]]; e !== -1; e = next[e]) visit(ids[e]);
      }
    }
  }
}

/** Reports a share done, now and then (the caller decides how often it is passed on). */
export type Progress = (share: number) => void;

/**
 * Pairs of similar images [earlier, later, how]: a pHash within the threshold, or enough of the
 * four quarters within theirs. Found through block indexes, so the same pairs as comparing every
 * pair (the indexes can't miss one), at a fraction of the work. With quadsNeeded >= 3 at most one
 * quarter differs, so the first or the second quarter is always within threshold.
 */
function similarImagePairs(entries: DupeEntry[], imgs: number[], opts: MatchOptions, skip: Set<number>, progress: Progress, loose: Uint8Array | null = null): [number, number, string][] {
  const out: [number, number, string][] = [];
  const everyPair = opts.quadsNeeded < 3; // the quarter indexes couldn't promise to find these
  // The hashes as plain 32-bit integers side by side: comparing them is the hot path.
  const n = entries.length;
  const ph = new Int32Array(n * 2);
  const qd = new Int32Array(n * 8);
  const hasQ = new Uint8Array(n);
  for (const i of imgs) {
    const im = entries[i].image!;
    ph[2 * i] = im.phash[0] | 0;
    ph[2 * i + 1] = im.phash[1] | 0;
    if (im.quads?.length === 4) {
      hasQ[i] = 1;
      for (let q = 0; q < 4; q++) {
        qd[8 * i + 2 * q] = im.quads[q][0] | 0;
        qd[8 * i + 2 * q + 1] = im.quads[q][1] | 0;
      }
    }
  }
  const T = opts.imageThreshold;
  const QT = opts.quadThreshold;
  const need = opts.quadsNeeded;
  const byHash = new BlockIndex();
  const q0 = new BlockIndex();
  const q1 = new BlockIndex();
  const seen = new Int32Array(n).fill(-1);
  const before: number[] = [];
  for (let x = 0; x < imgs.length; x++) {
    if ((x & 255) === 0) progress(x / imgs.length);
    const i = imgs[x];
    if (skip.has(i)) continue;
    const a = entries[i].image!;
    const pa0 = ph[2 * i];
    const pa1 = ph[2 * i + 1];
    const consider = (j: number) => {
      if (seen[j] === i) return;
      seen[j] = i;
      const d = popcount32(pa0 ^ ph[2 * j]) + popcount32(pa1 ^ ph[2 * j + 1]);
      if (d <= T) return void out.push([j, i, `d=${d}`]);
      if (!hasQ[i] || !hasQ[j]) return;
      // Quarters within threshold; given up as soon as too many differ.
      let alike = 0;
      let off = 0;
      for (let q = 0; q < 4; q++) {
        const qa = 8 * i + 2 * q;
        const qb = 8 * j + 2 * q;
        if (popcount32(qd[qa] ^ qd[qb]) + popcount32(qd[qa + 1] ^ qd[qb + 1]) <= QT) alike++;
        else if (++off > 4 - need) return;
      }
      out.push([j, i, `${alike} of 4 quarters alike, d=${d}`]);
    };
    if (everyPair) before.forEach(consider);
    else {
      byHash.near(a.phash, T, consider);
      if (hasQ[i]) {
        q0.near(a.quads![0], QT, consider);
        q1.near(a.quads![1], QT, consider);
      }
    }
    before.push(i);
    byHash.add(a.phash, i);
    if (hasQ[i]) {
      q0.add(a.quads![0], i);
      q1.add(a.quads![1], i);
    }
  }
  if (!loose) return out;

  // Versions (a page a plugin painted over and its original differ where it painted): looked up
  // again among everything at the loose sensitivity's distances, for the pairs not found above.
  const L = SENSITIVITY.loose;
  const LT = Math.max(T, L.imageThreshold);
  const LQT = Math.max(QT, L.quadThreshold);
  const lneed = Math.min(need, L.quadsNeeded);
  const quads = (i: number, j: number, t: number) => {
    let n = 0;
    for (let q = 0; q < 4; q++) {
      const qa = 8 * i + 2 * q;
      const qb = 8 * j + 2 * q;
      if (popcount32(qd[qa] ^ qd[qb]) + popcount32(qd[qa + 1] ^ qd[qb + 1]) <= t) n++;
    }
    return n;
  };
  const paired = new Set<string>();
  seen.fill(-1);
  for (const i of imgs) {
    if (!loose[i] || skip.has(i)) continue;
    const a = entries[i].image!;
    const consider = (j: number) => {
      if (j === i || seen[j] === i || skip.has(j)) return;
      seen[j] = i;
      const pair = i < j ? `${i}|${j}` : `${j}|${i}`;
      if (paired.has(pair)) return; // two versions: found from either
      paired.add(pair);
      const d = popcount32(ph[2 * i] ^ ph[2 * j]) + popcount32(ph[2 * i + 1] ^ ph[2 * j + 1]);
      const both = hasQ[i] && hasQ[j];
      if (d <= T || (both && quads(i, j, QT) >= need)) return; // found above
      if (d <= LT) return void out.push([j, i, `as a version, d=${d}`]);
      const alike = both ? quads(i, j, LQT) : 0;
      if (alike >= lneed) out.push([j, i, `as a version, ${alike} of 4 quarters alike, d=${d}`]);
    };
    byHash.near(a.phash, LT, consider);
    if (hasQ[i]) {
      q0.near(a.quads![0], LQT, consider);
      q1.near(a.quads![1], LQT, consider);
    }
  }
  return out;
}

/**
 * Pairs of videos worth comparing frame by frame [lower, higher]: a few frames spread over each
 * video (all of a short one) looked up among every frame of the others. Two videos that match
 * share most of the shorter one's frames, so at least one of its samples is found unless nearly
 * every sample happens to land on the few frames that differ.
 */
function videoCandidates(entries: DupeEntry[], vids: number[], opts: MatchOptions, progress: Progress): [number, number][] {
  const SAMPLES = 10;
  const T = opts.frameThreshold;
  // Longest first: each video looks only among the longer ones already in the index (a match is
  // found from its shorter side), then goes in itself. Each pair is looked for once, not twice.
  const informative = (v: number) => entries[v].video!.frames.filter((_, k) => entries[v].video!.informative[k]);
  const order = vids.map((v) => ({ v, frames: informative(v) })).sort((a, b) => b.frames.length - a.frames.length);
  const total = order.reduce((a, x) => a + x.frames.length, 0);
  const owner = new Int32Array(total);
  const hi = new Int32Array(total);
  const lo = new Int32Array(total);
  const index = new BlockIndex();
  const pairs = new Set<number>();
  const n = entries.length;
  let filled = 0;
  for (let x = 0; x < order.length; x++) {
    if ((x & 15) === 0) progress(x / order.length);
    const { v, frames } = order[x];
    const step = Math.max(1, frames.length / SAMPLES);
    for (let t = 0; t < Math.min(SAMPLES, frames.length); t++) {
      const h = frames[Math.floor(t * step)];
      const h0 = h[0] | 0;
      const h1 = h[1] | 0;
      index.near(h, T, (f) => {
        const w = owner[f];
        const key = v < w ? v * n + w : w * n + v;
        if (pairs.has(key)) return;
        if (popcount32(h0 ^ hi[f]) + popcount32(h1 ^ lo[f]) <= T) pairs.add(key);
      });
    }
    for (const h of frames) {
      owner[filled] = v;
      hi[filled] = h[0] | 0;
      lo[filled] = h[1] | 0;
      index.add(h, filled++);
    }
  }
  return [...pairs].sort((a, b) => a - b).map((k) => [Math.floor(k / n), k % n]);
}

export function findGroups(entries: DupeEntry[], opts: MatchOptions, progress: Progress = () => {}): DupeGroup[] {
  const n = entries.length;
  const uf = new UnionFind(n);
  const notes: string[][] = Array.from({ length: n }, () => []);
  const kinds: ("exact" | "image" | "video")[] = new Array(n).fill("image");

  // Exact copies by fingerprint (any kind).
  const byFp = new Map<string, number[]>();
  entries.forEach((e, i) => {
    if (e.fp) byFp.set(e.fp, [...(byFp.get(e.fp) ?? []), i]);
  });
  // Exact copies keep to themselves: a pair of copies that merely looks like another pair is not one group.
  const exact = new Set<number>();
  for (const idxs of byFp.values()) {
    if (idxs.length < 2) continue;
    for (const i of idxs) {
      uf.union(idxs[0], i);
      notes[i].push("exact copy");
      kinds[i] = "exact";
      exact.add(i);
    }
  }

  // How far along: pictures first, then videos, each weighed by how many there are.
  const imgs = entries.map((e, i) => (e.image ? i : -1)).filter((i) => i >= 0);
  const vids = entries.map((e, i) => (e.video ? i : -1)).filter((i) => i >= 0);
  const imgShare = imgs.length + vids.length ? imgs.length / (imgs.length + vids.length * 4) : 1;
  const part = (from: number, width: number): Progress => (f) => progress(from + f * width);

  // Versions a plugin made, when the check for them is on: one named after its picture beside it
  // belongs with it outright; the others are matched more loosely below.
  const versions = opts.versions ?? [];
  const loose = versions.length ? new Uint8Array(n) : null;
  if (loose) {
    const byName = new Map<string, number[]>();
    imgs.forEach((i) => {
      const k = `${entries[i].item.dir}\n${entries[i].item.name.toLowerCase()}`;
      byName.set(k, [...(byName.get(k) ?? []), i]);
    });
    for (const v of versions) {
      const keys = new Set(v.keys ?? []);
      const prefix = v.prefix?.toLowerCase() ?? "";
      for (const i of imgs) {
        const name = entries[i].item.name.toLowerCase();
        const named = !!prefix && name.startsWith(prefix) && name.length > prefix.length;
        if (!named && !keys.has(entries[i].item.key)) continue;
        loose[i] = 1;
        if (!named) continue;
        for (const j of byName.get(`${entries[i].item.dir}\n${name.slice(prefix.length)}`) ?? []) {
          if (j === i) continue;
          uf.union(i, j);
          notes[i].push(`${v.note} version of ${entries[j].item.name}`);
          notes[j].push(`${v.note} version: ${entries[i].item.name}`);
        }
      }
    }
  }

  // Versions the app made or saved, with what they were made from outright, wherever either has gone.
  for (const l of opts.links ?? []) {
    for (const i of byFp.get(l.made) ?? [])
      for (const j of byFp.get(l.from) ?? []) {
        if (i === j) continue;
        uf.union(i, j);
        notes[i].push(`${l.note} version of ${entries[j].item.name}`);
        notes[j].push(`${l.note} version: ${entries[i].item.name}`);
      }
  }

  // Similar images (exact copies keep to themselves).
  for (const [j, i, how] of similarImagePairs(entries, imgs, opts, exact, part(0, imgShare), loose)) {
    uf.union(i, j);
    notes[i].push(`similar to ${entries[j].item.name} (${how})`);
    notes[j].push(`similar to ${entries[i].item.name} (${how})`);
  }

  // Videos: duplicates and clips contained in longer videos. Compared frame by frame only where
  // a sampled frame turned up in the other video, or they share identical frames.
  const frameExact = identicalFrames(entries, vids, opts);
  const vidShare = 1 - imgShare;
  const found = videoCandidates(entries, vids, opts, part(imgShare, vidShare / 2));
  const seenPair = new Set(found.map(([i, j]) => `${i}|${j}`));
  for (const key of frameExact.keys()) {
    if (seenPair.has(key)) continue;
    const [i, j] = key.split("|").map(Number);
    found.push([i, j]);
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const compare = part(imgShare + vidShare / 2, vidShare / 2);
  // A clip inside a longer video is not joined to it: both of two videos holding the same clip (a
  // studio intro, a scene in two compilations) would end up in one group with each other, and
  // everything they hold too. The clip shows in the group of each video it is in instead.
  const inside: [number, number][] = []; // [clip, container]
  for (let c = 0; c < found.length; c++) {
    if ((c & 63) === 0) compare(c / found.length);
    {
      const [i, j] = found[c];
      const longer = entries[i].video!.frames.length >= entries[j].video!.frames.length ? i : j;
      const shorter = longer === i ? j : i;
      // Footage they share frame for frame: the same video when as long, else a clip inside the other.
      const same = frameExact.get(`${i}|${j}`);
      if (same) {
        const one = sameLength(entries[i].video!.frames.length, entries[j].video!.frames.length);
        if (one) uf.union(i, j);
        else inside.push([shorter, longer]);
        kinds[i] = "exact";
        kinds[j] = "exact";
        notes[i].push(`${same.count} identical frames with ${entries[j].item.name}`);
        notes[j].push(`${same.count} identical frames with ${entries[i].item.name}`);
        continue;
      }
      if (exact.has(i) || exact.has(j)) continue;
      const m = matchVideos(entries[i].video!, entries[j].video!, opts);
      if (!m) continue;
      kinds[i] = kinds[i] === "exact" ? "exact" : "video";
      kinds[j] = kinds[j] === "exact" ? "exact" : "video";
      const pct = Math.round(m.ratio * 100);
      if (m.kind === "duplicate") {
        uf.union(i, j);
        notes[i].push(`same footage as ${entries[j].item.name} (${pct}%)`);
        notes[j].push(`same footage as ${entries[i].item.name} (${pct}%)`);
      } else {
        const [s, l] = m.shorter === 0 ? [i, j] : [j, i];
        inside.push([s, l]);
        notes[s].push(`inside ${entries[l].item.name} at ${fmtTime(m.offset)} (${pct}%)`);
        notes[l].push(`contains ${entries[s].item.name}`);
      }
    }
  }

  // Groups: things that are the same (copies, look-alikes, the same footage), each with the clips
  // inside it, and theirs. A group held inside another shows only within that one.
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    clusters.set(r, [...(clusters.get(r) ?? []), i]);
  }
  const holds = new Map<number, Set<number>>();
  const held = new Set<number>();
  for (const [c, l] of inside) {
    const rc = uf.find(c);
    const rl = uf.find(l);
    if (rc === rl) continue;
    holds.set(rl, (holds.get(rl) ?? new Set()).add(rc));
    held.add(rc);
  }
  const out: DupeGroup[] = [];
  for (const [r, own] of clusters) {
    if (held.has(r)) continue; // shown inside what holds it
    const idxs = new Set(own);
    const seen = new Set([r]);
    const walk = (x: number) => {
      for (const y of holds.get(x) ?? []) {
        if (seen.has(y)) continue;
        seen.add(y);
        for (const i of clusters.get(y) ?? []) idxs.add(i);
        walk(y);
      }
    };
    walk(r);
    if (idxs.size < 2) continue;
    const list = [...idxs].sort((a, b) => a - b);
    const kind = list.every((i) => kinds[i] === "exact") ? "exact" : list.some((i) => entries[i].video) ? "video" : "image";
    out.push({
      id: list.join("-"),
      kind,
      members: list
        .map((i) => ({ item: entries[i].item, notes: notes[i], image: entries[i].image, video: entries[i].video }))
        .sort((a, b) => b.item.size - a.item.size),
    });
  }
  return out.sort((a, b) => b.members.length - a.members.length || a.members[0].item.name.localeCompare(b.members[0].item.name));
}

/* ---------------- matching off the main thread ---------------- */

let matcher: Worker | null = null;
let matchSeq = 0;
const matchWaiting = new Map<number, { resolve: (g: DupeGroup[]) => void; entries: DupeEntry[]; opts: MatchOptions; progress?: Progress }>();

/**
 * `findGroups`, in a worker when the browser has them (the match is quadratic: on a big library it
 * takes seconds, which would freeze every button), or right here for a small set or without workers.
 */
export function matchGroups(entries: DupeEntry[], opts: MatchOptions, progress?: Progress): Promise<DupeGroup[]> {
  if (typeof Worker === "undefined" || entries.length < 400) return Promise.resolve(findGroups(entries, opts, progress));
  try {
    if (!matcher) {
      matcher = new Worker(new URL("./dupeWorker.ts", import.meta.url), { type: "module" });
      matcher.onmessage = (e: MessageEvent<{ id: number; groups?: DupeGroup[]; progress?: number }>) => {
        const w = matchWaiting.get(e.data.id);
        if (e.data.groups === undefined) return void w?.progress?.(e.data.progress ?? 0);
        matchWaiting.delete(e.data.id);
        w?.resolve(e.data.groups);
      };
      matcher.onerror = () => {
        // The worker is gone: answer what was waiting here, and try a fresh worker next time.
        const pending = [...matchWaiting.values()];
        matchWaiting.clear();
        matcher?.terminate();
        matcher = null;
        for (const w of pending) w.resolve(findGroups(w.entries, w.opts, w.progress));
      };
    }
  } catch {
    return Promise.resolve(findGroups(entries, opts));
  }
  const id = ++matchSeq;
  return new Promise((resolve) => {
    matchWaiting.set(id, { resolve, entries, opts, progress });
    matcher!.postMessage({ id, entries, opts });
  });
}

/** Small JPEG data URLs of a video at the given seconds, for a timeline. Empty when it can't be decoded. */
export async function videoStrip(url: string, times: number[], width = 120): Promise<string[]> {
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  v.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve();
      v.onerror = () => reject(new Error("video decode failed"));
    });
    const c = document.createElement("canvas");
    c.width = width;
    c.height = Math.max(1, Math.round((width * (v.videoHeight || 9)) / (v.videoWidth || 16)));
    const ctx = c.getContext("2d");
    if (!ctx) return [];
    const out: string[] = [];
    for (const t of times) {
      await new Promise<void>((resolve) => {
        const done = () => {
          v.removeEventListener("seeked", done);
          resolve();
        };
        v.addEventListener("seeked", done);
        setTimeout(done, 4000);
        v.currentTime = Math.min(Math.max(0, t), Math.max(0, (v.duration || t) - 0.05));
      });
      ctx.drawImage(v, 0, 0, c.width, c.height);
      out.push(c.toDataURL("image/jpeg", 0.7));
    }
    return out;
  } catch {
    return [];
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

/* ---------- removing exact copies ---------- */

/** What "Remove exact duplicates" does with one exact group. */
export interface ExactPlan {
  group: DupeGroup;
  /** The copy that stays: the most pixels, then the most tags. */
  keep: DupeMember;
  /** The copies that go to the trash. */
  drop: DupeMember[];
  /** Tags of the dropped copies that the kept one doesn't have yet. */
  tags: string[];
  /** Copies left alone: album pages (a hole would break the album). */
  spared: DupeMember[];
}

/**
 * For each exact group of pictures, the copy to keep and the copies to trash.
 * Byte-identical copies share their resolution (one may simply not have been
 * measured). Videos are left alone: a compilation can hold a whole clip, and
 * both are worth keeping.
 */
export function planExact(groups: DupeGroup[], info: (m: DupeMember) => { tags: string[]; fp?: string }): ExactPlan[] {
  const out: ExactPlan[] = [];
  for (const g of groups) {
    if (g.kind !== "exact" || g.members.length < 2) continue;
    if (g.members.some((m) => m.video || m.item.kind === "video")) continue;
    const meta = new Map(g.members.map((m) => [m, info(m)]));
    const own = (m: DupeMember) => {
      const s = m.image ?? m.video;
      return s ? s.width * s.height : 0;
    };
    const pixels = (m: DupeMember) => {
      const fp = meta.get(m)!.fp;
      return Math.max(own(m), ...g.members.filter((o) => fp && meta.get(o)!.fp === fp).map(own));
    };
    const ranked = [...g.members].sort(
      (a, b) =>
        pixels(b) - pixels(a) ||
        meta.get(b)!.tags.length - meta.get(a)!.tags.length ||
        // An album page stays anyway, so it is the better keeper.
        Number(!!b.item.albumKey) - Number(!!a.item.albumKey) ||
        a.item.modified - b.item.modified,
    );
    const keep = ranked[0];
    const drop: DupeMember[] = [];
    const spared: DupeMember[] = [];
    for (const m of ranked.slice(1)) {
      if (m.item.albumKey) spared.push(m);
      else drop.push(m);
    }
    if (!drop.length) continue;
    const have = new Set(meta.get(keep)!.tags);
    const tags = [...new Set(drop.flatMap((m) => meta.get(m)!.tags))].filter((t) => !have.has(t));
    out.push({ group: g, keep, drop, tags, spared });
  }
  return out;
}

