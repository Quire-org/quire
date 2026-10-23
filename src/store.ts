import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, storedPath } from "./lib/api";
import { suggestHotkey } from "./lib/hotkeys";
import { basename, shuffled, uid } from "./lib/format";
import type { Album, AlbumRename, History, Library, MediaItem, Target } from "./lib/types";

export type Screen = "welcome" | "viewer" | "browse" | "dupes" | "albums";

/** Where the viewer's queue came from. */
export type QueueSource = { kind: "unsorted" } | { kind: "browse" } | { kind: "dupes" } | { kind: "albums" };
export type FitMode = "fit" | "fill";

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
  /** Everything under the root plus outside targets; items in a target carry targetId. */
  allItems: MediaItem[];
  allLoaded: boolean;
  allStale: boolean;
  albums: Album[];
  albumsLoaded: boolean;
  fitMode: FitMode;
  driveOpen: boolean;
  immersive: boolean;
  /** item key -> last viewed (ms); lives in .mediasorter.history.json next to the media. */
  viewed: Record<string, number>;
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
  moveItem(item: MediaItem, targetId: string): Promise<boolean>;
  trashItem(item: MediaItem): Promise<boolean>;
  loadAll(force?: boolean): Promise<MediaItem[]>;
  openDupes(): void;
  openAlbums(): void;
  loadAlbums(force?: boolean): Promise<Album[]>;
  addAlbumRoot(absPath: string): void;
  removeAlbumRoot(path: string): void;
  setAlbumRating(album: Album, rating: number | null): void;
  moveAlbum(album: Album, targetId: string): Promise<boolean>;
  openAlbum(album: Album): Promise<void>;
  /** Viewer over the contents of several albums, in the given order. */
  openAlbums_Slideshow(albums: Album[]): Promise<void>;
  toggleFit(): void;
  /** Album folders with URL-escaped names and their decoded names. */
  albumRenamePlan(): Promise<AlbumRename[]>;
  /** Rename those folders (all of the plan, or a chosen subset) and re-key their ratings. */
  applyAlbumRenames(plan: AlbumRename[]): Promise<number>;
  setAutoDecodeAlbumNames(on: boolean): void;
  setAlbumRatingByKey(key: string, rating: number | null): void;
  recordView(item: MediaItem): void;
  /** Jump to a random item, favouring ones not seen lately. */
  surprise(): Promise<void>;
  toggleImmersive(): void;
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

let historyTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleHistorySave() {
  if (historyTimer) clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    const { root, viewed } = useStore.getState();
    if (!root) return;
    const history: History = { version: 1, viewed };
    api.saveHistory(root, history).catch(() => {});
  }, 2000);
}

function loadFit(): FitMode {
  try {
    return localStorage.getItem("mediasorter.fit") === "fill" ? "fill" : "fit";
  } catch {
    return "fit";
  }
}

