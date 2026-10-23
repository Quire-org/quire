import { invoke, convertFileSrc, Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Album, AlbumRename, Benchmark, DriveInfo, History, ImageHashResult, Library, MediaItem, MoveResult, TrashInfo, VerifyProgress, VerifyResult } from "./types";

export const api = {
  loadLibrary: (root: string) => invoke<Library>("load_library", { root }),
  saveLibrary: (root: string, library: Library) =>
    invoke<void>("save_library", { root, library }),
  scanUnsorted: (root: string, library: Library) =>
    invoke<MediaItem[]>("scan_unsorted", { root, library }),
  scanDir: (root: string, dir: string) =>
    invoke<MediaItem[]>("scan_dir", { root, dir }),
  scanAll: (root: string, library: Library, includeAlbums = false) =>
    invoke<MediaItem[]>("scan_all", { root, library, includeAlbums }),
  scanAlbums: (root: string, library: Library) => invoke<Album[]>("scan_albums", { root, library }),
  moveDir: (root: string, dir: string, dest: string) => invoke<string>("move_dir", { root, dir, dest }),
  albumRenamePlan: (root: string, library: Library) => invoke<AlbumRename[]>("album_rename_plan", { root, library }),
  albumRenameApply: (plan: AlbumRename[]) => invoke<AlbumRename[]>("album_rename_apply", { plan }),
  driveInfo: (root: string) => invoke<DriveInfo>("drive_info", { root }),
  readBenchmark: (root: string, maxBytes = 128 * 1024 * 1024) => invoke<Benchmark>("read_benchmark", { root, maxBytes }),
  verifyReadability: (root: string, onProgress: (p: VerifyProgress) => void) => {
    const ch = new Channel<VerifyProgress>();
    ch.onmessage = onProgress;
    return invoke<VerifyResult>("verify_readability", { root, onProgress: ch });
  },
  cancelVerify: () => invoke<void>("cancel_verify"),
  imageHash: (path: string, isRaw: boolean) =>
    invoke<ImageHashResult>("image_hash", { path, isRaw }),
  fileFingerprint: (path: string) => invoke<string>("file_fingerprint", { path }),
  loadCache: (root: string) => invoke<unknown>("load_cache", { root }),
  loadHistory: (root: string) => invoke<History | null>("load_history", { root }),
  saveHistory: (root: string, history: History) => invoke<void>("save_history", { root, history }),
  saveCache: (root: string, cache: unknown) => invoke<void>("save_cache", { root, cache }),
  moveItem: (root: string, item: MediaItem, dest: string) =>
    invoke<MoveResult>("move_item", { root, item, dest }),
  trashItem: (root: string, library: Library, item: MediaItem) =>
    invoke<MoveResult>("trash_item", { root, library, item }),
  restoreFiles: (moves: [string, string][]) =>
    invoke<void>("restore_files", { moves }),
  trashInfo: (root: string, library: Library) =>
    invoke<TrashInfo>("trash_info", { root, library }),
  emptyTrash: (root: string, library: Library) =>
    invoke<number>("empty_trash", { root, library }),
  scanTrash: (root: string, library: Library) =>
    invoke<MediaItem[]>("scan_trash", { root, library }),
  rawPreview: (path: string) => invoke<ArrayBuffer>("raw_preview", { path }),
  initialRoot: () => invoke<string | null>("initial_root"),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  resolvePath: (root: string, stored: string) =>
    invoke<string>("resolve_path", { root, stored }),
};

/** URL the webview can load a file from. */
export const fileSrc = (path: string) => convertFileSrc(path);

export async function pickFolder(title: string, defaultPath?: string) {
  const res = await open({ directory: true, multiple: false, title, defaultPath });
  return typeof res === "string" ? res : null;
}

/** Store a target path relative to the root when it lives inside it. */
export function storedPath(root: string, abs: string): string {
  const r = root.endsWith("/") ? root : root + "/";
  return abs.startsWith(r) ? abs.slice(r.length) : abs;
}

/** Small in-memory cache of RAW preview blob URLs (no disk cache by design). */
const previewCache = new Map<string, string>();
const PREVIEW_CACHE_MAX = 60;

export async function rawPreviewUrl(path: string): Promise<string> {
  const hit = previewCache.get(path);
  if (hit) return hit;
  const buf = await api.rawPreview(path);
  const url = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
  previewCache.set(path, url);
  if (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value as string;
    URL.revokeObjectURL(previewCache.get(oldest)!);
    previewCache.delete(oldest);
  }
  return url;
}
