export type MediaKind = "image" | "raw" | "video";

export interface MediaItem {
  /** Rating key: primary path relative to the root. */
  key: string;
  primary: string;
  files: string[];
  kind: MediaKind;
  name: string;
  dir: string;
  size: number;
  modified: number;
  hasRaw: boolean;
  hasVideo: boolean;
  /** Set client-side when the item came from a target folder scan. */
  targetId?: string;
  /** Key of the album this item belongs to, when inside an album folder. */
  albumKey?: string;
  /** Vault object id of the primary file, when it is encrypted. */
  vaultId?: string;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  hasRecovery: boolean;
  plaintextFiles: number;
  plaintextBytes: number;
  encryptedFiles: number;
  /** "touchid" | "hello" | "keyring" */
  quickMethod: string;
  /** The drive's format as the system names it: "msdos" (FAT), "exfat", "apfs"…, when known. */
  format?: string | null;
  quickRemembered: boolean;
}

/** This build of the app, and why it can't update itself when it can't (a dev build, say). */
export interface AppBuild {
  version: string;
  cannot: string | null;
}

/** A newer version of the app, as its release describes it. */
export interface AppUpdate {
  version: string;
  notes: string | null;
  /** When it was released, ms since epoch. */
  date: number | null;
  /** Downloaded already: it goes in place with the next restart. */
  downloaded: boolean;
}

/** What a vault took in as it opened, left in the clear beside it by an earlier version. */
export interface VaultAdopted {
  /** Documents it didn't have. */
  documents: string[];
  /** Ones from before that took the place of its own, made since (those kept aside). */
  restored: string[];
  /** Ones from before kept aside, its own staying in use. */
  aside: string[];
  /** Scrapbook pictures. */
  pictures: number;
}

export interface VaultProgress {
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  current: string;
}

export interface EditTools {
  ffmpeg: string | null;
  ffprobe: string | null;
  version: string | null;
  encoders: string[];
}

export type { Pipeline as EditOp } from "../editStore";

export interface EditResult {
  item: MediaItem;
  trashed: [string, string][];
}

/** What a version (an edit's result, a plugin's) was made from: both known by content fingerprint. */
export interface VersionLink {
  from: string;
  fromName: string;
  /** Where each was when the link was made (keys). */
  madeAt: string;
  fromAt: string;
  /** "edit", or the plugin's id; and what such a version is called ("edited"). */
  by: string;
  note: string;
  at: number;
}

export interface VersionInfo {
  /** Its fingerprint, when it is a version or an original. */
  fp: string | null;
  link: VersionLink | null;
  /** The original kept for Revert: the file that shows it. */
  kept: string | null;
  /** The original in the library (a copy was saved beside it), when it is still there. */
  original: string | null;
  /** Versions made from it, each where it is when still where it was made. */
  versions: { made: string; link: VersionLink; path: string | null }[];
}

/** This computer, as far as choosing a language model goes (the backend's `hardware`). */
export interface Hardware {
  /** Bytes of memory in all. */
  memory: number;
  /** "Apple M1 Pro", "AMD Ryzen 7 7800X3D"… */
  chip: string;
  os: string;
  arch: string;
  /** The graphics use the same memory (Apple silicon). */
  unified: boolean;
}

export interface DirEntryInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  encrypted: boolean;
  vaultId?: string | null;
  count: number;
}

export interface History {
  version: number;
  /** item key -> last viewed, ms since epoch */
  viewed: Record<string, number>;
}

export interface Target {
  id: string;
  name: string;
  /** Relative to the root when inside it, absolute otherwise. */
  path: string;
  hotkey: string;
  /** A bucket (Professional, Private…): what goes into it is filed by year and day (lib/filing). */
  bucket?: boolean;
}

