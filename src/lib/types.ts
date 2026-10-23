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
