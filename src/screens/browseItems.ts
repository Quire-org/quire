import { useDeferredValue, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { filterPictures, NO_FILTER, useFilterData, usePictureFilterSections, type PictureFilter } from "../components/PictureFilters";
import type { Filter } from "../components/Filters";
import { naturalCompare, shuffled } from "../lib/format";
import { seriesIndex, stacks } from "../lib/series";
import type { MediaItem } from "../lib/types";
import { useSimilarOrder } from "../similarStore";
import { useStore, type BrowseFilters } from "../store";

export type SortSel = "name" | "date" | "rating" | "size";

/** Every filter off (the search, order and layout stay). */
export const FILTERS_OFF: Partial<BrowseFilters> = { location: "all", kind: "all", folders: null, minRating: 0, unratedOnly: false, tagged: "all", tags: [], tagsMode: "or", tagsOut: [], tagsOutMode: "or", artists: [], people: [] };

/** What Browse shows, on a computer and a phone alike: the library narrowed by its filters, then in the order asked for. */
export function useBrowseItems() {
  const s = useStore(useShallow((x) => ({ allItems: x.allItems, browseFilters: x.browseFilters, library: x.library, seriesTogether: x.seriesTogether, setBrowseFilters: x.setBrowseFilters, viewed: x.viewed })));
  const f = s.browseFilters;
  const { location, kind, query, sortBy, desc, minRating, unratedOnly, random, tagged = "all", tags: tagsSel = [], tagsMode = "or", tagsOut = [], tagsOutMode = "or", artists: artistsSel = [], people: peopleSel = [] } = f;
  const seed = useStore((st) => st.browseSeed);
  // Typing stays instant; filtering the whole library follows a beat behind.
  const searchQuery = useDeferredValue(query);
  const targets = s.library?.targets ?? [];
  const all = useMemo(() => s.allItems.filter((i) => !i.albumKey), [s.allItems]);
  const ratings = s.library?.ratings ?? {};
  const viewed = s.viewed;
  const targetName = useMemo(() => Object.fromEntries(targets.map((t) => [t.id, t.name])), [targets]);

  // Narrowed as everywhere pictures are (PictureFilters), then in the order asked for.
  const picked = useMemo<PictureFilter>(() => ({ ...NO_FILTER, location, kind, folders: f.folders, query: searchQuery, minRating, unratedOnly, tagged, tags: tagsSel, tagsMode, tagsOut, tagsOutMode, artists: artistsSel, people: peopleSel }), [location, kind, f.folders, searchQuery, minRating, unratedOnly, tagged, tagsSel, tagsMode, tagsOut, tagsOutMode, artistsSel, peopleSel]);
  const filterData = useFilterData(picked);
  // A rating or a view is a reason to put the list in order again only when it is ordered by them.
  const ratingsForSort = sortBy === "rating" ? ratings : null;
  const viewedForSort = location === "recent" ? viewed : null;
  // Show similar: the most alike first, as far as the filters let them through.
  const similar = useSimilarOrder(all, filterData);
  const seedKey = similar?.keys[0];
  const seedItem = useMemo(() => (seedKey ? all.find((i) => i.key === seedKey) : undefined), [all, seedKey]);
  const items = useMemo(() => {
    const list = filterPictures(all, picked, filterData);
    if (similar) {
      const at = new Map(similar.keys.map((k, i) => [k, i]));
      return list.filter((i) => at.has(i.key)).sort((a, b) => at.get(a.key)! - at.get(b.key)!);
    }
    if (random) return shuffled(list, seed);
    if (location === "recent") return list.slice().sort((a, b) => (viewed[b.key] ?? 0) - (viewed[a.key] ?? 0));
    const cmp: Record<SortSel, (a: MediaItem, b: MediaItem) => number> = {
      name: (a, b) => naturalCompare(a.name, b.name),
      date: (a, b) => a.modified - b.modified,
      size: (a, b) => a.size - b.size,
      rating: (a, b) => (ratings[a.key] ?? 0) - (ratings[b.key] ?? 0) || a.name.localeCompare(b.name),
    };
    const out = list.slice().sort(cmp[sortBy]);
    return desc ? out.reverse() : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, picked, filterData, similar, random, seed, sortBy, desc, ratingsForSort, viewedForSort]);

  // The filters, as every screen shows them: a section each in the panel, chips for what is on.
  const filters: Filter[] = usePictureFilterSections({ ...picked, query }, s.setBrowseFilters, all);

  // Series kept together are one tile, the rest of each behind its first picture; opened, all of them in a row.
  const seriesOf = useMemo(() => seriesIndex(s.library?.series), [s.library?.series]);
  const tiles = useMemo(() => (s.seriesTogether ? stacks(items, seriesOf) : items.map((item) => ({ item, members: [item] }))), [items, seriesOf, s.seriesTogether]);

  return { all, items, tiles, filters, similar, seedKey, seedItem, seriesOf, ratings, targetName };
}