export interface Library {
  version: number;
  targets: Target[];
  ratings: Record<string, number>;
  trashDir: string;
  /** Folders whose immediate subfolders are albums. */
  albumRoots: string[];
  /** An album read as another album when translated: album key → the translated album's key. */
  albumTranslations?: Record<string, string>;
  /** Album key → its language ("ja", "en" …), shown as a flag on its card. */
  albumLanguages?: Record<string, string>;
  /** Albums said not to be one work in two languages, though they looked it: "<key>|<key>", in order. */
  albumNotVersions?: string[];
  albumRatings: Record<string, number>;
  /** Decode URL-escaped album folder names whenever albums are scanned. */
  autoDecodeAlbumNames: boolean;
  backupDest?: string | null;
  lastBackup?: number | null;
  /** item key -> identity, so ratings follow files moved outside the app. */
  ids: Record<string, { s: number; m: number; n: string; f?: string }>;
  /** Album key -> its Scrapbook cover (the scrapbook's id). */
  albumCovers?: Record<string, string>;
  /** Item key -> where it came from: a platform in Find. */
  sources?: Record<string, ItemSource>;
  /** Series: pictures alike kept on purpose, by item key (see lib/series.ts). */
  series?: string[][];
  /** Pictures said not to be a series, though they looked it: "<key>|<key>", in order. */
  seriesNot?: string[];
  /** What is in the trash and where it came from: trash key → the key it had (an album folder's too), so Restore puts it back there. */
  trashFrom?: Record<string, string>;
  /** The app's settings, kept with the library so any copy of the app opening it has them (see lib/librarySettings). */
  settings?: LibrarySettings;
}

/** Settings kept with a library: each is also remembered on the computer, for before a library is open. */
export interface LibrarySettings {
  theme?: string;
  mode?: "light" | "dark" | "system";
  sounds?: { menus: boolean; sorting: boolean; volume: number };
  slideshow?: { interval: number; hideUi: boolean };
  pageTurns?: boolean;
  seriesTogether?: boolean;
  fit?: "fit" | "fill";
  /** Asking before going online (see lib/online). */
  online?: { ask: boolean; each: boolean; keep: boolean };
  /** What is connected, kept while `online.keep` is on. */
  connected?: { all: boolean; platforms: string[] };
  /** Checking for updates when the library opens. */
  updates?: { auto: boolean };
}

/** Where a picture came from, kept with it through moves: a work on a platform Find searched. */
export interface ItemSource {
  /** The platform (its Find plugin's id for it) and the work's id there. */
  platform: string;
  id: string;
  url: string;
  title: string;
  author: { id: string; name: string; account?: string };
  /** The platform's tags: offered as suggestions; one linked to a tag of yours (`sourceMap`) brings it in on import. `kind` where the platform says (a character's name tells People who is in it). */
  tags: { name: string; translated: string | null; kind?: "artist" | "series" | "character" | "general" | "meta" }[];
  date: string | null;
  adult: boolean;
  /** Its language (ISO 639-1), where the platform says: an album that came in from it takes it. */
  language?: string;
  /** When it came in (ms). */
  added: number;
  /** The same work on other platforms (a crosspost), as found there since: each without an `also` of its own (see lib/sources.ts). */
  also?: ItemSource[];
}

export interface BackupEntry {
  rel: string;
  size: number;
  mtime: number;
}
export interface BackupPlan {
  copy: BackupEntry[];
  update: BackupEntry[];
  moves: [string, string][];
  extra: BackupEntry[];
  unchanged: number;
  unchangedBytes: number;
  bytesToCopy: number;
  sourceFiles: number;
  sourceBytes: number;
}
export interface BackupProgress {
  stage: string;
  doneFiles: number;
  totalFiles: number;
  doneBytes: number;
  totalBytes: number;
  current: string;
  errors: number;
}
export interface BackupOutcome {
  copied: number;
  updated: number;
  moved: number;
  deleted: number;
  bytes: number;
  millis: number;
  verified: number;
  errors: [string, string][];
  cancelled: boolean;
}

