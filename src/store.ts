import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { debounced, flushAll } from "./lib/pending";
import { pageNumber } from "./lib/format";
import { api, setCurrentRoot, storedPath } from "./lib/api";
import { closeViews, loadViews, setView, view } from "./lib/views";
import { isPdfPage } from "./lib/pdf";
import { versionsKey } from "./lib/versions";
import { joined, pairKey, seriesIndex, together, without } from "./lib/series";
import { withSource } from "./lib/sources";
import { suggestHotkey } from "./lib/hotkeys";
import { findMoves, identityOf, nextSnapshot, readSnapshot, seenIn, snapshotSig, type Orphan } from "./lib/reconcile";
import { folderMoves, mover, rekeyRecord, type MovePair } from "./lib/moves";
import { applyLook, loadModeId, resolveMode, watchSystemMode, type Mode, type ResolvedMode, loadThemeId } from "./themes";
import { basename, shuffled, uid, naturalCompare, plainCompare } from "./lib/format";
import type { Album, AlbumRename, History, ItemSource, Library, LibrarySettings, MediaItem, Target, VaultStatus } from "./lib/types";
import { useEdit, type Pipeline } from "./editStore";
import { steppedJob } from "./lib/jobs";
import { PART, bucketOf, filedFolder, folderName, fromRoot, inTarget, isFilingName, ownFolderOf, partOf, targetFor, within } from "./lib/filing";
import { invoke } from "@tauri-apps/api/core";
import { cue } from "./lib/sounds";

export type Screen = "welcome" | "home" | "viewer" | "browse" | "dupes" | "albums" | "files" | "tags" | "people" | "artists" | "find" | "activity" | "scrapbook" | "cover";

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
  /** Tags: everything, only tagged, only untagged. */
  tagged: "all" | "tagged" | "untagged";
  /** Tags picked, and whether an item needs all of them or any. */
  tags: string[];
  tagsMode: "and" | "or";
  tagsOut: string[];
  tagsOutMode: "and" | "or";
  /** By any of these artists, or with any of these people in them. */
  artists: string[];
  people: string[];
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
  /** Tags the album must carry, and must not. */
  tags: string[];
  tagsMode: "and" | "or";
  tagsOut: string[];
  tagsOutMode: "and" | "or";
  /** By any of these artists, or with any of these people on its pages. */
  artists: string[];
  people: string[];
}
const DEFAULT_BROWSE: BrowseFilters = { location: "all", kind: "all", folders: null, query: "", sortBy: "name", desc: false, minRating: 0, unratedOnly: false, random: false, zoom: 220, layout: "masonry", tagged: "all", tags: [], tagsMode: "or", tagsOut: [], tagsOutMode: "or", artists: [], people: [] };
const DEFAULT_ALBUMS: AlbumFilters = { query: "", rootSel: "all", kind: "all", minRating: 0, unratedOnly: false, sortBy: "name", desc: false, random: false, zoom: 260, tags: [], tagsMode: "or", tagsOut: [], tagsOutMode: "or", artists: [], people: [] };

/** Preferences remembered on this computer: the bars folded away, and the last used of the library's settings (see lib/librarySettings), for before a library opens. */
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
      /** Moved with others as one (a series): undone with them. */
      batch?: string;
    }
  | { type: "rating"; key: string; prev: number | undefined; item: MediaItem };

interface State {
  root: string | null;
  library: Library | null;
  screen: Screen;
  /** Where Activity goes back to. */
  activityBack: Screen;
  /** Where the viewer goes back to (Esc, the arrow at the top left): the screen it was opened from. */
  viewerBack: Screen;
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
  /** An album's pages turn in the viewer as the theme's sticker book turns its own (kept on this computer). */
  pageTurns: boolean;
  /** Series kept together: whole in Sort (one key files all of it) and one tile in Browse; else each picture alone. */
  seriesTogether: boolean;
  driveOpen: boolean;
  immersive: boolean;
  backupOpen: boolean;
  vaultOpen: boolean;
  pluginsOpen: boolean;
  /** Settings → Updates. */
  updatesOpen: boolean;
  /** Settings → Local models. */
  modelsOpen: boolean;
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
  /** item key -> last viewed (ms); lives in .quire.history.json next to the media. */
  viewed: Record<string, number>;
  /** Filter state of the list screens, kept until changed (and across launches). */
  browseFilters: BrowseFilters;
  albumFilters: AlbumFilters;
  loading: string | null;
  busy: boolean;
  toasts: Toast[];
  undoStack: UndoEntry[];
  settingsOpen: boolean;
  /** The import dialog, open: with sources chosen already (a folder being organised, say), and what to do after. */
  importOpen: ImportRequest | null;
  /** The guided pass that brings what is in the library already into buckets. */
  organiseOpen: boolean;
  trashOpen: boolean;
  helpOpen: boolean;
  hudHidden: boolean;
  infoOpen: boolean;
  fullscreen: boolean;
  recentRoots: string[];
  /** Remember the folder the last target was picked from. */
  lastTargetParent: string | null;
  /** The item whose Info is open. */
  infoItem: MediaItem | null;
  /** The album whose Info is open. */
  infoAlbum: Album | null;
  /** Files moved or renamed by the Files screen: every list, the queue, ratings and tags follow the new paths. */
  relocatePaths(pairs: [string, string][]): void;
  /** Where pictures came from (Find), by key; they follow the files from then on. */
  addSources(entries: [string, ItemSource][]): void;
}

interface Actions {
  openRoot(root: string): Promise<void>;
  closeRoot(): void;
  rescan(quiet?: boolean): Promise<void>;
  saveLibrary(): Promise<void>;
  /** Settings changed: into the open library (see lib/librarySettings), saved when anything differs. */
  keepSettings(patch: Partial<LibrarySettings>): void;
  setIndex(i: number): void;
  next(): void;
  prev(): void;
  toggleShuffle(): void;
  setRating(item: MediaItem, rating: number | null): void;
  /** `folder`: into that folder of yours in the target's bucket (a path from the root), not the target's own. */
  moveCurrent(targetId: string, folder?: string): Promise<void>;
  trashCurrent(): Promise<void>;
  /** `batch`: one of several moved as one (a series), undone together; `folder`: as moveCurrent's. */
  moveItem(item: MediaItem, targetId: string, quiet?: boolean, batch?: string, folder?: string): Promise<boolean>;
  trashItem(item: MediaItem): Promise<boolean>;
  loadAll(force?: boolean): Promise<MediaItem[]>;
  openDupes(): void;
  openAlbums(): void;
  loadAlbums(force?: boolean): Promise<Album[]>;
  addAlbumRoot(absPath: string): void;
  removeAlbumRoot(path: string): void;
  moveAlbum(album: Album, targetId: string): Promise<boolean>;
  /** An album in the viewer, from its first page or the page `at` (its key). */
  openAlbum(album: Album, at?: string): Promise<void>;
  /** In an album with a translated version (or in that version): read the other one, at the same page. */
  switchTranslation(): Promise<void>;
  /** Viewer over the contents of several albums, in the given order. */
  openAlbums_Slideshow(albums: Album[]): Promise<void>;
  toggleFit(): void;
  setFitMode(fitMode: FitMode): void;
  setPageTurns(on: boolean): void;
  setSeriesTogether(on: boolean): void;
  /** These pictures one series (with any series they are in); in the viewer, its members come right after the one on show. */
  makeSeries(keys: string[]): void;
  /** These pictures out of their series. */
  leaveSeries(keys: string[]): void;
  /** A suggested series turned down: these pictures aren't suggested with `key` again. */
  notSeries(key: string, others: string[]): void;
  /** Album folders with URL-escaped names and their decoded names. */
  albumRenamePlan(): Promise<AlbumRename[]>;
  /** Rename those folders (all of the plan, or a chosen subset) and re-key their ratings. */
  applyAlbumRenames(plan: AlbumRename[]): Promise<number>;
  setAutoDecodeAlbumNames(on: boolean): void;
  setAlbumRatingByKey(key: string, rating: number | null): void;
  /** Link an album to its translated version (or unlink it, with null): linked, the two are one album. */
  setTranslation(key: string, translation: string | null): void;
  recordView(item: MediaItem): void;
  /** The order of a shuffled Browse grid: it changes only when Shuffle is pressed, not when the grid is opened again. */
  browseSeed: number;
  reshuffleBrowse(): void;
  /** Jump to a random item, favouring ones not seen lately. */
  surprise(): Promise<void>;
  toggleImmersive(): void;
  toggleHud(): void;
  setBrowseFilters(patch: Partial<BrowseFilters>): void;
  /** Re-attach ratings and history to files that were moved or renamed outside the app. */
  reconcileKeys(items: MediaItem[]): Promise<void>;
  navCollapsed: boolean;
  sideCollapsed: boolean;
  /** Top bar only (its own button). */
  toggleNav(): void;
  /** Sidebar only (its own button). */
  toggleSide(): void;
  /** H: hide both, or show both when either is hidden. */
  toggleChrome(): void;
  theme: string;
  /** Light, dark or the system's; and which of the two that is right now. */
  themeMode: Mode;
  mode: ResolvedMode;
  setThemeMode(mode: Mode): void;
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
  openTags(): void;
  /** Scrapbook: the covers made, and the sticker book. */
  openScrapbook(): void;
  openPeople(): void;
  /** The library's Home: its board of blocks (the brand in the top bar, ⇧H). */
  openHome(): void;
  /** The artists, or one artist's page. */
  openArtists(id?: string): void;
  openFind(): void;
  /** Everything running, full page; reached from the progress ring at the top. */
  openActivity(): void;
  closeActivity(): void;
  /** Enter edit mode on these items (shows the first; a save applies to all). */
  openEdit(items: MediaItem[]): void;
  leaveEdit(): void;
  /** Apply an edit to items in turn; updates queue, ratings and lists. */
  /** A file made from `item` (an edit, or a plugin's result) joins the lists; with `replace` it takes the item's place. */
  absorbEdit(item: MediaItem, made: MediaItem, replace: boolean): void;
  /** A version back to the original kept for it (the version to the trash); ⌘Z undoes it. `quiet`: one of many, said once by the caller. */
  revertItem(item: MediaItem, quiet?: boolean): Promise<boolean>;
  applyEdit(items: MediaItem[], op: Pipeline, replace: boolean, onProgress: (done: number, total: number, frac: number) => void): Promise<MediaItem[]>;
  undo(): Promise<void>;
  addTarget(absPath: string): void;
  /** A bucket: a folder at the top of the library, a target whose pictures are filed by year and day. */
  addBucket(name: string): Promise<Target | null>;
  updateTarget(id: string, patch: Partial<Target>): void;
  removeTarget(id: string): void;
  openBrowse(): void;
  openViewer(items: MediaItem[], index: number, source: QueueSource): void;
  /** Back to the screen the viewer was opened from. */
  closeViewer(): void;
  openSortQueue(): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: string): void;
  set(partial: Partial<State>): void;
  toggleFullscreen(): Promise<void>;
  emptyTrash(): Promise<number>;
}

