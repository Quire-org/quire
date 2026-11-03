import { invoke, convertFileSrc, Channel } from "@tauri-apps/api/core";
import { backendJob, startJob } from "./jobs";
import { isPdfPage } from "./pdf";
import type { Incoming } from "./filing";
import { open } from "@tauri-apps/plugin-dialog";
import type { DownloadProgress, EngineCatalog, FetchResponse, Inspected, Manifest, PluginInfo, UpdateCheck, StoreInfo } from "../plugins/types";
import type { AppBuild, AppUpdate, VaultAdopted, IndexModels, IndexProgress, IndexedItem, MediaInfo, TagData, TagIndexView, TagName, Album, AlbumRename, BackupOutcome, BackupPlan, BackupProgress, Benchmark, DirEntryInfo, DriveInfo, EditOp, EditResult, EditTools, Hardware, History, ImageHashResult, VaultProgress, VaultStatus, Library, MediaItem, MoveResult, TrashInfo, VerifyProgress, VerifyResult, AlbumGuess, FaceView, FacesSorted, VersionInfo, VersionLink } from "./types";

const nameOf = (rel: string) => rel.split("/").pop() ?? rel;
/** A vault job's progress, for Activity: by bytes, with the file it is on. */
const vaultJob = (p: VaultProgress) => ({ done: p.bytes, total: p.totalBytes, detail: `${p.done} of ${p.total} files`, items: p.current ? [{ key: p.current, name: nameOf(p.current) }] : [] });

/** A file-by-file backend command (vault, import) as an Activity job: progress in, Pause and Stop out. */
function vaultCommand(cmd: string, args: Record<string, unknown>, init: Parameters<typeof backendJob>[0], onProgress?: (p: VaultProgress) => void): Promise<number> {
  const { job, id } = backendJob(init);
  const ch = new Channel<VaultProgress>();
  ch.onmessage = (p) => {
    onProgress?.(p);
    job.update(vaultJob(p));
  };
  return invoke<number>(cmd, { ...args, job: id, onProgress: ch }).finally(job.finish);
}

/** A backend command over many files as an Activity job counting files (Pause and Stop out). */
const formatMB = (bytes: number) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;

/** A pick for find_download: its files, or an animation's frames. */
export interface FindDownload {
  key: string;
  files: { url: string; name: string }[];
  animation?: { zip: string; name: string; frames: { file: string; delay: number }[] };
}

function filesCommand<T>(cmd: string, args: Record<string, unknown>, init: Parameters<typeof backendJob>[0]): Promise<T> {
  const { job, id } = backendJob(init);
  const ch = new Channel<VaultProgress>();
  ch.onmessage = (p) => job.update(init.bytes ? vaultJob(p) : { done: p.done, total: p.total, items: p.current ? [{ key: p.current, name: nameOf(p.current) }] : [] });
  return invoke<T>(cmd, { ...args, job: id, onProgress: ch }).finally(job.finish);
}

