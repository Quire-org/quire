import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, setCurrentRoot, storedPath } from "./lib/api";
import { suggestHotkey } from "./lib/hotkeys";
import { identityOf, reconcile } from "./lib/reconcile";
import { applyTheme, loadThemeId } from "./themes";
import { basename, shuffled, uid } from "./lib/format";
import type { Album, AlbumRename, History, Library, MediaItem, Target, VaultStatus } from "./lib/types";
import { useEdit, type Pipeline } from "./editStore";

export type Screen = "welcome" | "viewer" | "browse" | "dupes" | "albums" | "files";

/** Where the viewer's queue came from. */
export type QueueSource = { kind: "unsorted" } | { kind: "browse" } | { kind: "dupes" } | { kind: "albums" };
export type FitMode = "fit" | "fill";

export interface BrowseFilters {
  location: string;
  kind: "all" | "image" | "raw" | "video";
  folders: string[] | null;
  query: string;
  sortBy: "name" | "date" | "rating" | "size";
  desc: boolean;
  minRating: number;
  unratedOnly: boolean;
  random: boolean;
  zoom: number;
  layout: "masonry" | "grid";
}
export interface AlbumFilters {
  query: string;
  rootSel: string;
  kind: "all" | "photos" | "videos" | "mixed";
  minRating: number;
  unratedOnly: boolean;
  sortBy: "name" | "date" | "size" | "count" | "rating";
  desc: boolean;
  random: boolean;
  zoom: number;
}
const DEFAULT_BROWSE: BrowseFilters = { location: "all", kind: "all", folders: null, query: "", sortBy: "name", desc: false, minRating: 0, unratedOnly: false, random: false, zoom: 220, layout: "masonry" };
const DEFAULT_ALBUMS: AlbumFilters = { query: "", rootSel: "all", kind: "all", minRating: 0, unratedOnly: false, sortBy: "name", desc: false, random: false, zoom: 260 };

