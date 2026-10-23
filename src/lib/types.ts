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
}

export interface Library {
  version: number;
  targets: Target[];
  ratings: Record<string, number>;
  trashDir: string;
  /** Folders whose immediate subfolders are albums. */
  albumRoots: string[];
  albumRatings: Record<string, number>;
  /** Decode URL-escaped album folder names whenever albums are scanned. */
  autoDecodeAlbumNames: boolean;
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
  dhash: string;
  width: number;
  height: number;
}

export interface TrashInfo {
  path: string;
  files: number;
  bytes: number;
}