export const api = {
  /** Replace the Dock / taskbar icon of the running app with this PNG. */
  setAppIcon: (png: Uint8Array) => invoke<void>("set_app_icon", png),
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
  // Long jobs show in Activity (lib/jobs.ts): wherever they are started from.
  /** What an earlier version left in the clear beside the vault, taken in (see libdocs.rs). */
  vaultAdopt: (root: string) => invoke<VaultAdopted>("vault_adopt", { root }),
  /** Whether the vault's files are still all in one folder, as earlier versions kept them. */
  vaultUnsharded: (root: string) => invoke<boolean>("vault_unsharded", { root }),
  /** Those files moved into their folders, as a job in Activity counting files. */
  vaultShard: (root: string) => {
    const { job, id } = backendJob({ title: "Moving the vault's files into folders", source: "Vault", total: 0 });
    const ch = new Channel<VaultProgress>();
    ch.onmessage = (p) => job.update({ done: p.done, total: p.total });
    return invoke<number>("vault_shard", { root, job: id, onProgress: ch }).finally(job.finish);
  },
  vaultEncryptAll: (root: string, onProgress: (p: VaultProgress) => void) =>
    vaultCommand("vault_encrypt_all", { root }, { title: "Encrypting the library", source: "Vault", total: 0, bytes: true }, onProgress),
  vaultExport: (root: string, paths: string[], dest: string) =>
    vaultCommand("vault_export", { root, paths, dest }, { title: `Decrypting ${paths.length} file${paths.length === 1 ? "" : "s"} out`, source: "Vault", total: 0, bytes: true }),
  vaultRemove: (root: string, onProgress: (p: VaultProgress) => void) =>
    vaultCommand("vault_remove", { root }, { title: "Taking the vault apart", source: "Vault", total: 0, bytes: true }, onProgress),
  // edits
  editTools: () => invoke<EditTools>("edit_tools"),
  /** `job`: the Activity job's backend id, so its Pause and Stop reach ffmpeg. */
  editApply: (root: string, library: Library, item: MediaItem, op: EditOp, replace: boolean, onProgress: (p: number) => void, job?: string) => {
    // Rust expects the pipeline's crop/trim as arrays and nulls as absent options; both serialise as-is.
    const ch = new Channel<number>();
    ch.onmessage = onProgress;
    return invoke<EditResult>("edit_apply", { root, library, item, op, replace, job: job ?? null, onProgress: ch });
  },
  // plugins
  pluginList: () => invoke<PluginInfo[]>("plugin_list"),
  pluginInspect: (source: string) => invoke<Inspected>("plugin_inspect", { source }),
  pluginInstall: (source: string, granted: string[]) => invoke<Manifest>("plugin_install", { source, granted }),
  pluginSetState: (id: string, patch: { enabled?: boolean; allowVault?: boolean; granted?: string[] }) => invoke<void>("plugin_set_state", { id, enabled: patch.enabled ?? null, allowVault: patch.allowVault ?? null, granted: patch.granted ?? null }),
  /** The sites the reader allowed a plugin, for the library open (kept with it): what is kept, checked. */
  pluginSitesSet: (id: string, sites: string[]) => invoke<string[]>("plugin_sites_set", { id, sites }),
  /** A page of a site fetched by its browser session (a hidden window that passed its check): its status and text. */
  pluginBrowse: (id: string, url: string, cookies: string | null) => invoke<{ status: number; body: string }>("plugin_browse", { id, url, cookies }),
  /** A site's browser check passed in a window of the app's own: its cookies and the browser it saw, or null. */
  pluginCheck: (id: string, url: string, name: string) => invoke<{ cookies: string; userAgent: string } | null>("plugin_check", { id, url, name }),
  pluginUninstall: (id: string, keepData: boolean) => invoke<void>("plugin_uninstall", { id, keepData }),
  /** A plugin removed with its data: what it kept with this library goes too. */
  pluginLibraryForget: (id: string, root: string) => invoke<void>("plugin_library_forget", { id, root }),
  pluginCheckUpdates: () => invoke<UpdateCheck[]>("plugin_check_updates"),
  // the app's own updates (see lib/updates.ts)
  appBuild: () => invoke<AppBuild>("app_build"),
  appUpdateCheck: () => invoke<AppUpdate | null>("app_update_check"),
  /** The version found, downloaded as a job in Activity. It can't pause; Stop lets it go. */
  appUpdateDownload: (version: string) => {
    const id = `update-${Date.now()}`;
    const job = startJob({
      title: `Downloading Quire ${version}`,
      source: "Updates",
      total: 0,
      bytes: true,
      pause: { cannot: "A download can't pause: stop it, and download it again later." },
      stop: () => void invoke("job_stop", { id }).catch(() => {}),
    });
    const ch = new Channel<{ done: number; total: number | null }>();
    ch.onmessage = (p) => job.update(p.total ? { done: p.done, total: p.total } : { done: p.done });
    return invoke<void>("app_update_download", { job: id, onProgress: ch }).finally(job.finish);
  },
  /** The downloaded version put in place; the app restarts into it. */
  appUpdateInstall: () => invoke<void>("app_update_install"),
  /** This copy of the app holds the library open (another copy can't open it meanwhile). */
  libraryClaim: (root: string) => invoke<void>("library_claim", { root }),
  /** A library's files from when the app was Media Sorter get Quire's names; `kept`: old ones left, Quire having its own. */
  libraryAdoptNames: (root: string) => invoke<{ renamed: number; kept: string[] }>("library_adopt_names", { root }),
  libraryRelease: () => invoke<void>("library_release"),
  pluginUpdate: (id: string, acceptNewPermissions: boolean) => invoke<Manifest>("plugin_update", { id, acceptNewPermissions }),
  pluginStorageGet: (id: string) => invoke<Record<string, unknown>>("plugin_storage_get", { id }),
  pluginStorageSet: (id: string, key: string, value: unknown) => invoke<void>("plugin_storage_set", { id, key, value }),
  pluginSettingsGet: (id: string) => invoke<Record<string, unknown>>("plugin_settings_get", { id }),
  pluginSettingsSet: (id: string, values: Record<string, unknown>) => invoke<void>("plugin_settings_set", { id, values }),
  pluginFetch: (id: string, request: { url: string; method: string; headers: Record<string, string>; body: string | null; bodyBase64?: string | null }) => invoke<FetchResponse>("plugin_fetch", { id, request }),
  /** A plugin's value kept with the library (in its vault when it has one). */
  pluginLibraryGet: (id: string, root: string, key: string) => invoke<unknown>("plugin_library_get", { id, root, key }),
  pluginLibrarySet: (id: string, root: string, key: string, value: unknown) => invoke<void>("plugin_library_set", { id, root, key, value }),
  /** A platform's sign-in page in its own window; the address it ended on (one of `until`), or null when closed. */
  /** The sign-in window: where it ended, and the cookies asked for (addresses on the plugin's hosts), or null when closed. */
  pluginLogin: (id: string, url: string, until: string[], title: string, cookies: string[]) => invoke<{ url: string; cookies: Record<string, string> } | null>("plugin_login", { id, url, until, title, cookies }),
  pluginLoginClose: (id: string) => invoke<void>("plugin_login_close", { id }),
  /** An image for Find, fetched with the headers its platform wants. */
  findImage: (id: string, url: string, headers: Record<string, string>) => invoke<ArrayBuffer>("find_image", { id, url, headers }),
  /** Picks downloaded for Import, as an Activity job: per pick, its files (in this computer's cache) or what went wrong. */
  findDownload: (id: string, platform: string, works: FindDownload[], headers: Record<string, string>) => {
    const files = works.reduce((n, w) => n + w.files.length + (w.animation ? 1 : 0), 0);
    const { job, id: jobId } = backendJob({ title: `Downloading ${works.length} from ${platform}`, source: "Find", total: files });
    const ch = new Channel<{ done: number; total: number; bytes: number; current: string }>();
    ch.onmessage = (p) => job.update({ done: p.done, total: p.total, detail: formatMB(p.bytes), items: p.current ? [{ key: `find:${p.current}`, name: p.current }] : [] });
    return invoke<{ key: string; files: string[]; error: string | null }[]>("find_download", { id, works, headers, job: jobId, onProgress: ch }).finally(job.finish);
  },
  /** Find's downloads gone from this computer's cache. */
  findClear: () => invoke<void>("find_clear"),
  /** A platform's image hashed like the library's pictures, to look for it there. */
  findImageHash: (id: string, url: string, headers: Record<string, string>) => invoke<ImageHashResult>("find_image_hash", { id, url, headers }),
  /** The faces found so far in the library, and which pictures were looked at (`[size, modified]` then). */
  /** `noCharacters`: pictures looked at without the character finder (it is optional), looked at again once it is downloaded. */
  facesLoad: (root: string) => invoke<{ faces: FaceView[]; scanned: Record<string, [number, number]>; noCharacters: string[] }>("faces_load", { root }),
  /** Faces looked for in pictures, as an Activity job: how many were found. */
  facesScan: (root: string, items: { key: string; path: string; size: number; modified: number; kind: "photo" | "drawn" | null; raw: boolean; video?: boolean }[], onProgress?: (p: { done: number; total: number; faces: number }) => void) => {
    const { job, id } = backendJob({ title: `Looking for faces in ${items.length.toLocaleString("en-GB")} picture${items.length === 1 ? "" : "s"}`, source: "People", total: items.length });
    const ch = new Channel<{ done: number; total: number; current: string; faces: number }>();
    ch.onmessage = (p) => {
      onProgress?.(p);
      job.update({ done: p.done, total: p.total, detail: `${p.faces.toLocaleString("en-GB")} face${p.faces === 1 ? "" : "s"} so far`, items: p.current ? [{ key: p.current, name: nameOf(p.current) }] : [] });
    };
    return invoke<number>("faces_scan", { root, items, job: id, onProgress: ch }).finally(job.finish);
  },
  /** Faces looked for in the part of a picture the reader marked (fractions: left, top, right, bottom), kept beside its others; in a drawing the part is the face when none is found. The faces found. */
  facesMark: (root: string, item: MediaItem, kind: "photo" | "drawn" | null, area: [number, number, number, number]) => invoke<FaceView[]>("faces_mark", { root, key: item.key, path: item.primary, raw: item.kind === "raw", kind, area }),
  /** Faces matched to the people named (`named`: characters the tagger names in a face's picture, `ruledOut`: ones it surely doesn't) and the rest grouped. */
  facesSort: (root: string, labels: { assigned: [number, string, boolean][]; no: number[]; not: [number, string][]; named?: [number, string[]][]; ruledOut?: [number, string[]][] }) => invoke<FacesSorted>("faces_sort", { root, labels }),
  facesRename: (root: string, pairs: [string, string][]) => invoke<void>("faces_rename", { root, pairs }),
  facesForget: (root: string, prefix: string) => invoke<void>("faces_forget", { root, prefix }),
  /** People: who they are and which faces are whose, kept with the library. */
  peopleLoad: (root: string) => invoke<unknown>("people_load", { root }),
  peopleSave: (root: string, data: unknown) => invoke<void>("people_save", { root, data }),
  /** The library's artists, kept with it. */
  artistsLoad: (root: string) => invoke<unknown>("artists_load", { root }),
  artistsSave: (root: string, data: unknown) => invoke<void>("artists_save", { root, data }),
  /** An artist's icon from their platform, kept with the library as `name` (read back with scrapbookBlob). */
  artistAvatarSave: (id: string, root: string, name: string, url: string, headers: Record<string, string>) => invoke<void>("artist_avatar_save", { id, root, name, url, headers }),
  /** Find's state kept with the library (the basket). */
  /** The Home's board, kept with the library. */
  homeLoad: (root: string) => invoke<unknown>("home_load", { root }),
  /** What each screen was left showing in this library (see lib/views.ts). */
  viewsLoad: (root: string) => invoke<unknown>("views_load", { root }),
  viewsSave: (root: string, data: unknown) => invoke<void>("views_save", { root, data }),
  homeSave: (root: string, data: unknown) => invoke<void>("home_save", { root, data }),
  findStateLoad: (root: string) => invoke<unknown>("find_state_load", { root }),
  findStateSave: (root: string, data: unknown) => invoke<void>("find_state_save", { root, data }),
  pluginLog: (id: string, level: string, message: string) => invoke<void>("plugin_log", { id, level, message }),
  /** A plugin's own pipeline (its WebAssembly module) on a picture: the picture it gives back (PNG), if any, and what it answers. */
  pluginEngineRun: (id: string, root: string, path: string, options: unknown) =>
    invoke<{ pngBase64: string | null; width: number; height: number; result: unknown; seconds: number }>("plugin_engine_run", { id, root, path, options }),
  engineModels: () => invoke<EngineCatalog>("engine_models"),
  /** This computer's memory and chip, to weigh language models against. */
  hardware: () => invoke<Hardware>("hardware"),
  engineChoose: (llm: string) => invoke<void>("engine_choose", { llm }),
  engineStoreGet: () => invoke<StoreInfo>("engine_store_get"),
  mediaInfo: (root: string, path: string) => invoke<MediaInfo>("media_info", { root, path }),
  // tags
  loadTags: (root: string) => invoke<TagData | null>("load_tags", { root }),
  saveTags: (root: string, data: Omit<TagData, "auto" | "indexed">) => invoke<void>("save_tags", { root, data }),
  /** The tag index (backend): the tagger's words and what is indexed; the embeddings stay there. */
  tagsIndexLoad: (root: string) => invoke<TagIndexView>("tags_index_load", { root }),
  /** The index made with newer models knows everything: it takes over (false: there was none). */
  /** Tags these items (all pictures, or all albums) may carry: learned from your yeses and noes (and young tags' names), best first. */
  tagsPredict: (root: string, keys: string[]) => invoke<{ tag: string; p: number; examples: boolean }[]>("tags_predict", { root, keys }),
  /** What might carry a tag, with how sure, best first: at least `min`, `skip` left out. */
  tagsCandidates: (root: string, tag: string, albums: boolean, skip: string[], min: number, limit: number) =>
    invoke<{ key: string; p: number; examples: boolean }[]>("tags_candidates", { root, tag, albums, skip, min, limit }),
  /** Search by words, in the index's own model (crops and frames counting). */
  tagsSearch: (root: string, text: string, albums: boolean, limit: number) => invoke<[string, number][]>("tags_search", { root, text, albums, limit }),
  /** Files whose size or time changed but not their content: what was indexed of them still holds. */
  tagsIndexRestamp: (root: string, stamps: [string, number, number][]) => invoke<void>("tags_index_restamp", { root, stamps }),
  tagsIndexRename: (root: string, pairs: [string, string][]) => invoke<void>("tags_index_rename", { root, pairs }),
  /** The items most like any of the queries (candidates: these keys, else everything indexed), best first. */
  tagsRank: (root: string, req: { queries: ({ keys: string[] } | { vector: number[] })[]; candidates: string[] | null; groups: Record<string, string[]>; skip: string[]; min: number; limit: number }) =>
    invoke<[string, number][]>("tags_rank", { root, ...req }),
  /** Each item's likeness to each vector (null: not indexed). */
  tagsScores: (root: string, keys: string[], vectors: number[][], groups: Record<string, string[]>) => invoke<(number[] | null)[]>("tags_scores", { root, keys, vectors, groups }),
  /** Index items with these models (into the index being remade, when they are newer than the one in use). */
  tagsIndex: (root: string, items: MediaItem[], embed: boolean, tag: boolean, models: IndexModels, onProgress: (p: IndexProgress) => void, onItem: (r: IndexedItem) => void) => {
    const progress = new Channel<IndexProgress>();
    progress.onmessage = onProgress;
    const item = new Channel<IndexedItem>();
    item.onmessage = onItem;
    return invoke<number>("tags_index", { root, items, embed, tag, ...models, onProgress: progress, onItem: item });
  },
  tagsCancel: () => invoke<void>("tags_cancel"),
  /** Files or folders that moved: version links look for them where they are now. */
  versionsFollow: (root: string, pairs: [string, string][]) => invoke<void>("versions_follow", { root, pairs }),
  /** Files gone for good: the tag index forgets them (their vectors and the tagger's words). */
  tagsIndexForget: (root: string, keys: string[]) => invoke<void>("tags_index_forget", { root, keys }),
  tagsPause: (on: boolean) => invoke<void>("tags_pause", { on }),
  tagsEmbedText: (root: string, text: string) => invoke<number[]>("tags_embed_text", { root, text }),
  tagsTagNames: (tagger: string) => invoke<TagName[]>("tags_tag_names", { tagger }),
  /** Folders outside the album folders that look like albums (numbered pages of one type). */
  albumsSuggest: (root: string, library: Library) => {
    // One look through the folders: it can't count or pause, and Stop stops waiting for it.
    let quit = (_: Error) => {};
    const stopped = new Promise<never>((_, reject) => (quit = reject));
    const job = startJob({
      title: "Looking for album folders",
      source: "Albums",
      total: { unknown: "One look through the folders; it can't count ahead." },
      pause: { cannot: "One look through the folders; it can't pause halfway." },
      stop: () => quit(new Error("Stopped looking for album folders")),
    });
    return Promise.race([invoke<AlbumGuess[]>("albums_suggest", { root, library }), stopped]).finally(job.finish);
  },
  /** Small JPEG frames of a video at these seconds, as data URLs ("" where one failed). */
  videoThumbs: (root: string, path: string, times: number[], width: number) => invoke<string[]>("video_thumbs", { root, path, times, width }),
  /** One video from two that overlap, written next to the base; the new file's path. */
  videoCombine: (root: string, base: string, other: string, head: number, tailFrom: number | null, name: string) => invoke<string>("video_combine", { root, base, other, head, tailFrom, name }),
  engineStoreSet: (path: string | null) => {
    const halfway = "Moving the folder can't stop halfway: the models would be split between two places.";
    const job = startJob({ title: "Moving the model folder", source: "Local models", total: { unknown: "One move of the whole folder." }, pause: { cannot: halfway }, stop: { cannot: halfway } });
    return invoke<void>("engine_store_set", { path }).finally(job.finish);
  },
  engineDownload: (model: string, onProgress: (p: DownloadProgress) => void) => {
    // Stop is the download's own, which also deletes what it left half-written.
    const { job, id } = backendJob({ title: `Downloading ${model}`, source: "Local models", total: 0, bytes: true, stop: () => void invoke("engine_cancel_download") });
    const ch = new Channel<DownloadProgress>();
    ch.onmessage = (p) => {
      onProgress(p);
      job.update({ done: p.completed, total: p.total, detail: p.name });
    };
    return invoke<void>("engine_download", { id: model, job: id, onProgress: ch }).finally(job.finish);
  },
  engineCancelDownload: () => invoke<void>("engine_cancel_download"),
  engineRemove: (id: string) => invoke<void>("engine_remove", { id }),
  readMediaImage: (root: string, path: string) => invoke<ArrayBuffer>("read_media_image", { root, path }),
  // Scrapbook: covers' layouts and custom stickers, and their pictures (in the folder, or encrypted in its vault).
  scrapbookLoad: (root: string) => invoke<unknown>("scrapbook_load", { root }),
  scrapbookSave: (root: string, data: unknown) => invoke<void>("scrapbook_save", { root, data }),
  /** A cover saved as a picture where the user picks: PNG or JPEG by the name chosen. Null if cancelled. */
  scrapbookExport: (name: string, pngBase64: string, jpegBase64: string) => invoke<string | null>("scrapbook_export", { name, pngBase64, jpegBase64 }),
  scrapbookBlob: (root: string, name: string) => invoke<ArrayBuffer>("scrapbook_blob", { root, name }),
  scrapbookBlobPut: (root: string, name: string, dataBase64: string) => invoke<void>("scrapbook_blob_put", { root, name, dataBase64 }),
  scrapbookBlobDelete: (root: string, name: string) => invoke<void>("scrapbook_blob_delete", { root, name }),
  /** Where the subjects of a picture are: a grey PNG (white: subject), scaled to fit maxSide. */
  scrapbookCutout: (root: string, path: string, maxSide: number, crop?: [number, number, number, number]) => invoke<{ width: number; height: number; mask_base64: string; seconds: number }>("scrapbook_cutout", { root, path, maxSide, crop: crop ?? null }),
  /** A new file in `dir`; made `from` a picture by a plugin (`by`), it is linked to it as a version. */
  writeMediaFile: (root: string, dir: string, name: string, dataBase64: string, made?: { from: string; by: string; note: string | null }) =>
    invoke<string>("write_media_file", { root, dir, name, dataBase64, from: made?.from ?? null, by: made?.by ?? null, note: made?.note ?? null }),
  replaceMediaFile: (root: string, library: Library, item: MediaItem, name: string, dataBase64: string, by: string, note: string | null) => invoke<EditResult>("replace_media_file", { root, library, item, name, dataBase64, by, note }),
  // versions: what each edited picture was made from, and the originals kept for Revert
  versionsLoad: (root: string) => invoke<{ links: Record<string, VersionLink> } | null>("versions_load", { root }),
  versionInfo: (root: string, path: string) => invoke<VersionInfo>("version_info", { root, path }),
  versionRevert: (root: string, library: Library, item: MediaItem) => invoke<{ item: MediaItem; moves: [string, string][] }>("version_revert", { root, library, item }),
  keptOriginals: (root: string) => invoke<{ originals: number; bytes: number }>("kept_originals", { root }),
  keptOriginalsForget: (root: string) => invoke<number>("kept_originals_forget", { root }),
  // files tab
  listDir: (root: string, dir: string) => invoke<DirEntryInfo[]>("list_dir", { root, dir }),
  fsMkdir: (root: string, dir: string, name: string) => invoke<string>("fs_mkdir", { root, dir, name }),
  fsMove: (root: string, paths: string[], dest: string) => invoke<string[]>("fs_move", { root, paths, dest }),
  fsRename: (root: string, path: string, newName: string) => invoke<string>("fs_rename", { root, path, newName }),
  fsDelete: (root: string, paths: string[]) => invoke<number>("fs_delete", { root, paths }),
  /** Every picture and video an import would bring in from these files and folders (the trash left out). */
  importScan: (root: string, sources: string[], trash: string) => invoke<Incoming[]>("import_scan", { root, sources, trash }),
  /** Fingerprints of files, in the library or outside it, to find exact copies (none: unreadable). */
  importFingerprints: (root: string, paths: string[]) => filesCommand<(string | null)[]>("import_fingerprints", { root, paths }, { title: "Looking for duplicates", source: "Import", total: paths.length }),
  /** Files into the library, each into its folder: copied from elsewhere, moved from inside. Where each went (none: not reached). */
  importFiles: (root: string, items: { src: string; dest: string }[]) =>
    filesCommand<(string | null)[]>("import_files", { root, items }, { title: `Importing ${items.length} file${items.length === 1 ? "" : "s"}`, source: "Import", total: 0, bytes: true }),
  driveInfo: (root: string) => invoke<DriveInfo>("drive_info", { root }),
  readBenchmark: (root: string, maxBytes = 128 * 1024 * 1024) => invoke<Benchmark>("read_benchmark", { root, maxBytes }),
  /** Every file read through, as an Activity job (paused and stopped there, or with `stop`). */
  verifyReadability: (root: string, onProgress: (p: VerifyProgress) => void) => {
    const { job, id } = backendJob({ title: `Reading every file on ${nameOf(root) || root}`, source: "Drive health", total: 0, bytes: true });
    const ch = new Channel<VerifyProgress>();
    ch.onmessage = (p) => {
      onProgress(p);
      job.update({ done: p.bytes, total: p.totalBytes, detail: `${p.files} of ${p.totalFiles} files${p.errors ? ` · ${p.errors} unreadable` : ""}`, items: p.current ? [{ key: p.current, name: p.current }] : [] });
    };
    return { done: invoke<VerifyResult>("verify_readability", { root, job: id, onProgress: ch }).finally(job.finish), stop: () => void invoke("job_stop", { id }).catch(() => {}) };
  },
  /** One of the drive maker's apps that driveInfo found. */
  driveOpenApp: (path: string) => invoke<void>("drive_open_app", { path }),
  backupPlan: (root: string, dest: string, library: Library, skipTrash: boolean) => invoke<BackupPlan>("backup_plan", { root, dest, library, skipTrash }),
  backupRun: (root: string, dest: string, plan: BackupPlan, mirror: boolean, verify: boolean, onProgress: (p: BackupProgress) => void) => {
    const { job, id } = backendJob({ title: "Backing up", source: "Backup", total: 0, bytes: true });
    const ch = new Channel<BackupProgress>();
    ch.onmessage = (p) => {
      onProgress(p);
      job.update({ done: p.doneBytes, total: p.totalBytes, detail: `${p.stage} · ${p.doneFiles} of ${p.totalFiles} files${p.errors ? ` · ${p.errors} errors` : ""}`, items: p.current ? [{ key: p.current, name: nameOf(p.current) }] : [] });
    };
    return invoke<BackupOutcome>("backup_run", { root, dest, plan, mirror, verify, job: id, onProgress: ch }).finally(job.finish);
  },
  cancelBackup: () => invoke<void>("cancel_backup"),
  /** A PDF album's pages, as pictures of it. */
  pdfPages: (root: string, path: string) => invoke<MediaItem[]>("pdf_pages", { root, path }),
  /** How surely the tagger takes a PDF for a comic (0–1), from its first pages. */
  pdfComic: (root: string, path: string, embedder: string, tagger: string) => invoke<number>("pdf_comic", { root, path, embedder, tagger }),
  imageHash: (path: string, isRaw: boolean) =>
    invoke<ImageHashResult>("image_hash", { root: currentRoot(), path, isRaw }),
  fileFingerprint: (path: string) => invoke<string>("file_fingerprint", { root: currentRoot(), path }),
  /** Showing on another device (components/Cast). */
  castStart: (remote: boolean) => invoke<{ urls: { iface: string; url: string }[]; fingerprint: string }>("cast_start", { remote }),
  castStop: () => invoke<void>("cast_stop"),
  /** The picture shown now (a JPEG made here), or the video shown now (streamed from its file as the device plays it), or nothing. */
  castFrame: (seq: number, jpegBase64: string | null, name: string, video: boolean, index: number, total: number, none: boolean, videoPath: string | null = null, root: string | null = null) =>
    invoke<void>("cast_frame", { seq, jpegBase64, name, video, index, total, none, videoPath, root }),
  castStatus: () => invoke<{ running: boolean; devices: { id: string; name: string; ip: string; state: "pending" | "allowed" | "denied" }[]; nav: number[] }>("cast_status"),
  castDecide: (id: string, allow: boolean) => invoke<void>("cast_decide", { id, allow }),
  castRemote: (on: boolean) => invoke<void>("cast_remote", { on }),
  /** What was where at the last full look at the library (lib/snapshot), or null. */
  snapshotLoad: (root: string) => invoke<unknown>("snapshot_load", { root }),
  snapshotSave: (root: string, snapshot: unknown) => invoke<void>("snapshot_save", { root, snapshot }),
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
  /** The folder to open at launch: one given on the command line, else `last` when its drive is there. */
  initialRoot: (last?: string | null) => invoke<string | null>("initial_root", { last: last ?? null }),
  devPassphrase: () => invoke<string | null>("dev_passphrase"),
};