function loadPref<T extends object>(key: string, def: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v === "object" ? { ...def, ...v } : def;
  } catch {
    return def;
  }
}
function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

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
  backupOpen: boolean;
  vaultOpen: boolean;
  /** Loupe zoom: level is image pixels per CSS pixel (0 = fit); pan in CSS px from centre. */
  zoom: { level: number; preferredLevel: number; focal: { x: number; y: number }; pan: { px: number; py: number } };
  setZoom(z: Partial<State["zoom"]>): void;
  /** Z: cycle fit -> 100% -> 200% -> fit at the image centre. */
  cycleZoom(): void;
  /** Viewer edit mode: side-by-side preview and the edit bar. */
  editMode: boolean;
  /** Items the edit applies to (the current item, or a Browse selection). */
  editItems: MediaItem[];
  /** Vault state of the open folder, or of the folder waiting to be unlocked. */
  vault: VaultStatus | null;
  /** A folder with a locked vault that is waiting for a passphrase. */
  pendingRoot: string | null;
  /** Set after a recovery-code unlock: the user should choose a new passphrase. */
  needsNewPassphrase: boolean;
  /** item key -> last viewed (ms); lives in .mediasorter.history.json next to the media. */
  viewed: Record<string, number>;
  /** Filter state of the list screens, kept until changed (and across launches). */
  browseFilters: BrowseFilters;
  albumFilters: AlbumFilters;
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
  toggleHud(): void;
  setBrowseFilters(patch: Partial<BrowseFilters>): void;
  /** Re-attach ratings and history to files that were moved or renamed outside the app. */
  reconcileKeys(items: MediaItem[]): Promise<void>;
  navCollapsed: boolean;
  toggleNav(): void;
  theme: string;
  setTheme(id: string): void;
  /** Auto-advance in the viewer: seconds per image; videos play to the end. */
  slideshow: { playing: boolean; interval: number; hideUi: boolean; hidByShow: boolean };
  toggleSlideshow(): void;
  setSlideshowHideUi(on: boolean): void;
  setSlideshowInterval(seconds: number): void;
  setLibraryField(patch: Partial<Library>): void;
  setAlbumFilters(patch: Partial<AlbumFilters>): void;
  refreshVault(): Promise<void>;
  unlockVault(secret: string, recovery: boolean): Promise<boolean>;
  unlockVaultQuick(): Promise<boolean>;
  lockVault(): Promise<void>;
  openFiles(): void;
  /** Enter edit mode on these items (shows the first; a save applies to all). */
  openEdit(items: MediaItem[]): void;
  leaveEdit(): void;
  /** Apply an edit to items in turn; updates queue, ratings and lists. */
  applyEdit(items: MediaItem[], op: Pipeline, replace: boolean, onProgress: (done: number, total: number, frac: number) => void): Promise<MediaItem[]>;
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
  backupOpen: false,
  vaultOpen: false,
  zoom: { level: 0, preferredLevel: 2, focal: { x: 0.5, y: 0.5 }, pan: { px: 0, py: 0 } },
  editMode: false,
  editItems: [],
  vault: null,
  pendingRoot: null,
  needsNewPassphrase: false,
  viewed: {},
  navCollapsed: loadPref<{ v: boolean }>("mediasorter.navCollapsed", { v: false }).v,
  theme: loadThemeId(),
  slideshow: { playing: false, hidByShow: false, ...loadPref<{ interval: number; hideUi: boolean }>("mediasorter.slideshow", { interval: 5, hideUi: true }) },
  browseFilters: loadPref("mediasorter.browseFilters", DEFAULT_BROWSE),
  albumFilters: loadPref("mediasorter.albumFilters", DEFAULT_ALBUMS),
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
      setCurrentRoot(root);
      const vault = await api.vaultStatus(root).catch(() => null);
      if (vault?.exists && !vault.unlocked) {
        // Ask for the passphrase first; unlockVault calls openRoot again.
        set({ loading: null, vault, pendingRoot: root, screen: "welcome" });
        return;
      }
      set({ vault, pendingRoot: null });
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
      // Full scan in the background: feeds Browse and re-attaches ratings to moved files.
      void get().loadAll(true);
    } catch (e) {
      set({ loading: null });
      get().toast(String(e), "error");
    }
  },

  closeRoot() {
    setCurrentRoot(null);
    set({
      vault: null,
      pendingRoot: null,
      vaultOpen: false,
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
    const z = get().zoom;
    const zoom = z.level ? { ...z, level: 0, pan: { px: 0, py: 0 } } : z;
    if (n === 0) return set({ index: 0, zoom });
    set({ index: ((i % n) + n) % n, zoom });
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
    const ids = { ...(library.ids ?? {}) };
    if (rating == null) {
      delete ratings[item.key];
      delete ids[item.key];
    } else {
      ratings[item.key] = rating;
      ids[item.key] = { ...identityOf(item), f: ids[item.key]?.f };
    }
    set((s) => ({
      library: { ...library, ratings, ids },
      undoStack: [...s.undoStack.slice(-49), { type: "rating", key: item.key, prev, item }],
    }));
    get().saveLibrary();
    // Content fingerprint in the background, so the rating can follow a renamed copy too.
    if (rating != null && !ids[item.key].f) {
      api.fileFingerprint(item.primary)
        .then((f) => {
          const lib = get().library;
          if (!lib || !lib.ids?.[item.key]) return;
          set({ library: { ...lib, ids: { ...lib.ids, [item.key]: { ...lib.ids[item.key], f } } } });
          get().saveLibrary();
        })
        .catch(() => {});
    }
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
      const items = sortItems(await api.scanAll(root, library, true));
      set({ allItems: items, allLoaded: true, allStale: false, loading: null });
      void get().reconcileKeys(items);
      return items;
    } catch (e) {
      set({ loading: null });
      get().toast(String(e), "error");
      return allItems;
    }
  },

  openDupes() {
    if (get().editMode) get().leaveEdit();
    set({ screen: "dupes", settingsOpen: false, trashOpen: false, immersive: false, hudHidden: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
  },

  openAlbums() {
    if (get().editMode) get().leaveEdit();
    set({ screen: "albums", settingsOpen: false, trashOpen: false, immersive: false, hudHidden: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
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

  async refreshVault() {
    const root = get().root ?? get().pendingRoot;
    if (!root) return;
    const vault = await api.vaultStatus(root).catch(() => null);
    set({ vault });
  },

  async unlockVault(secret, recovery) {
    const root = get().pendingRoot ?? get().root;
    if (!root) return false;
    try {
      if (recovery) await api.vaultUnlockRecovery(root, secret);
      else await api.vaultUnlock(root, secret);
    } catch (e) {
      get().toast(String(e), "error");
      return false;
    }
    set({ pendingRoot: null, needsNewPassphrase: recovery });
    await get().openRoot(root);
    if (recovery) set({ vaultOpen: true });
    return true;
  },

  async unlockVaultQuick() {
    const root = get().pendingRoot ?? get().root;
    if (!root) return false;
    try {
      await api.vaultUnlockQuick(root);
    } catch (e) {
      get().toast(String(e), "error");
      return false;
    }
    set({ pendingRoot: null, needsNewPassphrase: false });
    await get().openRoot(root);
    return true;
  },

  async lockVault() {
    await api.vaultLock().catch(() => {});
    get().toast("Vault locked");
    get().closeRoot();
  },

  setZoom(z) {
    set({ zoom: { ...get().zoom, ...z } });
  },

  cycleZoom() {
    const z = get().zoom;
    const next = z.level === 0 ? 1 : z.level === 1 ? 2 : 0;
    set({ zoom: { ...z, level: next, preferredLevel: next || z.preferredLevel, pan: { px: 0, py: 0 }, focal: { x: 0.5, y: 0.5 } } });
    get().toast(next === 0 ? "Fit" : `${next * 100}%`);
  },

  openEdit(items) {
    if (!items.length) return;
    useEdit.getState().reset();
    const st = get();
    if (st.screen !== "viewer" || !st.queue.some((q) => q.key === items[0].key)) {
      // From a list screen: view the selection, first item up front.
      set({ screen: "viewer", queue: items, index: 0, source: { kind: "browse" }, shuffle: false });
    } else {
      set({ index: st.queue.findIndex((q) => q.key === items[0].key) });
    }
    set({ editMode: true, editItems: items, hudHidden: false, immersive: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
  },

  leaveEdit() {
    useEdit.getState().reset();
    set({ editMode: false, editItems: [] });
  },

  async applyEdit(items, op, replace, onProgress) {
    const { root } = get();
    if (!root) return [];
    const results: MediaItem[] = [];
    for (let k = 0; k < items.length; k++) {
      const item = items[k];
      const library = get().library!;
      try {
        const r = await api.editApply(root, library, item, op, replace, (f) => onProgress(k, items.length, f));
        const s = get();
        const lib = s.library!;
        const ratings = { ...lib.ratings };
        const ids = { ...(lib.ids ?? {}) };
        if (replace && item.key in ratings) {
          ratings[r.item.key] = ratings[item.key];
          delete ratings[item.key];
          if (ids[item.key]) {
            ids[r.item.key] = { ...identityOf(r.item), f: undefined };
            delete ids[item.key];
          }
        }
        // Queue: replace in place, or insert the copy right after the original.
        const qi = s.queue.findIndex((q) => q.key === item.key);
        const queue = s.queue.slice();
        if (qi >= 0) {
          if (replace) queue[qi] = r.item;
          else queue.splice(qi + 1, 0, r.item);
        }
        const drop = (list: MediaItem[]) => (replace ? list.filter((i) => i.key !== item.key) : list);
        set({
          library: { ...lib, ratings, ids },
          queue,
          index: replace ? s.index : Math.min(s.index, queue.length - 1),
          unsorted: sortItems([...drop(s.unsorted), ...(!item.targetId && !item.albumKey ? [r.item] : [])]),
          allItems: sortItems([...drop(s.allItems), r.item]),
        });
        get().saveLibrary();
        results.push(r.item);
      } catch (e) {
        get().toast(`${item.name}: ${e}`, "error");
      }
    }
    onProgress(items.length, items.length, 1);
    return results;
  },

  openFiles() {
    if (get().editMode) get().leaveEdit();
    set({ screen: "files", settingsOpen: false, trashOpen: false, immersive: false, hudHidden: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
  },

  setLibraryField(patch) {
    const { library } = get();
    if (!library) return;
    set({ library: { ...library, ...patch } });
    get().saveLibrary();
  },

  toggleSlideshow() {
    const cur = get().slideshow;
    const playing = !cur.playing;
    if (playing) {
      // Hide the HUD for the show (like H), and remember whether we were the ones who hid it.
      const hidByShow = cur.hideUi && !get().hudHidden;
      if (hidByShow) set({ hudHidden: true, infoOpen: false });
      set({ slideshow: { ...cur, playing, hidByShow } });
      get().toast(`Slideshow: ${cur.interval}s per image. Enter pauses, H shows the controls`);
    } else {
      if (cur.hidByShow && get().hudHidden && !get().immersive) set({ hudHidden: false });
      set({ slideshow: { ...cur, playing, hidByShow: false } });
      get().toast("Slideshow paused");
    }
  },

  setSlideshowInterval(seconds) {
    const slideshow = { ...get().slideshow, interval: seconds };
    set({ slideshow });
    savePref("mediasorter.slideshow", { interval: seconds, hideUi: slideshow.hideUi });
  },

  setSlideshowHideUi(on) {
    const slideshow = { ...get().slideshow, hideUi: on };
    set({ slideshow });
    savePref("mediasorter.slideshow", { interval: slideshow.interval, hideUi: on });
  },

  setTheme(id) {
    applyTheme(id);
    set({ theme: id });
  },

  toggleNav() {
    const navCollapsed = !get().navCollapsed;
    set({ navCollapsed });
    savePref("mediasorter.navCollapsed", { v: navCollapsed });
  },

  async reconcileKeys(items) {
    const { library, viewed } = get();
    if (!library) return;
    const missing = Object.keys(library.ratings).some((k) => !items.some((i) => i.key === k));
    if (!missing) return;
    const r = await reconcile({ ratings: library.ratings, ids: library.ids ?? {}, viewed, items, fingerprint: (p) => api.fileFingerprint(p) });
    if (r.moves.length === 0) return;
    const lib = get().library!;
    set({ library: { ...lib, ratings: r.ratings, ids: r.ids }, viewed: r.viewed });
    get().saveLibrary();
    scheduleHistorySave();
    get().toast(`${r.moves.length} rating${r.moves.length === 1 ? "" : "s"} followed moved files`, "ok");
  },

  setBrowseFilters(patch) {
    const browseFilters = { ...get().browseFilters, ...patch };
    set({ browseFilters });
    savePref("mediasorter.browseFilters", browseFilters);
  },

  setAlbumFilters(patch) {
    const albumFilters = { ...get().albumFilters, ...patch };
    set({ albumFilters });
    savePref("mediasorter.albumFilters", albumFilters);
  },

  toggleImmersive() {
    const immersive = !get().immersive;
    set({ immersive, hudHidden: immersive, infoOpen: false });
    if (immersive) get().toast("Immersive mode. Press C to leave");
  },

  toggleHud() {
    const hudHidden = !get().hudHidden;
    // Showing the HUD also leaves immersive mode; hiding it alone keeps the theme background.
    set({ hudHidden, immersive: hudHidden ? get().immersive : false, infoOpen: false });
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
        const ids = { ...(library.ids ?? {}) };
        if (entry.toKey in ids) {
          ids[entry.fromKey] = ids[entry.toKey];
          delete ids[entry.toKey];
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
          library: { ...library, ratings, ids },
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
    if (get().editMode) get().leaveEdit();
    set({ screen: "browse", settingsOpen: false, trashOpen: false, immersive: false, hudHidden: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
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
  const ids = { ...(library.ids ?? {}) };
  if (from.key in ids) {
    ids[to.key] = ids[from.key];
    delete ids[from.key];
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
    library: { ...library, ratings, ids },
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
