mod albums;
mod backup;
mod drive;
mod dupes;
mod fsx;
mod library;
mod media;
mod ops;
mod preview;
mod vault;

use fsx::Ctx;
use library::{resolve, Library};
use media::MediaItem;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::Response;
use tauri::{Manager, State};
use vault::Vault;

/// The one unlocked vault (if any). Held in a std mutex: index edits are
/// quick, and long jobs (encrypt all) are explicit steps with progress.
#[derive(Default)]
pub struct VaultState(Mutex<Option<Vault>>);

type VS<'a> = State<'a, VaultState>;

fn with_ctx<T>(vs: &VS, root: &Path, f: impl FnOnce(&mut Ctx) -> T) -> T {
    let mut guard = vs.0.lock().unwrap_or_else(|p| p.into_inner());
    let mut ctx = Ctx::new(root, guard.as_mut());
    f(&mut ctx)
}

/* ---------------- library / metadata ---------------- */

#[tauri::command]
fn load_library(vs: VS, root: String) -> Result<Library, String> {
    let root = PathBuf::from(root);
    with_ctx(&vs, &root, |ctx| {
        if ctx.vault.is_some() {
            match ctx.load_meta("library")? {
                Some(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
                None => Ok(Library::default()),
            }
        } else {
            Library::load(&root)
        }
    })
}

#[tauri::command]
fn save_library(vs: VS, root: String, library: Library) -> Result<(), String> {
    let root = PathBuf::from(root);
    with_ctx(&vs, &root, |ctx| {
        if ctx.vault.is_some() {
            ctx.save_meta("library", &serde_json::to_string_pretty(&library).map_err(|e| e.to_string())?)
        } else {
            library.save(&root)
        }
    })
}

fn load_json(vs: &VS, root: &str, name: &str) -> Result<serde_json::Value, String> {
    with_ctx(vs, Path::new(root), |ctx| Ok(ctx.load_meta(name)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(serde_json::Value::Null)))
}

fn save_json(vs: &VS, root: &str, name: &str, v: &serde_json::Value) -> Result<(), String> {
    with_ctx(vs, Path::new(root), |ctx| ctx.save_meta(name, &serde_json::to_string(v).map_err(|e| e.to_string())?))
}

#[tauri::command]
fn load_history(vs: VS, root: String) -> Result<serde_json::Value, String> {
    load_json(&vs, &root, "history")
}
#[tauri::command]
fn save_history(vs: VS, root: String, history: serde_json::Value) -> Result<(), String> {
    save_json(&vs, &root, "history", &history)
}
#[tauri::command]
fn load_cache(vs: VS, root: String) -> Result<serde_json::Value, String> {
    load_json(&vs, &root, "cache")
}
#[tauri::command]
fn save_cache(vs: VS, root: String, cache: serde_json::Value) -> Result<(), String> {
    save_json(&vs, &root, "cache", &cache)
}

/* ---------------- scanning ---------------- */

#[tauri::command]
fn scan_unsorted(vs: VS, root: String, library: Library) -> Result<Vec<MediaItem>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let mut exclude: Vec<PathBuf> = library.targets.iter().map(|t| resolve(&root, &t.path)).collect();
    exclude.push(library.trash_path(&root));
    exclude.extend(library.album_root_paths(&root));
    Ok(with_ctx(&vs, &root, |ctx| ctx.scan(&root, &exclude)))
}