export interface AlbumRename {
  from: string;
  to: string;
  fromKey: string;
  toKey: string;
}

export interface Album {
  key: string;
  path: string;
  name: string;
  albumRoot: string;
  count: number;
  bytes: number;
  images: number;
  videos: number;
  modified: number;
  cover: MediaItem | null;
  /** A PDF, not a folder: its pages are drawn from it (`<path>#<n>`). */
  pdf: boolean;
}

/** A folder that looks like an album (1.jpg, 2.jpg …) but isn't under an album folder. */
export interface AlbumGuess {
  path: string;
  name: string;
  count: number;
  ext: string;
  first: MediaItem[];
}

export interface SmartInfo {
  passed: boolean | null;
  temperatureC: number | null;
  powerOnHours: number | null;
  percentUsed: number | null;
  reallocatedSectors: number | null;
  pendingSectors: number | null;
  model: string | null;
  rawError: string | null;
}

export interface DriveInfo {
  mountPoint: string;
  device: string | null;
  fileSystem: string | null;
  totalBytes: number;
  availableBytes: number;
  removable: boolean;
  bus: string;
  model: string | null;
  solidState: boolean | null;
  smartStatus: string | null;
  smartctlAvailable: boolean;
  smart: SmartInfo | null;
  /** Who made it, as its USB connection says ("SanDisk"). */
  vendor: string | null;
  serial: string | null;
  /** Its firmware, as the drive reports it to the computer. */
  firmware: string | null;
  /** The USB version it speaks ("3.2"), and how fast it is connected now, in Gb/s. */
  usbVersion: string | null;
  linkGbps: number | null;
  /** The maker's own apps installed on this computer (for firmware and settings). */
  vendorApps: { name: string; path: string }[];
}

export interface Benchmark {
  bytes: number;
  millis: number;
  mbPerS: number;
  files: number;
}

export interface VerifyProgress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
  errors: number;
  current: string;
}

export interface VerifyResult {
  files: number;
  bytes: number;
  millis: number;
  errors: [string, string][];
  cancelled: boolean;
}

export interface MoveResult {
  moved: [string, string][];
  item: MediaItem;
}

export interface ImageHashResult {
  /** 64-bit hashes as 16 hex characters. */
  phash: string;
  /** pHash of each quarter (top-left, top-right, bottom-left, bottom-right): a local edit leaves most of them alike. */
  quads?: string[];
  dhash: string;
  width: number;
  height: number;
}

export interface TrashInfo {
  path: string;
  files: number;
  bytes: number;
}

/** Tags and what the local models know about each item, kept with the library (inside the vault when there is one). */
export interface TagData {
  version: 1;
  /** Tag types (the folders): "month", "motives", ... in display order. */
  types: string[];
  /** item key -> tags, each "type/name". */
  tags: Record<string, string[]>;
  /** item key -> the anime tagger's tags over the threshold, [tag index, probability]. */
  auto: Record<string, [number, number][]>;
  /** item key -> identity of the file when it was indexed (size, mtime), to know when to redo it. */
  indexed: Record<string, { s: number; m: number }>;
  /** A tagger tag's name -> the tag of yours it was accepted as, so it suggests that from then on. */
  autoMap: Record<string, string>;
  /** A platform's tag (`<platform>:<its tag>`) -> one of yours: what comes in from there carrying it gets yours. */
  sourceMap?: Record<string, string>;
  /** album key -> the page keys indexed for it (a spread of up to 12), whose embeddings pool into the album's. */
  albums: Record<string, string[]>;
  /** tag -> keys the user said don't carry it (suggestions turned down). */
  denied?: Record<string, string[]>;
  /** Bundles: a name -> the tags it stands for ("cloud" and "cloudy" as one), a filter, not an assignment. */
  bundles?: Record<string, string[]>;
  /** "One of" folders: something carries at most one of their tags (day or night, never both). */
  exclusive?: string[];
  /** Pairs of tags never suggested together, either way: one on something keeps the other off its suggestions. */
  apart?: [string, string][];
  /** tag -> what was said not to go with it under "Often together" (your tags, or "auto:<tagger word>"). */
  unrelated?: Record<string, string[]>;
  /** Subtags: tag -> its parent, in the same folder. Whatever carries a subtag carries its parent too (kept in `tags`). */
  parents?: Record<string, string>;
  /** Tag -> its Scrapbook banner (the scrapbook's id). */
  covers?: Record<string, string>;
  /**
   * Bucket folders: tag folders whose tags are buckets (Professional, Private…). A picture carries the
   * one it is in (kept in `tags` from where it is), and setting another moves it there. Pick one.
   */
  places?: string[];
  /** A bucket folder's tag -> the bucket it stands for (a sort target's id). */
  placeOf?: Record<string, string>;
  /** Index crops of each picture too (finds small things, takes longer): on unless turned off. */
  lookCloser?: boolean;
  /** Tagger words never to offer as a new tag ("comic" on every manga page, say). */
  ignoredWords?: string[];
  /** An indexing run going (paused or not) when the app last saved: it carries on when the library opens. */
  resumeIndex?: { paused?: boolean };
}

