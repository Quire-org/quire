import { useMemo } from "react";
import { create } from "zustand";
import { api } from "./lib/api";
import { steppedJob } from "./lib/jobs";
import { cacheValid } from "./lib/dupes";
import { lookAlikes, pairKey, seriesIndex } from "./lib/series";
import { CACHE_VERSION, signItem, useDupes } from "./dupesStore";
import { useVersions } from "./versionsStore";
import { useStore } from "./store";
import type { MediaItem } from "./lib/types";

/**
 * Series suggested in Sort: the pictures waiting there are looked at as the duplicate check does
 * (once each, kept in its cache), so the one on show can be offered with its look-alikes.
 */
interface SeriesStore {
  /** Bumped as pictures are looked at, so suggestions are made again. */
  looked: number;
}

export const useSeries = create<SeriesStore>(() => ({ looked: 0 }));

const isPicture = (i: MediaItem) => (i.kind === "image" || i.kind === "raw") && !i.albumKey;

let looking = false;

/** The pictures among `items` not looked at yet, looked at: a job in Activity (pause, stop), skipped while the duplicate check runs. */
export async function lookForSeries(items: MediaItem[]): Promise<void> {
  const root = useStore.getState().root;
  if (looking || !root) return;
  await useDupes.getState().loadCache();
  const ds = useDupes.getState();
  if (ds.running || ds.cacheRoot !== root) return;
  const cache = ds.cache;
  const todo = items.filter((i) => isPicture(i) && !(cacheValid(cache[i.key], i) && cache[i.key].image));
  if (!todo.length) return;
  looking = true;
  const { job, gate } = steppedJob({ title: "Looking for series", source: "Sort", total: todo.length });
  const save = () => api.saveCache(root, { version: CACHE_VERSION, sigs: cache, ignored: useDupes.getState().ignored, matched: useDupes.getState().matched }).catch(() => {});
  try {
    for (let k = 0; k < todo.length; k++) {
      if (!(await gate.pass()) || useStore.getState().root !== root || useDupes.getState().running) break;
      const it = todo[k];
      job.update({ done: k, detail: `${k + 1} of ${todo.length}: ${it.name}`, items: [{ key: it.key, name: it.name }] });
      await signItem(it, cache);
      if (k % 25 === 24) {
        useSeries.setState({ looked: useSeries.getState().looked + 1 });
        await save();
      }
    }
    await save();
  } finally {
    job.finish();
    looking = false;
    useSeries.setState({ looked: useSeries.getState().looked + 1 });
  }
}

/**
 * The pictures of the queue that would make a series with `item`, closest first; none when it is in
 * a series already or isn't a picture. Pictures in a series of their own, pairs turned down, and a
 * picture and its version are left out.
 */
export function useSuggestedSeries(item: MediaItem | undefined, queue: MediaItem[]): string[] {
  const library = useStore((s) => s.library);
  const looked = useSeries((s) => s.looked);
  const cache = useDupes((d) => d.cache);
  const links = useVersions((v) => v.links);
  return useMemo(() => {
    if (!item || !isPicture(item)) return [];
    const index = seriesIndex(library?.series);
    if (index.has(item.key)) return [];
    const not = new Set(library?.seriesNot ?? []);
    const fpOf = (k: string) => cache[k]?.fp;
    const versionOf = (a: string, b: string) => {
      const [fa, fb] = [fpOf(a), fpOf(b)];
      return !!fa && !!fb && (links[fa]?.from === fb || links[fb]?.from === fa);
    };
    const others = queue.filter((q) => isPicture(q) && !index.has(q.key)).map((q) => q.key);
    return lookAlikes(item.key, others, cache, (a, b) => not.has(pairKey(a, b)) || versionOf(a, b));
    // `looked`: the cache is filled in place as pictures are looked at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.key, queue, library?.series, library?.seriesNot, cache, links, looked]);
}
