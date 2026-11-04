import { useCallback, useMemo, useState, type ReactNode } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useStore } from "../store";
import { canThumb, mediaUrl, thumbUrl } from "../lib/api";
import { Select } from "./Select";
import { naturalCompare } from "../lib/format";
import type { MediaItem } from "../lib/types";

/** Pictures shown at a time; more on asking. */
const STEP = 120;

/**
 * A small browser for picking a picture: whole pictures in their own shape, in rows of one height
 * (each as wide as its shape makes it, so nothing is cropped and there are no bars round the tall
 * ones), the next ones in rows below, loading as they come into view. Either the pictures that
 * belong to what is being made (an album's pages, a tag's pictures) or the library's own pictures
 * (album pages left out), narrowed by folder and by name.
 */
/** What a picture dragged out of a MiniBrowser carries: its key. */
export const PICTURE_DRAG = "application/x-quire-picture";

/** `draggable`: its pictures can be dragged out (onto a scrapbook page), carrying their keys as PICTURE_DRAG. */
export function MiniBrowser({ own, ownLabel, row, onPick, action, draggable }: { own: MediaItem[]; ownLabel: string; row: number; onPick: (it: MediaItem) => void; action?: { label: ReactNode; title: string; onClick: (it: MediaItem) => void }; draggable?: boolean }) {
  const root = useStore((x) => x.root);
  const all = useStore((x) => x.allItems);
  const [scope, setScope] = useState<"own" | "library">(own.length ? "own" : "library");
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [limit, setLimit] = useState(STEP);
  // Each picture's shape once it has loaded (square until then).
  const [shapes, setShapes] = useState<Record<string, number>>({});
  const shaped = useCallback((key: string, ratio: number) => setShapes((s) => (Math.abs((s[key] ?? 0) - ratio) < 0.01 ? s : { ...s, [key]: ratio })), []);
  const library = useMemo(() => all.filter((i) => (i.kind === "image" || i.kind === "raw") && !i.albumKey), [all]);
  const folders = useMemo(() => [...new Set(library.map((i) => i.dir))].sort(naturalCompare), [library]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = scope === "own" && own.length ? own : library;
    if (scope === "library" && folder) list = list.filter((i) => i.dir === folder || i.dir.startsWith(`${folder}/`));
    if (q) list = list.filter((i) => i.name.toLowerCase().includes(q));
    return list;
  }, [scope, own, library, folder, query]);
  const src = (it: MediaItem) => (root && canThumb(it) ? thumbUrl(root, it, Math.round(row * 1.6)) : mediaUrl(it));
  const more = () => setLimit(STEP);

  return (
    <div className="mini-browser">
      <div className="mini-head">
        {own.length > 0 && (
          <span className="btn-group">
            <button className={`btn sm ${scope === "own" ? "active" : "ghost"}`} onClick={() => (setScope("own"), more())}>
              {ownLabel}
            </button>
            <button className={`btn sm ${scope === "library" ? "active" : "ghost"}`} onClick={() => (setScope("library"), more())}>
              Library
            </button>
          </span>
        )}
        {scope === "library" && folders.length > 1 && (
          <Select
            compact
            searchable
            value={folder}
            options={[{ value: "", label: "Every folder" }, ...folders.map((d) => ({ value: d, label: d || "/", indent: d ? d.split("/").length - 1 : 0 }))]}
            onChange={(f) => (setFolder(f), more())}
            title="Only this folder (and the ones in it)"
          />
        )}
        <div className="row search-field mini-search">
          <MagnifyingGlass className="dim" />
          <input className="input grow" placeholder="Name…" value={query} onChange={(e) => (setQuery(e.target.value), more())} />
        </div>
      </div>
      <div className="mini-scroll">
        {/* Justified rows: a tile grows in step with its shape, so a row's pictures share one height. */}
        <div className="mini-rows" style={{ ["--row" as string]: `${row}px` }}>
          {shown.slice(0, limit).map((it) => {
            const ratio = shapes[it.key] ?? 1;
            return (
              <div key={it.key} className="mini-tile" style={{ flexGrow: ratio, flexBasis: ratio * row, aspectRatio: String(ratio) }} title={`${it.dir ? `${it.dir}/` : ""}${it.name}`}>
                <button className="mini-pick" onClick={() => onPick(it)} draggable={draggable} onDragStart={draggable ? (ev) => ev.dataTransfer.setData(PICTURE_DRAG, it.key) : undefined}>
                  <img
                    src={src(it)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    onLoad={(e) => {
                      const im = e.currentTarget;
                      if (im.naturalWidth && im.naturalHeight) shaped(it.key, im.naturalWidth / im.naturalHeight);
                    }}
                  />
                </button>
                {action && (
                  <button className="btn sm mini-action" title={action.title} onClick={() => action.onClick(it)}>
                    {action.label}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {shown.length > limit && (
          <button className="btn sm ghost mini-more" onClick={() => setLimit(limit + STEP)}>
            Show more ({shown.length - limit} left)
          </button>
        )}
      </div>
      {!shown.length && <div className="dim small">{query.trim() ? "No picture by that name here." : "No pictures here."}</div>}
    </div>
  );
}