export type Store = State & Actions;

export interface ImportRequest {
  sources?: string[];
  /** After an import ran, as the dialog closes (not when it closes without one); `back`: closed, not left for the pictures. */
  done?: (back: boolean) => void;
  /** Picks downloaded in Find, each with its files: one of several pages marked `album` comes in as an album of its own, the rest as single pictures. */
  works?: { files: string[]; folder: string; album?: boolean }[];
  /** Where the works came from: the platform's name, as its plugin gives it. */
  from?: string;
  /** Once they are in: each downloaded file and where it landed. */
  placed?: (pairs: [string, string][]) => void;
  /** As the dialog closes, whether or not anything came in. */
  closed?: () => void;
}

/** Pictures into a bucket, filed by the day; several as a job in Activity (pause, stop). How many went. */
export async function moveIntoBucket(items: MediaItem[], targetId: string): Promise<number> {
  const s = useStore.getState();
  const target = s.library?.targets.find((t) => t.id === targetId);
  if (!target) return 0;
  // In it already (in a folder of its with a key of its own, too): they stay where they are.
  const todo = items.filter((i) => !inTarget(i, target, s.library!.targets) && !i.albumKey);
  if (!todo.length) return 0;
  if (todo.length === 1) return (await s.moveItem(todo[0], targetId)) ? 1 : 0;
  const { job, gate } = steppedJob({ title: `Into ${target.name}`, source: "Buckets", total: todo.length });
  let n = 0;
  try {
    for (const it of todo) {
      if (!(await gate.pass())) break;
      if (await useStore.getState().moveItem(it, targetId, true)) n++;
      job.update({ done: n, items: [{ key: it.key, name: it.name }] });
    }
  } finally {
    job.finish();
  }
  useStore.getState().toast(`${n} into ${target.name}`, "ok");
  return n;
}

/** The first folder of a filed set with room for `need` more files (a pair needs two): the folder itself, then its parts. */
export async function roomIn(root: string, base: string, need = 1): Promise<string> {
  for (let k = 1; ; k++) {
    const folder = partOf(base, k);
    const n = await api.listDir(root, folder).then(
      (es) => es.filter((e) => !e.isDir).length,
      () => 0,
    );
    if (n + need <= PART || n === 0) return folder;
  }
}

const RECENT_KEY = "quire.recentRoots";

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

const itemOrder = (a: MediaItem, b: MediaItem) => plainCompare(a.dir, b.dir) || naturalCompare(a.name, b.name);

export function sortItems(items: MediaItem[]): MediaItem[] {
  return items.slice().sort(itemOrder);
}

