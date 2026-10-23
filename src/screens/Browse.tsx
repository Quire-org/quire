import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { Thumb } from "../components/Thumb";
import { isTypingTarget } from "../lib/hotkeys";
import { formatBytes, shuffled } from "../lib/format";
import type { MediaItem } from "../lib/types";

type LocationSel = "all" | "unsorted" | string;
type KindSel = "all" | "image" | "raw" | "video";
type SortSel = "name" | "date" | "rating" | "size";

/**
 * Everything under the opened folder (and any target folders outside it) as one
 * grid, narrowed down by location, type, subfolder, rating and name.
 */
export function Browse() {
  const s = useStore();
  const targets = s.library?.targets ?? [];
  const [location, setLocation] = useState<LocationSel>("all");
  const [kind, setKind] = useState<KindSel>("all");
  const [folder, setFolder] = useState<string>("");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortSel>("name");
  const [desc, setDesc] = useState(false);
  const [minRating, setMinRating] = useState(0);
  const [unratedOnly, setUnratedOnly] = useState(false);
  const [random, setRandom] = useState(false);
  const [seed, setSeed] = useState(0);
  const [zoom, setZoom] = useState(220);

  useEffect(() => {
    void s.loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, s.allStale]);

  const all = s.allItems;
  const ratings = s.library?.ratings ?? {};
  const targetName = useMemo(() => Object.fromEntries(targets.map((t) => [t.id, t.name])), [targets]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length, unsorted: 0 };
    for (const i of all) {
      if (i.targetId) c[i.targetId] = (c[i.targetId] ?? 0) + 1;
      else c.unsorted++;
    }
    return c;
  }, [all]);

  const folders = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) {
      const parts = i.dir ? i.dir.split("/") : [];
      // Count the item for the folder and every ancestor so parents include children.
      for (let k = 0; k <= parts.length; k++) {
        const key = parts.slice(0, k).join("/");
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [all]);

  const items = useMemo(() => {
    let list: MediaItem[] = all;
    if (location === "unsorted") list = list.filter((i) => !i.targetId);
    else if (location !== "all") list = list.filter((i) => i.targetId === location);
    if (kind !== "all") list = list.filter((i) => i.kind === kind);
    if (folder) list = list.filter((i) => i.dir === folder || i.dir.startsWith(folder + "/"));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((i) => i.name.toLowerCase().includes(q) || i.dir.toLowerCase().includes(q));
    }
    if (unratedOnly) list = list.filter((i) => ratings[i.key] == null);
    else if (minRating > 0) list = list.filter((i) => (ratings[i.key] ?? 0) >= minRating);
    if (random) return shuffled(list);
    const cmp: Record<SortSel, (a: MediaItem, b: MediaItem) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      date: (a, b) => a.modified - b.modified,
      size: (a, b) => a.size - b.size,
      rating: (a, b) => (ratings[a.key] ?? 0) - (ratings[b.key] ?? 0) || a.name.localeCompare(b.name),
    };
    const out = list.slice().sort(cmp[sortBy]);
    return desc ? out.reverse() : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, location, kind, folder, query, ratings, minRating, unratedOnly, random, seed, sortBy, desc]);

  const totalBytes = useMemo(() => items.reduce((a, i) => a + i.size, 0), [items]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (s.settingsOpen || s.trashOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "b") s.openSortQueue();
      if (key === "d") s.openDupes();
      if (key === "s") {
        setRandom((r) => !r);
        setSeed((x) => x + 1);
      }
      if (key === "g") s.set({ settingsOpen: true });
      if (key === "enter" && items.length) s.openViewer(items, 0, { kind: "browse" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, s]);

  const open = (i: number) => s.openViewer(items, i, { kind: "browse" });
  const chip = (active: boolean) => `btn sm ${active ? "active" : ""}`;

  return (
    <div className="browse">
      <aside className="browse-side panel">
        <div className="side-head">
          <span className="brand">MEDIA SORTER</span>
          <button className="btn sm accent2" onClick={s.openSortQueue} title="Back to sorting (Esc)">
            Sort <kbd className="kbd">Esc</kbd>
          </button>
        </div>

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
        </div>

        <div className="label">Type</div>
        <div className="chips">
          {(["all", "image", "raw", "video"] as KindSel[]).map((k) => (
            <button key={k} className={chip(kind === k)} onClick={() => setKind(k)}>
              {k === "all" ? "All" : k === "image" ? "Photos" : k === "raw" ? "RAW" : "Videos"}
            </button>
          ))}
        </div>

        <div className="label">Folder</div>
        <select className="input" value={folder} onChange={(e) => setFolder(e.target.value)}>
          {folders.map(([f, n]) => (
            <option key={f} value={f}>
              {f ? `${"  ".repeat(f.split("/").length - 1)}${f.split("/").pop()}` : "All folders"} ({n})
            </option>
          ))}
        </select>

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
              className={chip(!random && sortBy === k)}
              onClick={() => {
                if (sortBy === k && !random) setDesc((d) => !d);
                setSortBy(k);
                setRandom(false);
              }}
            >
              {k} {!random && sortBy === k ? (desc ? "↓" : "↑") : ""}
            </button>
          ))}
          <button
            className={chip(random)}
            onClick={() => {
              setRandom(true);
              setSeed((x) => x + 1);
            }}
          >
            Random <kbd className="kbd">S</kbd>
          </button>
        </div>

        <div className="label">Tile size</div>
        <div className="side-row">
          <input type="range" min={120} max={480} step={20} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </div>

        <hr className="rule" />
        <button className="btn primary" disabled={!items.length} onClick={() => open(0)}>
          Slideshow <kbd className="kbd">⏎</kbd>
        </button>
        <button className="btn sm" onClick={s.openDupes}>
          Find duplicates <kbd className="kbd">D</kbd>
        </button>
        <button className="btn sm ghost" onClick={() => s.set({ settingsOpen: true })}>
          Settings <kbd className="kbd">G</kbd>
        </button>
      </aside>

      <main className="browse-main">
        <div className="browse-head">
          <span className="mono dim">
            {s.loading ? s.loading : `${items.length} of ${all.length} items · ${formatBytes(totalBytes)}`}
          </span>
        </div>
        <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))` }}>
          {items.map((it, i) => (
            <Thumb key={it.primary} item={it} rating={ratings[it.key]} label={it.targetId ? targetName[it.targetId] : undefined} onClick={() => open(i)} />
          ))}
        </div>
      </main>
    </div>
  );
}
