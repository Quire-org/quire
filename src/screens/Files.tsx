import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useStore } from "../store";
import { api, pickFolder } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { isTypingTarget } from "../lib/hotkeys";
import { formatBytes, formatDate } from "../lib/format";
import type { DirEntryInfo, VaultProgress } from "../lib/types";
import { ArrowUp, CaretRight, DownloadSimple, File as FileIcon, FileAudio, FileCode, FilePdf, FileText, FileZip, Folder, FolderPlus, House, List, LockKey, PencilSimple, SquaresFour, Trash } from "@phosphor-icons/react";
import { mediaUrl, rawPreviewUrl } from "../lib/api";
import { videoPoster } from "../lib/poster";
import { classifyName } from "../lib/kinds";

/**
 * A plain file manager over the opened folder: every file (not only media),
 * folders, drag and drop between folders and from the desktop, rename, delete,
 * export. Works for plain folders and vaults alike; encrypted files show a lock.
 */
export function Files() {
  const s = useStore();
  const root = s.root ?? "";
  const [dir, setDir] = useState<string>(root);
  const [entries, setEntries] = useState<DirEntryInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [progress, setProgress] = useState<VaultProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "icons">(() => {
    try {
      return localStorage.getItem("mediasorter.filesView") === "list" ? "list" : "icons";
    } catch {
      return "icons";
    }
  });
  const [iconSize, setIconSize] = useState(140);
  const switchView = (v: "list" | "icons") => {
    setView(v);
    try {
      localStorage.setItem("mediasorter.filesView", v);
    } catch {
      /* ignore */
    }
  };

  const load = useCallback(async () => {
    if (!root) return;
    try {
      setEntries(await api.listDir(root, dir));
    } catch (e) {
      s.toast(String(e), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, dir]);

  useEffect(() => {
    void load();
    setSelected(new Set());
  }, [load]);

  // Files dropped from the desktop (Tauri drag-drop events carry real paths).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (ev.payload.type === "drop") void importPaths(ev.payload.paths, dropTarget ?? dir);
        if (ev.payload.type === "leave") setDropTarget(null);
      })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, dropTarget]);

  const importPaths = async (paths: string[], dest: string) => {
    if (!root || paths.length === 0) return;
    setBusy(true);
    try {
      const n = await api.fsImport(root, paths, dest, setProgress);
      s.toast(`${s.vault?.unlocked ? "Encrypted and added" : "Added"} ${n} files`, "ok");
      s.set({ allStale: true });
      await load();
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
      setProgress(null);
      setDropTarget(null);
    }
  };

  const moveTo = async (paths: string[], dest: string) => {
    if (!root || paths.length === 0 || paths.includes(dest)) return;
    setBusy(true);
    try {
      await api.fsMove(root, paths, dest);
      s.set({ allStale: true, albumsLoaded: false });
      await load();
      s.toast(`Moved ${paths.length} item${paths.length === 1 ? "" : "s"}`, "ok");
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
      setDropTarget(null);
    }
  };

  const del = async (paths: string[]) => {
    if (!root || !paths.length) return;
    if (!window.confirm(`Delete ${paths.length} item${paths.length === 1 ? "" : "s"} for good? This skips the trash.`)) return;
    setBusy(true);
    try {
      await api.fsDelete(root, paths);
      s.set({ allStale: true, albumsLoaded: false });
      await load();
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const exportSel = async (paths: string[]) => {
    if (!root || !paths.length) return;
    const dest = await pickFolder("Choose where to write the copies");
    if (!dest) return;
    setBusy(true);
    try {
      // Folders: expand to their files server-side is not available; export files only.
      const n = await api.vaultExport(root, paths, dest);
      s.toast(`Exported ${n} files`, "ok");
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  // Double-clicking a media file opens it in the viewer with its folder as the queue.
  const openFile = async (x: DirEntryInfo) => {
    if (!root || !classifyName(x.name)) return;
    try {
      const items = await api.scanDir(root, dir);
      const idx = Math.max(0, items.findIndex((i) => i.primary === x.path || i.files.includes(x.path)));
      s.openViewer(items, idx, { kind: "browse" });
    } catch (e) {
      s.toast(String(e), "error");
    }
  };

  const crumbs = useMemo(() => {
    const rel = dir.startsWith(root) ? dir.slice(root.length).split("/").filter(Boolean) : [];
    return rel.map((name, i) => ({ name, path: `${root}/${rel.slice(0, i + 1).join("/")}` }));
  }, [dir, root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || s.settingsOpen || s.trashOpen || s.driveOpen || s.backupOpen || s.vaultOpen) return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "a") {
        e.preventDefault();
        setSelected(new Set(entries.map((x) => x.path)));
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (key === "escape") {
        if (selected.size) setSelected(new Set());
        else s.openSortQueue();
      }
      if (key === "backspace" || key === "delete") void del([...selected]);
      if (key === "b") s.openBrowse();
      if (key === "a") s.openAlbums();
      if (key === "d") s.openDupes();
      if (key === "g") s.set({ settingsOpen: true });
      if (key === "h") s.toggleNav();
      if (key === "arrowup" && dir !== root) setDir(dir.slice(0, dir.lastIndexOf("/")));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, selected, dir, root, s]);

  const onDragStart = (e: DragEvent, path: string) => {
    const paths = selected.has(path) ? [...selected] : [path];
    e.dataTransfer.setData("application/x-mediasorter-paths", JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDropInto = (e: DragEvent, dest: string) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-mediasorter-paths");
    setDropTarget(null);
    if (raw) void moveTo(JSON.parse(raw) as string[], dest);
  };
  const totalBytes = entries.reduce((a, x) => a + x.size, 0);
  const pct = progress && progress.totalBytes ? Math.round((progress.bytes / progress.totalBytes) * 100) : progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className={`screen ${s.navCollapsed ? "chrome-hidden" : ""}`}>
      <TopNav current="files" />
      <div className="files" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropInto(e, dir)}>
        <div className="browse-head files-head">
          <nav className="crumbs mono">
            <button className={`btn sm ghost ${dropTarget === root ? "drop" : ""}`} onClick={() => setDir(root)} onDragOver={(e) => { e.preventDefault(); setDropTarget(root); }} onDrop={(e) => onDropInto(e, root)}>
              <House />
            </button>
            {crumbs.map((c) => (
              <span key={c.path} className="crumb">
                <CaretRight className="faint" />
                <button className={`btn sm ghost ${dropTarget === c.path ? "drop" : ""}`} onClick={() => setDir(c.path)} onDragOver={(e) => { e.preventDefault(); setDropTarget(c.path); }} onDrop={(e) => onDropInto(e, c.path)}>
                  {c.name}
                </button>
              </span>
            ))}
          </nav>
          <span className="mono dim small grow">
            {entries.filter((x) => x.isDir).length} folders · {entries.filter((x) => !x.isDir).length} files · {formatBytes(totalBytes)}
            {s.vault?.unlocked && (
              <span className="accent-text">
                {" "}
                · <LockKey /> vault
              </span>
            )}
          </span>
          <button className="btn sm ghost" disabled={dir === root} onClick={() => setDir(dir.slice(0, dir.lastIndexOf("/")))} title="Up (↑)">
            <ArrowUp />
          </button>
          <span className="chips">
            <button className={`btn sm ${view === "icons" ? "active" : "ghost"}`} onClick={() => switchView("icons")} title="Icon view">
              <SquaresFour />
            </button>
            <button className={`btn sm ${view === "list" ? "active" : "ghost"}`} onClick={() => switchView("list")} title="List view">
              <List />
            </button>
          </span>
          {view === "icons" && <input type="range" min={90} max={260} step={10} value={iconSize} onChange={(e) => setIconSize(Number(e.target.value))} title="Icon size" style={{ width: 90 }} />}
          <button className="btn sm" onClick={() => setNewFolder("")}>
            <FolderPlus /> New folder
          </button>
          {selected.size > 0 && (
            <>
              <span className="mono accent-text small">{selected.size} selected</span>
              <button className="btn sm" disabled={busy} onClick={() => void exportSel([...selected].filter((p) => !entries.find((x) => x.path === p)?.isDir))} title="Write readable copies elsewhere">
                <DownloadSimple /> Export
              </button>
              <button className="btn sm danger" disabled={busy} onClick={() => void del([...selected])}>
                <Trash /> Delete
              </button>
            </>
          )}
        </div>

        {progress && (
          <div className="progress files-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="mono faint small ellipsis">
              {progress.done}/{progress.total} · {progress.current}
            </div>
          </div>
        )}

        <div className={view === "icons" ? "file-icons" : "file-list"} style={view === "icons" ? { gridTemplateColumns: `repeat(auto-fill, minmax(${iconSize}px, 1fr))` } : undefined}>
          {newFolder !== null && (
            <form
              className="file-row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!root) return;
                try {
                  await api.fsMkdir(root, dir, newFolder);
                  setNewFolder(null);
                  await load();
                } catch (err) {
                  s.toast(String(err), "error");
                }
              }}
            >
              <Folder className="file-icon" />
              <input className="input grow" autoFocus placeholder="Folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} onBlur={() => !newFolder && setNewFolder(null)} />
              <button className="btn sm primary" type="submit" disabled={!newFolder.trim()}>
                Create
              </button>
              <button className="btn sm ghost" type="button" onClick={() => setNewFolder(null)}>
                Cancel
              </button>
            </form>
          )}
          {entries.map((x) => view === "icons" ? (
            <FileTile
              key={x.path}
              entry={x}
              size={iconSize}
              selected={selected.has(x.path)}
              drop={dropTarget === x.path}
              onDragStart={(e) => onDragStart(e, x.path)}
              onDragOver={(e) => {
                if (x.isDir) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(x.path);
                }
              }}
              onDragLeave={() => dropTarget === x.path && setDropTarget(null)}
              onDrop={(e) => {
                if (x.isDir) {
                  e.stopPropagation();
                  onDropInto(e, x.path);
                }
              }}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  const n = new Set(selected);
                  if (n.has(x.path)) n.delete(x.path);
                  else n.add(x.path);
                  setSelected(n);
                } else setSelected(new Set([x.path]));
              }}
              onDoubleClick={() => (x.isDir ? setDir(x.path) : openFile(x))}
              onRename={() => {
                setRenaming(x.path);
                setRenameTo(x.name);
              }}
              renaming={renaming === x.path}
              renameTo={renameTo}
              setRenameTo={setRenameTo}
              commitRename={async () => {
                if (!root) return;
                try {
                  await api.fsRename(root, x.path, renameTo);
                  setRenaming(null);
                  s.set({ allStale: true, albumsLoaded: false });
                  await load();
                } catch (err) {
                  s.toast(String(err), "error");
                }
              }}
              cancelRename={() => setRenaming(null)}
            />
          ) : (
            <div
              key={x.path}
              className={`file-row ${selected.has(x.path) ? "selected" : ""} ${dropTarget === x.path ? "drop" : ""}`}
              draggable
              onDragStart={(e) => onDragStart(e, x.path)}
              onDragOver={(e) => {
                if (x.isDir) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropTarget(x.path);
                }
              }}
              onDragLeave={() => dropTarget === x.path && setDropTarget(null)}
              onDrop={(e) => {
                if (x.isDir) {
                  e.stopPropagation();
                  onDropInto(e, x.path);
                }
              }}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  const n = new Set(selected);
                  if (n.has(x.path)) n.delete(x.path);
                  else n.add(x.path);
                  setSelected(n);
                } else setSelected(new Set([x.path]));
              }}
              onDoubleClick={() => (x.isDir ? setDir(x.path) : openFile(x))}
            >
              {x.isDir ? <Folder className="file-icon" /> : <FileIcon className="file-icon" />}
              {renaming === x.path ? (
                <form
                  className="grow row"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!root) return;
                    try {
                      await api.fsRename(root, x.path, renameTo);
                      setRenaming(null);
                      s.set({ allStale: true, albumsLoaded: false });
                      await load();
                    } catch (err) {
                      s.toast(String(err), "error");
                    }
                  }}
                >
                  <input className="input grow" autoFocus value={renameTo} onChange={(e) => setRenameTo(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setRenaming(null)} />
                  <button className="btn sm primary" type="submit">
                    Rename
                  </button>
                </form>
              ) : (
                <span className="file-name ellipsis" title={x.path}>
                  {x.name}
                </span>
              )}
              {x.encrypted && (
                <span className="faint" title="Encrypted">
                  <LockKey />
                </span>
              )}
              <span className="mono faint small file-meta">{x.isDir ? `${x.count} files` : formatBytes(x.size)}</span>
              <span className="mono faint small file-meta">{x.modified ? formatDate(x.modified) : ""}</span>
              <span className="file-actions">
                <button
                  className="btn sm ghost"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming(x.path);
                    setRenameTo(x.name);
                  }}
                >
                  <PencilSimple />
                </button>
                <button
                  className="btn sm ghost"
                  title="Delete for good"
                  onClick={(e) => {
                    e.stopPropagation();
                    void del([x.path]);
                  }}
                >
                  <Trash />
                </button>
              </span>
            </div>
          ))}
          {entries.length === 0 && newFolder === null && <div className="dim file-empty">Empty folder. Drop files here to add them{s.vault?.unlocked ? " (they are encrypted on the way in)" : ""}.</div>}
        </div>
      </div>
    </div>
  );
}


