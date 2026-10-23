import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Thumb } from "../components/Thumb";
import { isTypingTarget } from "../lib/hotkeys";
import { shuffled } from "../lib/format";
import type { MediaItem } from "../lib/types";

type SourceSel = "all" | "unsorted" | string;
type SortSel = "name" | "date" | "rating";

export function Browse() {
  const s = useStore();
  const targets = s.library?.targets ?? [];
  const [source, setSource] = useState<SourceSel>("all");
  const [sortBy, setSortBy] = useState<SortSel>("name");
  const [desc, setDesc] = useState(false);
  const [minRating, setMinRating] = useState(0);
  const [unratedOnly, setUnratedOnly] = useState(false);
  const [random, setRandom] = useState(false);
  const [seed, setSeed] = useState(0);
  const [sorted, setSorted] = useState<MediaItem[]>([]);
  const [scanning, setScanning] = useState(false);
  const [zoom, setZoom] = useState(220);

  // Load sorted media from every target folder.
  useEffect(() => {
    if (!s.root) return;
    let alive = true;
    setScanning(true);
    Promise.all(targets.map((t) => api.scanDir(s.root!, t.path).then((items) => items.map((i) => ({ ...i, targetId: t.id })))))
      .then((lists) => alive && setSorted(lists.flat()))
      .catch((e) => s.toast(String(e), "error"))
      .finally(() => alive && setScanning(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, targets.map((t) => t.path).join("|"), s.screen]);

  const ratings = s.library?.ratings ?? {};
  const targetName = useMemo(() => Object.fromEntries(targets.map((t) => [t.id, t.name])), [targets]);

  const items = useMemo(() => {
    let list: MediaItem[] = source === "unsorted" ? s.unsorted : source === "all" ? sorted : sorted.filter((i) => i.targetId === source);
    if (unratedOnly) list = list.filter((i) => ratings[i.key] == null);
    else if (minRating > 0) list = list.filter((i) => (ratings[i.key] ?? 0) >= minRating);
    if (random) return shuffled(list);
    const cmp: Record<SortSel, (a: MediaItem, b: MediaItem) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      date: (a, b) => a.modified - b.modified,
      rating: (a, b) => (ratings[a.key] ?? 0) - (ratings[b.key] ?? 0) || a.name.localeCompare(b.name),
    };
    const out = list.slice().sort(cmp[sortBy]);
    return desc ? out.reverse() : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sorted, s.unsorted, ratings, minRating, unratedOnly, random, seed, sortBy, desc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (s.settingsOpen || s.trashOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "b") s.openSortQueue();
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

  return (
    <div className="browse">
      <aside className="browse-side panel">
        <div className="side-head">
          <span className="brand">MEDIA SORTER</span>
          <button className="btn sm accent2" onClick={s.openSortQueue} title="Back to sorting (Esc)">
            Sort <kbd className="kbd">Esc</kbd>
          </button>
        </div>

        <div className="label">Source</div>
        <div className="side-list">
          <button className={`btn sm ${source === "all" ? "active" : ""}`} onClick={() => setSource("all")}>
            All sorted <span className="faint mono">{sorted.length}</span>
          </button>
          {targets.map((t) => (
            <button key={t.id} className={`btn sm ${source === t.id ? "active" : ""}`} onClick={() => setSource(t.id)}>
              {t.name} <span className="faint mono">{sorted.filter((i) => i.targetId === t.id).length}</span>
            </button>
          ))}
          <button className={`btn sm ${source === "unsorted" ? "active" : ""}`} onClick={() => setSource("unsorted")}>
            Unsorted <span className="faint mono">{s.unsorted.length}</span>
          </button>
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
        <div className="side-list">
          {(["name", "date", "rating"] as SortSel[]).map((k) => (
            <button
              key={k}
              className={`btn sm ${!random && sortBy === k ? "active" : ""}`}
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
            className={`btn sm ${random ? "active" : ""}`}
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
        <button className="btn sm ghost" onClick={() => s.set({ settingsOpen: true })}>
          Settings <kbd className="kbd">G</kbd>
        </button>
      </aside>

      <main className="browse-main">
        <div className="browse-head">
          <span className="mono dim">
            {scanning ? "Scanning…" : `${items.length} items`}
          </span>
        </div>
        <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))` }}>
          {items.map((it, i) => (
            <Thumb
              key={it.primary}
              item={it}
              rating={ratings[it.key]}
              label={source === "all" && it.targetId ? targetName[it.targetId] : undefined}
              onClick={() => open(i)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}
