import { useAsync } from "../lib/useAsync";
import { setView, view } from "../lib/views";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { TopNav } from "../components/TopNav";
import { Thumb, ALBUM_RATIO } from "../components/Thumb";
import { TagPicker } from "../components/TagPicker";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { fmtEta, useCountdown } from "../lib/eta";
import { eachOnce, useStore } from "../store";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { useScrollMemory } from "../lib/scrollMemory";
import { useEngine } from "../plugins/engine";
import { albumKeyOf, blockerOf, conflictsOf, descendantsOf, isAlbumTagKey, isTagFilter, nameOf, pathOf, tagsOfType, treeOfType, typeOf, useTags, inOrder, type Suggestion, indexedFresh } from "../tagsStore";
import type { MediaItem } from "../lib/types";
import { ArrowLeft, CaretDown, CaretRight, Check, Cpu, Folder, GridFour, Info, MagnifyingGlass, Pause, PencilSimple, Play, Plus, RadioButton, SidebarSimple, Sparkle, SquaresFour, Stack, Stop, Tag as TagIcon, Trash, X, Books, Image as ImageIcon } from "@phosphor-icons/react";
import { askText } from "../components/Confirm";
import { PickOne } from "../components/TagPicker";
import { Covers, FolderPanel, MergePicker, NewFolderPanel, PlaceSelect, TagCard, TagRow, adoptWord, bundleTogether, makeSubtag, moveTagInto, renameTagTo, useFolderDrop, whyText, type TagNode } from "../components/TagBits";
import { ConflictActions, FolderInspector, TagInspector, carriersOf } from "../components/TagSide";
import { useCoverUrl } from "../scrapbook/pictures";
import { tileShapes } from "../lib/tileShapes";

/**
 * Tags: typed tags on images and videos, or on whole albums. The main view
 * is a board of the tag folders, each with all its tags as chips to drag
 * between folders; a "pick one" folder holds tags something carries at most
 * one of (day or night). Clicking a folder or a tag opens its settings in a
 * side panel (opposites, what often goes with a tag, the way into its grid).
 * Beside a grid, the tag list (left, folds away) and the selection's tags
 * (right) show. A folder also opens to its tags as cards with previews. Below
 * the folders, what the anime tagger sees often that isn't a tag of yours
 * yet. Right-click a tag for rename, merge, delete; a suggested one for adding
 * it into one you have.
 */
const NO_SUGGESTIONS: { key: string; score: number; why: Suggestion["why"]; note?: string }[] = [];
const NO_TAGS: Suggestion[] = [];

