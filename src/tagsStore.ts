import { create } from "zustand";
import { debounced } from "./lib/pending";
import { api } from "./lib/api";
import { albumPages as pagesOf, eachOnce, moveIntoBucket, originalOf, useStore } from "./store";

/** The pages of an album that the tag index knows (for reading what they show). */
export function albumPageKeys(albumKey: string): string[] {
  const d = useTags.getState().data;
  return d ? albumPages(d, albumKey) : [];
}

/** Tags go on whole albums: a page's key becomes its album's (found in the library or the open queue). */
let albumOfIndex: { items: MediaItem[]; map: Map<string, string> } | null = null;
export function tagKeysFor(keys: string[]): string[] {
  const st = useStore.getState();
  if (albumOfIndex?.items !== st.allItems) {
    const map = new Map<string, string>();
    for (const it of st.allItems) if (it.albumKey) map.set(it.key, it.albumKey);
    albumOfIndex = { items: st.allItems, map };
  }
  const out = keys.map((k) => {
    if (isAlbumTagKey(k)) return keptKey(k);
    const ak = albumOfIndex!.map.get(k) ?? st.queue.find((i) => i.key === k)?.albumKey;
    return ak ? albumKeyOf(ak) : k;
  });
  return [...new Set(out)];
}

/** An album's pages that the tag index knows: the spread picked when indexing albums, else every page in the library. */
let pageIndex: { items: MediaItem[]; map: Map<string, string[]> } | null = null;
function albumPages(d: TagData, albumKey: string): string[] {
  const picked = d.albums?.[albumKey];
  if (picked?.length) return picked;
  const items = useStore.getState().allItems;
  if (pageIndex?.items !== items) {
    const map = new Map<string, string[]>();
    for (const it of items) {
      if (!it.albumKey) continue;
      const list = map.get(it.albumKey) ?? [];
      list.push(it.key);
      map.set(it.albumKey, list);
    }
    pageIndex = { items, map };
  }
  const all = (pageIndex.map.get(albumKey) ?? []).filter((k) => d.indexed[k] || d.auto[k]);
  if (all.length <= 24) return all;
  const step = all.length / 24;
  return Array.from({ length: 24 }, (_, i) => all[Math.floor(i * step)]);
}
import type { IndexProgress, ItemSource, MediaItem, Target, TagData, TagName, IndexedItem } from "./lib/types";
import { targetFor } from "./lib/filing";
import { useEngine } from "./plugins/engine";

/**
 * Tags: typed ("month/October", "motives/cat"), on images and videos, or on
 * whole albums. What the local models know of each item lives here too: a
 * SigLIP 2 embedding, and the anime tagger's tags when it is downloaded (it is
 * optional, for art and manga), made once in the background and kept with the
 * library (inside the vault when there is one). Suggestions
 * come from the embeddings: the nearest tagged items vote, the tag's own
 * words count before there are examples, and a tagger tag that was once
 * accepted as a tag of yours keeps suggesting it.
 */

export type TagMode = "images" | "albums";

/** The key a tag sits on: an item's, or an album's with a prefix (a translated version's is its original's). */
export const albumKeyOf = (albumKey: string) => `album:${originalOf(albumKey)}`;
export const isAlbumTagKey = (key: string) => key.startsWith("album:");
/** A tag key as it is kept: a translated version's becomes its original's. */
export const keptKey = (key: string) => (isAlbumTagKey(key) ? albumKeyOf(key.slice(6)) : key);

export interface Suggestion {
  tag: string;
  /** 0..1, how sure. */
  score: number;
  /** Where it comes from. */
  why: "neighbours" | "words" | "tagger";
  /** What else spoke for it: its folder, the tags it goes with. */
  note?: string;
}

interface TagsStore {
  data: TagData | null;
  loaded: boolean;
  /** The anime tagger's tag names, once the engine gave them. */
  names: TagName[] | null;
  indexing:
    | (IndexProgress & {
        key?: string;
        eta: number | null;
        failed?: number;
        lastError?: string;
      })
    | null;
  indexPaused: boolean;
  mode: TagMode;
  /** "overview" (the types as folders), "type:<type>", "all", "untagged", a tag id, or "search". */
  filter: string;
  /** Tile size and layout of the item grid, kept between sessions. */
  zoom: number;
  layout: "grid" | "masonry";
  query: string;
  /** Keys in search order, when `filter` is "search". */
  found: string[];
  selected: Set<string>;
  /** The models the index was made with (null until loaded; the embedder "" while it is empty, the tagger "" until the anime tagger has looked). */
  models: { embedder: string; tagger: string } | null;
  /** The models indexing uses now, of what is downloaded: the picture and word matcher (null without it), and the anime tagger or "" (it is optional). */
  target: { embedder: string; tagger: string } | null;
  /** Suggestions inside a tag: the likeliest first, or the ones it is least sure of (each answer teaches it most). */
  suggestOrder: "likely" | "unsure";

  load(): Promise<void>;
  save(): void;
  /** The tags and index entries of files gone for good (purged from the trash, deleted outside the app a month ago). */
  forgetKeys(gone: (key: string) => boolean): void;
  /** A save waiting to happen, done now (the backend learns from the saved tags). */
  flush(): Promise<void>;
  setSuggestOrder(order: "likely" | "unsure"): void;
  /** Index crops of each picture too, or not. */
  setLookCloser(on: boolean): void;
  /** Never offer this tagger word as a new tag again (or do again). */
  ignoreWord(name: string, on: boolean): void;
  /** Which models indexing uses now, from what the engine has downloaded. */
  refreshTarget(): Promise<void>;
  setMode(mode: TagMode): void;
  setFilter(filter: string): void;
  select(keys: Set<string>): void;

  addType(name: string): void;
  renameType(from: string, to: string): void;
  removeType(name: string): void;
  addTag(id: string): void;
  renameTag(from: string, to: string): void;
  removeTag(id: string): void;
  /** Put a tag on keys, or take it off. */
  setTag(keys: string[], tag: string, on: boolean): void;
  /** Linked albums are one: a translated version's tags and turned-down suggestions join its original's. */
  joinVersions(): void;
  /** Unlinked from its original, a translated version keeps a copy of the tags the two had. */
  splitVersion(original: string, translation: string): Promise<void>;
  /** Everything carrying `from` gets `to` instead; `from` goes, its tagger links move over. */
  mergeTags(from: string, to: string): void;
  /** Move a tag (with its subtags) into another folder, as a top tag there (merged with ones of the same names). */
  moveTag(id: string, toType: string): void;
  /** Make a tag a subtag of another (moving it, with its own subtags, into that one's folder), or a top tag again (null). */
  setParent(id: string, parent: string | null): void;
  /** The tagger's words containing `q`, the ones seen most often in this library first. */
  findWords(q: string, limit?: number): { name: string; count: number; linkedTo?: string }[];
  /** Make a folder "one of" (something carries at most one of its tags), or not. */
  setExclusive(type: string, on: boolean): void;
  /** A tag folder made a bucket folder (its tags buckets, pick one), or plain again. */
  setPlace(type: string, on: boolean): void;
  /** A bucket folder's tag's bucket (a target's id), or none. */
  setPlaceOf(tag: string, target: string | null): void;
  /** Bucket folders' tags as where things are now. */
  syncPlaces(): void;
  /** A bucket folder's tag set: what carries it moved into its bucket. */
  placeInto(keys: string[], tag: string, on: boolean): Promise<void>;
  /** Never suggest these two together, either way (or again do). */
  setApart(a: string, b: string, on: boolean): void;
  /** Undo a tagger word's link to a tag of yours. */
  unmapAuto(autoName: string): void;
  /** Something under a tag's "Often together" doesn't go with it: not offered there again. */
  dismissRelated(tag: string, other: string): void;
  /** What goes with a tag: your tags and the tagger's words seen on much of what carries it. */
  related(tag: string): Related;
  setZoom(zoom: number): void;
  setLayout(layout: "grid" | "masonry"): void;
  /** A tagger tag accepted as a tag of yours: remembered, so it suggests that tag from then on. */
  mapAuto(autoName: string, tag: string): void;
  /** A platform's tag linked to one of yours (null: unlinked): what comes in carrying it gets yours. */
  linkSource(platform: string, name: string, tag: string | null): void;
  /** Pictures just brought in with their sources: the tags of yours their platform's linked tags stand for. */
  applySources(entries: [string, ItemSource][]): Promise<void>;

  /** Everything not indexed yet (or changed since), in a mode (the current one unless named). */
  pending(mode?: TagMode): Promise<MediaItem[]>;
  /** Index what isn't yet; `paused`: start held (a paused run carried on after a restart); `both`: pictures and albums, as when the anime tagger was just downloaded. */
  startIndex(opts?: { paused?: boolean; both?: boolean }): Promise<void>;
  cancelIndex(): void;
  pauseIndex(on: boolean): void;
  search(text: string): Promise<void>;

