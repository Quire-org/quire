import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, ArrowRight, Copy, HardDrive, Play, Plus, PushPin, PuzzlePiece, Tray } from "@phosphor-icons/react";
import { albumPages, useStore } from "../store";
import { api, canThumb, mediaUrl, thumbUrl } from "../lib/api";
import { formatAgo, formatBytes } from "../lib/format";
import type { Album, DriveInfo, MediaItem } from "../lib/types";
import { usePeople } from "../peopleStore";
import { useDupes } from "../dupesStore";
import { BASKET, showWork, useFind, useFindImage, type BasketItem } from "../findStore";
import { usePlugins } from "../plugins/store";
import { sendEvent } from "../plugins/host";
import { PluginIcon } from "../components/PluginButtons";
import type { SharedItem } from "../plugins/types";
import { FitButtons, type FitItem } from "./fit";
import { mayGoOnline, useOnline } from "../lib/online";
import { PlatformRows, type RowGroup } from "./rows";
import { useFinders } from "../plugins/find";
import { suggestionsFor, useArtists } from "../artistsStore";
import { nameOf, useTags } from "../tagsStore";
import { lookAlikes, pairKey, seriesIndex } from "../lib/series";
import { useCoverUrl } from "../scrapbook/pictures";
import { useScrapbook } from "../scrapbook/store";
import { openBoardWindow } from "../scrapbook/boardWindow";
import { pageOf, type ScrapDoc } from "../scrapbook/model";
import { askNewBoard } from "../components/NewBoard";
import { useActivity } from "../lib/activity";
import { JobRow } from "../components/Activity";
import { PlatformIcon } from "../components/PlatformIcon";
import { SCREENS } from "../components/TopNav";
import { filterPictures, useFilterData, type PictureFilter } from "../components/PictureFilters";
import { FaceCrop } from "../screens/People";
import { DEFAULT_SHORTCUTS, KINDS, RANDOM_BOARD, SHORTCUT_SCREENS, boardStrip, canMosaic, justify, nearestDay, onThisDay, pickStable, shownOnHome, today, type Block, type BlockType } from "./board";
import { themes } from "../themes";
import { ModePicker, ThemeSwatch } from "../components/ThemeSwatch";
import { useHome } from "./store";

/* ---------- what every block shares ---------- */

/** The library's pictures by key, album pages too. */
let itemsMap: { all: MediaItem[]; map: Map<string, MediaItem> } | null = null;
function useItemMap(): Map<string, MediaItem> {
  const all = useStore((s) => s.allItems);
  if (itemsMap?.all !== all) itemsMap = { all, map: new Map(all.map((i) => [i.key, i])) };
  return itemsMap.map;
}

/** The pictures the Home may show: stills (videos and the trash left out), in the folders its filter allows. */
export function usePool(): MediaItem[] {
  const all = useStore((s) => s.allItems);
  const trash = useStore((s) => s.library?.trashDir);
  const folders = useHome((h) => h.doc?.folders);
  return useMemo(() => {
    const t = trash ? `${trash.replace(/\/+$/, "")}/` : null;
    return all.filter((i) => (i.kind === "image" || i.kind === "raw") && (!t || !i.key.startsWith(t)) && (!folders || shownOnHome(i.key, folders)));
  }, [all, trash, folders]);
}

/**
 * A block's pictures, narrowed by its filters as Browse narrows them (album pages left out, as there),
 * or one album's pages; `defaults` fills in what the block's own filters don't say.
 */
function useFiltered(block: Block, defaults: Partial<PictureFilter> = {}): MediaItem[] {
  const pool = usePool();
  const filter = block.filter;
  const data = useFilterData({ ...defaults, ...filter });
  const wants = !!(filter?.tags?.length || filter?.tagsOut?.length || filter?.tagged || filter?.query);
  useEffect(() => {
    // What its filters read, read once they ask for it.
    if (wants) void useTags.getState().load();
    if (filter?.people?.length) void usePeople.getState().load();
    if (filter?.artists?.length) void useArtists.getState().load();
  }, [wants, filter?.people?.length, filter?.artists?.length]);
  return useMemo(() => {
    const album = filter?.album;
    const base = album ? pool.filter((i) => i.albumKey === album) : pool.filter((i) => !i.albumKey);
    return filterPictures(base, { ...defaults, ...filter }, data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, filter, data, JSON.stringify(defaults)]);
}

/** How a block's body measures, to fit its pictures to it. */
function useBox<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box];
}

const GAP = 4;
/** As many rows as tiles of about `side` fit (`maxRows` at most), and as many columns as keep them square-ish. */
function fit(box: { w: number; h: number }, side = 150, maxRows = Infinity): { cols: number; rows: number } {
  if (!box.w || !box.h) return { cols: 1, rows: 1 };
  const rows = Math.max(1, Math.min(maxRows, Math.round(box.h / side)));
  const s = (box.h - (rows - 1) * GAP) / rows;
  return { cols: Math.max(1, Math.round((box.w + GAP) / (s + GAP))), rows };
}

const open = (list: MediaItem[], at: MediaItem) => useStore.getState().openViewer(list, Math.max(0, list.indexOf(at)), { kind: "browse" });

/** One picture, filling its cell; opens the viewer over its block's pictures. */
function Pic({ item, list, label }: { item: MediaItem; list: MediaItem[]; label?: string }) {
  const root = useStore((s) => s.root);
  const src = root && canThumb(item) ? thumbUrl(root, item, 280) : mediaUrl(item);
  return (
    <button className="home-pic" onClick={() => open(list, item)} title={item.name}>
      <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
      {label && <span className="home-pic-label mono">{label}</span>}
    </button>
  );
}

/** The block being drawn, for what its pictures need to know of it (a mosaic, its size). */
export const BlockCtx = createContext<Block | null>(null);

/** Pictures' shapes (width over height), learnt from their thumbnails once, for the mosaics. */
const shapes = new Map<string, number>();
let shapesFor: string | null = null;
function useShapes(items: MediaItem[]): number {
  const root = useStore((s) => s.root);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    // Another library's pictures: its own shapes.
    if (shapesFor !== root) {
      shapes.clear();
      shapesFor = root;
    }
    let live = true;
    for (const it of items) {
      // Keyed with the picture's time too: one edited (cropped) gets measured again.
      const k = `${it.key}@${it.modified}`;
      if (shapes.has(k)) continue;
      const img = new Image();
      const done = (a: number) => {
        shapes.set(k, a);
        if (live) setVersion((v) => v + 1);
      };
      img.onload = () => done(img.naturalWidth / Math.max(1, img.naturalHeight));
      img.onerror = () => done(4 / 3);
      img.src = root && canThumb(it) ? thumbUrl(root, it, 280) : mediaUrl(it);
    }
    return () => {
      live = false;
    };
  }, [items, root]);
  return version;
}

