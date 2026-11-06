/**
 * Show similar: the pictures most like one, as a station plays songs like one. Four things count,
 * each can be switched off: how it looks (the tag index's embedding of the whole picture), the tags
 * it shares (a rare tag more than a common one), its artist, and the people in it.
 */
export type Signal = "looks" | "tags" | "artist" | "people";

export const SIGNALS: { id: Signal; label: string; title: string }[] = [
  { id: "looks", label: "Looks", title: "Looks alike: its colours, what is in it, how it is drawn or shot. Only pictures the tagger has gone through (Tags) count here" },
  { id: "tags", label: "Tags", title: "Shares its tags: a rare tag counts for more than one on half the library" },
  { id: "artist", label: "Artist", title: "By the same artist" },
  { id: "people", label: "People", title: "Someone in it is in this one too" },
];

/** How much each counts. */
const WEIGHT: Record<Signal, number> = { looks: 1, tags: 1, artist: 0.6, people: 0.8 };

/** A cosine at or below this is no likeness (pictures with nothing in common still score some); 1 is the same picture. */
export const LOOKS_FLOOR = 0.5;

/**
 * As alike as this at least, all counted (each signal 0 to 1, the artist 0.6): a cosine of 0.65, a
 * third of its tags (by weight) shared, the same artist, or one of its few people. Below it, nearly
 * every picture is a little alike (sharing "1girl", say), and the list would be the library reordered.
 */
const SIMILAR_MIN = 0.3;

export interface SimilarData {
  /** Pictures near the seed in the tag index, and their cosine with it. */
  looks: ReadonlyMap<string, number>;
  /** Each picture's tags. */
  tags: Readonly<Record<string, readonly string[]>>;
  /** Each picture's artists. */
  artistItems: Readonly<Record<string, readonly string[]>> | undefined;
  /** Each person's pictures. */
  peopleKeys: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The pictures among `keys` alike `seed` by what is on, most alike first; the seed itself left out. */
export function rankSimilar(seed: string, keys: readonly string[], d: SimilarData, on: ReadonlySet<Signal>): string[] {
  // A tag weighs as much as it tells: in a few pictures a lot, in most of them little, in all nothing.
  const mine = on.has("tags") ? (d.tags[seed] ?? []) : [];
  const seen = new Map(mine.map((t) => [t, 0]));
  if (seen.size) for (const k of keys) for (const t of d.tags[k] ?? []) if (seen.has(t)) seen.set(t, seen.get(t)! + 1);
  const tagWeight = new Map([...seen].map(([t, n]) => [t, Math.log(keys.length / Math.max(1, n))]));
  const tagTotal = [...tagWeight.values()].reduce((a, b) => a + b, 0);
  const artists = new Set(on.has("artist") ? (d.artistItems?.[seed] ?? []) : []);
  const people = on.has("people") ? [...d.peopleKeys].filter(([, ks]) => ks.has(seed)).map(([, ks]) => ks) : [];
  const found: { k: string; score: number }[] = [];
  for (const k of keys) {
    if (k === seed) continue;
    let score = 0;
    const cos = on.has("looks") ? d.looks.get(k) : undefined;
    if (cos != null && cos > LOOKS_FLOOR) score += (WEIGHT.looks * (cos - LOOKS_FLOOR)) / (1 - LOOKS_FLOOR);
    if (tagTotal) score += (WEIGHT.tags * (d.tags[k] ?? []).reduce((a, t) => a + (tagWeight.get(t) ?? 0), 0)) / tagTotal;
    if (artists.size && (d.artistItems?.[k] ?? []).some((a) => artists.has(a))) score += WEIGHT.artist;
    if (people.length) score += (WEIGHT.people * people.filter((ks) => ks.has(k)).length) / people.length;
    if (score >= SIMILAR_MIN) found.push({ k, score });
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.k);
}