  /** Tags to suggest for some items, from the tag index in the backend. */
  suggest(keys: string[]): Promise<Suggestion[]>;
  tagsOf(key: string): string[];
  /** The tagger's tags of an item (or an album's pages pooled), highest first. */
  autoOf(key: string): [string, number][];
  loadNames(): Promise<void>;
  /** A few keys carrying a tag, for its card. */
  coversFor(tag: string, mode: TagMode, n: number): string[];
  /** Tagger words seen often (p ≥ 0.5) that aren't one of your tags yet, most frequent first. */
  suggestedAuto(mode: TagMode, limit?: number): { name: string; count: number; sample: string[] }[];
  /** Everything the tagger saw this word in (at 50% or more), best first: a suggested tag's contents. */
  autoKeys(name: string, mode: TagMode): string[];
  /** Moves tags from single album pages onto their albums; how many pages had some. */
  healPages(): number;
  /** Adopt a tagger word as a tag of yours: remembered; what it is seen in is suggested inside the tag. */
  adoptAuto(autoName: string, tag: string): void;
  /** What might carry a tag but doesn't yet (by the tagger's word, neighbours, or the name), best first. */
  suggestedFor(tag: string, mode: TagMode): Promise<{ key: string; score: number; why: Suggestion["why"]; note?: string }[]>;
  /** Turn suggestions down: they stay off the tag's list. */
  deny(tag: string, keys: string[]): void;
  /** Everything carrying any tag of a bundle. */
  bundleKeys(name: string): string[];
  /** A bundle's tags (none removes the bundle). */
  setBundle(name: string, tags: string[]): void;
}

const EMPTY: TagData = {
  version: 1,
  types: ["motives", "style"],
  tags: {},
  auto: {},
  indexed: {},
  autoMap: {},
  albums: {},
};
/** The read under way, so screens asking together share it. */
let loading: { root: string; p: Promise<void> } | null = null;
const tagsSave = debounced("tags", 400, async (root) => {
  const data = useTags.getState().data;
  if (!data || (loadedFor !== null && loadedFor !== root)) return;
  // What the models found is the backend's to save; only what you made goes over.
  const { auto: _auto, indexed: _indexed, ...mine } = data;
  void _auto;
  void _indexed;
  await api.saveTags(root, mine).catch((e) => useStore.getState().toast(`Could not save tags: ${String(e)}`, "error"));
});
// Another library: its tags, not this one's, and nothing of this one's written there.
useStore.subscribe((s, prev) => {
  // Another library (or none): a run indexing the last one stops (it carries on when that one opens
  // again, from the note kept with its tags).
  if (s.root !== prev.root && useTags.getState().indexing) useTags.getState().cancelIndex();
  if (s.root !== prev.root && loadedFor !== null && loadedFor !== s.root) {
    tagsSave.cancel();
    loadedFor = null;
    loading = null;
    useTags.setState({
      data: null,
      loaded: false,
      selected: new Set(),
      found: [],
    });
  }
});
let loadedFor: string | null = null;

export const typeOf = (id: string) => id.slice(0, id.indexOf("/"));
export const nameOf = (id: string) => id.slice(id.indexOf("/") + 1);

/** What the middle can show besides a tag's grid; anything else is a tag id. */
const VIEWS = ["overview", "all", "untagged", "search"];
const VIEW_PREFIXES = ["type:", "bundle:", "auto:", "tag:", "folder:", "conflicts:"];
export const isTagFilter = (f: string) => !VIEWS.includes(f) && !VIEW_PREFIXES.some((p) => f.startsWith(p));

/** Under a tag's "Often together": your tags and the tagger's words found on much of what carries it. */
export interface Related {
  /** How many things carry the tag, and how many of those the tagger has read. */
  count: number;
  read: number;
  /** Your tags: on how many of them both are, the share of this tag's and of that tag's own. */
  tags: { id: string; both: number; share: number; theirs: number }[];
  /** The tagger's words: on how many, the share, and how much more often than elsewhere. */
  words: {
    name: string;
    count: number;
    share: number;
    lift: number;
    linkedTo?: string;
  }[];
}

/** A tag's parent, its parent's parent, and so on up. */
export function ancestorsOf(d: TagData, id: string): string[] {
  const out: string[] = [];
  const seen = new Set([id]);
  for (let p = d.parents?.[id]; p && !seen.has(p); p = d.parents?.[p]) {
    out.push(p);
    seen.add(p);
  }
  return out;
}

/** A tag's subtags, theirs, and so on down. */
export function descendantsOf(d: TagData, id: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const [c, p] of Object.entries(d.parents ?? {})) kids.set(p, [...(kids.get(p) ?? []), c]);
  const out = new Set<string>();
  const walk = (x: string) => {
    for (const c of kids.get(x) ?? []) if (!out.has(c) && c !== id) (out.add(c), walk(c));
  };
  walk(id);
  return out;
}

/** One a subtag of the other (at any depth), or the same: on one branch, so never in each other's way. */
export function sameBranch(d: TagData, a: string, b: string): boolean {
  return a === b || ancestorsOf(d, a).includes(b) || ancestorsOf(d, b).includes(a);
}

/** "night › midnight": a tag's name with its parents'. */
export function pathOf(d: TagData, id: string): string {
  return [...ancestorsOf(d, id).reverse(), id].map(nameOf).join(" › ");
}

