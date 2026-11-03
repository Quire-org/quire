import { useMemo, useRef } from "react";
import { useStore, type BrowseFilters } from "../store";
import { useTags } from "../tagsStore";
import { useArtists } from "../artistsStore";
import { TagFilter, matchesTagQuery } from "./TagFilter";
import { ChoiceFilter, PickFilter, RatingFilter, pickChips, ratingChips, useArtistOptions, usePeopleKeys, usePeopleOptions, type Filter } from "./Filters";
import { FolderPicker } from "./FolderPicker";
import { inTarget } from "../lib/filing";
import type { MediaItem, TagData } from "../lib/types";

/**
 * Narrowing pictures down, as Browse does it: where they are, their folders, their type, words in
 * their name, folder or tags, their tags, rating, artists and people. Browse and the Home's picture
 * blocks share it: the same filters, the same panel sections.
 */
export type PictureFilter = Pick<BrowseFilters, "location" | "kind" | "folders" | "query" | "minRating" | "unratedOnly" | "tagged" | "tags" | "tagsMode" | "tagsOut" | "tagsOutMode" | "artists" | "people">;

/** Every filter off. */
export const NO_FILTER: PictureFilter = { location: "all", kind: "all", folders: null, query: "", minRating: 0, unratedOnly: false, tagged: "all", tags: [], tagsMode: "or", tagsOut: [], tagsOutMode: "or", artists: [], people: [] };

/** What filtering reads besides the pictures. */
export interface FilterData {
  ratings: Record<string, number>;
  viewed: Record<string, number>;
  tags: TagData | null;
  artistItems: Record<string, string[]> | undefined;
  peopleKeys: Map<string, Set<string>>;
}

/** The pictures the filter lets through, in the order given. */
export function filterPictures(list: MediaItem[], filter: Partial<PictureFilter>, d: FilterData): MediaItem[] {
  const f = { ...NO_FILTER, ...filter };
  const { location } = f;
  const { viewed } = d;
  if (location === "unsorted") list = list.filter((i) => !i.targetId);
  else if (location === "recent") list = list.filter((i) => viewed[i.key]);
  else if (location === "unseen") list = list.filter((i) => !viewed[i.key]);
  else if (location !== "all") {
    // A target's pictures, with those in a folder of its that has a key of its own.
    const targets = useStore.getState().library?.targets ?? [];
    const t = targets.find((x) => x.id === location);
    list = list.filter((i) => (t ? inTarget(i, t, targets) : i.targetId === location));
  }
  if (f.kind !== "all") list = list.filter((i) => i.kind === f.kind);
  if (f.folders) {
    const folders = new Set(f.folders);
    list = list.filter((i) => folders.has(i.dir));
  }
  const tagsOf = (i: MediaItem) => d.tags?.tags[i.key] ?? [];
  if (f.query.trim()) {
    // Words match the name, the folder, or a tag; "#word" only tags.
    const q = f.query.trim().toLowerCase();
    const onlyTags = q.startsWith("#");
    const term = onlyTags ? q.slice(1) : q;
    const bundled = new Set(Object.entries(d.tags?.bundles ?? {}).filter(([n]) => n.toLowerCase().includes(term)).flatMap(([, ids]) => ids));
    const hasTag = (i: MediaItem) => tagsOf(i).some((id) => id.toLowerCase().includes(term) || bundled.has(id));
    list = list.filter((i) => hasTag(i) || (!onlyTags && (i.name.toLowerCase().includes(q) || i.dir.toLowerCase().includes(q))));
  }
  if (f.tagged !== "all") list = list.filter((i) => (tagsOf(i).length ? "tagged" : "untagged") === f.tagged);
  if (f.tags.length || f.tagsOut.length) {
    const q = { tags: f.tags, tagsMode: f.tagsMode, tagsOut: f.tagsOut, tagsOutMode: f.tagsOutMode };
    list = list.filter((i) => matchesTagQuery(tagsOf(i), q, d.tags?.bundles ?? {}));
  }
  if (f.unratedOnly) list = list.filter((i) => d.ratings[i.key] == null);
  else if (f.minRating > 0) list = list.filter((i) => (d.ratings[i.key] ?? 0) >= f.minRating);
  if (f.artists.length) list = list.filter((i) => (d.artistItems?.[i.key] ?? []).some((id) => f.artists.includes(id)));
  if (f.people.length) list = list.filter((i) => f.people.some((p) => d.peopleKeys.get(p)?.has(i.key)));
  return list;
}

/**
 * What filtering reads, from the stores. Ratings change on every keypress in the viewer; they only
 * bring a new filter set (and so a refilter of the whole library on Browse and every Home block)
 * when `filter` asks for them. The same for the view history.
 */
