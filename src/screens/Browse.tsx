import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type MouseEvent, useDeferredValue } from "react";
import { useShallow } from "zustand/react/shallow";
import { TopNav, SideToggle } from "../components/TopNav";
import { PluginButtons } from "../components/PluginButtons";
import { api, pickFolder } from "../lib/api";
import { ArrowCounterClockwise, ArrowsClockwise, Info, MagnifyingGlass, Stack, PaintBrush, PencilSimple, Play, Scissors, Selection, Sparkle, Tag as TagIcon, Trash } from "@phosphor-icons/react";
import { findSources } from "../findSource";
import { useFinders } from "../plugins/find";
import { useScrapbook } from "../scrapbook/store";
import { useScrollMemory } from "../lib/scrollMemory";
import { Popover } from "../components/Popover";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { TagEditor } from "../components/TagPicker";
import { ArtistPicker } from "../components/ArtistPicker";
import { useTags } from "../tagsStore";
import { useStore, type BrowseFilters } from "../store";
import { revertAll, useVersions } from "../versionsStore";
import { seriesIndex, stacks } from "../lib/series";
import { FiltersButton, FiltersPanel, type Filter } from "../components/Filters";
import { NO_FILTER, filterPictures, useFilterData, usePictureFilterSections, type PictureFilter } from "../components/PictureFilters";
import { Thumb } from "../components/Thumb";
import { Deco } from "../components/Deco";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { formatBytes, shuffled, naturalCompare } from "../lib/format";
import type { MediaItem } from "../lib/types";
import { tileShapes } from "../lib/tileShapes";

type SortSel = "name" | "date" | "rating" | "size";
type Layout = "masonry" | "grid";

const GAP = 10;
/** Every filter off (the search, order and layout stay). */
const FILTERS_OFF: Partial<BrowseFilters> = { location: "all", kind: "all", folders: null, minRating: 0, unratedOnly: false, tagged: "all", tags: [], tagsMode: "or", tagsOut: [], tagsOutMode: "or", artists: [], people: [] };
const DEFAULTS_RESET: Partial<BrowseFilters> = { ...FILTERS_OFF, query: "", sortBy: "name", desc: false, random: false };
const META_H = 30; // caption row under each tile, must match .thumb-meta
const OVERSCAN = 900;

/**
 * Everything under the opened folder (and any target folders outside it) as one
 * virtualised masonry grid, narrowed down by location, type, folders, rating
 * and name. Album folders are kept out; they have their own screen.
 */
