import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from "react";
import { TopNav } from "../components/TopNav";
import { api, pickFolder } from "../lib/api";
import { ArrowsClockwise, PencilSimple, Play, Selection, Sparkle, Trash } from "@phosphor-icons/react";
import { useStore } from "../store";
import { useDupes } from "../dupesStore";
import { Thumb } from "../components/Thumb";
import { FolderPicker } from "../components/FolderPicker";
import { Deco } from "../components/Deco";
import { isTypingTarget } from "../lib/hotkeys";
import { formatBytes, shuffled } from "../lib/format";
import { cacheValid } from "../lib/dupes";
import type { MediaItem } from "../lib/types";

type LocationSel = "all" | "unsorted" | "recent" | "unseen" | string;
type KindSel = "all" | "image" | "raw" | "video";
type SortSel = "name" | "date" | "rating" | "size";
type Layout = "masonry" | "grid";

const GAP = 10;
const DEFAULTS_RESET = { location: "all", kind: "all", folders: null, query: "", sortBy: "name", desc: false, minRating: 0, unratedOnly: false, random: false } as const;
const META_H = 30; // caption row under each tile, must match .thumb-meta
const OVERSCAN = 900;

/**
 * Everything under the opened folder (and any target folders outside it) as one
 * virtualised masonry grid, narrowed down by location, type, folders, rating
 * and name. Album folders are kept out; they have their own screen.
 */