/** The folder currently open; commands that resolve paths need it. */
let rootForCommands = "";
export const setCurrentRoot = (r: string | null) => {
  rootForCommands = r ?? "";
};
const currentRoot = () => rootForCommands;

/** URL the webview can load a plain file from. */
export const fileSrc = (path: string) => convertFileSrc(path);

/** URL for an item: through the vault protocol when encrypted, the asset protocol otherwise; a PDF's page drawn about as wide as the screen. */
export const mediaUrl = (item: { primary: string; vaultId?: string; modified?: number }) =>
  isPdfPage(item)
    ? `${convertFileSrc(item.primary, "thumb")}?w=${Math.min(3200, Math.round(window.screen.width * (window.devicePixelRatio || 1)))}&v=${item.modified ?? 0}&root=${encodeURIComponent(currentRoot())}`
    : item.vaultId
      ? convertFileSrc(item.vaultId, "vault")
      : convertFileSrc(item.primary);

/** Widths the backend makes thumbnails at (thumbs.rs); asking for one of these shares its copy. */
const THUMB_WIDTHS = [192, 320, 480, 720, 1024];
/** Formats the backend can't shrink (the webview decodes them), and GIFs, which would stop moving. */
const NO_THUMB = /\.(heic|heif|avif|gif)$/i;

