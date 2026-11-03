import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { ArrowSquareOut, ArrowUp, CaretRight, Folder, FolderPlus, House, MagnifyingGlass } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { useStore } from "../store";
import { api, canThumb, pickFolder, thumbUrl } from "../lib/api";
import { fromRoot, within } from "../lib/filing";
import { naturalCompare } from "../lib/format";
import type { DirEntryInfo, Library, MediaItem } from "../lib/types";

/** Pictures shown on a folder's tile, from inside it. */
const PREVIEWS = 4;

interface Pick {
  title: string;
  /** Where it opens: a folder in the library (the library's top when not in it). */
  start?: string | null;
  /** The choose button's words (else "Choose" and the folder's name). */
  confirm?: string;
  /** The library's top can be chosen too (to move something there). */
  allowTop?: boolean;
  /** A folder outside the library can be chosen too, in the system's dialog. */
  outside?: boolean;
  /** Why a folder (by its path from the root) can't be chosen, when it can't. */
  why?: (rel: string) => string | null;
}

const usePick = create<{ open: (Pick & { resolve: (abs: string | null) => void }) | null }>(() => ({ open: null }));

/**
 * A folder of the library chosen in the app's own browser: the system's dialog can't see inside a
 * vault (its folders are kept encrypted). Its full path, or null when cancelled.
 */
export function pickLibraryFolder(p: Pick): Promise<string | null> {
  // One still open is cancelled before the next shows.
  usePick.getState().open?.resolve(null);
  return new Promise((resolve) => usePick.setState({ open: { ...p, resolve } }));
}

/** What can't be a sort target: the trash, an album folder, a target already. */
export const notForTarget = (library: Library | null, root: string) => (rel: string) =>
  !library ? null : within(rel, library.trashDir) ? "The trash" : library.albumRoots.some((r) => within(rel, fromRoot(root, r))) ? "In an album folder" : library.targets.some((t) => t.path === rel) ? "A target folder already" : null;

/** What can't be an album folder: the trash, one already (or a folder in one). */
export const notForAlbums = (library: Library | null, root: string) => (rel: string) =>
  !library ? null : within(rel, library.trashDir) ? "The trash" : library.albumRoots.some((r) => within(rel, fromRoot(root, r))) ? "An album folder already, or in one" : null;

/** Mounted once (App): the folder browser asked for, if any. */
export function FolderBrowserHost() {
  const p = usePick((s) => s.open);
  const root = useStore((x) => x.root);
  useEffect(() => {
    // No library open: nothing to choose in.
    if (p && !root) {
      usePick.setState({ open: null });
      p.resolve(null);
    }
  }, [p, root]);
  if (!p || !root) return null;
  const answer = (abs: string | null) => {
    usePick.setState({ open: null });
    p.resolve(abs);
  };
  return <FolderBrowser pick={p} root={root} onAnswer={answer} />;
}

/**
 * The library's folders as Files shows them, small: where you are as a trail, the folders in it as
 * tiles with a few of the pictures inside, opened by a click; the one you are in is chosen. A new
 * folder can be made in place. ⌫ (with nothing typed) goes up, ⏎ chooses.
 */
