import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, storedPath } from "./lib/api";
import { suggestHotkey } from "./lib/hotkeys";
import { basename, shuffled, uid } from "./lib/format";
import type { Library, MediaItem, Target } from "./lib/types";

export type Screen = "welcome" | "viewer" | "browse";

/** Where the viewer's queue came from. */
export type QueueSource = { kind: "unsorted" } | { kind: "browse" };

export interface Toast {
  id: string;
  text: string;
  tone: "info" | "ok" | "warn" | "error";
}

type UndoEntry =
  | {
      type: "move";
      label: string;
      moves: [string, string][];
      item: MediaItem;
      index: number;
      fromKey: string;
      toKey: string;
    }
  | { type: "rating"; key: string; prev: number | undefined; item: MediaItem };

interface State {
  root: string | null;
  library: Library | null;
  screen: Screen;
  queue: MediaItem[];
  index: number;
  source: QueueSource;
  shuffle: boolean;
  /** Master list of unsorted items, in scan order. */
  unsorted: MediaItem[];
  loading: string | null;
  busy: boolean;
  toasts: Toast[];
  undoStack: UndoEntry[];
  settingsOpen: boolean;
  trashOpen: boolean;
  helpOpen: boolean;
  hudHidden: boolean;
  infoOpen: boolean;
  fullscreen: boolean;
  recentRoots: string[];
  /** Remember the folder the last target was picked from. */
  lastTargetParent: string | null;
}

interface Actions {
  openRoot(root: string): Promise<void>;
  closeRoot(): void;
  rescan(quiet?: boolean): Promise<void>;
  saveLibrary(): Promise<void>;
  setIndex(i: number): void;
  next(): void;
  prev(): void;
  toggleShuffle(): void;
  setRating(item: MediaItem, rating: number | null): void;
  moveCurrent(targetId: string): Promise<void>;
  trashCurrent(): Promise<void>;
  undo(): Promise<void>;
  addTarget(absPath: string): void;
  updateTarget(id: string, patch: Partial<Target>): void;
  removeTarget(id: string): void;
  openBrowse(): void;
  openViewer(items: MediaItem[], index: number, source: QueueSource): void;
  openSortQueue(): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: string): void;
  set(partial: Partial<State>): void;
  toggleFullscreen(): Promise<void>;
  emptyTrash(): Promise<number>;
}

export type Store = State & Actions;

const RECENT_KEY = "mediasorter.recentRoots";

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* ignore */
  }
}