export function useFilterData(filter?: Partial<PictureFilter>): FilterData {
  const wantRatings = !!(filter?.minRating || filter?.unratedOnly);
  const wantViewed = filter?.location === "recent" || filter?.location === "unseen";
  const ratings = useStore((s) => s.library?.ratings);
  const viewed = useStore((s) => s.viewed);
  const tags = useTags((t) => t.data);
  const artistItems = useArtists((a) => a.doc?.items);
  const peopleKeys = usePeopleKeys();
  const latest = useRef({ ratings, viewed });
  latest.current = { ratings, viewed };
  // Read through `latest` so the filter sees current values even when they aren't a reason to refilter.
  return useMemo(
    () => ({
      get ratings() {
        return latest.current.ratings ?? {};
      },
      get viewed() {
        return latest.current.viewed;
      },
      tags,
      artistItems,
      peopleKeys,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wantRatings ? ratings : null, wantViewed ? viewed : null, tags, artistItems, peopleKeys],
  );
}

const KIND_NAME = { image: "Photos", raw: "RAW", video: "Videos" } as const;

/** The filters as a panel shows them: a section each, with chips for what is on. `all`: the pictures they narrow (for counts and folders). */
export function usePictureFilterSections(f: PictureFilter, set: (patch: Partial<PictureFilter>) => void, all: MediaItem[]): Filter[] {
  const targets = useStore((s) => s.library?.targets) ?? [];
  const viewed = useStore((s) => s.viewed);
  const artistOptions = useArtistOptions();
  const peopleOptions = usePeopleOptions();
  const folders = useMemo(() => (f.folders ? new Set(f.folders) : null), [f.folders]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length, unsorted: 0, recent: 0, unseen: 0 };
    for (const i of all) {
      if (i.targetId) c[i.targetId] = (c[i.targetId] ?? 0) + 1;
      else c.unsorted++;
      if (viewed[i.key]) c.recent++;
      else c.unseen++;
    }
    return c;
  }, [all, viewed]);
  const targetName = Object.fromEntries(targets.map((t) => [t.id, t.name]));
  const tagName = (id: string) => id.slice(id.lastIndexOf("/") + 1);
  return [
    {
      id: "where",
      label: "Where",
      chips: f.location === "all" ? [] : [{ key: f.location, label: ({ unsorted: "Unsorted", recent: "Recently viewed", unseen: "Never viewed" } as Record<string, string>)[f.location] ?? targetName[f.location] ?? f.location, remove: () => set({ location: "all" }) }],
      body: (
        <ChoiceFilter
          value={f.location}
          onChange={(v) => set({ location: v })}
          options={[
            { value: "all", label: "Everything", count: counts.all },
            { value: "unsorted", label: "Unsorted", count: counts.unsorted },
            ...targets.map((t) => ({ value: t.id, label: t.name, count: counts[t.id] ?? 0 })),
            { value: "recent", label: "Recently viewed", count: counts.recent, title: "What you looked at, newest first" },
            { value: "unseen", label: "Never viewed", count: counts.unseen, title: "Never opened in the viewer" },
          ]}
        />
      ),
    },
    { id: "folders", label: "Folders", chips: folders ? [{ key: "folders", label: `${folders.size} folder${folders.size === 1 ? "" : "s"}`, remove: () => set({ folders: null }) }] : [], body: <FolderPicker items={all} selected={folders} onChange={(v) => set({ folders: v ? [...v] : null })} /> },
    {
      id: "type",
      label: "Type",
      chips: f.kind === "all" ? [] : [{ key: f.kind, label: KIND_NAME[f.kind], remove: () => set({ kind: "all" }) }],
      body: <ChoiceFilter value={f.kind} onChange={(v) => set({ kind: v })} options={(["all", "image", "raw", "video"] as const).map((k) => ({ value: k, label: k === "all" ? "All" : KIND_NAME[k] }))} />,
    },
    {
      id: "tags",
      label: "Tags",
      chips: [
        ...(f.tagged === "all" ? [] : [{ key: f.tagged, label: f.tagged === "tagged" ? "Tagged" : "Untagged", remove: () => set({ tagged: "all" }) }]),
        ...f.tags.map((id) => ({ key: `in:${id}`, label: `#${tagName(id)}`, title: id, remove: () => set({ tags: f.tags.filter((x) => x !== id) }) })),
        ...f.tagsOut.map((id) => ({ key: `out:${id}`, label: `not #${tagName(id)}`, title: id, remove: () => set({ tagsOut: f.tagsOut.filter((x) => x !== id) }) })),
      ],
      body: (
        <>
          <ChoiceFilter value={f.tagged} onChange={(v) => set({ tagged: v })} options={[{ value: "all", label: "Any" }, { value: "tagged", label: "Tagged" }, { value: "untagged", label: "Untagged" }]} />
          <TagFilter value={{ tags: f.tags, tagsMode: f.tagsMode, tagsOut: f.tagsOut, tagsOutMode: f.tagsOutMode }} onChange={(patch) => set(patch)} />
        </>
      ),
    },
    { id: "rating", label: "Rating", chips: ratingChips(f.minRating, f.unratedOnly, () => set({ minRating: 0, unratedOnly: false })), body: <RatingFilter min={f.minRating} unrated={f.unratedOnly} onChange={set} /> },
    { id: "artists", label: "Artists", chips: pickChips(f.artists, artistOptions, (ids) => set({ artists: ids })), body: <PickFilter picked={f.artists} options={artistOptions} onChange={(ids) => set({ artists: ids })} placeholder="Find an artist" empty="No artists yet: give pictures one in Artists." /> },
    { id: "people", label: "People", chips: pickChips(f.people, peopleOptions, (ids) => set({ people: ids })), body: <PickFilter picked={f.people} options={peopleOptions} onChange={(ids) => set({ people: ids })} placeholder="Find a person or character" empty="No one named yet: name faces in People." /> },
  ];
}