function FolderBrowser({ pick, root, onAnswer }: { pick: Pick; root: string; onAnswer: (abs: string | null) => void }) {
  const top = root.replace(/\/+$/, "");
  const library = useStore((x) => x.library);
  const all = useStore((x) => x.allItems);
  const startAt = (() => {
    const s = pick.start ? (pick.start.startsWith("/") ? pick.start : `${top}/${pick.start}`) : top;
    return s === top || s.startsWith(`${top}/`) ? s.replace(/\/+$/, "") : top;
  })();
  const [dir, setDir] = useState(startAt);
  const [entries, setEntries] = useState<DirEntryInfo[] | null>(null);
  const [q, setQ] = useState("");
  const [making, setMaking] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const rel = fromRoot(top, dir) === top ? "" : fromRoot(top, dir);

  useEffect(() => {
    void useStore.getState().loadAll();
  }, []);
  useEffect(() => {
    let live = true;
    setEntries(null);
    api
      .listDir(root, dir)
      .then((es) => live && setEntries(es.filter((e) => e.isDir && !e.name.startsWith(".") && fromRoot(top, e.path) !== library?.trashDir).sort((a, b) => naturalCompare(a.name, b.name))))
      .catch(() => live && setEntries([]));
    return () => {
      live = false;
    };
  }, [root, dir, top, library?.trashDir, tick]);

  // A few pictures from inside each folder here (at any depth), for its tile.
  const previews = useMemo(() => {
    const out = new Map<string, MediaItem[]>();
    const under = `${dir}/`;
    for (const it of all) {
      if (!it.primary.startsWith(under) || !canThumb(it)) continue;
      const rest = it.primary.slice(under.length);
      const cut = rest.indexOf("/");
      if (cut < 0) continue;
      const child = rest.slice(0, cut);
      const list = out.get(child) ?? [];
      if (list.length < PREVIEWS) out.set(child, [...list, it]);
    }
    return out;
  }, [all, dir]);

  const crumbs = rel ? rel.split("/").map((name, i, parts) => ({ name, path: `${top}/${parts.slice(0, i + 1).join("/")}` })) : [];
  const shown = (entries ?? []).filter((e) => !q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase()));
  const reason = !rel && !pick.allowTop ? "The library itself" : rel && pick.why ? pick.why(rel) : null;
  const name = crumbs.length ? crumbs[crumbs.length - 1].name : (top.split("/").pop() ?? top);
  const go = (to: string) => {
    setDir(to);
    setQ("");
    setMaking(null);
  };
  const up = () => dir !== top && go(dir.slice(0, dir.lastIndexOf("/")) || top);
  const make = async () => {
    const n = making?.trim();
    if (!n) return setMaking(null);
    try {
      const made = await api.fsMkdir(root, dir, n);
      // Into the folder just made: it is the one chosen then.
      go(typeof made === "string" && made ? made : `${dir}/${n}`);
      setTick((t) => t + 1);
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  };
  const outside = async () => {
    const got = await pickFolder(pick.title, top);
    if (got) onAnswer(got);
  };

  return (
    <Modal title={pick.title} onClose={() => onAnswer(null)} wide>
      <div className="folder-browser">
        <div className="row folder-browser-head">
          <nav className="crumbs mono grow">
            <button className="btn sm ghost" onClick={() => go(top)} title={`The library's top (${name})`}>
              <House />
            </button>
            {crumbs.map((c) => (
              <span key={c.path} className="crumb">
                <CaretRight className="faint" />
                <button className="btn sm ghost" onClick={() => go(c.path)}>
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
          <button className="btn sm ghost" onClick={up} disabled={dir === top} title="Up (⌫)">
            <ArrowUp />
          </button>
          <div className="row search-field folder-browser-find">
            <MagnifyingGlass className="dim" />
            <input
              className="input grow"
              autoFocus
              placeholder="Find a folder here…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !q) {
                  e.preventDefault();
                  up();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  // What is typed names one folder here: into it; else this one is chosen.
                  if (q.trim() && shown.length === 1) go(shown[0].path);
                  else if (!q.trim() && !reason) onAnswer(dir);
                }
              }}
            />
          </div>
          <button className="btn sm" onClick={() => setMaking("")} title="A new folder in this one">
            <FolderPlus /> New folder
          </button>
        </div>
        {making !== null && (
          <form
            className="row folder-browser-new"
            onSubmit={(e) => {
              e.preventDefault();
              void make();
            }}
          >
            <Folder className="file-glyph" />
            <input className="input grow" autoFocus placeholder="Its name" value={making} onChange={(e) => setMaking(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setMaking(null))} />
            <button className="btn sm primary" type="submit" disabled={!making.trim()}>
              Make it
            </button>
            <button className="btn sm ghost" type="button" onClick={() => setMaking(null)}>
              Cancel
            </button>
          </form>
        )}
        <div className="folder-browser-grid">
          {shown.map((e) => {
            const pics = previews.get(e.name) ?? [];
            const note = pick.why?.(fromRoot(top, e.path));
            return (
              <button key={e.path} className="file-tile folder-card" onClick={() => go(e.path)} title={fromRoot(top, e.path)}>
                <div className="file-tile-art folder-card-art">
                  {pics.length ? (
                    <div className={`folder-mosaic n${pics.length}`}>
                      {pics.map((it) => (
                        <img key={it.key} src={thumbUrl(root, it, 160)} alt="" loading="lazy" decoding="async" draggable={false} />
                      ))}
                    </div>
                  ) : (
                    <Folder size={40} weight="fill" className="file-glyph" />
                  )}
                  {e.count > 0 && <span className="badge accent2 tile-count">{e.count}</span>}
                </div>
                <span className="file-tile-name">{e.name}</span>
                {note && <span className="small faint ellipsis">{note}</span>}
              </button>
            );
          })}
          {entries && !shown.length && <div className="dim small folder-browser-empty">{q.trim() ? "No folder by that name here." : "No folders in here."}</div>}
          {!entries && <div className="dim small folder-browser-empty">Looking…</div>}
        </div>
        <div className="row pop-actions">
          <span className="mono small ellipsis grow" title={dir}>
            {rel || name}
            {reason && <span className="warn-text"> · {reason}</span>}
          </span>
          {pick.outside && (
            <button className="btn ghost" onClick={() => void outside()} title="A folder that isn't in the library, in the system's dialog">
              <ArrowSquareOut /> Outside the library…
            </button>
          )}
          <button className="btn ghost" onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!reason} onClick={() => onAnswer(dir)}>
            {pick.confirm ?? `Choose “${name}”`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
