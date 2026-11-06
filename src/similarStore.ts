import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { api } from "./lib/api";
import { LOOKS_FLOOR, SIGNALS, rankSimilar, type Signal, type SimilarData } from "./lib/similar";
import { useStore } from "./store";
import type { MediaItem, TagData } from "./lib/types";

/** How many pictures near it the tag index is asked for at most. */
const LOOKS_MAX = 3000;

interface SimilarStore {
  /** The picture Browse shows the pictures most like (none: Browse as usual). */
  seed: string | null;
  /** It is a video: asked by its frames. */
  video: boolean;
  /** What is switched off. */
  off: Signal[];
  /** The tag index's answer for a seed: the pictures near it and their cosine. Kept, so Browse coming back (from one of them opened) has it at once. */
  looks: { of: string; near: Map<string, number> } | null;
}

export const useSimilar = create<SimilarStore>(() => ({ seed: null, video: false, off: [], looks: null }));

/** What can be a picture to show the likes of: one Browse shows (not an album's page). */
export const canShowSimilar = (item: MediaItem) => !item.albumKey;

/** Browse, with the pictures most like `item` first (right-click › Show similar, wherever a picture is). */
export function showSimilar(item: MediaItem) {
  if (!canShowSimilar(item)) return;
  useSimilar.setState({ seed: item.key, video: item.kind === "video", off: [] });
  useStore.getState().openBrowse();
}

/** Pictures moved (see followMoves): the one its likes show, and those it found, go on being them. */
export function followSimilar(move: (key: string) => string | null) {
  const { seed, looks } = useSimilar.getState();
  if (!seed) return;
  const to = (k: string) => move(k) ?? k;
  useSimilar.setState({ seed: to(seed), looks: looks && { of: to(looks.of), near: new Map([...looks.near].map(([k, c]) => [to(k), c])) } });
}

export const endSimilar = () => useSimilar.setState({ seed: null });

export function toggleSignal(id: Signal) {
  const off = useSimilar.getState().off;
  useSimilar.setState({ off: off.includes(id) ? off.filter((x) => x !== id) : [...off, id] });
}

// Another library (or none): its pictures aren't this one's.
useStore.subscribe((st, prev) => {
  if (st.root !== prev.root) useSimilar.setState({ seed: null, looks: null });
});

/**
 * The keys of `all` in order of likeness to the seed, the seed first (the rest aren't alike enough);
 * null when Show similar is off. `looking`: how the pictures look is still being asked of the tag index.
 * `d`: the pictures' tags, artists and people, as the filters have them.
 */
export function useSimilarOrder(all: MediaItem[], d: { tags: TagData | null; artistItems: SimilarData["artistItems"]; peopleKeys: SimilarData["peopleKeys"] }): { keys: string[]; looking: boolean } | null {
  const seed = useSimilar((s) => s.seed);
  const video = useSimilar((s) => s.video);
  const off = useSimilar((s) => s.off);
  const looks = useSimilar((s) => s.looks);
  const root = useStore((s) => s.root);
  const known = !!seed && looks?.of === seed;
  useEffect(() => {
    if (!seed || !root || known) return;
    // A video asks by its frames, and a video's frames count as well as its whole: the whole is their
    // mean, more like other videos' means than like any picture, so a video found only videos.
    const near = (pairs: [string, number][]) => useSimilar.getState().seed === seed && useSimilar.setState({ looks: { of: seed, near: new Map(pairs) } });
    api
      .tagsRank(root, { queries: [video ? { parts: seed } : { keys: [seed] }], candidates: null, groups: {}, skip: [seed], min: LOOKS_FLOOR, limit: LOOKS_MAX, parts: true })
      .then(near)
      .catch(() => near([]));
  }, [seed, root, known, video]);
  const { tags, artistItems, peopleKeys } = d;
  return useMemo(() => {
    if (!seed) return null;
    if (!looks || !known) return { keys: [seed], looking: true };
    const on = new Set(SIGNALS.map((s) => s.id).filter((id) => !off.includes(id)));
    const keys = all.map((i) => i.key);
    return { keys: [seed, ...rankSimilar(seed, keys, { looks: looks.near, tags: tags?.tags ?? {}, artistItems, peopleKeys }, on)], looking: false };
  }, [seed, off, looks, known, all, tags, artistItems, peopleKeys]);
}