export const useStore = create<Store>((set, get) => ({
  root: null,
  library: null,
  screen: "welcome",
  queue: [],
  index: 0,
  source: { kind: "unsorted" },
  shuffle: false,
  unsorted: [],
  allItems: [],
  allLoaded: false,
  allStale: false,
  albums: [],
  albumsLoaded: false,
  fitMode: loadFit(),
  driveOpen: false,
  immersive: false,
  viewed: {},
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
      const history = await api.loadHistory(root).catch(() => null);
      set({ loading: "Scanning folder…", viewed: history?.viewed ?? {} });
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
        allItems: [],
        allLoaded: false,
        allStale: false,
        albums: [],
        albumsLoaded: false,
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
      allItems: [],
      allLoaded: false,
      albums: [],
      albumsLoaded: false,
      viewed: {},
      immersive: false,
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
    set({ loading: "Scanning folder…" });
    try {
      const unsorted = sortItems(await api.scanUnsorted(root, library));
      const patch: Partial<State> = { unsorted, loading: null, allStale: true, albumsLoaded: false };
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
    const item = get().queue[get().index];
    if (item) await get().moveItem(item, targetId);
  },

  async trashCurrent() {
    const item = get().queue[get().index];
    if (item) await get().trashItem(item);
  },

  async moveItem(item, targetId) {
    const { root, library, busy } = get();
    const target = library?.targets.find((t) => t.id === targetId);
    if (!root || !library || !target || busy) return false;
    set({ busy: true });
    try {
      const res = await api.moveItem(root, item, target.path);
      applyMove(res.moved, item, { ...res.item, targetId }, `Moved to ${target.name}`);
      get().toast(`→ ${target.name}`, "ok");
      return true;
    } catch (e) {
      get().toast(String(e), "error");
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async trashItem(item) {
    const { root, library, busy } = get();
    if (!root || !library || busy) return false;
    set({ busy: true });
    try {
      const res = await api.trashItem(root, library, item);
      applyMove(res.moved, item, res.item, "Deleted", true);
      get().toast("Moved to trash", "warn");
      return true;
    } catch (e) {
      get().toast(String(e), "error");
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async loadAll(force = false) {
    const { root, library, allLoaded, allStale, allItems } = get();
    if (!root || !library) return [];
    if (allLoaded && !allStale && !force) return allItems;
    set({ loading: "Scanning folder…" });
    try {
      const items = sortItems(await api.scanAll(root, library, false));
      set({ allItems: items, allLoaded: true, allStale: false, loading: null });
      return items;
    } catch (e) {
      set({ loading: null });
      get().toast(String(e), "error");
      return allItems;
    }
  },

  openDupes() {
    set({ screen: "dupes", settingsOpen: false, trashOpen: false });
  },

  openAlbums() {
    set({ screen: "albums", settingsOpen: false, trashOpen: false });
  },

  async loadAlbums(force = false) {
    const { root, library, albumsLoaded, albums } = get();
    if (!root || !library) return [];
    if (albumsLoaded && !force) return albums;
    try {
      if (library.autoDecodeAlbumNames) {
        const plan = await api.albumRenamePlan(root, library);
        if (plan.length) await get().applyAlbumRenames(plan);
      }
      const list = await api.scanAlbums(root, get().library ?? library);
      set({ albums: list, albumsLoaded: true });
      return list;
    } catch (e) {
      get().toast(String(e), "error");
      return albums;
    }
  },

  addAlbumRoot(absPath) {
    const { root, library } = get();
    if (!root || !library) return;
    const path = storedPath(root, absPath);
    if (library.albumRoots.includes(path)) return;
    set({ library: { ...library, albumRoots: [...library.albumRoots, path] }, albumsLoaded: false });
    get().saveLibrary();
    void get().rescan(true);
  },

  removeAlbumRoot(path) {
    const { library } = get();
    if (!library) return;
    set({ library: { ...library, albumRoots: library.albumRoots.filter((p) => p !== path) }, albumsLoaded: false });
    get().saveLibrary();
    void get().rescan(true);
  },

  setAlbumRating(album, rating) {
    const { library } = get();
    if (!library) return;
    const albumRatings = { ...library.albumRatings };
    if (rating == null) delete albumRatings[album.key];
    else albumRatings[album.key] = rating;
    set({ library: { ...library, albumRatings } });
    get().saveLibrary();
  },

  async moveAlbum(album, targetId) {
    const { root, library, busy } = get();
    const target = library?.targets.find((t) => t.id === targetId);
    if (!root || !library || !target || busy) return false;
    set({ busy: true });
    try {
      const newPath = await api.moveDir(root, album.path, target.path);
      const albumRatings = { ...library.albumRatings };
      const newKey = storedPath(root, newPath);
      if (album.key in albumRatings) {
        albumRatings[newKey] = albumRatings[album.key];
        delete albumRatings[album.key];
      }
      set({
        library: { ...library, albumRatings },
        albums: get().albums.filter((a) => a.key !== album.key),
        allStale: true,
      });
      get().saveLibrary();
      get().toast(`Album → ${target.name}`, "ok");
      return true;
    } catch (e) {
      get().toast(String(e), "error");
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async openAlbum(album) {
    const { root } = get();
    if (!root) return;
    try {
      const items = sortItems(await api.scanDir(root, album.path)).map((i) => ({ ...i, albumKey: album.key }));
      set({ screen: "viewer", queue: items, index: 0, source: { kind: "albums" }, shuffle: false });
    } catch (e) {
      get().toast(String(e), "error");
    }
  },

  async albumRenamePlan() {
    const { root, library } = get();
    if (!root || !library) return [];
    try {
      return await api.albumRenamePlan(root, library);
    } catch (e) {
      get().toast(String(e), "error");
      return [];
    }
  },

  async applyAlbumRenames(plan) {
    const { root } = get();
    if (!root || plan.length === 0) return 0;
    try {
      const done = await api.albumRenameApply(plan);
      const library = get().library!;
      const albumRatings = { ...library.albumRatings };
      for (const r of done) {
        // The album itself and anything keyed below it.
        for (const key of Object.keys(albumRatings)) {
          if (key === r.fromKey || key.startsWith(r.fromKey + "/")) {
            albumRatings[r.toKey + key.slice(r.fromKey.length)] = albumRatings[key];
            delete albumRatings[key];
          }
        }
      }
      set({ library: { ...library, albumRatings }, albumsLoaded: false, allStale: true });
      get().saveLibrary();
      if (done.length) get().toast(`Renamed ${done.length} album folder${done.length === 1 ? "" : "s"}`, "ok");
      return done.length;
    } catch (e) {
      get().toast(String(e), "error");
      return 0;
    }
  },

  setAutoDecodeAlbumNames(on) {
    const { library } = get();
    if (!library) return;
    set({ library: { ...library, autoDecodeAlbumNames: on }, albumsLoaded: false });
    get().saveLibrary();
  },

  async openAlbums_Slideshow(albums) {
    const { root } = get();
    if (!root || albums.length === 0) return;
    set({ loading: "Reading albums…" });
    try {
      const lists = await Promise.all(albums.map((a) => api.scanDir(root, a.path)));
      const items = lists.flatMap((l, k) => sortItems(l).map((i) => ({ ...i, albumKey: albums[k].key })));
      set({ screen: "viewer", queue: items, index: 0, source: { kind: "albums" }, shuffle: false, loading: null });
    } catch (e) {
      set({ loading: null });
      get().toast(String(e), "error");
    }
  },

  setAlbumRatingByKey(key, rating) {
    const { library } = get();
    if (!library) return;
    const albumRatings = { ...library.albumRatings };
    if (rating == null) delete albumRatings[key];
    else albumRatings[key] = rating;
    set({ library: { ...library, albumRatings } });
    get().saveLibrary();
  },

  recordView(item) {
    const { root } = get();
    if (!root) return;
    const viewed = { ...get().viewed, [item.key]: Date.now() };
    set({ viewed });
    scheduleHistorySave();
  },

  async surprise() {
    const all = await get().loadAll();
    if (all.length === 0) {
      get().toast("Nothing to show yet", "warn");
      return;
    }
    const { viewed } = get();
    const now = Date.now();
    // Never viewed counts like a month untouched; recently viewed is unlikely but possible.
    const weights = all.map((i) => {
      const t = viewed[i.key];
      return t ? Math.min(30, Math.max(1, (now - t) / 86_400_000)) : 30;
    });
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let pick = all.length - 1;
    for (let k = 0; k < weights.length; k++) {
      r -= weights[k];
      if (r <= 0) {
        pick = k;
        break;
      }
    }
    const rest = shuffled(all.filter((_, k) => k !== pick));
    set({ screen: "viewer", queue: [all[pick], ...rest], index: 0, source: { kind: "browse" }, shuffle: true, settingsOpen: false, trashOpen: false });
    get().toast("Surprise!", "ok");
  },

  toggleImmersive() {
    const immersive = !get().immersive;
    set({ immersive, hudHidden: immersive, infoOpen: false });
    if (immersive) get().toast("Immersive mode. Press C to leave");
  },

  toggleFit() {
    const fitMode: FitMode = get().fitMode === "fit" ? "fill" : "fit";
    try {
      localStorage.setItem("mediasorter.fit", fitMode);
    } catch {
      /* ignore */
    }
    set({ fitMode });
    get().toast(fitMode === "fit" ? "Fit: whole image visible" : "Fill: edge to edge, may crop");
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
        const viewed = { ...get().viewed };
        if (entry.toKey in viewed) {
          viewed[entry.fromKey] = viewed[entry.toKey];
          delete viewed[entry.toKey];
          scheduleHistorySave();
        }
        const queue = get().queue.slice();
        const at = Math.min(entry.index, queue.length);
        queue.splice(at, 0, entry.item);
        const unsorted = !entry.item.targetId ? sortItems([...get().unsorted, entry.item]) : get().unsorted;
        const allItems = sortItems([...get().allItems.filter((i) => i.key !== entry.toKey), entry.item]);
        set({
          library: { ...library, ratings },
          viewed,
          queue,
          index: at,
          unsorted,
          allItems,
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
function applyMove(moves: [string, string][], from: MediaItem, to: MediaItem, label: string, trashed = false) {
  const s = useStore.getState();
  const library = s.library!;
  const ratings = { ...library.ratings };
  if (from.key in ratings) {
    ratings[to.key] = ratings[from.key];
    delete ratings[from.key];
  }
  const viewed = { ...s.viewed };
  if (from.key in viewed) {
    viewed[to.key] = viewed[from.key];
    delete viewed[from.key];
    scheduleHistorySave();
  }
  const removedAt = s.queue.findIndex((q) => q.key === from.key);
  const queue = s.queue.filter((q) => q.key !== from.key);
  const unsorted = s.unsorted.filter((u) => u.key !== from.key);
  const allItems = s.allItems.filter((i) => i.key !== from.key);
  if (!trashed) allItems.push(to);
  const index = queue.length === 0 ? 0 : Math.min(s.index, queue.length - 1);
  useStore.setState({
    library: { ...library, ratings },
    viewed,
    queue,
    unsorted,
    allItems: sortItems(allItems),
    index,
    undoStack: [
      ...s.undoStack.slice(-49),
      { type: "move", label, moves, item: from, index: removedAt >= 0 ? removedAt : s.index, fromKey: from.key, toKey: to.key },
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