export interface IndexProgress {
  done: number;
  total: number;
  current: string;
  /** The item being indexed, for a preview. */
  key?: string;
}

/** One item's result from the indexing job. */
export interface IndexedItem {
  key: string;
  embedding: number[] | null;
  tags: [number, number][] | null;
  error: string | null;
}

/** The models an index is made with, and how. */
export interface IndexModels {
  /** "siglip2"; "pixai", or "" without the anime tagger (it is optional). */
  embedder: string;
  tagger: string;
  /** Also crops of each picture (finds small things; takes about five times as long). */
  parts: boolean;
  /** The anime tagger only looks at drawn pictures (not photos). */
  drawnOnly: boolean;
  /** Start held (a paused run carried on after a restart). */
  paused?: boolean;
}

/** The tag index as the frontend sees it (the vectors stay in the backend). */
export interface TagIndexView {
  auto: TagData["auto"];
  indexed: TagData["indexed"];
  embedded: number;
  /** The models the index was made with: the matcher ("" while it is empty), the anime tagger ("" until it has looked). */
  embedder: string;
  tagger: string;
}

/** One of the anime tagger's tags. */
export interface TagName {
  name: string;
  category: number;
}

/** A face the face finder saw: a real person's in a photo, or a character's in a drawing. */
export interface FaceView {
  id: number;
  /** The picture it is in. */
  key: string;
  kind: "photo" | "drawn";
  /** In fractions of the upright picture: left, top, right, bottom. */
  bbox: [number, number, number, number];
  score: number;
  /** Width in pixels where it was looked at. */
  size: number;
  /** Found where the reader marked it. */
  marked?: boolean;
  /** In a video: the second it was seen at. */
  at?: number;
}

/** Faces no one has named, sorted: close enough to a person to go with them, or in groups alike. */
export interface FacesSorted {
  matches: { face: number; person: string; score: number }[];
  /** Faces given a person but not checked that are like none of their others (`score`: the closest). */
  doubts?: { face: number; person: string; score: number }[];
  /** `scores`: how close each face is to its group as a whole, in the order of `faces`. */
  groups: { kind: "photo" | "drawn"; faces: number[]; scores: number[] }[];
}

/** What the file and the camera say about an item (Info). */
export interface MediaInfo {
  width: number | null;
  height: number | null;
  format: string | null;
  exif: {
    dateTaken: string | null;
    make: string | null;
    model: string | null;
    lens: string | null;
    exposure: string | null;
    fNumber: string | null;
    iso: string | null;
    focal: string | null;
    software: string | null;
    gps: string | null;
    orientation: string | null;
  } | null;
}