/** Whether an item has a backend thumbnail: a picture, or a video in a vault (its picture made once and kept there, encrypted). */
export const canThumb = (item: { kind: string; primary: string; vaultId?: string }) =>
  ((item.kind === "image" || item.kind === "raw") && !NO_THUMB.test(item.primary)) || (item.kind === "video" && !!item.vaultId);

/** A small copy of a picture, about `width` CSS pixels wide (sharp on this screen), made by the backend. */
export function thumbUrl(root: string, item: { primary: string; modified: number }, width: number): string {
  const want = width * (window.devicePixelRatio || 1);
  const w = THUMB_WIDTHS.find((b) => b >= want) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
  return `${convertFileSrc(item.primary, "thumb")}?w=${w}&v=${item.modified}&root=${encodeURIComponent(root)}`;
}

/** Sides the backend cuts faces out at (thumbs.rs). */
const FACE_SIDES = [64, 128, 256, 384, 512];

/** A face cut out of a picture by the backend: the square `around` times its box, `size` CSS pixels (sharp on this screen). */
export function faceUrl(root: string, item: { primary: string; modified: number }, bbox: number[], size: number, around: number, at?: number): string {
  const want = size * (window.devicePixelRatio || 1);
  const w = FACE_SIDES.find((b) => b >= want) ?? FACE_SIDES[FACE_SIDES.length - 1];
  // A face in a video: cut from the frame at its moment.
  const moment = at != null ? `&at=${at.toFixed(2)}` : "";
  return `${convertFileSrc(item.primary, "thumb")}?face=${bbox.map((v) => v.toFixed(4)).join(",")}&around=${around}&w=${w}${moment}&v=${item.modified}&root=${encodeURIComponent(root)}`;
}

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
