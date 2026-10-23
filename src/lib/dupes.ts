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
  image?: { phash: string; dhash: string; width: number; height: number };
  video?: { frames: string[]; info: string; duration: number; width: number; height: number };
  error?: string;
}
export type SigCache = Record<string, CachedSig>;

export function cacheValid(c: CachedSig | undefined, item: MediaItem): c is CachedSig {
  return !!c && c.size === item.size && c.modified === item.modified;
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
  /** Max dHash distance for a video frame to count as matching. */
  frameThreshold: number;
  /** Fraction of informative frames of the shorter video that must match. */
  minMatchRatio: number;
}

export const SENSITIVITY: Record<"strict" | "normal" | "loose", MatchOptions> = {
  strict: { imageThreshold: 4, frameThreshold: 10, minMatchRatio: 0.9 },
  normal: { imageThreshold: 10, frameThreshold: 14, minMatchRatio: 0.8 },
  loose: { imageThreshold: 16, frameThreshold: 18, minMatchRatio: 0.7 },
};

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

export function matchVideos(a: VideoSig, b: VideoSig, opts: MatchOptions): VideoMatch | null {
  const [L, S, shorter] = a.frames.length >= b.frames.length ? [a, b, 1 as const] : [b, a, 0 as const];
  const informativeTotal = S.informative.filter(Boolean).length;
  if (S.frames.length < 3 || informativeTotal < 3) return null;
  const allowedMisses = Math.floor((1 - opts.minMatchRatio) * informativeTotal);
  let best: { ratio: number; offset: number } | null = null;
  for (let off = 0; off + S.frames.length <= L.frames.length; off++) {
    let matched = 0;
    let misses = 0;
    for (let i = 0; i < S.frames.length; i++) {
      if (!S.informative[i]) continue;
      let d = 64;
      for (let j = Math.max(0, off + i - 1); j <= Math.min(L.frames.length - 1, off + i + 1); j++) {
        d = Math.min(d, hamming(S.frames[i], L.frames[j]));
      }
      if (d <= opts.frameThreshold) matched++;
      else if (++misses > allowedMisses) break;
    }
    const ratio = matched / informativeTotal;
    if (ratio >= opts.minMatchRatio && (!best || ratio > best.ratio)) best = { ratio, offset: off };
  }
  if (!best) return null;
  const lengthDiff = Math.abs(L.frames.length - S.frames.length);
  const kind = lengthDiff <= Math.max(1, 0.1 * L.frames.length) ? "duplicate" : "contained";
  return { kind, ratio: best.ratio, offset: best.offset, shorter };
}

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function findGroups(entries: DupeEntry[], opts: MatchOptions): DupeGroup[] {
  const n = entries.length;
  const uf = new UnionFind(n);
  const notes: string[][] = Array.from({ length: n }, () => []);
  const kinds: ("exact" | "image" | "video")[] = new Array(n).fill("image");

  // Exact copies by fingerprint (any kind).
  const byFp = new Map<string, number[]>();
  entries.forEach((e, i) => {
    if (e.fp) byFp.set(e.fp, [...(byFp.get(e.fp) ?? []), i]);
  });
  for (const idxs of byFp.values()) {
    if (idxs.length < 2) continue;
    for (const i of idxs) {
      uf.union(idxs[0], i);
      notes[i].push("exact copy");
      kinds[i] = "exact";
    }
  }

  // Similar images.
  const imgs = entries.map((e, i) => (e.image ? i : -1)).filter((i) => i >= 0);
  for (let x = 0; x < imgs.length; x++) {
    for (let y = x + 1; y < imgs.length; y++) {
      const i = imgs[x];
      const j = imgs[y];
      if (entries[i].fp && entries[i].fp === entries[j].fp) continue;
      const d = hamming(entries[i].image!.phash, entries[j].image!.phash);
      if (d <= opts.imageThreshold) {
        uf.union(i, j);
        notes[i].push(`similar to ${entries[j].item.name} (d=${d})`);
        notes[j].push(`similar to ${entries[i].item.name} (d=${d})`);
      }
    }
  }

  // Videos: duplicates and clips contained in longer videos.
  const vids = entries.map((e, i) => (e.video ? i : -1)).filter((i) => i >= 0);
  for (let x = 0; x < vids.length; x++) {
    for (let y = x + 1; y < vids.length; y++) {
      const i = vids[x];
      const j = vids[y];
      if (entries[i].fp && entries[i].fp === entries[j].fp) continue;
      const m = matchVideos(entries[i].video!, entries[j].video!, opts);
      if (!m) continue;
      uf.union(i, j);
      kinds[i] = kinds[i] === "exact" ? "exact" : "video";
      kinds[j] = kinds[j] === "exact" ? "exact" : "video";
      const pct = Math.round(m.ratio * 100);
      if (m.kind === "duplicate") {
        notes[i].push(`same footage as ${entries[j].item.name} (${pct}%)`);
        notes[j].push(`same footage as ${entries[i].item.name} (${pct}%)`);
      } else {
        const [s, l] = m.shorter === 0 ? [i, j] : [j, i];
        notes[s].push(`inside ${entries[l].item.name} at ${fmtTime(m.offset)} (${pct}%)`);
        notes[l].push(`contains ${entries[s].item.name}`);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  const out: DupeGroup[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const kind = idxs.every((i) => kinds[i] === "exact") ? "exact" : idxs.some((i) => entries[i].video) ? "video" : "image";
    out.push({
      id: idxs.join("-"),
      kind,
      members: idxs
        .map((i) => ({ item: entries[i].item, notes: notes[i], image: entries[i].image, video: entries[i].video }))
        .sort((a, b) => b.item.size - a.item.size),
    });
  }
  return out.sort((a, b) => b.members.length - a.members.length || a.members[0].item.name.localeCompare(b.members[0].item.name));
}
