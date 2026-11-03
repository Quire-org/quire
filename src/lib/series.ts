import { SENSITIVITY, hamming, hexToH64, quadsAlike, type CachedSig, type ImageSig } from "./dupes";

/**
 * Series: pictures alike that are kept on purpose, all of them (a burst, glasses on and off, an
 * artist's variations of a drawing), as the library keeps them: each a list of item keys, a picture
 * in one at most. Kept together (a setting), a series comes up whole in Sort, where one key files all
 * of it, and is one tile in Browse.
 */
export type Series = string[];

/** A pair of keys as the library keeps one said not to be a series: in order. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** How many pictures of a series are in the library: one deleted waits in the trash, for Undo. */
export const seriesCount = (series: Series, trashDir: string | undefined) => {
  const trash = `${(trashDir ?? "").replace(/\/+$/, "")}/`;
  return series.filter((k) => !trashDir || !k.startsWith(trash)).length;
};

/** Each key's series. */
export function seriesIndex(series: readonly Series[] | undefined): Map<string, Series> {
  const index = new Map<string, Series>();
  for (const s of series ?? []) for (const k of s) index.set(k, s);
  return index;
}

/** The series with `keys` made one: with every series any of them was in, in the order given then theirs. */
export function joined(series: readonly Series[], keys: readonly string[]): Series[] {
  const touched = series.filter((s) => s.some((k) => keys.includes(k)));
  const one = [...new Set([...keys, ...touched.flat()])];
  const rest = series.filter((s) => !touched.includes(s));
  return one.length > 1 ? [...rest, one] : rest;
}

/** The series without `keys`; one left with a single picture is none. */
export function without(series: readonly Series[], keys: readonly string[]): Series[] {
  const gone = new Set(keys);
  return series.map((s) => s.filter((k) => !gone.has(k))).filter((s) => s.length > 1);
}

/** Items with each series whole where its first member comes, in the series' order (Sort, a viewer's queue). */
export function together<T extends { key: string }>(items: readonly T[], index: Map<string, Series>): T[] {
  if (!index.size) return items.slice();
  const byKey = new Map(items.map((i) => [i.key, i]));
  const done = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (done.has(it.key)) continue;
    const s = index.get(it.key);
    if (!s) {
      out.push(it);
      continue;
    }
    for (const k of s) {
      const m = byKey.get(k);
      if (m && !done.has(k)) {
        out.push(m);
        done.add(k);
      }
    }
  }
  return out;
}

/** Browse's tiles: a series as one, its first member showing, with the rest of it behind. */
export function stacks<T extends { key: string }>(items: readonly T[], index: Map<string, Series>): { item: T; members: T[] }[] {
  const ordered = together(items, index);
  const out: { item: T; members: T[] }[] = [];
  for (const it of ordered) {
    const last = out[out.length - 1];
    const s = index.get(it.key);
    if (last && s && index.get(last.item.key) === s) last.members.push(it);
    else out.push({ item: it, members: [it] });
  }
  return out;
}

const sigOf = (c: CachedSig["image"]): ImageSig | null => (c ? { phash: hexToH64(c.phash), quads: c.quads?.map(hexToH64), dhash: hexToH64(c.dhash), width: c.width, height: c.height } : null);

/** At most this many pictures in a suggested series: a series is a few pictures, not a folder. */
export const SERIES_MAX = 8;

/**
 * The pictures among `others` that look like `key`'s, closest first: a series to suggest. Alike as
 * the duplicate check's loose sensitivity has it (a pose or an outfit changed leaves most of the
 * picture alike); an exact copy is a duplicate, not a series, and pairs said not to be one, or a
 * picture and its version, are left out. When they were made doesn't matter (an artist's variations
 * are saved weeks apart); between two as alike, the one made nearer in time comes first.
 */
export function lookAlikes(key: string, others: readonly string[], cache: Record<string, CachedSig | undefined>, skip: (a: string, b: string) => boolean): string[] {
  const mine = sigOf(cache[key]?.image);
  if (!mine) return [];
  const loose = SENSITIVITY.loose;
  const fp = cache[key]?.fp;
  const when = cache[key]?.modified ?? 0;
  const found: { k: string; d: number; t: number }[] = [];
  for (const k of others) {
    if (k === key || skip(key, k)) continue;
    const c = cache[k];
    const theirs = sigOf(c?.image);
    if (!theirs || (fp && c?.fp === fp)) continue;
    const d = hamming(mine.phash, theirs.phash);
    if (d <= loose.imageThreshold || quadsAlike(mine, theirs, loose.quadThreshold) >= loose.quadsNeeded) found.push({ k, d, t: Math.abs((c?.modified ?? 0) - when) });
  }
  return found
    .sort((a, b) => a.d - b.d || a.t - b.t)
    .slice(0, SERIES_MAX - 1)
    .map((f) => f.k);
}
