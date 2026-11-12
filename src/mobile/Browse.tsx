import { useEffect, useMemo, useReducer, useRef, useState, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowCounterClockwise, FolderOpen, Info, MagnifyingGlass, PaintBrush, Selection, SlidersHorizontal, Sparkle, Stack, Star, Tag as TagIcon, Trash, X } from "@phosphor-icons/react";
import { ArtistPicker } from "../components/ArtistPicker";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { FiltersButton, FiltersPanel } from "../components/Filters";
import { Modal } from "../components/Modal";
import { SimilarBar } from "../components/SimilarBar";
import { TagEditor } from "../components/TagPicker";
import { Thumb } from "../components/Thumb";
import { useScrollMemory } from "../lib/scrollMemory";
import { HOME_DEVICE } from "../lib/platform";
import { tileShapes } from "../lib/tileShapes";
import type { MediaItem } from "../lib/types";
import { FILTERS_OFF, useBrowseItems, type SortSel } from "../screens/browseItems";
import { seriesActionFor } from "../seriesStore";
import { showSimilar } from "../similarStore";
import { useStore } from "../store";
import { useTags } from "../tagsStore";
import { revertAll, useVersions } from "../versionsStore";
import { TILE_COLS_DEFAULT, TILE_COLS_KEY, useColumns } from "./columns";
import { MobileTop } from "./TopBar";

const GAP = 3;
/** Pixels of grid kept ready past the screen each way. */
const OVERSCAN = 700;
const COLS_CHOICES = HOME_DEVICE === "tablet" ? [3, 4, 5, 6, 8] : [2, 3, 4, 5];

type Sheet = "view" | "rate" | "move" | "tags" | "artist";

