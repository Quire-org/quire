/**
 * "Do I have this?" for a work in Find: the library's pictures that are it, by what Find kept when
 * it came in, by the work's id in a file's name (as a platform names its downloads), or by the
 * picture itself, against the duplicate check's fingerprints.
 */
import { cacheValid, hamming, hexToH64, quadsAlike, type ImageSig, type SigCache } from "./dupes";
import type { ImageHashResult, ItemSource, MediaItem } from "./types";
import { hasWork } from "./sources";

export interface HaveMatch {
  item: MediaItem;
  /** imported: brought in from this work through Find; picture: the same picture; name: its id in the name. */
  why: "imported" | "picture" | "name";
  /** The same picture: how alike (`likeness`). */
  score?: number;
}

export interface HaveResult {
  matches: HaveMatch[];
  /** The library's pictures, and how many of them the duplicate check has fingerprinted. */
  pictures: number;
  fingerprinted: number;
}

export const sigOf = (h: ImageHashResult): ImageSig => ({ phash: hexToH64(h.phash), quads: h.quads?.map(hexToH64), dhash: hexToH64(h.dhash), width: h.width, height: h.height });

/** A likeness this high: surely the same picture (taken as it is, given an artist by itself). */
export const SURE_MATCH = 0.8;
/** Below this: not the same picture. */
export const LIKE_MATCH = 0.6;

/**
 * How alike two pictures are, 0 to 1 (0: not the same picture), lenient on a part painted again
 * (a part redrawn, a watermark): the same shape, and the whole alike (pHash within 12 bits;
 * scored with the dHash too), or, if a part changed a lot, quarters near the same. Measured on
 * public pictures with a big part covered on one side and painted again on the other: the whole
 * stayed within 8 bits and dHash 7 (a likeness of 0.69 at worst, 0.94 typically); different
 * pictures of the same shape came no nearer than 16, and never had two quarters near the same
 * with the whole within 20, nor three at all.
 */
export function likeness(a: ImageSig, b: ImageSig): number {
  if (!a.width || !a.height || !b.width || !b.height || Math.abs(a.width / a.height / (b.width / b.height) - 1) > 0.04) return 0;
  const whole = hamming(a.phash, b.phash);
  if (whole <= 12) {
    const s = 1 - (whole + hamming(a.dhash, b.dhash)) / 48;
    if (s >= LIKE_MATCH) return Math.min(1, s);
  }
  // A part changed a lot: three quarters near the same, or two and the whole not far off (never
  // either among the different pictures measured).
  const near = quadsAlike(a, b, 4);
  return near >= 3 ? LIKE_MATCH + 0.1 : near === 2 && whole <= 20 ? LIKE_MATCH : 0;
}

export function findInLibrary(work: { platform: string; id: string }, hashes: ImageHashResult[], items: MediaItem[], sources: Record<string, ItemSource>, cache: SigCache): HaveResult {
  const found = new Map<string, HaveMatch>();
  const byKey = new Map(items.map((i) => [i.key, i]));
  const add = (item: MediaItem | undefined, why: HaveMatch["why"], score?: number) => item && !found.has(item.key) && found.set(item.key, { item, why, ...(score != null ? { score } : {}) });
  for (const [k, s] of Object.entries(sources)) if (hasWork(s, work)) add(byKey.get(k), "imported");
  const sigs = hashes.map(sigOf);
  let pictures = 0;
  let fingerprinted = 0;
  for (const it of items) {
    if (it.kind === "video") continue;
    pictures++;
    const c = cache[it.key];
    if (!cacheValid(c, it) || !c.image) continue;
    fingerprinted++;
    const mine = sigOf(c.image);
    const best = Math.max(0, ...sigs.map((s) => likeness(s, mine)));
    if (best >= LIKE_MATCH) add(it, "picture", best);
  }
  // A platform's id in a file's name, standing alone (12345678_1.png, art_12345678_2026…): long
  // enough not to be a picture number.
  if (/^\d{6,}$/.test(work.id)) {
    const alone = new RegExp(`(^|\\D)${work.id}(\\D|$)`);
    for (const it of items) if (alone.test(it.name)) add(it, "name");
  }
  const order = { imported: 0, picture: 1, name: 2 };
  return { matches: [...found.values()].sort((a, b) => order[a.why] - order[b.why] || (b.score ?? 1) - (a.score ?? 1)), pictures, fingerprinted };
}
