import { useEffect, useMemo, useState } from "react";
import { Folder, FolderPlus } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { useStore } from "../store";
import { api } from "../lib/api";
import { folderUnder, fromRoot, ownFolders, typedFolders } from "../lib/filing";
import type { Target } from "../lib/types";

/**
 * The folders of yours from `base` down (it first), as paths from the root; null while they are
 * read. The trash and album folders aren't among them, nor the year and day folders filing makes.
 */
export function useOwnFolders(base: string | undefined): string[] | null {
  const root = useStore((x) => x.root);
  const trash = useStore((x) => x.library?.trashDir);
  const albumRoots = useStore((x) => x.library?.albumRoots);
  const [known, setKnown] = useState<{ base: string; folders: string[] } | null>(null);
  useEffect(() => {
    if (!root || !base) return;
    let live = true;
    const skip = new Set([trash ?? "", ...(albumRoots ?? []).map((r) => fromRoot(root, r))]);
    void ownFolders(base, (d) => api.listDir(root, d), (abs) => fromRoot(root, abs), skip).then((folders) => live && setKnown({ base, folders }));
    return () => {
      live = false;
    };
  }, [root, trash, albumRoots, base]);
  return known && known.base === base ? known.folders : null;
}

/** A folder of yours as it reads, from the target's name: `Professional › Weddings › James & Amy`. */
export const folderLabel = (target: Target, path: string) => [target.name, ...path.slice(target.path.length + 1).split("/").filter(Boolean)].join(" › ");

/**
 * Into which folder of yours in a target that files by the day: found by typing, or named new
 * (`Paris trip`, `Weddings > James & Amy`); what goes in is filed by the day inside it. ⇧ and the
 * target's key in the viewer (or ⇧-click on its button) open it.
 */
export function OwnFolderPicker({ target, onPick, onClose }: { target: Target; onPick: (folder: string) => void; onClose: () => void }) {
  const known = useOwnFolders(target.path);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const typed = useMemo(() => typedFolders(q), [q]);
  const rows = useMemo(() => {
    const all = known ?? [target.path];
    const rel = (p: string) => p.slice(target.path.length + 1).split("/").join(" › ").toLowerCase();
    if (!typed.names.length) return all.map((path) => ({ path, made: false }));
    const needle = typed.names.join(" › ").toLowerCase();
    const named = folderUnder(target.path, typed.names, all);
    const there = all.includes(named);
    // The folder named first, then those whose path has what is typed; one named that isn't there yet last, to make.
    const found = all.filter((p) => p !== target.path && p !== named && rel(p).includes(needle));
    // A new one only once the folders there are read: else one there in another case would be made again.
    const make = !there && !typed.bad && !!known;
    return [...(there ? [{ path: named, made: false }] : []), ...found.map((path) => ({ path, made: false })), ...(make ? [{ path: named, made: true }] : [])];
  }, [known, target.path, typed]);
  const pickAt = Math.min(at, Math.max(0, rows.length - 1));
  useEffect(() => setAt(0), [q]);

  return (
    <Modal title={`Into ${target.name}`} onClose={onClose}>
      <div className="own-folder-picker">
        <input
          className="input"
          autoFocus
          placeholder="Find a folder, or name a new one: Weddings > James & Amy"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setAt(Math.max(0, Math.min(rows.length - 1, pickAt + (e.key === "ArrowDown" ? 1 : -1))));
            } else if (e.key === "Enter" && rows[pickAt]) onPick(rows[pickAt].path);
            else if (e.key === "Escape") onClose();
          }}
        />
        <div className="own-folder-list" role="listbox" aria-label="Folders">
          {rows.map((r, i) => (
            <button key={`${r.made}${r.path}`} role="option" aria-selected={i === pickAt} className={`own-folder-row ${i === pickAt ? "on" : ""}`} onClick={() => onPick(r.path)} onMouseEnter={() => setAt(i)}>
              {r.made ? <FolderPlus /> : <Folder />}
              <span className="grow ellipsis">{r.made ? `New folder: ${folderLabel(target, r.path)}` : folderLabel(target, r.path)}</span>
            </button>
          ))}
          {!known && <div className="small dim">Reading its folders…</div>}
        </div>
        {typed.bad ? (
          <div className="small warn-text">“{typed.bad}” would read as one of the year or day folders filing makes: name it something else.</div>
        ) : (
          <div className="small faint">Filed by the day inside the folder picked. ↑↓ choose, ⏎ moves it, Esc closes.</div>
        )}
      </div>
    </Modal>
  );
}
