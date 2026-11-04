import React, { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { forgetGone, useStore } from "../store";
import { api, pickFolder, canThumb, storedPath, thumbUrl } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { pickLibraryFolder } from "../components/FolderBrowser";
import { Modal } from "../components/Modal";
import { TagPicker } from "../components/TagPicker";
import { useTags } from "../tagsStore";
import { Tag as TagIcon } from "@phosphor-icons/react";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { formatBytes, formatDate } from "../lib/format";
import type { DirEntryInfo, VaultProgress } from "../lib/types";
import { ArrowUp, CaretRight, FolderOpen, DownloadSimple, Tray, File as FileIcon, FileAudio, FileCode, FilePdf, FileText, FileZip, FilmStrip, Folder, FolderPlus, House, List, LockKey, PencilSimple, Play, SquaresFour, Trash } from "@phosphor-icons/react";
import { mediaUrl, rawPreviewUrl } from "../lib/api";
import { videoPoster } from "../lib/poster";
import { classifyName } from "../lib/kinds";
import { dateNamedInBucket, fromRoot, within } from "../lib/filing";

/**
 * A folder made or renamed in a bucket with a name like a year or a day: the app reads it as one of
 * the folders filing makes, so it isn't offered as a folder to file into. Said, not refused: Files
 * does as asked, like Finder.
 */
function sayIfDateNamed(root: string, abs: string, isDir = true) {
  const s = useStore.getState();
  const name = isDir && s.library ? dateNamedInBucket(storedPath(root, abs), s.library.targets) : null;
  if (name) s.toast(`“${name}” reads as one of the year or day folders filing makes, so Import and Sort won't offer it as a folder of yours`, "warn");
}
import { ask } from "../components/Confirm";

/**
 * A plain file manager over the opened folder: every file (not only media),
 * folders, drag and drop between folders and from the desktop, rename, delete,
 * export. Works for plain folders and vaults alike; encrypted files show a lock.
 */
export function Files() {
  const s = useStore(useShallow((x) => ({ allItems: x.allItems, backupOpen: x.backupOpen, driveOpen: x.driveOpen, loadAll: x.loadAll, navCollapsed: x.navCollapsed, openAlbums: x.openAlbums, openBrowse: x.openBrowse, openDupes: x.openDupes, openSortQueue: x.openSortQueue, openViewer: x.openViewer, pluginsOpen: x.pluginsOpen, relocatePaths: x.relocatePaths, root: x.root, set: x.set, settingsOpen: x.settingsOpen, toast: x.toast, toggleChrome: x.toggleChrome, trashOpen: x.trashOpen, vault: x.vault, vaultOpen: x.vaultOpen })));
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
  const [ctx, setCtx] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const [tagging, setTagging] = useState<string | null>(null);
  /** Where a ⇧-click selects from: the item last clicked, and what else was selected then. */
  const anchor = useRef<{ path: string; base: Set<string> } | null>(null);
  /** The box drawn to select, and whether one was just let go (its click selects nothing). */
  const box = useRef<HTMLDivElement>(null);
  const boxed = useRef(false);
  /** Every item of the library inside a folder (by absolute path), subfolders included. */
  const itemsUnder = (absDir: string) => {
    if (!root) return [];
    const rel = absDir.startsWith(root) ? absDir.slice(root.length).replace(/^\/+/, "") : absDir;
    return s.allItems.filter((i) => (i.kind === "image" || i.kind === "video") && (rel === "" || i.dir === rel || i.dir.startsWith(`${rel}/`)));
  };
  useEffect(() => {
    void s.loadAll();
    void useTags.getState().load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  /** Right-click on an entry: it, or the selection it is part of. */
  const entryMenu = (e: React.MouseEvent, x: DirEntryInfo) => {
    e.preventDefault();
    e.stopPropagation();
    const paths = selected.has(x.path) ? [...selected] : [x.path];
    if (!selected.has(x.path)) {
      setSelected(new Set([x.path]));
      anchor.current = { path: x.path, base: new Set() };
    }
    const many = paths.length > 1;
    setCtx({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: x.isDir ? <><FolderOpen /> Open</> : <><FileIcon /> Open</>, onClick: () => (x.isDir ? setDir(x.path) : openFile(x)), disabled: many },
        { label: <><PencilSimple /> Rename…</>, onClick: () => setRenaming(x.path), disabled: many },
        { label: <><ArrowUp /> Move to…</>, onClick: () => void chooseAndMove(paths) },
        ...(x.isDir && !many ? [{ label: <><TagIcon /> Tag everything in this folder…</>, onClick: () => setTagging(x.path) }] : []),
        { label: <><FolderPlus /> New folder here</>, onClick: () => setNewFolder("") },
        { separator: true },
        { label: <><Trash /> Delete{many ? ` ${paths.length}` : ""}…</>, danger: true, onClick: () => void del(paths) },
      ],
    });
  };
  const [view, setView] = useState<"list" | "icons">(() => {
    try {
      return localStorage.getItem("quire.filesView") === "list" ? "list" : "icons";
    } catch {
      return "icons";
    }
  });
  const [iconSize, setIconSize] = useState(140);
  const switchView = (v: "list" | "icons") => {
    setView(v);
    try {
      localStorage.setItem("quire.filesView", v);
    } catch {
      /* ignore */
    }
  };

  /** The folder whose entries are listed now (the one asked for may still be loading). */
  const [listed, setListed] = useState<string | null>(null);
  // Only the folder asked for last is listed: an earlier one answering late is left out.
  const asked = useRef("");
  const load = useCallback(async () => {
    if (!root) return;
    asked.current = dir;
    try {
      const got = await api.listDir(root, dir);
      if (asked.current !== dir) return;
      setEntries(got);
      setListed(dir);
    } catch (e) {
      s.toast(String(e), "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, dir]);

  useEffect(() => {
    void load();
    setSelected(new Set());
    anchor.current = null;
  }, [load]);

  // A file shown here from elsewhere (Show in Files): its folder opened, the file selected and scrolled to.
  const show = useStore((x) => x.filesShow);
  const showIn = show && root ? show.slice(0, show.lastIndexOf("/")) || root : null;
  useEffect(() => {
    if (showIn) setDir(showIn);
  }, [showIn]);
  useEffect(() => {
    if (!show || listed !== showIn) return;
    useStore.setState({ filesShow: null });
    if (!entries.some((x) => x.path === show)) return s.toast(`${show.split("/").pop()} isn't in its folder any more`, "error");
    setSelected(new Set([show]));
    anchor.current = { path: show, base: new Set() };
    requestAnimationFrame(() => document.querySelector(`[data-path="${CSS.escape(show)}"]`)?.scrollIntoView({ block: "center" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, showIn, listed, entries]);

  // Files dropped from the desktop come in through the web drop event (the window's own drop
  // handling is off, or in-page drags never fire on macOS): their bytes are read here and written
  // through the app, encrypted on the way in when the folder is a vault.
  const importDropped = async (files: FileList, dest: string) => {
    if (!root || !files.length) return;
    setBusy(true);
    let n = 0;
    try {
      const rel = dest.startsWith(root) ? dest.slice(root.length).replace(/^\/+/, "") : dest;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setProgress({ done: i, total: files.length, bytes: 0, totalBytes: 0, current: f.name });
        const bytes = new Uint8Array(await f.arrayBuffer());
        let b64 = "";
        for (let o = 0; o < bytes.length; o += 0x8000) b64 += String.fromCharCode(...bytes.subarray(o, o + 0x8000));
        await api.writeMediaFile(root, rel, f.name, btoa(b64));
        n++;
      }
      s.toast(`${s.vault?.unlocked ? "Encrypted and added" : "Added"} ${n} file${n === 1 ? "" : "s"}`, "ok");
      s.set({ allStale: true, albumsLoaded: false });
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
      const moved = await api.fsMove(root, paths, dest).catch((e) => {
        // Some moved before one failed: those are followed all the same (the backend names them).
        const m = /^MovedSome:(\[.*\]):([\s\S]*)$/.exec(String(e).replace(/^Error: /, ""));
        if (!m) throw e;
        const done = JSON.parse(m[1]) as string[];
        s.toast(m[2], "error");
        return done;
      });
      // The app's lists and the viewer keep pointing at the files, under their new paths.
      s.relocatePaths(paths.map((from, i) => [from, moved[i]] as [string, string]).filter(([, to]) => !!to));
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

  // Where to, in the app's own folder browser (it sees into a vault); never into one of those moving.
  const chooseAndMove = async (paths: string[]) => {
    if (!root) return;
    const dest = await pickLibraryFolder({
      title: `Move ${paths.length} item${paths.length === 1 ? "" : "s"} into…`,
      start: dir,
      allowTop: true,
      confirm: "Move here",
      why: (rel) => (paths.some((p) => within(rel, fromRoot(root, p))) ? "One of those being moved" : null),
    });
    if (dest) await moveTo(paths, dest);
  };

  const del = async (paths: string[]) => {
    if (!root || !paths.length) return;
    const sure = await ask({
      title: "Delete for good?",
      message: `${paths.length} item${paths.length === 1 ? "" : "s"} will be deleted permanently. This skips the trash and can't be undone.`,
      confirm: "Delete for good",
      danger: true,
      safeDefault: true,
    });
    if (!sure) return;
    setBusy(true);
    try {
      await api.fsDelete(root, paths);
      // Gone for good: what is known of them (and of everything in a folder deleted) is forgotten,
      // rather than waiting for a later file of the same name to inherit it.
      forgetGone({ keys: [], folders: paths.map((p) => storedPath(root, p)) });
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
      if (isTypingTarget(e.target) || dialogOpen() || s.settingsOpen || s.trashOpen || s.driveOpen || s.backupOpen || s.vaultOpen || s.pluginsOpen) return;
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
      if (key === "k") useStore.getState().openScrapbook();
      if (key === "p") useStore.getState().openPeople();
      if (key === "w") useStore.getState().openArtists();
      if (key === "g") s.set({ settingsOpen: true });
      if (key === "h") s.toggleChrome();
      if (key === "arrowup" && dir !== root) setDir(dir.slice(0, dir.lastIndexOf("/")));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, selected, dir, root, s]);

  const onDragStart = (e: DragEvent, path: string) => {
    const paths = selected.has(path) ? [...selected] : [path];
    e.dataTransfer.setData("application/x-quire-paths", JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDropInto = (e: DragEvent, dest: string) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-quire-paths");
    setDropTarget(null);
    if (raw) void moveTo(JSON.parse(raw) as string[], dest);
    else if (e.dataTransfer.files?.length) void importDropped(e.dataTransfer.files, dest);
  };

  /** A click on an entry: it alone; ⌘ adds or takes it away; ⇧ everything from the last one clicked to it. */
  const pick = (e: React.MouseEvent, x: DirEntryInfo) => {
    if (boxed.current) return;
    const from = anchor.current ? entries.findIndex((y) => y.path === anchor.current!.path) : -1;
    if (e.shiftKey && from >= 0) {
      const to = entries.indexOf(x);
      const n = new Set(anchor.current!.base);
      for (const y of entries.slice(Math.min(from, to), Math.max(from, to) + 1)) n.add(y.path);
      setSelected(n);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      const n = new Set(selected);
      if (n.has(x.path)) n.delete(x.path);
      else n.add(x.path);
      setSelected(n);
      const base = new Set(n);
      base.delete(x.path);
      anchor.current = { path: x.path, base };
    } else {
      setSelected(new Set([x.path]));
      anchor.current = { path: x.path, base: new Set() };
    }
  };

  /**
   * Dragging from empty space (or a list row's blank part) draws a box: what it touches is selected,
   * added to the selection with ⇧, flipped with ⌘. Near the top or bottom edge the list scrolls on.
   */
  const startBox = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.button !== 0 || t.closest("[draggable='true'], button, input, form, a")) return;
    const el = e.currentTarget;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const mode = e.shiftKey ? "add" : e.metaKey || e.ctrlKey ? "flip" : "new";
    const base = mode === "new" ? new Set<string>() : new Set(selected);
    // A click on nothing clears the selection, as in Finder.
    if (mode === "new" && !t.closest("[data-path]")) {
      setSelected(new Set());
      anchor.current = null;
    }
    const height = el.scrollHeight;
    /** A point on screen as a place in the list, scrolled part included, kept inside it. */
    const inside = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(el.clientWidth, cx - r.left - el.clientLeft + el.scrollLeft)),
        y: Math.max(0, Math.min(height, cy - r.top - el.clientTop + el.scrollTop)),
      };
    };
    const spots = Array.from(el.querySelectorAll<HTMLElement>("[data-path]")).map((n) => {
      const b = n.getBoundingClientRect();
      const at = inside(b.left, b.top);
      return { path: n.dataset.path!, x: at.x, y: at.y, w: b.width, h: b.height };
    });
    const start = inside(e.clientX, e.clientY);
    let pointer = { x: e.clientX, y: e.clientY };
    let drawing = false;
    let shown: string | null = null;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const r = el.getBoundingClientRect();
      const edge = 28;
      const over = pointer.y < r.top + edge ? pointer.y - (r.top + edge) : pointer.y > r.bottom - edge ? pointer.y - (r.bottom - edge) : 0;
      if (drawing && over) el.scrollTop += Math.max(-30, Math.min(30, over / 2));
      const p = inside(pointer.x, pointer.y);
      if (!drawing && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
      drawing = true;
      const [x0, x1, y0, y1] = [Math.min(start.x, p.x), Math.max(start.x, p.x), Math.min(start.y, p.y), Math.max(start.y, p.y)];
      Object.assign(box.current!.style, { display: "block", left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      const hits = spots.filter((o) => o.x < x1 && o.x + o.w > x0 && o.y < y1 && o.y + o.h > y0).map((o) => o.path);
      const key = hits.join("\n");
      if (key === shown) return;
      shown = key;
      const n = new Set(base);
      for (const h of hits) {
        if (mode === "flip" && base.has(h)) n.delete(h);
        else n.add(h);
      }
      setSelected(n);
      if (hits.length) anchor.current = { path: hits[0], base: n };
    };
    const move = (ev: MouseEvent) => void (pointer = { x: ev.clientX, y: ev.clientY });
    const end = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      if (box.current) box.current.style.display = "";
      if (!drawing) return;
      // The click this makes is the box's, not a pick; the next press starts afresh.
      boxed.current = true;
      window.addEventListener("mousedown", () => (boxed.current = false), { capture: true, once: true });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    frame = requestAnimationFrame(tick);
  };
  const totalBytes = entries.reduce((a, x) => a + x.size, 0);
  const pct = progress && progress.totalBytes ? Math.round((progress.bytes / progress.totalBytes) * 100) : progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className={`screen ${s.navCollapsed ? "chrome-hidden" : ""}`}>
      <TopNav current="files" />
      <ContextMenu at={ctx?.at ?? null} items={ctx?.items ?? []} onClose={() => setCtx(null)} />
      {tagging !== null && (
        <Modal title={`Tag everything in ${tagging.split("/").filter(Boolean).pop() || "/"}`} onClose={() => setTagging(null)}>
          <p className="dim small">
            {itemsUnder(tagging).length} image{itemsUnder(tagging).length === 1 ? "" : "s"} and video{itemsUnder(tagging).length === 1 ? "" : "s"} in this folder and its subfolders get the tag.
          </p>
          <TagPicker
            autoFocus
            placeholder="type/name or name…"
            onAdd={(id) => {
              const keys = itemsUnder(tagging).map((i) => i.key);
              useTags.getState().setTag(keys, id, true);
              s.toast(`${keys.length} tagged ${id}`, "ok");
              setTagging(null);
            }}
          />
        </Modal>
      )}
      <div
        className="files"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDropInto(e, dir)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({ at: { x: e.clientX, y: e.clientY }, items: [{ label: <><FolderPlus /> New folder</>, onClick: () => setNewFolder("") }, { label: <><TagIcon /> Tag everything in this folder…</>, onClick: () => setTagging(dir) }, { label: <>Select all</>, onClick: () => setSelected(new Set(entries.map((x) => x.path))) }] });
        }}
      >
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
          <button className="btn sm" onClick={() => s.set({ importOpen: {} })} title="Bring pictures in from a card, a phone or a folder: into a bucket or as an album, duplicates checked">
            <Tray /> Import…
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

        <div className={view === "icons" ? "file-icons" : "file-list"} style={view === "icons" ? { gridTemplateColumns: `repeat(auto-fill, minmax(${iconSize}px, 1fr))` } : undefined} onMouseDown={startBox}>
          <div ref={box} className="file-box" />
          {newFolder !== null && (
            <form
              className="file-row"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!root) return;
                try {
                  await api.fsMkdir(root, dir, newFolder);
                  sayIfDateNamed(root, `${dir.replace(/\/+$/, "")}/${newFolder.trim()}`);
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
              onContextMenu={(e) => entryMenu(e, x)}
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
              onClick={(e) => pick(e, x)}
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
                  const renamed = await api.fsRename(root, x.path, renameTo);
                  s.relocatePaths([[x.path, renamed]]);
                  sayIfDateNamed(root, renamed, x.isDir);
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
              data-path={x.path}
              className={`file-row ${selected.has(x.path) ? "selected" : ""} ${dropTarget === x.path ? "drop" : ""}`}
              onContextMenu={(e) => entryMenu(e, x)}
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
              onClick={(e) => pick(e, x)}
              onDoubleClick={() => (x.isDir ? setDir(x.path) : openFile(x))}
            >
              {/* Moved by its icon and name; the rest of the row starts a selection box. */}
              <span className={`file-grab ${renaming === x.path ? "grow" : ""}`} draggable={renaming !== x.path} onDragStart={(e) => onDragStart(e, x.path)}>
                {x.isDir ? <Folder className="file-icon" /> : classifyName(x.name) === "video" ? <FilmStrip className="file-icon" /> : <FileIcon className="file-icon" />}
                {renaming === x.path ? (
                  <form
                    className="grow row"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!root) return;
                      try {
                        const renamed = await api.fsRename(root, x.path, renameTo);
                        s.relocatePaths([[x.path, renamed]]);
                        sayIfDateNamed(root, renamed, x.isDir);
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
              </span>
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
  onContextMenu: (e: React.MouseEvent) => void;
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
    const item = { primary: x.path, vaultId: x.vaultId ?? undefined, modified: x.modified, kind };
    const root = useStore.getState().root;
    const url =
      root && canThumb(item)
        ? Promise.resolve(thumbUrl(root, item, ref.current?.clientWidth || 160))
        : kind === "raw"
          ? rawPreviewUrl(x.path)
          : kind === "video"
            ? videoPoster(mediaUrl(item))
            : Promise.resolve(mediaUrl(item));
    url.then((u) => alive && setThumb(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible, kind, x.path, x.encrypted, x.modified]);

  const Glyph = x.isDir ? Folder : kind === "video" ? FilmStrip : /\.(mp3|wav|flac|m4a|aac|ogg)$/i.test(x.name) ? FileAudio : /\.(pdf)$/i.test(x.name) ? FilePdf : /\.(zip|rar|7z|gz|tar|dmg)$/i.test(x.name) ? FileZip : /\.(json|xml|js|ts|py|rs|html|css|sh|yml|yaml|toml)$/i.test(x.name) ? FileCode : /\.(txt|md|rtf|csv|log)$/i.test(x.name) ? FileText : FileIcon;

  return (
    <div
      ref={ref}
      data-path={x.path}
      className={`file-tile ${props.selected ? "selected" : ""} ${props.drop ? "drop" : ""}`}
      draggable
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
      title={x.path}
    >
      <div className="file-tile-art" style={{ height: size * 0.75 }}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <Glyph size={Math.round(size * 0.42)} weight={x.isDir ? "fill" : undefined} className="file-glyph" />}
        {kind === "video" && thumb && (
          <span className="thumb-play">
            <Play />
          </span>
        )}
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
          {kind === "video" && <FilmStrip />}
          {x.name}
        </div>
      )}
      <div className="mono faint small">{x.isDir ? `${x.count} files` : formatBytes(x.size)}</div>
    </div>
  );
}