/** Icon-view tile: thumbnail for media, a typed glyph for everything else. */
function FileTile(props: {
  entry: DirEntryInfo;
  size: number;
  selected: boolean;
  drop: boolean;
  renaming: boolean;
  renameTo: string;
  setRenameTo: (v: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  onRename: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const { entry: x, size } = props;
  const kind = x.isDir ? null : classifyName(x.name);
  const [thumb, setThumb] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && setVisible(true)), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !kind) return;
    let alive = true;
    const item = { primary: x.path, vaultId: x.vaultId ?? undefined };
    const url = kind === "raw" ? rawPreviewUrl(x.path) : kind === "video" ? videoPoster(mediaUrl(item)) : Promise.resolve(mediaUrl(item));
    url.then((u) => alive && setThumb(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, kind, x.path, x.encrypted]);

  const Glyph = x.isDir ? Folder : /\.(mp3|wav|flac|m4a|aac|ogg)$/i.test(x.name) ? FileAudio : /\.(pdf)$/i.test(x.name) ? FilePdf : /\.(zip|rar|7z|gz|tar|dmg)$/i.test(x.name) ? FileZip : /\.(json|xml|js|ts|py|rs|html|css|sh|yml|yaml|toml)$/i.test(x.name) ? FileCode : /\.(txt|md|rtf|csv|log)$/i.test(x.name) ? FileText : FileIcon;

  return (
    <div
      ref={ref}
      className={`file-tile ${props.selected ? "selected" : ""} ${props.drop ? "drop" : ""}`}
      draggable
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      title={x.path}
    >
      <div className="file-tile-art" style={{ height: size * 0.75 }}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <Glyph size={Math.round(size * 0.42)} weight={x.isDir ? "fill" : undefined} className="file-glyph" />}
        {x.isDir && <span className="badge accent2 tile-count">{x.count}</span>}
        {x.encrypted && (
          <span className="tile-lock" title="Encrypted">
            <LockKey />
          </span>
        )}
        {!x.isDir && !kind && <span className="badge tile-ext">{x.name.split(".").pop()?.toUpperCase().slice(0, 5)}</span>}
      </div>
      {props.renaming ? (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            props.commitRename();
          }}
        >
          <input className="input grow" autoFocus value={props.renameTo} onChange={(e) => props.setRenameTo(e.target.value)} onKeyDown={(e) => e.key === "Escape" && props.cancelRename()} onBlur={props.cancelRename} />
        </form>
      ) : (
        <div className="file-tile-name" onDoubleClick={(e) => { e.stopPropagation(); props.onRename(); }} title="Double-click to rename">
          {x.name}
        </div>
      )}
      <div className="mono faint small">{x.isDir ? `${x.count} files` : formatBytes(x.size)}</div>
    </div>
  );
}