#[tauri::command]
fn scan_all(vs: VS, root: String, library: Library, include_albums: bool) -> Result<Vec<MediaItem>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let trash = library.trash_path(&root);
    let mut exclude = vec![trash.clone()];
    if !include_albums {
        exclude.extend(library.album_root_paths(&root));
    }
    let targets: Vec<(String, PathBuf)> = library.targets.iter().map(|t| (t.id.clone(), resolve(&root, &t.path))).collect();
    let mut items = with_ctx(&vs, &root, |ctx| {
        let mut items = ctx.scan(&root, &exclude);
        for (_, dir) in &targets {
            if !dir.starts_with(&root) && dir.is_dir() {
                items.extend(ctx.scan(dir, &exclude));
            }
        }
        items
    });
    let album_roots = library.album_root_paths(&root);
    for item in &mut items {
        let p = Path::new(&item.primary);
        if include_albums {
            item.album_key = album_roots.iter().find_map(|ar| {
                let rel = p.strip_prefix(ar).ok()?;
                let first = rel.components().next()?;
                Some(media::rel_key(&root, &ar.join(first.as_os_str())))
            });
        }
        item.target_id = targets.iter().filter(|(_, dir)| p.starts_with(dir)).max_by_key(|(_, dir)| dir.components().count()).map(|(id, _)| id.clone());
    }
    Ok(items)
}

#[tauri::command]
fn scan_dir(vs: VS, root: String, dir: String) -> Result<Vec<MediaItem>, String> {
    let root = PathBuf::from(root);
    let dir = resolve(&root, &dir);
    Ok(with_ctx(&vs, &root, |ctx| ctx.scan(&dir, &[])))
}

