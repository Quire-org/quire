import { invoke, convertFileSrc, Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Album, AlbumRename, BackupOutcome, BackupPlan, BackupProgress, Benchmark, DirEntryInfo, DriveInfo, EditOp, EditResult, EditTools, History, ImageHashResult, VaultProgress, VaultStatus, Library, MediaItem, MoveResult, TrashInfo, VerifyProgress, VerifyResult } from "./types";

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
  albumRenameApply: (plan: AlbumRename[]) => invoke<AlbumRename[]>("album_rename_apply", { root: currentRoot(), plan }),
  // vault
  vaultStatus: (root: string) => invoke<VaultStatus>("vault_status", { root }),
  vaultCreate: (root: string, passphrase: string) => invoke<string>("vault_create", { root, passphrase }),
  vaultUnlock: (root: string, passphrase: string) => invoke<void>("vault_unlock", { root, passphrase }),
  vaultUnlockRecovery: (root: string, code: string) => invoke<void>("vault_unlock_recovery", { root, code }),
  vaultLock: () => invoke<void>("vault_lock"),
  vaultUnlockQuick: (root: string) => invoke<void>("vault_unlock_quick", { root }),
  vaultRemember: () => invoke<void>("vault_remember"),
  vaultForget: (root: string) => invoke<void>("vault_forget", { root }),
  vaultChangePassphrase: (old: string, newPass: string) => invoke<void>("vault_change_passphrase", { old, new: newPass }),
  vaultResetPassphrase: (newPass: string) => invoke<void>("vault_reset_passphrase", { new: newPass }),
  vaultNewRecoveryCode: (passphrase: string) => invoke<string>("vault_new_recovery_code", { passphrase }),
  vaultEncryptAll: (root: string, onProgress: (p: VaultProgress) => void) => {
    const ch = new Channel<VaultProgress>();
    ch.onmessage = onProgress;
    return invoke<number>("vault_encrypt_all", { root, onProgress: ch });
  },
  vaultExport: (root: string, paths: string[], dest: string) => invoke<number>("vault_export", { root, paths, dest }),
  vaultRemove: (root: string, onProgress: (p: VaultProgress) => void) => {
    const ch = new Channel<VaultProgress>();
    ch.onmessage = onProgress;
    return invoke<number>("vault_remove", { root, onProgress: ch });
  },
  // edits
  editTools: () => invoke<EditTools>("edit_tools"),
  editApply: (root: string, library: Library, item: MediaItem, op: EditOp, replace: boolean, onProgress: (p: number) => void) => {
    const ch = new Channel<number>();
    ch.onmessage = onProgress;
    return invoke<EditResult>("edit_apply", { root, library, item, op, replace, onProgress: ch });
  },
  // files tab
  listDir: (root: string, dir: string) => invoke<DirEntryInfo[]>("list_dir", { root, dir }),
  fsMkdir: (root: string, dir: string, name: string) => invoke<string>("fs_mkdir", { root, dir, name }),
  fsMove: (root: string, paths: string[], dest: string) => invoke<string[]>("fs_move", { root, paths, dest }),
  fsRename: (root: string, path: string, newName: string) => invoke<string>("fs_rename", { root, path, newName }),
  fsDelete: (root: string, paths: string[]) => invoke<number>("fs_delete", { root, paths }),
  fsImport: (root: string, sources: string[], dest: string, onProgress: (p: VaultProgress) => void) => {
    const ch = new Channel<VaultProgress>();
    ch.onmessage = onProgress;
    return invoke<number>("fs_import", { root, sources, dest, onProgress: ch });
  },
  driveInfo: (root: string) => invoke<DriveInfo>("drive_info", { root }),
  readBenchmark: (root: string, maxBytes = 128 * 1024 * 1024) => invoke<Benchmark>("read_benchmark", { root, maxBytes }),
  verifyReadability: (root: string, onProgress: (p: VerifyProgress) => void) => {
    const ch = new Channel<VerifyProgress>();
    ch.onmessage = onProgress;
    return invoke<VerifyResult>("verify_readability", { root, onProgress: ch });
  },
  cancelVerify: () => invoke<void>("cancel_verify"),
  backupPlan: (root: string, dest: string, library: Library, skipTrash: boolean) => invoke<BackupPlan>("backup_plan", { root, dest, library, skipTrash }),
  backupRun: (root: string, dest: string, plan: BackupPlan, mirror: boolean, verify: boolean, onProgress: (p: BackupProgress) => void) => {
    const ch = new Channel<BackupProgress>();
    ch.onmessage = onProgress;
    return invoke<BackupOutcome>("backup_run", { root, dest, plan, mirror, verify, onProgress: ch });
  },
  cancelBackup: () => invoke<void>("cancel_backup"),
  imageHash: (path: string, isRaw: boolean) =>
    invoke<ImageHashResult>("image_hash", { root: currentRoot(), path, isRaw }),
  fileFingerprint: (path: string) => invoke<string>("file_fingerprint", { root: currentRoot(), path }),
  loadCache: (root: string) => invoke<unknown>("load_cache", { root }),
  loadHistory: (root: string) => invoke<History | null>("load_history", { root }),
  saveHistory: (root: string, history: History) => invoke<void>("save_history", { root, history }),
  saveCache: (root: string, cache: unknown) => invoke<void>("save_cache", { root, cache }),
  moveItem: (root: string, item: MediaItem, dest: string) =>
    invoke<MoveResult>("move_item", { root, item, dest }),
  trashItem: (root: string, library: Library, item: MediaItem) =>
    invoke<MoveResult>("trash_item", { root, library, item }),
  restoreFiles: (moves: [string, string][]) =>
    invoke<void>("restore_files", { root: currentRoot(), moves }),
  trashInfo: (root: string, library: Library) =>
    invoke<TrashInfo>("trash_info", { root, library }),
  emptyTrash: (root: string, library: Library) =>
    invoke<number>("empty_trash", { root, library }),
  scanTrash: (root: string, library: Library) =>
    invoke<MediaItem[]>("scan_trash", { root, library }),
  rawPreview: (path: string) => invoke<ArrayBuffer>("raw_preview", { root: currentRoot(), path }),
  initialRoot: () => invoke<string | null>("initial_root"),
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  resolvePath: (root: string, stored: string) =>
    invoke<string>("resolve_path", { root, stored }),
};

/** The folder currently open; commands that resolve paths need it. */
let rootForCommands = "";
export const setCurrentRoot = (r: string | null) => {
  rootForCommands = r ?? "";
};
const currentRoot = () => rootForCommands;

/** URL the webview can load a plain file from. */
export const fileSrc = (path: string) => convertFileSrc(path);

/** URL for an item: through the vault protocol when encrypted, the asset protocol otherwise. */
export const mediaUrl = (item: { primary: string; vaultId?: string }) => (item.vaultId ? convertFileSrc(item.vaultId, "vault") : convertFileSrc(item.primary));

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