/** The most a mosaic waits for its pictures' shapes before laying out with those it has. */
const SHAPES_WAIT_MS = 1200;

/**
 * As many of `items` as fit the space left in the block: a grid of near-square tiles, or, in a block
 * set to Mosaic and big enough, a mosaic of rows that keep each picture's shape (the grid when they
 * wouldn't fill the block without trimming too much). A mosaic is laid out once, when the shapes of
 * the pictures it can hold are known (or after a moment, with those that are): until then it shows
 * nothing, rather than shuffling as each shape comes in.
 */
function Pics({ items, labelOf, side }: { items: MediaItem[]; labelOf?: (i: MediaItem) => string | undefined; side?: number }) {
  const block = useContext(BlockCtx);
  const mosaic = !!block && block.layout === "mosaic" && canMosaic(block);
  const [ref, box] = useBox<HTMLDivElement>();
  const pool = useMemo(() => (mosaic ? items.slice(0, 60) : []), [mosaic, items]);
  const version = useShapes(pool);
  const shapeOf = (i: MediaItem) => shapes.get(`${i.key}@${i.modified}`);
  // The pictures a mosaic of this size can hold (rows at least 100 px high, most of them wider than
  // tall), a few more to choose from: their shapes are what it waits for.
  const holds = Math.min(pool.length, Math.ceil((box.w * box.h) / (100 * 120)) + 4);
  const allKnown = pool.slice(0, holds).every((i) => shapeOf(i) !== undefined);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const t = setTimeout(() => setWaited(true), SHAPES_WAIT_MS);
    return () => clearTimeout(t);
  }, [pool]);
  const settled = allKnown || waited;
  const tiles = useMemo(() => {
    if (!mosaic || !settled) return null;
    const known = pool.filter((i) => shapeOf(i) !== undefined);
    return justify(known.map((i) => ({ key: i.key, a: shapeOf(i)! })), box.w, box.h, block?.maxRows);
    // Laid out once it settles (and again if the block's size changes), not as each later shape comes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mosaic, settled, pool, box.w, box.h, block?.maxRows]);
  void version;
  if (mosaic && !settled) return <div ref={ref} className="home-pics home-mosaic" aria-busy="true" />;
  if (tiles) {
    const byKey = new Map(items.map((i) => [i.key, i]));
    return (
      <div ref={ref} className="home-pics home-mosaic">
        {tiles.map((t) => (
          <div key={t.key} className="home-mosaic-tile" style={{ left: t.x, top: t.y, width: t.w, height: t.h }}>
            <Pic item={byKey.get(t.key)!} list={items} label={labelOf?.(byKey.get(t.key)!)} />
          </div>
        ))}
      </div>
    );
  }
  const { cols, rows: room } = fit(box, side, block?.maxRows);
  // Fewer pictures than cells: as many rows as they fill, each taller, so no empty rows are left.
  const rows = Math.max(1, Math.min(room, Math.ceil(items.length / cols)));
  const shown = items.slice(0, cols * rows);
  return (
    <div ref={ref} className="home-pics" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
      {shown.map((i) => (
        <Pic key={i.key} item={i} list={items} label={labelOf?.(i)} />
      ))}
    </div>
  );
}

/** A way forward from a block with nothing in it. */
function Go({ label, to }: { label: string; to: () => void }) {
  return (
    <button className="btn sm" onClick={to} title={label}>
      <span className="ellipsis">{label}</span> <ArrowRight />
    </button>
  );
}

const NoPictures = () => <Quiet action={<Go label="Import" to={() => useStore.getState().set({ importOpen: {} })} />}>No pictures here yet.</Quiet>;

/** Nothing to show, said plainly, with what to do about it. */
function Quiet({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="home-quiet">
      <span className="dim small home-quiet-text">{children}</span>
      {action}
    </div>
  );
}

/** A number as large as the block lets it be, with what it counts. */
function Big({ n, what }: { n: number; what: React.ReactNode }) {
  return (
    <div className="home-big">
      <b>{n.toLocaleString("en-GB")}</b> <span>{what}</span>
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/* ---------- work waiting ---------- */

function SortBlock() {
  // Arranging, Done is the one act-here: the block's own button goes plain.
  const arranging = useHome((h) => h.arranging);
  const unsorted = useStore((s) => s.unsorted);
  const targets = useStore((s) => s.library?.targets.length ?? 0);
  const newest = useMemo(() => [...unsorted].sort((a, b) => b.modified - a.modified), [unsorted]);
  const clips = unsorted.filter((i) => i.kind === "video").length;
  if (!unsorted.length) return <Quiet action={<Go label="Import" to={() => useStore.getState().set({ importOpen: {} })} />}>Everything is sorted.</Quiet>;
  const stills = newest.filter((i) => i.kind !== "video");
  return (
    <>
      <div className="home-sort-head">
        <Big n={unsorted.length - clips} what={<>{unsorted.length - clips === 1 ? "picture" : "pictures"}{clips ? ` and ${plural(clips, "clip")}` : ""}</>} />
        {targets ? (
          <button className={`btn ${arranging ? "" : "primary"}`} onClick={() => useStore.getState().openSortQueue()} title="Sort them (⏎)">
            Sort <kbd className="kbd">⏎</kbd>
          </button>
        ) : (
          <button className={`btn ${arranging ? "" : "primary"}`} onClick={() => useStore.getState().set({ settingsOpen: true })} title="Where pictures go when you press their key (⏎)">
            Set up target folders <kbd className="kbd">⏎</kbd>
          </button>
        )}
      </div>
      <Pics items={stills} side={170} />
    </>
  );
}

function ImportBlock() {
  return (
    <Quiet
      action={
        <button className="btn" onClick={() => useStore.getState().set({ importOpen: {} })}>
          <Tray /> Import…
        </button>
      }
    >
      From a card, a phone or a folder: into a bucket or as an album, duplicates checked first.
    </Quiet>
  );
}

function usePeopleLoaded() {
  const root = useStore((s) => s.root);
  useEffect(() => void usePeople.getState().load(), [root]);
}

function WhoBlock() {
  usePeopleLoaded();
  const groups = usePeople((p) => p.sorted?.groups);
  const byId = usePeople((p) => p.byId);
  const [ref, box] = useBox<HTMLDivElement>();
  if (!groups) return <Quiet>Looking at the faces…</Quiet>;
  if (!groups.length) return <Quiet action={<Go label="People" to={() => useStore.getState().openPeople()} />}>Everyone found has a name.</Quiet>;
  const side = Math.max(40, Math.min(96, box.h - 34));
  const fits = Math.max(1, Math.floor((box.w + 8) / (side + 8)));
  return (
    <div ref={ref} className="home-faces">
      <div className="home-face-row">
        {groups.slice(0, fits).map((g) => {
          const f = byId.get(g.faces[0]);
          return f ? (
            <button key={g.faces[0]} className="home-face" onClick={() => useStore.getState().openPeople()} title={`${g.faces.length} faces alike: who is it?`}>
              <FaceCrop face={f} size={side} className="round" />
              <span className="mono small">{g.faces.length}</span>
            </button>
          ) : null;
        })}
      </div>
      <span className="dim small">{plural(groups.length, "group")} of faces waiting for a name</span>
    </div>
  );
}

function FacesBlock() {
  usePeopleLoaded();
  const sorted = usePeople((p) => p.sorted);
  const doc = usePeople((p) => p.doc);
  const byId = usePeople((p) => p.byId);
  const open = useMemo(() => (sorted?.matches ?? []).filter((m) => doc?.people[m.person] && !doc.faces[String(m.face)] && !doc.no.includes(m.face) && !doc.not[String(m.face)]?.includes(m.person)), [sorted, doc]);
  const doubts = (sorted?.doubts ?? []).filter((d) => doc?.faces[String(d.face)]?.p === d.person && !doc.faces[String(d.face)]?.ok).length;
  const [ref, box] = useBox<HTMLDivElement>();
  if (!sorted) return <Quiet>Looking at the faces…</Quiet>;
  if (!open.length && !doubts) return <Quiet action={<Go label="People" to={() => useStore.getState().openPeople()} />}>Nothing to check.</Quiet>;
  const fits = Math.max(1, Math.floor((box.w + 8) / 56));
  return (
    <div ref={ref} className="home-faces">
      <div className="home-face-row">
        {open.slice(0, fits).map((m) => {
          const f = byId.get(m.face);
          return f ? (
            <button key={m.face} className="home-face" onClick={() => useStore.getState().openPeople()} title={`Looks like ${doc?.people[m.person]?.name}`}>
              <FaceCrop face={f} size={48} className="round" />
            </button>
          ) : null;
        })}
      </div>
      <span className="dim small">
        {open.length ? `${plural(open.length, "face")} look like someone you named` : ""}
        {open.length && doubts ? " · " : ""}
        {doubts ? `${doubts} given someone to check` : ""}
      </span>
    </div>
  );
}

function DupesBlock() {
  const root = useStore((s) => s.root);
  const matched = useDupes((d) => d.matched);
  const items = useItemMap();
  useEffect(() => void useDupes.getState().loadCache(), [root]);
  const groups = matched?.groups ?? [];
  if (!matched)
    return (
      <Quiet
        action={
          <button className="btn" onClick={() => useStore.getState().openDupes()}>
            <Copy /> Find duplicates
          </button>
        }
      >
        No duplicate check has run yet.
      </Quiet>
    );
  if (!groups.length) return <Quiet action={<Go label="Check again" to={() => useStore.getState().openDupes()} />}>No duplicates in the last check.</Quiet>;
  const first = groups[0].members.map((m) => items.get(m.key)).filter((i): i is MediaItem => !!i && i.kind !== "video");
  return (
    <>
      <Big n={groups.length} what={groups.length === 1 ? "group" : "groups"} />
      {first.length > 0 && <Pics items={first} side={120} />}
    </>
  );
}

function SeriesBlock() {
  const root = useStore((s) => s.root);
  const unsorted = useStore((s) => s.unsorted);
  const library = useStore((s) => s.library);
  const cache = useDupes((d) => d.cache);
  useEffect(() => void useDupes.getState().loadCache(), [root]);
  // Among the first few hundred waiting (the look is pairwise): groups of look-alikes not decided on.
  const groups = useMemo(() => {
    const stills = unsorted.filter((i) => i.kind !== "video").slice(0, 300);
    const keys = stills.map((i) => i.key);
    const inSeries = seriesIndex(library?.series);
    const not = new Set(library?.seriesNot ?? []);
    const done = new Set<string>();
    const out: MediaItem[][] = [];
    for (const it of stills) {
      if (done.has(it.key) || inSeries.has(it.key)) continue;
      const alike = lookAlikes(it.key, keys, cache, (a, b) => not.has(pairKey(a, b)) || done.has(b) || inSeries.has(b));
      if (!alike.length) continue;
      const group = [it, ...alike.map((k) => stills.find((s) => s.key === k)!)];
      group.forEach((g) => done.add(g.key));
      out.push(group);
    }
    return out;
  }, [unsorted, library?.series, library?.seriesNot, cache]);
  if (!groups.length) return <Quiet action={<Go label="Sort" to={() => useStore.getState().openSortQueue()} />}>No look-alikes waiting.</Quiet>;
  return (
    <>
      <Big n={groups.length} what="series to decide" />
      <Pics items={groups[0]} side={120} />
    </>
  );
}

/** A saved search run in Find: its platform chosen, then the search. */
export const runSaved = (s: { id: string; pluginId: string }) => {
  useFind.getState().choose(s.pluginId);
  void useFind.getState().openSaved(s.id);
  useStore.getState().openFind();
};

function FindNewBlock() {
  const root = useStore((s) => s.root);
  const saved = useFind((f) => f.saved);
  const finders = useFinders((f) => f.finders);
  useEffect(() => void useFind.getState().loadBaskets(), [root]);
  const fresh = saved.filter((s) => (s.fresh ?? 0) > 0).sort((a, b) => (b.fresh ?? 0) - (a.fresh ?? 0));
  if (!saved.length) return <Quiet action={<Go label="Find" to={() => useStore.getState().openFind()} />}>No saved searches yet: save one in Find to see what it finds here.</Quiet>;
  if (!fresh.length) return <Quiet action={<Go label="Find" to={() => useStore.getState().openFind()} />}>Nothing new since you last looked.</Quiet>;
  // Each platform under its logo, its searches with what they found.
  const platforms = [...new Set(fresh.map((s) => s.pluginId))];
  return (
    <div className="home-list">
      {platforms.map((pid) => (
        <div key={pid} className="home-list-group">
          <div className="home-list-head small">
            <PlatformIcon pluginId={pid} url={finders[pid]?.icon ?? null} />
            <span className="ellipsis">{finders[pid]?.name ?? pid}</span>
          </div>
          {fresh
            .filter((s) => s.pluginId === pid)
            .map((s) => (
              <button key={s.id} className="home-row" onClick={() => runSaved(s)}>
                <span className="ellipsis grow">{s.name}</span>
                <span className="mono accent-text">
                  {s.fresh}
                  {s.more ? "+" : ""} new
                </span>
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

function ArtistsBlock() {
  const root = useStore((s) => s.root);
  const doc = useArtists((a) => a.doc);
  const sources = useStore((s) => s.library?.sources);
  const all = useStore((s) => s.allItems);
  useEffect(() => void useArtists.getState().load(), [root]);
  const suggestions = useMemo(() => {
    if (!doc) return [];
    const present = all.length ? new Set(all.map((i) => i.key)) : null;
    const albums = new Map(all.filter((i) => i.albumKey).map((i) => [i.key, i.albumKey!]));
    return suggestionsFor(doc, sources ?? {}, present, (k) => albums.get(k));
  }, [doc, sources, all]);
  if (!suggestions.length) return <Quiet action={<Go label="Artists" to={() => useStore.getState().openArtists()} />}>No artists waiting for a yes.</Quiet>;
  return (
    <div className="home-list">
      {suggestions.slice(0, 8).map((s) => (
        <button key={s.key} className="home-row" onClick={() => useStore.getState().openArtists()}>
          <PlatformIcon pluginId={s.platform} url={null} />
          <span className="ellipsis grow">{s.name}</span>
          <span className="mono dim">{s.items.length}</span>
        </button>
      ))}
    </div>
  );
}

/** Find on a platform, at its basket. */
const openBasket = (pluginId: string) => {
  useFind.getState().choose(pluginId);
  useFind.getState().open({ section: BASKET });
  useStore.getState().openFind();
};

function BasketTile({ pluginId, item }: { pluginId: string; item: BasketItem }) {
  const img = useFindImage(pluginId, item.thumb);
  return (
    <button className="home-pic" onClick={() => openBasket(pluginId)} title={item.title}>
      {img.src && <img src={img.src} alt="" loading="lazy" decoding="async" draggable={false} />}
    </button>
  );
}

function BasketBlock() {
  const maxRows = useContext(BlockCtx)?.maxRows;
  const root = useStore((s) => s.root);
  const baskets = useFind((f) => f.baskets);
  const finders = useFinders((f) => f.finders);
  const online = useOnline();
  useEffect(() => void useFind.getState().loadBaskets(), [root]);
  const groups: RowGroup[] = Object.entries(baskets)
    .filter(([, items]) => items.length)
    .map(([pid, items]) => ({
      id: pid,
      name: finders[pid]?.name ?? pid,
      icon: <PlatformIcon pluginId={pid} url={finders[pid]?.icon ?? null} />,
      count: items.length,
      open: () => openBasket(pid),
      tiles: items.slice(0, 40).map((item) => ({ key: item.id, node: <BasketTile pluginId={pid} item={item} /> })),
      connect: mayGoOnline(pid, online) ? undefined : () => useOnline.getState().connect(pid),
    }));
  if (!groups.length) return <Quiet action={<Go label="Find" to={() => useStore.getState().openFind()} />}>The basket is empty: put works in it in Find to look at them later.</Quiet>;
  return <PlatformRows groups={groups} maxRows={maxRows} />;
}

/** One thing an extension shares: its picture, by address (fetched as the plugin's) or its own. */
function SharedTile({ pluginId, panel, item }: { pluginId: string; panel: string; item: SharedItem }) {
  const img = useFindImage(item.image ? null : pluginId, item.thumb ?? null);
  const src = item.image ?? img.src;
  const open = () => {
    const f = useFinders.getState().finders[pluginId];
    if (item.work && f) void showWork(f.platform, item.work, null);
    else sendEvent(pluginId, "home", { panel, id: item.id });
  };
  return (
    <button className="home-pic" onClick={open} title={item.title}>
      {src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />}
    </button>
  );
}

/** The shared panels extensions fill, by name, with the title the first gives it. */
export function useSharedPanels(): { id: string; title: string }[] {
  const shared = usePlugins((p) => p.shared);
  return Object.entries(shared).map(([id, parts]) => ({ id, title: Object.values(parts)[0]?.title ?? id }));
}

function SharedBlock({ block }: { block: Block }) {
  const panels = useSharedPanels();
  const panel = block.panel ?? panels[0]?.id;
  const parts = usePlugins((p) => (panel ? p.shared[panel] : undefined));
  const plugins = usePlugins((p) => p.list);
  const finders = useFinders((f) => f.finders);
  const online = useOnline();
  if (!panels.length) return <Quiet>No extension shares anything on the Home yet.</Quiet>;
  if (!parts) return <Quiet>The extensions sharing this panel aren't running.</Quiet>;
  const groups: RowGroup[] = Object.entries(parts)
    .filter(([, part]) => part.items.length)
    .map(([pid, part]) => {
      const info = plugins.find((x) => x.id === pid);
      return {
        id: pid,
        name: info?.manifest?.name ?? pid,
        // A Find platform's logo where the extension is one; else the plugins' own mark.
        icon: finders[pid] ? <PlatformIcon pluginId={pid} url={finders[pid].icon} /> : <PluginIcon />,
        count: part.items.length,
        open: () => sendEvent(pid, "home", { panel, id: null }),
        tiles: part.items.map((item) => ({ key: item.id, node: <SharedTile pluginId={pid} panel={panel!} item={item} /> })),
        // Pictures by address wait for Connect; pictures of its own are here already.
        connect: part.items.some((i) => i.thumb && !i.image) && !mayGoOnline(pid, online) ? () => useOnline.getState().connect(pid) : undefined,
      };
    });
  return groups.length ? <PlatformRows groups={groups} maxRows={block.maxRows} /> : <Quiet>Nothing in it right now.</Quiet>;
}

/* ---------- pick up ---------- */

/** Albums with a page looked at, most lately first, with that page. */
function useReading(): { album: Album; at: string; when: number }[] {
  const albums = useStore((s) => s.albums);
  const loaded = useStore((s) => s.albumsLoaded);
  const viewed = useStore((s) => s.viewed);
  useEffect(() => {
    if (!loaded) void useStore.getState().loadAlbums();
  }, [loaded]);
  return useMemo(() => {
    const byKey = new Map(albums.map((a) => [a.key, a]));
    const best = new Map<string, { at: string; when: number }>();
    for (const [k, when] of Object.entries(viewed)) {
      const a = byKey.get(k.includes("#") ? k.slice(0, k.indexOf("#")) : k.slice(0, k.lastIndexOf("/")));
      if (a && (best.get(a.key)?.when ?? 0) < when) best.set(a.key, { at: k, when });
    }
    return [...best.entries()].sort((x, y) => y[1].when - x[1].when).map(([k, v]) => ({ album: byKey.get(k)!, ...v }));
  }, [albums, viewed]);
}

/** An album's pages in order, read once per album and day of change. */
const pagesOf = new Map<string, Promise<string[]>>();
function usePageNumber(album: Album, at: string): number | null {
  const root = useStore((s) => s.root);
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!root) return;
    const id = `${album.key}:${album.modified}`;
    if (!pagesOf.has(id)) pagesOf.set(id, albumPages(root, album).then((p) => p.map((i) => i.key)));
    let live = true;
    void pagesOf
      .get(id)!
      .then((keys) => live && setN(keys.indexOf(at) + 1 || null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [root, album, at]);
  return n;
}

function ReadingRow({ album, at, when }: { album: Album; at: string; when: number }) {
  const root = useStore((s) => s.root);
  const scrap = useStore((s) => s.library?.albumCovers?.[album.key]);
  const made = useCoverUrl(scrap);
  const page = usePageNumber(album, at);
  const c = album.cover;
  const cover = made ?? (c && root && canThumb(c) ? thumbUrl(root, c, 120) : c ? mediaUrl(c) : null);
  const share = page && album.count ? page / album.count : 0;
  return (
    <button className="home-reading" onClick={() => void useStore.getState().openAlbum(album, at)} title={`Open ${album.name} at that page`}>
      {cover ? <img src={cover} alt="" draggable={false} /> : <span className="home-reading-ph" />}
      <span className="home-reading-text">
        <span className="ellipsis">{album.name}</span>
        <span className="mono dim small">
          {page ? `Page ${page} of ${album.count}` : `${album.count} pages`} · {formatAgo(when)}
        </span>
        <span className="home-bar">
          <i style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      </span>
    </button>
  );
}

function ReadingBlock() {
  const reading = useReading();
  const [ref, box] = useBox<HTMLDivElement>();
  if (!reading.length) return <Quiet action={<Go label="Albums" to={() => useStore.getState().openAlbums()} />}>No album opened yet.</Quiet>;
  const rows = Math.max(1, Math.floor((box.h + 8) / 92));
  return (
    <div ref={ref} className="home-list">
      {reading.slice(0, rows).map((r) => (
        <ReadingRow key={r.album.key} {...r} />
      ))}
    </div>
  );
}

function ViewedBlock() {
  const viewed = useStore((s) => s.viewed);
  const items = useItemMap();
  const folders = useHome((h) => h.doc?.folders);
  const list = useMemo(
    () =>
      Object.entries(viewed)
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => items.get(k))
        .filter((i): i is MediaItem => !!i && i.kind !== "video" && (!folders || shownOnHome(i.key, folders)))
        .slice(0, 200),
    [viewed, items, folders],
  );
  return list.length ? <Pics items={list} /> : <Quiet action={<Go label="Browse" to={() => useStore.getState().openBrowse()} />}>Nothing looked at yet.</Quiet>;
}

function NewestBlock({ block }: { block: Block }) {
  const base = useFiltered(block);
  const list = useMemo(() => [...base].sort((a, b) => b.modified - a.modified).slice(0, 200), [base]);
  return list.length ? <Pics items={list} /> : <NoPictures />;
}

function LastBlock() {
  const last = useHome((h) => h.doc?.last);
  const screen = last && SCREENS[last.screen as keyof typeof SCREENS];
  if (!last || !screen) return <Quiet action={<Go label="Browse" to={() => useStore.getState().openBrowse()} />}>Nowhere yet.</Quiet>;
  return (
    <div className="home-last">
      <button className="btn" onClick={screen.go} title={`Back to ${screen.label}`}>
        {screen.icon} <span className="ellipsis">Back to {screen.label}</span> <ArrowRight />
      </button>
      <span className="mono dim small">Left {formatAgo(last.at)}</span>
    </div>
  );
}

/* ---------- rediscover ---------- */

const dayLabel = (d = new Date()) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** How far "this day" widens when nothing is from the day itself: this week, then this month. */
const AROUND = [
  { days: 0, said: null },
  { days: 3, said: "Nothing from the day: this week in other years" },
  { days: 15, said: "Nothing this week: this month in other years" },
];

function OnThisDayBlock({ block, salt }: { block: Block; salt: number }) {
  const base = useFiltered(block);
  const unsorted = useStore((s) => s.unsorted);
  const { list, said, newest } = useMemo((): { list: MediaItem[]; said: string | null; newest?: boolean } => {
    const now = new Date();
    for (const a of AROUND) {
      const years = onThisDay(base, now, a.days);
      if (years.length) return { list: years.flatMap((y) => y.items), said: a.said };
    }
    // Nothing this month: the nearest day that has pictures, in any earlier year.
    const near = nearestDay(base, now);
    if (near != null) return { list: onThisDay(base, now, near).flatMap((y) => y.items), said: `Nothing this month: ${near} days off, in other years` };
    // No earlier year at all yet: a random handful, said so, rather than an empty panel; not the
    // pictures waiting to sort, which their own block shows.
    const waiting = new Set(unsorted.map((i) => i.key));
    const rest = base.filter((i) => !waiting.has(i.key));
    return { list: pickStable(rest.length ? rest : base, 60, salt), said: "Nothing from earlier years: a random handful", newest: true };
  }, [base, unsorted, salt]);
  if (!list.length) return <NoPictures />;
  return (
    <>
      {said && <span className="dim small">{said}</span>}
      <Pics items={list} labelOf={newest ? undefined : (i) => String(new Date(i.modified).getFullYear())} />
    </>
  );
}

/** New each time the app opens, for the blocks that pick at random: a new pick each session. */
const SESSION_SEED = Date.now() % 100_000;

/** A salt per block, so its Shuffle changes only it; kept in the Home store, so the pick shuffled to stays when Home is left. */
export function useSalt(block: Block): [number, () => void] {
  const salt = useHome((h) => h.salts[block.id] ?? 0);
  const own = [...block.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
  return [SESSION_SEED + own + salt * 7919, () => useHome.getState().shuffle(block.id)];
}

/** A header button: a new pick. */
const shuffles: Partial<Record<BlockType, boolean>> = { random: true, unseen: true, favourites: true };
export const canShuffle = (block: Block) => !!shuffles[block.type] || (block.type === "board" && block.board === RANDOM_BOARD);

function RandomBlock({ block, salt }: { block: Block; salt: number }) {
  const base = useFiltered(block);
  const list = useMemo(() => pickStable(base, 60, salt), [base, salt]);
  return list.length ? <Pics items={list} /> : <NoPictures />;
}

function FavouritesBlock({ block, salt }: { block: Block; salt: number }) {
  // From 8 up unless its own rating filter says otherwise.
  const base = useFiltered(block, { minRating: 8 });
  const ratings = useStore((s) => s.library?.ratings);
  const min = block.filter?.minRating || 8;
  const list = useMemo(() => pickStable(base, 60, salt), [base, salt]);
  return list.length ? <Pics items={list} labelOf={(i) => String(ratings?.[i.key] ?? "")} /> : <Quiet action={<Go label="Rate in Browse" to={() => useStore.getState().openBrowse()} />}>Nothing rated {min} or more yet.</Quiet>;
}

const YEAR = 365 * 86_400_000;
function UnseenBlock({ block, salt }: { block: Block; salt: number }) {
  const base = useFiltered(block);
  const viewed = useStore((s) => s.viewed);
  const list = useMemo(() => {
    const before = Date.now() - YEAR;
    return pickStable(
      base.filter((i) => (viewed[i.key] ?? 0) < before),
      60,
      salt,
    );
  }, [base, viewed, salt]);
  return list.length ? <Pics items={list} /> : <Quiet action={<Go label="Browse" to={() => useStore.getState().openBrowse()} />}>You have looked at everything here this year.</Quiet>;
}

function SourceBlock({ block }: { block: Block }) {
  const base = useFiltered(block);
  const list = useMemo(() => [...base].sort((a, b) => b.modified - a.modified), [base]);
  if (!block.filter || !Object.keys(block.filter).length) return <Quiet>Pick its pictures in Arrange: click it, then its filters (tags, people, artists, rating, folders, an album).</Quiet>;
  return list.length ? <Pics items={list} /> : <Quiet>None of the pictures fit its filters.</Quiet>;
}

function SlideshowBlock({ block, salt }: { block: Block; salt: number }) {
  const base = useFiltered(block);
  const list = useMemo(() => pickStable(base, 80, salt), [base, salt]);
  const [at, setAt] = useState(0);
  const root = useStore((s) => s.root);
  useEffect(() => {
    setAt(0);
    if (list.length < 2) return;
    const t = setInterval(() => setAt((n) => (n + 1) % list.length), 8000);
    return () => clearInterval(t);
  }, [list]);
  if (!list.length) return <NoPictures />;
  const item = list[at % list.length];
  const src = root && canThumb(item) ? thumbUrl(root, item, 1024) : mediaUrl(item);
  return (
    <div className="home-slide">
      <img key={item.key} className="home-slide-pic" src={src} alt="" draggable={false} />
      <button
        className="btn sm home-slide-play"
        onClick={() => {
          open(list, item);
          useStore.getState().toggleSlideshow();
        }}
        title="These pictures full screen, one after another"
      >
        <Play /> Play
      </button>
    </div>
  );
}

function PictureBlock({ block, salt }: { block: Block; salt: number }) {
  const base = useFiltered(block);
  const items = useItemMap();
  const root = useStore((s) => s.root);
  const pinned = block.pinned ? items.get(block.pinned) : undefined;
  const item = pinned ?? pickStable(base, 1, today() + salt)[0];
  if (!item) return <NoPictures />;
  const src = root && canThumb(item) ? thumbUrl(root, item, 1024) : mediaUrl(item);
  return (
    <div className="home-one-wrap">
      <button className="home-one" onClick={() => open([item], item)} title={item.name}>
        <img src={src} alt="" draggable={false} />
      </button>
      {!pinned && (
        <button className="btn sm home-pin" onClick={() => useHome.getState().updateBlock(block.id, { pinned: item.key })} title="Keep this picture here, not a new one each day">
          <PushPin /> Keep this one
        </button>
      )}
    </div>
  );
}

function CoverTile({ album }: { album: Album }) {
  const book = useStore((s) => s.library?.albumCovers?.[album.key]);
  const url = useCoverUrl(book);
  return (
    <button className="home-cover" onClick={() => void useStore.getState().openAlbum(album)} title={album.name}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="home-reading-ph" />}
    </button>
  );
}

function ScrapbookBlock() {
  const albums = useStore((s) => s.albums);
  const loaded = useStore((s) => s.albumsLoaded);
  const covers = useStore((s) => s.library?.albumCovers);
  useEffect(() => {
    if (!loaded) void useStore.getState().loadAlbums();
  }, [loaded]);
  const made = albums.filter((a) => covers?.[a.key]);
  const [ref, box] = useBox<HTMLDivElement>();
  if (!made.length)
    return (
      <Quiet
        action={
          <button className="btn" onClick={() => useStore.getState().openAlbums()}>
            Albums
          </button>
        }
      >
        No scrapbook covers yet: make one from an album's menu.
      </Quiet>
    );
  // Covers keep their page's shape (1280:1817).
  const w = Math.max(60, ((box.h || 200) * 1280) / 1817);
  const fits = Math.max(1, Math.floor((box.w + 8) / (w + 8)));
  return (
    <div ref={ref} className="home-covers">
      {made.slice(0, fits).map((a) => (
        <CoverTile key={a.key} album={a} />
      ))}
    </div>
  );
}

/** The library's boards, the last changed first. */
export function useBoards(): ScrapDoc[] {
  const books = useScrapbook((x) => x.lib?.books);
  const root = useStore((s) => s.root);
  useEffect(() => void useScrapbook.getState().load(), [root]);
  return useMemo(() => Object.values(books ?? {}).filter((b) => b.kind === "board").sort((a, b) => b.updated - a.updated), [books]);
}

const openBoard = (board: ScrapDoc) => void useScrapbook.getState().open({ kind: "board", id: board.id, name: board.name || "Board" });

/** The board each board block shows now (its key opens it). */
const shownBoards = new Map<string, string>();

/** The board a block shows: the one picked, a random one, or the one last changed (also when the one picked has gone). */
function boardOf(block: Block, boards: ScrapDoc[], salt: number): ScrapDoc | null {
  const picked = block.board && block.board !== RANDOM_BOARD ? boards.find((b) => b.id === block.board) : undefined;
  if (picked) return picked;
  if (block.board === RANDOM_BOARD) return pickStable(boards.map((b) => ({ key: b.id, b })), 1, salt)[0]?.b ?? null;
  return boards[0] ?? null;
}

const NoBoards = () => (
  <Quiet
    action={
      <button className="btn" onClick={askNewBoard}>
        <Plus /> New board
      </button>
    }
  >
    No boards yet: pages of your own in the Scrapbook, for references, notes and arrows.
  </Quiet>
);

function BoardBlock({ block, salt }: { block: Block; salt: number }) {
  const boards = useBoards();
  const board = boardOf(block, boards, salt);
  const url = useCoverUrl(board?.id);
  if (board) shownBoards.set(block.id, board.id);
  if (!board) return <NoBoards />;
  const name = board.name || "Board";
  return (
    <div className="home-one-wrap">
      <button className="home-one home-board" onClick={() => openBoard(board)} title={`${name}: work on it`}>
        {url ? <img src={url} alt="" draggable={false} /> : <span className="dim small">{name}: nothing on it yet</span>}
      </button>
      {/* Its name, unless the block is named after it already. */}
      {block.board !== board.id && <span className="home-pic-label">{name}</span>}
      <button className="btn sm home-pin" onClick={() => void openBoardWindow(board)} title="In its own window, which can stay above your other apps">
        <AppWindow /> Own window
      </button>
    </div>
  );
}

/**
 * Boards each whole in its own shape, all the same height (or width, one above another in a tall
 * block), the last changed first, after a button for a new one: as many as fit at a fair size (see
 * `boardStrip`).
 */
function BoardsBlock() {
  const boards = useBoards();
  const [ref, box] = useBox<HTMLDivElement>();
  const W = box.w || 480;
  const H = box.h || 160;
  const tall = W < H * 1.2;
  // The button for a new one: a strip across the top of a tall block, a narrow tile in a wide one.
  const add = tall ? 34 : Math.round(Math.min(110, Math.max(72, W * 0.16)));
  // Each board's width over its height (a very thin one shown a little less so, trimmed).
  const shapes = boards.slice(0, 24).map((b) => {
    const page = pageOf(b);
    return Math.min(3, Math.max(0.4, page.w / page.h));
  });
  const { n, depth } = boardStrip(tall ? shapes.map((a) => 1 / a) : shapes, (tall ? H : W) - add - 8, tall ? W : H);
  return (
    <div ref={ref} className={`home-boards ${tall ? "tall" : ""}`}>
      <button className="home-board-new" style={tall ? { height: add } : { width: add }} onClick={askNewBoard} title="Start a new board">
        <Plus />
        <span>New board</span>
      </button>
      {boards.slice(0, n).map((board, i) => (
        <BoardTile key={board.id} board={board} width={tall ? depth : depth * shapes[i]} height={tall ? depth / shapes[i] : depth} />
      ))}
      {!boards.length && <span className="dim small home-boards-none">No boards yet: pages of your own, for references, notes and arrows.</span>}
    </div>
  );
}

function BoardTile({ board, width, height }: { board: ScrapDoc; width: number; height: number }) {
  const url = useCoverUrl(board.id);
  const name = board.name || "Board";
  return (
    <button className="home-board-tile" style={{ width, height }} onClick={() => openBoard(board)} title={`${name}: work on it`}>
      {url ? <img src={url} alt="" draggable={false} /> : <span className="home-reading-ph" />}
      <span className="home-pic-label">{name}</span>
    </button>
  );
}

/* ---------- status ---------- */

function ActivityBlock() {
  const jobs = useActivity();
  const items = useItemMap();
  if (!jobs.length) return <Quiet>Nothing running now.</Quiet>;
  return (
    <div className="home-list home-jobs">
      {jobs.map((j) => (
        <JobRow key={j.id} j={j} lookup={(k) => items.get(k)} />
      ))}
    </div>
  );
}

/** The drive, asked once a minute at most. */
const driveAsked = new Map<string, { at: number; info: Promise<DriveInfo> }>();
function DriveBlock() {
  const root = useStore((s) => s.root);
  const [info, setInfo] = useState<DriveInfo | null>(null);
  useEffect(() => {
    if (!root) return;
    const was = driveAsked.get(root);
    if (!was || Date.now() - was.at > 60_000) driveAsked.set(root, { at: Date.now(), info: api.driveInfo(root) });
    let live = true;
    void driveAsked
      .get(root)!
      .info.then((d) => live && setInfo(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [root]);
  if (!info) return <Quiet>Asking the drive…</Quiet>;
  const free = info.totalBytes ? info.availableBytes / info.totalBytes : 1;
  // What the drive says of itself, when it says something clear.
  const health = /fail/i.test(info.smartStatus ?? "") ? "failing" : /verif|pass|^ok/i.test(info.smartStatus ?? "") ? "healthy" : null;
  return (
    <div className="home-status">
      <div className="home-status-line">
        <HardDrive />
        <span className="ellipsis grow" title={info.model ?? info.vendor ?? info.mountPoint}>
          {info.model ?? info.vendor ?? info.mountPoint}
        </span>
      </div>
      <span className="home-bar">
        <i style={{ width: `${Math.round((1 - free) * 100)}%` }} />
      </span>
      <div className="home-status-line">
        <span className={`mono small grow ${free < 0.1 ? "danger-text" : free < 0.2 ? "warn-text" : "dim"}`}>{formatBytes(info.availableBytes)} free</span>
        <button className={`btn sm ghost ${health === "failing" ? "danger-text" : ""}`} onClick={() => useStore.getState().set({ driveOpen: true })} title="Drive health">
          {health === "failing" ? "Failing" : health === "healthy" ? "Healthy" : "Health"} <ArrowRight />
        </button>
      </div>
    </div>
  );
}

function BackupBlock() {
  const last = useStore((s) => s.library?.lastBackup);
  const dest = useStore((s) => s.library?.backupDest);
  const days = last ? (Date.now() - last) / 86_400_000 : null;
  return (
    <div className="home-status">
      <div className="home-status-line">
        <span className="grow">{dest ? `To ${dest.split("/").filter(Boolean).pop()}` : "No backup drive set"}</span>
        <span className={`mono small ${days == null || days > 30 ? "danger-text" : days > 7 ? "warn-text" : "dim"}`}>{last ? formatAgo(last) : "never"}</span>
      </div>
      <button className="btn sm ghost" onClick={() => useStore.getState().set({ backupOpen: true })}>
        Back up <ArrowRight />
      </button>
    </div>
  );
}

/* ---------- shortcuts ---------- */

/** What a Shortcuts block can hold: the screens, each Find platform (an extension), and the plugins page. */
export function useShortcutOptions(): { id: string; label: string; icon: React.ReactNode; key?: string; go: () => void }[] {
  const finders = useFinders((f) => f.finders);
  return [
    ...SHORTCUT_SCREENS.map((id) => SCREENS[id] && { id, label: SCREENS[id]!.label, icon: SCREENS[id]!.icon, key: SCREENS[id]!.key, go: SCREENS[id]!.go }),
    ...Object.values(finders).map((f) => ({
      id: `find:${f.pluginId}`,
      label: f.name,
      icon: <PlatformIcon pluginId={f.pluginId} url={f.icon} />,
      go: () => {
        useFind.getState().choose(f.pluginId);
        useStore.getState().openFind();
      },
    })),
    { id: "plugins", label: "Plugins", icon: <PuzzlePiece />, go: () => useStore.getState().set({ pluginsOpen: true }) },
  ].filter((x): x is NonNullable<typeof x> => !!x);
}

/** The shortcuts a block starts with: a few screens, and every Find platform. */
export const defaultShortcuts = (options: { id: string }[]) => [...DEFAULT_SHORTCUTS, ...options.filter((o) => o.id.startsWith("find:")).map((o) => o.id)];

function ShortcutsBlock({ block }: { block: Block }) {
  const options = useShortcutOptions();
  const ids = block.screens ?? defaultShortcuts(options);
  const items: FitItem[] = ids.flatMap((id) => {
    const o = options.find((x) => x.id === id);
    return o ? [{ id: o.id, label: o.label, icon: o.icon, keycap: o.key, go: o.go }] : [];
  });
  return items.length ? <FitButtons items={items} /> : <Quiet>Pick what goes on it in Arrange.</Quiet>;
}

/** The saved searches a Jump in block starts with: the two most lately opened on each platform. */
export function defaultSearches(saved: { id: string; pluginId: string; openedAt: number }[]): string[] {
  const by = new Map<string, { id: string; openedAt: number }[]>();
  for (const s of saved) by.set(s.pluginId, [...(by.get(s.pluginId) ?? []), s]);
  return [...by.values()].flatMap((list) => list.sort((a, b) => b.openedAt - a.openedAt).slice(0, 2).map((s) => s.id));
}

function JumpInBlock({ block }: { block: Block }) {
  const root = useStore((s) => s.root);
  const saved = useFind((f) => f.saved);
  const finders = useFinders((f) => f.finders);
  useEffect(() => void useFind.getState().loadBaskets(), [root]);
  const ids = block.searches ?? defaultSearches(saved);
  const items: FitItem[] = ids.flatMap((id) => {
    const s = saved.find((x) => x.id === id);
    return s ? [{ id: s.id, label: s.name, icon: <PlatformIcon pluginId={s.pluginId} url={finders[s.pluginId]?.icon ?? null} />, badge: s.fresh ? `${s.fresh}${s.more ? "+" : ""}` : undefined, go: () => runSaved(s) }] : [];
  });
  if (!saved.length) return <Quiet action={<Go label="Find" to={() => useStore.getState().openFind()} />}>No saved searches yet: save one in Find.</Quiet>;
  // Several searches share a platform's logo: names, shortened if need be, never logos alone.
  return items.length ? <FitButtons items={items} icons={false} /> : <Quiet>Pick its saved searches in Arrange.</Quiet>;
}

/* ---------- the registry ---------- */

/** Each kind's body. */
export function BlockBody({ block, salt }: { block: Block; salt: number }) {
  return (
    <BlockCtx.Provider value={block}>
      <Body block={block} salt={salt} />
    </BlockCtx.Provider>
  );
}

function Body({ block, salt }: { block: Block; salt: number }) {
  switch (block.type) {
    case "sort":
      return <SortBlock />;
    case "import":
      return <ImportBlock />;
    case "who":
      return <WhoBlock />;
    case "faces":
      return <FacesBlock />;
    case "dupes":
      return <DupesBlock />;
    case "series":
      return <SeriesBlock />;
    case "findnew":
      return <FindNewBlock />;
    case "artists":
      return <ArtistsBlock />;
    case "basket":
      return <BasketBlock />;
    case "shared":
      return <SharedBlock block={block} />;
    case "jumpin":
      return <JumpInBlock block={block} />;
    case "reading":
      return <ReadingBlock />;
    case "viewed":
      return <ViewedBlock />;
    case "newest":
      return <NewestBlock block={block} />;
    case "last":
      return <LastBlock />;
    case "onthisday":
      return <OnThisDayBlock block={block} salt={salt} />;
    case "random":
      return <RandomBlock block={block} salt={salt} />;
    case "favourites":
      return <FavouritesBlock block={block} salt={salt} />;
    case "source":
      return <SourceBlock block={block} />;
    case "unseen":
      return <UnseenBlock block={block} salt={salt} />;
    case "slideshow":
      return <SlideshowBlock block={block} salt={salt} />;
    case "picture":
      return <PictureBlock block={block} salt={salt} />;
    case "scrapbook":
      return <ScrapbookBlock />;
    case "board":
      return <BoardBlock block={block} salt={salt} />;
    case "boards":
      return <BoardsBlock />;
    case "activity":
      return <ActivityBlock />;
    case "drive":
      return <DriveBlock />;
    case "backup":
      return <BackupBlock />;
    case "shortcuts":
      return <ShortcutsBlock block={block} />;
    case "theme":
      return <ThemeBlock />;
  }
}

/** Every theme in its own look, in the light or dark chosen below; the one in use marked. */
function ThemeBlock() {
  const theme = useStore((s) => s.theme);
  const themeMode = useStore((s) => s.themeMode);
  const mode = useStore((s) => s.mode);
  return (
    <div className="home-themes-wrap">
      <div className="home-themes">
        {themes.map((t) => (
          <ThemeSwatch key={t.id} theme={t} mode={mode} active={t.id === theme} onPick={(id) => useStore.getState().setTheme(id)} />
        ))}
      </div>
      <ModePicker mode={themeMode} onPick={(m) => useStore.getState().setThemeMode(m)} small />
    </div>
  );
}

/** What a block's number key does: its main action, or the screen it stands for. */
export function actionOf(block: Block): (() => void) | null {
  const s = useStore.getState();
  switch (block.type) {
    case "sort":
      return s.library?.targets.length ? s.openSortQueue : () => s.set({ settingsOpen: true });
    case "import":
      return () => s.set({ importOpen: {} });
    case "who":
    case "faces":
      return s.openPeople;
    case "dupes":
      return s.openDupes;
    case "series":
      return s.openSortQueue;
    case "findnew":
      return s.openFind;
    case "artists":
      return () => s.openArtists();
    case "basket": {
      // The platform with the most in its basket.
      const most = Object.entries(useFind.getState().baskets).sort((a, b) => b[1].length - a[1].length)[0];
      return most?.[1].length ? () => openBasket(most[0]) : s.openFind;
    }
    case "scrapbook":
      return s.openAlbums;
    case "board": {
      const shown = useScrapbook.getState().lib?.books[shownBoards.get(block.id) ?? ""];
      return shown ? () => openBoard(shown) : s.openScrapbook;
    }
    case "boards":
      return askNewBoard;
    case "drive":
      return () => s.set({ driveOpen: true });
    case "backup":
      return () => s.set({ backupOpen: true });
    case "theme":
      // The next look along, round and round.
      return () => s.setTheme(themes[(themes.findIndex((t) => t.id === s.theme) + 1) % themes.length].id);
    case "last": {
      const last = useHome.getState().doc?.last;
      const screen = last && SCREENS[last.screen as keyof typeof SCREENS];
      return screen ? screen.go : null;
    }
    default:
      return null;
  }
}

/** A block's name on the board: its own, else its source's, else its kind's. */
export function useBlockTitle(block: Block): string {
  const tags = useTags((t) => t.data);
  const people = usePeople((p) => p.doc?.people);
  const artists = useArtists((a) => a.doc?.artists);
  const albums = useStore((s) => s.albums);
  // A board picked by name: named after it.
  const board = useScrapbook((x) => (block.type === "board" && block.board ? x.lib?.books[block.board]?.name : undefined));
  if (block.title) return block.title;
  if (board) return board;
  // Pictures chosen by one thing: named after it.
  const f = block.filter ?? {};
  if (block.type === "source") {
    const one = (l: string[] | undefined) => (l?.length === 1 ? l[0] : null);
    const named = [f.album ? (albums.find((a) => a.key === f.album)?.name ?? f.album.split("/").pop()) : null, one(f.tags) && (tags ? nameOf(one(f.tags)!) : null), one(f.people) && people?.[one(f.people)!]?.name, one(f.artists) && artists?.[one(f.artists)!]?.name, one(f.folders ?? undefined)?.split("/").filter(Boolean).pop()].filter(Boolean);
    if (named.length === 1) return named[0]!;
  }
  if (block.type === "onthisday") return `${KINDS.onthisday.name} · ${dayLabel()}`;
  return KINDS[block.type].name;
}