#[tauri::command]
fn scan_trash(vs: VS, root: String, library: Library) -> Result<Vec<MediaItem>, String> {
    let root = PathBuf::from(root);
    let trash = library.trash_path(&root);
    Ok(with_ctx(&vs, &root, |ctx| ctx.scan(&trash, &[])))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashInfo {
    path: String,
    files: usize,
    bytes: u64,
}

#[tauri::command]
fn trash_info(vs: VS, root: String, library: Library) -> TrashInfo {
    let root = PathBuf::from(root);
    let trash = library.trash_path(&root);
    let files = with_ctx(&vs, &root, |ctx| ctx.list_files(&trash, &[]));
    TrashInfo { path: trash.to_string_lossy().into_owned(), files: files.len(), bytes: files.iter().map(|f| f.size).sum() }
}

#[tauri::command]
fn empty_trash(vs: VS, root: String, library: Library) -> Result<usize, String> {
    let root = PathBuf::from(root);
    let trash = library.trash_path(&root);
    with_ctx(&vs, &root, |ctx| {
        let files = ctx.list_files(&trash, &[]);
        for f in &files {
            ctx.remove(&f.path)?;
        }
        // Also drop anything left on disk (non-media files) and empty dirs.
        if trash.is_dir() {
            let _ = ops::purge_dir(&trash);
        }
        Ok(files.len())
    })
}

/* ---------------- moving ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveResult {
    moved: Vec<(String, String)>,
    item: MediaItem,
}

fn rebuild_item(ctx: &Ctx, item: &MediaItem, new_files: &[PathBuf]) -> MediaItem {
    let idx = item.files.iter().position(|f| f == &item.primary).unwrap_or(0);
    let primary = &new_files[idx];
    let parent = primary.parent().unwrap_or(&ctx.root);
    MediaItem {
        key: media::rel_key(&ctx.root, primary),
        primary: primary.to_string_lossy().into_owned(),
        files: new_files.iter().map(|f| f.to_string_lossy().into_owned()).collect(),
        dir: media::rel_key(&ctx.root, parent),
        vault_id: ctx.vault_id(primary),
        ..item.clone()
    }
}

fn move_item_to(vs: &VS, root: &Path, item: &MediaItem, dest_dir: &Path) -> Result<MoveResult, String> {
    with_ctx(vs, root, |ctx| {
        let files: Vec<PathBuf> = item.files.iter().map(PathBuf::from).collect();
        let new_files = ctx.move_group(&files, dest_dir)?;
        let moved = files.iter().zip(new_files.iter()).map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned())).collect();
        Ok(MoveResult { moved, item: rebuild_item(ctx, item, &new_files) })
    })
}

#[tauri::command]
fn move_item(vs: VS, root: String, item: MediaItem, dest: String) -> Result<MoveResult, String> {
    let root = PathBuf::from(root);
    let dest_dir = resolve(&root, &dest);
    move_item_to(&vs, &root, &item, &dest_dir)
}

#[tauri::command]
fn trash_item(vs: VS, root: String, library: Library, item: MediaItem) -> Result<MoveResult, String> {
    let root = PathBuf::from(root);
    let trash = library.trash_path(&root);
    move_item_to(&vs, &root, &item, &trash)
}

/// Undo helper: put files back exactly where they were.
#[tauri::command]
fn restore_files(vs: VS, root: String, moves: Vec<(String, String)>) -> Result<(), String> {
    let root = PathBuf::from(root);
    with_ctx(&vs, &root, |ctx| {
        for (orig, cur) in &moves {
            let (orig, cur) = (PathBuf::from(orig), PathBuf::from(cur));
            if orig.exists() || ctx.vault_id(&orig).is_some() {
                return Err(format!("cannot restore, {} already exists", orig.display()));
            }
            ctx.move_one(&cur, &orig)?;
        }
        Ok(())
    })
}

#[tauri::command]
fn move_dir(vs: VS, root: String, dir: String, dest: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    let dest_dir = resolve(&root, &dest);
    with_ctx(&vs, &root, |ctx| ctx.move_dir(Path::new(&dir), &dest_dir).map(|p| p.to_string_lossy().into_owned()))
}

/* ---------------- albums ---------------- */

#[tauri::command]
fn scan_albums(vs: VS, root: String, library: Library) -> Result<Vec<albums::Album>, String> {
    let root = PathBuf::from(root);
    Ok(with_ctx(&vs, &root, |ctx| {
        let mut out = vec![];
        for stored in &library.album_roots {
            let dir = resolve(&root, stored);
            for sub in ctx.subdirs(&dir) {
                let mut items = ctx.scan(&sub, &[]);
                items.sort_by(|a, b| a.dir.cmp(&b.dir).then_with(|| a.name.cmp(&b.name)));
                out.push(albums::album_from_items(&root, &sub, stored, items));
            }
        }
        out
    }))
}

#[tauri::command]
fn album_rename_plan(vs: VS, root: String, library: Library) -> Vec<albums::Rename> {
    let root = PathBuf::from(root);
    with_ctx(&vs, &root, |ctx| {
        let mut plan = vec![];
        for dir in library.album_root_paths(&root) {
            let subs = ctx.subdirs(&dir);
            let mut taken: Vec<String> = subs.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
            for sub in subs {
                let name = sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let Some(mut new_name) = albums::decode_name(&name) else { continue };
                let base = new_name.clone();
                let mut n = 1;
                while taken.iter().any(|t| t != &name && t.eq_ignore_ascii_case(&new_name)) {
                    new_name = format!("{base} ({n})");
                    n += 1;
                }
                taken.push(new_name.clone());
                let to = dir.join(&new_name);
                plan.push(albums::Rename { from: sub.to_string_lossy().into_owned(), to: to.to_string_lossy().into_owned(), from_key: media::rel_key(&root, &sub), to_key: media::rel_key(&root, &to) });
            }
        }
        plan
    })
}

#[tauri::command]
fn album_rename_apply(vs: VS, root: String, plan: Vec<albums::Rename>) -> Result<Vec<albums::Rename>, String> {
    let root = PathBuf::from(root);
    with_ctx(&vs, &root, |ctx| {
        let mut done = vec![];
        for r in &plan {
            let (from, to) = (Path::new(&r.from), Path::new(&r.to));
            if to.exists() {
                continue;
            }
            if ctx.rename_dir(from, to).is_ok() {
                done.push(r.clone());
            }
        }
        Ok(done)
    })
}

/* ---------------- hashing / preview ---------------- */

#[tauri::command]
fn image_hash(vs: VS, root: String, path: String, is_raw: bool) -> Result<dupes::ImageHash, String> {
    let p = PathBuf::from(&path);
    let bytes = with_ctx(&vs, Path::new(&root), |ctx| if ctx.vault_id(&p).is_some() { ctx.read_all(&p).map(Some) } else { Ok(None) })?;
    match bytes {
        Some(b) => dupes::image_hash_bytes(&b, is_raw),
        None => dupes::image_hash(&p, is_raw),
    }
}

#[tauri::command]
fn file_fingerprint(vs: VS, root: String, path: String) -> Result<String, String> {
    with_ctx(&vs, Path::new(&root), |ctx| ctx.fingerprint(Path::new(&path)))
}

#[tauri::command]
fn raw_preview(vs: VS, root: String, path: String) -> Result<Response, String> {
    let p = PathBuf::from(&path);
    let bytes = with_ctx(&vs, Path::new(&root), |ctx| ctx.read_all(&p))?;
    preview::embedded_jpeg_bytes(&bytes).map(Response::new)
}

/* ---------------- drive / backup (unchanged, disk-level) ---------------- */

#[tauri::command]
async fn drive_info(root: String) -> drive::DriveInfo {
    tauri::async_runtime::spawn_blocking(move || drive::drive_info(Path::new(&root))).await.unwrap_or_default()
}

#[tauri::command]
async fn read_benchmark(root: String, max_bytes: u64) -> Result<drive::Benchmark, String> {
    tauri::async_runtime::spawn_blocking(move || drive::read_benchmark(Path::new(&root), max_bytes)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn verify_readability(root: String, on_progress: tauri::ipc::Channel<drive::VerifyProgress>) -> Result<drive::VerifyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        drive::verify_readability(Path::new(&root), |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_verify() {
    drive::VERIFY_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[tauri::command]
async fn backup_plan(root: String, dest: String, library: Library, skip_trash: bool) -> Result<backup::Plan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(root);
        let trash = library.trash_path(&root);
        backup::plan(&root, Path::new(&dest), if skip_trash { Some(trash.as_path()) } else { None })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn backup_run(root: String, dest: String, plan: backup::Plan, mirror: bool, verify: bool, on_progress: tauri::ipc::Channel<backup::Progress>) -> Result<backup::Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        backup::run(Path::new(&root), Path::new(&dest), &plan, mirror, verify, |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn cancel_backup() {
    backup::BACKUP_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

/* ---------------- vault ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    exists: bool,
    unlocked: bool,
    has_recovery: bool,
    /// Plain files outside the vault that could still be encrypted.
    plaintext_files: usize,
    plaintext_bytes: u64,
    encrypted_files: usize,
}

#[tauri::command]
fn vault_status(vs: VS, root: String) -> VaultStatus {
    let root = PathBuf::from(root);
    let exists = vault::exists(&root);
    let guard = vs.0.lock().unwrap_or_else(|p| p.into_inner());
    let unlocked = guard.as_ref().map(|v| v.root == root).unwrap_or(false);
    let encrypted_files = guard.as_ref().filter(|v| v.root == root).map(|v| v.entries().len()).unwrap_or(0);
    let plain = if exists { fsx::plaintext_files(&root) } else { vec![] };
    VaultStatus { exists, unlocked, has_recovery: exists && Vault::has_recovery(&root), plaintext_files: plain.len(), plaintext_bytes: plain.iter().map(|f| f.size).sum(), encrypted_files }
}

/// Migrate plaintext metadata files into the vault (or back out).
fn migrate_meta_in(v: &Vault, root: &Path) -> Result<(), String> {
    for (name, file) in [("library", ".mediasorter.json"), ("history", ".mediasorter.history.json"), ("cache", ".mediasorter.cache.json")] {
        let p = root.join(file);
        if p.exists() {
            v.write_meta(name, &std::fs::read(&p).map_err(|e| e.to_string())?)?;
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn migrate_meta_out(v: &Vault, root: &Path) -> Result<(), String> {
    for (name, file) in [("library", ".mediasorter.json"), ("history", ".mediasorter.history.json"), ("cache", ".mediasorter.cache.json")] {
        if let Some(bytes) = v.read_meta(name)? {
            std::fs::write(root.join(file), bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Create a vault and return its recovery code (shown once).
#[tauri::command]
fn vault_create(vs: VS, root: String, passphrase: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    let v = Vault::create(&root, &passphrase)?;
    let code = v.set_recovery_code()?;
    migrate_meta_in(&v, &root)?;
    *vs.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(v);
    Ok(code)
}

#[tauri::command]
fn vault_unlock(vs: VS, root: String, passphrase: String) -> Result<(), String> {
    let v = Vault::unlock(Path::new(&root), &passphrase)?;
    *vs.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(v);
    Ok(())
}

#[tauri::command]
fn vault_unlock_recovery(vs: VS, root: String, code: String) -> Result<(), String> {
    let v = Vault::unlock_with_recovery(Path::new(&root), &code)?;
    *vs.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(v);
    Ok(())
}

#[tauri::command]
fn vault_lock(vs: VS) {
    *vs.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

#[tauri::command]
fn vault_change_passphrase(vs: VS, old: String, new: String) -> Result<(), String> {
    let guard = vs.0.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_ref().ok_or("vault is locked")?.change_passphrase(&old, &new)
}

#[tauri::command]
fn vault_reset_passphrase(vs: VS, new: String) -> Result<(), String> {
    let guard = vs.0.lock().unwrap_or_else(|p| p.into_inner());
    guard.as_ref().ok_or("vault is locked")?.reset_passphrase(&new)
}

#[tauri::command]
fn vault_new_recovery_code(vs: VS, passphrase: String) -> Result<String, String> {
    let guard = vs.0.lock().unwrap_or_else(|p| p.into_inner());
    let v = guard.as_ref().ok_or("vault is locked")?;
    Vault::unlock(&v.root, &passphrase).map_err(|_| "passphrase is wrong".to_string())?;
    v.set_recovery_code()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VaultProgress {
    done: usize,
    total: usize,
    bytes: u64,
    total_bytes: u64,
    current: String,
}

/// Encrypt every plain file in the root into the vault and remove the plaintext.
#[tauri::command]
fn vault_encrypt_all(vs: VS, root: String, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let root = PathBuf::from(root);
    let mut guard = vs.0.lock().unwrap_or_else(|p| p.into_inner());
    let v = guard.as_mut().filter(|v| v.root == root).ok_or("vault is locked")?;
    let files = fsx::plaintext_files(&root);
    let total_bytes: u64 = files.iter().map(|f| f.size).sum();
    let mut bytes = 0u64;
    let mut n = 0usize;
    for (i, f) in files.iter().enumerate() {
        let rel = media::rel_key(&root, &f.path);
        let _ = on_progress.send(VaultProgress { done: i, total: files.len(), bytes, total_bytes, current: rel.clone() });
        if v.entry_by_rel(&rel).is_some() {
            // Same name already encrypted: keep the vault copy under a suffixed name.
            let mut k = 1;
            let mut alt = rel.clone();
            while v.entry_by_rel(&alt).is_some() {
                alt = ops::with_suffix(Path::new(&rel), k).to_string_lossy().into_owned();
                if let Some(dir) = Path::new(&rel).parent().filter(|d| !d.as_os_str().is_empty()) {
                    alt = format!("{}/{}", dir.to_string_lossy(), alt);
                }
                k += 1;
            }
            v.add_file(&f.path, &alt)?;
        } else {
            v.add_file(&f.path, &rel)?;
        }
        std::fs::remove_file(&f.path).map_err(|e| e.to_string())?;
        bytes += f.size;
        n += 1;
    }
    prune_empty_dirs(&root, &root);
    let _ = on_progress.send(VaultProgress { done: files.len(), total: files.len(), bytes, total_bytes, current: String::new() });
    Ok(n)
}

fn prune_empty_dirs(root: &Path, dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(Result::ok) {
            let p = e.path();
            if p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false) {
                continue;
            }
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                prune_empty_dirs(root, &p);
                if p != root {
                    let _ = std::fs::remove_dir(&p);
                }
            }
        }
    }
}

/// Decrypt selected logical paths into `dest`, keeping their relative folders.
#[tauri::command]
fn vault_export(vs: VS, root: String, paths: Vec<String>, dest: String) -> Result<usize, String> {
    let root = PathBuf::from(root);
    let dest = PathBuf::from(dest);
    with_ctx(&vs, &root, |ctx| {
        let mut n = 0;
        for p in &paths {
            let p = Path::new(p);
            let rel = p.strip_prefix(&root).map_err(|_| "path outside the folder")?;
            let out = dest.join(rel);
            if let Some(id) = ctx.vault_id(p) {
                ctx.vault.as_deref().unwrap().export(&id, &out)?;
            } else {
                if let Some(d) = out.parent() {
                    std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
                }
                std::fs::copy(p, &out).map_err(|e| e.to_string())?;
            }
            n += 1;
        }
        Ok(n)
    })
}

/// Decrypt everything back to plain files and delete the vault.
#[tauri::command]
fn vault_remove(vs: VS, root: String, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let root = PathBuf::from(root);
    let mut guard = vs.0.lock().unwrap_or_else(|p| p.into_inner());
    let v = guard.as_mut().filter(|v| v.root == root).ok_or("vault is locked")?;
    let entries: Vec<vault::Entry> = v.entries().to_vec();
    let total_bytes: u64 = entries.iter().map(|e| e.size).sum();
    let mut bytes = 0;
    for (i, e) in entries.iter().enumerate() {
        let _ = on_progress.send(VaultProgress { done: i, total: entries.len(), bytes, total_bytes, current: e.rel.clone() });
        let mut out = root.join(&e.rel);
        let mut k = 1;
        while out.exists() {
            out = out.parent().unwrap_or(&root).join(ops::with_suffix(Path::new(&e.rel), k));
            k += 1;
        }
        v.export(&e.id, &out)?;
        bytes += e.size;
    }
    migrate_meta_out(v, &root)?;
    std::fs::remove_dir_all(root.join(vault::VAULT_DIR)).map_err(|e| e.to_string())?;
    *guard = None;
    Ok(entries.len())
}

/* ---------------- files tab ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
    encrypted: bool,
    /// Number of files below a folder (recursive).
    count: usize,
}

#[tauri::command]
fn list_dir(vs: VS, root: String, dir: String) -> Result<Vec<DirEntryInfo>, String> {
    let root = PathBuf::from(root);
    let dir = resolve(&root, &dir);
    Ok(with_ctx(&vs, &root, |ctx| {
        let mut out: Vec<DirEntryInfo> = ctx
            .subdirs(&dir)
            .into_iter()
            .map(|d| {
                let files = ctx.list_files(&d, &[]);
                DirEntryInfo { name: d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path: d.to_string_lossy().into_owned(), is_dir: true, size: files.iter().map(|f| f.size).sum(), modified: files.iter().map(|f| f.modified).max().unwrap_or(0), encrypted: false, count: files.len() }
            })
            .collect();
        let mut files: Vec<DirEntryInfo> = ctx
            .list_files(&dir, &[])
            .into_iter()
            .filter(|f| f.path.parent() == Some(dir.as_path()))
            .map(|f| DirEntryInfo { name: f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path: f.path.to_string_lossy().into_owned(), is_dir: false, size: f.size, modified: f.modified, encrypted: ctx.vault_id(&f.path).is_some(), count: 0 })
            .collect();
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out.extend(files);
        out
    }))
}

#[tauri::command]
fn fs_mkdir(vs: VS, root: String, dir: String, name: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    let target = resolve(&root, &dir).join(name.trim());
    if name.trim().is_empty() || name.contains('/') || name.contains('\\') {
        return Err("invalid folder name".into());
    }
    with_ctx(&vs, &root, |ctx| {
        if ctx.vault.is_some() {
            // Folders in a vault exist only through their files; make a placeholder on disk
            // so the folder shows up and files can be dropped into it.
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        }
        Ok(target.to_string_lossy().into_owned())
    })
}

/// Move files and folders into `dest` (a logical folder). Returns new paths.
#[tauri::command]
fn fs_move(vs: VS, root: String, paths: Vec<String>, dest: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root);
    let dest_dir = resolve(&root, &dest);
    with_ctx(&vs, &root, |ctx| {
        let mut out = vec![];
        for p in &paths {
            let p = PathBuf::from(p);
            if dest_dir.starts_with(&p) {
                return Err("cannot move a folder into itself".into());
            }
            let is_dir = p.is_dir() || ctx.subdirs(p.parent().unwrap_or(&root)).iter().any(|d| d == &p);
            if is_dir {
                out.push(ctx.move_dir(&p, &dest_dir)?.to_string_lossy().into_owned());
            } else {
                let moved = ctx.move_group(&[p.clone()], &dest_dir)?;
                out.push(moved[0].to_string_lossy().into_owned());
            }
        }
        Ok(out)
    })
}

#[tauri::command]
fn fs_rename(vs: VS, root: String, path: String, new_name: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    let p = PathBuf::from(&path);
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') {
        return Err("invalid name".into());
    }
    let target = p.parent().unwrap_or(&root).join(new_name);
    with_ctx(&vs, &root, |ctx| {
        let is_dir = p.is_dir() || ctx.subdirs(p.parent().unwrap_or(&root)).iter().any(|d| d == &p);
        if is_dir {
            ctx.rename_dir(&p, &target)?;
        } else {
            if target.exists() || ctx.vault_id(&target).is_some() {
                return Err(format!("{new_name} already exists"));
            }
            ctx.move_one(&p, &target)?;
        }
        Ok(target.to_string_lossy().into_owned())
    })
}

/// Delete files and folders for good (the Files tab's own trash is the app trash folder).
#[tauri::command]
fn fs_delete(vs: VS, root: String, paths: Vec<String>) -> Result<usize, String> {
    let root = PathBuf::from(root);
    with_ctx(&vs, &root, |ctx| {
        let mut n = 0;
        for p in &paths {
            let p = PathBuf::from(p);
            let files = if p.is_dir() || ctx.subdirs(p.parent().unwrap_or(&root)).iter().any(|d| d == &p) { ctx.list_files(&p, &[]).into_iter().map(|f| f.path).collect() } else { vec![p.clone()] };
            for f in files {
                ctx.remove(&f)?;
                n += 1;
            }
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            }
        }
        Ok(n)
    })
}

/// Bring outside files into the folder (drag and drop): copied, and encrypted when a vault is open.
#[tauri::command]
fn fs_import(vs: VS, root: String, sources: Vec<String>, dest: String, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let root = PathBuf::from(root);
    let dest_dir = resolve(&root, &dest);
    // Expand folders.
    let mut files: Vec<(PathBuf, PathBuf)> = vec![]; // (source, target logical path)
    for s in &sources {
        let s = PathBuf::from(s);
        if s.is_dir() {
            let base = s.parent().unwrap_or(&s);
            for f in media::walk_files(&s, &[]) {
                let rel = f.path.strip_prefix(base).unwrap_or(&f.path);
                files.push((f.path.clone(), dest_dir.join(rel)));
            }
        } else if s.is_file() {
            files.push((s.clone(), dest_dir.join(s.file_name().unwrap_or_default())));
        }
    }
    let total_bytes: u64 = files.iter().filter_map(|(s, _)| std::fs::metadata(s).ok()).map(|m| m.len()).sum();
    let mut bytes = 0u64;
    with_ctx(&vs, &root, |ctx| {
        for (i, (src, target)) in files.iter().enumerate() {
            let _ = on_progress.send(VaultProgress { done: i, total: files.len(), bytes, total_bytes, current: src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() });
            let mut t = target.clone();
            let mut k = 1;
            while t.exists() || ctx.vault_id(&t).is_some() {
                t = target.parent().unwrap_or(&dest_dir).join(ops::with_suffix(target, k));
                k += 1;
            }
            let rel = media::rel_key(&root, &t);
            match ctx.vault.as_deref_mut() {
                Some(v) => {
                    v.add_file(src, &rel)?;
                }
                None => {
                    if let Some(d) = t.parent() {
                        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
                    }
                    std::fs::copy(src, &t).map_err(|e| e.to_string())?;
                }
            }
            bytes += std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        }
        let _ = on_progress.send(VaultProgress { done: files.len(), total: files.len(), bytes, total_bytes, current: String::new() });
        Ok(files.len())
    })
}

/* ---------------- misc ---------------- */

#[tauri::command]
fn initial_root() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-')).or_else(|| std::env::var("MEDIA_SORTER_ROOT").ok()).filter(|p| Path::new(p).is_dir())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn resolve_path(root: String, stored: String) -> String {
    resolve(Path::new(&root), &stored).to_string_lossy().into_owned()
}

fn content_type(rel: &str) -> &'static str {
    match rel.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic" | "heif") => "image/heic",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("tif" | "tiff") => "image/tiff",
        Some("mp4" | "m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("mts" | "m2ts") => "video/mp2t",
        _ => "application/octet-stream",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(VaultState::default())
        // vault://localhost/<id>  (http://vault.localhost/<id> on Windows): decrypts on demand with Range support.
        .register_asynchronous_uri_scheme_protocol("vault", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let id = request.uri().path().trim_start_matches('/').to_string();
            let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(String::from);
            std::thread::spawn(move || {
                let state = app.state::<VaultState>();
                let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
                let reply = |status: u16, body: Vec<u8>, extra: Vec<(&str, String)>| {
                    let mut b = tauri::http::Response::builder().status(status).header("Access-Control-Allow-Origin", "*").header("Accept-Ranges", "bytes");
                    for (k, v) in extra {
                        b = b.header(k, v);
                    }
                    b.body(body).unwrap()
                };
                let Some(v) = guard.as_ref() else {
                    return responder.respond(reply(423, b"vault is locked".to_vec(), vec![]));
                };
                let Some(entry) = v.entry_by_id(&id).cloned() else {
                    return responder.respond(reply(404, b"no such object".to_vec(), vec![]));
                };
                let ct = content_type(&entry.rel).to_string();
                match vault::parse_range(range.as_deref(), entry.size) {
                    Some((start, end)) => match v.read_range(&id, start, end) {
                        Ok(bytes) => responder.respond(reply(206, bytes, vec![("Content-Type", ct), ("Content-Range", format!("bytes {start}-{}/{}", end - 1, entry.size)), ("Content-Length", (end - start).to_string())])),
                        Err(e) => responder.respond(reply(500, e.into_bytes(), vec![])),
                    },
                    None if range.is_some() => responder.respond(reply(416, vec![], vec![("Content-Range", format!("bytes */{}", entry.size))])),
                    None => match v.read_all(&id) {
                        Ok(bytes) => responder.respond(reply(200, bytes, vec![("Content-Type", ct), ("Content-Length", entry.size.to_string())])),
                        Err(e) => responder.respond(reply(500, e.into_bytes(), vec![])),
                    },
                }
            });
        })
        .invoke_handler(tauri::generate_handler![
            load_library,
            save_library,
            load_history,
            save_history,
            load_cache,
            save_cache,
            scan_unsorted,
            scan_all,
            scan_dir,
            scan_trash,
            trash_info,
            empty_trash,
            move_item,
            trash_item,
            restore_files,
            move_dir,
            scan_albums,
            album_rename_plan,
            album_rename_apply,
            image_hash,
            file_fingerprint,
            raw_preview,
            drive_info,
            read_benchmark,
            verify_readability,
            cancel_verify,
            backup_plan,
            backup_run,
            cancel_backup,
            vault_status,
            vault_create,
            vault_unlock,
            vault_unlock_recovery,
            vault_lock,
            vault_change_passphrase,
            vault_reset_passphrase,
            vault_new_recovery_code,
            vault_encrypt_all,
            vault_export,
            vault_remove,
            list_dir,
            fs_mkdir,
            fs_move,
            fs_rename,
            fs_delete,
            fs_import,
            initial_root,
            path_exists,
            create_dir,
            resolve_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