export function Browse() {
  const s = useStore();
  const sigCache = useDupes((d) => d.cache);
  const loadCache = useDupes((d) => d.loadCache);
  const targets = s.library?.targets ?? [];
  const f = s.browseFilters;
  const setF = s.setBrowseFilters;
  const { location, kind, query, sortBy, desc, minRating, unratedOnly, random, zoom, layout } = f;
  const folders = useMemo(() => (f.folders ? new Set(f.folders) : null), [f.folders]);
  const setLocation = (v: LocationSel) => setF({ location: v });
  const setKind = (v: KindSel) => setF({ kind: v });
  const setFolders = (v: Set<string> | null) => setF({ folders: v ? [...v] : null });
  const setQuery = (v: string) => setF({ query: v });
  const setMinRating = (v: number) => setF({ minRating: v });
  const setUnratedOnly = (v: boolean) => setF({ unratedOnly: v });
  const setZoom = (v: number) => setF({ zoom: v });
  const setLayout = (v: Layout) => setF({ layout: v });
  const [seed, setSeed] = useState(0);
  const toggleRandom = () => {
    setF({ random: !useStore.getState().browseFilters.random });
    setSeed((x) => x + 1);
  };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const anchor = useRef<number | null>(null);

  useEffect(() => {
    void s.loadAll();
    void loadCache();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, s.allStale]);

  const all = useMemo(() => s.allItems.filter((i) => !i.albumKey), [s.allItems]);
  const ratings = s.library?.ratings ?? {};
  const viewed = s.viewed;
  const targetName = useMemo(() => Object.fromEntries(targets.map((t) => [t.id, t.name])), [targets]);

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

  const items = useMemo(() => {
    let list: MediaItem[] = all;
    if (location === "unsorted") list = list.filter((i) => !i.targetId);
    else if (location === "recent") list = list.filter((i) => viewed[i.key]);
    else if (location === "unseen") list = list.filter((i) => !viewed[i.key]);
    else if (location !== "all") list = list.filter((i) => i.targetId === location);
    if (kind !== "all") list = list.filter((i) => i.kind === kind);
    if (folders) list = list.filter((i) => folders.has(i.dir));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((i) => i.name.toLowerCase().includes(q) || i.dir.toLowerCase().includes(q));
    }
    if (unratedOnly) list = list.filter((i) => ratings[i.key] == null);
    else if (minRating > 0) list = list.filter((i) => (ratings[i.key] ?? 0) >= minRating);
    if (random) return shuffled(list);
    if (location === "recent") return list.slice().sort((a, b) => (viewed[b.key] ?? 0) - (viewed[a.key] ?? 0));
    const cmp: Record<SortSel, (a: MediaItem, b: MediaItem) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      date: (a, b) => a.modified - b.modified,
      size: (a, b) => a.size - b.size,
      rating: (a, b) => (ratings[a.key] ?? 0) - (ratings[b.key] ?? 0) || a.name.localeCompare(b.name),
    };
    const out = list.slice().sort(cmp[sortBy]);
    return desc ? out.reverse() : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, location, kind, folders, query, ratings, viewed, minRating, unratedOnly, random, seed, sortBy, desc]);

  // Drop selections that are no longer in the list (moved, trashed, filtered out).
  useEffect(() => {
    if (selected.size === 0) return;
    const keys = new Set(items.map((i) => i.key));
    const next = new Set([...selected].filter((k) => keys.has(k)));
    if (next.size !== selected.size) setSelected(next);
  }, [items, selected]);

  const totalBytes = useMemo(() => items.reduce((a, i) => a + i.size, 0), [items]);
  const scannedCount = useMemo(() => items.filter((i) => cacheValid(sigCache[i.key], i) && !sigCache[i.key].error).length, [items, sigCache]);

  /* ---------- layout ---------- */
  const aspects = useRef(new Map<string, number>());
  const [aspectVersion, bumpAspects] = useReducer((x: number) => x + 1, 0);
  const aspectRaf = useRef(0);
  const onAspect = useCallback((key: string, ratio: number) => {
    if (Math.abs((aspects.current.get(key) ?? 0) - ratio) < 0.01) return;
    aspects.current.set(key, ratio);
    if (!aspectRaf.current) aspectRaf.current = requestAnimationFrame(() => {
      aspectRaf.current = 0;
      bumpAspects();
    });
  }, []);

  const scrollerRef = useRef<HTMLDivElement>(null);
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
    const pos = items.map((it) => {
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
  }, [items, gridW, zoom, layout, aspectVersion]);

  /* ---------- selection ---------- */
  const open = (i: number) => s.openViewer(items, i, { kind: "browse" });
  const toggle = (key: string) =>
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const onTileClick = (i: number, e: MouseEvent) => {
    const key = items[i].key;
    if (e.shiftKey && anchor.current != null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      setSelected((sel) => {
        const next = new Set(sel);
        for (let k = a; k <= b; k++) next.add(items[k].key);
        return next;
      });
      return;
    }
    if (e.metaKey || e.ctrlKey || selectMode || selected.size > 0) {
      toggle(key);
      anchor.current = i;
      return;
    }
    anchor.current = i;
    open(i);
  };
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.key)), [items, selected]);
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
      if (isTypingTarget(e.target)) return;
      if (s.settingsOpen || s.trashOpen || s.driveOpen || s.backupOpen || s.vaultOpen) return;
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
      if (key === "h") s.toggleNav();
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
    <div className={`screen ${s.navCollapsed ? "chrome-hidden" : ""}`}>
      <TopNav current="browse" />
    <div className="browse">
      <aside className="browse-side panel">
        <input className="input" placeholder="Search name or folder…" value={query} onChange={(e) => setQuery(e.target.value)} />

        <div className="label">Location</div>
        <div className="side-list">
          <button className={chip(location === "all")} onClick={() => setLocation("all")}>
            Everything <span className="faint mono">{counts.all}</span>
          </button>
          <button className={chip(location === "unsorted")} onClick={() => setLocation("unsorted")}>
            Unsorted <span className="faint mono">{counts.unsorted}</span>
          </button>
          {targets.map((t) => (
            <button key={t.id} className={chip(location === t.id)} onClick={() => setLocation(t.id)}>
              {t.name} <span className="faint mono">{counts[t.id] ?? 0}</span>
            </button>
          ))}
          <button className={chip(location === "recent")} onClick={() => setLocation("recent")} title="What you looked at, newest first">
            Recently viewed <span className="faint mono">{counts.recent}</span>
          </button>
          <button className={chip(location === "unseen")} onClick={() => setLocation("unseen")} title="Never opened in the viewer">
            Never viewed <span className="faint mono">{counts.unseen}</span>
          </button>
        </div>

        <div className="label">Folders</div>
        <FolderPicker items={all} selected={folders} onChange={setFolders} />

        <div className="label">Type</div>
        <div className="chips">
          {(["all", "image", "raw", "video"] as KindSel[]).map((k) => (
            <button key={k} className={chip(kind === k)} onClick={() => setKind(k)}>
              {k === "all" ? "All" : k === "image" ? "Photos" : k === "raw" ? "RAW" : "Videos"}
            </button>
          ))}
        </div>

        <div className="label">Rating</div>
        <div className="side-row">
          <input type="range" min={0} max={10} value={minRating} onChange={(e) => setMinRating(Number(e.target.value))} disabled={unratedOnly} />
          <span className="mono">{unratedOnly ? "—" : minRating === 0 ? "any" : `≥ ${minRating}`}</span>
        </div>
        <label className="side-row check">
          <input type="checkbox" checked={unratedOnly} onChange={(e) => setUnratedOnly(e.target.checked)} /> Unrated only
        </label>

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
              setSeed((x) => x + 1);
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
        <button className="btn sm ghost" onClick={() => setF({ ...DEFAULTS_RESET })} title="Reset all filters">
          <ArrowsClockwise /> Reset filters
        </button>
        <Deco kind="mug" className="deco-side" />
      </aside>

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
            <button className="btn sm" disabled={s.busy} onClick={() => s.openEdit(selectedItems)} title="Edit the selection: rotate, flip, crop, resize, convert (T)">
              <PencilSimple /> Edit
            </button>
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
              {scannedCount > 0 && <span className="faint"> · {scannedCount} fingerprinted ✓</span>}
            </span>
            <button className={chip(selectMode)} onClick={() => setSelectMode((m) => !m)} title="Click selects tiles instead of opening them (⌘-click and ⇧-click always select)">
              <Selection /> {selectMode ? "Selecting" : "Select"}
            </button>
          </div>
        )}
        <div className="scroller" ref={scrollerRef} onScroll={onScroll}>
          <div className="masonry" style={{ height: total }}>
            {gridW > 0 &&
              items.map((it, i) => {
                const p = pos[i];
                if (p.y + p.h < minY || p.y > maxY) return null;
                return (
                  <div key={it.primary} className="mtile" style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: colW }}>
                    <Thumb
                      item={it}
                      eager
                      aspect={p.ratio}
                      onAspect={layout === "masonry" ? onAspect : undefined}
                      rating={ratings[it.key]}
                      label={it.targetId ? targetName[it.targetId] : undefined}
                      scanned={cacheValid(sigCache[it.key], it) && !sigCache[it.key].error}
                      selected={selected.has(it.key)}
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