export function Tags() {
  const s = useStore(useShallow((x) => ({ albums: x.albums, allItems: x.allItems, library: x.library, loadAlbums: x.loadAlbums, openAlbum: x.openAlbum, openAlbums: x.openAlbums, openBrowse: x.openBrowse, openDupes: x.openDupes, openFiles: x.openFiles, openSortQueue: x.openSortQueue, openViewer: x.openViewer, root: x.root })));
  const t = useTags(useShallow((x) => ({ addTag: x.addTag, addType: x.addType, adoptAuto: x.adoptAuto, autoKeys: x.autoKeys, autoOf: x.autoOf, bundleKeys: x.bundleKeys, cancelIndex: x.cancelIndex, coversFor: x.coversFor, data: x.data, deny: x.deny, filter: x.filter, found: x.found, indexPaused: x.indexPaused, indexing: x.indexing, layout: x.layout, load: x.load, loadNames: x.loadNames, loaded: x.loaded, mapAuto: x.mapAuto, mergeTags: x.mergeTags, mode: x.mode, names: x.names, pauseIndex: x.pauseIndex, query: x.query, removeTag: x.removeTag, removeType: x.removeType, renameTag: x.renameTag, renameType: x.renameType, search: x.search, select: x.select, selected: x.selected, setBundle: x.setBundle, setFilter: x.setFilter, setLayout: x.setLayout, setMode: x.setMode, setTag: x.setTag, setZoom: x.setZoom, startIndex: x.startIndex, suggest: x.suggest, suggestedAuto: x.suggestedAuto, suggestedFor: x.suggestedFor, models: x.models, target: x.target, suggestOrder: x.suggestOrder, setSuggestOrder: x.setSuggestOrder, setLookCloser: x.setLookCloser, zoom: x.zoom })));
  const [newTag, setNewTag] = useState<{ type: string; name: string } | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const onBoard = t.filter === "overview" || t.filter.startsWith("tag:") || t.filter.startsWith("folder:");
  useScrollMemory(`tags:${t.mode}:${onBoard ? "overview" : t.filter}`, gridRef, t.loaded);
  useScrollMemory(`tags:${t.mode}:${onBoard ? "overview" : t.filter}`, overviewRef, t.loaded);
  const [viewport, setViewport] = useState({ top: 0, h: 800, w: 900 });
  // Thumbnails tell their aspect ratio as they load; the masonry layout follows. Kept past the
  // screen (tileShapes): back from the viewer, the mosaic is as it was.
  const aspects = useMemo(() => ({ current: tileShapes(s.root) }), [s.root]);
  const [, bumpAspects] = useState(0);
  // Many thumbnails load in the same moment: one layout per frame, not one per picture.
  const aspectRaf = useRef(0);
  const onAspect = useCallback((key: string, ratio: number) => {
    if (Math.abs((aspects.current.get(key) ?? 0) - ratio) < 0.01) return;
    aspects.current.set(key, ratio);
    if (!aspectRaf.current)
      aspectRaf.current = requestAnimationFrame(() => {
        aspectRaf.current = 0;
        bumpAspects((x) => x + 1);
      });
  }, [aspects]);
  const scrollRaf = useRef(0);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setViewport({ top: el.scrollTop, h: el.clientHeight || 800, w: el.clientWidth || 900 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [t.loaded, t.filter]);

  useEffect(() => {
    void t.load().then(() => void t.loadNames());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || dialogOpen()) return;
      const key = e.key.toLowerCase();
      if (key === "b") s.openBrowse();
      else if (key === "a") s.openAlbums();
      else if (key === "d") s.openDupes();
      else if (key === "e") s.openFiles();
      else if (key === "k") useStore.getState().openScrapbook();
      else if (key === "p") useStore.getState().openPeople();
      else if (key === "w") useStore.getState().openArtists();
      else if (key === "escape") {
        const f = useTags.getState().filter;
        if (f === "overview") s.openSortQueue();
        else t.setFilter(upFrom(f));
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Albums are wanted in both modes: an album page is suggested as its whole album.
    if (!s.albums.length) void s.loadAlbums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.mode]);

  const d = t.data;
  const items = s.allItems;
  // A translated version is one album with its original: shown, counted and tagged as it.
  const albums = useMemo(() => eachOnce(s.albums), [s.albums, s.library?.albumTranslations]); // eslint-disable-line react-hooks/exhaustive-deps
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const albumByKey = useMemo(() => new Map(albums.map((a) => [albumKeyOf(a.key), a])), [albums]);

  /** Album pages become their album (once, in the place of its first page): albums are tagged whole. */
  const foldPages = (list: string[]): string[] => {
    if (t.mode !== "images") return list;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of list) {
      const ak = byKey.get(k)?.albumKey;
      const key = ak && albumByKey.has(albumKeyOf(ak)) ? albumKeyOf(ak) : k;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  };

  // What the middle shows when a tag (or folder, search, all, untagged) is open: keys in order.
  const keys = useMemo(() => {
    if (!d || onBoard || t.filter.startsWith("type:")) return [];
    const base: string[] = t.mode === "images" ? foldPages(items.filter((i) => i.kind === "image" || i.kind === "video").map((i) => i.key)) : albums.map((a) => albumKeyOf(a.key));
    if (t.filter === "search") return t.found.filter((k) => (t.mode === "images" ? byKey.has(k) : albumByKey.has(k)));
    // An album also counts as tagged with what any of its pages carries.
    const pageTags = new Map<string, Set<string>>();
    if (t.mode === "albums") {
      for (const it of items) {
        if (!it.albumKey) continue;
        const list = d.tags[it.key];
        if (!list?.length) continue;
        const ak = albumKeyOf(it.albumKey);
        const set = pageTags.get(ak) ?? new Set<string>();
        for (const id of list) set.add(id);
        pageTags.set(ak, set);
      }
    }
    const carries = (k: string, id: string) => !!d.tags[k]?.includes(id) || !!pageTags.get(k)?.has(id);
    if (t.filter === "untagged") return base.filter((k) => !d.tags[k]?.length && !pageTags.get(k)?.size);
    if (t.filter.startsWith("conflicts:")) {
      const of = new Set(conflictsOf(d, t.filter.slice(10)));
      return base.filter((k) => of.has(k));
    }
    if (t.filter === "all") return base;
    if (t.filter.startsWith("bundle:")) {
      const members = new Set(t.bundleKeys(t.filter.slice(7)));
      const ids = d.bundles?.[t.filter.slice(7)] ?? [];
      return base.filter((k) => members.has(k) || ids.some((id) => carries(k, id)));
    }
    if (t.filter.startsWith("auto:")) return foldPages(t.autoKeys(t.filter.slice(5), t.mode).filter((k) => (t.mode === "images" ? byKey.has(k) : albumByKey.has(k))));
    const own = base.filter((k) => carries(k, t.filter));
    // Albums carry tags whole: in the pictures view they show as an album among the pictures.
    return own;
  }, [d, t.mode, t.filter, t.found, items, albums, byKey, albumByKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // In a tag's view: what might belong but isn't confirmed, shown after the verified ones with dashed outlines.
  const [showing, setShowing] = useState<"both" | "verified" | "suggested">("both");
  const isTagView = !!d && isTagFilter(t.filter);
  const showable = (k: string) => (isAlbumTagKey(k) ? !!albumByKey.get(k)?.cover : byKey.has(k));
  // Worked out in the backend (the embeddings live there).
  const rawSuggested = useAsync(`${t.mode}:${t.filter}`, () => (isTagView && d ? t.suggestedFor(t.filter, t.mode) : NO_SUGGESTIONS), [isTagView, d, t.models, t.names], NO_SUGGESTIONS);
  const allSuggested = useMemo(() => {
    if (!isTagView || !d) return NO_SUGGESTIONS;
    // Only what can be shown: the index still knows files since trashed or moved, and albums
    // without a cover; given a place in the grid, those left empty gaps.
    // Nothing carrying a tag it isn't suggested with (an album's pages fold into it below: checked again there).
    const blocked = blockerOf(d, t.filter);
    const raw = inOrder(rawSuggested.filter((x) => showable(x.key) && !blocked(d.tags[x.key])), t.suggestOrder);
    if (t.mode !== "images") return raw;
    // A page of an album is suggested as the whole album, unless the album has the tag or was turned down.
    const seen = new Set<string>();
    const out: typeof raw = [];
    for (const x of raw) {
      const ak = byKey.get(x.key)?.albumKey;
      const key = ak && albumByKey.has(albumKeyOf(ak)) ? albumKeyOf(ak) : x.key;
      if (seen.has(key)) continue;
      seen.add(key);
      if (key !== x.key && (d.tags[key]?.includes(t.filter) || d.denied?.[t.filter]?.includes(key) || !showable(key) || blocked(d.tags[key]))) continue;
      out.push(key === x.key ? x : { ...x, key });
    }
    return out;
  }, [rawSuggested, isTagView, t.mode, d, byKey, albumByKey, t.suggestOrder]); // eslint-disable-line react-hooks/exhaustive-deps
  const [suggestLimit, setSuggestLimit] = useState(60);
  useEffect(() => setSuggestLimit(60), [t.filter]);
  const suggestedKeys = useMemo(() => allSuggested.slice(0, suggestLimit), [allSuggested, suggestLimit]);
  const suggestedSet = useMemo(() => new Set(suggestedKeys.map((x) => x.key)), [suggestedKeys]);
  const suggestedBy = useMemo(() => new Map(suggestedKeys.map((x) => [x.key, x])), [suggestedKeys]);
  const shownKeys = useMemo(() => {
    if (!isTagView) return keys;
    const verified = showing === "suggested" ? [] : keys.filter(showable);
    const suggested = showing === "verified" ? [] : suggestedKeys.map((x) => x.key);
    return [...verified, ...suggested];
  }, [keys, isTagView, showing, suggestedKeys]);

  const selectedKeys = useMemo(() => {
    const set = new Set(keys);
    return [...t.selected].filter((k) => set.has(k));
  }, [t.selected, keys]);
  const suggestions = useAsync(selectedKeys.join("\n"), () => (selectedKeys.length ? t.suggest(selectedKeys) : NO_TAGS), [d, t.models, t.names], NO_TAGS);
  const auto = useMemo(() => (selectedKeys.length === 1 ? t.autoOf(selectedKeys[0]).slice(0, 24) : []), [selectedKeys, d, t.names]); // eslint-disable-line react-hooks/exhaustive-deps
  const pendingCount = useMemo(() => {
    if (!d || t.mode !== "images") return null;
    const fresh = indexedFresh(d, t.target?.tagger);
    return items.filter((i) => (i.kind === "image" || i.kind === "video") && !fresh(i)).length;
  }, [d, items, t.mode, t.target]);
  const [autoLimit, setAutoLimit] = useState(40);
  const suggestedTags = useMemo(() => (d && t.names ? t.suggestedAuto(t.mode, autoLimit) : []), [d, t.names, t.mode, autoLimit, s.albums]); // eslint-disable-line react-hooks/exhaustive-deps
  const allTagIds = useMemo(() => (d ? [...new Set(Object.values(d.tags).flat())].sort() : []), [d]);

  // The grid's window: tiles `zoom` wide, in as many columns as fit; rows above and below the view left out.
  const GAP = 10;
  const cols = Math.max(1, Math.floor((viewport.w + GAP) / (t.zoom + GAP)));
  const colW = (viewport.w - GAP * (cols - 1)) / cols;
  const META = 30; // the name bar under each picture
  // A tile's shape: an album's pages', else a square in the grid or the picture's own.
  const shapeOf = (k: string) => (isAlbumTagKey(k) ? ALBUM_RATIO : t.layout === "grid" ? 1 : (aspects.current.get(k) ?? 1));
  const layout = useMemo(() => {
    // Each tile's place: rows as tall as their tallest tile (an album's), or columns filled
    // shortest-first by the tiles' shapes.
    const heights = new Array<number>(cols).fill(0);
    let rowY = 0;
    let rowH = 0;
    const out = shownKeys.map((k, i) => {
      const h = colW / shapeOf(k) + META;
      if (t.layout === "grid") {
        if (i % cols === 0) {
          rowY += rowH ? rowH + GAP : 0;
          rowH = Math.max(...shownKeys.slice(i, i + cols).map((r) => colW / shapeOf(r) + META));
        }
        heights[i % cols] = rowY + rowH + GAP;
        return { x: (i % cols) * (colW + GAP), y: rowY, w: colW, h };
      }
      const c = heights.indexOf(Math.min(...heights));
      const y = heights[c];
      heights[c] = y + h + GAP;
      return { x: c * (colW + GAP), y, w: colW, h };
    });
    return { tiles: out, height: Math.max(0, ...heights) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKeys, cols, colW, t.layout, aspects, aspects.current.size, viewport.w]);
  // The suggestions scrolled past so far (wholly above the bottom of the view): yes to all of them at once.
  const seenSuggested = useMemo(() => {
    if (!isTagView || showing === "verified" || !d) return [];
    const bottom = viewport.top + viewport.h;
    return shownKeys.filter((k, i) => suggestedSet.has(k) && !d.tags[k]?.includes(t.filter) && !!layout.tiles[i] && layout.tiles[i].y + layout.tiles[i].h <= bottom + 1);
  }, [isTagView, showing, d, viewport, shownKeys, suggestedSet, layout, t.filter]);
  const [accepted, setAccepted] = useState<{ tag: string; keys: string[] } | null>(null);
  useEffect(() => setAccepted(null), [t.filter]);

  const visible = useMemo(() => {
    const top = viewport.top - 400;
    const bottom = viewport.top + viewport.h + 400;
    const out: number[] = [];
    layout.tiles.forEach((p, i) => {
      if (p.y + p.h >= top && p.y <= bottom) out.push(i);
    });
    return out;
  }, [layout, viewport.top, viewport.h]);

  const onTile = (i: number, e: MouseEvent) => {
    const key = shownKeys[i];
    const next = new Set(e.metaKey || e.ctrlKey ? t.selected : []);
    if (e.shiftKey && anchor != null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      for (let j = a; j <= b; j++) next.add(shownKeys[j]);
    } else {
      if ((e.metaKey || e.ctrlKey) && next.has(key)) next.delete(key);
      else next.add(key);
      setAnchor(i);
    }
    t.select(next);
  };

  const open = (key: string) => {
    if (isAlbumTagKey(key)) {
      const a = albumByKey.get(key);
      if (a) void s.openAlbum(a);
    } else if (byKey.get(key)) {
      const list = shownKeys.filter((k) => byKey.has(k));
      s.openViewer(list.map((k) => byKey.get(k)!), Math.max(0, list.indexOf(key)), { kind: "browse" });
    }
  };

  const itemFor = useCallback((k: string): MediaItem | null => (isAlbumTagKey(k) ? (albumByKey.get(k)?.cover ?? null) : (byKey.get(k) ?? null)), [byKey, albumByKey]);
  // Worked out once per change of the tags or the library, not on every render.
  const coverCache = useMemo(() => new Map<string, MediaItem[]>(), [d, t.mode, byKey, albumByKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const covers = (tag: string, n = 4) => {
    const k = `${tag}|${n}`;
    let c = coverCache.get(k);
    if (!c) coverCache.set(k, (c = t.coversFor(tag, t.mode, n).map(itemFor).filter((x): x is MediaItem => !!x)));
    return c;
  };
  const typeTags = useMemo(() => new Map((d?.types ?? []).map((ty) => [ty, tagsOfType(d!, ty)])), [d]);
  const tagsIn = (ty: string) => typeTags.get(ty) ?? (d ? tagsOfType(d, ty) : []);
  // Subtags under their parents, for the board and the list.
  const typeTrees = useMemo(() => new Map((d?.types ?? []).map((ty) => [ty, treeOfType(d!, ty)])), [d]);
  const treeIn = (ty: string) => typeTrees.get(ty) ?? [];
  const shownCount = useMemo(() => (t.mode === "images" ? items.filter((i) => i.kind !== "raw").length : albums.length), [t.mode, items, albums]);
  const untaggedCount = useMemo(
    () => (t.mode === "images" ? items.filter((i) => i.kind === "image" || i.kind === "video").map((i) => i.key) : albums.map((a) => albumKeyOf(a.key))).filter((k) => !d?.tags[k]?.length).length,
    [t.mode, items, albums, d],
  );

  const tagsOnSelection = useMemo(() => {
    if (!d || !selectedKeys.length) return [];
    const count = new Map<string, number>();
    const sole = new Set(d.exclusive ?? []);
    for (const k of selectedKeys) for (const id of d.tags[k] ?? []) if (!sole.has(typeOf(id))) count.set(id, (count.get(id) ?? 0) + 1);
    return [...count].map(([id, n]) => ({ id, all: n === selectedKeys.length })).sort((a, b) => a.id.localeCompare(b.id));
  }, [d, selectedKeys]);
  const conflictCounts = useMemo(() => new Map((d?.exclusive ?? []).map((ty) => [ty, conflictsOf(d!, ty).length])), [d]);
  const carrierCounts = useMemo(() => new Map((d?.types ?? []).map((ty) => [ty, carriersOf(d!.tags, ty)])), [d]);

  const left = useCountdown(t.indexing?.eta ?? null);

  // The tag list beside a grid, folded away or not, kept between visits.
  const [listOpen, setListOpen] = useState(() => {
    try {
      return localStorage.getItem("quire.tags.list") !== "0";
    } catch {
      return true;
    }
  });
  const toggleList = () => {
    setListOpen(!listOpen);
    try {
      localStorage.setItem("quire.tags.list", listOpen ? "0" : "1");
    } catch {
      /* no storage: it opens again next time */
    }
  };

  // Types folded away in the tag list, kept between visits (with the library: see lib/views).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set<string>(view<string[]>("tagsCollapsed", [])));
  const toggleCollapsed = (type: string) => {
    const next = new Set(collapsed);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setCollapsed(next);
    setView("tagsCollapsed", [...next]);
  };

  // ---- right-click menus ----
  const tagMenu = (e: MouseEvent, id: string) => {
    e.preventDefault();
    const type = id.slice(0, id.indexOf("/"));
    const name = id.slice(id.indexOf("/") + 1);
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: <><Info /> Settings</>, onClick: () => t.setFilter(`tag:${id}`) },
        { label: <><SquaresFour /> See tagged</>, onClick: () => t.setFilter(id) },
        { label: <><PencilSimple /> Rename…</>, onClick: () => void askText({ title: "Rename tag", message: <>New name for <b>{name}</b>:</>, initial: name, confirm: "Rename" }).then((to) => void (to && renameTagTo(id, to))) },
        { content: <MergePicker label="Move to subtag of…" tags={allTagIds.filter((x) => x !== id && x !== d?.parents?.[id] && !(d && descendantsOf(d, id).has(x)))} onPick={(to) => { void makeSubtag(id, to); setMenu(null); }} /> },
        ...(d?.parents?.[id] ? [{ label: <><ArrowLeft /> Make it a top tag</>, onClick: () => void moveTagInto(id, type) }] : []),
        { content: <MergePicker label="Merge into…" tags={allTagIds.filter((x) => x !== id)} onPick={(to) => { t.mergeTags(id, to); setMenu(null); }} /> },
        {
          content: (
            <MergePicker
              label="Bundle with… (a tag, a bundle, or a new alias)"
              tags={[...Object.keys(d?.bundles ?? {}).map((n) => `bundle:${n}`), ...allTagIds.filter((x) => x !== id)]}
              onNew={(alias) => {
                // An alias that doesn't exist yet: made in this tag's type, and bundled with it under the tag's own name.
                const aliasId = `${type}/${alias}`;
                t.addTag(aliasId);
                bundleTogether(id, aliasId);
                setMenu(null);
              }}
              onPick={(other) => {
                if (other.startsWith("bundle:")) {
                  const n = other.slice(7);
                  t.setBundle(n, [...(d?.bundles?.[n] ?? []), id]);
                } else {
                  void askText({ title: "New bundle", message: "A name for the bundle (a filter that stands for both tags):", initial: `${name} & ${other.slice(other.indexOf("/") + 1)}`, confirm: "Make bundle" }).then((n) => n && t.setBundle(n, [id, other]));
                }
                setMenu(null);
              }}
            />
          ),
        },
        { separator: true },
        { label: <><Trash /> Delete everywhere</>, danger: true, onClick: () => t.removeTag(id) },
      ],
    });
  };
  const suggestedMenu = (e: MouseEvent, name: string) => {
    e.preventDefault();
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { content: <MergePicker label="Add as a subtag of…" tags={allTagIds} onPick={(to) => { adoptWord(name, name.replace(/_/g, " "), `under:${to}`); setMenu(null); }} /> },
        { content: <MergePicker label="Add into one of your tags (as the same thing)…" tags={allTagIds} onPick={(to) => { t.adoptAuto(name, to); setMenu(null); }} /> },
        { separator: true },
        { label: `Don't offer “${name.replace(/_/g, " ")}” again`, onClick: () => useTags.getState().ignoreWord(name, true) },
      ],
    });
  };

  if (!d) {
    return (
      <div className="screen tags-screen">
        <TopNav current="tags" />
        <div className="dim" style={{ padding: 24 }}>
          Loading tags…
        </div>
      </div>
    );
  }

  const label = nameOf;
  const inType = t.filter.startsWith("type:") ? t.filter.slice(5) : null;
  // On the board, a clicked tag or folder shows its settings in the side panel.
  const tagSel = t.filter.startsWith("tag:") ? t.filter.slice(4) : null;
  const folderSel = t.filter.startsWith("folder:") ? t.filter.slice(7) : null;
  const title = t.filter.startsWith("auto:")
    ? `“${t.filter.slice(5).replace(/_/g, " ")}”, as the tagger sees it`
    : onBoard
      ? "Your tags"
      : inType
        ? inType
        : t.filter === "all"
            ? `All ${t.mode}`
            : t.filter === "untagged"
              ? "Untagged"
              : t.filter === "search"
                ? `Found for “${t.query}”`
                : t.filter.startsWith("conflicts:")
                    ? `Carrying more than one of ${t.filter.slice(10)}`
                    : t.filter.startsWith("bundle:")
                      ? `${t.filter.slice(7)} (bundle: ${(d.bundles?.[t.filter.slice(7)] ?? []).map(nameOf).join(", ")})`
                      : `${typeOf(t.filter)} / ${nameOf(t.filter)}`;
  const current = t.indexing?.key ? byKey.get(t.indexing.key) : undefined;
  // Grids have the tag list (left, folds away) and the selection's tags (right); the board has the side panel of what was clicked.
  const showsItems = !(onBoard || inType);
  const columns = showsItems ? `${listOpen ? "240px " : ""}minmax(0, 1fr) 300px` : tagSel || folderSel ? "minmax(0, 1fr) 340px" : "minmax(0, 1fr)";
  const wantsIndex = !!t.indexing || t.mode === "albums" || !!pendingCount;
  const openTag = (id: string) => t.setFilter(`tag:${id}`);

  return (
    <div className="screen tags-screen">
      <TopNav current="tags" />
      <div className="page-tabs" role="tablist">
        <button role="tab" aria-selected={t.mode === "images"} className={`page-tab ${t.mode === "images" ? "active" : ""}`} onClick={() => t.setMode("images")}>
          <ImageIcon /> Images
        </button>
        <button role="tab" aria-selected={t.mode === "albums"} className={`page-tab ${t.mode === "albums" ? "active" : ""}`} onClick={() => t.setMode("albums")}>
          <Books /> Albums
        </button>
        <span className="grow" />
        <form
          className="row tags-search"
          onSubmit={(e) => {
            e.preventDefault();
            void t.search(t.query);
          }}
        >
          <input className="input" placeholder="Find by words…" value={t.query} onChange={(e) => useTags.setState({ query: e.target.value })} />
          <button className="btn sm ghost" type="submit" title="Search the pictures by what they show">
            <MagnifyingGlass />
          </button>
        </form>
      </div>
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
      <div className="tags-layout" style={{ gridTemplateColumns: columns }}>
        {/* ---- left, beside a grid: the folders and tags, to jump between and drag tags across ---- */}
        {showsItems && listOpen && (
          <aside className="tags-side panel">
            <div className="tags-list">
              <button className={`tags-row ${t.filter === "overview" ? "active" : ""}`} onClick={() => t.setFilter("overview")}>
                <TagIcon /> Your tags
              </button>
              <button className={`tags-row ${t.filter === "all" ? "active" : ""}`} onClick={() => t.setFilter("all")}>
                All {t.mode}
                <span className="count">{shownCount}</span>
              </button>
              <button className={`tags-row ${t.filter === "untagged" ? "active" : ""}`} onClick={() => t.setFilter("untagged")}>
                Untagged
                <span className="count">{untaggedCount}</span>
              </button>
              {d.types.map((type) => (
                <ListFolder
                  key={type}
                  type={type}
                  tags={treeIn(type)}
                  exclusive={!!d.exclusive?.includes(type)}
                  open={!collapsed.has(type)}
                  filter={t.filter}
                  onToggle={() => toggleCollapsed(type)}
                  onOpenType={() => t.setFilter(`folder:${type}`)}
                  onOpenTag={openTag}
                  onOpenGrid={(id) => t.setFilter(id)}
                  onMenu={tagMenu}
                  onNew={() => setNewTag({ type, name: "" })}
                >
                  {newTag?.type === type && (
                    <form
                      className="row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const name = newTag.name.trim().replace(/\//g, " ");
                        if (name) {
                          const id = `${type}/${name}`;
                          t.addTag(id);
                          // Made beside a selection: it goes on the selection straight away.
                          if (selectedKeys.length) t.setTag(selectedKeys, id, true);
                          else t.setFilter(id);
                        }
                        setNewTag(null);
                      }}
                    >
                      <input className="input grow" autoFocus placeholder={selectedKeys.length ? `new tag, on the ${selectedKeys.length} selected` : "new tag"} value={newTag.name} onChange={(e) => setNewTag({ type, name: e.target.value })} onKeyDown={(e) => e.key === "Escape" && setNewTag(null)} />
                      <button className="btn sm primary" type="submit">
                        <Check />
                      </button>
                    </form>
                  )}
                </ListFolder>
              ))}
            </div>
          </aside>
        )}

        {/* ---- middle: the board, a folder's tags, a tag's page, or a grid ---- */}
        <main className="tags-grid-wrap">
          <div className="row tags-grid-head">
            {showsItems && (
              <button className={`btn sm ${listOpen ? "ghost" : ""}`} onClick={toggleList} title={listOpen ? "Hide the tag list" : "Show the tag list"}>
                <SidebarSimple />
              </button>
            )}
            {!onBoard && (
              <button className="btn sm ghost" onClick={() => t.setFilter(upFrom(t.filter))} title="Back (Esc)">
                <ArrowLeft />
              </button>
            )}
            <span className="label">
              {title}
              {showsItems && <span className="dim"> · {keys.length}</span>}
            </span>
            {isTagView && (
              <button className="btn sm ghost" onClick={() => openTag(t.filter)} title="The tag's settings: opposites, what often goes with it">
                <Info /> Tag settings
              </button>
            )}
            {inType && (
              <button className="btn sm ghost" onClick={() => t.setFilter(`folder:${inType}`)} title="The folder's settings">
                <Info /> Folder settings
              </button>
            )}
            <span className="grow" />
            {t.filter.startsWith("auto:") && (
              <AdoptBar
                name={t.filter.slice(5)}
                selected={selectedKeys.length}
                firstType={d.types[0] ?? "motives"}
                onAdopt={(text, place) => {
                  const id = adoptWord(t.filter.slice(5), text, place);
                  if (!id) return;
                  // What is selected here goes into the new tag straight away; the rest is offered inside it.
                  if (selectedKeys.length) t.setTag(selectedKeys, id, true);
                  t.setFilter(id);
                }}
              />
            )}
            {t.filter.startsWith("bundle:") && (
              <span className="tags-bundle-add">
                <TagPicker placeholder="Add an alias (new or known tag)…" defaultType={typeOf((d.bundles?.[t.filter.slice(7)] ?? [])[0] ?? "")} onAdd={(aid) => t.setBundle(t.filter.slice(7), [...(d.bundles?.[t.filter.slice(7)] ?? []), aid])} />
              </span>
            )}
            {showsItems && (keys.length > 0 || suggestedKeys.length > 0) && (
              <span className="row tags-tools">
                {selectedKeys.length > 0 && <span className="dim small">{selectedKeys.length} selected</span>}
                <button className="btn sm ghost" onClick={() => t.select(new Set(keys))} title="Select everything shown">
                  All
                </button>
                <button className="btn sm ghost" onClick={() => t.select(new Set())}>
                  None
                </button>
                {isTagView && (
                  <span className="btn-group" title="Confirmed ones, suggested ones (dashed), or both">
                    {(["both", "verified", "suggested"] as const).map((v) => (
                      <button key={v} className={`btn sm ${showing === v ? "active" : "ghost"}`} onClick={() => setShowing(v)}>
                        {v === "both" ? "Both" : v === "verified" ? "Verified" : `Suggested ${allSuggested.length}`}
                      </button>
                    ))}
                  </span>
                )}
                {isTagView && suggestedKeys.length > 0 && showing !== "verified" && (
                  <>
                    <span className="btn-group" title="Which suggestions come first">
                      <button className={`btn sm ${t.suggestOrder === "likely" ? "active" : "ghost"}`} onClick={() => t.setSuggestOrder("likely")} title="The likeliest first">
                        Likely
                      </button>
                      <button className={`btn sm ${t.suggestOrder === "unsure" ? "active" : "ghost"}`} onClick={() => t.setSuggestOrder("unsure")} title="The ones it is least sure of first: each yes or no there teaches it the most">
                        Unsure
                      </button>
                    </span>
                    <button className="btn sm ghost" onClick={() => t.setTag(suggestedKeys.map((x) => x.key), t.filter, true)} title="Confirm every suggestion shown">
                      <Check /> All
                    </button>
                    <button className="btn sm ghost" onClick={() => t.deny(t.filter, suggestedKeys.map((x) => x.key))} title="Turn every suggestion down">
                      <X /> All
                    </button>
                  </>
                )}
                <span className="btn-group">
                  <button className={`btn sm ${t.layout === "grid" ? "active" : "ghost"}`} onClick={() => t.setLayout("grid")} title="Square tiles">
                    Grid
                  </button>
                  <button className={`btn sm ${t.layout === "masonry" ? "active" : "ghost"}`} onClick={() => t.setLayout("masonry")} title="Tiles in their own shape, like Browse">
                    Mosaic
                  </button>
                </span>
                <input type="range" min={100} max={420} step={20} value={t.zoom} onChange={(e) => t.setZoom(Number(e.target.value))} title="Tile size" />
              </span>
            )}
          </div>

          {isTagView && <TagBanner id={t.filter} />}
          {(t.filter === "untagged" || (t.filter === "search" && !shownKeys.length)) && wantsIndex && (
            <div className="tags-index-banner panel">
              <Cpu />
              {t.indexing ? (
                <>
                  {current && (
                    <div className="index-pill-thumb" title={current.name}>
                      <Thumb item={current} eager aspect={1} onClick={() => {}} />
                    </div>
                  )}
                  <div className="grow tags-index-progress">
                    <div className="row index-now">
                      <span className="small ellipsis grow">{t.indexPaused ? "Paused" : `Indexing · ${t.indexing.current || "finishing…"}`}</span>
                      <span className="mono small dim">
                        {t.indexing.done} / {t.indexing.total} · ~{fmtEta(left)} left
                      </span>
                    </div>
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${t.indexing.total ? Math.round((100 * t.indexing.done) / t.indexing.total) : 0}%` }} />
                    </div>
                    {(t.indexing.failed ?? 0) > 0 && (
                      <div className="small index-failed" title={t.indexing.lastError}>
                        {t.indexing.failed} could not be read · <span className="dim">{t.indexing.lastError}</span>
                      </div>
                    )}
                  </div>
                  <button className="btn sm ghost" onClick={() => t.pauseIndex(!t.indexPaused)} title={t.indexPaused ? "Carry on with the next picture" : "Hold after the current picture; what is done stays"}>
                    {t.indexPaused ? <Play /> : <Pause />}
                  </button>
                  <button className="btn sm ghost" onClick={t.cancelIndex} title="Stop; what is done stays">
                    <Stop />
                  </button>
                </>
              ) : (
                <>
                  <span className="small grow index-note">
                    {t.mode === "images" ? `${pendingCount} not indexed yet.` : "Albums are indexed by a spread of their pages."} Suggestions and search come from the index; it runs here, on this computer, once per picture.
                    {t.target && !t.target.tagger && <> For anime, manga and art, the anime tagger (optional, in Models) also names what it sees in drawings.</>}
                  </span>
                  <label className="row small index-closer" title="Also look at four crops of each picture: finds small things in a corner, but takes about five times as long">
                    <input type="checkbox" checked={d?.lookCloser ?? true} onChange={(e) => t.setLookCloser(e.target.checked)} /> Look closer
                  </label>
                  <button className="btn sm primary" onClick={() => void t.startIndex()}>
                    <Sparkle /> Index {t.mode}
                  </button>
                  <button className="btn sm ghost" onClick={() => useEngine.getState().open(["siglip2"])} title="The model this needs, and the optional anime tagger">
                    Models
                  </button>
                </>
              )}
            </div>
          )}

          {onBoard ? (
            <div
              className="tags-overview"
              ref={overviewRef}
              onScroll={(e) => {
                // More of the tagger's words as the bottom comes near.
                const el = e.currentTarget;
                if (el.scrollTop + el.clientHeight > el.scrollHeight - 400 && suggestedTags.length >= autoLimit) setAutoLimit(autoLimit + 40);
              }}
            >
              <div className="type-cards">
                <div className="type-card panel" onClick={() => t.setFilter("untagged")} title="What has no tag yet">
                  <div className="type-card-head">
                    <TagIcon />
                    <strong>Untagged</strong>
                    <span className="dim mono small">{untaggedCount}</span>
                  </div>
                  <div className="type-card-sub dim">{t.indexing ? `Indexing · ${t.indexing.done} / ${t.indexing.total}` : pendingCount ? `Still to be tagged · ${pendingCount} not indexed yet` : "Still to be tagged."}</div>
                </div>
                <div className="type-card panel" onClick={() => t.setFilter("all")} title={`Every ${t.mode === "images" ? "image and video" : "album"}`}>
                  <div className="type-card-head">
                    <SquaresFour />
                    <strong>All {t.mode}</strong>
                    <span className="dim mono small">{shownCount}</span>
                  </div>
                  <div className="type-card-sub dim">Everything, tagged or not.</div>
                </div>
                {Object.entries(d.bundles ?? {}).map(([name, members]) => (
                  <div key={`bundle:${name}`} className="type-card panel bundle" onClick={() => t.setFilter(`bundle:${name}`)} title="A bundle: everything carrying any of its tags">
                    <div className="type-card-head">
                      <Stack />
                      <strong>{name}</strong>
                      <span className="dim mono small">{t.bundleKeys(name).length}</span>
                      <span className="grow" />
                      <button className="chip-x" title="Remove the bundle (its tags stay)" onClick={(e) => { e.stopPropagation(); t.setBundle(name, []); }}>
                        <X />
                      </button>
                    </div>
                    <div className="chips">
                      {members.map((id) => (
                        <span key={id} className="chip" title={id}>
                          {nameOf(id)}
                          <button className="chip-x" title="Take this tag out of the bundle" onClick={(e) => { e.stopPropagation(); t.setBundle(name, members.filter((x) => x !== id)); }}>
                            <X />
                          </button>
                        </span>
                      ))}
                    </div>
                    <div onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                      <TagPicker placeholder="Add an alias (new or known tag)…" defaultType={typeOf(members[0] ?? "")} onAdd={(aid) => t.setBundle(name, [...members, aid])} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="tag-folders">
                {d.types.map((type) => (
                  <FolderPanel
                    key={type}
                    type={type}
                    tags={treeIn(type)}
                    carriers={carrierCounts.get(type) ?? 0}
                    exclusive={!!d.exclusive?.includes(type)}
                    conflicts={conflictCounts.get(type) ?? 0}
                    selected={folderSel === type}
                    selectedTag={tagSel}
                    onSelect={() => t.setFilter(folderSel === type ? "overview" : `folder:${type}`)}
                    onOpenTag={(id) => t.setFilter(tagSel === id ? "overview" : `tag:${id}`)}
                    onMenu={tagMenu}
                  />
                ))}
                <NewFolderPanel />
              </div>
              {suggestedTags.length > 0 && (
                <section>
                  <div className="label">
                    <Sparkle /> Seen often by the tagger, not yet one of your tags
                  </div>
                  <div className="dim small">Add one as a new tag under any name and type, or right-click to add it into a tag you already have. Nothing is tagged by itself: what the tagger saw it in appears inside the tag as suggestions, dashed, to confirm or turn down.</div>
                  <div className="tag-cards">
                    {suggestedTags.map((sg) => (
                      <SuggestedCard key={sg.name} onOpen={() => t.setFilter(`auto:${sg.name}`)} name={sg.name} count={sg.count} covers={sg.sample.map(itemFor).filter((x): x is MediaItem => !!x)} firstType={d.types[0] ?? "motives"} onAdopt={(text, place) => void adoptWord(sg.name, text, place)} onMenu={(e) => suggestedMenu(e, sg.name)} />
                    ))}
                  </div>
                  {suggestedTags.length >= autoLimit && (
                    <div className="row" style={{ justifyContent: "center", padding: 12 }}>
                      <button className="btn sm" onClick={() => setAutoLimit((n) => n + 40)}>
                        Show more
                      </button>
                    </div>
                  )}
                </section>
              )}
              {!suggestedTags.length && pendingCount !== 0 && t.mode === "images" && <div className="dim small">Index the pictures (in Untagged) and the tagger's suggestions appear here.</div>}
            </div>
          ) : inType ? (
            <div className="tags-overview" ref={overviewRef}>
              <div className="tag-cards">
                {tagsIn(inType).map((tag) => (
                  <TagCard key={tag.id} id={tag.id} name={pathOf(d, tag.id)} count={tag.count} covers={covers(tag.id)} onOpen={() => openTag(tag.id)} onMenu={(e) => tagMenu(e, tag.id)} />
                ))}
                {!tagsIn(inType).length && <div className="dim tags-empty">No tags in {inType} yet. Add one with + on its folder on the main view.</div>}
              </div>
            </div>
          ) : (
            <div
              className="tags-grid"
              ref={gridRef}
              onScroll={(e) => {
                // At most once a frame: scroll events come faster than the screen draws.
                const el = e.currentTarget;
                if (scrollRaf.current) return;
                scrollRaf.current = requestAnimationFrame(() => {
                  scrollRaf.current = 0;
                  setViewport((v) => (v.top === el.scrollTop && v.h === (el.clientHeight || v.h) ? v : { ...v, top: el.scrollTop, h: el.clientHeight || v.h }));
                });
              }}
            >
              {/* Only the tiles in view are rendered: a library of thousands stays light. */}
              <div className="tags-grid-rows" style={{ height: layout.height, position: "relative" }}>
                {visible.map((i) => {
                  const k = shownKeys[i];
                  const p = layout.tiles[i];
                  const album = albumByKey.get(k);
                  const it = album ? album.cover : byKey.get(k);
                  if (!it) return null;
                  const suggested = isTagView && suggestedSet.has(k) && !d.tags[k]?.includes(t.filter);
                  return (
                    <div key={k} className={`tags-tile ${t.selected.has(k) ? "selected" : ""} ${suggested ? "suggested" : ""}`} style={{ position: "absolute", left: p.x, top: p.y, width: p.w, height: p.h }} onDoubleClick={() => open(k)}>
                      {suggested && suggestedBy.get(k) && (
                        <span className="tags-tile-score mono small" title={`${whyText(suggestedBy.get(k)!.why)}${suggestedBy.get(k)!.note ? `; ${suggestedBy.get(k)!.note}` : ""}`}>
                          {Math.round(suggestedBy.get(k)!.score * 100)}%
                        </span>
                      )}
                      {suggested && (
                        <span className="tags-tile-verdict">
                          <button className="btn sm" title="Yes, it belongs" onClick={(e) => { e.stopPropagation(); t.setTag([k], t.filter, true); }}>
                            <Check />
                          </button>
                          <button className="btn sm" title="No, it doesn't" onClick={(e) => { e.stopPropagation(); t.deny(t.filter, [k]); }}>
                            <X />
                          </button>
                        </span>
                      )}
                      <Thumb item={it} aspect={shapeOf(k)} onAspect={t.layout === "masonry" && !album ? onAspect : undefined} rating={s.library?.ratings[it.key]} album={!!album} name={album?.name} selected={t.selected.has(k)} onClick={(e) => onTile(i, e)} />
                      {(d.tags[k]?.length ?? 0) > 0 && <TileTags ids={d.tags[k]} />}
                    </div>
                  );
                })}
              </div>
              {isTagView && showing !== "verified" && (seenSuggested.length > 0 || accepted) && (
                <div className="tags-seen-bar panel">
                  {accepted ? (
                    <>
                      <span className="grow">
                        {accepted.keys.length} tagged {label(accepted.tag)}.
                      </span>
                      <button className="btn sm ghost" onClick={() => (t.setTag(accepted.keys, accepted.tag, false), setAccepted(null))}>
                        Undo
                      </button>
                    </>
                  ) : (
                    <span className="grow dim small">Everything down to here looks right?</span>
                  )}
                  {seenSuggested.length > 0 && (
                    <button
                      className="btn sm primary"
                      onClick={() => {
                        t.setTag(seenSuggested, t.filter, true);
                        setAccepted({ tag: t.filter, keys: seenSuggested });
                      }}
                      title="Yes to every suggestion you've scrolled past, down to the bottom of the view"
                    >
                      <Check /> Yes to the {seenSuggested.length} down to here
                    </button>
                  )}
                </div>
              )}
              {isTagView && showing !== "verified" && allSuggested.length > suggestLimit && (
                <div className="row" style={{ justifyContent: "center", padding: 12 }}>
                  <button className="btn sm" onClick={() => setSuggestLimit((n) => n + 120)}>
                    Show more suggestions ({allSuggested.length - suggestLimit} left)
                  </button>
                </div>
              )}
              {!shownKeys.length && (
                <div className="dim tags-empty">
                  {t.filter === "search" ? "Nothing matched. Search needs the pictures indexed first." : t.filter.startsWith("conflicts:") ? "Nothing carries more than one of them any more." : "Nothing here."}
                </div>
              )}
            </div>
          )}
        </main>

        {/* ---- right, on the board: the settings of the tag or folder clicked ---- */}
        {tagSel && (
          <TagInspector
            key={tagSel}
            id={tagSel}
            itemFor={itemFor}
            onClose={() => t.setFilter("overview")}
            onSee={(which) => {
              setShowing(which);
              t.setFilter(tagSel);
            }}
            onOpenTag={openTag}
            onFilter={t.setFilter}
          />
        )}
        {folderSel && <FolderInspector key={folderSel} type={folderSel} onClose={() => t.setFilter("overview")} onOpenTag={openTag} onPreviews={() => t.setFilter(`type:${folderSel}`)} onConflicts={() => t.setFilter(`conflicts:${folderSel}`)} />}

        {/* ---- right, beside a grid: the selection's tags ---- */}
        {showsItems && (
          <aside className="tags-side right panel">
            {t.filter.startsWith("conflicts:") && (
              <>
                <ConflictActions type={t.filter.slice(10)} />
                <hr className="rule" />
              </>
            )}
            {selectedKeys.length === 0 ? (
              <div className="dim small">Select something to see and set its tags. Click, ⌘-click, shift-click; double-click opens it.</div>
            ) : (
              <>
                <section>
                  <div className="label">
                    Tags on {selectedKeys.length === 1 ? (albumByKey.get(selectedKeys[0])?.name ?? byKey.get(selectedKeys[0])?.name ?? "this") : `${selectedKeys.length} ${t.mode}`}
                  </div>
                  <PickOne keys={selectedKeys} empty={<span className="dim small">No tags yet.</span>}>
                    {tagsOnSelection.map(({ id, all }) => (
                      <span key={id} className={`chip ${all ? "" : "partial"}`} title={all ? id : `${id} (on some)`} onContextMenu={(e) => tagMenu(e, id)}>
                        {label(id)}
                        <button className="chip-x" title="Take this tag off" onClick={() => t.setTag(selectedKeys, id, false)}>
                          <X />
                        </button>
                      </span>
                    ))}
                  </PickOne>
                  <TagPicker onAdd={(id) => t.setTag(selectedKeys, id, true)} />
                </section>
                <hr className="rule" />
                <section>
                  <div className="label">
                    <Sparkle /> Suggested
                  </div>
                  <div className="chips">
                    {suggestions.map((sg) => (
                      <SuggestionChip key={sg.tag} sg={sg} onAccept={() => t.setTag(selectedKeys, sg.tag, true)} />
                    ))}
                    {!suggestions.length && <span className="dim small">{d.indexed[selectedKeys[0]] || isAlbumTagKey(selectedKeys[0]) ? "Nothing to suggest yet: tag a few things first, or name tags after what they show." : "Not indexed yet (index in Untagged)."}</span>}
                  </div>
                </section>
                {auto.length > 0 && (
                  <>
                    <hr className="rule" />
                    <section>
                      <div className="label">Seen in it</div>
                      <div className="dim small">The anime tagger's words. Click one to make it a tag of yours (right-click: into a tag you have); it will suggest that tag from then on.</div>
                      <div className="chips">
                        {auto.map(([name, p]) => (
                          <AutoChip
                            key={name}
                            name={name}
                            p={p}
                            types={d.types}
                            mapped={d.autoMap?.[name]}
                            onPick={(id) => {
                              t.mapAuto(name, id);
                              t.addTag(id);
                              t.setTag(selectedKeys, id, true);
                            }}
                            onMenu={(e) => suggestedMenu(e, name)}
                          />
                        ))}
                      </div>
                    </section>
                  </>
                )}
              </>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/** A tile's tags: as many as fit whole, then how many more there are. */
function TileTags({ ids }: { ids: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(ids.length);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const count = () => {
      // Measured whole in a hidden row: each tag, and the "+n" for the most there could be.
      const widths = Array.from(el.querySelectorAll<HTMLElement>(".tile-tags-measure .badge"), (b) => b.offsetWidth);
      const more = widths.pop() ?? 0;
      const room = el.clientWidth;
      const GAP = 4;
      let used = 0;
      let n = 0;
      while (n < widths.length && used + widths[n] + (n < widths.length - 1 ? GAP + more : 0) <= room) used += widths[n++] + GAP;
      setFit(n);
    };
    count();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(count);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ids]);
  const left = ids.length - fit;
  return (
    <div className="tags-tile-tags" ref={box}>
      {ids.slice(0, fit).map((id) => (
        <span key={id} className="badge">
          {nameOf(id)}
        </span>
      ))}
      {left > 0 && (
<span className="badge">+{left}</span>
      )}
      <div className="tile-tags-measure" aria-hidden>
        {ids.map((id) => (
          <span key={id} className="badge">
            {nameOf(id)}
          </span>
        ))}
        <span className="badge">+{ids.length}</span>
      </div>
    </div>
  );
}

/** A tag's Scrapbook banner above its grid, when it has one. */
function TagBanner({ id }: { id: string }) {
  const url = useCoverUrl(useTags((x) => x.data?.covers?.[id]));
  return url ? <img className="tag-banner wide" src={url} alt="" draggable={false} /> : null;
}

/** One level up from a view: a tag's grid to its settings, a folder's previews to its settings, anything else to the board. */
function upFrom(filter: string): string {
  if (isTagFilter(filter)) return `tag:${filter}`;
  if (filter.startsWith("type:")) return `folder:${filter.slice(5)}`;
  return "overview";
}

/** A folder in the tag list beside a grid: its tags to open (or straight to their grid), and a place to drop a dragged tag. */
function ListFolder({ type, tags, exclusive, open, filter, onToggle, onOpenType, onOpenTag, onOpenGrid, onMenu, onNew, children }: { type: string; tags: TagNode[]; exclusive: boolean; open: boolean; filter: string; onToggle: () => void; onOpenType: () => void; onOpenTag: (id: string) => void; onOpenGrid: (id: string) => void; onMenu: (e: MouseEvent, id: string) => void; onNew: () => void; children?: React.ReactNode }) {
  const drop = useFolderDrop(type);
  return (
    <div className={`tags-type ${drop.over ? "drop-over" : ""}`} {...drop.props}>
      <div className={`tags-type-head ${filter === `type:${type}` ? "active" : ""}`}>
        <button className="btn sm ghost tags-type-caret" title={open ? "Fold its tags away" : "Show its tags"} onClick={onToggle}>
          {open ? <CaretDown /> : <CaretRight />}
        </button>
        <button className="tags-row grow" onClick={onOpenType} title={`${type}: its settings`}>
          <Folder /> <span className="label">{type}</span>
          {exclusive && (
            <span className="dim" title="Pick one: at most one of its tags on anything">
              <RadioButton />
            </span>
          )}
          {!open && <span className="count">{tags.length}</span>}
        </button>
        <button className="btn sm ghost" title={`New tag in ${type}`} onClick={onNew}>
          <Plus />
        </button>
      </div>
      {open && children}
      {open &&
        tags.map((tag) => (
          <TagRow
            key={tag.id}
            node={tag}
            active={filter === tag.id || filter === `tag:${tag.id}`}
            icon={<TagIcon />}
            onOpen={() => onOpenTag(tag.id)}
            onMenu={(e) => onMenu(e, tag.id)}
            extra={
              <button className="btn sm ghost tags-row-x" title="Straight to its grid" onClick={(e) => (e.stopPropagation(), onOpenGrid(tag.id))}>
                <GridFour />
              </button>
            }
          />
        ))}
    </div>
  );
}

/** A tagger word seen often: adopt it as a tag of yours under a name and type of your choosing, or (right-click) into one you have. */
/** A tagger's word made into one of your tags: a name and a type, then it opens as that tag. */
function AdoptBar({ name, firstType, selected, onAdopt }: { name: string; firstType: string; selected: number; onAdopt: (text: string, place: string) => void }) {
  const [text, setText] = useState(name.replace(/_/g, " "));
  const [place, setPlace] = useState(`in:${firstType}`);
  return (
    <form
      className="row tags-adopt-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onAdopt(text, place);
      }}
    >
      <PlaceSelect value={place} onChange={setPlace} />
      <input className="input" value={text} onChange={(e) => setText(e.target.value)} title="Its name" />
      <button className="btn sm primary" type="submit" title="Make it one of your tags: the selected pictures are put in it, the others offered inside it to confirm">
        <Plus /> Make it a tag{selected ? ` (+${selected} selected)` : ""}
      </button>
    </form>
  );
}

function SuggestedCard({ name, count, covers, firstType, onAdopt, onMenu, onOpen }: { name: string; count: number; covers: MediaItem[]; firstType: string; onAdopt: (text: string, place: string) => void; onMenu: (e: MouseEvent) => void; onOpen: () => void }) {
  const shown = name.replace(/_/g, " ");
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(shown);
  const [place, setPlace] = useState(`in:${firstType}`);
  return (
    <div
      className="tag-card panel suggested"
      title={`The tagger sees “${shown}” in ${count} pictures. Click to see them; right-click to add it into a tag you have.`}
      onContextMenu={onMenu}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, form, input, select")) return;
        onOpen();
      }}
    >
      <Covers covers={covers} />
      {editing ? (
        <form
          className="tag-card-adopt"
          onSubmit={(e) => {
            e.preventDefault();
            onAdopt(text, place);
            setEditing(false);
          }}
        >
          <PlaceSelect value={place} onChange={setPlace} />
          <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
          <button className="btn sm primary" type="submit" title="Add as a tag; it stays recognised by what the tagger saw">
            <Check />
          </button>
        </form>
      ) : (
        <div className="tag-card-foot stacked">
          <span className="tag-card-name" title={shown}>
            {shown}
          </span>
          <div className="row">
            <span className="dim small grow">in {count}</span>
            <button className="btn sm ghost" onClick={() => setEditing(true)} title="Make it one of your tags, under any name: in a folder, or as a subtag of a tag">
              <Plus /> Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SuggestionChip({ sg, onAccept }: { sg: Suggestion; onAccept: () => void }) {
  const why = whyText(sg.why);
  return (
    <button className="chip suggest" onClick={onAccept} title={`${Math.round(sg.score * 100)}%: ${why}${sg.note ? `; ${sg.note}` : ""}`}>
      <Plus /> {sg.tag.slice(sg.tag.indexOf("/") + 1)} <span className="dim mono small">{Math.round(sg.score * 100)}</span>
    </button>
  );
}

function AutoChip({ name, p, types, mapped, onPick, onMenu }: { name: string; p: number; types: string[]; mapped?: string; onPick: (id: string) => void; onMenu: (e: MouseEvent) => void }) {
  const [picking, setPicking] = useState(false);
  if (mapped) {
    return (
      <button className="chip auto mapped" onClick={() => onPick(mapped)} onContextMenu={onMenu} title={`= ${mapped} (${Math.round(p * 100)}%)`}>
        {name.replace(/_/g, " ")} <span className="dim mono small">{Math.round(p * 100)}</span>
      </button>
    );
  }
  if (picking) {
    return (
      <span className="chip auto">
        {name.replace(/_/g, " ")} →
        {types.map((type) => (
          <button
            key={type}
            className="btn sm ghost"
            onClick={() => {
              setPicking(false);
              onPick(`${type}/${name.replace(/_/g, " ")}`);
            }}
          >
            {type}
          </button>
        ))}
        <button className="chip-x" onClick={() => setPicking(false)}>
          <X />
        </button>
      </span>
    );
  }
  return (
    <button className="chip auto" onClick={() => setPicking(true)} onContextMenu={onMenu} title={`${Math.round(p * 100)}%: click to make it one of your tags, right-click to add it into one you have`}>
      {name.replace(/_/g, " ")} <span className="dim mono small">{Math.round(p * 100)}</span>
    </button>
  );
}