/** A folder's tags in tree order (each followed by its subtags), with depth and how many things carry each. */
export function treeOfType(d: TagData, type: string): { id: string; name: string; count: number; depth: number }[] {
  const flat = tagsOfType(d, type);
  const ids = new Set(flat.map((x) => x.id));
  const kids = new Map<string, typeof flat>();
  const roots: typeof flat = [];
  for (const x of flat) {
    const p = d.parents?.[x.id];
    if (p && ids.has(p) && p !== x.id) kids.set(p, [...(kids.get(p) ?? []), x]);
    else roots.push(x);
  }
  const out: { id: string; name: string; count: number; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (x: (typeof flat)[number], depth: number) => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    out.push({ ...x, depth });
    for (const c of kids.get(x.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const x of flat) walk(x, 0); // anything left by a loop in the data
  return out;
}

/**
 * Whether something carrying `carried` should not get `tag` suggested: it has another tag of the
 * same "one of" folder, or a tag never suggested together with it.
 */
export function blockerOf(d: TagData, tag: string): (carried: readonly string[] | undefined) => boolean {
  const type = typeOf(tag);
  const sole = !!d.exclusive?.includes(type);
  // A subtag brings its parents: their opposites are its own.
  const line = new Set([tag, ...ancestorsOf(d, tag)]);
  const partners = new Set<string>();
  for (const [a, b] of d.apart ?? []) {
    if (line.has(a)) partners.add(b);
    else if (line.has(b)) partners.add(a);
  }
  if (!sole && !partners.size) return () => false;
  // In a "pick one" folder another branch is in the way; the tag's own parents and subtags aren't.
  return (carried) => !!carried?.some((x) => x !== tag && ((sole && typeOf(x) === type && !sameBranch(d, x, tag)) || partners.has(x)));
}

/** The tags a tag is never suggested with: its rules, and the rest of its folder when that is "one of". */
export function apartFrom(d: TagData, tag: string): string[] {
  return (d.apart ?? []).flatMap(([a, b]) => (a === tag ? [b] : b === tag ? [a] : []));
}

/** What carries more than one branch of a "pick one" folder (from before it was one, or a tag moved in). */
export function conflictsOf(d: TagData, type: string): string[] {
  const out: string[] = [];
  for (const [k, list] of Object.entries(d.tags)) {
    if (!k) continue;
    const mine = list.filter((id) => typeOf(id) === type);
    if (mine.length > 1 && mine.some((a, i) => mine.slice(i + 1).some((b) => !sameBranch(d, a, b)))) out.push(k);
  }
  return out;
}

/** Every place a tag id is kept, put through `f` (null drops it): renames, moves, merges and deletes alike. */
function rewrite(d: TagData, f: (id: string) => string | null): TagData {
  const map = (list: string[]) => [...new Set(list.map(f).filter((x): x is string => !!x))];
  const tags: TagData["tags"] = {};
  for (const [k, list] of Object.entries(d.tags)) {
    const kept = map(list);
    if (kept.length) tags[k] = kept;
  }
  const autoMap: TagData["autoMap"] = {};
  for (const [n, id] of Object.entries(d.autoMap ?? {})) {
    const to = f(id);
    if (to) autoMap[n] = to;
  }
  const sourceMap: Record<string, string> = {};
  for (const [n, id] of Object.entries(d.sourceMap ?? {})) {
    const to = f(id);
    if (to) sourceMap[n] = to;
  }
  const bundles: Record<string, string[]> = {};
  for (const [n, list] of Object.entries(d.bundles ?? {})) {
    const kept = map(list);
    if (kept.length) bundles[n] = kept;
  }
  // Kept by tag: two tags merging pool theirs.
  const byTag = (rec: Record<string, string[]> | undefined, values: (list: string[]) => string[]) => {
    const out: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(rec ?? {})) {
      const to = f(id);
      if (to) out[to] = [...new Set([...(out[to] ?? []), ...values(list)])];
    }
    return out;
  };
  const denied = byTag(d.denied, (l) => l);
  const unrelated = byTag(d.unrelated, (l) => l.map((x) => (x.startsWith("auto:") ? x : f(x))).filter((x): x is string => !!x));
  const seen = new Set<string>();
  const apart: [string, string][] = [];
  for (const [a, b] of d.apart ?? []) {
    const x = f(a);
    const y = f(b);
    if (!x || !y || x === y) continue;
    const pair = [x, y].sort() as [string, string];
    if (seen.has(pair.join("\n"))) continue;
    seen.add(pair.join("\n"));
    apart.push(pair);
  }
  // A tag's Scrapbook banner: renamed with it; merged, the one it went into keeps its own.
  const covers: Record<string, string> = {};
  for (const [id, book] of Object.entries(d.covers ?? {})) {
    const to = f(id);
    if (to && !(to in covers && to === id)) covers[to] = to in (d.covers ?? {}) && to !== id ? d.covers![to] : book;
  }
  const parents: Record<string, string> = {};
  for (const [c, p] of Object.entries(d.parents ?? {})) {
    const x = f(c);
    const y = f(p);
    if (x && y && x !== y) parents[x] = y;
  }
  // A bucket folder's tag keeps its bucket when renamed.
  const placeOf: Record<string, string> = {};
  for (const [id, target] of Object.entries(d.placeOf ?? {})) {
    const to = f(id);
    if (to && !(to in placeOf)) placeOf[to] = target;
  }
  return {
    ...d,
    tags,
    autoMap,
    sourceMap,
    bundles,
    denied,
    unrelated,
    apart,
    parents,
    covers,
    placeOf,
  };
}

/** What some tags are beyond what carries them (their settings): to put back as they were. */
export interface TagSettings {
  autoMap: Record<string, string>;
  sourceMap: Record<string, string>;
  denied: Record<string, string[]>;
  bundles: Record<string, string[]>;
  apart: [string, string][];
  unrelated: Record<string, string[]>;
  parents: Record<string, string>;
  covers: Record<string, string>;
  placeOf: Record<string, string>;
}

/** The settings of these tags, wherever they are kept (taken before the tags go). */
export function settingsOf(d: TagData, ids: string[]): TagSettings {
  const of = new Set(ids);
  const pick = <T>(rec: Record<string, T> | undefined, keep: (k: string, v: T) => boolean) => Object.fromEntries(Object.entries(rec ?? {}).filter(([k, v]) => keep(k, v)));
  const lists = (rec: Record<string, string[]> | undefined, whole: (k: string) => boolean) =>
    Object.fromEntries(
      Object.entries(rec ?? {})
        .map(([k, l]) => [k, whole(k) ? l : l.filter((x) => of.has(x))] as const)
        .filter(([, l]) => l.length),
    );
  return {
    autoMap: pick(d.autoMap, (_, id) => of.has(id)),
    sourceMap: pick(d.sourceMap, (_, id) => of.has(id)),
    denied: pick(d.denied, (id) => of.has(id)),
    bundles: lists(d.bundles, () => false),
    apart: (d.apart ?? []).filter(([a, b]) => of.has(a) || of.has(b)),
    unrelated: lists(d.unrelated, (id) => of.has(id)),
    parents: pick(d.parents, (c, p) => of.has(c) || of.has(p)),
    covers: pick(d.covers, (id) => of.has(id)),
    placeOf: pick(d.placeOf, (id) => of.has(id)),
  };
}

/** Tags' settings put back, over what was made of them meanwhile (subtags moved up a level), and with what else changed since kept. */
export function withSettings(d: TagData, s: TagSettings): TagData {
  const merged = (cur: Record<string, string[]> | undefined, add: Record<string, string[]>) => {
    const out = { ...(cur ?? {}) };
    for (const [k, l] of Object.entries(add)) out[k] = [...new Set([...(out[k] ?? []), ...l])];
    return out;
  };
  const pair = (p: [string, string]) => [...p].sort().join("\n");
  const had = new Set((d.apart ?? []).map(pair));
  return {
    ...d,
    autoMap: { ...s.autoMap, ...d.autoMap },
    sourceMap: { ...s.sourceMap, ...d.sourceMap },
    denied: merged(d.denied, s.denied),
    bundles: merged(d.bundles, s.bundles),
    apart: [...(d.apart ?? []), ...s.apart.filter((p) => !had.has(pair(p)))],
    unrelated: merged(d.unrelated, s.unrelated),
    parents: { ...(d.parents ?? {}), ...s.parents },
    covers: { ...s.covers, ...(d.covers ?? {}) },
    placeOf: { ...s.placeOf, ...(d.placeOf ?? {}) },
  };
}

/**
 * Bucket folders' tags as where things are: each picture carries the tag of the bucket it is in
 * (by its target), none of the folder's others, and none at all outside them. A bucket nothing is in
 * keeps its tag, empty. The same data back when nothing changed.
 */
export function withPlaces(d: TagData, items: MediaItem[], targets: Target[] = []): TagData {
  const places = new Set(d.places ?? []);
  if (!places.size) return d;
  const tagOf = new Map<string, string>();
  for (const [id, target] of Object.entries(d.placeOf ?? {})) if (places.has(typeOf(id))) tagOf.set(target, id);
  // A picture in a folder with a key of its own, inside a bucket a tag stands for, carries the
  // bucket's tag: the nearest target above it that has one.
  const placeOf = new Map<string, string>();
  for (const t of targets) {
    let at: Target | undefined = t;
    while (at && !tagOf.has(at.id)) at = targetFor(at.path.slice(0, Math.max(0, at.path.lastIndexOf("/"))), targets);
    if (at) placeOf.set(t.id, tagOf.get(at.id)!);
  }
  let tags = d.tags;
  const put = (k: string, list: string[]) => {
    if (tags === d.tags) tags = { ...d.tags };
    if (list.length) tags[k] = list;
    else delete tags[k];
  };
  for (const it of items) {
    if (it.albumKey) continue;
    const want = it.targetId ? (tagOf.get(it.targetId) ?? placeOf.get(it.targetId)) : undefined;
    const had = tags[it.key] ?? [];
    const placed = had.filter((id) => places.has(typeOf(id)));
    if (placed.length === (want ? 1 : 0) && (!want || placed[0] === want)) continue;
    put(it.key, [...had.filter((id) => !places.has(typeOf(id))), ...(want ? [want] : [])]);
  }
  const carried = new Set(Object.entries(tags).flatMap(([k, list]) => (k ? list : [])));
  const empty = tags[""] ?? [];
  const missing = [...tagOf.values()].filter((id) => !carried.has(id) && !empty.includes(id));
  if (missing.length) put("", [...empty, ...missing]);
  return tags === d.tags ? d : { ...d, tags };
}

/** Whether the tags follow the item list yet (once, after the first load). */
let watchingPlaces = false;

/** The screen showing a tag (its page or its grid) follows the tag when it is renamed or goes. */
function followFilter(filter: string, f: (id: string) => string | null): string {
  if (filter.startsWith("tag:")) {
    const to = f(filter.slice(4));
    return to ? `tag:${to}` : "overview";
  }
  if (isTagFilter(filter)) return f(filter) ?? "overview";
  return filter;
}

/**
 * How often each tagger word is seen (p ≥ 0.35) across what the tagger looked at: what "more often
 * than elsewhere" compares to. (It only looks at drawn pictures; photos, which it skipped, don't count.)
 */
let wordBase: {
  auto: TagData["auto"];
  counts: Map<number, number>;
  n: number;
} | null = null;
function wordCounts(d: TagData) {
  if (wordBase?.auto === d.auto) return wordBase;
  const counts = new Map<number, number>();
  let n = 0;
  for (const [k, list] of Object.entries(d.auto)) {
    if (isAlbumTagKey(k) || !list.length) continue;
    n++;
    for (const [i, p] of list) if (p >= 0.35) counts.set(i, (counts.get(i) ?? 0) + 1);
  }
  return (wordBase = { auto: d.auto, counts, n });
}

/**
 * How much a tagger word says about a picture, 0..1: what share of what the tagger looked at does
 * NOT have it. "comic" on every manga page says nothing, and isn't offered as a tag (0 from half up).
 */
export function telling(d: TagData, index: number): number {
  const { counts, n } = wordCounts(d);
  if (n < 20) return 1;
  const share = (counts.get(index) ?? 0) / n;
  return share > 0.5 ? 0 : 1 - share;
}

export const useTags = create<TagsStore>((set, get) => ({
  data: null,
  loaded: false,
  names: null,
  indexing: null,
  indexPaused: false,
  mode: "images",
  filter: "overview",
  zoom: Number(localStorage.getItem("quire.tags.zoom")) || 180,
  layout: (localStorage.getItem("quire.tags.layout") as "grid" | "masonry") || "grid",
  query: "",
  found: [],
  selected: new Set(),
  models: null,
  target: null,
  suggestOrder: "likely",

  async load() {
    const root = useStore.getState().root;
    if (!root) return;
    if (loadedFor === root && get().loaded) return;
    // Asked for by several screens at once: one read, shared.
    if (loading?.root === root) return loading.p;
    const p = (async () => {
      try {
        // The tags (small, saved on every edit), and from the backend's tag index the tagger's words and
        // what is indexed; the embeddings stay in the backend.
        const raw = (await api.loadTags(root)) as Partial<TagData> | null;
        const index = await api.tagsIndexLoad(root).catch(() => null);
        // Another library opened meanwhile: these tags are the old one's.
        if (useStore.getState().root !== root) return;
        const data: TagData = {
          ...EMPTY,
          ...(raw ?? {}),
          types: raw?.types?.length ? raw.types : EMPTY.types,
          auto: index?.auto ?? raw?.auto ?? {},
          indexed: index?.indexed ?? raw?.indexed ?? {},
        };
        loadedFor = root;
        const models = index ? { embedder: index.embedder, tagger: index.tagger } : null;
        set({
          data,
          loaded: true,
          selected: new Set(),
          filter: "overview",
          found: [],
          models,
          names: null,
        });
        get().joinVersions();
        void get().refreshTarget();
        // Bucket folders' tags follow where pictures are: now, and whenever the list of them changes.
        if (!watchingPlaces) {
          watchingPlaces = true;
          useStore.subscribe((s, p) => void (s.allItems !== p.allItems && useTags.getState().syncPlaces()));
        }
        get().syncPlaces();
      } catch (e) {
        if (useStore.getState().root !== root) return;
        useStore.getState().toast(`Could not load tags: ${String(e)}`, "error");
        loadedFor = root;
        set({ data: { ...EMPTY }, loaded: true });
      }
    })();
    loading = { root, p };
    try {
      await p;
    } finally {
      if (loading?.p === p) loading = null;
    }
  },

  save() {
    // Only tags of the library they were loaded for are written, and only once loaded: an edit made
    // before another library's tags came in would otherwise write this library's over them.
    const root = loadedFor ?? (get().loaded ? useStore.getState().root : null);
    if (root) tagsSave.schedule(root);
  },

  flush() {
    return tagsSave.flush();
  },

  forgetKeys(gone) {
    const d = get().data;
    if (!d) return;
    // A key here may be an album's ("album:<its folder>"): gone with its folder.
    const isGone = (k: string) => gone(isAlbumTagKey(k) ? k.slice(6) : k);
    const keys = Object.keys(d.tags).filter(isGone);
    // What the models made of them goes too, from the backend's index as well (their vectors are of the pictures).
    const modelled = [...new Set([...Object.keys(d.indexed ?? {}), ...Object.keys(d.auto ?? {})])].filter(gone);
    const albumsGone = Object.keys(d.albums ?? {}).filter(gone);
    const pagesGone = Object.values(d.albums ?? {}).some((list) => list.some(gone));
    const deniedGone = Object.values(d.denied ?? {}).some((list) => list.some(isGone));
    if (!keys.length && !modelled.length && !albumsGone.length && !pagesGone && !deniedGone) return;
    const tags = { ...d.tags };
    for (const k of keys) delete tags[k];
    const indexed = { ...d.indexed };
    const auto = { ...d.auto };
    for (const k of modelled) {
      delete indexed[k];
      delete auto[k];
    }
    const albums = Object.fromEntries(Object.entries(d.albums ?? {}).filter(([a]) => !gone(a)).map(([a, list]) => [a, list.filter((k) => !gone(k))]));
    const denied = Object.fromEntries(Object.entries(d.denied ?? {}).map(([t, list]) => [t, list.filter((k) => !isGone(k))]));
    set({ data: { ...d, tags, indexed, auto, albums, denied } });
    get().save();
    const root = useStore.getState().root;
    if (root && modelled.length) void Promise.resolve().then(() => api.tagsIndexForget(root, modelled)).catch(() => {});
  },

  setSuggestOrder(order) {
    set({ suggestOrder: order });
  },

  ignoreWord(name, on) {
    const d = get().data;
    if (!d) return;
    const rest = (d.ignoredWords ?? []).filter((w) => w !== name);
    set({ data: { ...d, ignoredWords: on ? [...rest, name] : rest } });
    get().save();
  },

  setLookCloser(on) {
    const d = get().data;
    if (!d) return;
    set({ data: { ...d, lookCloser: on } });
    get().save();
  },

  async refreshTarget() {
    const engine = useEngine.getState();
    if (!engine.catalog) await engine.refresh();
    const have = new Set((useEngine.getState().catalog?.models ?? []).filter((m) => m.downloaded).map((m) => m.id));
    set({ target: have.has("siglip2") ? { embedder: "siglip2", tagger: have.has("pixai") ? "pixai" : "" } : null });
  },

  setMode(mode) {
    set({
      mode,
      filter: "overview",
      selected: new Set(),
      found: [],
      query: "",
    });
  },

  setFilter(filter) {
    set({ filter, selected: new Set() });
  },

  select(keys) {
    set({ selected: keys });
  },

  addType(name) {
    const d = get().data;
    const n = name.trim().replace(/\//g, " ");
    if (!d || !n || d.types.includes(n)) return;
    set({ data: { ...d, types: [...d.types, n] } });
    get().save();
  },

  renameType(from, to) {
    const d = get().data;
    const t = to.trim().replace(/\//g, " ");
    if (!d || !t || from === t || d.types.includes(t)) return;
    const next = rewrite(d, (id) => (typeOf(id) === from ? `${t}/${nameOf(id)}` : id));
    const swap = (x: string) => (x === from ? t : x);
    const f0 = get().filter;
    const filter = f0 === `type:${from}` || f0 === `folder:${from}` || f0 === `conflicts:${from}` ? f0.replace(`:${from}`, `:${t}`) : followFilter(get().filter, (id) => (typeOf(id) === from ? `${t}/${nameOf(id)}` : id));
    set({
      data: {
        ...next,
        types: d.types.map(swap),
        exclusive: d.exclusive?.map(swap),
        places: d.places?.map(swap),
      },
      filter,
    });
    get().save();
  },

  removeType(name) {
    const d = get().data;
    if (!d) return;
    const next = rewrite(d, (id) => (typeOf(id) === name ? null : id));
    const filter = [`type:${name}`, `folder:${name}`, `conflicts:${name}`].includes(get().filter) ? "overview" : followFilter(get().filter, (id) => (typeOf(id) === name ? null : id));
    set({
      data: {
        ...next,
        types: d.types.filter((x) => x !== name),
        exclusive: d.exclusive?.filter((x) => x !== name),
        places: d.places?.filter((x) => x !== name),
      },
      filter,
    });
    get().save();
  },

  addTag(id) {
    // A tag exists by being on something; an empty one is kept as a placeholder entry under "".
    const d = get().data;
    if (!d) return;
    const [type] = id.split("/");
    if (!d.types.includes(type)) set({ data: { ...d, types: [...d.types, type] } });
    const known = get().data!.tags[""] ?? [];
    if (!known.includes(id)) {
      set({
        data: {
          ...get().data!,
          tags: { ...get().data!.tags, "": [...known, id] },
        },
      });
      get().save();
    }
  },

  renameTag(from, to) {
    // Into a name that exists already, it is a merge: whatever carried either carries that one.
    const d = get().data;
    if (!d || from === to || !to.includes("/")) return;
    const type = typeOf(to);
    const next = rewrite(d, (id) => (id === from ? to : id));
    set({
      data: {
        ...next,
        types: next.types.includes(type) ? next.types : [...next.types, type],
      },
      filter: followFilter(get().filter, (id) => (id === from ? to : id)),
    });
    get().save();
  },

  removeTag(id) {
    const d0 = get().data;
    if (!d0) return;
    // Its subtags stay, one level up.
    const parents = { ...(d0.parents ?? {}) };
    for (const [c, p] of Object.entries(parents)) if (p === id) parents[c] = d0.parents?.[id] ?? "";
    for (const [c, p] of Object.entries(parents)) if (!p) delete parents[c];
    const d = { ...d0, parents };
    set({
      data: rewrite(d, (x) => (x === id ? null : x)),
      filter: followFilter(get().filter, (x) => (x === id ? null : x)),
    });
    get().save();
  },

  setTag(keys, tag, on) {
    // A bucket folder's tag is where things are: setting it moves them.
    if (get().data?.places?.includes(typeOf(tag))) {
      void get().placeInto(keys, tag, on);
      return;
    }
    keys = tagKeysFor(keys);
    const d = get().data;
    if (!d) return;
    const tags = { ...d.tags };
    const denied = { ...(d.denied ?? {}) };
    if (on && denied[tag]) denied[tag] = denied[tag].filter((k) => !keys.includes(k));
    // A subtag brings its parents along; taking a tag off takes its subtags with it. In a "pick one"
    // folder the tag's branch takes the place of the one there was.
    const type = typeOf(tag);
    const sole = on && !!d.exclusive?.includes(type);
    const line = on ? [...ancestorsOf(d, tag).reverse(), tag] : [];
    const below = on ? null : descendantsOf(d, tag);
    const dropped = new Set<string>();
    for (const k of keys) {
      const list = tags[k] ?? [];
      const kept = on ? [...list.filter((x) => !sole || typeOf(x) !== type || sameBranch(d, x, tag)), ...line.filter((x) => !list.includes(x))] : list.filter((x) => x !== tag && !below!.has(x));
      for (const x of list) if (!kept.includes(x)) dropped.add(x);
      if (kept.length) tags[k] = kept;
      else delete tags[k];
    }
    // A tag taken off the last thing carrying it stays (empty) until it is deleted: switching the only
    // "day" picture to "night" mustn't make "day" go.
    for (const x of dropped) {
      if (Object.entries(tags).some(([k, list]) => k && list.includes(x))) continue;
      if (!tags[""]?.includes(x)) tags[""] = [...(tags[""] ?? []), x];
    }
    set({ data: { ...d, tags, denied } });
    get().save();
  },

  mergeTags(from, to) {
    get().renameTag(from, to);
  },

  moveTag(id, toType) {
    const d = get().data;
    if (!d) return;
    const parents = { ...(d.parents ?? {}) };
    delete parents[id];
    if (typeOf(id) === toType) {
      // Same folder: a subtag made a top tag again.
      set({ data: { ...d, parents } });
      return get().save();
    }
    const tree = new Set([id, ...descendantsOf(d, id)]);
    const f = (x: string) => (tree.has(x) ? `${toType}/${nameOf(x)}` : x);
    const next = rewrite({ ...d, parents }, f);
    set({
      data: {
        ...next,
        types: next.types.includes(toType) ? next.types : [...next.types, toType],
      },
      filter: followFilter(get().filter, f),
    });
    get().save();
  },

  setParent(id, parent) {
    if (parent === null) return get().moveTag(id, typeOf(id));
    let d = get().data;
    if (!d || parent === id || d.parents?.[id] === parent || descendantsOf(d, id).has(parent)) return;
    // Into the parent's folder first (with its own subtags).
    if (typeOf(parent) !== typeOf(id)) {
      get().moveTag(id, typeOf(parent));
      id = `${typeOf(parent)}/${nameOf(id)}`;
      d = get().data!;
      if (id === parent) return;
    }
    const parents = { ...(d.parents ?? {}), [id]: parent };
    // Whatever carries it now carries the parents too.
    const up = ancestorsOf({ ...d, parents }, id);
    const tags = { ...d.tags };
    for (const [k, list] of Object.entries(tags)) if (k && list.includes(id) && up.some((p) => !list.includes(p))) tags[k] = [...list, ...up.filter((p) => !list.includes(p))];
    set({ data: { ...d, parents, tags } });
    get().save();
  },

  findWords(q, limit = 8) {
    const d = get().data;
    const names = get().names;
    const needle = q.trim().toLowerCase().replace(/ /g, "_");
    if (!d || !names || !needle) return [];
    const base = wordCounts(d);
    const out: { name: string; count: number; linkedTo?: string }[] = [];
    names.forEach((n, i) => {
      if (n.category !== 9 && n.name.toLowerCase().includes(needle))
        out.push({
          name: n.name,
          count: base.counts.get(i) ?? 0,
          linkedTo: d.autoMap?.[n.name],
        });
    });
    // Seen most first; among those, the closest to what was typed.
    return out.sort((a, b) => b.count - a.count || Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)) || a.name.length - b.name.length).slice(0, limit);
  },

  setExclusive(type, on) {
    const d = get().data;
    if (!d) return;
    const ex = new Set(d.exclusive ?? []);
    if (on) ex.add(type);
    else ex.delete(type);
    set({ data: { ...d, exclusive: d.types.filter((x) => ex.has(x)) } });
    get().save();
  },

  setPlace(type, on) {
    const d = get().data;
    if (!d) return;
    const places = new Set(d.places ?? []);
    const ex = new Set(d.exclusive ?? []);
    if (on) (places.add(type), ex.add(type));
    else places.delete(type);
    set({
      data: {
        ...d,
        places: d.types.filter((x) => places.has(x)),
        exclusive: d.types.filter((x) => ex.has(x)),
      },
    });
    get().save();
    if (on)
      void useStore
        .getState()
        .loadAll()
        .then(() => get().syncPlaces());
  },

  setPlaceOf(tag, target) {
    const d = get().data;
    if (!d) return;
    const placeOf = { ...(d.placeOf ?? {}) };
    // One tag to a bucket: another tag that had it lets go.
    for (const [id, t] of Object.entries(placeOf)) if (t === target && typeOf(id) === typeOf(tag)) delete placeOf[id];
    if (target) placeOf[tag] = target;
    else delete placeOf[tag];
    set({ data: { ...d, placeOf } });
    get().save();
    get().syncPlaces();
  },

  syncPlaces() {
    const d = get().data;
    if (!d?.places?.length) return;
    const next = withPlaces(d, useStore.getState().allItems, useStore.getState().library?.targets);
    if (next === d) return;
    set({ data: next });
    get().save();
  },

  async placeInto(keys, tag, on) {
    const s = useStore.getState();
    const target = get().data?.placeOf?.[tag];
    if (!on) {
      s.toast(`Everything is in some bucket: put it into another of ${typeOf(tag)}'s instead`, "warn");
      return;
    }
    if (!target || !s.library?.targets.some((t) => t.id === target)) {
      s.toast(`${nameOf(tag)} has no folder yet: choose one in Tags → ${typeOf(tag)}`, "warn");
      return;
    }
    const want = new Set(keys);
    const items = s.allItems.filter((i) => want.has(i.key) && !i.albumKey);
    if (keys.some((k) => k.startsWith("album:"))) s.toast("Albums stay in their album folder: only pictures go into buckets", "warn");
    await moveIntoBucket(items, target);
    get().syncPlaces();
  },

  setApart(a, b, on) {
    const d = get().data;
    if (!d || a === b) return;
    const [x, y] = [a, b].sort();
    const rest = (d.apart ?? []).filter(([p, q]) => !(p === x && q === y));
    set({ data: { ...d, apart: on ? [...rest, [x, y]] : rest } });
    get().save();
  },

  unmapAuto(autoName) {
    const d = get().data;
    if (!d?.autoMap?.[autoName]) return;
    const autoMap = { ...d.autoMap };
    delete autoMap[autoName];
    set({ data: { ...d, autoMap } });
    get().save();
  },

  dismissRelated(tag, other) {
    const d = get().data;
    if (!d) return;
    set({
      data: {
        ...d,
        unrelated: {
          ...(d.unrelated ?? {}),
          [tag]: [...new Set([...(d.unrelated?.[tag] ?? []), other])],
        },
      },
    });
    get().save();
  },

  related(tag) {
    const d = get().data;
    const out: Related = { count: 0, read: 0, tags: [], words: [] };
    if (!d) return out;
    const no = new Set(d.unrelated?.[tag] ?? []);
    const blocked = blockerOf(d, tag);
    const bundled = new Set(
      Object.values(d.bundles ?? {})
        .filter((m) => m.includes(tag))
        .flat(),
    );
    // Its parents and subtags go with it by definition: not news.
    for (const x of [...ancestorsOf(d, tag), ...descendantsOf(d, tag)]) bundled.add(x);
    // Your tags: how much of what carries this one carries them too, and how much of theirs carries this.
    const carriers: string[] = [];
    const totals = new Map<string, number>();
    const both = new Map<string, number>();
    for (const [k, list] of Object.entries(d.tags)) {
      if (!k) continue;
      const has = list.includes(tag);
      if (has) carriers.push(k);
      for (const id of list) {
        if (id === tag) continue;
        totals.set(id, (totals.get(id) ?? 0) + 1);
        if (has) both.set(id, (both.get(id) ?? 0) + 1);
      }
    }
    const n = carriers.length;
    out.count = n;
    // Ranked by how far the two overlap (shared over either): the same thing under two names comes first.
    const overlap = (id: string, b: number) => b / (n + (totals.get(id) ?? b) - b);
    out.tags = [...both]
      .filter(([id, b]) => b >= 2 && !no.has(id) && !bundled.has(id) && !blocked([id]))
      .map(([id, b]) => ({
        id,
        both: b,
        share: b / n,
        theirs: b / (totals.get(id) ?? b),
      }))
      .filter((x) => x.share >= 0.5 || x.theirs >= 0.5)
      .sort((a, b) => overlap(b.id, b.both) - overlap(a.id, a.both))
      .slice(0, 12);
    // The tagger's words: seen on much of it, and more often than across everything read.
    const names = get().names;
    if (!names) return out;
    const base = wordCounts(d);
    const seen = new Map<number, number>();
    for (const k of carriers) {
      const best = new Map<number, number>();
      for (const src of isAlbumTagKey(k) ? albumPages(d, k.slice(6)) : [k]) for (const [i, p] of d.auto[src] ?? []) if (p > (best.get(i) ?? 0)) best.set(i, p);
      if (!best.size) continue;
      out.read++;
      for (const [i, p] of best) if (p >= 0.35) seen.set(i, (seen.get(i) ?? 0) + 1);
    }
    const floor = 1 / Math.max(1, base.n);
    const words: Related["words"] = [];
    for (const [i, c] of seen) {
      const name = names[i]?.name;
      if (!name || names[i].category === 9 || c < 2 || no.has(`auto:${name}`) || d.autoMap?.[name] === tag) continue;
      const share = c / out.read;
      const lift = share / Math.max((base.counts.get(i) ?? 0) / Math.max(1, base.n), floor);
      if (share >= 0.4 && lift >= 1.5)
        words.push({
          name,
          count: c,
          share,
          lift,
          linkedTo: d.autoMap?.[name],
        });
    }
    out.words = words.sort((a, b) => b.share * Math.log2(b.lift) - a.share * Math.log2(a.lift)).slice(0, 12);
    return out;
  },

  setZoom(zoom) {
    set({ zoom });
    try {
      localStorage.setItem("quire.tags.zoom", String(zoom));
    } catch {
      /* no storage */
    }
  },

  setLayout(layout) {
    set({ layout });
    try {
      localStorage.setItem("quire.tags.layout", layout);
    } catch {
      /* no storage */
    }
  },

  linkSource(platform, name, tag) {
    const d = get().data;
    if (!d) return;
    const sourceMap = { ...(d.sourceMap ?? {}) };
    if (tag) sourceMap[`${platform}:${name}`] = tag;
    else delete sourceMap[`${platform}:${name}`];
    set({ data: { ...d, sourceMap } });
    get().save();
  },

  async applySources(entries) {
    await get().load();
    const map = get().data?.sourceMap ?? {};
    const words = get().data?.autoMap ?? {};
    // Platforms whose tags are the anime tagger's own words: a word linked to a tag of yours links theirs too.
    const { useFinders } = await import("./plugins/find");
    const taggerWords = new Set(
      Object.values(useFinders.getState().finders)
        .filter((f) => f.taggerWords)
        .map((f) => f.platform),
    );
    if (!Object.keys(map).length && !(taggerWords.size && Object.keys(words).length)) return;
    // Each tag of yours, with the pictures (or their albums) to give it.
    const give = new Map<string, string[]>();
    for (const [key, src] of entries)
      for (const t of src.tags ?? []) {
        const tag = map[`${src.platform}:${t.name}`] ?? (taggerWords.has(src.platform) ? words[t.name] : undefined);
        if (tag && !give.get(tag)?.includes(key)) give.set(tag, [...(give.get(tag) ?? []), key]);
      }
    for (const [tag, keys] of give) get().setTag(keys, tag, true);
  },

  mapAuto(autoName, tag) {
    const d = get().data;
    if (!d) return;
    set({ data: { ...d, autoMap: { ...(d.autoMap ?? {}), [autoName]: tag } } });
    get().save();
  },

  async pending(mode = get().mode) {
    const s = useStore.getState();
    const d = get().data;
    if (!d || !s.root) return [];
    const fresh = indexedFresh(d, get().target?.tagger);
    if (mode === "images") {
      const all = s.allItems.length ? s.allItems : await s.loadAll();
      return all.filter((it) => (it.kind === "image" || it.kind === "video") && !fresh(it));
    }
    // Albums: a spread of each album's pages (up to 12), remembered so the album's vector can be pooled.
    // A translated version is read through its original: indexing it too would only say it twice.
    const albums = eachOnce(s.albums.length ? s.albums : await s.loadAlbums());
    const out: MediaItem[] = [];
    const albumPages = { ...(d.albums ?? {}) };
    for (const a of albums) {
      let pages: MediaItem[];
      try {
        pages = (await pagesOf(s.root, a)).filter((it) => it.kind === "image" || it.kind === "video");
      } catch {
        continue;
      }
      const step = Math.max(1, pages.length / 12);
      const picked: MediaItem[] = [];
      for (let i = 0; i < pages.length && picked.length < 12; i += step) picked.push(pages[Math.floor(i)]);
      albumPages[a.key] = picked.map((p) => p.key);
      for (const p of picked) if (!fresh(p)) out.push(p);
    }
    set({ data: { ...get().data!, albums: albumPages } });
    get().save();
    return out;
  },

  async startIndex(opts) {
    const s = useStore.getState();
    const root = s.root;
    if (!root || get().indexing) return;
    // Remembered with the tags while it goes: an app quit or restarted carries on with it (see below).
    const remember = (on: { paused?: boolean } | null) => {
      const d = get().data;
      if (!d || JSON.stringify(d.resumeIndex ?? null) === JSON.stringify(on)) return;
      const { resumeIndex: _was, ...rest } = d;
      void _was;
      set({ data: on ? { ...rest, resumeIndex: on } : rest });
      get().save();
      void get().flush();
    };
    await get().refreshTarget();
    const target = get().target;
    if (!target) {
      s.toast("Download the picture and word matcher first (Settings → Local models).", "warn");
      useEngine.getState().open(["siglip2"]);
      return;
    }
    // The anime tagger just downloaded goes through pictures and albums both (`both`), what is indexed
    // already among them: into the same index, the matcher's part kept.
    const runs: { mode: TagMode; items: MediaItem[] }[] = [];
    for (const mode of opts?.both ? (["images", "albums"] as const) : [get().mode]) runs.push({ mode, items: await get().pending(mode) });
    const total = runs.reduce((a, r) => a + r.items.length, 0);
    if (!total) {
      remember(null);
      if (!opts?.both) s.toast("Everything here is indexed.", "ok");
      return;
    }
    remember({ paused: !!opts?.paused });
    set({
      indexing: { done: 0, total, current: "", eta: null },
      indexPaused: !!opts?.paused,
    });
    // Results are put in the tag data a batch at a time: each commit copies the maps, so one per item
    // made a long run quadratic and redrew every screen per picture.
    const byKey = new Map(runs.flatMap((r) => r.items).map((i) => [i.key, i]));
    let batch: IndexedItem[] = [];
    let lastCommit = Date.now();
    const commit = () => {
      // Another library opened meanwhile: the results are in its index (in the backend), and nothing
      // of them goes into the one open now.
      if (useStore.getState().root !== root) batch = [];
      if (!batch.length) return;
      const stamp = (k: string) => ({
        s: byKey.get(k)?.size ?? 0,
        m: byKey.get(k)?.modified ?? 0,
      });
      // The backend keeps the results (and the embeddings); this copy is for showing them.
      const d = get().data;
      if (!d) return;
      const auto = { ...d.auto };
      const indexed = { ...d.indexed };
      for (const r of batch) {
        if (r.tags) auto[r.key] = r.tags.map(([i, p]) => [i, Math.round(p * 1000) / 1000] as [number, number]);
        indexed[r.key] = stamp(r.key);
      }
      set({ data: { ...d, auto, indexed } });
      // An empty index takes on the matcher of its first run, and the anime tagger when it first looks.
      const was = get().models;
      if (!was?.embedder || (target.tagger && !was.tagger)) {
        set({ models: { embedder: target.embedder, tagger: target.tagger || (was?.tagger ?? "") }, names: null });
        void get().loadNames();
      }
      batch = [];
      lastCommit = Date.now();
    };
    const startedAt = Date.now();
    let pausedFor = 0;
    let pausedAt: number | null = null;
    let failed = 0;
    let lastError: string | undefined;
    let offset = 0;
    try {
      for (const run of runs) {
        if (!run.items.length) continue;
        const models = {
          ...target,
          parts: get().data?.lookCloser ?? true,
          drawnOnly: run.mode === "images",
          paused: get().indexPaused,
        };
        const done = await api.tagsIndex(
          root,
          run.items,
          true,
          !!target.tagger,
          models,
          (p) => {
            const at = { ...p, done: p.done + offset, total };
            // Time left from the pace so far, the paused stretches left out.
            if (p.current === "paused") {
              pausedAt ??= Date.now();
              set({
                indexing: {
                  ...at,
                  current: "",
                  key: get().indexing?.key,
                  eta: get().indexing?.eta ?? null,
                  failed,
                  lastError,
                },
              });
              return;
            }
            if (pausedAt != null) {
              pausedFor += Date.now() - pausedAt;
              pausedAt = null;
            }
            const elapsed = (Date.now() - startedAt - pausedFor) / 1000;
            const eta = at.done > 0 && total > at.done ? Math.round((elapsed / at.done) * (total - at.done)) : null;
            set({ indexing: { ...at, eta, failed, lastError } });
          },
          (r) => {
            if (r.error) {
              if (r.error.startsWith("not downloaded")) s.toast(`Download the models first: ${r.error}`, "warn");
              // Not indexed: it comes up again next run, and the panel says how many could not be read.
              failed++;
              lastError = r.error;
              if (get().indexing) set({ indexing: { ...get().indexing!, failed, lastError } });
              return;
            }
            batch.push(r);
            if (batch.length >= 25 || Date.now() - lastCommit > 2000) commit();
          },
        );
        offset += run.items.length;
        if (done < run.items.length) break;
      }
    } catch (e) {
      s.toast(`Indexing stopped: ${String(e)}`, "error");
    } finally {
      // Stopped because another library opened: that one keeps its note to carry on with, and
      // nothing of this run is put in the one open now.
      const here = useStore.getState().root === root;
      if (here) {
        commit();
        // Ended here (done, stopped, or it couldn't go on): nothing to carry on with.
        remember(null);
      }
      set({ indexing: null, indexPaused: false });
      if (failed && here) s.toast(`${failed} item${failed === 1 ? "" : "s"} could not be read: ${lastError}`, "warn");
    }
  },

  cancelIndex() {
    set({ indexPaused: false });
    void api.tagsCancel();
  },

  pauseIndex(on) {
    set({ indexPaused: on });
    void api.tagsPause(on);
    // Held across a restart too.
    const d = get().data;
    if (d?.resumeIndex && !!d.resumeIndex.paused !== on) {
      set({ data: { ...d, resumeIndex: { paused: on } } });
      get().save();
    }
  },

  async search(text) {
    const q = text.trim();
    set({ query: text });
    if (!q) {
      set({ filter: "overview", found: [] });
      return;
    }
    try {
      const root = useStore.getState().root;
      const d = get().data;
      if (!root || !d) return;
      // In the backend, with the index's own model: albums by their pages, pictures by themselves and their crops.
      const hits = await api.tagsSearch(root, q, get().mode === "albums", 300);
      if (get().query !== text) return; // typed on since
      set({
        filter: "search",
        found: [...new Set(hits.map(([k]) => keptKey(k)))],
        selected: new Set(),
      });
    } catch (e) {
      useStore.getState().toast(`Search needs the picture and word matcher: ${String(e)}`, "warn");
    }
  },

  tagsOf(key) {
    return get().data?.tags[key] ?? [];
  },

  autoOf(key) {
    const d = get().data;
    const names = get().names;
    if (!d || !names) return [];
    const best = new Map<number, number>();
    const sources = isAlbumTagKey(key) ? albumPages(d, key.slice(6)) : [key];
    for (const k of sources) for (const [i, p] of d.auto[k] ?? []) best.set(i, Math.max(best.get(i) ?? 0, p));
    return [...best]
      .filter(([i]) => names[i] && names[i].category !== 9)
      .sort((a, b) => b[1] - a[1])
      .map(([i, p]) => [names[i].name, p] as [string, number]);
  },

  async suggest(keys) {
    const d = get().data;
    const root = useStore.getState().root;
    if (!d || !root || !keys.length) return [];
    const mine = new Set(keys.flatMap((k) => d.tags[k] ?? []));
    // Learned in the backend from the saved tags: what is waiting to be saved goes first.
    await get().flush();
    const chances = await api.tagsPredict(root, keys).catch(() => []);
    const out = new Map<string, Suggestion>();
    // Not what one of them can't take: a second tag of a "one of" folder, or one never suggested with a tag it has.
    const carried = [...mine];
    const blocked = new Map<string, boolean>();
    const offer = (tag: string, score: number, why: Suggestion["why"], note?: string) => {
      if (mine.has(tag) || score <= 0) return;
      if (!blocked.has(tag)) blocked.set(tag, blockerOf(d, tag)(carried));
      if (blocked.get(tag)) return;
      const had = out.get(tag);
      if (!had || had.score < score) out.set(tag, { tag, score: Math.min(1, score), why, note });
    };
    for (const c of chances) {
      // Where they are and what they carry nudge it (never suggest it on their own).
      const nudges = keys.map((k) => contextBoost(d, c.tag, k));
      const boost = nudges.reduce((a, x) => a + x.boost, 0) / keys.length;
      offer(c.tag, withContext(c.p, boost), c.examples ? "neighbours" : "words", nudges.find((x) => x.note)?.note);
    }
    // Tagger tags that were once accepted as one of yours.
    const map = d.autoMap ?? {};
    for (const [name, p] of get().autoOf(keys[0])) {
      const tag = map[name];
      if (tag && p >= 0.4) offer(tag, p, "tagger");
    }
    return [...out.values()]
      .filter((x) => x.score >= 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
  },

  coversFor(tag, mode, n) {
    const d = get().data;
    if (!d) return [];
    const out: string[] = [];
    for (const [k, list] of Object.entries(d.tags)) {
      if (!k || isAlbumTagKey(k) !== (mode === "albums") || !list.includes(tag)) continue;
      out.push(k);
      if (out.length >= n) break;
    }
    return out;
  },

  healPages() {
    // Tags put on single pages of an album (before albums were tagged whole) move onto the album.
    const d = get().data;
    const items = useStore.getState().allItems;
    if (!d || !items.length) return 0;
    // Nearly always nothing to do: find that out without copying anything.
    const albumOf = new Map<string, string>();
    for (const it of items) if (it.albumKey && d.tags[it.key]) albumOf.set(it.key, it.albumKey);
    if (!albumOf.size) return 0;
    const tags = { ...d.tags };
    let moved = 0;
    for (const [k, list] of Object.entries(d.tags)) {
      const ak = albumOf.get(k);
      if (!ak) continue;
      if (list.length) {
        const to = albumKeyOf(ak);
        tags[to] = [...new Set([...(tags[to] ?? []), ...list])];
        moved++;
      }
      delete tags[k];
    }
    if (!moved && Object.keys(tags).length === Object.keys(d.tags).length) return 0;
    set({ data: { ...d, tags } });
    get().save();
    return moved;
  },

  autoKeys(name, mode) {
    const d = get().data;
    const names = get().names;
    if (!d || !names) return [];
    const scored: [string, number][] = [];
    if (mode === "albums") {
      for (const a of eachOnce(useStore.getState().albums)) {
        const k = albumKeyOf(a.key);
        const p =
          get()
            .autoOf(k)
            .find(([n]) => n === name)?.[1] ?? 0;
        if (p >= 0.5) scored.push([k, p]);
      }
    } else {
      const i = names.findIndex((x) => x.name === name);
      if (i < 0) return [];
      for (const [k, list] of Object.entries(d.auto)) {
        const p = list.find(([j]) => j === i)?.[1] ?? 0;
        if (p >= 0.5) scored.push([k, p]);
      }
    }
    return scored.sort((a, b) => b[1] - a[1]).map(([k]) => k);
  },

  suggestedAuto(mode, limit = 40) {
    const d = get().data;
    const names = get().names;
    if (!d || !names) return [];
    // Not what is linked already, turned away, or on most of everything (says nothing).
    const mapped = new Set([...Object.keys(d.autoMap ?? {}), ...(d.ignoredWords ?? [])]);
    const count = new Map<number, { n: number; sample: string[] }>();
    const nameIndex = new Map(names.map((x, i) => [x.name, i]));
    const sources: [string, [number, number][]][] =
      mode === "albums"
        ? eachOnce(useStore.getState().albums).map((a) => [
            albumKeyOf(a.key),
            get()
              .autoOf(albumKeyOf(a.key))
              .map(([name, p]) => [nameIndex.get(name) ?? -1, p] as [number, number]),
          ])
        : Object.entries(d.auto);
    for (const [k, list] of sources) {
      for (const [i, p] of list) {
        if (p < 0.5 || i < 0 || !names[i] || names[i].category === 9 || mapped.has(names[i].name) || !telling(d, i)) continue;
        const c = count.get(i) ?? { n: 0, sample: [] };
        c.n++;
        if (c.sample.length < 4) c.sample.push(k);
        count.set(i, c);
      }
    }
    return [...count]
      .filter(([, c]) => c.n >= 3)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, limit)
      .map(([i, c]) => ({ name: names[i].name, count: c.n, sample: c.sample }));
  },

  adoptAuto(autoName, tag) {
    // The link is made; what the tagger saw it in is offered inside the tag, to confirm or turn down.
    const d = get().data;
    if (!d) return;
    get().addTag(tag);
    get().mapAuto(autoName, tag);
  },

  async suggestedFor(tag, mode) {
    // Learned in the backend from what carries the tag and what was turned down (and, while it is
    // young, its name); the tagger words linked to it, here; nudged by where things are and what
    // they carry.
    const d = get().data;
    const root = useStore.getState().root;
    if (!d || !root) return [];
    await get().flush();
    const denied = d.denied?.[tag] ?? [];
    const have = Object.entries(d.tags)
      .filter(([k, list]) => k && list.includes(tag))
      .map(([k]) => k);
    const skip = [...have, ...denied];
    const out = new Map<string, { key: string; score: number; why: Suggestion["why"]; note?: string }>();
    const offer = (key: string, score: number, why: Suggestion["why"], note?: string) => {
      const had = out.get(key);
      if (!had || had.score < score) out.set(key, { key, score: Math.min(1, score), why, note });
    };
    const skipSet = new Set(skip);
    const found = await api.tagsCandidates(root, tag, mode === "albums", skip, SHOWN_FROM, 600).catch(() => []);
    for (const c of found) {
      // A translated version (indexed before it was linked) is suggested as its original.
      const key = keptKey(c.key);
      if (skipSet.has(key)) continue;
      const { boost, note } = contextBoost(d, tag, key);
      offer(key, withContext(c.p, boost), c.examples ? "neighbours" : "words", note);
    }
    const names = get().names;
    const linked = new Set(
      Object.entries(d.autoMap ?? {})
        .filter(([, t]) => t === tag)
        .map(([n]) => names?.findIndex((x) => x.name === n) ?? -1)
        .filter((i) => i >= 0),
    );
    if (linked.size) {
      const keys =
        mode === "albums"
          ? Object.keys(d.albums ?? {})
              .filter((a) => originalOf(a) === a)
              .map(albumKeyOf)
          : Object.keys(d.auto).filter((k) => !isAlbumTagKey(k));
      for (const k of keys) {
        if (skipSet.has(k)) continue;
        const sources = isAlbumTagKey(k) ? (d.albums?.[k.slice(6)] ?? []) : [k];
        for (const src of sources) for (const [i, p] of d.auto[src] ?? []) if (linked.has(i) && p >= 0.4) offer(k, p, "tagger");
      }
    }
    const blocked = blockerOf(d, tag);
    return [...out.values()]
      .filter((x) => x.score >= SHOWN_FROM && !blocked(d.tags[x.key]))
      .sort((a, b) => b.score - a.score)
      .slice(0, 600);
  },

  bundleKeys(name) {
    const d = get().data;
    const members = new Set(d?.bundles?.[name] ?? []);
    if (!d || !members.size) return [];
    return Object.entries(d.tags)
      .filter(([k, list]) => k && list.some((t) => members.has(t)))
      .map(([k]) => k);
  },

  setBundle(name, tags) {
    const d = get().data;
    if (!d) return;
    const bundles = { ...(d.bundles ?? {}) };
    if (tags.length) bundles[name] = [...new Set(tags)];
    else delete bundles[name];
    set({ data: { ...d, bundles } });
    get().save();
  },

  deny(tag, keys) {
    const d = get().data;
    if (!d) return;
    const denied = {
      ...(d.denied ?? {}),
      [tag]: [...new Set([...(d.denied?.[tag] ?? []), ...keys])],
    };
    set({ data: { ...d, denied } });
    get().save();
  },

  joinVersions() {
    const d = get().data;
    const twin = new Map(Object.entries(useStore.getState().library?.albumTranslations ?? {}).map(([o, t]) => [`album:${t}`, `album:${o}`]));
    if (!d || !twin.size) return;
    // Nearly always nothing to do: find that out without copying anything.
    if (!Object.keys(d.tags).some((k) => twin.has(k)) && !Object.values(d.denied ?? {}).some((list) => list.some((k) => twin.has(k)))) return;
    const tags = { ...d.tags };
    for (const [from, to] of twin) {
      if (!tags[from]) continue;
      tags[to] = [...new Set([...(tags[to] ?? []), ...tags[from]])];
      delete tags[from];
    }
    const denied = Object.fromEntries(Object.entries(d.denied ?? {}).map(([tag, list]) => [tag, [...new Set(list.map((k) => twin.get(k) ?? k))]]));
    set({ data: { ...d, tags, denied } });
    get().save();
  },

  async splitVersion(original, translation) {
    await get().load();
    const d = get().data;
    const [from, to] = [`album:${original}`, `album:${translation}`];
    if (!d || (!d.tags[from] && !Object.values(d.denied ?? {}).some((list) => list.includes(from)))) return;
    const tags = d.tags[from]
      ? {
          ...d.tags,
          [to]: [...new Set([...(d.tags[to] ?? []), ...d.tags[from]])],
        }
      : d.tags;
    const denied = Object.fromEntries(Object.entries(d.denied ?? {}).map(([tag, list]) => [tag, list.includes(from) && !list.includes(to) ? [...list, to] : list]));
    set({ data: { ...d, tags, denied } });
    get().save();
  },

  async loadNames() {
    if (get().names) return;
    // The anime tagger's names: its numbers are positions in them. None without it (it is optional).
    const tagger = get().models?.tagger || get().target?.tagger;
    if (!tagger) return;
    try {
      set({ names: await api.tagsTagNames(tagger) });
    } catch {
      // The tagger isn't downloaded yet: its tags simply don't show.
    }
  },
}));

/**
 * Whether an item is indexed as it is now: with this size and time, and when the anime tagger is
 * downloaded, looked at by it as well (it leaves an empty list on a photo it passes over).
 */
export function indexedFresh(d: TagData, tagger: string | undefined) {
  return (it: MediaItem) => {
    const was = d.indexed[it.key];
    return !!was && was.s === it.size && was.m === it.modified && (!tagger || it.key in d.auto);
  };
}

/** Every tag id known: on something, or added empty. */
export function allTags(d: TagData): string[] {
  return [...new Set(Object.values(d.tags).flat())].sort();
}

/** Tag ids of a type, with how many things carry each (albums and items alike). */
export function tagsOfType(d: TagData, type: string): { id: string; name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const [k, list] of Object.entries(d.tags)) for (const id of list) if (id.startsWith(`${type}/`)) counts.set(id, (counts.get(id) ?? 0) + (k ? 1 : 0));
  return [...counts].map(([id, count]) => ({ id, name: id.slice(type.length + 1), count })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Suggestions inside a tag are shown from this chance up. */
const SHOWN_FROM = 0.3;
/** What the library says around a tag, worked out once per change of the tags and the library. */
let around: {
  tags: TagData["tags"];
  items: MediaItem[];
  dirOf: Map<string, string>;
  byDir: Map<string, string[]>;
  byTag: Map<string, Set<string>>;
  tagged: number;
  together: Map<string, number>;
} | null = null;

function surroundings(d: TagData) {
  const items = useStore.getState().allItems;
  if (around?.tags === d.tags && around.items === items) return around;
  const dirOf = new Map<string, string>();
  const byDir = new Map<string, string[]>();
  for (const it of items) {
    dirOf.set(it.key, it.dir);
    const list = byDir.get(it.dir) ?? [];
    list.push(it.key);
    byDir.set(it.dir, list);
  }
  const byTag = new Map<string, Set<string>>();
  let tagged = 0;
  for (const [k, list] of Object.entries(d.tags)) {
    if (!k || !list.length) continue;
    tagged++;
    for (const t of list) {
      const set = byTag.get(t) ?? new Set<string>();
      set.add(k);
      byTag.set(t, set);
    }
  }
  return (around = {
    tags: d.tags,
    items,
    dirOf,
    byDir,
    byTag,
    tagged,
    together: new Map(),
  });
}

/**
 * What where something is and what it carries say about a tag, as a nudge in logits (and why):
 * its folder (an import day, an event), when most of the others there carry the tag; and a tag of
 * its own that the tag usually goes with. Only a nudge: `withContext` never lets it suggest alone.
 */
export function contextBoost(d: TagData, tag: string, key: string): { boost: number; note?: string } {
  const c = surroundings(d);
  const carriers = c.byTag.get(tag);
  let boost = 0;
  const notes: string[] = [];
  const dir = c.dirOf.get(key);
  const others = dir === undefined ? [] : (c.byDir.get(dir) ?? []).filter((k) => k !== key);
  if (others.length >= 3) {
    const n = carriers ? others.filter((k) => carriers.has(k)).length : 0;
    const share = n / others.length;
    boost += Math.max(-0.5, Math.min(2, 2.5 * (share - 0.25)));
    if (share >= 0.4) notes.push(`${n} of ${others.length} in its folder have it`);
  }
  // A tag it carries that this one usually goes with (seen together on most of what carries that).
  const base = (carriers?.size ?? 0) / Math.max(1, c.tagged);
  let best = 0;
  let bestWith = "";
  for (const s of d.tags[key] ?? []) {
    const withS = c.byTag.get(s);
    if (!withS || withS.size < 3 || s === tag) continue;
    const pair = `${tag}\n${s}`;
    let both = c.together.get(pair);
    if (both === undefined) {
      both = 0;
      if (carriers) for (const k of withS) if (carriers.has(k)) both++;
      c.together.set(pair, both);
    }
    const share = both / withS.size;
    if (share > best) {
      best = share;
      bestWith = s;
    }
  }
  if (best > base) {
    boost += Math.min(1.5, 2 * (best - base));
    if (best >= 0.5) notes.push(`usually goes with ${nameOf(bestWith)}`);
  }
  return {
    boost: Math.min(2.5, boost),
    note: notes.length ? notes.join("; ") : undefined,
  };
}

/** Suggestions in the order asked for: the likeliest first, or the ones nearest even odds (each answer there teaches the most). */
export function inOrder<T extends { score: number }>(list: T[], order: "likely" | "unsure"): T[] {
  return [...list].sort(order === "unsure" ? (a, b) => Math.abs(a.score - 0.5) - Math.abs(b.score - 0.5) : (a, b) => b.score - a.score);
}

/** A chance nudged by context: only where the pictures themselves already speak for it a little. */
export function withContext(p: number, boost: number): number {
  if (p < 0.15 || !boost) return p;
  const z = Math.log(p / (1 - Math.min(p, 0.9999))) + boost;
  return 1 / (1 + Math.exp(-z));
}

// Whenever the library is read (and once the tags are), old page tags move onto their albums.
const heal = () => {
  const n = useTags.getState().healPages();
  if (n) useStore.getState().toast(`Tags from ${n} album page${n === 1 ? "" : "s"} moved onto their album${n === 1 ? "" : "s"} (albums are tagged whole)`, "ok");
};
// After the library settles: sorting changes the list on every key press.
let healTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((st, prev) => {
  if (st.allItems === prev.allItems || !st.allItems.length) return;
  if (!prev.allItems.length) return heal(); // the library just came in: old page tags move right away
  if (healTimer) clearTimeout(healTimer);
  healTimer = setTimeout(heal, 1500);
});
useTags.subscribe((st, prev) => {
  if (st.data && st.data !== prev.data && !prev.loaded && st.loaded) heal();
});
// Albums linked as translations (the library read, or a link made): their tags join.
useStore.subscribe((st, prev) => {
  if (st.library?.albumTranslations !== prev.library?.albumTranslations) useTags.getState().joinVersions();
});
/**
 * An indexing run cut short (the app quit, or a restart while working on it) carries on, held if it
 * was, when its library opens again: without visiting Tags. What it had done is kept (the backend's
 * journal), so it goes on from where it was.
 */
let resumedFor: string | null = null;
async function carryOn() {
  const root = useStore.getState().root;
  if (!root || resumedFor === root) return;
  resumedFor = root;
  await useTags.getState().load();
  const t = useTags.getState();
  if (useStore.getState().root !== root || !t.data?.resumeIndex || t.indexing) return;
  void t.startIndex({ paused: !!t.data.resumeIndex.paused });
}
useStore.subscribe((s, p) => {
  if (s.root && s.root !== p.root) void carryOn();
});
if (useStore.getState().root) void carryOn();

// Models downloaded or removed: which ones indexing uses follows. The anime tagger just downloaded
// looks at what is indexed already, as a job in Activity (a run going finishes first).
useEngine.subscribe((st, prev) => {
  if (!st.catalog || st.catalog === prev.catalog) return;
  const tagger = (c: { models: { id: string; downloaded: boolean }[] } | null) => !!c?.models.some((m) => m.id === "pixai" && m.downloaded);
  const t = useTags.getState();
  void t.refreshTarget().then(() => {
    if (prev.catalog && !tagger(prev.catalog) && tagger(st.catalog) && t.models?.embedder && !useTags.getState().indexing) void useTags.getState().startIndex({ both: true });
  });
});