export function Browse() {
  const s = useStore(useShallow((x) => ({ allItems: x.allItems, allStale: x.allStale, backupOpen: x.backupOpen, browseFilters: x.browseFilters, busy: x.busy, driveOpen: x.driveOpen, library: x.library, loadAll: x.loadAll, leaveSeries: x.leaveSeries, loading: x.loading, makeSeries: x.makeSeries, moveItem: x.moveItem, openAlbums: x.openAlbums, openDupes: x.openDupes, openEdit: x.openEdit, openFiles: x.openFiles, openSortQueue: x.openSortQueue, openTags: x.openTags, openViewer: x.openViewer, pluginsOpen: x.pluginsOpen, root: x.root, seriesTogether: x.seriesTogether, set: x.set, setBrowseFilters: x.setBrowseFilters, setRating: x.setRating, settingsOpen: x.settingsOpen, sideCollapsed: x.sideCollapsed, surprise: x.surprise, toast: x.toast, toggleChrome: x.toggleChrome, trashItem: x.trashItem, trashOpen: x.trashOpen, undo: x.undo, vault: x.vault, vaultOpen: x.vaultOpen, viewed: x.viewed })));
  const targets = s.library?.targets ?? [];
  const f = s.browseFilters;
  const setF = s.setBrowseFilters;
  const { location, kind, query, sortBy, desc, minRating, unratedOnly, random, zoom, layout, tagged = "all", tags: tagsSel = [], tagsMode = "or", tagsOut = [], tagsOutMode = "or", artists: artistsSel = [], people: peopleSel = [] } = f;
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    void useTags.getState().load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root]);
  const folders = useMemo(() => (f.folders ? new Set(f.folders) : null), [f.folders]);
  const setQuery = (v: string) => setF({ query: v });
  // Typing stays instant; filtering the whole library follows a beat behind.
  const searchQuery = useDeferredValue(query);
  const setZoom = (v: number) => setF({ zoom: v });
  const setLayout = (v: Layout) => setF({ layout: v });
  const seed = useStore((st) => st.browseSeed);
  const setSeed = () => useStore.getState().reshuffleBrowse();
  const toggleRandom = () => {
    setF({ random: !useStore.getState().browseFilters.random });
    setSeed();
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [tagMenu, setTagMenu] = useState(false);
  const [artistMenu, setArtistMenu] = useState(false);
  const [ctx, setCtx] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  /** Right-click on a tile: it, or the selection it is part of. */
  // Platforms in Find that can look a picture up (Find source).
  const lookups = useFinders(useShallow((f) => Object.values(f.finders).filter((x) => x.lookup)));
  const tileMenu = (e: MouseEvent, it: MediaItem) => {
    e.preventDefault();
    const group = selected.has(it.key) ? selectedItems : [it];
    const keys = group.map((g) => g.key);
    const many = group.length > 1;
    setCtx({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: <><Info /> Info</>, onClick: () => s.set({ infoItem: it }) },
        ...(it.kind === "image" || it.kind === "raw" ? [{ label: <><Scissors /> Make a sticker…</>, onClick: () => void useScrapbook.getState().openStudio({ item: it }) }] : []),
        ...(lookups.length && group.some((g) => g.kind === "image") ? [{ label: <><MagnifyingGlass /> Find source{many ? `s of ${group.length}` : ""} on {lookups.map((f) => f.name).join(" and ")}</>, onClick: () => void findSources(group) }] : []),
        { content: <><span className="label">Tags{many ? ` on ${group.length}` : ""}</span><TagEditor keys={keys} /></> },
        { separator: true },
        ...targets.map((t) => ({ label: <>Move to {t.name}</>, onClick: () => void (many ? moveSelected(t.id) : s.moveItem(it, t.id)) })),
        { separator: true },
        { label: <><Trash /> Trash{many ? ` ${group.length}` : ""}</>, danger: true, onClick: () => void (many ? trashSelected() : s.trashItem(it)) },
      ],
    });
  };
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    void s.loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, s.allStale]);

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
  const items = useMemo(() => {
    const list = filterPictures(all, picked, filterData);
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
  }, [all, picked, filterData, random, seed, sortBy, desc, ratingsForSort, viewedForSort]);

  // The filters, as every screen shows them: a section each in the panel, chips for what is on.
  const filters: Filter[] = usePictureFilterSections({ ...picked, query }, setF, all);

  // Drop selections that are no longer in the list (moved, trashed, filtered out).
  useEffect(() => {
    if (selected.size === 0) return;
    const keys = new Set(items.map((i) => i.key));
    const next = new Set([...selected].filter((k) => keys.has(k)));
    if (next.size !== selected.size) setSelected(next);
  }, [items, selected]);

  const totalBytes = useMemo(() => items.reduce((a, i) => a + i.size, 0), [items]);

  // Series kept together are one tile, the rest of each behind its first picture; opened, all of them in a row.
  const seriesOf = useMemo(() => seriesIndex(s.library?.series), [s.library?.series]);
  const tiles = useMemo(() => (s.seriesTogether ? stacks(items, seriesOf) : items.map((item) => ({ item, members: [item] }))), [items, seriesOf, s.seriesTogether]);

  /* ---------- layout ---------- */
  // Kept past the screen (tileShapes): back from the viewer, the mosaic is as it was.
  const aspects = useMemo(() => ({ current: tileShapes(s.root) }), [s.root]);
  const [aspectVersion, bumpAspects] = useReducer((x: number) => x + 1, 0);
  const aspectRaf = useRef(0);
  const onAspect = useCallback((key: string, ratio: number) => {
    if (Math.abs((aspects.current.get(key) ?? 0) - ratio) < 0.01) return;
    aspects.current.set(key, ratio);
    if (!aspectRaf.current) aspectRaf.current = requestAnimationFrame(() => {
      aspectRaf.current = 0;
      bumpAspects();
    });
  }, [aspects]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  useScrollMemory(`browse:${location}:${kind}:${query}:${sortBy}:${desc}:${random}:${minRating}:${unratedOnly}:${tagged}:${[...(folders ?? [])].join(",")}`, scrollerRef, true);
  const [gridW, setGridW] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, h: 0 });
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      setGridW(el.clientWidth - 32);
      setViewport({ top: el.scrollTop, h: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scrollRaf = useRef(0);
  const onScroll = () => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const el = scrollerRef.current;
      if (el) setViewport({ top: el.scrollTop, h: el.clientHeight });
    });
  };

  const positions = useMemo(() => {
    const cols = Math.max(1, Math.floor((gridW + GAP) / (zoom + GAP)));
    const colW = (gridW - GAP * (cols - 1)) / cols;
    const heights = new Array<number>(cols).fill(0);
    const pos = tiles.map(({ item: it }) => {
      const ratio = layout === "grid" ? 4 / 3 : (aspects.current.get(it.key) ?? 4 / 3);
      const h = colW / ratio + META_H;
      let c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c] - 0.5) c = k;
      const y = heights[c];
      heights[c] = y + h + GAP;
      return { x: c * (colW + GAP), y, w: colW, h, ratio };
    });
    return { pos, total: Math.max(0, ...heights), colW };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, gridW, zoom, layout, aspectVersion, aspects]);

  /* ---------- selection ---------- */
  /** The tile at `i` in the viewer, with everything shown in order (a series whole). */
  const open = (i: number) => {
    const queue = tiles.flatMap((t) => t.members);
    s.openViewer(queue, Math.max(0, queue.indexOf(tiles[i].item)), { kind: "browse" });
  };
  const onTileClick = (i: number, e: MouseEvent) => {
    // A series' tile selects all of it.
    const keys = tiles[i].members.map((m) => m.key);
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      setSelected((sel) => {
        const next = new Set(sel);
        for (let k = a; k <= b; k++) for (const m of tiles[k].members) next.add(m.key);
        return next;
      });
      return;
    }
    if (e.metaKey || e.ctrlKey || selectMode || selected.size > 0) {
      setSelected((sel) => {
        const next = new Set(sel);
        const on = !keys.every((k) => next.has(k));
        for (const k of keys) {
          if (on) next.add(k);
          else next.delete(k);
        }
        return next;
      });
      anchor.current = i;
      return;
    }
    anchor.current = i;
    open(i);
  };
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.key)), [items, selected]);
  // A few pictures alike made a series, or a series' pictures taken out of it.
  const seriesAction = useMemo(() => {
    const pictures = selectedItems.filter((i) => i.kind === "image" || i.kind === "raw");
    const inOne = selectedItems.filter((i) => seriesOf.has(i.key));
    if (inOne.length && inOne.length === selectedItems.length && new Set(inOne.map((i) => seriesOf.get(i.key))).size === 1 && seriesOf.get(inOne[0].key)!.length === inOne.length)
      return { label: "Split series", title: "These are no series: each picture on its own again", run: () => s.leaveSeries(inOne.map((i) => i.key)) };
    if (pictures.length >= 2 && pictures.length === selectedItems.length)
      return { label: "Make series", title: "Keep these together as a series: one tile here, and whole in Sort (one key files all of it)", run: () => s.makeSeries(pictures.map((i) => i.key)) };
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItems, seriesOf]);
  // Revert shows once anything here has been overwritten by an edit or a plugin.
  const hasVersions = useVersions((v) => Object.keys(v.links).length > 0);
  const rateSelected = (r: number | null) => {
    for (const it of selectedItems) s.setRating(it, r);
    s.toast(r == null ? `Cleared ${selectedItems.length} ratings` : `Rated ${selectedItems.length} items ${r}`, "ok");
  };
  const moveSelected = async (targetId: string) => {
    const list = selectedItems;
    setSelected(new Set());
    for (const it of list) await s.moveItem(it, targetId);
  };
  const trashSelected = async () => {
    const list = selectedItems;
    setSelected(new Set());
    for (const it of list) await s.trashItem(it);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || dialogOpen()) return;
      if (s.settingsOpen || s.trashOpen || s.driveOpen || s.backupOpen || s.vaultOpen || s.pluginsOpen) return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "a") {
        e.preventDefault();
        setSelected(new Set(items.map((i) => i.key)));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key === "z") {
        e.preventDefault();
        void s.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (key === "escape") {
        if (selected.size) setSelected(new Set());
        else s.openSortQueue();
        return;
      }
      if (selected.size > 0) {
        if (/^[0-9]$/.test(key)) return rateSelected(key === "0" ? 10 : Number(key));
        if (key === "u") return rateSelected(null);
        if (key === "backspace" || key === "delete") return void trashSelected();
        if (key === "t") return s.openEdit(selectedItems);
        const t = targets.find((t) => t.hotkey.toLowerCase() === key);
        if (t) return void moveSelected(t.id);
      }
      if (key === "b") s.openSortQueue();
      if (key === "d") s.openDupes();
      if (key === "a") s.openAlbums();
      if (key === "r") void s.surprise();
      if (key === "s") toggleRandom();
      if (key === "g") s.set({ settingsOpen: true });
      if (key === "e") s.openFiles();
      if (key === "l") s.openTags();
      if (key === "k") useStore.getState().openScrapbook();
      if (key === "p") useStore.getState().openPeople();
      if (key === "w") useStore.getState().openArtists();
      if (key === "h") s.toggleChrome();
      if (key === "enter" && items.length) open(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, s, selected, selectedItems, targets]);

  const chip = (active: boolean) => `btn sm ${active ? "active" : ""}`;
  const { pos, total, colW } = positions;
  const minY = viewport.top - OVERSCAN;
  const maxY = viewport.top + viewport.h + OVERSCAN;

  return (
    <div className={`screen ${s.sideCollapsed ? "chrome-hidden" : ""}`}>
      <TopNav current="browse" />
      <SideToggle />
    <div className="browse">
      <aside className="browse-side panel">
        <input className="input" placeholder="Search name or folder…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <FiltersButton filters={filters} open={filtersOpen} onToggle={() => setFiltersOpen(!filtersOpen)} onClear={() => setF({ ...FILTERS_OFF })} />

        <div className="label">Order</div>
        <div className="chips">
          {(["name", "date", "size", "rating"] as SortSel[]).map((k) => (
            <button
              key={k}
              className={chip(!random && sortBy === k && location !== "recent")}
              onClick={() => setF({ sortBy: k, desc: sortBy === k && !random ? !desc : desc, random: false })}
            >
              {k} {!random && sortBy === k ? (desc ? "↓" : "↑") : ""}
            </button>
          ))}
          <button
            className={chip(random)}
            onClick={() => {
              setF({ random: true });
              setSeed();
            }}
          >
            Random <kbd className="kbd">S</kbd>
          </button>
        </div>

        <div className="label">Layout</div>
        <div className="side-row">
          <div className="chips">
            <button className={chip(layout === "masonry")} onClick={() => setLayout("masonry")} title="Tiles keep their own shape">
              Masonry
            </button>
            <button className={chip(layout === "grid")} onClick={() => setLayout("grid")} title="Uniform 4:3 tiles">
              Grid
            </button>
          </div>
        </div>
        <div className="side-row">
          <input type="range" min={120} max={480} step={20} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title="Tile size" />
        </div>

        <hr className="rule" />
        <button className="btn primary" disabled={!items.length} onClick={() => open(0)}>
          <Play /> Slideshow <kbd className="kbd">⏎</kbd>
        </button>
        <button className="btn sm" onClick={() => void s.surprise()} title="A random item you haven't seen lately">
          <Sparkle /> Surprise me <kbd className="kbd">R</kbd>
        </button>
        <button className="btn sm ghost" onClick={() => setF({ ...DEFAULTS_RESET })} title="The search, the filters and the order as they start">
          <ArrowsClockwise /> Reset all
        </button>
        <Deco kind="mug" className="deco-side" />
      </aside>

      {filtersOpen && <FiltersPanel filters={filters} onClose={() => setFiltersOpen(false)} onClear={() => setF({ ...FILTERS_OFF })} />}
      <ContextMenu at={ctx?.at ?? null} items={ctx?.items ?? []} onClose={() => setCtx(null)} />
      <main className="browse-main">
        {selected.size > 0 ? (
          <div className="browse-head selection-bar">
            <span className="mono accent-text">{selected.size} selected</span>
            <span className="label">Rate</span>
            <span className="chips">
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <button key={n} className="btn sm" onClick={() => rateSelected(n)} title={`Rate all ${n} (key ${n % 10})`}>
                  {n}
                </button>
              ))}
              <button className="btn sm ghost" onClick={() => rateSelected(null)}>
                Clear <kbd className="kbd">U</kbd>
              </button>
            </span>
            <span className="label">Move to</span>
            <span className="chips">
              {targets.map((t) => (
                <button key={t.id} className="btn sm primary" disabled={s.busy} onClick={() => void moveSelected(t.id)}>
                  {t.hotkey && <kbd className="kbd">{t.hotkey}</kbd>}
                  {t.name}
                </button>
              ))}
            </span>
            <Popover
              open={tagMenu}
              onClose={() => setTagMenu(false)}
              width={320}
              trigger={
                <button className="btn sm" onClick={() => setTagMenu(!tagMenu)} title="Tags on the selection">
                  <TagIcon /> Tag…
                </button>
              }
            >
              <div className="pop-title">Tags on {selected.size} selected</div>
              <TagEditor keys={[...selected]} />
            </Popover>
            <Popover
              open={artistMenu}
              onClose={() => setArtistMenu(false)}
              width={280}
              trigger={
                <button className="btn sm" onClick={() => setArtistMenu(!artistMenu)} title="Who made the selection">
                  <PaintBrush /> Artist…
                </button>
              }
            >
              <div className="pop-title">Artist of {selected.size} selected</div>
              <ArtistPicker keys={[...selected]} />
            </Popover>
            <PluginButtons location="browse.selection" context={() => ({ items: selectedItems })} />
            <button className="btn sm" disabled={s.busy} onClick={() => s.openEdit(selectedItems)} title="Edit the selection: rotate, flip, crop, resize, convert (T)">
              <PencilSimple /> Edit
            </button>
            {seriesAction && (
              <button className="btn sm" onClick={seriesAction.run} title={seriesAction.title}>
                <Stack /> {seriesAction.label}
              </button>
            )}
            {hasVersions && (
              <button className="btn sm" disabled={s.busy} onClick={() => void revertAll(selectedItems)} title="Put back the originals kept for the selected pictures that were overwritten; each version goes to the trash">
                <ArrowCounterClockwise /> Revert
              </button>
            )}
            <button className="btn sm danger" disabled={s.busy} onClick={() => void trashSelected()}>
              <Trash /> Trash <kbd className="kbd">⌫</kbd>
            </button>
            <button
              className="btn sm ghost"
              disabled={s.busy}
              title={s.vault?.unlocked ? "Write decrypted copies elsewhere" : "Copy the selection elsewhere"}
              onClick={async () => {
                const dest = await pickFolder("Choose where to write the copies");
                if (!dest || !s.root) return;
                try {
                  const n = await api.vaultExport(s.root, selectedItems.flatMap((i) => i.files), dest);
                  s.toast(`Exported ${n} files`, "ok");
                } catch (e) {
                  s.toast(String(e), "error");
                }
              }}
            >
              Export…
            </button>
            <button className="btn sm ghost" onClick={() => setSelected(new Set(items.map((i) => i.key)))}>
              All <kbd className="kbd">⌘A</kbd>
            </button>
            <button className="btn sm ghost" onClick={() => setSelected(new Set())}>
              None <kbd className="kbd">Esc</kbd>
            </button>
          </div>
        ) : (
          <div className="browse-head">
            <span className="mono dim grow">
              {s.loading ? s.loading : `${items.length} of ${all.length} items · ${formatBytes(totalBytes)}`}
            </span>
            <button className={chip(selectMode)} onClick={() => setSelectMode((m) => !m)} title="Click selects tiles instead of opening them (⌘-click and ⇧-click always select)">
              <Selection /> {selectMode ? "Selecting" : "Select"}
            </button>
          </div>
        )}
        <div className="scroller" ref={scrollerRef} onScroll={onScroll}>
          <div className="masonry" style={{ height: total }}>
            {gridW > 0 &&
              tiles.map(({ item: it, members }, i) => {
                const p = pos[i];
                if (p.y + p.h < minY || p.y > maxY) return null;
                return (
                  <div key={it.primary} className={`mtile ${members.length > 1 ? "stacked" : ""}`} style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: colW }} onContextMenu={(e) => tileMenu(e, it)}>
                    {members.length > 1 && (
                      <span className="tile-stack mono" title={`A series of ${members.length}: opened, all of it in a row`}>
                        <Stack /> {members.length}
                      </span>
                    )}
                    <button
                      className="tile-info"
                      title="Everything known about this file"
                      onClick={(e) => {
                        e.stopPropagation();
                        s.set({ infoItem: it });
                      }}
                    >
                      <Info />
                    </button>
                    <Thumb
                      item={it}
                      eager
                      aspect={p.ratio}
                      onAspect={layout === "masonry" ? onAspect : undefined}
                      rating={ratings[it.key]}
                      label={it.targetId ? targetName[it.targetId] : undefined}
                      selected={members.every((m) => selected.has(m.key))}
                      onClick={(e) => onTileClick(i, e)}
                    />
                  </div>
                );
              })}
          </div>
        </div>
      </main>
    </div>
    </div>
  );
}
