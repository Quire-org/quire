import type { ItemSource } from "./types";

/**
 * Where a picture came from: the work it came in as, and the same work met on other platforms since
 * (a crosspost, found by "Do I have this?", Find source or an artist's works), kept in its `also`.
 */
export function allSources(s: ItemSource | undefined): ItemSource[] {
  return s ? [s, ...(s.also ?? [])] : [];
}

const same = (a: { platform: string; id: string }, b: { platform: string; id: string }) => a.platform === b.platform && a.id === b.id;

/** Whether a picture's sources have this work. */
export function hasWork(s: ItemSource | undefined, work: { platform: string; id: string }): boolean {
  return allSources(s).some((x) => same(x, work));
}

/**
 * A picture's sources with one more: the work it came in as when it has none, else that work again
 * (as the platform says it now), else one of its crossposts (new, or again).
 */
export function withSource(had: ItemSource | undefined, src: ItemSource): ItemSource {
  const { also: _also, ...plain } = src;
  if (!had) return plain;
  if (same(had, plain)) return { ...plain, ...(had.also?.length ? { also: had.also } : {}) };
  const also = had.also ?? [];
  return { ...had, also: also.some((x) => same(x, plain)) ? also.map((x) => (same(x, plain) ? plain : x)) : [...also, plain] };
}