function sortItems(items: MediaItem[]): MediaItem[] {
  return items
    .slice()
    .sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<Store>((set, get) => ({
  root: null,
  library: null,
  screen: "welcome",
  queue: [],
  index: 0,
  source: { kind: "unsorted" },
  shuffle: false,
  unsorted: [],
  loading: null,
  busy: false,
  toasts: [],
  undoStack: [],
  settingsOpen: false,
  trashOpen: false,
  helpOpen: false,
  hudHidden: false,
  infoOpen: false,
  fullscreen: false,
  recentRoots: loadRecent(),
  lastTargetParent: null,

  set: (partial) => set(partial),

  toast(text, tone = "info") {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => get().dismissToast(id), tone === "error" ? 6000 : 2500);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  async openRoot(root) {
    set({ loading: "Reading library…" });
    try {
      const library = await api.loadLibrary(root);
      set({ loading: "Scanning volume…" });
      const unsorted = sortItems(await api.scanUnsorted(root, library));
      const recent = [root, ...get().recentRoots.filter((r) => r !== root)];
      saveRecent(recent);
      set({
        root,
        library,
        unsorted,
        queue: unsorted,
        index: 0,
        source: { kind: "unsorted" },
        shuffle: false,
        screen: "viewer",
        loading: null,
        undoStack: [],
        recentRoots: recent,
        settingsOpen: library.targets.length === 0,
      });
      get().toast(`${unsorted.length} unsorted items`, "ok");
    } catch (e) {
      set({ loading: null });
      get().toast(String(e), "error");
    }
  },

  closeRoot() {
    set({
      root: null,
      library: null,
      unsorted: [],
      queue: [],
      index: 0,
      screen: "welcome",
      undoStack: [],
      settingsOpen: false,
      trashOpen: false,
    });
  },

  async rescan(quiet = false) {
    const { root, library, source } = get();
    if (!root || !library) return;
    set({ loading: "Scanning volume…" });
    try {
      const unsorted = sortItems(await api.scanUnsorted(root, library));
      const patch: Partial<State> = { unsorted, loading: null };
      if (source.kind === "unsorted") {
        const cur = get().queue[get().index];
        const queue = get().shuffle ? shuffled(unsorted) : unsorted;
        const idx = cur ? Math.max(0, queue.findIndex((i) => i.key === cur.key)) : 0;
        Object.assign(patch, { queue, index: idx });
      }
      set(patch);
      if (!quiet) get().toast(`${unsorted.length} unsorted items`, "ok");
    } catch (e) {
      set({ loading: null });
      get().toast(String(e), "error");
    }
  },

  async saveLibrary() {
    const { root, library } = get();
    if (!root || !library) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await api.saveLibrary(root, get().library!);
      } catch (e) {
        get().toast(`Could not save library: ${e}`, "error");
      }
    }, 250);
  },

  setIndex(i) {
    const n = get().queue.length;
    if (n === 0) return set({ index: 0 });
    set({ index: ((i % n) + n) % n });
  },
  next() {
    get().setIndex(get().index + 1);
  },
  prev() {
    get().setIndex(get().index - 1);
  },

  toggleShuffle() {
    const { shuffle, queue, index, source, unsorted } = get();
    const cur = queue[index];
    let next: MediaItem[];
    if (shuffle) {
      const inQueue = new Set(queue.map((q) => q.key));
      next = source.kind === "unsorted" ? unsorted.filter((u) => inQueue.has(u.key)) : sortItems(queue);
    } else {
      next = shuffled(queue);
    }
    const idx = cur ? Math.max(0, next.findIndex((i) => i.key === cur.key)) : 0;
    set({ shuffle: !shuffle, queue: next, index: idx });
    get().toast(!shuffle ? "Shuffle on" : "Shuffle off");
  },

  setRating(item, rating) {
    const { library } = get();
    if (!library) return;
    const prev = library.ratings[item.key];
    const ratings = { ...library.ratings };
    if (rating == null) delete ratings[item.key];
    else ratings[item.key] = rating;
    set((s) => ({
      library: { ...library, ratings },
      undoStack: [...s.undoStack.slice(-49), { type: "rating", key: item.key, prev, item }],
    }));
    get().saveLibrary();
  },

  async moveCurrent(targetId) {
    const { root, library, queue, index, busy } = get();
    const item = queue[index];
    const target = library?.targets.find((t) => t.id === targetId);
    if (!root || !library || !item || !target || busy) return;
    set({ busy: true });
    try {
      const res = await api.moveItem(root, item, target.path);
      applyMove(res.moved, item, res.item, `Moved to ${target.name}`);
      get().toast(`→ ${target.name}`, "ok");
    } catch (e) {
      get().toast(String(e), "error");
    } finally {
      set({ busy: false });
    }
  },

  async trashCurrent() {
    const { root, library, queue, index, busy } = get();
    const item = queue[index];
    if (!root || !library || !item || busy) return;
    set({ busy: true });
    try {
      const res = await api.trashItem(root, library, item);
      applyMove(res.moved, item, res.item, "Deleted");
      get().toast("Moved to trash", "warn");
    } catch (e) {
      get().toast(String(e), "error");
    } finally {
      set({ busy: false });
    }
  },

  async undo() {
    const { undoStack, library, busy } = get();
    const entry = undoStack[undoStack.length - 1];
    if (!entry || !library || busy) return;
    set({ busy: true });
    try {
      if (entry.type === "rating") {
        const ratings = { ...library.ratings };
        if (entry.prev == null) delete ratings[entry.key];
        else ratings[entry.key] = entry.prev;
        set({ library: { ...library, ratings }, undoStack: undoStack.slice(0, -1) });
        get().saveLibrary();
        get().toast("Rating restored");
      } else {
        await api.restoreFiles(entry.moves);
        const ratings = { ...library.ratings };
        if (entry.toKey in ratings) {
          ratings[entry.fromKey] = ratings[entry.toKey];
          delete ratings[entry.toKey];
        }
        const queue = get().queue.slice();
        const at = Math.min(entry.index, queue.length);
        queue.splice(at, 0, entry.item);
        const unsorted = get().source.kind === "unsorted" ? sortItems([...get().unsorted, entry.item]) : get().unsorted;
        set({
          library: { ...library, ratings },
          queue,
          index: at,
          unsorted,
          undoStack: undoStack.slice(0, -1),
        });
        get().saveLibrary();
        get().toast(`Undid: ${entry.label}`, "ok");
      }
    } catch (e) {
      get().toast(`Undo failed: ${e}`, "error");
    } finally {
      set({ busy: false });
    }
  },

  addTarget(absPath) {
    const { root, library } = get();
    if (!root || !library) return;
    const path = storedPath(root, absPath);
    if (library.targets.some((t) => t.path === path)) {
      get().toast("That folder is already a target", "warn");
      return;
    }
    const name = basename(absPath) || absPath;
    const target: Target = {
      id: uid(),
      name,
      path,
      hotkey: suggestHotkey(name, library.targets.map((t) => t.hotkey)),
    };
    set({
      library: { ...library, targets: [...library.targets, target] },
      lastTargetParent: absPath.replace(/[/\\][^/\\]+$/, ""),
    });
    get().saveLibrary();
    // A target inside the root is excluded from the unsorted queue.
    if (!path.startsWith("/") && !/^[A-Za-z]:/.test(path)) void get().rescan(true);
  },

  updateTarget(id, patch) {
    const { library } = get();
    if (!library) return;
    set({
      library: { ...library, targets: library.targets.map((t) => (t.id === id ? { ...t, ...patch } : t)) },
    });
    get().saveLibrary();
  },

  removeTarget(id) {
    const { library } = get();
    if (!library) return;
    set({ library: { ...library, targets: library.targets.filter((t) => t.id !== id) } });
    get().saveLibrary();
    void get().rescan(true);
  },

  openBrowse() {
    set({ screen: "browse", settingsOpen: false, trashOpen: false });
  },

  openViewer(items, index, source) {
    set({ screen: "viewer", queue: items, index, source, shuffle: false });
  },

  openSortQueue() {
    const { unsorted, shuffle } = get();
    set({ screen: "viewer", queue: shuffle ? shuffled(unsorted) : unsorted, index: 0, source: { kind: "unsorted" } });
  },

  async toggleFullscreen() {
    const win = getCurrentWindow();
    const fs = await win.isFullscreen();
    await win.setFullscreen(!fs);
    set({ fullscreen: !fs });
  },

  async emptyTrash() {
    const { root, library } = get();
    if (!root || !library) return 0;
    const n = await api.emptyTrash(root, library);
    // Drop ratings of purged files.
    const prefix = library.trashDir.replace(/\/+$/, "") + "/";
    const ratings: Record<string, number> = {};
    for (const [k, v] of Object.entries(library.ratings)) if (!k.startsWith(prefix)) ratings[k] = v;
    set({ library: { ...library, ratings } });
    get().saveLibrary();
    return n;
  },
}));

/** Shared bookkeeping after a move or trash succeeded. */
function applyMove(moves: [string, string][], from: MediaItem, to: MediaItem, label: string) {
  const s = useStore.getState();
  const library = s.library!;
  const ratings = { ...library.ratings };
  if (from.key in ratings) {
    ratings[to.key] = ratings[from.key];
    delete ratings[from.key];
  }
  const queue = s.queue.filter((q) => q.key !== from.key);
  const unsorted = s.unsorted.filter((u) => u.key !== from.key);
  const index = queue.length === 0 ? 0 : Math.min(s.index, queue.length - 1);
  useStore.setState({
    library: { ...library, ratings },
    queue,
    unsorted,
    index,
    undoStack: [
      ...s.undoStack.slice(-49),
      { type: "move", label, moves, item: from, index: s.index, fromKey: from.key, toKey: to.key },
    ],
  });
  void useStore.getState().saveLibrary();
}

/** Convenience selectors */
export const selectCurrent = (s: Store) => s.queue[s.index];
export const selectRating = (s: Store) => {
  const cur = s.queue[s.index];
  return cur && s.library ? s.library.ratings[cur.key] : undefined;
};