/** A sorted list with one more item, put in its place: a move or an edit needn't sort the whole library again. */
export function withSorted(sorted: MediaItem[], item: MediaItem): MediaItem[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (itemOrder(sorted[mid], item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  const out = sorted.slice();
  out.splice(lo, 0, item);
  return out;
}


/** An album's pages in reading order: a folder's pictures, or a PDF's pages (drawn from it). */
export async function albumPages(root: string, album: Album): Promise<MediaItem[]> {
  const items = album.pdf ? await api.pdfPages(root, album.path) : sortItems(await api.scanDir(root, album.path));
  return items.map((i) => ({ ...i, albumKey: album.key }));
}

/** A PDF's page stays in its PDF: moved, trashed or edited only as the whole album (said so). */
function pdfPageStays(item: MediaItem): boolean {
  if (!isPdfPage(item)) return false;
  useStore.getState().toast("A PDF's pages stay in their PDF: move or trash the whole album in Albums", "warn");
  return true;
}
/** Where the viewer's back goes: the screen it was opened from; opened again from the viewer (or Activity), where it went before. */
const backTo = (s: State): Screen => (s.screen === "viewer" || s.screen === "activity" ? s.viewerBack : s.screen);

const historySave = debounced("history", 2000, async (root) => {
  if (useStore.getState().root !== root) return;
  const history: History = { version: 1, viewed: useStore.getState().viewed };
  await api.saveHistory(root, history).catch(() => {});
});
function scheduleHistorySave() {
  const root = useStore.getState().root;
  if (root) historySave.schedule(root);
}

/** The library, written a moment after the last change: for the library it belonged to, never one opened since. */
const librarySave = debounced("library", 250, async (root) => {
  const { root: now, library } = useStore.getState();
  if (now !== root || !library) return;
  try {
    await api.saveLibrary(root, library);
  } catch (e) {
    useStore.getState().toast(`Could not save library: ${e}`, "error");
  }
});

/** A library's settings being taken in (see lib/librarySettings): their setters don't keep them back into it. */
let takingSettings = false;
export function takingFromLibrary(run: () => void) {
  takingSettings = true;
  try {
    run();
  } finally {
    takingSettings = false;
  }
}

function loadSeriesTogether(): boolean {
  try {
    return localStorage.getItem("quire.seriesTogether") !== "0";
  } catch {
    return true;
  }
}

function loadPageTurns(): boolean {
  try {
    return localStorage.getItem("quire.pageTurns") !== "0";
  } catch {
    return true;
  }
}

function loadFit(): FitMode {
  try {
    return localStorage.getItem("quire.fit") === "fill" ? "fill" : "fit";
  } catch {
    return "fit";
  }
}

/**
 * Opening or unlocking waits on the library's drive. One that stops answering (macOS stuck reading
 * it, as a FAT drive once was) would leave that waiting for good with no word: after 15 seconds it
 * says what is going on and what to do. Call the result when the wait is over.
 */
function driveWatch(): () => void {
  const t = setTimeout(() => {
    const s = useStore.getState();
    if (s.loading) useStore.setState({ loading: "Waiting for the drive to answer…" });
    s.toast("The drive isn't answering: macOS is still waiting on it. If this stays, unplug the drive or restart the Mac, then check it with First Aid in Disk Utility before opening it again.", "error");
  }, 15_000);
  return () => clearTimeout(t);
}

/** The library's documents in words, for saying what came back. */
function docWords(names: string[]): string[] {
  const words: Record<string, string> = { tags: "your tags", "tags-before-split": "your tags", home: "the Home", scrapbook: "the scrapbook", snapshot: "where files were", artists: "artists", people: "people", faces: "faces", find: "Find", history: "what was seen", library: "the library file", versions: "versions", cache: "the cache" };
  const out = names.map((n) => (/^tag(index|vectors|journal)/.test(n) ? "the tag index" : n.startsWith("plugin-") ? "plugins' settings" : (words[n.replace(/\.broken$/, "")] ?? n)));
  return [...new Set(out)];
}

/** What a vault took in as it opened, said once. */
function sayAdopted(a: import("./lib/types").VaultAdopted) {
  const back = docWords([...a.documents, ...a.restored]);
  if (!back.length && !a.pictures) return;
  const parts = [...back, ...(a.pictures ? [`${a.pictures} scrapbook picture${a.pictures === 1 ? "" : "s"} (stickers, covers, artists' icons)`] : [])];
  const aside = a.restored.length ? ` The ones made since in their place are kept aside in the vault.` : "";
  useStore.getState().toast(`Brought into the vault from before it was made: ${parts.join(", ")}.${aside}`, "ok");
}

/** Libraries whose vault is moving its files into folders now (see tidyVault). */
const tidying = new Set<string>();

/** The vault's files still all in one folder, as earlier versions kept them, moved into their folders (a job in Activity). */
async function tidyVault(root: string) {
  if (tidying.has(root)) return;
  tidying.add(root);
  try {
    if (await api.vaultUnsharded(root).catch(() => false)) await api.vaultShard(root);
  } catch (e) {
    useStore.getState().toast(`Not all of the vault's files moved into folders: ${String(e)}. The rest moves the next time it opens.`, "warn");
  } finally {
    tidying.delete(root);
  }
}

export const useStore = create<Store>((set, get) => ({
  root: null,
  library: null,
  screen: "welcome",
  activityBack: "browse",
  viewerBack: "browse",
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
  pageTurns: loadPageTurns(),
  seriesTogether: loadSeriesTogether(),
  driveOpen: false,
  immersive: false,
  backupOpen: false,
  vaultOpen: false,
  pluginsOpen: false,
  updatesOpen: false,
  modelsOpen: false,
  zoom: { level: 0, preferredLevel: 2, focal: { x: 0.5, y: 0.5 }, pan: { px: 0, py: 0 } },
  editMode: false,
  editItems: [],
  vault: null,
  pendingRoot: null,
  needsNewPassphrase: false,
  viewed: {},
  navCollapsed: loadPref<{ v: boolean }>("quire.navCollapsed", { v: false }).v,
  sideCollapsed: loadPref<{ v: boolean }>("quire.sideCollapsed", { v: false }).v,
  theme: loadThemeId(),
  themeMode: loadModeId(),
  mode: resolveMode(loadModeId()),
  slideshow: { playing: false, hidByShow: false, ...loadPref<{ interval: number; hideUi: boolean }>("quire.slideshow", { interval: 5, hideUi: true }) },
  browseFilters: DEFAULT_BROWSE,
  browseSeed: 1,
  infoItem: null,
  infoAlbum: null,
  albumFilters: DEFAULT_ALBUMS,
  loading: null,
  busy: false,
  toasts: [],
  undoStack: [],
  settingsOpen: false,
  importOpen: null,
  organiseOpen: false,
  trashOpen: false,
  helpOpen: false,
  hudHidden: false,
  infoOpen: false,
  fullscreen: false,
  recentRoots: loadRecent(),
  lastTargetParent: null,

  set: (partial) => set(partial),

  toast(text, tone = "info") {
    if (tone === "error") cue("error");
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    // Long enough to read: longer for a long one.
    setTimeout(() => get().dismissToast(id), Math.max(tone === "error" ? 6000 : 2500, text.length * 50));
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  async openRoot(root) {
    // What the library open now still has to write goes first, so nothing lands in the new one.
    await flushAll();
    // Held by this copy of the app, before anything of it is read: another copy (a dev build beside
    // the released app) can't have it open meanwhile, and one with it open already says so here.
    try {
      await api.libraryClaim(root);
    } catch (e) {
      get().toast(String(e), "error");
      return;
    }
    set({ loading: "Reading library…" });
    const slow = driveWatch();
    try {
      // Its files from when the app was Media Sorter get Quire's names, before anything of it is read.
      const named = await api.libraryAdoptNames(root);
      if (named?.kept.length) {
        get().toast(`Some of this library's files from Media Sorter were left as they were, because Quire has its own by those names: ${named.kept.join(", ")}`, "warn");
      }
      setCurrentRoot(root);
      const vault = await api.vaultStatus(root).catch(() => null);
      if (vault?.exists && !vault.unlocked) {
        // Development aid: QUIRE_PASSPHRASE skips the prompt.
        const dev = await api.devPassphrase().catch(() => null);
        let unlocked = false;
        if (dev) {
          try {
            await api.vaultUnlock(root, dev);
            unlocked = true;
          } catch {
            /* fall through to the prompt */
          }
        }
        if (!unlocked) {
          // Ask for the passphrase first; unlockVault calls openRoot again.
          set({ loading: null, vault, pendingRoot: root, screen: "welcome" });
          return;
        }
      }
      set({ vault, pendingRoot: null });
      // What an earlier version left in the clear beside the vault (its tags, Home, scrapbook…),
      // taken in before anything of the library is read.
      if (vault?.exists) {
        const adopted = await api.vaultAdopt(root).catch(() => null);
        if (adopted) sayAdopted(adopted);
      }
      const library = await api.loadLibrary(root);
      // What its screens were left showing, before they show.
      await loadViews(root);
      const history = await api.loadHistory(root).catch(() => null);
      set({ loading: "Scanning folder…", viewed: history?.viewed ?? {} });
      const unsorted = sortItems(await api.scanUnsorted(root, library));
      // Where it opens: its Home, Sort, or the screen it was left on, as its Home says.
      const { useHome, REMEMBERED } = await import("./home/store");
      const home = await useHome.getState().load(true, root).catch(() => null);
      const last = home?.last?.screen;
      const opensOn: Screen = home?.opensOn === "sort" ? "viewer" : home?.opensOn === "last" && last && REMEMBERED.has(last) ? (last as Screen) : "home";
      const recent = [root, ...get().recentRoots.filter((r) => r !== root)];
      saveRecent(recent);
      set({
        root,
        library: joinRatings(library),
        unsorted,
        queue: unsorted,
        index: 0,
        source: { kind: "unsorted" },
        shuffle: false,
        screen: opensOn,
        loading: null,
        undoStack: [],
        recentRoots: recent,
        // Straight into Sort with nowhere to file to: the targets first (the Home says so itself).
        settingsOpen: opensOn === "viewer" && library.targets.length === 0,
        browseFilters: { ...DEFAULT_BROWSE, ...view<Partial<BrowseFilters>>("browseFilters", {}) },
        albumFilters: { ...DEFAULT_ALBUMS, ...view<Partial<AlbumFilters>>("albumFilters", {}) },
        allItems: [],
        allLoaded: false,
        allStale: false,
        albums: [],
        albumsLoaded: false,
      });
      // Its settings (the theme, sounds, going online…) taken in; those it hasn't, given it from this computer's.
      (await import("./lib/librarySettings")).adoptSettings();
      get().toast(`${unsorted.length} unsorted items`, "ok");
      // Full scan in the background: feeds Browse and re-attaches ratings to moved files.
      void get().loadAll(true);
      if (vault?.exists) void tidyVault(root);
    } catch (e) {
      set({ loading: null });
      get().toast(String(e), "error");
      // The library still open keeps its hold (the claim moved to the one that didn't open).
      const open = get().root;
      if (open && open !== root) void api.libraryClaim(open).catch(() => {});
    } finally {
      slow();
    }
  },

  closeRoot() {
    // Written before anything is forgotten (a rating given just now is kept), then let go of.
    void flushAll().then(() => {
      closeViews();
      return api.libraryRelease().catch(() => {});
    });
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
      importOpen: null,
      organiseOpen: false,
      trashOpen: false,
      // Every page of Settings, so none stays open over the Welcome; and nothing of the library goes on.
      driveOpen: false,
      backupOpen: false,
      pluginsOpen: false,
      modelsOpen: false,
      updatesOpen: false,
      editMode: false,
      editItems: [],
      slideshow: { ...get().slideshow, playing: false },
    });
  },

  async rescan(quiet = false) {
    const { root, library, source } = get();
    if (!root || !library) return;
    set({ loading: "Scanning folder…" });
    try {
      const unsorted = sortItems(await api.scanUnsorted(root, library));
      if (get().root !== root) return;
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
    librarySave.schedule(root);
  },

  keepSettings(patch) {
    const library = get().library;
    if (!library || takingSettings) return;
    const kept = library.settings ?? {};
    const changed = (Object.keys(patch) as (keyof LibrarySettings)[]).some((k) => JSON.stringify(patch[k]) !== JSON.stringify(kept[k]));
    if (!changed) return;
    set({ library: { ...library, settings: { ...kept, ...patch } } });
    void get().saveLibrary();
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
    cue("rate");
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

  async moveCurrent(targetId, folder) {
    const { queue, index, seriesTogether, library, busy } = get();
    const item = queue[index];
    // An album's page stays in its album: the album moves whole, from Albums.
    if (!item || item.albumKey) return;
    // Heard as the key is pressed, not once the files have moved.
    if (!busy && library?.targets.some((t) => t.id === targetId)) cue("move");
    // Kept together, a series goes as one: every picture of it in the queue, undone as one too.
    const series = seriesTogether ? seriesIndex(library?.series).get(item.key) : undefined;
    const members = series ? queue.filter((q) => series.includes(q.key)) : [];
    if (members.length < 2) return void (await get().moveItem(item, targetId, false, undefined, folder));
    const batch = uid();
    let n = 0;
    for (const m of members) if (await get().moveItem(m, targetId, true, batch, folder)) n++;
    const target = library?.targets.find((t) => t.id === targetId);
    if (n) get().toast(`→ ${target?.name ?? "moved"}: the series of ${n}`, "ok");
  },

  async trashCurrent() {
    const item = get().queue[get().index];
    if (!item) return;
    // Heard as the key is pressed, not once the files have moved.
    if (!get().busy && !isPdfPage(item)) cue("trash");
    await get().trashItem(item);
  },

  async moveItem(item, targetId, quiet = false, batch, folder) {
    if (pdfPageStays(item)) return false;
    const { root, library, busy } = get();
    const target = library?.targets.find((t) => t.id === targetId);
    if (!root || !library || !target || busy) return false;
    // Into a bucket, a folder of yours in one, or a target inside one: filed under the year and day
    // it went in, in that folder. A target outside every bucket takes it as it is.
    const bucket = bucketOf(target, library.targets);
    const base = bucket && folder && within(folder, target.path) ? folder : target.path;
    // There already (anywhere in the target, or in the folder chosen): it stays in the folder it was filed in.
    if (bucket && (base !== target.path ? ownFolderOf(item.dir, bucket.path) === base : inTarget(item, target, library.targets))) return true;
    const name = base === target.path ? target.name : [target.name, ...base.slice(target.path.length + 1).split("/")].join(" › ");
    set({ busy: true });
    try {
      const dest = bucket ? await roomIn(root, filedFolder(base, new Date()), item.files.length) : target.path;
      const res = await api.moveItem(root, item, dest);
      // The target it is in now: the deepest one holding it (a folder of yours may have a key of its own).
      applyMove(res.moved, item, { ...res.item, targetId: targetFor(res.item.key, library.targets)?.id ?? targetId }, `Moved to ${name}`, false, batch);
      if (!quiet) get().toast(`→ ${name}`, "ok");
      return true;
    } catch (e) {
      get().toast(String(e), "error");
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async trashItem(item) {
    if (pdfPageStays(item)) return false;
    const { root, library, busy } = get();
    if (!root || !library || busy) return false;
    set({ busy: true });
    try {
      const res = await api.trashItem(root, library, item);
      applyMove(res.moved, item, res.item, "Deleted", true);
      set({ albumsLoaded: false });
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
      // Another library opened while this one was scanned: its files aren't this one's.
      if (get().root !== root) return allItems;
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
      if (get().root !== root) return albums;
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


  async moveAlbum(album, targetId) {
    const { root, library, busy } = get();
    const target = library?.targets.find((t) => t.id === targetId);
    if (!root || !library || !target || busy) return false;
    set({ busy: true });
    try {
      // A PDF album is one file; a folder album its folder.
      const newPath = album.pdf ? (await api.fsMove(root, [album.path], target.path))[0] : await api.moveDir(root, album.path, target.path);
      set({ albums: get().albums.filter((a) => a.key !== album.key), allStale: true });
      // The album's rating, tags, language, and its pages' ratings, tags and fingerprints go with it.
      followMoves([[album.key, storedPath(root, newPath)]]);
      get().toast(`Album → ${target.name}`, "ok");
      return true;
    } catch (e) {
      get().toast(String(e), "error");
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async openAlbum(album, at) {
    const { root } = get();
    if (!root) return;
    const viewerBack = backTo(get());
    try {
      const items = await albumPages(root, album);
      set({ screen: "viewer", queue: items, index: Math.max(0, at ? items.findIndex((i) => i.key === at) : 0), source: { kind: "albums" }, shuffle: false, viewerBack });
    } catch (e) {
      get().toast(String(e), "error");
    }
  },

  async switchTranslation() {
    const { root, library, queue, index } = get();
    const cur = queue[index];
    if (!root || !cur?.albumKey) return;
    const links = library?.albumTranslations ?? {};
    const otherKey = links[cur.albumKey] ?? Object.keys(links).find((k) => links[k] === cur.albumKey);
    if (!otherKey) return;
    const albums = get().albums.length ? get().albums : await get().loadAlbums();
    const other = albums.find((a) => a.key === otherKey);
    if (!other) {
      get().toast("The other version of this album is gone", "warn");
      return;
    }
    try {
      const items = await albumPages(root, other);
      if (!items.length) return get().toast(`${other.name} is empty`, "warn");
      // The same page: the one numbered as this one is (a page missing on one side shifts the
      // rest, so the place alone would land a page off); by place when the pages aren't numbered.
      const n = pageNumber(cur.name);
      const byNumber = n == null ? -1 : items.findIndex((i) => pageNumber(i.name) === n);
      set({ queue: items, index: byNumber >= 0 ? byNumber : Math.min(index, items.length - 1) });
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
      set({ albumsLoaded: false, allStale: true });
      // The albums and everything kept below them.
      followMoves(done.map((r) => [r.fromKey, r.toKey] as MovePair));
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
    const viewerBack = backTo(get());
    set({ loading: "Reading albums…" });
    try {
      const items = (await Promise.all(albums.map((a) => albumPages(root, a)))).flat();
      set({ screen: "viewer", queue: items, index: 0, source: { kind: "albums" }, shuffle: false, loading: null, viewerBack });
    } catch (e) {
      set({ loading: null });
      get().toast(String(e), "error");
    }
  },

  setAlbumRatingByKey(album, rating) {
    const { library } = get();
    if (!library) return;
    cue("rate");
    // One rating for an album and its translated version, kept on the original.
    const key = originalOf(album);
    const albumRatings = { ...library.albumRatings };
    const translation = library.albumTranslations?.[key];
    if (translation) delete albumRatings[translation];
    if (rating == null) delete albumRatings[key];
    else albumRatings[key] = rating;
    set({ library: { ...library, albumRatings } });
    get().saveLibrary();
  },

  setTranslation(key, translation) {
    const lib = get().library;
    if (!lib) return;
    const was = lib.albumTranslations?.[key];
    const albumTranslations = { ...(lib.albumTranslations ?? {}) };
    if (translation) albumTranslations[key] = translation;
    else delete albumTranslations[key];
    // Unlinked, a translated version keeps a copy of what the two had; linked, its own join its original's.
    const albumRatings = { ...lib.albumRatings };
    if (was && was !== translation && albumRatings[key] != null) albumRatings[was] = albumRatings[key];
    set({ library: joinRatings({ ...lib, albumTranslations, albumRatings }) });
    void get().saveLibrary();
    if (was && was !== translation) {
      void import("./tagsStore").then(({ useTags }) => useTags.getState().splitVersion(key, was));
      void import("./artistsStore").then(({ useArtists }) => useArtists.getState().splitVersion(key, was));
    }
  },

  addSources(entries) {
    const lib = get().library;
    if (!lib || !entries.length) return;
    const byKey = new Map(get().allItems.map((i) => [i.key, i]));
    const ids = { ...(lib.ids ?? {}) };
    for (const [k] of entries) {
      const it = byKey.get(k);
      if (it && !ids[k]) ids[k] = identityOf(it);
    }
    // A work that came in as an album says its language: the album's, unless it has one already.
    const albumLanguages = { ...(lib.albumLanguages ?? {}) };
    for (const [k, src] of entries) {
      const root = src.language ? lib.albumRoots.map((r) => r.replace(/\/+$/, "")).find((r) => k.startsWith(`${r}/`)) : undefined;
      const rest = root ? k.slice(root.length + 1) : "";
      if (root && rest.includes("/")) albumLanguages[`${root}/${rest.slice(0, rest.indexOf("/"))}`] ??= src.language!;
    }
    // A picture from another work already: this one is the same work posted elsewhere, kept beside it.
    const sources = { ...(lib.sources ?? {}) };
    for (const [k, src] of entries) sources[k] = withSource(sources[k], src);
    set({ library: { ...lib, ids, sources, albumLanguages } });
    get().saveLibrary();
    // Their platform's tags linked to yours come with them.
    void import("./tagsStore").then(({ useTags }) => useTags.getState().applySources(entries));
  },

  relocatePaths(pairs) {
    const { root } = get();
    if (!root || !pairs.length) return;
    const rel = (abs: string) => abs.slice(root.length).replace(/^\/+/, "");
    // An item under an old path (the file itself, or a folder above it) gets the new one.
    const moved = (p: string): string | null => {
      for (const [from, to] of pairs) {
        if (p === from) return to;
        if (p.startsWith(from.replace(/\/+$/, "") + "/")) return to.replace(/\/+$/, "") + p.slice(from.replace(/\/+$/, "").length);
      }
      return null;
    };
    const base = root.replace(/\/+$/, "");
    const inside = (p: string) => p.startsWith(`${base}/`);
    // A sort target outside the library whose folder (or a folder above it) moved points at its new
    // place; one inside it follows below, with everything else kept by its path.
    const lib = get().library;
    const targets = lib?.targets.map((t) => {
      const to = moved(t.path);
      return to ? { ...t, path: to } : t;
    });
    const targetsMoved = !!lib && targets!.some((t, i) => t !== lib.targets[i]);
    // Where things are after the move, to say what is in which target, and what the Sort queue
    // leaves out (anything in a target, the trash or an album folder) before and after.
    const after = (path: string) => (path.startsWith("/") ? path : (() => { const to = moved(`${base}/${path}`); return to && inside(to) ? rel(to) : path; })());
    const targetsAfter = (targets ?? []).map((t) => ({ ...t, path: after(t.path) }));
    const rootsBefore = (lib?.albumRoots ?? []).map((r) => fromRoot(root, r));
    const rootsAfter = rootsBefore.map(after);
    const sortedBefore = (key: string) => !!lib && (!!targetFor(key, lib.targets) || within(key, lib.trashDir) || rootsBefore.some((r) => within(key, r)));
    const sortedAfter = (key: string) => !!lib && (!!targetFor(key, targetsAfter) || within(key, after(lib.trashDir)) || rootsAfter.some((r) => within(key, r)));
    const fix = (it: MediaItem): MediaItem => {
      const primary = moved(it.primary);
      if (!primary) return it;
      const key = rel(primary);
      // In the target that holds it now (moved in Files into a bucket, say, or out of one).
      const targetId = lib && inside(primary) ? targetFor(key, targetsAfter)?.id : it.targetId;
      return { ...it, primary, key, files: it.files.map((f) => moved(f) ?? f), dir: key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "", targetId };
    };
    const keyPairs: [string, string][] = [];
    const walk = (list: MediaItem[]) => list.map((it) => { const n = fix(it); if (n !== it) keyPairs.push([it.key, n.key]); return n; });
    const allItems = walk(get().allItems);
    // Moved into a target (or the trash, an album folder): out of the Sort queue, the picture shown kept if it is still there.
    const left = (before: MediaItem[], now: MediaItem[]) => now.filter((it, i) => it === before[i] || !inside(it.primary) || !sortedAfter(it.key));
    const unsorted0 = get().unsorted;
    const unsorted = left(unsorted0, walk(unsorted0));
    const queue0 = get().queue;
    const walked = walk(queue0);
    const queue = get().source.kind === "unsorted" ? left(queue0, walked) : walked;
    const current = walked[get().index];
    const at = current ? queue.indexOf(current) : -1;
    const index = queue.length === 0 ? 0 : at >= 0 ? at : Math.min(get().index, queue.length - 1);
    set({ queue, index, allItems, unsorted, infoItem: get().infoItem ? fix(get().infoItem!) : null, albumsLoaded: false, ...(targetsMoved ? { library: { ...lib!, targets: targets! } } : {}) });
    if (targetsMoved) void get().saveLibrary();
    // Moved out of a target to where Sort looks: found by a scan (what was in a folder needn't be loaded).
    if (pairs.some(([from, to]) => inside(from) && inside(to) && sortedBefore(rel(from)) && !sortedAfter(rel(to)))) void get().rescan(true);
    // Files and whole folders: what is kept by key goes with them, whether loaded or not.
    followMoves(pairs.filter(([from, to]) => inside(from) && inside(to)).map(([from, to]) => [rel(from), rel(to)] as MovePair));
  },

  recordView(item) {
    const { root } = get();
    if (!root) return;
    const viewed = { ...get().viewed, [item.key]: Date.now() };
    set({ viewed });
    scheduleHistorySave();
  },

  reshuffleBrowse() {
    set({ browseSeed: Math.floor(Math.random() * 2 ** 31) + 1 });
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
    const slow = driveWatch();
    try {
      if (recovery) await api.vaultUnlockRecovery(root, secret);
      else await api.vaultUnlock(root, secret);
    } catch (e) {
      slow();
      get().toast(String(e), "error");
      return false;
    }
    slow();
    set({ pendingRoot: null, needsNewPassphrase: recovery });
    await get().openRoot(root);
    if (recovery) set({ vaultOpen: true });
    return true;
  },

  async unlockVaultQuick() {
    const root = get().pendingRoot ?? get().root;
    if (!root) return false;
    const slow = driveWatch();
    try {
      await api.vaultUnlockQuick(root);
    } catch (e) {
      slow();
      get().toast(String(e), "error");
      return false;
    }
    slow();
    set({ pendingRoot: null, needsNewPassphrase: false });
    await get().openRoot(root);
    return true;
  },

  async lockVault() {
    // What is still waiting to be saved goes into the vault first: once it is locked, nothing of the
    // library is written beside it (the backend refuses).
    await flushAll().catch(() => {});
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
    if (!items.length || items.some(pdfPageStays)) return;
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

  absorbEdit(item, made, replace) {
    const s = get();
    const lib = s.library!;
    const ratings = { ...lib.ratings };
    const ids = { ...(lib.ids ?? {}) };
    if (replace && item.key in ratings) {
      ratings[made.key] = ratings[item.key];
      delete ratings[item.key];
      if (ids[item.key]) {
        ids[made.key] = { ...identityOf(made), f: undefined };
        delete ids[item.key];
      }
    }
    // Queue: replace in place, or insert the copy right after the original.
    const qi = s.queue.findIndex((q) => q.key === item.key);
    const queue = s.queue.slice();
    if (qi >= 0) {
      if (replace) queue[qi] = made;
      else queue.splice(qi + 1, 0, made);
    }
    const drop = (list: MediaItem[]) => (replace ? list.filter((i) => i.key !== item.key) : list);
    set({
      library: { ...lib, ratings, ids },
      queue,
      index: replace ? s.index : Math.min(s.index, queue.length - 1),
      unsorted: !item.targetId && !item.albumKey ? withSorted(drop(s.unsorted), made) : drop(s.unsorted),
      allItems: withSorted(drop(s.allItems), made),
    });
    get().saveLibrary();
    if (replace) followMoves([[item.key, made.key]]);
  },

  async revertItem(item, quiet = false) {
    const { root, library } = get();
    if (!root || !library) return false;
    try {
      const r = await api.versionRevert(root, library, item);
      const at = get().queue.findIndex((q) => q.key === item.key);
      get().absorbEdit(item, r.item, true);
      set({ undoStack: [...get().undoStack.slice(-49), { type: "move", label: `Back to ${r.item.name}`, moves: r.moves, item, index: at >= 0 ? at : get().index, fromKey: item.key, toKey: r.item.key }] });
      if (quiet) return true;
      void import("./versionsStore").then(({ useVersions }) => useVersions.getState().load(true));
      get().toast(`Back to ${r.item.name}; ⌘Z undoes it`, "ok");
      return true;
    } catch (e) {
      if (!quiet) get().toast(`Couldn't revert ${item.name}: ${e}`, "error");
      return false;
    }
  },

  async applyEdit(items, op, replace, onProgress) {
    const { root } = get();
    if (!root) return [];
    const results: MediaItem[] = [];
    // In Activity too: a video edit can take minutes. The bar moves within an item as it goes.
    // Pause and Stop reach ffmpeg mid-edit (suspended, or ended) and hold or end the batch between items.
    const backend = `edit-${Date.now()}`;
    const { job, gate } = steppedJob({
      title: items.length === 1 ? `Editing ${items[0].name}` : `Editing ${items.length} items`,
      source: "Edit",
      total: items.length,
      onPause: (on) => void invoke("job_pause", { id: backend, on }).catch(() => {}),
      onStop: () => void invoke("job_stop", { id: backend }).catch(() => {}),
    });
    try {
      for (let k = 0; k < items.length; k++) {
        if (!(await gate.pass())) break;
        const item = items[k];
        const library = get().library!;
        job.update({ done: k, detail: `${k + 1} of ${items.length}: ${item.name}`, items: [{ key: item.key, name: item.name }] });
        try {
          const r = await api.editApply(
            root,
            library,
            item,
            op,
            replace,
            (f) => {
              onProgress(k, items.length, f);
              job.update({ done: k + f });
            },
            backend,
          );
          get().absorbEdit(item, r.item, replace);
          results.push(r.item);
          void import("./versionsStore").then(({ useVersions }) => useVersions.getState().load(true));
        } catch (e) {
          if (!gate.stopped) get().toast(`${item.name}: ${e}`, "error");
        }
      }
    } finally {
      job.finish();
    }
    onProgress(items.length, items.length, 1);
    return results;
  },

  openFiles() {
    if (get().editMode) get().leaveEdit();
    set({ screen: "files", settingsOpen: false, trashOpen: false, immersive: false, hudHidden: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
  },

  openTags() {
    if (get().editMode) get().leaveEdit();
    set({ screen: "tags", hudHidden: false });
    void get().loadAll();
  },

  openScrapbook() {
    if (get().editMode) get().leaveEdit();
    set({ screen: "scrapbook", hudHidden: false });
    void get().loadAll();
  },

  openPeople() {
    if (get().editMode) get().leaveEdit();
    set({ screen: "people", hudHidden: false });
  },

  openHome() {
    if (!get().root) return;
    if (get().editMode) get().leaveEdit();
    set({ screen: "home", settingsOpen: false, trashOpen: false, immersive: false, hudHidden: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
  },

  openArtists(id) {
    if (get().editMode) get().leaveEdit();
    set({ screen: "artists", hudHidden: false });
    void import("./artistsStore").then(({ useArtists }) => id !== undefined && useArtists.getState().setOpen(id));
  },

  openFind() {
    if (get().editMode) get().leaveEdit();
    set({ screen: "find", hudHidden: false });
  },

  openActivity() {
    const from = get().screen;
    if (from === "activity") return;
    if (get().editMode) get().leaveEdit();
    set({ screen: "activity", activityBack: from, hudHidden: false, immersive: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
  },

  closeActivity() {
    // Straight back: the screen's lists and the viewer's queue are still in the store.
    set({ screen: get().activityBack === "activity" ? "browse" : get().activityBack });
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
    savePref("quire.slideshow", { interval: seconds, hideUi: slideshow.hideUi });
    get().keepSettings({ slideshow: { interval: seconds, hideUi: slideshow.hideUi } });
  },

  setSlideshowHideUi(on) {
    const slideshow = { ...get().slideshow, hideUi: on };
    set({ slideshow });
    savePref("quire.slideshow", { interval: slideshow.interval, hideUi: on });
    get().keepSettings({ slideshow: { interval: slideshow.interval, hideUi: on } });
  },

  setTheme(id) {
    const mode = applyLook(id, get().themeMode);
    set({ theme: id, mode });
    get().keepSettings({ theme: id });
  },

  setThemeMode(themeMode) {
    const mode = applyLook(get().theme, themeMode);
    set({ themeMode, mode });
    get().keepSettings({ mode: themeMode });
  },

  toggleNav() {
    const navCollapsed = !get().navCollapsed;
    set({ navCollapsed });
    savePref("quire.navCollapsed", { v: navCollapsed });
  },

  toggleSide() {
    const sideCollapsed = !get().sideCollapsed;
    set({ sideCollapsed });
    savePref("quire.sideCollapsed", { v: sideCollapsed });
  },

  toggleChrome() {
    const { navCollapsed, sideCollapsed } = get();
    const hide = !(navCollapsed && sideCollapsed);
    set({ navCollapsed: hide, sideCollapsed: hide });
    savePref("quire.navCollapsed", { v: hide });
    savePref("quire.sideCollapsed", { v: hide });
  },

  async reconcileKeys(items) {
    // One at a time: a second look (Browse opened while the first ran) starts once the first is done,
    // from what it left.
    const run = reconciling.then(() => reconcileNow(items));
    reconciling = run.catch(() => {});
    try {
      await run;
    } catch (e) {
      get().toast(`Couldn't look for files moved outside the app: ${String(e)}`, "error");
    }
  },

  setBrowseFilters(patch) {
    const browseFilters = { ...get().browseFilters, ...patch };
    set({ browseFilters });
    setView("browseFilters", browseFilters);
  },

  setAlbumFilters(patch) {
    const albumFilters = { ...get().albumFilters, ...patch };
    set({ albumFilters });
    setView("albumFilters", albumFilters);
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

  setPageTurns(on) {
    try {
      localStorage.setItem("quire.pageTurns", on ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ pageTurns: on });
    get().keepSettings({ pageTurns: on });
  },

  setSeriesTogether(on) {
    try {
      localStorage.setItem("quire.seriesTogether", on ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ seriesTogether: on });
    get().keepSettings({ seriesTogether: on });
  },

  makeSeries(keys) {
    const { library, queue, index, seriesTogether } = get();
    if (!library || keys.length < 2) return;
    const series = joined(library.series ?? [], keys);
    set({ library: { ...library, series } });
    get().saveLibrary();
    // Together, the rest of it follows the picture on show in the viewer.
    const cur = queue[index];
    const made = series[series.length - 1];
    if (!seriesTogether || !cur || !made.includes(cur.key)) return;
    const members = new Set(made);
    const rest = queue.filter((q) => !members.has(q.key) || q.key === cur.key);
    const after = made.filter((k) => k !== cur.key).flatMap((k) => queue.filter((q) => q.key === k));
    const at = rest.indexOf(cur);
    set({ queue: [...rest.slice(0, at + 1), ...after, ...rest.slice(at + 1)], index: at });
  },

  leaveSeries(keys) {
    const { library } = get();
    if (!library?.series?.length) return;
    set({ library: { ...library, series: without(library.series, keys) } });
    get().saveLibrary();
  },

  notSeries(key, others) {
    const { library } = get();
    if (!library || !others.length) return;
    const seriesNot = [...new Set([...(library.seriesNot ?? []), ...others.map((o) => pairKey(key, o))])];
    set({ library: { ...library, seriesNot } });
    get().saveLibrary();
  },

  toggleFit() {
    const fitMode: FitMode = get().fitMode === "fit" ? "fill" : "fit";
    get().setFitMode(fitMode);
    get().toast(fitMode === "fit" ? "Fit: whole image visible" : "Fill: edge to edge, may crop");
  },

  setFitMode(fitMode) {
    try {
      localStorage.setItem("quire.fit", fitMode);
    } catch {
      /* ignore */
    }
    set({ fitMode });
    get().keepSettings({ fit: fitMode });
  },

  async undo() {
    const top = get().undoStack[get().undoStack.length - 1];
    if (!top || !get().library || get().busy) return;
    set({ busy: true });
    try {
      // Several moved as one (a series) come back as one.
      const batch = top.type === "move" ? top.batch : undefined;
      let n = 0;
      do {
        await undoTop();
        n++;
      } while (batch && isBatch(get().undoStack[get().undoStack.length - 1], batch));
      if (top.type === "move") get().toast(`Undid: ${top.label}${n > 1 ? ` (${n} pictures)` : ""}`, "ok");
    } catch (e) {
      get().toast(`Undo failed: ${e}`, "error");
    } finally {
      set({ busy: false });
    }
  },

  async addBucket(name) {
    const { root, library } = get();
    const path = folderName(name);
    if (!root || !library || !path) return null;
    if (isFilingName(path)) {
      get().toast(`"${path}" reads as one of the year or day folders filing makes: name the bucket something else`, "warn");
      return null;
    }
    const had = library.targets.find((t) => t.path === path);
    if (had) {
      if (!had.bucket) get().updateTarget(had.id, { bucket: true });
      return { ...had, bucket: true };
    }
    await api.fsMkdir(root, root, path);
    const target: Target = { id: uid(), name: path, path, hotkey: suggestHotkey(path, library.targets.map((t) => t.hotkey)), bucket: true };
    set({ library: { ...library, targets: [...library.targets, target] } });
    await get().saveLibrary();
    return target;
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
    set({ screen: "viewer", queue: items, index, source, shuffle: false, viewerBack: backTo(get()) });
  },

  closeViewer() {
    if (get().editMode) get().leaveEdit();
    const to = get().viewerBack;
    set({ screen: to === "viewer" || to === "welcome" ? "browse" : to, settingsOpen: false, trashOpen: false, immersive: false, hudHidden: false, slideshow: { ...get().slideshow, playing: false, hidByShow: false } });
  },

  openSortQueue() {
    const { unsorted, shuffle, seriesTogether, library } = get();
    const queue = shuffle ? shuffled(unsorted) : unsorted;
    set({ screen: "viewer", queue: seriesTogether ? together(queue, seriesIndex(library?.series)) : queue, index: 0, source: { kind: "unsorted" } });
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
    // Everything that was in the trash is gone for good: what is known of it, everywhere.
    forgetGone({ keys: [], folders: [library.trashDir] });
    return n;
  },
}));

/** Looks for moved files run one after another. */
let reconciling: Promise<void> = Promise.resolve();

/** How long a file deleted outside the app stays known (its rating waiting for it to come back). */
export const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Everything kept by these files' keys let go: the library's, the history's, the tags', faces', artists'. */
/** Things gone for good: items by key, and folders (an album's too) with everything under them. */
export interface Gone {
  keys: string[];
  folders: string[];
}

/** Whether a key (an item's, an album's, a folder's) is one of what is gone, or under it. */
export function goneTest(g: Gone): (key: string) => boolean {
  const keys = new Set(g.keys);
  const folders = g.folders.map((f) => f.replace(/\/+$/, "")).filter(Boolean);
  return (k) => keys.has(k) || folders.some((f) => k === f || k.startsWith(`${f}/`));
}

/**
 * What the library knows of things gone for good (purged from the trash, deleted in Files, missing a
 * month), forgotten everywhere it is kept: the library file (ratings, identities, sources, series,
 * what was seen; an album's rating, language, cover and translation link; where trashed things came
 * from), tags and the tag index, artists, people and faces, the Home's filters and pins, the
 * duplicate check's fingerprints, and versions. Plugins are told. The one list of what is kept by
 * key: a store added later is added here, or what it keeps outlives what it was of.
 */
export function forgetGone(g: Gone) {
  if (!g.keys.length && !g.folders.length) return;
  const gone = goneTest(g);
  const s = useStore.getState();
  const lib = s.library;
  const root = s.root;
  if (!lib || !root) return;
  const drop = <T,>(rec: Record<string, T> | undefined) => (rec ? Object.fromEntries(Object.entries(rec).filter(([k]) => !gone(k))) : rec);
  const pairsKept = (list: string[] | undefined) => list?.filter((p) => !p.split("|").some(gone));
  const series = lib.series && without(lib.series, lib.series.flat().filter(gone));
  const albumTranslations = lib.albumTranslations && Object.fromEntries(Object.entries(lib.albumTranslations).filter(([k, v]) => !gone(k) && !gone(v)));
  useStore.setState({
    library: {
      ...lib,
      ratings: drop(lib.ratings)!,
      ids: drop(lib.ids)!,
      sources: drop(lib.sources),
      series,
      seriesNot: pairsKept(lib.seriesNot),
      albumRatings: drop(lib.albumRatings)!,
      albumLanguages: drop(lib.albumLanguages),
      albumCovers: drop(lib.albumCovers),
      albumTranslations,
      albumNotVersions: pairsKept(lib.albumNotVersions),
      trashFrom: drop(lib.trashFrom),
    },
    viewed: drop(s.viewed)!,
  });
  scheduleHistorySave();
  void s.saveLibrary();
  const here = () => useStore.getState().root === root;
  void import("./tagsStore")
    .then(async ({ useTags }) => {
      await useTags.getState().load();
      if (here()) useTags.getState().forgetKeys(gone);
    })
    .catch(() => {});
  void import("./artistsStore")
    .then(async ({ useArtists }) => {
      await useArtists.getState().load();
      if (here()) useArtists.getState().forget(gone);
    })
    .catch(() => {});
  void import("./peopleStore")
    .then(async ({ usePeople }) => {
      // Loaded first: People forgets (and follows) only the library its document is of.
      await usePeople.getState().load();
      if (!here()) return;
      for (const f of g.folders) usePeople.getState().forget(`${f.replace(/\/+$/, "")}/`);
      for (const k of g.keys) usePeople.getState().forget(k);
    })
    .catch(() => {});
  void import("./home/store").then(({ useHome }) => void (here() && useHome.getState().forget(gone))).catch(() => {});
  void import("./dupesStore").then(({ useDupes }) => (here() ? useDupes.getState().forget(gone) : undefined)).catch(() => {});
  void import("./versionsStore").then(({ useVersions }) => (here() ? useVersions.getState().load(true) : undefined)).catch(() => {});
  void import("./plugins/host").then((host) => host.broadcast?.("forgotten", { keys: g.keys, folders: g.folders })).catch(() => {});
}

/** Files gone for good, by key (see `forgetGone`). */
export function forgetKeys(keys: string[]) {
  forgetGone({ keys, folders: [] });
}

/**
 * Files moved outside the app (in Finder, say): what is kept under their old keys is found by what
 * is known of each file (lib/reconcile) and follows them, as a move in the app does. Then the
 * snapshot of what is where now is kept for next time.
 */
async function reconcileNow(items: MediaItem[]): Promise<void> {
  const { library, root } = useStore.getState();
  if (!library || !root) return;
  const [{ useTags, isAlbumTagKey, typeOf }, { useDupes }, { useArtists }] = await Promise.all([import("./tagsStore"), import("./dupesStore"), import("./artistsStore")]);
  // The artists can't hold up finding moves: without them, their pictures are found by the rest.
  await Promise.all([useTags.getState().load(), useDupes.getState().loadCache(), useArtists.getState().load().catch(() => null)]);
  // No snapshot (or none readable): as before there were any.
  const snap = readSnapshot(await Promise.resolve().then(() => api.snapshotLoad(root)).catch(() => null));
  if (useStore.getState().root !== root || !useStore.getState().library) return;
  const lib = useStore.getState().library!;
  const d = useTags.getState().data;
  const cache = useDupes.getState().cacheRoot === root ? useDupes.getState().cache : {};
  const present = new Set(items.map((i) => i.key));
  // Kept by a file: a rating, or tags of yours (a bucket folder's tag says where it is, not what it is).
  const places = new Set(d?.places ?? []);
  const ownTags = (k: string) => !isAlbumTagKey(k) && !!d?.tags[k]?.some((id) => !places.has(typeOf(id)));
  const assigned = useArtists.getState().doc?.items ?? {};
  const kept = (k: string) => k in lib.ratings || k in (lib.sources ?? {}) || k in assigned || ownTags(k);
  // Missing files and what is known of each, best first: the snapshot (as it was last time, and
  // when last seen), its record of files gone with something kept, a rating's identity, the tag
  // index's, the duplicate scanner's (with its content fingerprint).
  const orphans = new Map<string, Orphan>();
  // A file in the trash is where it is (the trash isn't scanned): never a missing file to look for,
  // else a twin of it elsewhere takes its rating and series place.
  const trashPrefix = `${lib.trashDir.replace(/\/+$/, "")}/`;
  const know = (k: string, id: Orphan) => {
    if (k && !present.has(k) && !isAlbumTagKey(k) && !k.startsWith(trashPrefix)) orphans.set(k, { ...id, ...(orphans.get(k) ?? {}) });
  };
  const keys = new Set([...Object.keys(lib.ratings), ...Object.keys(lib.sources ?? {}), ...Object.keys(assigned), ...Object.keys(d?.tags ?? {}).filter(ownTags)]);
  for (const k of keys) {
    if (present.has(k)) continue;
    const seen = seenIn(snap, k);
    if (seen && snap) know(k, { s: seen[0], m: seen[1], lastSeen: snap.at });
    const g = snap?.gone[k];
    if (g) know(k, { s: g[0], m: g[1], lastSeen: g[2] });
  }
  for (const [k, id] of Object.entries(lib.ids ?? {})) know(k, id);
  for (const [k, id] of Object.entries(d?.indexed ?? {})) know(k, { s: id.s, m: id.m });
  for (const [k, c] of Object.entries(cache)) know(k, { s: c.size, m: c.modified, f: c.fp });
  // Kept from before files had identities: found by name where its neighbours went (an old
  // rating also by a name one of a kind on both sides, as it always was).
  for (const k of keys) know(k, k in lib.ratings ? { byName: true } : {});
  let moves: [string, string][] = [];
  if (orphans.size) {
    const taken = new Set(items.filter((i) => kept(i.key)).map((i) => i.key));
    const firstSeen = (key: string) => (snap ? (seenIn(snap, key)?.[2] ?? Number.MAX_SAFE_INTEGER) : undefined);
    moves = await findMoves({ orphans, items, taken, firstSeen, fingerprint: (p) => api.fileFingerprint(p) });
    if (useStore.getState().root !== root) return;
    if (moves.length) {
      // Found with its size or time changed but not its content (its sidecars tidied away, its time
      // rounded by another drive): what was made of it (fingerprints, a video's frames, the tag
      // index's) is told so; else all of it would be made again.
      const byKey = new Map(items.map((i) => [i.key, i]));
      const restamp: [string, number, number][] = [];
      for (const [from, to] of moves) {
        const now = byKey.get(to);
        if (!now) continue;
        const c = cache[from];
        if (c && (c.size !== now.size || c.modified !== now.modified)) Object.assign(c, { size: now.size, modified: now.modified });
        const ix = d?.indexed[from];
        if (ix && (ix.s !== now.size || ix.m !== now.modified)) {
          Object.assign(ix, { s: now.size, m: now.modified });
          restamp.push([from, now.size, now.modified]);
        }
      }
      if (restamp.length) await Promise.resolve().then(() => api.tagsIndexRestamp(root, restamp)).catch(() => {});
      // Folders moved whole (an album renamed): their own keys follow too.
      followMoves([...folderMoves(moves, present), ...moves]);
      useStore.getState().toast(`${moves.length} file${moves.length === 1 ? "" : "s"} moved outside the app: their ratings, tags and scan results went with them`, "ok");
    }
  }
  // A series member gone for good (deleted outside the app, not found anywhere, not in the trash)
  // leaves its series: a ghost would keep its partner counted as "in a series" for ever.
  const lib2 = useStore.getState().library;
  if (lib2 && useStore.getState().root === root) {
    const trash = `${lib2.trashDir.replace(/\/+$/, "")}/`;
    const movedTo = new Set(moves.map(([, to]) => to));
    const here = (k: string) => present.has(k) || movedTo.has(k) || k.startsWith(trash);
    const ghosts = (lib2.series ?? []).flat().filter((k) => !here(k));
    const notGone = (lib2.seriesNot ?? []).filter((p) => p.split("|").some((k) => !here(k)));
    if (ghosts.length || notGone.length) {
      const series = lib2.series ? without(lib2.series, ghosts) : lib2.series;
      const seriesNot = lib2.seriesNot?.filter((p) => !notGone.includes(p));
      useStore.setState({ library: { ...lib2, series, seriesNot } });
      void useStore.getState().saveLibrary();
    }
  }
  // Deleted outside the app and not seen for a month: what was kept for it is let go (a rating, its
  // identity, where it came from, tags, faces, artist), else every file ever deleted in Finder would
  // be looked for on every scan for ever. The snapshot says when each was last seen.
  const found = new Set(moves.map(([from]) => from));
  const stale = Object.entries(snap?.gone ?? {})
    .filter(([k, g]) => !present.has(k) && !found.has(k) && !k.startsWith(trashPrefix) && Date.now() - g[2] > FORGET_AFTER_MS)
    .map(([k]) => k);
  if (stale.length && useStore.getState().root === root) {
    forgetKeys(stale);
    useStore.getState().toast(`${stale.length} file${stale.length === 1 ? "" : "s"} deleted outside the app over a month ago: what was kept for ${stale.length === 1 ? "it" : "them"} was let go`, "ok");
  }
  // What is where now, and what is missing with something kept (not what was just found).
  const next = nextSnapshot(snap, items, (k) => kept(k) && !found.has(k) && !stale.includes(k), Date.now());
  if (!snap || snapshotSig(next) !== snapshotSig(snap)) await Promise.resolve().then(() => api.snapshotSave(root, next)).catch(() => {});
}

/**
 * Everything kept by a file's or folder's key goes with it when it moves, in the app or found moved
 * after the fact (a pair: a file's key, or a folder's and everything under it). The library (ratings,
 * identities, album ratings, languages and translation links, album roots), the history, the tags
 * (an album's too, the pages an album was read by, turned-down suggestions) with the tag index, the
 * duplicate scanner's fingerprints, and plugins (a "moved" event). Tags and fingerprints are loaded
 * for it when they aren't yet: they would otherwise stay behind under the old keys.
 */
export function followMoves(pairs: MovePair[]) {
  const move = mover(pairs);
  if (!pairs.some(([a, b]) => a !== b)) return;
  const s = useStore.getState();
  const lib = s.library;
  if (lib) {
    const ratings = rekeyRecord(lib.ratings, move);
    const ids = rekeyRecord(lib.ids ?? {}, move);
    const albumRatings = rekeyRecord(lib.albumRatings, move);
    const albumLanguages = rekeyRecord(lib.albumLanguages ?? {}, move);
    const albumCovers = rekeyRecord(lib.albumCovers ?? {}, move);
    const sources = rekeyRecord(lib.sources ?? {}, move);
    const links = lib.albumTranslations ?? {};
    const linksMoved = Object.entries(links).some(([k, v]) => move(k) != null || move(v) != null);
    const albumTranslations = linksMoved ? Object.fromEntries(Object.entries(links).map(([k, v]) => [move(k) ?? k, move(v) ?? v])) : null;
    const notVersions = lib.albumNotVersions ?? [];
    const notVersionsMoved = notVersions.some((k) => k.split("|").some((x) => move(x) != null));
    const albumNotVersions = notVersionsMoved ? notVersions.map((k) => k.split("|").map((x) => move(x) ?? x)).map(([a, b]) => versionsKey(a, b)) : null;
    // A series, and pictures said not to be one, by their pictures' keys.
    const seriesMoved = (lib.series ?? []).some((list) => list.some((k) => move(k) != null));
    const series = seriesMoved ? lib.series!.map((list) => list.map((k) => move(k) ?? k)) : null;
    const notSeriesMoved = (lib.seriesNot ?? []).some((k) => k.split("|").some((x) => move(x) != null));
    const seriesNot = notSeriesMoved ? lib.seriesNot!.map((k) => k.split("|").map((x) => move(x) ?? x)).map(([a, b]) => pairKey(a, b)) : null;
    const rootsMoved = lib.albumRoots.some((r) => move(r) != null);
    // A sort target (a bucket too) in the library follows its folder.
    const targetsMoved = lib.targets.some((t) => !t.path.startsWith("/") && move(t.path) != null);
    if (ratings || ids || albumRatings || albumLanguages || albumCovers || sources || albumTranslations || albumNotVersions || series || seriesNot || rootsMoved || targetsMoved) {
      useStore.setState({
        library: {
          ...lib,
          ratings: ratings ?? lib.ratings,
          ids: ids ?? lib.ids,
          albumRatings: albumRatings ?? lib.albumRatings,
          albumLanguages: albumLanguages ?? lib.albumLanguages,
          albumCovers: albumCovers ?? lib.albumCovers,
          sources: sources ?? lib.sources,
          albumTranslations: albumTranslations ?? lib.albumTranslations,
          albumNotVersions: albumNotVersions ?? lib.albumNotVersions,
          series: series ?? lib.series,
          seriesNot: seriesNot ?? lib.seriesNot,
          albumRoots: rootsMoved ? lib.albumRoots.map((r) => move(r) ?? r) : lib.albumRoots,
          targets: targetsMoved ? lib.targets.map((t) => (!t.path.startsWith("/") && move(t.path) != null ? { ...t, path: move(t.path)! } : t)) : lib.targets,
        },
      });
      void useStore.getState().saveLibrary();
    }
  }
  const viewed = rekeyRecord(s.viewed, move);
  if (viewed) {
    useStore.setState({ viewed });
    scheduleHistorySave();
  }
  const root = s.root;
  void import("./tagsStore").then(async ({ useTags, isAlbumTagKey }) => {
    await useTags.getState().load();
    const d = useTags.getState().data;
    if (!d || useStore.getState().root !== root) return;
    // An album's tags sit under "album:<its folder>".
    const tagKey = (k: string) => (isAlbumTagKey(k) ? (() => { const to = move(k.slice(6)); return to == null ? null : `album:${to}`; })() : move(k));
    // Tags it has at its new key already (a bucket's, or given there since) are kept beside the moved ones.
    const tags = rekeyRecord(d.tags, tagKey, (here, moved) => [...new Set([...moved, ...here])]);
    const auto = rekeyRecord(d.auto, move);
    const indexed = rekeyRecord(d.indexed, move);
    const albums0 = rekeyRecord(d.albums ?? {}, move) ?? d.albums ?? {};
    const pagesMoved = Object.values(albums0).some((list) => list.some((k) => move(k) != null));
    const albums = pagesMoved ? Object.fromEntries(Object.entries(albums0).map(([a, list]) => [a, list.map((k) => move(k) ?? k)])) : albums0;
    const deniedMoved = Object.values(d.denied ?? {}).some((list) => list.some((k) => tagKey(k) != null));
    const denied = deniedMoved ? Object.fromEntries(Object.entries(d.denied ?? {}).map(([t, list]) => [t, list.map((k) => tagKey(k) ?? k)])) : d.denied;
    // The backend's index (embeddings and the tagger's words) is kept by file: told each file that moved.
    const files: MovePair[] = [...new Set([...Object.keys(d.indexed), ...Object.keys(d.auto)])].flatMap((k) => {
      const to = move(k);
      return to == null ? [] : [[k, to] as MovePair];
    });
    if (files.length && root) void api.tagsIndexRename(root, files).catch(() => {});
    if (!tags && !auto && !indexed && albums === d.albums && denied === d.denied) return;
    useTags.setState({ data: { ...d, tags: tags ?? d.tags, auto: auto ?? d.auto, indexed: indexed ?? d.indexed, albums, denied } });
    useTags.getState().save();
  });
  void import("./dupesStore").then(async ({ useDupes, CACHE_VERSION }) => {
    await useDupes.getState().loadCache();
    const ds = useDupes.getState();
    if (!root || ds.cacheRoot !== root) return;
    // In place: a running scan keeps adding to the same cache and saves it.
    const cache = ds.cache;
    let moved = 0;
    for (const k of Object.keys(cache)) {
      const to = move(k);
      if (to == null) continue;
      if (!(to in cache)) cache[to] = cache[k];
      delete cache[k];
      moved++;
    }
    const ignored = ds.ignored.map((g) => ({ ...g, keys: g.keys.map((k) => move(k) ?? k) }));
    if (!moved && !ds.ignored.some((g) => g.keys.some((k) => move(k) != null))) return;
    // The kept match was of the old keys: made again when next looked at.
    useDupes.setState({ ignored, matched: null });
    void api.saveCache(root, { version: CACHE_VERSION, sigs: cache, ignored, matched: null }).catch(() => {});
    // Matched again when the Duplicates screen is next looked at, not now.
    if (useStore.getState().screen === "dupes") void useDupes.getState().refreshCandidates();
  });
  // Its faces, and People's folders left out of the face scan.
  // Loaded first, as the others: People follows only the library its document is of, and it may not
  // have been opened yet (moves made in Finder are followed as the library opens).
  void import("./peopleStore").then(async ({ usePeople }) => {
    await usePeople.getState().load();
    if (useStore.getState().root === root) usePeople.getState().follow(pairs);
  }).catch(() => {});
  // The Home's folders, sources and pinned pictures too.
  void import("./home/store").then(({ useHome }) => useHome.getState().follow(pairs)).catch(() => {});
  // A picture's artists go with it.
  void import("./artistsStore").then(async ({ useArtists }) => {
    await useArtists.getState().load();
    if (useStore.getState().root === root) useArtists.getState().follow(move);
  }).catch(() => {});
  // A sticker remembers the picture it was cut from.
  void import("./scrapbook/store").then(async ({ useScrapbook }) => {
    const lib = await useScrapbook.getState().load();
    if (useStore.getState().root !== root || !lib.stickers.some((st) => st.source && move(st.source) != null)) return;
    useScrapbook.getState().setStickers(lib.stickers.map((st) => (st.source && move(st.source) != null ? { ...st, source: move(st.source)! } : st)));
  }).catch(() => {});
  // Where a version and its original are, for Info.
  if (root) void Promise.resolve().then(() => api.versionsFollow(root, pairs)).catch(() => {});
  void import("./plugins/host").then((host) => host.broadcast?.("moved", { moves: pairs })).catch(() => {});
}

/** A file moved by the app (or brought back from the trash): what is kept by its key follows it. */
export function applyMove(moves: [string, string][], from: MediaItem, to: MediaItem, label: string, trashed = false, batch?: string) {
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
  // Into the trash a picture keeps its place in its series, as its rating: Undo brings both back.
  const series = trashed && library.series?.some((list) => list.includes(from.key)) ? library.series.map((list) => list.map((k) => (k === from.key ? to.key : k))) : library.series;
  // Where it came from is kept while it is in the trash, so Restore puts it back there; restored (or
  // moved on from the trash), the note goes.
  const trashFrom = { ...(library.trashFrom ?? {}) };
  if (trashed) trashFrom[to.key] = from.key;
  delete trashFrom[from.key];
  const removedAt = s.queue.findIndex((q) => q.key === from.key);
  const queue = s.queue.filter((q) => q.key !== from.key);
  const unsorted = s.unsorted.filter((u) => u.key !== from.key);
  const kept = s.allItems.filter((i) => i.key !== from.key);
  const allItems = trashed ? kept : withSorted(kept, to);
  const index = queue.length === 0 ? 0 : Math.min(s.index, queue.length - 1);
  useStore.setState({
    library: { ...library, ratings, ids, series, trashFrom },
    viewed,
    queue,
    unsorted,
    allItems,
    index,
    undoStack: [
      ...s.undoStack.slice(-49),
      { type: "move", label, moves, item: from, index: removedAt >= 0 ? removedAt : s.index, fromKey: from.key, toKey: to.key, ...(batch ? { batch } : {}) },
    ],
  });
  void useStore.getState().saveLibrary();
  // Tags, faces, artists, fingerprints and the rest go with it, into the trash too: Restore (to
  // wherever) and Undo bring them back the same way, and Empty Trash forgets them with it.
  followMoves([[from.key, to.key]]);
}

/**
 * An album and its translated version are one album: its tags, artist and rating sit on the
 * original, and lists show it once. The original of an album (itself when it isn't a translation).
 */
let originals: { links: Record<string, string> | undefined; of: Map<string, string> } | null = null;
export function originalOf(albumKey: string): string {
  const links = useStore.getState().library?.albumTranslations;
  if (!originals || originals.links !== links) originals = { links, of: new Map(Object.entries(links ?? {}).map(([o, t]) => [t, o])) };
  return originals.of.get(albumKey) ?? albumKey;
}

/**
 * Albums once each: a translated version is read through its original. One whose original is gone
 * (trashed, moved away, renamed in Finder) stands for itself: folded away, it would be lost to the list.
 */
export const eachOnce = (albums: Album[]) => {
  const here = new Set(albums.map((a) => a.key));
  return albums.filter((a) => {
    const o = originalOf(a.key);
    return o === a.key || !here.has(o);
  });
};

/** A translated version's rating joins its original's (the original's own wins). */
function joinRatings(lib: Library): Library {
  const links = Object.entries(lib.albumTranslations ?? {});
  if (!links.some(([, t]) => lib.albumRatings[t] != null)) return lib;
  const albumRatings = { ...lib.albumRatings };
  for (const [o, t] of links) {
    if (albumRatings[t] == null) continue;
    albumRatings[o] ??= albumRatings[t];
    delete albumRatings[t];
  }
  return { ...lib, albumRatings };
}

/** Convenience selectors */
export const selectCurrent = (s: Store) => s.queue[s.index];
export const selectRating = (s: Store) => {
  const cur = s.queue[s.index];
  return cur && s.library ? s.library.ratings[cur.key] : undefined;
};

const isBatch = (e: UndoEntry | undefined, batch: string) => e?.type === "move" && e.batch === batch;

/** The last thing done, undone (the store's undo, one entry at a time). */
async function undoTop() {
  const { undoStack, library } = useStore.getState();
  const get = useStore.getState;
  const set = useStore.setState;
  const entry = undoStack[undoStack.length - 1];
  if (!entry || !library) return;
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
    // (A revert's original stood in its place: it goes as the version comes back.)
    const queue = get().queue.filter((q) => q.key !== entry.toKey);
    const at = Math.min(entry.index, queue.length);
    queue.splice(at, 0, entry.item);
    const unsorted = !entry.item.targetId ? sortItems([...get().unsorted.filter((u) => u.key !== entry.toKey), entry.item]) : get().unsorted;
    const allItems = sortItems([...get().allItems.filter((i) => i.key !== entry.toKey), entry.item]);
    // Out of the trash again: the note of where it came from goes.
    const trashFrom = library.trashFrom && entry.toKey in library.trashFrom ? Object.fromEntries(Object.entries(library.trashFrom).filter(([k]) => k !== entry.toKey)) : library.trashFrom;
    set({
      library: { ...library, ratings, ids, trashFrom },
      viewed,
      queue,
      index: at,
      unsorted,
      allItems,
      undoStack: undoStack.slice(0, -1),
    });
    get().saveLibrary();
    // Back where it was: its tags and fingerprints too (a trashed one kept them there).
    if (entry.toKey !== entry.fromKey) followMoves([[entry.toKey, entry.fromKey]]);
    void import("./versionsStore").then(({ useVersions }) => useVersions.getState().load(true));
  }
}

// The system switching between light and dark: the look follows when it is set to the system's.
watchSystemMode(() => {
  const s = useStore.getState();
  if (s.themeMode === "system") s.setThemeMode("system");
});