/** Everything in the library as a grid to thumb through, narrowed by the same filters as on a computer. */
export function MobileBrowse() {
  const s = useStore(useShallow((x) => ({ busy: x.busy, browseFilters: x.browseFilters, library: x.library, loadAll: x.loadAll, allStale: x.allStale, loading: x.loading, moveItem: x.moveItem, openViewer: x.openViewer, root: x.root, set: x.set, setBrowseFilters: x.setBrowseFilters, setRating: x.setRating, toast: x.toast, trashItem: x.trashItem })));
  const { all, items, tiles, filters, similar, seedKey, seedItem, seriesOf, ratings, targetName } = useBrowseItems();
  const targets = s.library?.targets ?? [];
  const f = s.browseFilters;
  const setF = s.setBrowseFilters;
  const { query, sortBy, desc, random, layout } = f;
  const [searching, setSearching] = useState(!!query);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cols, setCols] = useColumns(TILE_COLS_KEY, TILE_COLS_DEFAULT);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  // What a menu or the selection bar acts on: the keys of pictures, for the tag and artist sheets.
  const [forKeys, setForKeys] = useState<string[]>([]);

  useEffect(() => {
    void useTags.getState().load();
    void useVersions.getState().load();
  }, [s.root]);
  useEffect(() => void s.loadAll(), [s.root, s.allStale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop what is no longer listed (moved, trashed, filtered out) from the selection.
  useEffect(() => {
    if (!selected.size) return;
    const keys = new Set(items.map((i) => i.key));
    const next = new Set([...selected].filter((k) => keys.has(k)));
    if (next.size !== selected.size) setSelected(next);
  }, [items, selected]);

  /* ---------- layout ---------- */
  const aspects = useMemo(() => ({ current: tileShapes(s.root) }), [s.root]);
  const [aspectVersion, bumpAspects] = useReducer((x: number) => x + 1, 0);
  const aspectRaf = useRef(0);
  const onAspect = (key: string, ratio: number) => {
    if (Math.abs((aspects.current.get(key) ?? 0) - ratio) < 0.01) return;
    aspects.current.set(key, ratio);
    if (!aspectRaf.current)
      aspectRaf.current = requestAnimationFrame(() => {
        aspectRaf.current = 0;
        bumpAspects();
      });
  };
  const scrollerRef = useRef<HTMLDivElement>(null);
  useScrollMemory(`m-browse:${f.location}:${f.kind}:${query}:${sortBy}:${desc}:${random}:${f.minRating}:${f.unratedOnly}:${seedKey ?? ""}`, scrollerRef, !similar?.looking);
  const [gridW, setGridW] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, h: 0 });
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      setGridW(el.clientWidth);
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
  const { pos, total, colW } = useMemo(() => {
    const colW = (gridW - GAP * (cols - 1)) / cols;
    const heights = new Array<number>(cols).fill(0);
    const pos = tiles.map(({ item }) => {
      const ratio = layout === "grid" ? 1 : (aspects.current.get(item.key) ?? 4 / 3);
      const h = colW / ratio;
      let c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c] - 0.5) c = k;
      const y = heights[c];
      heights[c] = y + h + GAP;
      return { x: c * (colW + GAP), y, h, ratio };
    });
    return { pos, total: Math.max(0, ...heights), colW };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, gridW, cols, layout, aspectVersion, aspects]);
  const minY = viewport.top - OVERSCAN;
  const maxY = viewport.top + viewport.h + OVERSCAN;

  /* ---------- acting ---------- */
  const open = (i: number) => {
    const queue = tiles.flatMap((t) => t.members);
    s.openViewer(queue, Math.max(0, queue.indexOf(tiles[i].item)), { kind: "browse" });
  };
  const toggle = (i: number) =>
    setSelected((sel) => {
      const keys = tiles[i].members.map((m) => m.key);
      const next = new Set(sel);
      const on = !keys.every((k) => next.has(k));
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const onTile = (i: number) => (selecting ? toggle(i) : open(i));
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.key)), [items, selected]);
  const seriesAction = useMemo(() => seriesActionFor(selectedItems, seriesOf), [selectedItems, seriesOf]);
  const hasVersions = useVersions((v) => Object.keys(v.links).length > 0);
  const moveAll = async (list: MediaItem[], targetId: string) => {
    stopSelecting();
    setSheet(null);
    for (const it of list) await s.moveItem(it, targetId);
  };
  const trashAll = async (list: MediaItem[]) => {
    stopSelecting();
    for (const it of list) await s.trashItem(it);
  };
  const rateAll = (r: number | null) => {
    for (const it of selectedItems) s.setRating(it, r);
    s.toast(r == null ? `Cleared ${selectedItems.length} ratings` : `Rated ${selectedItems.length} items ${r}`, "ok");
    setSheet(null);
  };
  const askFor = (keys: string[], what: "tags" | "artist") => {
    setForKeys(keys);
    setSheet(what);
  };
  const tileMenu = (e: MouseEvent, it: MediaItem, i: number) => {
    e.preventDefault();
    const keys = tiles[i].members.map((m) => m.key);
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: <><Selection /> Select</>, onClick: () => (setSelecting(true), toggle(i)) },
        { label: <><Info /> Info</>, onClick: () => s.set({ infoItem: it }) },
        { label: <><Sparkle /> Show similar</>, onClick: () => showSimilar(it) },
        { label: <><TagIcon /> Tags</>, onClick: () => askFor(keys, "tags") },
        { label: <><PaintBrush /> Artist</>, onClick: () => askFor(keys, "artist") },
        { separator: true },
        ...targets.map((t) => ({ label: <>Move to {t.name}</>, onClick: () => void moveAll(tiles[i].members, t.id) })),
        { separator: true },
        { label: <><Trash /> Trash</>, danger: true, onClick: () => void trashAll(tiles[i].members) },
      ],
    });
  };
  const chip = (on: boolean) => `btn sm ${on ? "active" : ""}`;

  return (
    <div className="m-browse">
      <MobileTop current="browse">
        <button className={`m-icon ${searching ? "on" : ""}`} aria-label="Search" onClick={() => (searching && query ? setF({ query: "" }) : undefined, setSearching(!searching))}>
          <MagnifyingGlass />
        </button>
        <button className="m-icon" aria-label="Order and layout" onClick={() => setSheet("view")}>
          <SlidersHorizontal />
        </button>
        <button className={`m-icon ${selecting ? "on" : ""}`} aria-label="Select" onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
          <Selection />
        </button>
      </MobileTop>
      {searching && (
        <div className="m-search">
          <input className="input" autoFocus type="search" autoCorrect="off" autoCapitalize="off" spellCheck={false} placeholder="Search name, folder or tag" value={query} onChange={(e) => setF({ query: e.target.value })} />
        </div>
      )}
      <div className="m-filters-row">
        <FiltersButton filters={filters} open={filtersOpen} onToggle={() => setFiltersOpen(!filtersOpen)} onClear={() => setF({ ...FILTERS_OFF })} />
        <span className="mono faint small m-count-all">{s.loading ?? `${items.length} of ${all.length}`}</span>
      </div>
      {similar && <SimilarBar seed={seedItem} alike={items[0]?.key === seedKey ? items.length - 1 : items.length} looking={similar.looking} />}
      {filtersOpen && <FiltersPanel filters={filters} onClose={() => setFiltersOpen(false)} onClear={() => setF({ ...FILTERS_OFF })} />}
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />

      <div className="scroller m-scroller" ref={scrollerRef} onScroll={onScroll}>
        <div className="masonry" style={{ height: total }}>
          {gridW > 0 &&
            tiles.map(({ item: it, members }, i) => {
              const p = pos[i];
              if (p.y + p.h < minY || p.y > maxY) return null;
              return (
                <div key={it.primary} className={`mtile ${members.length > 1 ? "stacked" : ""}`} style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: colW }} onContextMenu={(e) => tileMenu(e, it, i)}>
                  {members.length > 1 && (
                    <span className="tile-stack mono">
                      <Stack /> {members.length}
                    </span>
                  )}
                  <Thumb item={it} eager aspect={p.ratio} onAspect={layout === "masonry" ? onAspect : undefined} rating={ratings[it.key]} label={it.targetId ? targetName[it.targetId] : undefined} selected={members.every((m) => selected.has(m.key))} onClick={() => onTile(i)} />
                </div>
              );
            })}
        </div>
        {!items.length && !s.loading && <div className="m-empty"><p className="dim">Nothing matches these filters.</p></div>}
      </div>

      {selecting && (
        <div className="m-selection">
          <span className="mono accent-text">{selected.size}</span>
          <span className="grow" />
          <button className="m-icon" aria-label="Rate" disabled={!selected.size} onClick={() => setSheet("rate")}>
            <Star />
          </button>
          <button className="m-icon" aria-label="Move" disabled={!selected.size || !targets.length} onClick={() => setSheet("move")}>
            <FolderOpen />
          </button>
          <button className="m-icon" aria-label="Tags" disabled={!selected.size} onClick={() => askFor([...selected], "tags")}>
            <TagIcon />
          </button>
          <button className="m-icon" aria-label="Artist" disabled={!selected.size} onClick={() => askFor([...selected], "artist")}>
            <PaintBrush />
          </button>
          {seriesAction && (
            <button className="m-icon" aria-label={seriesAction.label} onClick={seriesAction.run}>
              <Stack />
            </button>
          )}
          {hasVersions && (
            <button className="m-icon" aria-label="Revert" disabled={!selected.size || s.busy} onClick={() => void revertAll(selectedItems)}>
              <ArrowCounterClockwise />
            </button>
          )}
          <button className="m-icon danger" aria-label="Trash" disabled={!selected.size || s.busy} onClick={() => void trashAll(selectedItems)}>
            <Trash />
          </button>
          <button className="m-icon" aria-label="Done selecting" onClick={stopSelecting}>
            <X />
          </button>
        </div>
      )}

      {sheet === "view" && (
        <Modal title="Order and layout" onClose={() => setSheet(null)}>
          <div className="label">Order</div>
          <div className="chips">
            {(["name", "date", "size", "rating"] as SortSel[]).map((k) => (
              <button key={k} disabled={!!similar} className={chip(!similar && !random && sortBy === k)} onClick={() => setF({ sortBy: k, desc: sortBy === k && !random ? !desc : desc, random: false })}>
                {k} {!random && sortBy === k ? (desc ? "↓" : "↑") : ""}
              </button>
            ))}
            <button
              disabled={!!similar}
              className={chip(!similar && random)}
              onClick={() => {
                setF({ random: true });
                useStore.getState().reshuffleBrowse();
              }}
            >
              Random
            </button>
          </div>
          <div className="label">Layout</div>
          <div className="chips">
            <button className={chip(layout === "masonry")} onClick={() => setF({ layout: "masonry" })}>
              Masonry
            </button>
            <button className={chip(layout === "grid")} onClick={() => setF({ layout: "grid" })}>
              Grid
            </button>
          </div>
          <div className="label">Across</div>
          <div className="chips">
            {COLS_CHOICES.map((n) => (
              <button key={n} className={chip(cols === n)} onClick={() => setCols(n)}>
                {n}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {sheet === "rate" && (
        <Modal title={`Rate ${selected.size}`} onClose={() => setSheet(null)}>
          <div className="chips m-rate-all">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <button key={n} className="btn" onClick={() => rateAll(n)}>
                {n}
              </button>
            ))}
          </div>
          <button className="btn ghost" onClick={() => rateAll(null)}>
            Clear ratings
          </button>
        </Modal>
      )}
      {sheet === "move" && (
        <Modal title={`Move ${selected.size} to`} onClose={() => setSheet(null)}>
          <div className="m-list">
            {targets.map((t) => (
              <button key={t.id} className="btn" disabled={s.busy} onClick={() => void moveAll(selectedItems, t.id)}>
                {t.name}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {sheet === "tags" && (
        <Modal title="Tags" onClose={() => setSheet(null)}>
          <TagEditor keys={forKeys} />
        </Modal>
      )}
      {sheet === "artist" && (
        <Modal title="Artist" onClose={() => setSheet(null)}>
          <ArtistPicker keys={forKeys} />
        </Modal>
      )}
    </div>
  );
}
