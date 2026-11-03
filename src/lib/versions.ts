import type { ItemSource } from "./types";

/** Two albums that look like one work in two languages: which is the original, and how sure. */
export interface VersionPair {
  original: string;
  translation: string;
  score: number;
}

/** How alike two works' tags must be (shared over all, the file's own notes left out). */
const TAGS_ALIKE = 0.5;

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
export const versionsKey = pairKey;

/**
 * Albums that look like the same work in two languages: from the same platform and artist, about
 * as many pages, most of their tags the same, in different languages. The one in Japanese (else the
 * one that came in first) is the original. Each album in one pair at most, the likeliest; ones
 * linked already, or said not to be, left out. Only suggestions: linking them is the reader's yes.
 */
export function versionPairs(
  albums: { key: string; count: number }[],
  sourceOf: (albumKey: string) => ItemSource | undefined,
  languageOf: (albumKey: string) => string | undefined,
  linked: Set<string>,
  notSame: Set<string>,
): VersionPair[] {
  const groups = new Map<string, { key: string; count: number; src: ItemSource; lang: string; tags: Set<string> }[]>();
  for (const a of albums) {
    const src = sourceOf(a.key);
    const lang = languageOf(a.key) ?? src?.language;
    if (!src?.author?.id || !lang || linked.has(a.key)) continue;
    const by = `${src.platform}|${src.author.id}`;
    const tags = new Set(src.tags.filter((t) => t.kind !== "meta").map((t) => t.name));
    groups.set(by, [...(groups.get(by) ?? []), { key: a.key, count: a.count, src, lang, tags }]);
  }
  const pairs: VersionPair[] = [];
  for (const list of groups.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (a.lang === b.lang || notSame.has(pairKey(a.key, b.key))) continue;
        // A translation keeps its pages, give or take a credits page or two.
        const off = Math.abs(a.count - b.count);
        if (off > Math.max(2, Math.round(Math.max(a.count, b.count) * 0.1))) continue;
        const shared = [...a.tags].filter((t) => b.tags.has(t)).length;
        const all = new Set([...a.tags, ...b.tags]).size;
        const alike = all ? shared / all : 0;
        if (!all || alike < TAGS_ALIKE) continue;
        const aFirst = a.lang === "ja" || (b.lang !== "ja" && a.src.added <= b.src.added);
        pairs.push({ original: aFirst ? a.key : b.key, translation: aFirst ? b.key : a.key, score: alike - off * 0.02 });
      }
  pairs.sort((x, y) => y.score - x.score);
  const used = new Set<string>();
  return pairs.filter((p) => !used.has(p.original) && !used.has(p.translation) && (used.add(p.original), used.add(p.translation), true));
}
