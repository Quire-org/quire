mod albums;
mod backup;
mod cast;
mod drive;
mod dupes;
mod edit;
mod formerly;
mod fsx;
mod jobctl;
mod libdocs;
mod library;
mod listing;
mod media;
mod ops;
mod pdf;
mod plugins;
mod preview;
mod quick;
mod engine;
mod serve;
mod thumbs;
mod update;
mod vault;
mod versions;

use quire_tags::{faceindex, learn, tagindex};

use fsx::Ctx;
use library::{resolve, Library};
use media::MediaItem;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tauri::ipc::Response;
use tauri::{Manager, State};
use vault::Vault;

/// The one unlocked vault (if any). Commands that may change it take the write
/// lock; serving vault media to the webview only reads, so those run side by side.
type VaultLock = RwLock<Option<Vault>>;

/// The vault state the app manages: shared, so a command can take a handle on it to a blocking
/// thread (`share`) while the state itself stays with the app.
#[derive(Default)]
pub struct VaultState(Arc<VaultLock>);

impl std::ops::Deref for VaultState {
    type Target = VaultLock;
    fn deref(&self) -> &VaultLock {
        &self.0
    }
}

impl VaultState {
    /// A handle on the vault for a blocking thread (see `blocking`): the helpers below take either
    /// this or the managed state itself.
    fn share(&self) -> Arc<VaultLock> {
        self.0.clone()
    }
}

type VS<'a> = State<'a, VaultState>;

fn with_ctx<T>(vs: &VaultLock, root: &Path, f: impl FnOnce(&mut Ctx) -> T) -> T {
    // A folder with no open vault is plain files: no lock, so commands run in parallel
    // instead of queueing behind whatever scan or save holds it.
    let vaulted = vs.read().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|v| v.root == root);
    if !vaulted {
        return f(&mut Ctx::new(root, None));
    }
    let mut guard = vs.write().unwrap_or_else(|p| p.into_inner());
    let out = f(&mut Ctx::new(root, guard.as_mut()));
    // Renames made by the command go to the vault's index in one write.
    if let Some(v) = guard.as_mut() {
        let _ = v.flush();
    }
    out
}

/// The pause/stop control of the Activity job a command runs as (`job` is its id there); without
/// an id, one that never pauses or stops.
fn control(job: Option<&str>) -> (Option<jobctl::Registered>, std::sync::Arc<jobctl::Control>) {
    match job {
        Some(id) => {
            let r = jobctl::register(id);
            let c = r.ctl.clone();
            (Some(r), c)
        }
        None => (None, jobctl::none()),
    }
}

/// Activity's Pause / Resume for a backend job.
#[tauri::command]
fn job_pause(id: String, on: bool) {
    jobctl::pause(&id, on);
}

/// Activity's Stop for a backend job: it stops at its next step (what is done stays done).
#[tauri::command]
fn job_stop(id: String) {
    jobctl::stop(&id);
}

/// For commands that only read: inside a vault they share it with other readers (scans,
/// hashing, pictures) instead of taking turns.
fn with_ctx_read<T>(vs: &VaultLock, root: &Path, f: impl FnOnce(&Ctx) -> T) -> T {
    let guard = vs.read().unwrap_or_else(|p| p.into_inner());
    f(&Ctx::reading(root, guard.as_ref()))
}

/* ---------------- library / metadata ---------------- */

// Every command below that reads or writes the library's files does so on a blocking thread
// (`blocking`), never on the threads that answer the window's other calls: a scan of a large folder, a
// file hashed or a state document written would otherwise hold those up.

#[tauri::command]
async fn load_library(vs: VS<'_>, root: String) -> Result<Library, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        with_ctx_read(&vs, &root, |ctx| {
            if ctx.vault.is_some() {
                match ctx.load_meta("library")? {
                    Some(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
                    None => Ok(Library::default()),
                }
            } else {
                Library::load(&root)
            }
        })
    })
    .await
}

#[tauri::command]
async fn save_library(vs: VS<'_>, root: String, library: Library) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        with_ctx(&vs, &root, |ctx| {
            if ctx.vault.is_some() {
                ctx.save_meta("library", &serde_json::to_string_pretty(&library).map_err(|e| e.to_string())?)
            } else {
                ctx.not_beside_a_locked_vault()?;
                library.save(&root)
            }
        })
    })
    .await
}

/// A state document: `Null` when there is none yet. One that is there but won't read (cut short by
/// a crash, a drive pulled mid-write) is an error, never `Null`: the app would save an empty one
/// over it and lose what was in it. It is set aside as `.broken` so the app starts again and the
/// reader still has it.
fn load_json(vs: &VaultLock, root: &str, name: &str) -> Result<serde_json::Value, String> {
    let text = match with_ctx_read(vs, Path::new(root), |ctx| ctx.load_meta(name)) {
        Ok(t) => {
            unreadable().remove(&(root.to_string(), name.to_string()));
            t
        }
        // Not read at all (the drive not answering, the vault not opening it): what is there stays
        // as it is, and no save goes over it until it reads (see `save_json`).
        Err(e) => {
            unreadable().insert((root.to_string(), name.to_string()));
            return Err(format!("the {name} file couldn't be read ({e}); it is left as it is"));
        }
    };
    let Some(text) = text else { return Ok(serde_json::Value::Null) };
    match serde_json::from_str(&text) {
        Ok(v) => Ok(v),
        Err(e) => {
            with_ctx(vs, Path::new(root), |ctx| ctx.set_aside_meta(name));
            Err(format!("the {name} file couldn't be read ({e}); it was set aside as {name}.broken and a new one starts"))
        }
    }
}

/// Documents that couldn't be read when last loaded, by library and name: a screen that started
/// empty instead must not save that over what is there.
fn unreadable() -> std::sync::MutexGuard<'static, std::collections::HashSet<(String, String)>> {
    static U: std::sync::OnceLock<Mutex<std::collections::HashSet<(String, String)>>> = std::sync::OnceLock::new();
    U.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner())
}

fn save_json(vs: &VaultLock, root: &str, name: &str, v: &serde_json::Value) -> Result<(), String> {
    if unreadable().contains(&(root.to_string(), name.to_string())) {
        return Err(format!("the {name} file couldn't be read when the library opened: not saved over it, so nothing in it is lost. Open the library again once its drive answers."));
    }
    with_ctx(vs, Path::new(root), |ctx| ctx.save_meta(name, &serde_json::to_string(v).map_err(|e| e.to_string())?))
}

/// `load_json` and `save_json` for a command: on a blocking thread (a cache or snapshot document runs
/// to megabytes).
async fn load_doc(vs: &VS<'_>, root: String, name: &'static str) -> Result<serde_json::Value, String> {
    let vs = vs.share();
    blocking(move || load_json(&vs, &root, name)).await
}

async fn save_doc(vs: &VS<'_>, root: String, name: &'static str, v: serde_json::Value) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || save_json(&vs, &root, name, &v)).await
}

/* ---------------- Scrapbook ---------------- */

/// Scrapbook's file names: made by the app (`cover-<id>.jpg`, `sticker-<id>.png`), never a path.
fn blob_name(name: &str) -> Result<&str, String> {
    let ok = name.len() <= 96 && name.split_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && stem.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && matches!(ext, "png" | "jpg"));
    if ok { Ok(name) } else { Err(format!("not a scrapbook file name: {name}")) }
}

/// The scrapbooks: each cover's layout (to edit again) and the custom stickers.
#[tauri::command]
async fn scrapbook_load(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "scrapbook").await
}
#[tauri::command]
async fn scrapbook_save(vs: VS<'_>, root: String, data: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "scrapbook", data).await
}

/// A rendered cover or a sticker, as bytes.
#[tauri::command]
async fn scrapbook_blob(vs: VS<'_>, root: String, name: String) -> Result<Response, String> {
    let name = blob_name(&name)?.to_string();
    let vs = vs.share();
    blocking(move || with_ctx_read(&vs, Path::new(&root), |ctx| ctx.load_blob(&name))?.map(Response::new).ok_or_else(|| format!("{name} is gone"))).await
}
#[tauri::command]
async fn scrapbook_blob_put(vs: VS<'_>, root: String, name: String, data_base64: String) -> Result<(), String> {
    use base64::Engine;
    let name = blob_name(&name)?.to_string();
    let vs = vs.share();
    blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes()).map_err(|e| format!("bad data: {e}"))?;
        with_ctx(&vs, Path::new(&root), |ctx| ctx.save_blob(&name, &bytes))
    })
    .await
}
/// A cover saved as a picture where the user says (a save dialog, opened here so the page never names
/// a path): PNG or JPEG by the name chosen, both made by the page. The path saved to, or none if
/// the dialog was cancelled.
#[tauri::command]
async fn scrapbook_export(app: tauri::AppHandle, name: String, png_base64: String, jpeg_base64: String) -> Result<Option<String>, String> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().set_file_name(&name).add_filter("PNG", &["png"]).add_filter("JPEG", &["jpg", "jpeg"]).save_file(move |p| {
        let _ = tx.send(p);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten()).await.map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let mut path = picked.into_path().map_err(|e| e.to_string())?;
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    let jpeg = matches!(ext.as_deref(), Some("jpg" | "jpeg"));
    if !jpeg && ext.as_deref() != Some("png") {
        path.as_mut_os_string().push(".png");
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(if jpeg { jpeg_base64 } else { png_base64 }.as_bytes()).map_err(|e| format!("bad data: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}
#[tauri::command]
async fn scrapbook_blob_delete(vs: VS<'_>, root: String, name: String) -> Result<(), String> {
    let name = blob_name(&name)?.to_string();
    let vs = vs.share();
    blocking(move || with_ctx(&vs, Path::new(&root), |ctx| ctx.remove_blob(&name))).await
}

/// Where the subjects of a picture are, for a sticker: the engine's mask, scaled to fit `max_side`;
/// of only a part of it (`crop`, fractions), to look closer.
#[tauri::command]
async fn scrapbook_cutout(app: tauri::AppHandle, vs: VS<'_>, root: String, path: String, max_side: u32, crop: Option<[f64; 4]>) -> Result<engine::CutOut, String> {
    let vs = vs.share();
    blocking(move || {
        let p = PathBuf::from(&path);
        let mut bytes = with_ctx_read(&vs, Path::new(&root), |ctx| ctx.read_all(&p))?;
        if media::classify(&p) == Some(media::MediaKind::Raw) {
            bytes = preview::embedded_jpeg_bytes(&bytes)?;
        }
        let state = app.state::<engine::EngineState>();
        engine::cutout(&app, &state, bytes, max_side.clamp(64, 4096), crop)
    })
    .await
}

#[tauri::command]
async fn load_history(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "history").await
}
#[tauri::command]
async fn save_history(vs: VS<'_>, root: String, history: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "history", history).await
}
/// What was where at the last full look at the library (and what went missing that had something
/// kept), so files moved outside the app are found again: `.quire.snapshot.json`, or in the vault.
#[tauri::command]
async fn snapshot_load(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "snapshot").await
}
#[tauri::command]
async fn snapshot_save(vs: VS<'_>, root: String, snapshot: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "snapshot", snapshot).await
}
#[tauri::command]
async fn load_cache(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "cache").await
}
#[tauri::command]
async fn save_cache(vs: VS<'_>, root: String, cache: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "cache", cache).await
}

/* ---------------- scanning ---------------- */

#[tauri::command]
async fn scan_unsorted(vs: VS<'_>, root: String, library: Library) -> Result<Vec<MediaItem>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        if !root.is_dir() {
            return Err(format!("{} is not a directory", root.display()));
        }
        let mut exclude: Vec<PathBuf> = library.targets.iter().map(|t| resolve(&root, &t.path)).collect();
        exclude.push(library.trash_path(&root));
        exclude.extend(library.album_root_paths(&root));
        Ok(with_ctx_read(&vs, &root, |ctx| ctx.scan(&root, &exclude)))
    })
    .await
}

#[tauri::command]
async fn scan_all(vs: VS<'_>, root: String, library: Library, include_albums: bool) -> Result<Vec<MediaItem>, String> {
    let vs = vs.share();
    blocking(move || {
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
        let mut items = with_ctx_read(&vs, &root, |ctx| {
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
    })
    .await
}

#[tauri::command]
async fn scan_dir(vs: VS<'_>, root: String, dir: String) -> Result<Vec<MediaItem>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let dir = resolve(&root, &dir);
        Ok(with_ctx_read(&vs, &root, |ctx| ctx.scan(&dir, &[])))
    })
    .await
}

#[tauri::command]
async fn scan_trash(vs: VS<'_>, root: String, library: Library) -> Result<Vec<MediaItem>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let trash = library.trash_path(&root);
        Ok(with_ctx_read(&vs, &root, |ctx| ctx.scan(&trash, &[])))
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashInfo {
    path: String,
    files: usize,
    bytes: u64,
}

#[tauri::command]
async fn trash_info(vs: VS<'_>, root: String, library: Library) -> Result<TrashInfo, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let trash = library.trash_path(&root);
        let files = with_ctx_read(&vs, &root, |ctx| ctx.list_files(&trash, &[]));
        Ok(TrashInfo { path: trash.to_string_lossy().into_owned(), files: files.len(), bytes: files.iter().map(|f| f.size).sum() })
    })
    .await
}

#[tauri::command]
async fn empty_trash(vs: VS<'_>, root: String, library: Library) -> Result<usize, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        // Only ever a folder inside the library: a trash folder named outside it (a library file from
        // elsewhere, a slip) would otherwise be emptied for good.
        let trash = library::confined(&root, &library.trash_path(&root))?;
        with_ctx(&vs, &root, |ctx| {
            let files = ctx.list_files(&trash, &[]);
            // Versions among them take the originals kept for them along.
            let links = versions::load(ctx)?;
            let gone: Vec<String> = files.iter().filter(|f| versions::could_be_version(&links, f.size)).filter_map(|f| ctx.fingerprint(&f.path).ok()).collect();
            for f in &files {
                ctx.remove(&f.path)?;
            }
            // Also drop anything left on disk (non-media files) and empty dirs.
            if trash.is_dir() {
                let _ = ops::purge_dir(&trash);
            }
            versions::forget(ctx, gone)?;
            Ok(files.len())
        })
    })
    .await
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
    let fallback = PathBuf::from(&item.primary);
    let primary = new_files.get(idx).unwrap_or(&fallback);
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

fn move_item_to(vs: &VaultLock, root: &Path, item: &MediaItem, dest_dir: &Path) -> Result<MoveResult, String> {
    with_ctx(vs, root, |ctx| {
        let files: Vec<PathBuf> = item.files.iter().map(PathBuf::from).collect();
        let new_files = ctx.move_group(&files, dest_dir)?;
        let moved = files.iter().zip(new_files.iter()).map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned())).collect();
        Ok(MoveResult { moved, item: rebuild_item(ctx, item, &new_files) })
    })
}

#[tauri::command]
async fn move_item(vs: VS<'_>, root: String, item: MediaItem, dest: String) -> Result<MoveResult, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let dest_dir = resolve(&root, &dest);
        move_item_to(&vs, &root, &item, &dest_dir)
    })
    .await
}

#[tauri::command]
async fn trash_item(vs: VS<'_>, root: String, library: Library, item: MediaItem) -> Result<MoveResult, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let trash = library::confined(&root, &library.trash_path(&root))?;
        move_item_to(&vs, &root, &item, &trash)
    })
    .await
}

/// Undo helper: put files back exactly where they were.
#[tauri::command]
async fn restore_files(vs: VS<'_>, root: String, moves: Vec<(String, String)>) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        with_ctx(&vs, &root, |ctx| {
            for (orig, cur) in &moves {
                let (orig, cur) = (PathBuf::from(orig), PathBuf::from(cur));
                // Undo puts files back where they were in the library, never anywhere else (where they
                // are now may be a sort target outside it).
                if !library::inside(&root, &orig) {
                    return Err(format!("{} is outside the opened folder", orig.display()));
                }
                if orig.exists() || ctx.vault_id(&orig).is_some() {
                    return Err(format!("cannot restore, {} already exists", orig.display()));
                }
                ctx.move_one(&cur, &orig)?;
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
async fn move_dir(vs: VS<'_>, root: String, dir: String, dest: String) -> Result<String, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let dest_dir = resolve(&root, &dest);
        with_ctx(&vs, &root, |ctx| ctx.move_dir(Path::new(&dir), &dest_dir).map(|p| p.to_string_lossy().into_owned()))
    })
    .await
}

/* ---------------- albums ---------------- */

#[tauri::command]
async fn scan_albums(vs: VS<'_>, root: String, library: Library) -> Result<Vec<albums::Album>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let roots: Vec<(String, PathBuf)> = library.album_roots.iter().map(|stored| (stored.clone(), resolve(&root, stored))).collect();
        Ok(with_ctx_read(&vs, &root, |ctx| albums::scan_albums(ctx, &root, &roots)))
    })
    .await
}

#[tauri::command]
async fn album_rename_plan(vs: VS<'_>, root: String, library: Library) -> Result<Vec<albums::Rename>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        Ok(with_ctx_read(&vs, &root, |ctx| albums::rename_plan(ctx, &root, &library.album_root_paths(&root))))
    })
    .await
}

#[tauri::command]
async fn album_rename_apply(vs: VS<'_>, root: String, plan: Vec<albums::Rename>) -> Result<Vec<albums::Rename>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        Ok(with_ctx(&vs, &root, |ctx| albums::rename_apply(ctx, &plan)))
    })
    .await
}

/* ---------------- hashing / preview ---------------- */

/// The thumbnail a thumb:// request asks for: from memory, from the vault's encrypted copies,
/// or made now from the picture.
fn thumb_for(app: &tauri::AppHandle, uri: &tauri::http::Uri) -> Result<std::sync::Arc<thumbs::Thumb>, (u16, String)> {
    let decode = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned();
    let path = PathBuf::from(decode(uri.path().trim_start_matches('/')));
    let mut width = 320;
    let mut root = None;
    // A face cut out of it (People), instead of the whole picture: its box and how much around it.
    let mut face: Option<[f32; 4]> = None;
    let mut around = 1.8f32;
    // A face in a video: the second of the frame it was seen in.
    let mut at: Option<f64> = None;
    for pair in uri.query().unwrap_or("").split('&') {
        match pair.split_once('=') {
            Some(("w", v)) => width = v.parse().unwrap_or(320),
            Some(("at", v)) => at = v.parse::<f64>().ok().filter(|a| a.is_finite() && *a >= 0.0),
            Some(("root", v)) => root = Some(PathBuf::from(decode(v))),
            Some(("face", v)) => {
                let n: Vec<f32> = decode(v).split(',').filter_map(|x| x.parse().ok()).collect();
                face = (n.len() == 4 && n.iter().all(|x| x.is_finite())).then(|| [n[0], n[1], n[2], n[3]]);
            }
            Some(("around", v)) => around = v.parse::<f32>().ok().filter(|a| a.is_finite()).unwrap_or(1.8).clamp(1.0, 4.0),
            _ => {}
        }
    }
    // A PDF's page may be asked for larger than a thumbnail: the viewer shows it from here.
    let page_width = width.clamp(64, 3200);
    let width = if face.is_some() { thumbs::face_side(width) } else { thumbs::bucket(width) };
    // The key a copy is kept under: a face's has its box too.
    let keyed = |k: String| match face {
        Some([a, b, c, d]) => format!("{k}|face {a:.4} {b:.4} {c:.4} {d:.4} {around:.2}{}", at.map(|t| format!(" @{t:.2}")).unwrap_or_default()),
        None => k,
    };
    let root = root.ok_or((400, "no root".to_string()))?;
    // A PDF album's page (the PDF itself: its first), drawn at that width.
    if let Some((pdf, page)) = pdf::split_page(&path.to_string_lossy()).or_else(|| pdf::is_pdf(&path).then(|| (path.clone(), 1))) {
        let vs = app.state::<VaultState>();
        let (size, modified) = with_ctx_read(&vs, &root, |ctx| ctx.stat(&pdf)).ok_or((404, "no such PDF".to_string()))?;
        let width = if page_width > width { page_width } else { width };
        let key = thumbs::key(&format!("{}#{page}", pdf.to_string_lossy()), size, modified, width);
        if let Some(t) = thumbs::cached(&key) {
            return Ok(t);
        }
        let bytes = with_ctx_read(&vs, &root, |ctx| ctx.read_all(&pdf)).map_err(|e| (404, e))?;
        let made = {
            let _turn = thumbs::Slot::take();
            pdf::render(bytes, page, width).and_then(|img| thumbs::encode(image::DynamicImage::ImageRgb8(img))).map_err(|e| (415, e))?
        };
        let t = std::sync::Arc::new(made);
        thumbs::keep(key, t.clone());
        return Ok(t);
    }
    let kind = media::classify(&path);
    let is_raw = kind == Some(media::MediaKind::Raw);
    if kind == Some(media::MediaKind::Video) {
        // The video's picture for its tile, in an open vault (outside one the window makes its own).
        let Some(bbox) = face else {
            return video_thumb(&app.state::<VaultState>().0, &root, &path, width);
        };
        // A face in a video: cut from the frame at its moment (kept in memory only, like other faces).
        let Some(at) = at else { return Err((415, "not a picture".into())) };
        let vs = app.state::<VaultState>();
        let (size, modified) = with_ctx_read(&vs, &root, |ctx| ctx.stat(&path)).ok_or((404, "no such video".to_string()))?;
        let key = keyed(thumbs::key(&path.to_string_lossy(), size, modified, width));
        if let Some(t) = thumbs::cached(&key) {
            return Ok(t);
        }
        let made = {
            let _turn = thumbs::Slot::take();
            if let Some(t) = thumbs::cached(&key) {
                return Ok(t);
            }
            let input = video_input(&vs, &root, &path).map_err(|e| (500, e))?;
            let png = video_frame_at(&input.arg, at).map_err(|e| (415, e))?;
            thumbs::face(&png, false, bbox, around, width).map_err(|e| (415, e))?
        };
        let t = std::sync::Arc::new(made);
        thumbs::keep(key, t.clone());
        return Ok(t);
    }
    if !matches!(kind, Some(media::MediaKind::Image) | Some(media::MediaKind::Raw)) {
        return Err((415, "not a picture".into()));
    }
    let shown = path.to_string_lossy().into_owned();
    let state = app.state::<VaultState>();
    // In an open vault: the encrypted copy kept from before, else the decrypted picture.
    let in_vault = {
        let guard = state.0.read().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref().filter(|v| v.root == root) {
            Some(v) => {
                let rel = path.strip_prefix(&root).ok().map(|r| media::rel_key(Path::new(""), r));
                match rel.and_then(|r| v.entry_by_rel(&r).cloned()) {
                    Some(e) => {
                        let key = keyed(thumbs::key(&shown, e.size, e.mtime, width));
                        if let Some(t) = thumbs::cached(&key) {
                            return Ok(t);
                        }
                        // Thumbnails are kept in the vault too; face crops only in memory.
                        let name = face.is_none().then(|| format!("{}-{width}", e.id));
                        if let Some(bytes) = name.as_ref().and_then(|n| v.read_thumb(n)) {
                            let t = std::sync::Arc::new(thumbs::Thumb::from_stored(bytes));
                            thumbs::keep(key, t.clone());
                            return Ok(t);
                        }
                        let bytes = v.read_all(&e.id).map_err(|e| (500, e))?;
                        Some((key, name, bytes))
                    }
                    None => None,
                }
            }
            None => None,
        }
    };
    let (key, vault_name, bytes) = match in_vault {
        Some((key, name, bytes)) => (key, name, bytes),
        None => {
            let meta = std::fs::metadata(&path).map_err(|e| (404, e.to_string()))?;
            let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
            let key = keyed(thumbs::key(&shown, meta.len(), modified, width));
            if let Some(t) = thumbs::cached(&key) {
                return Ok(t);
            }
            (key, None, std::fs::read(&path).map_err(|e| (404, e.to_string()))?)
        }
    };
    let made = {
        let _turn = thumbs::Slot::take();
        // Another request may have made it while this one waited.
        if let Some(t) = thumbs::cached(&key) {
            return Ok(t);
        }
        match face {
            Some(bbox) => thumbs::face(&bytes, is_raw, bbox, around, width),
            None => thumbs::make(&bytes, is_raw, width),
        }
        .map_err(|e| (415, e))?
    };
    let t = std::sync::Arc::new(made);
    if let Some(name) = vault_name {
        let guard = state.0.read().unwrap_or_else(|p| p.into_inner());
        if let Some(v) = guard.as_ref().filter(|v| v.root == root) {
            let _ = v.write_thumb(&name, &t.bytes);
        }
    }
    thumbs::keep(key, t.clone());
    Ok(t)
}

#[tauri::command]
async fn image_hash(vs: VS<'_>, root: String, path: String, is_raw: bool) -> Result<dupes::ImageHash, String> {
    let vs = vs.share();
    // Reading and decoding a full-size picture is seconds of disk and CPU: off the async workers that
    // answer every other command.
    blocking(move || {
        // A PDF album's page (the PDF itself: its first), drawn as a picture of it.
        if let Some((pdf, page)) = pdf::split_page(&path).or_else(|| pdf::is_pdf(Path::new(&path)).then(|| (PathBuf::from(&path), 1))) {
            let bytes = with_ctx_read(&vs, Path::new(&root), |ctx| ctx.read_all(&pdf))?;
            return dupes::image_hash_bytes(&pdf::render_jpeg(bytes, page, 1024)?, false);
        }
        let p = PathBuf::from(&path);
        let bytes = with_ctx_read(&vs, Path::new(&root), |ctx| if ctx.vault_id(&p).is_some() { ctx.read_all(&p).map(Some) } else { Ok(None) })?;
        match bytes {
            Some(b) => dupes::image_hash_bytes(&b, is_raw),
            None => dupes::image_hash(&p, is_raw),
        }
    })
    .await
}

#[tauri::command]
async fn file_fingerprint(vs: VS<'_>, root: String, path: String) -> Result<String, String> {
    let vs = vs.share();
    blocking(move || with_ctx_read(&vs, Path::new(&root), |ctx| ctx.fingerprint(Path::new(&path)))).await
}

#[tauri::command]
async fn raw_preview(vs: VS<'_>, root: String, path: String) -> Result<Response, String> {
    let vs = vs.share();
    blocking(move || {
        let p = PathBuf::from(&path);
        let bytes = with_ctx_read(&vs, Path::new(&root), |ctx| ctx.read_all(&p))?;
        preview::embedded_jpeg_bytes(&bytes).map(Response::new)
    })
    .await
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

/// Every file read through, as an Activity job (`job`: Pause and Stop reach it between files).
#[tauri::command]
async fn verify_readability(root: String, job: Option<String>, on_progress: tauri::ipc::Channel<drive::VerifyProgress>) -> Result<drive::VerifyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_job, ctl) = control(job.as_deref());
        drive::verify_readability(Path::new(&root), || ctl.go_on(), |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// One of the drive maker's apps that `drive_info` found, opened.
#[tauri::command]
async fn drive_open_app(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || drive::open_vendor_app(&path)).await.map_err(|e| e.to_string())?
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
#[allow(clippy::too_many_arguments)]
async fn backup_run(root: String, dest: String, plan: backup::Plan, mirror: bool, verify: bool, job: Option<String>, on_progress: tauri::ipc::Channel<backup::Progress>) -> Result<backup::Outcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_job, ctl) = control(job.as_deref());
        backup::run(Path::new(&root), Path::new(&dest), &plan, mirror, verify, &ctl, |p| {
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
    /// Quick unlock: "touchid", "hello" or "keyring", and whether this folder is remembered here.
    quick_method: String,
    quick_remembered: bool,
    /// The drive's format as the system names it ("msdos" for FAT, "exfat", "apfs"…), when known.
    format: Option<String>,
}

#[tauri::command]
async fn vault_status(vs: VS<'_>, root: String) -> Result<VaultStatus, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let exists = vault::exists(&root);
        let guard = vs.write().unwrap_or_else(|p| p.into_inner());
        let unlocked = guard.as_ref().map(|v| v.root == root).unwrap_or(false);
        let encrypted_files = guard.as_ref().filter(|v| v.root == root).map(|v| v.entries().len()).unwrap_or(0);
        let plain = if exists { fsx::plaintext_files(&root) } else { vec![] };
        Ok(VaultStatus {
            exists,
            unlocked,
            has_recovery: exists && Vault::has_recovery(&root),
            plaintext_files: plain.len(),
            plaintext_bytes: plain.iter().map(|f| f.size).sum(),
            encrypted_files,
            quick_method: quick::method().to_string(),
            quick_remembered: exists && quick::is_remembered(&root),
            format: fsx::fs_kind(&root),
        })
    })
    .await
}

/// The library's state files that go into a vault and back out: the fixed ones and each plugin's
/// (a sign-in kept with the library, say). Name in the vault, plain file name.
/// Create a vault and return its recovery code (shown once).
#[tauri::command]
async fn vault_create(vs: VS<'_>, root: String, passphrase: String) -> Result<String, String> {
    let vs = vs.share();
    // Deriving the key from the passphrase takes a moment on purpose, and the state files move in.
    blocking(move || {
        let root = PathBuf::from(root);
        let v = Vault::create(&root, &passphrase)?;
        let code = v.set_recovery_code()?;
        // Every document and scrapbook picture of the library goes in (see `libdocs`).
        libdocs::move_in(&v, &root)?;
        *vs.write().unwrap_or_else(|p| p.into_inner()) = Some(v);
        Ok(code)
    })
    .await
}

#[tauri::command]
async fn vault_unlock(vs: VS<'_>, root: String, passphrase: String) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let v = Vault::unlock(Path::new(&root), &passphrase)?;
        *vs.write().unwrap_or_else(|p| p.into_inner()) = Some(v);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn vault_unlock_recovery(vs: VS<'_>, root: String, code: String) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let v = Vault::unlock_with_recovery(Path::new(&root), &code)?;
        *vs.write().unwrap_or_else(|p| p.into_inner()) = Some(v);
        Ok(())
    })
    .await
}

/// Remember the open vault on this computer (behind Touch ID / Windows Hello / the keyring).
#[tauri::command]
async fn vault_remember(vs: VS<'_>) -> Result<(), String> {
    let vs = vs.share();
    // The prompt waits for the user: not on an async worker.
    blocking(move || {
        let guard = vs.write().unwrap_or_else(|p| p.into_inner());
        let v = guard.as_ref().ok_or("vault is locked")?;
        quick::authenticate_for_setup()?;
        quick::remember(&v.root, &v.data_key())
    })
    .await
}

#[tauri::command]
fn vault_forget(root: String) -> Result<(), String> {
    quick::forget(Path::new(&root))
}

/// Unlock with the key remembered on this computer, after the OS prompt.
#[tauri::command]
async fn vault_unlock_quick(vs: VS<'_>, root: String) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(&root);
        let key = quick::unlock(&root, "unlock the media vault")?;
        let v = Vault::unlock_with_key(&root, key)?;
        *vs.write().unwrap_or_else(|p| p.into_inner()) = Some(v);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn vault_lock(vs: VS<'_>) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        // The tag index's latest goes into the vault while it is still open; then the decrypted
        // index in memory goes too, rather than staying to be written anywhere later.
        let _ = flush_tag_index(&vs, true);
        let root = vs.read().unwrap_or_else(|p| p.into_inner()).as_ref().map(|v| v.root.clone());
        // Dropping the vault writes its index if anything is unsaved.
        *vs.write().unwrap_or_else(|p| p.into_inner()) = None;
        if let Some(root) = root {
            let mut g = tag_index_lock();
            if g.as_ref().is_some_and(|i| i.root == root) {
                *g = None;
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn vault_change_passphrase(vs: VS<'_>, old: String, new: String) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let guard = vs.write().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().ok_or("vault is locked")?.change_passphrase(&old, &new)
    })
    .await
}

#[tauri::command]
async fn vault_reset_passphrase(vs: VS<'_>, new: String) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let guard = vs.write().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().ok_or("vault is locked")?.reset_passphrase(&new)
    })
    .await
}

#[tauri::command]
async fn vault_new_recovery_code(vs: VS<'_>, passphrase: String) -> Result<String, String> {
    let vs = vs.share();
    blocking(move || {
        let guard = vs.write().unwrap_or_else(|p| p.into_inner());
        let v = guard.as_ref().ok_or("vault is locked")?;
        Vault::unlock(&v.root, &passphrase).map_err(|_| "passphrase is wrong".to_string())?;
        v.set_recovery_code()
    })
    .await
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

/// As a vault opens, what an earlier version left in the clear beside it comes in (see
/// `libdocs::move_in`): its library's tags, Home, scrapbook and the like, which the app couldn't
/// see. The tag index in memory is let go of when its files changed, to be read again.
#[tauri::command]
async fn vault_adopt(vs: VS<'_>, root: String) -> Result<libdocs::Moved, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        // Kept originals under Media Sorter's folder name, where Revert wouldn't find them.
        if let Some(v) = vs.write().unwrap_or_else(|p| p.into_inner()).as_mut().filter(|v| v.root == root)
            && let Err(e) = formerly::rename_vault_originals(v)
        {
            eprintln!("[vault] kept originals keep Media Sorter's folder name: {e}");
        }
        let moved = {
            let g = vs.read().unwrap_or_else(|p| p.into_inner());
            let v = g.as_ref().filter(|v| v.root == root).ok_or("vault is locked")?;
            libdocs::move_in(v, &root)?
        };
        if moved.tag_index_changed() {
            let mut g = tag_index_lock();
            if g.as_ref().is_some_and(|i| i.root == root) {
                *g = None;
            }
        }
        Ok(moved)
    })
    .await
}

/// Whether files of the vault are still where earlier versions kept them, every one in one folder.
#[tauri::command]
async fn vault_unsharded(vs: VS<'_>, root: String) -> Result<bool, String> {
    let vs = vs.share();
    blocking(move || Ok(vs.read().unwrap_or_else(|p| p.into_inner()).as_ref().filter(|v| v.root == Path::new(&root)).is_some_and(|v| v.has_unsharded()))).await
}

/// The vault's files still in one folder moved into their own folders (see `vault::shard`), as
/// Activity job `job`: a rename each, on the same drive, so nothing is copied. Paused or stopped
/// between files; what is left moves the next time. The vault reads files in either place meanwhile.
#[tauri::command]
async fn vault_shard(vs: VS<'_>, root: String, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let vs = vs.share();
    blocking(move || {
        let (_job, ctl) = control(job.as_deref());
        let root = PathBuf::from(root);
        let open = |vs: &VaultLock| vs.read().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|v| v.root == root);
        let (plan, objects) = {
            let g = vs.read().unwrap_or_else(|p| p.into_inner());
            let v = g.as_ref().filter(|v| v.root == root).ok_or("vault is locked")?;
            (v.unsharded(), v.objects_dir())
        };
        let total = plan.len();
        // Locked or closed meanwhile: the rest moves the next time it opens.
        let moved = move_into_folders(&plan, &objects, |i| ctl.go_on() && (i % 100 != 0 || open(&vs)), |done| {
            let _ = on_progress.send(VaultProgress { done, total, bytes: 0, total_bytes: 0, current: String::new() });
        })?;
        let _ = on_progress.send(VaultProgress { done: total, total, bytes: 0, total_bytes: 0, current: String::new() });
        Ok(moved)
    })
    .await
}

/// Each file renamed to where it goes, while `go_on` says so (asked before each, with its place in
/// the list); one already there (moved by a run cut short) is left. Their folders' changes take
/// their turn on FAT drives (see `fsx::one_at_a_time`). How many moved.
fn move_into_folders(plan: &[(PathBuf, PathBuf)], drive: &Path, mut go_on: impl FnMut(usize) -> bool, mut progress: impl FnMut(usize)) -> Result<usize, String> {
    let mut made = std::collections::HashSet::new();
    let mut moved = 0;
    for (i, (from, to)) in plan.iter().enumerate() {
        if i % 20 == 0 {
            progress(i);
        }
        if !go_on(i) {
            break;
        }
        let _turn = fsx::one_at_a_time(drive);
        if let Some(dir) = to.parent()
            && made.insert(dir.to_path_buf())
        {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        if to.exists() {
            continue;
        }
        match std::fs::rename(from, to) {
            Ok(()) => moved += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("moving the vault's files into folders: {e}")),
        }
    }
    Ok(moved)
}

/// Encrypt every plain file in the root into the vault and remove the plaintext.
#[tauri::command]
async fn vault_encrypt_all(vs: VS<'_>, root: String, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let vs = vs.share();
    blocking(move || encrypt_all(&vs, PathBuf::from(root), job, on_progress)).await
}

/// How long encrypted files wait to be named in the index together: the index names every object
/// and grows with the vault, so writing it after every file made each file slower than the last.
const ENCRYPT_BATCH: std::time::Duration = std::time::Duration::from_secs(2);
/// The most a batch holds, while room allows (its originals are deleted only once it is written).
const ENCRYPT_BATCH_BYTES: u64 = 1 << 30;
/// The biggest file FAT32 stores.
const FAT32_MAX_FILE: u64 = (1 << 32) - 1;

/// Files encrypted, waiting for the index to name them before their originals go.
struct Encrypted {
    sealed: vault::Sealed,
    rel: String,
    path: PathBuf,
    size: u64,
}

fn encrypt_all(vs: &VaultLock, root: PathBuf, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let (_job, ctl) = control(job.as_deref());
    if !vs.read().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|v| v.root == root) {
        return Err("vault is locked".into());
    }
    let files = fsx::plaintext_files(&root);
    let total_bytes: u64 = files.iter().map(|f| f.size).sum();
    // A file's original is deleted once its encrypted copy is named in the index, so the volume needs
    // room for one more encrypted copy of the largest file, plus a little; said now rather than
    // failing on that file halfway through. Room beyond that lets files wait to be named together.
    let largest = files.iter().map(|f| f.size).max().unwrap_or(0);
    let needed = largest + largest / 64 + 64 * 1024 * 1024;
    let free = drive::available_space(&root);
    if let Some(free) = free
        && free < needed
    {
        return Err(format!("Not enough free space: encrypting needs room for one more copy of the largest file ({}), and the volume has {} free.", format_bytes(largest), format_bytes(free)));
    }
    // FAT32 stores no file of 4 GB or more, and an encrypted copy is a little bigger than its file:
    // one that would pass that is said now, rather than failing halfway through.
    if fsx::fs_kind(&root).as_deref() == Some("msdos") {
        let too_big: Vec<_> = files.iter().filter(|f| vault::encrypted_size(f.size) > FAT32_MAX_FILE).collect();
        if let Some(first) = too_big.first() {
            let n = too_big.len();
            return Err(format!(
                "{n} file{} can't be encrypted on this drive, {}: it is FAT32, which stores no file of 4 GB or more, and encrypted it would pass that. A drive formatted exFAT or APFS takes {}.",
                if n == 1 { "" } else { "s" },
                if n == 1 { format!("\"{}\"", media::rel_key(&root, &first.path)) } else { format!("\"{}\" among them", media::rel_key(&root, &first.path)) },
                if n == 1 { "it" } else { "them" }
            ));
        }
    }
    let room = free.map_or(0, |f| (f - needed).min(ENCRYPT_BATCH_BYTES));
    let mut batch: Vec<Encrypted> = Vec::new();
    let mut since = std::time::Instant::now();
    let mut bytes = 0u64;
    let mut n = 0usize;
    let run = (|| -> Result<(), String> {
        for (i, f) in files.iter().enumerate() {
            let rel = media::rel_key(&root, &f.path);
            let _ = on_progress.send(VaultProgress { done: i, total: files.len(), bytes, total_bytes, current: rel.clone() });
            // Before a pause or stop, and every couple of seconds, the batch is named and its originals
            // go: each file is wholly in the vault, or wholly not, whenever the job waits or ends.
            let full = batch.iter().map(|e| e.size).sum::<u64>() >= room;
            if !batch.is_empty() && (ctl.paused() || ctl.stopped() || full || since.elapsed() >= ENCRYPT_BATCH) {
                n += settle(vs, &root, &mut batch)?;
                since = std::time::Instant::now();
            }
            if !ctl.go_on() {
                return Ok(());
            }
            // The slow part, encrypting, shares the vault: browsing it, scans and pictures go on meanwhile.
            let sealed = {
                let g = vs.read().unwrap_or_else(|p| p.into_inner());
                let v = g.as_ref().filter(|v| v.root == root).ok_or("vault is locked")?;
                let sealed = v.seal(&f.path)?;
                if let Err(e) = v.note_pending(sealed.id()) {
                    v.keys().discard(sealed);
                    return Err(e);
                }
                sealed
            };
            batch.push(Encrypted { sealed, rel, path: f.path.clone(), size: f.size });
            bytes += f.size;
        }
        Ok(())
    })();
    // What is encrypted is named and its originals go, whether the run ended, stopped or failed.
    let settled = settle(vs, &root, &mut batch);
    if let Ok(k) = settled {
        n += k;
    }
    run?;
    settled?;
    prune_empty_dirs(&root, &root);
    let _ = on_progress.send(VaultProgress { done: files.len(), total: files.len(), bytes, total_bytes, current: String::new() });
    Ok(n)
}

/// A batch of encrypted files named in the index in one write, then their originals deleted.
/// A write that fails (the drive full, the vault locked meanwhile) takes the batch back: its objects
/// are deleted and the originals stay, as if it had never been encrypted.
fn settle(vs: &VaultLock, root: &Path, batch: &mut Vec<Encrypted>) -> Result<usize, String> {
    if batch.is_empty() {
        return Ok(0);
    }
    let items = std::mem::take(batch);
    let objects = root.join(vault::VAULT_DIR).join("objects");
    let mut g = vs.write().unwrap_or_else(|p| p.into_inner());
    let Some(v) = g.as_mut().filter(|v| v.root == root) else {
        for e in &items {
            vault::remove_either(&objects, e.sealed.id());
        }
        return Err("vault is locked".into());
    };
    let mut ids = Vec::with_capacity(items.len());
    let mut done = Vec::with_capacity(items.len());
    let mut rest = items.into_iter();
    let mut failed = None;
    for e in rest.by_ref() {
        // Same name already encrypted: keep the vault copy under a suffixed name.
        let mut k = 1;
        let mut name = e.rel.clone();
        while v.entry_by_rel(&name).is_some() {
            name = ops::with_suffix(Path::new(&e.rel), k).to_string_lossy().into_owned();
            if let Some(dir) = Path::new(&e.rel).parent().filter(|d| !d.as_os_str().is_empty()) {
                name = format!("{}/{}", dir.to_string_lossy(), name);
            }
            k += 1;
        }
        let id = e.sealed.id().to_string();
        match v.commit(e.sealed, &name) {
            Ok(_) => {
                ids.push(id);
                done.push(e.path);
            }
            Err(err) => {
                failed = Some(err);
                break;
            }
        }
    }
    let failed = match failed {
        Some(err) => Err(err),
        None => v.flush(),
    };
    if let Err(err) = failed {
        for e in rest {
            vault::remove_either(&objects, e.sealed.id());
        }
        v.uncommit(&ids);
        let _ = v.clear_pending();
        return Err(err);
    }
    let _ = v.clear_pending();
    drop(g);
    // Every original goes, even past one that won't: the first refusal is said after.
    let mut first = None;
    let mut gone = 0;
    for path in &done {
        match std::fs::remove_file(path) {
            Ok(()) => gone += 1,
            Err(e) => {
                first.get_or_insert_with(|| format!("{}: {e}", path.display()));
            }
        }
    }
    first.map_or(Ok(gone), Err)
}

fn format_bytes(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u + 1 < units.len() {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{n} B") } else { format!("{v:.1} {}", units[u]) }
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
async fn vault_export(vs: VS<'_>, root: String, paths: Vec<String>, dest: String, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let vs = vs.share();
    blocking(move || export(&vs, PathBuf::from(root), paths, PathBuf::from(dest), job, on_progress)).await
}

fn export(vs: &VaultLock, root: PathBuf, paths: Vec<String>, dest: PathBuf, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let (_job, ctl) = control(job.as_deref());
    let size_of = |p: &Path| with_ctx_read(vs, &root, |ctx| ctx.vault_id(p).and_then(|id| ctx.vault.as_deref().and_then(|v| v.entry_by_id(&id)).map(|e| e.size)).unwrap_or_else(|| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)));
    let total_bytes: u64 = paths.iter().map(|p| size_of(Path::new(p))).sum();
    let (mut n, mut bytes) = (0, 0);
    for p in &paths {
        let p = Path::new(p);
        let rel = p.strip_prefix(&root).map_err(|_| "path outside the folder")?;
        let _ = on_progress.send(VaultProgress { done: n, total: paths.len(), bytes, total_bytes, current: rel.to_string_lossy().into_owned() });
        // Between files, holding nothing: paused, or stopped (what is out stays out).
        if !ctl.go_on() {
            break;
        }
        let out = dest.join(rel);
        with_ctx_read(vs, &root, |ctx| {
            if let Some(id) = ctx.vault_id(p) {
                ctx.vault.as_deref().unwrap().export(&id, &out)
            } else {
                if let Some(d) = out.parent() {
                    std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
                }
                std::fs::copy(p, &out).map(|_| ()).map_err(|e| e.to_string())
            }
        })?;
        bytes += size_of(p);
        n += 1;
    }
    Ok(n)
}

/// Decrypt everything back to plain files and delete the vault.
#[tauri::command]
async fn vault_remove(vs: VS<'_>, root: String, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let vs = vs.share();
    blocking(move || remove_vault(&vs, PathBuf::from(root), job, on_progress)).await
}

fn remove_vault(vs: &VaultLock, root: PathBuf, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<usize, String> {
    let (_job, ctl) = control(job.as_deref());
    let entries: Vec<vault::Entry> = vs.read().unwrap_or_else(|p| p.into_inner()).as_ref().filter(|v| v.root == root).ok_or("vault is locked")?.entries().to_vec();
    let mut made: Vec<PathBuf> = vec![];
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
        // Paused between files, holding nothing; stopped, the copies made so far go again and the
        // vault is as it was.
        if !ctl.go_on() {
            for p in &made {
                let _ = std::fs::remove_file(p);
            }
            return Err("Stopped: the vault is as it was.".into());
        }
        // Decrypting a file out only reads the vault: other commands may read it meanwhile.
        {
            let guard = vs.read().unwrap_or_else(|p| p.into_inner());
            guard.as_ref().filter(|v| v.root == root).ok_or("vault is locked")?.export(&e.id, &out)?;
        }
        made.push(out);
        bytes += e.size;
    }
    // The tag index's latest written first, so it comes out with the rest.
    flush_tag_index(vs, true)?;
    // Taking the vault apart is done alone: every document and scrapbook picture comes out first.
    let mut guard = vs.write().unwrap_or_else(|p| p.into_inner());
    let v = guard.as_mut().filter(|v| v.root == root).ok_or("vault is locked")?;
    libdocs::move_out(v, &root)?;
    std::fs::remove_dir_all(root.join(vault::VAULT_DIR)).map_err(|e| e.to_string())?;
    let _ = quick::forget(&root);
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
    /// Vault object id when encrypted (for thumbnails through the vault protocol).
    vault_id: Option<String>,
    /// Number of files below a folder (recursive).
    count: usize,
}

#[tauri::command]
async fn list_dir(vs: VS<'_>, root: String, dir: String) -> Result<Vec<DirEntryInfo>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let dir = resolve(&root, &dir);
        Ok(with_ctx_read(&vs, &root, |ctx| {
            // One walk of the tree: each file counts towards the subfolder it is under. (A walk per
            // subfolder and then one more for the direct files read everything twice.)
            let all = ctx.list_files(&dir, &[]);
            let mut totals: std::collections::HashMap<std::ffi::OsString, (_, _, usize)> = std::collections::HashMap::new();
            for f in &all {
                let Ok(rel) = f.path.strip_prefix(&dir) else { continue };
                let mut parts = rel.components();
                let (Some(first), Some(_)) = (parts.next(), parts.next()) else { continue };
                let t = totals.entry(first.as_os_str().to_os_string()).or_insert((0, 0, 0));
                t.0 += f.size;
                t.1 = t.1.max(f.modified);
                t.2 += 1;
            }
            let mut out: Vec<DirEntryInfo> = ctx
                .subdirs(&dir)
                .into_iter()
                .map(|d| {
                    let (size, modified, count) = d.file_name().and_then(|n| totals.get(n)).copied().unwrap_or((0, 0, 0));
                    DirEntryInfo { name: d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path: d.to_string_lossy().into_owned(), is_dir: true, size, modified, encrypted: false, vault_id: None, count }
                })
                .collect();
            let mut files: Vec<DirEntryInfo> = all
                .into_iter()
                .filter(|f| f.path.parent() == Some(dir.as_path()))
                .map(|f| {
                    let vid = ctx.vault_id(&f.path);
                    DirEntryInfo { name: f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), path: f.path.to_string_lossy().into_owned(), is_dir: false, size: f.size, modified: f.modified, encrypted: vid.is_some(), vault_id: vid, count: 0 }
                })
                .collect();
            files.sort_by_key(|a| a.name.to_lowercase());
            out.extend(files);
            out
        }))
    })
    .await
}

#[tauri::command]
async fn fs_mkdir(vs: VS<'_>, root: String, dir: String, name: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    if name.trim().is_empty() || name.contains('/') || name.contains('\\') {
        return Err("invalid folder name".into());
    }
    let target = library::confined(&root, &resolve(&root, &dir).join(name.trim()))?;
    let vs = vs.share();
    blocking(move || {
        with_ctx(&vs, &root, |_ctx| {
            // In a vault too: folders there exist only through their files, so a placeholder on disk
            // lets the folder show up and take files.
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            Ok(target.to_string_lossy().into_owned())
        })
    })
    .await
}

/// Move files and folders into `dest` (a logical folder). Returns new paths.
#[tauri::command]
async fn fs_move(vs: VS<'_>, root: String, paths: Vec<String>, dest: String) -> Result<Vec<String>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let dest_dir = resolve(&root, &dest);
        with_ctx(&vs, &root, |ctx| {
            // One failing halfway: what moved before it is told all the same (as `MovedSome`), so the
            // app can follow those files; else their ratings and tags would wait for the next scan.
            let mut out = vec![];
            for p in &paths {
                let p = PathBuf::from(p);
                let one = (|| {
                    if dest_dir.starts_with(&p) {
                        return Err("cannot move a folder into itself".to_string());
                    }
                    let is_dir = p.is_dir() || ctx.subdirs(p.parent().unwrap_or(&root)).iter().any(|d| d == &p);
                    if is_dir {
                        Ok(ctx.move_dir(&p, &dest_dir)?.to_string_lossy().into_owned())
                    } else {
                        let moved = ctx.move_group(std::slice::from_ref(&p), &dest_dir)?;
                        Ok(moved[0].to_string_lossy().into_owned())
                    }
                })();
                match one {
                    Ok(np) => out.push(np),
                    Err(e) => return Err(if out.is_empty() { e } else { format!("MovedSome:{}:{e}", serde_json::to_string(&out).unwrap_or_default()) }),
                }
            }
            Ok(out)
        })
    })
    .await
}

#[tauri::command]
async fn fs_rename(vs: VS<'_>, root: String, path: String, new_name: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    let p = library::confined(&root, Path::new(&path))?;
    let new_name = new_name.trim();
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') {
        return Err("invalid name".into());
    }
    let target = p.parent().unwrap_or(&root).join(new_name);
    let new_name = new_name.to_string();
    let vs = vs.share();
    blocking(move || {
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
    })
    .await
}

/// Delete files and folders for good (the Files tab's own trash is the app trash folder).
#[tauri::command]
async fn fs_delete(vs: VS<'_>, root: String, paths: Vec<String>) -> Result<usize, String> {
    let root = PathBuf::from(root);
    // Deleting for good: only inside the library, whatever path was handed over.
    for p in &paths {
        library::confined(&root, Path::new(p))?;
    }
    let vs = vs.share();
    blocking(move || {
        with_ctx(&vs, &root, |ctx| {
            let mut n = 0;
            // Versions among them take the originals kept for them along (as emptying the trash does).
            let links = versions::load(ctx)?;
            let mut gone: Vec<String> = Vec::new();
            for p in &paths {
                let p = PathBuf::from(p);
                let files: Vec<PathBuf> = if p.is_dir() || ctx.subdirs(p.parent().unwrap_or(&root)).iter().any(|d| d == &p) { ctx.list_files(&p, &[]).into_iter().map(|f| f.path).collect() } else { vec![p.clone()] };
                for f in files {
                    // Its size as stored: an encrypted file's from the vault (the drive has none by its name).
                    if let Some((size, _)) = ctx.stat(&f)
                        && versions::could_be_version(&links, size)
                        && let Ok(fp) = ctx.fingerprint(&f)
                    {
                        gone.push(fp);
                    }
                    ctx.remove(&f)?;
                    n += 1;
                }
                if p.is_dir() {
                    let _ = std::fs::remove_dir_all(&p);
                }
            }
            versions::forget(ctx, gone)?;
            Ok(n)
        })
    })
    .await
}

/* ---------------- showing on another device ---------------- */

/// The session showing on another device, while there is one.
#[derive(Default)]
struct CastState(std::sync::Mutex<Option<cast::Cast>>);

/// Starts showing: a link (for each network this Mac is on) and the certificate's fingerprint.
#[tauri::command]
async fn cast_start(state: tauri::State<'_, CastState>, remote: bool) -> Result<cast::CastInfo, String> {
    let mut g = state.0.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(c) = g.as_ref() {
        return Ok(c.info.clone());
    }
    let c = cast::start(remote)?;
    let info = c.info.clone();
    *g = Some(c);
    Ok(info)
}

/// Stops showing: every device is told it ended, and the link is dead.
#[tauri::command]
async fn cast_stop(state: tauri::State<'_, CastState>) -> Result<(), String> {
    state.0.lock().unwrap_or_else(|p| p.into_inner()).take();
    Ok(())
}

/// The picture shown now (a screen-sized JPEG the app made), or the video shown now (`video_path`,
/// streamed as the device's player asks), or nothing.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn cast_frame(app: tauri::AppHandle, state: tauri::State<'_, CastState>, seq: u64, jpeg_base64: Option<String>, name: String, video: bool, index: usize, total: usize, none: bool, video_path: Option<String>, root: Option<String>) -> Result<(), String> {
    use base64::Engine;
    let jpeg = match jpeg_base64 {
        Some(b) => base64::engine::general_purpose::STANDARD.decode(b.as_bytes()).map_err(|e| e.to_string())?,
        None => vec![],
    };
    let stream = match (video_path, root) {
        (Some(p), Some(r)) => video_source(&app, Path::new(&r), Path::new(&p)),
        _ => None,
    };
    let g = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let Some(c) = g.as_ref() else { return Ok(()) };
    c.shared.lock().unwrap_or_else(|p| p.into_inner()).frame = (!none).then_some(cast::Frame { seq, jpeg, name, video, stream, index, total });
    Ok(())
}

/// A video in the library a browser can play, to stream: read piece by piece, from the file or
/// decrypted from the vault (never written out). None for anything else.
fn video_source(app: &tauri::AppHandle, root: &Path, path: &Path) -> Option<cast::VideoSource> {
    if !path.starts_with(root) || media::classify(path) != Some(media::MediaKind::Video) {
        return None;
    }
    let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        _ => return None,
    };
    let in_vault = {
        let st = app.state::<VaultState>();
        let guard = st.0.read().unwrap_or_else(|p| p.into_inner());
        guard.as_ref().filter(|v| v.root == root).and_then(|v| {
            let rel = media::rel_key(root, path);
            v.entry_by_rel(&rel).map(|e| (std::sync::Arc::new(v.keys()), e.id.clone(), e.size))
        })
    };
    if let Some((keys, id, size)) = in_vault {
        let read = move |at: u64, n: usize| keys.read_range(&id, size, at, (at + n as u64).min(size));
        return Some(cast::VideoSource { size, mime, read: std::sync::Arc::new(read) });
    }
    let size = std::fs::metadata(path).ok()?.len();
    let file = path.to_path_buf();
    let read = move |at: u64, n: usize| -> Result<Vec<u8>, String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&file).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
        let mut buf = Vec::with_capacity(n);
        f.take(n as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    };
    Some(cast::VideoSource { size, mime, read: std::sync::Arc::new(read) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CastStatus {
    running: bool,
    devices: Vec<cast::Device>,
    /// Back (-1) or on (1), asked by devices since last time.
    nav: Vec<i32>,
}

#[tauri::command]
async fn cast_status(state: tauri::State<'_, CastState>) -> Result<CastStatus, String> {
    let g = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let Some(c) = g.as_ref() else { return Ok(CastStatus { running: false, devices: vec![], nav: vec![] }) };
    let mut s = c.shared.lock().unwrap_or_else(|p| p.into_inner());
    Ok(CastStatus { running: true, devices: s.devices.clone(), nav: std::mem::take(&mut s.nav) })
}

/// A device let in, turned down (its address can't ask again this session), or sent away.
#[tauri::command]
async fn cast_decide(state: tauri::State<'_, CastState>, id: String, allow: bool) -> Result<(), String> {
    let g = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let Some(c) = g.as_ref() else { return Ok(()) };
    let mut s = c.shared.lock().unwrap_or_else(|p| p.into_inner());
    let mut denied = None;
    if let Some(d) = s.devices.iter_mut().find(|d| d.id == id) {
        d.state = if allow { cast::Access::Allowed } else { cast::Access::Denied };
        if !allow {
            denied = d.ip.parse().ok();
        }
    }
    if let Some(ip) = denied {
        s.denied_ips.insert(ip);
    }
    Ok(())
}

/// Whether devices may go back and forth, or only follow the Mac.
#[tauri::command]
async fn cast_remote(state: tauri::State<'_, CastState>, on: bool) -> Result<(), String> {
    if let Some(c) = state.0.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        c.shared.lock().unwrap_or_else(|p| p.into_inner()).remote = on;
    }
    Ok(())
}

/* ---------------- importing ---------------- */

/// A file an import would bring in: where it is, its size, and whether it is in the library already
/// (then it is moved, not copied).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Incoming {
    path: String,
    size: u64,
    inside: bool,
}

/// What an import would bring in: every picture and video in the sources (folders gone through, the
/// trash left out).
#[tauri::command]
async fn import_scan(vs: VS<'_>, root: String, sources: Vec<String>, trash: String) -> Result<Vec<Incoming>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let trash = resolve(&root, &trash);
        with_ctx_read(&vs, &root, |ctx| {
            let mut out = vec![];
            let mut seen = std::collections::HashSet::new();
            for s in &sources {
                let s = PathBuf::from(s);
                let inside = s.starts_with(&root);
                let is_dir = s.is_dir() || (inside && ctx.subdirs(s.parent().unwrap_or(&root)).iter().any(|d| d == &s));
                let files = if is_dir {
                    if inside { ctx.list_files(&s, std::slice::from_ref(&trash)) } else { media::walk_files(&s, &[]) }
                } else {
                    let size = if inside { ctx.list_files(s.parent().unwrap_or(&root), &[]).into_iter().find(|f| f.path == s).map(|f| f.size) } else { std::fs::metadata(&s).ok().map(|m| m.len()) };
                    size.map(|size| vec![media::FileRef { path: s.clone(), size, modified: 0 }]).unwrap_or_default()
                };
                for f in files {
                    // Pictures and videos, and PDFs (which come in as albums).
                    if (media::classify(&f.path).is_none() && !pdf::is_pdf(&f.path)) || !seen.insert(f.path.clone()) {
                        continue;
                    }
                    out.push(Incoming { path: f.path.to_string_lossy().into_owned(), size: f.size, inside: f.path.starts_with(&root) });
                }
            }
            Ok(out)
        })
    })
    .await
}

/// Fingerprints (size and sampled content) of files in the library (a vault's too) or outside it, to
/// find exact copies: one per path, none for one that can't be read.
#[tauri::command]
async fn import_fingerprints(vs: VS<'_>, root: String, paths: Vec<String>, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<Vec<Option<String>>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let (_job, ctl) = control(job.as_deref());
        with_ctx_read(&vs, &root, |ctx| {
            let mut out = Vec::with_capacity(paths.len());
            for (i, p) in paths.iter().enumerate() {
                let _ = on_progress.send(VaultProgress { done: i, total: paths.len(), bytes: 0, total_bytes: 0, current: Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() });
                if !ctl.go_on() {
                    return Err("stopped".into());
                }
                let p = PathBuf::from(p);
                out.push(if p.starts_with(&root) { ctx.fingerprint(&p) } else { dupes::file_fingerprint(&p) }.ok());
            }
            Ok(out)
        })
    })
    .await
}

/// A file to bring in, and the folder (in the library) it goes to.
#[derive(serde::Deserialize)]
struct ImportItem {
    src: String,
    dest: String,
}

/// Bring files into the library, each into its own folder: copied from elsewhere (its time kept;
/// encrypted when a vault is open), or moved when it is in the library already. Where each went, in
/// order; none for those not reached (stopped) or that failed.
#[tauri::command]
async fn import_files(vs: VS<'_>, root: String, items: Vec<ImportItem>, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<Vec<Option<String>>, String> {
    let vs = vs.share();
    blocking(move || import_all(&vs, PathBuf::from(root), items, job, on_progress)).await
}

fn import_all(vs: &VaultLock, root: PathBuf, items: Vec<ImportItem>, job: Option<String>, on_progress: tauri::ipc::Channel<VaultProgress>) -> Result<Vec<Option<String>>, String> {
    let (_job, ctl) = control(job.as_deref());
    let total_bytes: u64 = items.iter().filter_map(|it| std::fs::metadata(&it.src).ok()).map(|m| m.len()).sum();
    let mut bytes = 0u64;
    let mut out = Vec::with_capacity(items.len());
    for (i, it) in items.iter().enumerate() {
        let src = PathBuf::from(&it.src);
        let _ = on_progress.send(VaultProgress { done: i, total: items.len(), bytes, total_bytes, current: src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() });
        if !ctl.go_on() {
            break;
        }
        let dest_dir = resolve(&root, &it.dest);
        let placed = if src.starts_with(&root) {
            with_ctx(vs, &root, |ctx| ctx.move_group(std::slice::from_ref(&src), &dest_dir)).map(|v| v[0].clone())
        } else {
            copy_in(vs, &root, &src, &dest_dir)
        };
        bytes += std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
        out.push(placed.ok().map(|p| p.to_string_lossy().into_owned()));
    }
    let _ = on_progress.send(VaultProgress { done: items.len(), total: items.len(), bytes, total_bytes, current: String::new() });
    Ok(out)
}

/// One outside file copied into `dest_dir` under the first free name (its own, else with " (1)"…),
/// its modified time kept; sealed into the vault when one is open.
fn copy_in(vs: &VaultLock, root: &Path, src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let name = src.file_name().ok_or("no file name")?;
    let target = dest_dir.join(name);
    let free = |taken: &dyn Fn(&Path) -> bool| {
        let mut t = target.clone();
        let mut k = 1;
        while taken(&t) {
            t = dest_dir.join(ops::with_suffix(&target, k));
            k += 1;
        }
        t
    };
    let vaulted = vs.read().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|v| v.root == root);
    if vaulted {
        let sealed = {
            let g = vs.read().unwrap_or_else(|p| p.into_inner());
            g.as_ref().filter(|v| v.root == root).ok_or("vault is locked")?.seal(src)?
        };
        let mut g = vs.write().unwrap_or_else(|p| p.into_inner());
        let v = g.as_mut().filter(|v| v.root == root).ok_or("vault is locked")?;
        let t = free(&|t: &Path| t.exists() || v.entry_by_rel(&media::rel_key(root, t)).is_some());
        v.commit(sealed, &media::rel_key(root, &t))?;
        v.flush()?;
        return Ok(t);
    }
    copy_plain(src, dest_dir)
}

/// An outside file copied into a plain folder under the first free name, its modified time kept.
fn copy_plain(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    let target = dest_dir.join(src.file_name().ok_or("no file name")?);
    let mut t = target.clone();
    let mut k = 1;
    while t.exists() {
        t = dest_dir.join(ops::with_suffix(&target, k));
        k += 1;
    }
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    std::fs::copy(src, &t).map_err(|e| format!("copy {}: {e}", src.display()))?;
    if let Ok(m) = std::fs::metadata(src).and_then(|m| m.modified())
        && let Ok(f) = std::fs::File::options().write(true).open(&t)
    {
        let _ = f.set_modified(m);
    }
    Ok(t)
}

/* ---------------- edits ---------------- */

#[tauri::command]
async fn edit_tools() -> Result<edit::Tools, String> {
    blocking(|| Ok(edit::tools())).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EditResult {
    item: MediaItem,
    /// (old, new) paths of originals moved away when replacing: kept for Revert (see versions.rs).
    trashed: Vec<(String, String)>,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn edit_apply(vs: VS<'_>, root: String, library: Library, item: MediaItem, op: edit::Pipeline, replace: bool, job: Option<String>, on_progress: tauri::ipc::Channel<f32>) -> Result<EditResult, String> {
    let vs = vs.share();
    blocking(move || apply_edit(&vs, PathBuf::from(root), library, item, op, replace, job, on_progress)).await
}

#[allow(clippy::too_many_arguments)]
fn apply_edit(vs: &VaultLock, root: PathBuf, library: Library, item: MediaItem, op: edit::Pipeline, replace: bool, job: Option<String>, on_progress: tauri::ipc::Channel<f32>) -> Result<EditResult, String> {
    let (_job, ctl) = control(job.as_deref());
    let trash = library.trash_path(&root);
    let tools = edit::tools();
    let primary = PathBuf::from(&item.primary);
    let files: Vec<PathBuf> = item.files.iter().map(PathBuf::from).collect();
    // Read the input sharing the vault, run ffmpeg holding nothing, then a moment alone with
    // the vault (or folder) to put the result in place.
    let prepared = with_ctx_read(vs, &root, |ctx| edit::prepare(ctx, &primary, &op))?;
    let produced = prepared.produce(&tools, &op, replace, &ctl, |p| {
        let _ = on_progress.send(p);
    })?;
    let (outcome, new_item) = with_ctx(vs, &root, |ctx| {
        // The original, replaced, is kept for Revert; either way the result says what it was made from.
        let from = ctx.fingerprint(&primary).ok();
        let away = match (&from, replace) {
            (Some(fp), true) => versions::put_away_to(ctx, fp, &trash),
            _ => trash.clone(),
        };
        let o = edit::finish(ctx, &primary, &files, produced, replace, &away)?;
        if let Some(fp) = &from
            && let Err(e) = versions::note_made(ctx, &o.new_primary, fp, &primary, "edit", "edited")
        {
            eprintln!("[versions] {}: {e}", o.new_primary.display());
        }
        let dir = o.new_primary.parent().unwrap_or(&root).to_path_buf();
        let items = ctx.scan(&dir, &[]);
        let it = items.into_iter().find(|i| Path::new(&i.primary) == o.new_primary || i.files.iter().any(|f| Path::new(f) == o.new_primary)).ok_or("edited file not found after import")?;
        Ok::<_, String>((o, it))
    })?;
    let mut new_item = new_item;
    new_item.target_id = item.target_id.clone();
    new_item.album_key = item.album_key.clone();
    Ok(EditResult { item: new_item, trashed: outcome.trashed.iter().map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned())).collect() })
}

/* ---------------- plugins ---------------- */

pub struct PluginsState(PathBuf);

/// The models installed plugins bring, for the engine's catalogue (none when the plugins can't be read).
pub(crate) fn own_models(app: &tauri::AppHandle) -> Vec<serde_json::Value> {
    registry(app).map(|r| r.own_models()).unwrap_or_default()
}

/* ---------------- one copy of the app per library ---------------- */

/// The library this copy of the app has open, held by a lock on a file of its own in the app's data
/// folder. A second copy of the app (a dev build beside the released one: they share that folder)
/// can't open the same library meanwhile. Each copy keeps the vault's index, the history and pending
/// saves in memory, and the one writing last would undo the other's changes. The lock goes when the
/// library closes, or with the app however it quits; one stuck quitting is taken over (see `take_claim`).
#[derive(Default)]
struct Claim(Mutex<Option<Held>>);

/// A library held: its lock file's name (the same library however its path is written) and the lock.
struct Held {
    name: String,
    _lock: fs::File,
}

/// Who holds a library, as the note beside its lock file says: written by the copy that took it. Not
/// in the lock file itself, which Windows lets no one else read while it is locked.
struct Holder {
    pid: u32,
    dev: bool,
    since: u64,
}

impl Holder {
    fn now() -> Self {
        let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        Holder { pid: std::process::id(), dev: cfg!(debug_assertions), since }
    }
    fn write(&self, note: &Path) {
        let _ = fs::write(note, format!("{}\n{}\n{}\n", self.pid, if self.dev { "dev" } else { "release" }, self.since));
    }
    fn read(note: &Path) -> Option<Self> {
        let text = fs::read_to_string(note).ok()?;
        let mut lines = text.lines();
        Some(Holder { pid: lines.next()?.parse().ok()?, dev: lines.next()? == "dev", since: lines.next()?.parse().ok()? })
    }
    /// Whether the holder can still write: running, not gone and not stuck quitting. macOS shows a
    /// process that can't finish quitting (waiting on a drive that stopped answering, say) as E, and
    /// one that has finished as Z; neither runs any of its own code again.
    fn running(&self) -> bool {
        #[cfg(unix)]
        {
            if self.pid == std::process::id() {
                return true;
            }
            if unsafe { libc::kill(self.pid as libc::pid_t, 0) } != 0 {
                return std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
            }
            match std::process::Command::new("ps").args(["-o", "stat=", "-p", &self.pid.to_string()]).output() {
                Ok(o) => {
                    let stat = String::from_utf8_lossy(&o.stdout);
                    let stat = stat.trim();
                    !(stat.is_empty() || stat.contains('E') || stat.contains('Z'))
                }
                Err(_) => true,
            }
        }
        #[cfg(not(unix))]
        true
    }
    /// The refusal, naming the copy that has the library open.
    fn refusal(&self) -> String {
        let now = Holder::now().since;
        let mins = now.saturating_sub(self.since) / 60_000;
        let time = match mins {
            0 => "a moment".to_string(),
            1..=59 => format!("{mins} minute{}", if mins == 1 { "" } else { "s" }),
            _ => format!("{} hour{}", mins / 60, if mins / 60 == 1 { "" } else { "s" }),
        };
        let which = if self.dev { "a dev build" } else { "the released app" };
        format!("This library is open in another copy of Quire ({which}, for {time}). Close it there first: two copies writing to one library would undo each other's changes. If that copy doesn't respond, force quit it in Activity Monitor (process {}).", self.pid)
    }
}

/// Take the claim on `root` (its lock file in `dir`), giving up the one held before only once the new
/// one is held. A copy holding it that has gone or is stuck quitting can't write any more: its lock
/// file is replaced by a new one, so the library opens here and stays guarded. A drive or system that
/// can't lock files doesn't stop a library opening.
fn take_claim(held: &mut Option<Held>, root: &Path, dir: &Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    // Named by a hash of the path, so the path itself shows nowhere; the path as written, tidied
    // (`a/./b/` is `a/b`) without asking the library's drive, which may not be answering.
    let mut plain = PathBuf::new();
    for c in root.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                plain.pop();
            }
            c => plain.push(c.as_os_str()),
        }
    }
    let name = hex::encode(&Sha256::digest(plain.to_string_lossy().as_bytes())[..16]);
    if held.as_ref().is_some_and(|h| h.name == name) {
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.lock"));
    let note = dir.join(format!("{name}.holder"));
    let open = || fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&path).map_err(|e| e.to_string());
    let mut f = open()?;
    match f.try_lock() {
        Ok(()) => {}
        Err(fs::TryLockError::WouldBlock) => {
            let holder = Holder::read(&note);
            match holder {
                Some(h) if !h.running() => {
                    // Replaced only while it is still the file found locked (another copy taking it
                    // over at the same moment has made a new one).
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::MetadataExt;
                        let same = fs::metadata(&path).ok().zip(f.metadata().ok()).is_some_and(|(a, b)| a.ino() == b.ino());
                        if same {
                            let _ = fs::remove_file(&path);
                        }
                    }
                    f = open()?;
                    if let Err(e) = f.try_lock() {
                        return Err(match (e, Holder::read(&note)) {
                            (fs::TryLockError::WouldBlock, Some(h)) => h.refusal(),
                            _ => "This library was just opened by another copy of Quire: close it there first.".into(),
                        });
                    }
                }
                Some(h) => return Err(h.refusal()),
                None => return Err("This library is open in another copy of Quire. Close it there first: two copies writing to one library would undo each other's changes.".into()),
            }
        }
        Err(fs::TryLockError::Error(e)) => eprintln!("[claim] can't lock {}: {e}", dir.display()),
    }
    Holder::now().write(&note);
    *held = Some(Held { name, _lock: f });
    Ok(())
}

#[tauri::command]
async fn library_claim(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let dir = data_dir().ok_or("the app's data folder isn't known yet")?.join("open-libraries");
    blocking(move || take_claim(&mut app.state::<Claim>().0.lock().unwrap_or_else(|p| p.into_inner()), Path::new(&root), &dir)).await
}

/// A library's files on its drive, from when the app was Media Sorter, get Quire's names (see
/// `formerly`), before anything of it is read; a models setting pointing into the folder that moved
/// follows it.
#[tauri::command]
async fn library_adopt_names(app: tauri::AppHandle, root: String) -> Result<formerly::Renamed, String> {
    blocking(move || {
        let out = formerly::rename_library_files(Path::new(&root))?;
        if let Some((from, to)) = &out.models
            && let Some(store) = engine::store_info(&app)?.path
            && let Ok(rest) = Path::new(&store).strip_prefix(from)
        {
            engine::set_store(&app, &app.state::<engine::EngineState>(), Some(to.join(rest).to_string_lossy().into_owned()))?;
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
async fn library_release(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || {
        *app.state::<Claim>().0.lock().unwrap_or_else(|p| p.into_inner()) = None;
        Ok(())
    })
    .await
}

fn registry(app: &tauri::AppHandle) -> Result<plugins::Registry, String> {
    let st = app.try_state::<PluginsState>().ok_or("plugins are not ready yet")?;
    Ok(plugins::Registry::new(st.0.clone()))
}

/// The app's data folder, known once the app has started.
static DATA_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub(crate) fn data_dir() -> Option<&'static Path> {
    DATA_DIR.get().map(PathBuf::as_path)
}

fn plugin_base(app: &tauri::App) -> PathBuf {
    if let Some(dir) = std::env::var_os("QUIRE_PLUGIN_DIR") {
        return PathBuf::from(dir);
    }
    app.path().app_data_dir().map(|d| d.join("plugins")).unwrap_or_else(|_| std::env::temp_dir().join("quire-plugins"))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn plugin_list(app: tauri::AppHandle) -> Result<Vec<plugins::PluginInfo>, String> {
    // Disk work: on a blocking thread, not the main thread that draws the window.
    blocking(move || {
        Ok(registry(&app)?.list())
    })
    .await
}

/// Read a plugin's manifest without installing it (for the permission prompt).
/// Look at a GitHub link or folder path before installing it.
#[tauri::command]
async fn plugin_inspect(app: tauri::AppHandle, source: String) -> Result<plugins::Inspected, String> {
    let reg = registry(&app)?;
    blocking(move || reg.inspect(&source)).await
}

/// Install from a GitHub link (downloaded at its current commit) or a folder (used in place).
#[tauri::command]
async fn plugin_install(app: tauri::AppHandle, source: String, granted: Vec<String>) -> Result<plugins::Manifest, String> {
    let reg = registry(&app)?;
    blocking(move || reg.install(&source, granted, None)).await
}

#[tauri::command]
async fn plugin_set_state(app: tauri::AppHandle, id: String, enabled: Option<bool>, allow_vault: Option<bool>, granted: Option<Vec<String>>) -> Result<plugins::PluginState, String> {
    // Disk work: on a blocking thread, not the main thread that draws the window.
    blocking(move || {
        registry(&app)?.set_state(&id, enabled, allow_vault, granted)
    })
    .await
}

/// The sites the reader allowed a plugin, for the library open (kept with it): what it may
/// contact and open now, until another library opens. Checked; what is kept.
#[tauri::command]
fn plugin_sites_set(id: String, sites: Vec<String>) -> Result<Vec<String>, String> {
    plugins::set_sites(&id, sites)
}

#[tauri::command]
async fn plugin_uninstall(app: tauri::AppHandle, id: String, keep_data: bool) -> Result<(), String> {
    // Disk work: on a blocking thread, not the main thread that draws the window.
    blocking(move || {
        registry(&app)?.uninstall(&id, keep_data)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCheck {
    id: String,
    update: Option<plugins::UpdateInfo>,
    error: Option<String>,
}

#[tauri::command]
async fn plugin_check_updates(app: tauri::AppHandle) -> Result<Vec<UpdateCheck>, String> {
    let reg = registry(&app)?;
    blocking(move || {
        Ok(reg
            .list()
            .into_iter()
            .map(|p| match reg.check_update(&p.id) {
                Ok(update) => UpdateCheck { id: p.id, update, error: None },
                Err(e) => UpdateCheck { id: p.id, update: None, error: Some(e) },
            })
            .collect())
    })
    .await
}

#[tauri::command]
async fn plugin_update(app: tauri::AppHandle, id: String, accept_new_permissions: bool) -> Result<plugins::Manifest, String> {
    let reg = registry(&app)?;
    blocking(move || reg.apply_update(&id, accept_new_permissions)).await
}

fn require(reg: &plugins::Registry, id: &str, perm: &str) -> Result<(), String> {
    if reg.effective_permissions(id).iter().any(|p| p == perm) {
        Ok(())
    } else {
        Err(format!("this plugin does not have the \"{perm}\" permission"))
    }
}

#[tauri::command]
async fn plugin_storage_get(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    // Disk work: on a blocking thread, not the main thread that draws the window.
    blocking(move || {
        let reg = registry(&app)?;
        require(&reg, &id, "storage")?;
        Ok(reg.storage_get(&id))
    })
    .await
}

#[tauri::command]
async fn plugin_storage_set(app: tauri::AppHandle, id: String, key: String, value: serde_json::Value) -> Result<(), String> {
    // Disk work: on a blocking thread, not the main thread that draws the window.
    blocking(move || {
        let reg = registry(&app)?;
        require(&reg, &id, "storage")?;
        reg.storage_set(&id, &key, value)
    })
    .await
}

#[tauri::command]
async fn plugin_settings_get(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    // Disk work: on a blocking thread, not the main thread that draws the window.
    blocking(move || {
        Ok(registry(&app)?.settings_get(&id))
    })
    .await
}

#[tauri::command]
async fn plugin_settings_set(app: tauri::AppHandle, id: String, values: serde_json::Value) -> Result<(), String> {
    // Disk work: on a blocking thread, not the main thread that draws the window.
    blocking(move || {
        registry(&app)?.settings_set(&id, values)
    })
    .await
}

/// Network for plugins: only https, only to hosts the user granted.
#[tauri::command]
async fn plugin_fetch(app: tauri::AppHandle, id: String, request: plugins::FetchRequest) -> Result<plugins::FetchResponse, String> {
    let reg = registry(&app)?;
    let granted = reg.effective_permissions(&id);
    if std::env::var_os("QUIRE_DEBUG").is_some() {
        eprintln!("[plugin:{id}] fetch {} {}", request.method, request.url);
    }
    blocking(move || plugins::plugin_fetch(&granted, &request)).await
}

/* ---------------- Find: what a plugin needs to search a platform and bring picks in ---------------- */

const MAX_LIBRARY_DOC: usize = 1024 * 1024;

/// A plugin's data kept with the library, in its state on the drive (in the vault when it has one).
fn plugin_doc(id: &str) -> String {
    format!("plugin-{id}")
}

/// A library with a locked vault: nothing of a plugin's is read or written, so it never lands in plain sight.
fn vault_open_for(ctx: &Ctx, root: &Path) -> Result<(), String> {
    if vault::exists(root) && ctx.vault.is_none() {
        return Err("this library's vault is locked: unlock it first".into());
    }
    Ok(())
}

fn plugin_doc_load(vs: &VaultLock, root: &Path, id: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let name = plugin_doc(id);
    let text = with_ctx(vs, root, |ctx| {
        vault_open_for(ctx, root)?;
        ctx.load_meta(&name)
    })?;
    let Some(text) = text else { return Ok(Default::default()) };
    match serde_json::from_str(&text) {
        Ok(v) => Ok(v),
        Err(e) => {
            with_ctx(vs, root, |ctx| ctx.set_aside_meta(&name));
            Err(format!("the plugin's data couldn't be read ({e}); it was set aside and a new one starts"))
        }
    }
}

#[tauri::command]
async fn plugin_library_get(app: tauri::AppHandle, vs: VS<'_>, id: String, root: String, key: String) -> Result<serde_json::Value, String> {
    let vs = vs.share();
    blocking(move || {
        require(&registry(&app)?, &id, "library:storage")?;
        Ok(plugin_doc_load(&vs, Path::new(&root), &id)?.remove(&key).unwrap_or(serde_json::Value::Null))
    })
    .await
}

/// A plugin removed with its data: what it kept with the open library goes too (its sign-ins, the
/// sites allowed it). Other libraries keep theirs until it is removed while they are open.
#[tauri::command]
async fn plugin_library_forget(vs: VS<'_>, id: String, root: String) -> Result<(), String> {
    if !plugins::valid_id(&id) {
        return Err("bad id".into());
    }
    let vs = vs.share();
    blocking(move || with_ctx(&vs, Path::new(&root), |ctx| ctx.remove_meta(&format!("plugin-{id}")))).await
}

/// Set (or with null, remove) one of a plugin's values kept with the library.
#[tauri::command]
async fn plugin_library_set(app: tauri::AppHandle, vs: VS<'_>, id: String, root: String, key: String, value: serde_json::Value) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        require(&registry(&app)?, &id, "library:storage")?;
        if key.is_empty() || key.len() > 200 {
            return Err("keys are 1-200 characters".into());
        }
        let root = PathBuf::from(root);
        let mut doc = plugin_doc_load(&vs, &root, &id)?;
        if value.is_null() {
            doc.remove(&key);
        } else {
            doc.insert(key, value);
        }
        let text = serde_json::to_string(&doc).map_err(|e| e.to_string())?;
        if text.len() > MAX_LIBRARY_DOC {
            return Err("a plugin keeps at most 1 MB with a library".into());
        }
        with_ctx(&vs, &root, |ctx| {
            vault_open_for(ctx, &root)?;
            if doc.is_empty() { ctx.remove_meta(&plugin_doc(&id)) } else { ctx.save_meta(&plugin_doc(&id), &text) }
        })
    })
    .await
}

/// Where a sign-in ended, and the cookies the plugin asked to keep (`name=value; …` for each address).
#[derive(serde::Serialize)]
struct LoginBack {
    url: String,
    cookies: std::collections::BTreeMap<String, String>,
}

/// A platform's sign-in page in a window of its own, for a plugin granted `login:<host>`. Gives the
/// address it went to that starts with one of `until` (where the platform sends the sign-in back),
/// or nothing when the window is closed first. With `cookies` (addresses on hosts the plugin may
/// reach), the window's cookies for them come back too, read just before it closes: the website's own
/// sign-in, for a plugin that also asks the website. The window keeps nothing on this computer.
#[tauri::command]
async fn plugin_login(app: tauri::AppHandle, id: String, url: String, until: Vec<String>, title: String, cookies: Option<Vec<String>>) -> Result<Option<LoginBack>, String> {
    let reg = registry(&app)?;
    let granted = reg.effective_permissions(&id);
    let url = plugins::login_allowed(&granted, &url)?;
    if until.is_empty() || until.iter().any(|p| p.len() < 8 || !p.contains("://")) {
        return Err("say where the sign-in ends: addresses like https://example.org/callback".into());
    }
    let keep = cookies.unwrap_or_default().into_iter().take(4).map(|c| plugins::url_allowed(&granted, &c).map(|u| (c, u))).collect::<Result<Vec<_>, _>>()?;
    let label = format!("login-{id}");
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    let back = tx.clone();
    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .title(format!("Sign in to {}", title.chars().take(40).collect::<String>()))
        .inner_size(520.0, 760.0)
        .incognito(true)
        .on_navigation(move |to| {
            let at = to.as_str();
            if !until.iter().any(|p| at.starts_with(p.as_str())) {
                return true;
            }
            let _ = back.send(Some(at.to_string()));
            false
        })
        .build()
        .map_err(|e| format!("could not open the sign-in window: {e}"))?;
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            let _ = tx.send(None);
        }
    });
    blocking(move || {
        let Some(at) = rx.recv().ok().flatten() else { return Ok(None) };
        // The cookies first (off the main thread, as reading them needs), then the window goes.
        let mut cookies = std::collections::BTreeMap::new();
        if let Some(w) = app.get_webview_window(&label) {
            for (address, u) in keep {
                let jar = w.cookies_for_url(u).unwrap_or_default();
                let line = jar.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ");
                if !line.is_empty() {
                    cookies.insert(address, line);
                }
            }
            let (app2, label2) = (app.clone(), label.clone());
            let _ = app.run_on_main_thread(move || {
                if let Some(w) = app2.get_webview_window(&label2) {
                    let _ = w.destroy();
                }
            });
        }
        Ok(Some(LoginBack { url: at, cookies }))
    })
    .await
}

/// What a site's browser check gave: its cookies (`name=value; …`) and the browser it saw, which
/// requests must say they are for the cookies to be taken.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckPassed {
    cookies: String,
    user_agent: String,
}

/// The browser the check window says it is (and requests after it then say too).
const CHECK_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

/// The bar the check window shows at the foot of the site's pages: what to do, and Done (a visit to
/// an address the window stops at, so the page itself never goes anywhere).
const CHECK_BAR: &str = r#"(function () {
  if (window.top !== window) return;
  var add = function () {
    if (!document.body || document.getElementById("quire-check-bar")) return;
    var bar = document.createElement("div");
    bar.id = "quire-check-bar";
    bar.setAttribute("style", "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 14px;background:#16161a;color:#f2f2f2;font:14px -apple-system,system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.45)");
    var say = document.createElement("span");
    say.textContent = "Quire: answer what the site asks (its check, an age question), then press Done.";
    var done = document.createElement("button");
    done.textContent = "Done";
    done.setAttribute("style", "flex:none;padding:6px 18px;border:0;border-radius:4px;background:#4f8cff;color:#fff;font:600 14px -apple-system,system-ui,sans-serif;cursor:pointer");
    done.onclick = function () { location.href = location.origin + "/?quire-check=done"; };
    bar.appendChild(say);
    bar.appendChild(done);
    document.body.appendChild(bar);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
  else add();
  setInterval(add, 1000);
})();"#;

/// A site's browser check (Cloudflare's "Just a moment…") and anything else it asks first (an age
/// question) answered in a window of the app's own, for a plugin that may open the site (`login:`,
/// or a site the reader allowed it). The window stays on the site (`stay_on`). The reader presses
/// Done on the bar at the foot of the page, or closes the window: the window's cookies for the site
/// then (its clearance, the answers it keeps) go to the plugin. Done, the window stays, hidden, as
/// the site's browser session (`plugin_browse`). None when there were no cookies, or after ten
/// minutes. Each check its own window.
#[tauri::command]
async fn plugin_check(app: tauri::AppHandle, id: String, url: String, name: String) -> Result<Option<CheckPassed>, String> {
    let reg = registry(&app)?;
    let granted = reg.effective_permissions(&id);
    let url = plugins::login_allowed(&granted, &url)?;
    static CHECKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let label = format!("check-{id}-{}", CHECKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pressed = done.clone();
    let site = site_of(&url);
    let stay = stay_on(site.clone());
    let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url.clone()))
        .title(format!("{}: answer what it asks, then press Done", name.chars().take(40).collect::<String>()))
        .inner_size(560.0, 760.0)
        .center()
        .focused(true)
        .incognito(true)
        .user_agent(CHECK_AGENT)
        .initialization_script(CHECK_BAR)
        .on_navigation(move |to| {
            if to.query().is_some_and(|q| q.contains("quire-check=done")) {
                pressed.store(true, std::sync::atomic::Ordering::Relaxed);
                return false;
            }
            stay(to)
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|e| format!("could not open the check window: {e}"))?;
    let gone = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = gone.clone();
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    });
    blocking(move || {
        let started = std::time::Instant::now();
        // The cookies as last seen: a window closed by the reader can't be asked any more.
        let mut last: Option<String> = None;
        loop {
            let finished = done.load(std::sync::atomic::Ordering::Relaxed);
            if gone.load(std::sync::atomic::Ordering::Relaxed) || started.elapsed() > std::time::Duration::from_secs(600) {
                break;
            }
            let Some(w) = app.get_webview_window(&label) else { break };
            let jar = w.cookies_for_url(url.clone()).unwrap_or_default();
            if !jar.is_empty() {
                last = Some(jar.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; "));
            }
            if finished {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let (app2, label2) = (app.clone(), label.clone());
        let pressed = done.load(std::sync::atomic::Ordering::Relaxed);
        let quiet = quiet_page(&url);
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(&label2) {
                // Done: it is the site's session from now on, out of sight, on a page of the site
                // that runs nothing (no ads, no tracking); else it goes.
                if pressed {
                    let _ = w.hide();
                    if let Some(q) = quiet {
                        let _ = w.navigate(q);
                    }
                } else {
                    let _ = w.destroy();
                }
            }
        });
        if pressed && last.is_some() {
            keep_session(&app, &id, &site, label);
        }
        Ok(last.map(|cookies| CheckPassed { cookies, user_agent: CHECK_AGENT.into() }))
    })
    .await
}

/// Where a site's session window waits: a page of the site with no scripts (its robots.txt), so it
/// runs none of the site's ads or tracking, and its requests are still the site's own.
fn quiet_page(url: &reqwest::Url) -> Option<reqwest::Url> {
    url.join("/robots.txt").ok()
}

/// A site's domain, as sessions are kept by: its host without "www.".
fn site_of(url: &reqwest::Url) -> String {
    url.host_str().unwrap_or_default().trim_start_matches("www.").to_ascii_lowercase()
}

/// Where a site's window may go: the site and its subdomains, and Cloudflare's check; never where
/// an ad would send it.
fn stay_on(site: String) -> impl Fn(&reqwest::Url) -> bool + Send + 'static {
    move |to| match to.scheme() {
        "about" | "data" | "blob" => true,
        _ => {
            let host = to.host_str().unwrap_or_default().to_ascii_lowercase();
            host == site || host.ends_with(&format!(".{site}")) || host == "challenges.cloudflare.com"
        }
    }
}

/// Sites' browser sessions: "<plugin>|<site>" → the hidden window that fetches its pages.
static SESSIONS: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> = std::sync::Mutex::new(None);

/// A window as the session of a plugin's site, in place of any before it (which goes).
fn keep_session(app: &tauri::AppHandle, id: &str, site: &str, label: String) {
    let old = SESSIONS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(Default::default).insert(format!("{id}|{site}"), label.clone());
    if let Some(old) = old.filter(|o| *o != label) {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(&old) {
                let _ = w.destroy();
            }
        });
    }
}

/// A page as a site's browser session fetched it. `truncated`: it was longer than `BROWSE_BODY_CAP`
/// and only that much came back.
#[derive(serde::Serialize)]
struct Browsed {
    status: u16,
    body: String,
    truncated: bool,
}

/// The most of a page `plugin_browse` hands back, in UTF-16 units (what a JavaScript string counts): a
/// page is read in the site's own window, which a hostile site could fill with hundreds of megabytes
/// that would then cross into the app and on to the plugin whole. The pages plugins read (listings,
/// a work's page) are a few hundred kilobytes.
const BROWSE_BODY_CAP: usize = 8 * 1024 * 1024;

/// Script run in a session window, its answer back: a string, or None (null, or no answer: a window
/// still on its first page runs scripts only once it has loaded, and answers none of them).
fn eval_in(window: &tauri::WebviewWindow, js: String) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    window
        .eval_with_callback(js, move |out| {
            let _ = tx.send(out);
        })
        .map_err(|e| e.to_string())?;
    // The script's value, as JSON: a string (what it said), or null.
    Ok(rx.recv_timeout(std::time::Duration::from_secs(4)).ok().and_then(|out| serde_json::from_str::<Option<String>>(&out).ok().flatten()))
}

/// A page of a site fetched by its browser session: a hidden window of the app's own, on the site,
/// that its check let in, so the request is the browser's own (some checks turn the app's own
/// requests away, whatever cookies they carry). The window passed the check in `plugin_check`; one
/// gone (the app restarted) is opened again, hidden, with the site's cookies the plugin kept
/// (`cookies`). For a plugin that may open the site; only its pages, as text.
#[tauri::command]
async fn plugin_browse(app: tauri::AppHandle, id: String, url: String, cookies: Option<String>) -> Result<Browsed, String> {
    let reg = registry(&app)?;
    let granted = reg.effective_permissions(&id);
    let url = plugins::login_allowed(&granted, &url)?;
    let site = site_of(&url);
    let key = format!("{id}|{site}");
    let known = SESSIONS.lock().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|s| s.get(&key).cloned());
    let label = match known.filter(|l| app.get_webview_window(l).is_some()) {
        Some(l) => l,
        None => {
            let Some(line) = cookies.filter(|c| !c.trim().is_empty()) else {
                return Err(format!("no browser session for {site}: its check comes first"));
            };
            static OPENED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let label = format!("browse-{id}-{}", OPENED.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
            let home = quiet_page(&url).ok_or_else(|| format!("{site} has no page to wait on"))?;
            let window = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External("about:blank".parse().map_err(|e| format!("{e}"))?))
                .title(format!("{site}, for Quire"))
                .visible(false)
                .incognito(true)
                .user_agent(CHECK_AGENT)
                .on_navigation(stay_on(site.clone()))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()
                .map_err(|e| format!("could not open {site}'s window: {e}"))?;
            for pair in line.split(';') {
                let Some((name, value)) = pair.trim().split_once('=') else { continue };
                let c = tauri::webview::cookie::Cookie::build((name.trim().to_string(), value.trim().to_string())).domain(format!(".{site}")).path("/").secure(true).build();
                let _ = window.set_cookie(c);
            }
            window.navigate(home).map_err(|e| e.to_string())?;
            keep_session(&app, &id, &site, label.clone());
            label
        }
    };
    blocking(move || {
        let window = app.get_webview_window(&label).ok_or_else(|| format!("{site}'s window is gone"))?;
        // A window just opened loads the site first.
        let started = std::time::Instant::now();
        while eval_in(&window, "(function(){return document.readyState === 'complete' && location.protocol === 'https:' ? 'ready' : null;})()".into())?.is_none() {
            if started.elapsed() > std::time::Duration::from_secs(30) {
                return Err(format!("{site} didn't load in its window"));
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let slot = format!("__ms{:016x}", rand_u64());
        let start = format!(
            r#"(function(){{var k={slot};var u=new URL({url},location.href);
if(u.host!==location.host&&u.host.replace(/^www\./,"")===location.host.replace(/^www\./,""))u.host=location.host;
window[k]=null;
fetch(u.href,{{credentials:"include",headers:{{Accept:"text/html,application/xhtml+xml"}}}}).then(function(r){{return r.text().then(function(t){{var cap={cap};window[k]=JSON.stringify({{status:r.status,body:t.length>cap?t.slice(0,cap):t,truncated:t.length>cap}});}});}}).catch(function(e){{window[k]=JSON.stringify({{error:String(e)}});}});
return "started";}})()"#,
            slot = serde_json::to_string(&slot).unwrap_or_default(),
            url = serde_json::to_string(url.as_str()).unwrap_or_default(),
            cap = BROWSE_BODY_CAP,
        );
        eval_in(&window, start)?;
        let read = format!("(function(){{var k={};var v=window[k];if(!v)return null;delete window[k];return v;}})()", serde_json::to_string(&slot).unwrap_or_default());
        let started = std::time::Instant::now();
        loop {
            if let Some(out) = eval_in(&window, read.clone())? {
                let v: serde_json::Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
                if let Some(e) = v["error"].as_str() {
                    return Err(format!("{site}'s window couldn't fetch it: {e}"));
                }
                // The cap is applied in the window's own script; checked here too, since that script
                // runs in the site's page, where the site's scripts could have replaced what it uses.
                let body = v["body"].as_str().unwrap_or_default();
                let cut = body.char_indices().map(|(i, _)| i).nth(BROWSE_BODY_CAP);
                return Ok(Browsed { status: v["status"].as_u64().unwrap_or(0) as u16, body: body[..cut.unwrap_or(body.len())].to_string(), truncated: v["truncated"].as_bool().unwrap_or(false) || cut.is_some() });
            }
            if started.elapsed() > std::time::Duration::from_secs(60) {
                return Err(format!("{site} took too long to answer"));
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    })
    .await
}

/// A random number, for names a site's own scripts can't guess.
fn rand_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}

/// Find's own state for a library (the basket: works kept to look at later), with the library.
#[tauri::command]
async fn find_state_load(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "find").await
}
#[tauri::command]
async fn find_state_save(vs: VS<'_>, root: String, data: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "find", data).await
}

/* ---------------- People: the faces in the library's pictures ---------------- */

/// The face index of the library open, kept loaded; saved when it changed and some time has passed.
struct Faces {
    root: PathBuf,
    ix: faceindex::FaceIndex,
    dirty: bool,
    saved: std::time::Instant,
}
static FACES: Mutex<Option<Faces>> = Mutex::new(None);

fn faces_lock() -> std::sync::MutexGuard<'static, Option<Faces>> {
    FACES.lock().unwrap_or_else(|p| p.into_inner())
}

/// The face index of `root` (read from the library the first time), and `f` on it; `change`: it changed.
fn with_faces<T>(vs: &VaultLock, root: &Path, change: bool, f: impl FnOnce(&mut faceindex::FaceIndex) -> T) -> Result<T, String> {
    let mut g = faces_lock();
    if !g.as_ref().is_some_and(|x| x.root == root) {
        let bytes = with_ctx(vs, root, |ctx| {
            vault_open_for(ctx, root)?;
            ctx.load_meta_bytes("faces")
        })?;
        let ix = bytes.map(|b| faceindex::FaceIndex::from_bytes(&b)).transpose()?.unwrap_or_default();
        *g = Some(Faces { root: root.to_path_buf(), ix, dirty: false, saved: std::time::Instant::now() });
    }
    let x = g.as_mut().expect("loaded above");
    x.dirty |= change;
    Ok(f(&mut x.ix))
}

/// The face index to the library, if it changed: now (`force`), or once half a minute has passed.
fn save_faces(vs: &VaultLock, force: bool) -> Result<(), String> {
    let (root, bytes) = {
        let mut g = faces_lock();
        let Some(x) = g.as_mut() else { return Ok(()) };
        if !x.dirty || (!force && x.saved.elapsed() < std::time::Duration::from_secs(30)) {
            return Ok(());
        }
        x.dirty = false;
        x.saved = std::time::Instant::now();
        (x.root.clone(), x.ix.to_bytes())
    };
    with_ctx(vs, &root, |ctx| {
        vault_open_for(ctx, &root)?;
        ctx.save_meta_bytes("faces", &bytes)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FacesView {
    faces: Vec<faceindex::FaceView>,
    /// The pictures looked at, as they were then: `[size, modified]`.
    scanned: std::collections::HashMap<String, [u64; 2]>,
    /// The ones looked at without the character finder: looked at again once it is downloaded.
    no_characters: Vec<String>,
}

/// The faces found so far in the library, and which pictures were looked at.
#[tauri::command]
async fn faces_load(vs: VS<'_>, root: String) -> Result<FacesView, String> {
    let vs = vs.share();
    blocking(move || with_faces(&vs, Path::new(&root), false, |ix| FacesView { faces: ix.views(), scanned: ix.scanned.iter().map(|(k, s)| (k.clone(), [s.s, s.m])).collect(), no_characters: ix.no_characters.iter().cloned().collect() })).await
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FaceItem {
    key: String,
    path: String,
    size: u64,
    modified: u64,
    /// "photo" or "drawn" when the tag index knows which the picture is.
    kind: Option<String>,
    #[serde(default)]
    raw: bool,
    /// A video: a few frames spread over it are looked at, each face kept with its moment.
    #[serde(default)]
    video: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FaceProgress {
    done: usize,
    total: usize,
    current: String,
    faces: usize,
}

/// Look for faces in pictures, as an Activity job (paused and stopped there): each picture's faces
/// kept as it is done, so a stop or a restart loses at most the last half minute. How many faces were found.
#[tauri::command]
async fn faces_scan(app: tauri::AppHandle, vs: VS<'_>, root: String, items: Vec<FaceItem>, job: Option<String>, on_progress: tauri::ipc::Channel<FaceProgress>) -> Result<usize, String> {
    let vs = vs.share();
    blocking(move || scan_faces(&app, &vs, PathBuf::from(root), items, job, on_progress)).await
}

fn scan_faces(app: &tauri::AppHandle, vs: &VaultLock, rootp: PathBuf, items: Vec<FaceItem>, job: Option<String>, on_progress: tauri::ipc::Channel<FaceProgress>) -> Result<usize, String> {
    with_faces(vs, &rootp, false, |_| ())?;
    let (_job, ctl) = control(job.as_deref());
    let total = items.len();
    let mut found_all = 0usize;
    let mut result = Ok(());
    // Without ffmpeg, videos wait (not stamped as looked at) until it is installed.
    let mut no_ffmpeg = false;
    for (i, it) in items.iter().enumerate() {
        let _ = on_progress.send(FaceProgress { done: i, total, current: it.key.clone(), faces: found_all });
        if !ctl.go_on() {
            break;
        }
        if it.video {
            if no_ffmpeg {
                continue;
            }
            let stamp = tagindex::Stamp { s: it.size, m: it.modified };
            match video_faces(app, vs, &rootp, it) {
                Ok((found, characters)) => {
                    found_all += found.len();
                    with_faces(vs, &rootp, true, |ix| {
                        ix.put(&it.key, stamp, found);
                        if !characters && it.kind.as_deref() != Some("photo") {
                            ix.without_characters(&it.key);
                        }
                    })?;
                    let _ = save_faces(vs, false);
                }
                Err(e) if e.starts_with("ffmpeg is needed") => no_ffmpeg = true,
                Err(e) if e.starts_with("not downloaded") || e.contains("engine") => {
                    result = Err(e);
                    break;
                }
                // A video that can't be read counts as looked at, with no faces: not tried again until it changes.
                Err(_) => with_faces(vs, &rootp, true, |ix| ix.put(&it.key, stamp, Vec::new()))?,
            }
            continue;
        }
        let path = PathBuf::from(&it.path);
        let bytes = with_ctx_read(vs, &rootp, |ctx| ctx.read_all(&path)).and_then(|b| if it.raw { preview::embedded_jpeg_bytes(&b) } else { Ok(b) });
        // The parts the reader marked faces in: looked in again with the picture.
        let marks = with_faces(vs, &rootp, false, |ix| ix.marked_in(&it.key))?;
        let found = match bytes {
            Ok(bytes) => {
                let engine = app.state::<engine::EngineState>();
                let whole = engine::faces(app, &engine, bytes.clone(), it.kind.as_deref(), None, false);
                let mut marked = Vec::new();
                // A drawn face the reader marked can't be looked at again without the character finder:
                // the picture stays as it is (its faces and who they are) until the finder is there.
                let mut unmarkable = false;
                for (kind, area) in marks {
                    let kind = if kind == faceindex::Kind::Drawn { "drawn" } else { "photo" };
                    match engine::faces(app, &engine, bytes.clone(), Some(kind), Some(area), kind == "drawn") {
                        Ok(f) => marked.extend(f.faces.into_iter().map(|face| (face, area))),
                        Err(e) if e == "not downloaded: characters" => unmarkable = true,
                        Err(_) => {}
                    }
                }
                if unmarkable {
                    continue;
                }
                whole.map(|w| (w.faces, marked, w.characters))
            }
            Err(e) => Err(e),
        };
        let (faces, marked, characters) = match found {
            Ok(f) => f,
            // Without the models, or the engine, nothing further can be looked at.
            Err(e) if e.starts_with("not downloaded") || e.contains("engine") => {
                result = Err(e);
                break;
            }
            // A picture that can't be read counts as looked at, with no faces: not tried again until it changes.
            Err(_) => (Vec::new(), Vec::new(), true),
        };
        // A face the whole look found where one was marked is that one, kept as marked.
        let faces: Vec<engine::FoundFace> = faces.into_iter().filter(|f| !marked.iter().any(|(m, _)| m.kind == f.kind && faceindex::overlap(&m.bbox, &f.bbox) >= 0.5)).collect();
        found_all += faces.len() + marked.len();
        let kept: Vec<faceindex::Found> = faces.into_iter().map(|f| (f, None)).chain(marked.into_iter().map(|(f, a)| (f, Some(a)))).filter_map(|(f, area)| kept_face(f, area, None)).collect();
        with_faces(vs, &rootp, true, |ix| {
            ix.put(&it.key, tagindex::Stamp { s: it.size, m: it.modified }, kept);
            if !characters && it.kind.as_deref() != Some("photo") {
                ix.without_characters(&it.key);
            }
        })?;
        let _ = save_faces(vs, false);
    }
    save_faces(vs, true)?;
    let _ = on_progress.send(FaceProgress { done: total, total, current: String::new(), faces: found_all });
    result.map(|_| found_all)
}

/// A face the engine found, as the face index keeps it (`marked`: in the part the reader marked;
/// `at`: the second of the video frame it was seen in).
fn kept_face(f: engine::FoundFace, marked: Option<[f32; 4]>, at: Option<f32>) -> Option<faceindex::Found> {
    let kind = match f.kind.as_str() {
        "photo" => faceindex::Kind::Photo,
        "drawn" => faceindex::Kind::Drawn,
        _ => return None,
    };
    Some(faceindex::Found { kind, bbox: f.bbox, score: f.score, size: f.size, embedding: f.embedding, marked, at })
}

/// The faces in a video: a few frames spread over it (one every eight seconds or so, three at
/// least, twenty-four at most) looked at as pictures, each face kept with the moment of its frame.
/// The same face frame after frame is kept once, at its surest moment, so a clip of one person
/// gives one face, not twenty. Also whether the character finder looked (see `FacesFound`).
fn video_faces(app: &tauri::AppHandle, vs: &VaultLock, rootp: &Path, it: &FaceItem) -> Result<(Vec<faceindex::Found>, bool), String> {
    let path = PathBuf::from(&it.path);
    // ffmpeg reads the file, or the vault's video as it asks for it (`video_input`).
    let input = video_input(vs, rootp, &path)?;
    let duration = probe_duration(&input.arg).unwrap_or(60.0);
    let count = ((duration / 8.0).ceil() as usize).clamp(3, 24);
    let frames = video_frames_timed(&input.arg, count)?;
    let engine = app.state::<engine::EngineState>();
    let mut kept: Vec<faceindex::Found> = Vec::new();
    let mut characters = true;
    for (at, png) in frames {
        let found = engine::faces(app, &engine, png, it.kind.as_deref(), None, false)?;
        characters &= found.characters;
        for f in found.faces {
            let Some(f) = kept_face(f, None, Some(at as f32)) else { continue };
            match kept.iter_mut().find(|k| k.kind == f.kind && cosine(&k.embedding, &f.embedding) >= f.kind.same()) {
                Some(same) => {
                    if f.score > same.score {
                        *same = f;
                    }
                }
                None => kept.push(f),
            }
        }
    }
    Ok((kept, characters))
}

/// How alike two faces' numbers are, 1 the same.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na * nb) }
}

/// Faces looked for in the part of a picture the reader marked (`area`: fractions of the upright
/// picture), kept beside its others: in a drawing (`kind` "drawn"), the part is taken as the face when
/// none is found there. The faces found, as the app shows them; none when there was no face to find.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn faces_mark(app: tauri::AppHandle, vs: VS<'_>, root: String, key: String, path: String, raw: bool, kind: Option<String>, area: [f32; 4]) -> Result<Vec<faceindex::FaceView>, String> {
    let rootp = PathBuf::from(&root);
    let [l, t, r, b] = area;
    if !(0.0..=1.0).contains(&l) || !(0.0..=1.0).contains(&t) || r <= l || b <= t || r > 1.0 || b > 1.0 {
        return Err("mark the face with a box inside the picture".into());
    }
    let vs = vs.share();
    blocking(move || {
        let p = PathBuf::from(&path);
        let bytes = with_ctx_read(&vs, &rootp, |ctx| ctx.read_all(&p)).and_then(|b| if raw { preview::embedded_jpeg_bytes(&b) } else { Ok(b) })?;
        let whole = kind.as_deref() == Some("drawn");
        let found = engine::faces(&app, &app.state::<engine::EngineState>(), bytes, kind.as_deref(), Some(area), whole)?;
        let kept: Vec<faceindex::Found> = found.faces.into_iter().filter_map(|f| kept_face(f, Some(area), None)).collect();
        if kept.is_empty() {
            return Ok(Vec::new());
        }
        let ids = with_faces(&vs, &rootp, true, |ix| ix.add(&key, kept))?;
        save_faces(&vs, true)?;
        with_faces(&vs, &rootp, false, |ix| ix.views().into_iter().filter(|v| ids.contains(&v.id)).collect())
    })
    .await
}

/// Faces no one has named, sorted: those close enough to a person named already, and the rest in groups alike.
#[tauri::command]
async fn faces_sort(vs: VS<'_>, root: String, labels: faceindex::Labels) -> Result<faceindex::Sorted, String> {
    let vs = vs.share();
    // Reading the index, then a dot product per pair, many thousands of them: off the threads that
    // answer the window.
    blocking(move || {
        let rootp = PathBuf::from(&root);
        with_faces(&vs, &rootp, false, |_| ())?;
        let g = faces_lock();
        let x = g.as_ref().filter(|x| x.root == rootp).ok_or("the face index changed libraries")?;
        Ok(x.ix.sort(&labels))
    })
    .await
}

/// Pictures moved (in the app or found moved): their faces go with them.
#[tauri::command]
async fn faces_rename(vs: VS<'_>, root: String, pairs: Vec<(String, String)>) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let rootp = PathBuf::from(&root);
        if with_faces(&vs, &rootp, false, |ix| ix.rename(&pairs))? {
            with_faces(&vs, &rootp, true, |_| ())?;
            save_faces(&vs, true)?;
        }
        Ok(())
    })
    .await
}

/// Pictures gone for good (the trash emptied): their faces go too.
#[tauri::command]
async fn faces_forget(vs: VS<'_>, root: String, prefix: String) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let rootp = PathBuf::from(&root);
        if with_faces(&vs, &rootp, false, |ix| ix.forget(|k| k.starts_with(&prefix)))? {
            with_faces(&vs, &rootp, true, |_| ())?;
            save_faces(&vs, true)?;
        }
        Ok(())
    })
    .await
}

/// People: who they are, which faces are whose, and which aren't, kept with the library.
#[tauri::command]
async fn people_load(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "people").await
}
#[tauri::command]
async fn people_save(vs: VS<'_>, root: String, data: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "people", data).await
}

/// What each screen was left showing in the library (filters, folded types, the duplicate check's
/// scope): kept with it, in its vault when it has one.
#[tauri::command]
async fn views_load(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "views").await
}
#[tauri::command]
async fn views_save(vs: VS<'_>, root: String, data: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "views", data).await
}

/// The library's Home: its board of blocks, which folders it shows, what the library opens on.
#[tauri::command]
async fn home_load(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "home").await
}
#[tauri::command]
async fn home_save(vs: VS<'_>, root: String, data: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "home", data).await
}

/// The library's artists: who they are, their links to platforms, and the pictures given them.
#[tauri::command]
async fn artists_load(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    load_doc(&vs, root, "artists").await
}
#[tauri::command]
async fn artists_save(vs: VS<'_>, root: String, data: serde_json::Value) -> Result<(), String> {
    save_doc(&vs, root, "artists", data).await
}

/// An artist's icon from the platform they're linked to, kept with the library (in its vault when it
/// has one) as a JPEG of at most 512 px, named `artist-<id>.jpg`: read back like the Scrapbook's files.
#[tauri::command]
async fn artist_avatar_save(app: tauri::AppHandle, vs: VS<'_>, id: String, root: String, name: String, url: String, headers: std::collections::BTreeMap<String, String>) -> Result<(), String> {
    let name = blob_name(&name)?.to_string();
    if !name.starts_with("artist-") || !name.ends_with(".jpg") {
        return Err(format!("not an artist's icon: {name}"));
    }
    let reg = registry(&app)?;
    require(&reg, &id, "find")?;
    let granted = reg.effective_permissions(&id);
    let vs = vs.share();
    blocking(move || {
        let bytes = plugins::find_image(&granted, &url, &headers)?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("the icon isn't a picture: {e}"))?;
        let img = if img.width().max(img.height()) > 512 { img.thumbnail(512, 512) } else { img };
        let mut out = std::io::Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&img.to_rgb8()).map_err(|e| e.to_string())?;
        let jpeg = out.into_inner();
        with_ctx(&vs, Path::new(&root), |ctx| ctx.save_blob(&name, &jpeg))
    })
    .await
}

/// A platform's image hashed as the duplicate check hashes the library's pictures, to find it there.
#[tauri::command]
async fn find_image_hash(app: tauri::AppHandle, id: String, url: String, headers: std::collections::BTreeMap<String, String>) -> Result<dupes::ImageHash, String> {
    let reg = registry(&app)?;
    require(&reg, &id, "find")?;
    let granted = reg.effective_permissions(&id);
    blocking(move || dupes::image_hash_bytes(&plugins::find_image(&granted, &url, &headers)?, false)).await
}

/// Close a plugin's sign-in window (signing in another way, or not now).
#[tauri::command]
fn plugin_login_close(app: tauri::AppHandle, id: String) {
    if let Some(w) = app.get_webview_window(&format!("login-{id}")) {
        let _ = w.destroy();
    }
}

/// An image for Find (a result's thumbnail, a page in the preview), fetched with the headers the
/// platform's plugin gives, from hosts it was granted.
#[tauri::command]
async fn find_image(app: tauri::AppHandle, id: String, url: String, headers: std::collections::BTreeMap<String, String>) -> Result<Response, String> {
    let reg = registry(&app)?;
    require(&reg, &id, "find")?;
    let granted = reg.effective_permissions(&id);
    Ok(Response::new(blocking(move || plugins::find_image(&granted, &url, &headers)).await?))
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindFile {
    url: String,
    name: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindFrame {
    file: String,
    delay: u32,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindAnimation {
    zip: String,
    name: String,
    frames: Vec<FindFrame>,
}

/// A pick to download: its files, or an animation's frames (made into an MP4).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindWork {
    key: String,
    #[serde(default)]
    files: Vec<FindFile>,
    #[serde(default)]
    animation: Option<FindAnimation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FindFetched {
    key: String,
    files: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FindProgress {
    done: usize,
    total: usize,
    bytes: u64,
    current: String,
}

/// A name a platform gave, safe as a file name here: no folders, no leading dot, not too long.
fn safe_file_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let clean = clean.trim().trim_start_matches('.').chars().take(120).collect::<String>();
    if clean.is_empty() { "file".into() } else { clean }
}

/// Where Find's downloads wait for Import: in this computer's cache, emptied after each pull.
fn find_staging(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("find"))
}

/// Download picks from a platform, as an Activity job (paused and stopped there), into a folder each
/// in this computer's cache, for Import to bring in. What one couldn't get is said with it.
#[tauri::command]
async fn find_download(app: tauri::AppHandle, id: String, works: Vec<FindWork>, headers: std::collections::BTreeMap<String, String>, job: Option<String>, on_progress: tauri::ipc::Channel<FindProgress>) -> Result<Vec<FindFetched>, String> {
    let reg = registry(&app)?;
    require(&reg, &id, "find")?;
    let granted = reg.effective_permissions(&id);
    let base = find_staging(&app)?.join(format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
    blocking(move || {
        let (_job, ctl) = control(job.as_deref());
        let total: usize = works.iter().map(|w| w.files.len() + usize::from(w.animation.is_some())).sum();
        let (mut done, mut bytes) = (0usize, 0u64);
        let mut out = Vec::with_capacity(works.len());
        for (n, work) in works.iter().enumerate() {
            if !ctl.go_on() {
                break;
            }
            let dir = base.join(n.to_string());
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let mut files = Vec::new();
            let mut error = None;
            for f in &work.files {
                let _ = on_progress.send(FindProgress { done, total, bytes, current: f.name.clone() });
                let dest = dir.join(safe_file_name(&f.name));
                let at = bytes;
                match plugins::download_to(&granted, &f.url, &headers, &dest, |got| {
                    let _ = on_progress.send(FindProgress { done, total, bytes: at + got, current: f.name.clone() });
                    ctl.go_on()
                }) {
                    Ok(got) => {
                        bytes += got;
                        files.push(dest.to_string_lossy().into_owned());
                    }
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                }
                done += 1;
            }
            if let (Some(anim), None) = (&work.animation, &error) {
                let _ = on_progress.send(FindProgress { done, total, bytes, current: anim.name.clone() });
                match find_animation(&granted, &headers, anim, &dir, &ctl) {
                    Ok((path, got)) => {
                        bytes += got;
                        files.push(path.to_string_lossy().into_owned());
                    }
                    Err(e) => error = Some(e),
                }
                done += 1;
            }
            if error.as_deref() == Some("stopped") {
                break;
            }
            out.push(FindFetched { key: work.key.clone(), files, error });
        }
        let _ = on_progress.send(FindProgress { done: total, total, bytes, current: String::new() });
        Ok(out)
    })
    .await
}

/// An animation: its frames' zip downloaded and unpacked, then played at their timings into an MP4.
fn find_animation(granted: &[String], headers: &std::collections::BTreeMap<String, String>, anim: &FindAnimation, dir: &Path, ctl: &std::sync::Arc<jobctl::Control>) -> Result<(PathBuf, u64), String> {
    let frames_dir = dir.join("frames");
    std::fs::create_dir_all(&frames_dir).map_err(|e| e.to_string())?;
    let zip_path = dir.join("frames.zip");
    let got = plugins::download_to(granted, &anim.zip, headers, &zip_path, |_| ctl.go_on())?;
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&zip_path).map_err(|e| e.to_string())?).map_err(|e| format!("the frames didn't unpack: {e}"))?;
    // A frame not there by its name is taken by its place among the zip's pictures (a platform that
    // keeps the frames but not their names gives them by number).
    let mut pictures: Vec<String> = zip.file_names().filter_map(|n| n.ok()).filter(|n| !n.ends_with('/') && media::classify(Path::new(n.as_ref())) == Some(media::MediaKind::Image)).map(|n| n.into_owned()).collect();
    pictures.sort();
    let mut frames = Vec::with_capacity(anim.frames.len());
    for (i, f) in anim.frames.iter().enumerate() {
        let name = safe_file_name(&f.file);
        let at = if zip.index_for_name(&f.file).is_some() { f.file.clone() } else { pictures.get(i).cloned().ok_or_else(|| format!("frame {} is missing from the zip", f.file))? };
        let mut entry = zip.by_name(&at).map_err(|_| format!("frame {} is missing from the zip", f.file))?;
        let mut file = std::fs::File::create(frames_dir.join(&name)).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
        frames.push((name, f.delay));
    }
    let out = dir.join(safe_file_name(&anim.name));
    edit::frames_to_mp4(&frames_dir, &frames, &out, ctl)?;
    let _ = std::fs::remove_dir_all(&frames_dir);
    let _ = std::fs::remove_file(&zip_path);
    Ok((out, got))
}

/// Find's downloads, once Import has them (or they aren't wanted): gone from this computer.
#[tauri::command]
async fn find_clear(app: tauri::AppHandle) -> Result<(), String> {
    let dir = find_staging(&app)?;
    blocking(move || match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    })
    .await
}

/// A plugin's own pipeline (`engine` in its plugin.json: a WebAssembly module in its folder) on a
/// picture, on this computer, with the models it declares. Only for plugins granted `engine`.
#[tauri::command]
async fn plugin_engine_run(app: tauri::AppHandle, vs: VS<'_>, id: String, root: String, path: String, options: serde_json::Value) -> Result<engine::Ran, String> {
    let reg = registry(&app)?;
    if !reg.effective_permissions(&id).iter().any(|p| p == "engine") {
        return Err("permission \"engine\" was not granted".into());
    }
    let (module, models, own) = reg.engine_of(&id)?;
    let vs = vs.share();
    blocking(move || {
        let p = PathBuf::from(&path);
        let mut bytes = with_ctx_read(&vs, Path::new(&root), |ctx| ctx.read_all(&p))?;
        if media::classify(&p) == Some(media::MediaKind::Raw) {
            bytes = preview::embedded_jpeg_bytes(&bytes)?;
        }
        let state = app.state::<engine::EngineState>();
        engine::run(&app, &state, &id, &module, &models, &own, bytes, options)
    })
    .await
}

/// This computer, as far as choosing a language model goes: its memory, its chip, and whether the
/// graphics share that memory (Apple silicon), so a model's need can be weighed against it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Hardware {
    /// Bytes of memory in all.
    memory: u64,
    /// "Apple M1 Pro", "AMD Ryzen 7 7800X3D"…
    chip: String,
    os: &'static str,
    arch: &'static str,
    /// The graphics use the same memory (Apple silicon): no separate graphics memory to know.
    unified: bool,
}

#[tauri::command]
async fn hardware() -> Result<Hardware, String> {
    blocking(|| {
        use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
        let sys = System::new_with_specifics(RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()).with_cpu(CpuRefreshKind::nothing()));
        Ok(Hardware {
            memory: sys.total_memory(),
            chip: sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default(),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            unified: cfg!(all(target_os = "macos", target_arch = "aarch64")),
        })
    })
    .await
}

#[cfg(test)]
mod hardware_tests {
    #[test]
    fn knows_this_computers_memory_and_chip() {
        let h = tauri::async_runtime::block_on(super::hardware()).unwrap();
        assert!(h.memory > 1 << 30, "{} bytes", h.memory);
        assert!(!h.chip.is_empty());
        println!("{} · {} GB · {} {} · unified {}", h.chip, h.memory >> 30, h.os, h.arch, h.unified);
    }
}

/// The engine's models: what can be downloaded, what is, and which language model is chosen.
#[tauri::command]
async fn engine_models(app: tauri::AppHandle) -> Result<engine::Catalog, String> {
    blocking(move || engine::catalog(&app, &app.state::<engine::EngineState>())).await
}

#[tauri::command]
async fn engine_store_get(app: tauri::AppHandle) -> Result<engine::StoreInfo, String> {
    // Disk work: on a blocking thread, not the main thread that draws the window.
    blocking(move || {
        engine::store_info(&app)
    })
    .await
}

#[tauri::command]
async fn engine_store_set(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    blocking(move || engine::set_store(&app, &app.state::<engine::EngineState>(), path)).await
}

#[tauri::command]
async fn engine_choose(app: tauri::AppHandle, llm: String) -> Result<(), String> {
    blocking(move || engine::choose(&app, &app.state::<engine::EngineState>(), &llm)).await
}

/// Download a model (and the shared parts, the first time). Resolves when it is done; fails when cancelled.
#[tauri::command]
async fn engine_download(app: tauri::AppHandle, id: String, job: Option<String>, on_progress: tauri::ipc::Channel<engine::DownloadProgress>) -> Result<(), String> {
    blocking(move || {
        let (_job, ctl) = control(job.as_deref());
        engine::download(&app, &app.state::<engine::EngineState>(), &id, ctl, |p| {
            let _ = on_progress.send(p);
        })
    })
    .await
}

#[tauri::command]
async fn engine_cancel_download(app: tauri::AppHandle) -> Result<(), String> {
    blocking(move || engine::cancel_download(&app, &app.state::<engine::EngineState>())).await
}

#[tauri::command]
async fn engine_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    blocking(move || engine::remove(&app, &app.state::<engine::EngineState>(), &id)).await
}

#[tauri::command]
fn plugin_log(id: String, level: String, message: String) {
    if std::env::var_os("QUIRE_DEBUG").is_some() {
        eprintln!("[plugin:{id}] {level}: {message}");
    }
}

/// Displayable image bytes for an item: the file itself, or a RAW's embedded preview.
#[tauri::command]
async fn read_media_image(vs: VS<'_>, root: String, path: String) -> Result<Response, String> {
    let vs = vs.share();
    blocking(move || {
        if let Some((pdf, page)) = pdf::split_page(&path) {
            let bytes = with_ctx_read(&vs, Path::new(&root), |ctx| ctx.read_all(&pdf))?;
            return pdf::render_jpeg(bytes, page, 2400).map(Response::new);
        }
        let p = PathBuf::from(&path);
        let bytes = with_ctx_read(&vs, Path::new(&root), |ctx| ctx.read_all(&p))?;
        if media::classify(&p) == Some(media::MediaKind::Raw) {
            return preview::embedded_jpeg_bytes(&bytes).map(Response::new);
        }
        Ok(Response::new(bytes))
    })
    .await
}

/// Save a new file into `dir` (collision-safe). Encrypted when a vault is open. Made `from` a
/// picture (a plugin's result, by plugin `by`): linked to it as a version, called `note`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn write_media_file(vs: VS<'_>, root: String, dir: String, name: String, data_base64: String, from: Option<String>, by: Option<String>, note: Option<String>) -> Result<String, String> {
    use base64::Engine;
    let root = PathBuf::from(root);
    let name = name.trim().to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err("invalid file name".into());
    }
    let vs = vs.share();
    blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes()).map_err(|e| format!("bad data: {e}"))?;
        let dir = resolve(&root, &dir);
        if !dir.starts_with(&root) {
            return Err("plugins may only write inside the opened folder".into());
        }
        with_ctx(&vs, &root, |ctx| {
            let mut target = dir.join(&name);
            let mut n = 1;
            while target.exists() || ctx.vault_id(&target).is_some() {
                target = dir.join(ops::with_suffix(Path::new(&name), n));
                n += 1;
            }
            match ctx.vault.as_deref_mut() {
                Some(v) => {
                    let tmp = std::env::temp_dir().join(format!("ms-plugin-write-{}", std::process::id()));
                    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
                    let r = v.add_file(&tmp, &media::rel_key(&root, &target));
                    let _ = std::fs::remove_file(&tmp);
                    r?;
                }
                None => {
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
                }
            }
            if let Some(from) = from.as_deref().map(Path::new)
                && let Err(e) = ctx.fingerprint(from).and_then(|fp| versions::note_made(ctx, &target, &fp, from, by.as_deref().unwrap_or("plugin"), &version_note(note.as_deref())))
            {
                eprintln!("[versions] {}: {e}", target.display());
            }
            Ok(target.to_string_lossy().into_owned())
        })
    })
    .await
}

/// What a plugin calls its versions ("cleaned", say): a short word or two, "edited" when it says nothing.
fn version_note(note: Option<&str>) -> String {
    let n: String = note.unwrap_or("").trim().chars().filter(|c| !c.is_control()).take(24).collect();
    if n.is_empty() { "edited".into() } else { n }
}

/// A plugin's result in place of an item (the reader chose Overwrite): the item's files are kept
/// for Revert (see versions.rs) and the new file takes their place, linked to them as a version.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn replace_media_file(vs: VS<'_>, root: String, library: Library, item: MediaItem, name: String, data_base64: String, by: Option<String>, note: Option<String>) -> Result<EditResult, String> {
    use base64::Engine;
    let root = PathBuf::from(root);
    let trash = library.trash_path(&root);
    let name = name.trim().to_string();
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err("invalid file name".into());
    }
    let vs = vs.share();
    blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes()).map_err(|e| format!("bad data: {e}"))?;
        let primary = PathBuf::from(&item.primary);
        let dir = primary.parent().ok_or("no folder")?.to_path_buf();
        if !dir.starts_with(&root) {
            return Err("plugins may only write inside the opened folder".into());
        }
        let files: Vec<PathBuf> = item.files.iter().map(PathBuf::from).collect();
        let (trashed, new_item) = with_ctx(&vs, &root, |ctx| {
            let from = ctx.fingerprint(&primary).ok();
            let away = from.as_deref().map(|fp| versions::put_away_to(ctx, fp, &trash)).unwrap_or_else(|| trash.clone());
            // The result is written beside the picture first, under a name of its own; only once it is
            // whole is the original put away and the result given its place. A write that fails (the
            // drive full) leaves the original where it was, and a move that fails brings it back: the
            // picture is never out of sight with nothing in its place. Its name is picked once the
            // original is put away: the original's own place is free then.
            let free_name = |ctx: &fsx::Ctx| {
                let mut target = dir.join(&name);
                let mut n = 1;
                while target.exists() || ctx.vault_id(&target).is_some() {
                    target = dir.join(ops::with_suffix(Path::new(&name), n));
                    n += 1;
                }
                target
            };
            let staged = dir.join(format!(".{}.{}.part", name, std::process::id()));
            let written = match ctx.vault.as_deref_mut() {
                Some(v) => {
                    let tmp = std::env::temp_dir().join(format!("ms-plugin-replace-{}", std::process::id()));
                    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
                    let r = v.add_file(&tmp, &media::rel_key(&root, &staged));
                    let _ = std::fs::remove_file(&tmp);
                    r.map(|_| ())
                }
                None => std::fs::write(&staged, &bytes).map_err(|e| e.to_string()),
            };
            if let Err(e) = written {
                let _ = ctx.remove(&staged);
                return Err(e);
            }
            let moved = match ctx.move_group(&files, &away) {
                Ok(m) => m,
                Err(e) => {
                    let _ = ctx.remove(&staged);
                    return Err(e);
                }
            };
            let target = free_name(ctx);
            if let Err(e) = ctx.move_one(&staged, &target) {
                // The original back where it was; the result goes, as it was never in place.
                for (src, dst) in files.iter().zip(moved.iter()) {
                    let _ = ctx.move_one(dst, src);
                }
                let _ = ctx.remove(&staged);
                return Err(e);
            }
            let trashed: Vec<(PathBuf, PathBuf)> = files.iter().cloned().zip(moved).collect();
            if let Some(fp) = &from
                && let Err(e) = versions::note_made(ctx, &target, fp, &primary, by.as_deref().unwrap_or("plugin"), &version_note(note.as_deref()))
            {
                eprintln!("[versions] {}: {e}", target.display());
            }
            let items = ctx.scan(&dir, &[]);
            let it = items.into_iter().find(|i| Path::new(&i.primary) == target || i.files.iter().any(|f| Path::new(f) == target)).ok_or("the new file was not found after writing it")?;
            Ok::<_, String>((trashed, it))
        })?;
        let mut new_item = new_item;
        new_item.target_id = item.target_id.clone();
        new_item.album_key = item.album_key.clone();
        Ok(EditResult { item: new_item, trashed: trashed.iter().map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned())).collect() })
    })
    .await
}

/* ---------------- versions ---------------- */

/// Every version's link: what each was made from (for the duplicate check and Import).
#[tauri::command]
async fn versions_load(vs: VS<'_>, root: String) -> Result<versions::Versions, String> {
    let vs = vs.share();
    blocking(move || with_ctx_read(&vs, Path::new(&root), versions::load)).await
}

/// What a picture was made from, whether that is kept for Revert, and what was made from it.
#[tauri::command]
async fn version_info(vs: VS<'_>, root: String, path: String) -> Result<versions::Info, String> {
    let vs = vs.share();
    blocking(move || with_ctx_read(&vs, Path::new(&root), |ctx| versions::info(ctx, Path::new(&path)))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reverted {
    item: MediaItem,
    /// (where it was, where it is now) for every file moved, in the order Undo moves them back.
    moves: Vec<(String, String)>,
}

/// A version replaced by the original kept for it: the version to the trash, the original back.
#[tauri::command]
async fn version_revert(vs: VS<'_>, root: String, library: Library, item: MediaItem) -> Result<Reverted, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let trash = library.trash_path(&root);
        let primary = PathBuf::from(&item.primary);
        let files: Vec<PathBuf> = item.files.iter().map(PathBuf::from).collect();
        with_ctx(&vs, &root, |ctx| {
            let r = versions::revert(ctx, &primary, &files, &trash)?;
            let dir = primary.parent().unwrap_or(&root).to_path_buf();
            let it = ctx.scan(&dir, &[]).into_iter().find(|i| i.files.iter().any(|f| r.restored.iter().any(|p| Path::new(f) == p))).ok_or("the original was not found after putting it back")?;
            let moves = r.moves.iter().map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned())).collect();
            Ok(Reverted { item: MediaItem { target_id: item.target_id.clone(), album_key: item.album_key.clone(), ..it }, moves })
        })
    })
    .await
}

/// How many originals are kept for Revert, and their size.
#[tauri::command]
async fn kept_originals(vs: VS<'_>, root: String) -> Result<versions::Kept, String> {
    let vs = vs.share();
    blocking(move || with_ctx_read(&vs, Path::new(&root), |ctx| Ok(versions::kept(ctx)))).await
}

/// Every kept original deleted for good; the versions still say what they were made from.
#[tauri::command]
async fn kept_originals_forget(vs: VS<'_>, root: String) -> Result<usize, String> {
    let vs = vs.share();
    blocking(move || with_ctx(&vs, Path::new(&root), versions::forget_kept)).await
}

/* ---------------- info ---------------- */

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExifInfo {
    date_taken: Option<String>,
    make: Option<String>,
    model: Option<String>,
    lens: Option<String>,
    exposure: Option<String>,
    f_number: Option<String>,
    iso: Option<String>,
    focal: Option<String>,
    software: Option<String>,
    gps: Option<String>,
    orientation: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaInfo {
    width: Option<u32>,
    height: Option<u32>,
    format: Option<String>,
    exif: Option<ExifInfo>,
}

/// What the file itself says: its pixels and format, and what the camera wrote into it.
#[tauri::command]
async fn media_info(vs: VS<'_>, root: String, path: String) -> Result<MediaInfo, String> {
    let p = PathBuf::from(&path);
    let kind = media::classify(&p);
    // Nothing here reads a video (no pixel size from it, and the EXIF reader doesn't do video
    // containers), so a video of gigabytes is not read into memory just to answer that.
    if kind == Some(media::MediaKind::Video) {
        return Ok(MediaInfo { width: None, height: None, format: None, exif: None });
    }
    let vs = vs.share();
    blocking(move || {
        let bytes = with_ctx_read(&vs, Path::new(&root), |ctx| ctx.read_all(&p))?;
        let (mut width, mut height, mut format) = (None, None, None);
        {
            let raw_jpeg;
            let probe: &[u8] = if kind == Some(media::MediaKind::Raw) {
                raw_jpeg = preview::embedded_jpeg_bytes(&bytes).unwrap_or_default();
                &raw_jpeg
            } else {
                &bytes
            };
            if let Ok(reader) = image::ImageReader::new(std::io::Cursor::new(probe)).with_guessed_format() {
                format = reader.format().map(|f| format!("{f:?}").to_uppercase());
                if let Ok((w, h)) = reader.into_dimensions() {
                    width = Some(w);
                    height = Some(h);
                }
            }
            if kind == Some(media::MediaKind::Raw) {
                format = Some(p.extension().map(|e| e.to_string_lossy().to_uppercase()).unwrap_or_else(|| "RAW".into()));
            }
        }
        let exif = exif_of(&bytes);
        Ok(MediaInfo { width, height, format, exif })
    })
    .await
}

fn exif_of(bytes: &[u8]) -> Option<ExifInfo> {
    use exif::{In, Tag};
    let reader = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes)).ok()?;
    let text = |tag: Tag| reader.get_field(tag, In::PRIMARY).map(|f| f.display_value().with_unit(&reader).to_string().trim_matches('"').to_string()).filter(|s| !s.is_empty());
    let gps = match (reader.get_field(Tag::GPSLatitude, In::PRIMARY), reader.get_field(Tag::GPSLongitude, In::PRIMARY)) {
        (Some(lat), Some(lon)) => {
            let r = |f: &exif::Field, tag: Tag| f.display_value().to_string() + " " + &text(tag).unwrap_or_default();
            Some(format!("{}, {}", r(lat, Tag::GPSLatitudeRef), r(lon, Tag::GPSLongitudeRef)))
        }
        _ => None,
    };
    Some(ExifInfo {
        date_taken: text(Tag::DateTimeOriginal).or_else(|| text(Tag::DateTime)),
        make: text(Tag::Make),
        model: text(Tag::Model),
        lens: text(Tag::LensModel),
        exposure: text(Tag::ExposureTime),
        f_number: text(Tag::FNumber),
        iso: text(Tag::PhotographicSensitivity),
        focal: text(Tag::FocalLength),
        software: text(Tag::Software),
        gps,
        orientation: text(Tag::Orientation),
    })
}

/* ---------------- tags ---------------- */

/// Set while an indexing job should stop at the next item, or hold before it; and while one runs.
#[derive(Default)]
pub struct IndexState(std::sync::atomic::AtomicBool, std::sync::atomic::AtomicBool, std::sync::atomic::AtomicBool);

/// Clears "a run is going" however the run ends.
struct Running<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[derive(Clone, Serialize)]
struct IndexProgress {
    done: usize,
    total: usize,
    current: String,
    /// The item being indexed, for a preview.
    key: Option<String>,
}

#[derive(Clone, Serialize)]
struct IndexedItem {
    key: String,
    embedding: Option<Vec<f32>>,
    tags: Option<Vec<(usize, f32)>>,
    error: Option<String>,
}

/// Tags and what the models know of each item: with the library, inside the vault when there is one.
#[tauri::command]
async fn load_tags(vs: VS<'_>, root: String) -> Result<serde_json::Value, String> {
    let vs = vs.share();
    blocking(move || {
        // An older tags file still carrying the model maps is split first.
        ensure_tag_index(&vs, Path::new(&root))?;
        load_json(&vs, &root, "tags")
    })
    .await
}

#[tauri::command]
async fn save_tags(vs: VS<'_>, root: String, mut data: serde_json::Value) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        // The model maps live in the tag index; never back in here.
        let _ = tagindex::split_old(&mut data);
        save_json(&vs, &root, "tags", &data)?;
        TAGS_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    })
    .await
}

/* ---------------- tag index: what the models know, similarity and learning ---------------- */

/// The tag index of the opened folder, in memory while it is open.
static TAG_INDEX: Mutex<Option<tagindex::Index>> = Mutex::new(None);
static TAG_INDEX_LOADING: Mutex<()> = Mutex::new(());

fn tag_index_lock() -> std::sync::MutexGuard<'static, Option<tagindex::Index>> {
    TAG_INDEX.lock().unwrap_or_else(|p| p.into_inner())
}

/// The two files of the index: its JSON half, and its vectors.
const INDEX_FILES: (&str, &str) = ("tagindex", "tagvectors");
/// What earlier versions kept while they remade the index with newer models, and the one it replaced:
/// made with models the app doesn't have any more, so of no use. Gone as the index loads.
const EARLIER_INDEX_FILES: [&str; 4] = ["tagindex-next", "tagvectors-next", "tagindex-old", "tagvectors-old"];

/// The index's journal number `seq` (see `tagindex::Change`): changes since its last full save.
fn journal_name(seq: u64) -> String {
    format!("tagjournal.{seq}")
}

/// Journals after `from` that may hold changes: they run on with no gaps but quiet stretches.
const JOURNAL_LOOKAHEAD: u64 = 16;

/// The index from its files, with what its journals hold since they were saved made again.
fn read_index(ctx: &fsx::Ctx, root: &Path) -> Result<Option<tagindex::Index>, String> {
    let (json, vectors) = INDEX_FILES;
    let Some(text) = ctx.load_meta(json)? else { return Ok(None) };
    let f: tagindex::IndexFile = serde_json::from_str(&text).map_err(|e| format!("tag index: {e}"))?;
    let bytes = ctx.load_meta_bytes(vectors)?;
    let mut ix = tagindex::Index::from_files(root, f, bytes.as_deref());
    replay_journals(ctx, &mut ix)?;
    Ok(Some(ix))
}

fn replay_journals(ctx: &fsx::Ctx, ix: &mut tagindex::Index) -> Result<(), String> {
    let mut seq = ix.saved_journal;
    let mut quiet = 0;
    while quiet < JOURNAL_LOOKAHEAD {
        let records = ctx.load_meta_records(&journal_name(seq))?;
        if records.is_empty() {
            quiet += 1;
        } else {
            quiet = 0;
            for r in records {
                if let Ok(change) = serde_json::from_slice::<tagindex::Change>(&r) {
                    ix.apply(change);
                }
            }
            ix.journal = seq;
        }
        seq += 1;
    }
    Ok(())
}

/// Journals that a full save holds now: gone.
fn drop_journals(ctx: &fsx::Ctx, from: u64, to: u64) -> Result<(), String> {
    (from..to).try_for_each(|seq| ctx.remove_meta(&journal_name(seq)))
}

/// Write a change to the index's journal at once (a crash loses at most the picture it was on).
fn journal(vs: &VaultLock, root: &Path, seq: u64, change: &tagindex::Change) {
    let Ok(bytes) = serde_json::to_vec(change) else { return };
    let _ = with_ctx(vs, root, |ctx| ctx.append_meta_record(&journal_name(seq), &bytes));
}

fn write_index(ctx: &fsx::Ctx, ix: &tagindex::Index) -> Result<(), String> {
    let (json, vectors) = INDEX_FILES;
    let (file, bytes) = ix.to_files();
    // The vectors first: a JSON half never names models whose vectors aren't there.
    ctx.save_meta_bytes(vectors, &bytes)?;
    ctx.save_meta(json, &serde_json::to_string(&file).map_err(|e| e.to_string())?)
}

/// Load the folder's tag index if it isn't the one in memory (saving the one that was). An older
/// library kept the model maps in the tags file: they move to the index once, the new file written
/// before the tags file loses them, and the file as it was kept beside them. What an earlier version
/// left of a remade index goes (`EARLIER_INDEX_FILES`).
fn ensure_tag_index(vs: &VaultLock, root: &Path) -> Result<(), String> {
    let _one = TAG_INDEX_LOADING.lock().unwrap_or_else(|p| p.into_inner());
    if tag_index_lock().as_ref().is_some_and(|i| i.root == root) {
        return Ok(());
    }
    flush_tag_index(vs, true)?;
    let current = with_ctx(vs, root, |ctx| -> Result<tagindex::Index, String> {
        for name in EARLIER_INDEX_FILES {
            ctx.remove_meta(name)?;
        }
        if let Some(ix) = read_index(ctx, root)? {
            return Ok(ix);
        }
        let Some(text) = ctx.load_meta("tags")? else { return Ok(tagindex::Index::from_file(root, Default::default())) };
        let mut tags: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("tags: {e}"))?;
        let Some(f) = tagindex::split_old(&mut tags) else { return Ok(tagindex::Index::from_file(root, Default::default())) };
        let ix = tagindex::Index::from_file(root, f);
        ctx.save_meta("tags-before-split", &text)?;
        write_index(ctx, &ix)?;
        ctx.save_meta("tags", &serde_json::to_string(&tags).map_err(|e| e.to_string())?)?;
        Ok(ix)
    })?;
    *tag_index_lock() = Some(current);
    Ok(())
}

/// Run `f` on the folder's tag index.
fn with_tag_index<T>(vs: &VaultLock, root: &Path, f: impl FnOnce(&mut tagindex::Index) -> T) -> Result<T, String> {
    ensure_tag_index(vs, root)?;
    let mut g = tag_index_lock();
    let ix = g.as_mut().filter(|i| i.root == root).ok_or("the tag index changed folders")?;
    Ok(f(ix))
}

/// Save the tag index if it changed: now (`force`), or once it hasn't been saved for a while (the
/// longer, the bigger its vectors are: a long run doesn't rewrite a large file every few seconds).
/// The journals are written after every change, so a full save can wait longer as the vectors grow.
fn flush_tag_index(vs: &VaultLock, force: bool) -> Result<(), String> {
    {
        let (root, file, bytes, journals) = {
            let mut g = tag_index_lock();
            let Some(ix) = g.as_mut() else { return Ok(()) };
            let after = std::time::Duration::from_secs(60.max((ix.weight() / 1_000_000) as u64));
            let due = if force { ix.dirty() } else { ix.due(after) };
            if !due {
                return Ok(());
            }
            // Changes from now on go to a new journal; the full save holds the ones before.
            ix.journal += 1;
            let (file, bytes) = ix.to_files();
            ix.mark_saved();
            let journals = (ix.saved_journal, ix.journal);
            (ix.root.clone(), file, bytes, journals)
        };
        let (json, vectors) = INDEX_FILES;
        let saved = with_ctx(vs, &root, |ctx| {
            ctx.save_meta_bytes(vectors, &bytes)?;
            ctx.save_meta(json, &serde_json::to_string(&file).map_err(|e| e.to_string())?)?;
            drop_journals(ctx, journals.0, journals.1)
        });
        let mut g = tag_index_lock();
        if let Some(ix) = g.as_mut().filter(|i| i.root == root) {
            match saved {
                Ok(()) => ix.saved_journal = ix.saved_journal.max(journals.1),
                Err(_) => ix.mark_dirty(),
            }
        }
        saved?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagIndexView {
    auto: std::collections::HashMap<String, Vec<(u32, f32)>>,
    indexed: std::collections::HashMap<String, tagindex::Stamp>,
    embedded: usize,
    /// The models the index was made with: its picture-and-word matcher ("" while empty), and the
    /// anime tagger its words are from ("" when none has looked yet).
    embedder: String,
    tagger: String,
}

/// The tagger's words and what is indexed, for the frontend (the embeddings stay here).
#[tauri::command]
async fn tags_index_load(vs: VS<'_>, root: String) -> Result<TagIndexView, String> {
    let vs = vs.share();
    // The first call reads the index (its vectors run to hundreds of megabytes) from the library.
    blocking(move || {
        with_tag_index(&vs, Path::new(&root), |ix| TagIndexView { auto: ix.auto.clone(), indexed: ix.indexed.clone(), embedded: ix.len(), embedder: ix.embedder.clone(), tagger: ix.tagger.clone() })
    })
    .await
}

/// Files or folders that moved: version links follow them (see `versions::follow`).
#[tauri::command]
async fn versions_follow(vs: VS<'_>, root: String, pairs: Vec<(String, String)>) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || with_ctx(&vs, Path::new(&root), |ctx| versions::follow(ctx, &pairs).map(|_| ()))).await
}

/// Files gone for good (purged, deleted): the tag index forgets them.
#[tauri::command]
async fn tags_index_forget(vs: VS<'_>, root: String, keys: Vec<String>) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let changes: Vec<tagindex::Change> = keys.iter().map(|k| tagindex::Change::Forget { key: k.clone() }).collect();
        let forget = |ix: &mut tagindex::Index| {
            keys.iter().for_each(|k| ix.forget(k));
            ix.journal
        };
        let root = PathBuf::from(root);
        let seq = with_tag_index(&vs, &root, forget)?;
        changes.iter().for_each(|c| journal(&vs, &root, seq, c));
        flush_tag_index(&vs, false)
    })
    .await
}

#[tauri::command]
async fn tags_index_rename(vs: VS<'_>, root: String, pairs: Vec<(String, String)>) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let changes: Vec<tagindex::Change> = pairs.iter().map(|(from, to)| tagindex::Change::Rename { from: from.clone(), to: to.clone() }).collect();
        let rename = |ix: &mut tagindex::Index| {
            pairs.iter().for_each(|(a, b)| ix.rename(a, b));
            ix.journal
        };
        let root = PathBuf::from(root);
        let seq = with_tag_index(&vs, &root, rename)?;
        changes.iter().for_each(|c| journal(&vs, &root, seq, c));
        flush_tag_index(&vs, false)
    })
    .await
}

/// Files whose size or time changed but not their content (see `Index::restamp`).
#[tauri::command]
async fn tags_index_restamp(vs: VS<'_>, root: String, stamps: Vec<(String, u64, u64)>) -> Result<(), String> {
    let vs = vs.share();
    blocking(move || {
        let changes: Vec<tagindex::Change> = stamps.iter().map(|(k, s, m)| tagindex::Change::Restamp { key: k.clone(), stamp: tagindex::Stamp { s: *s, m: *m } }).collect();
        let stamp = |ix: &mut tagindex::Index| {
            stamps.iter().for_each(|(k, s, m)| ix.restamp(k, tagindex::Stamp { s: *s, m: *m }));
            ix.journal
        };
        let root = PathBuf::from(root);
        let seq = with_tag_index(&vs, &root, stamp)?;
        changes.iter().for_each(|c| journal(&vs, &root, seq, c));
        flush_tag_index(&vs, false)
    })
    .await
}

/// The items most like any of the queries, best first.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn tags_rank(vs: VS<'_>, root: String, queries: Vec<tagindex::Query>, candidates: Option<Vec<String>>, groups: tagindex::Groups, skip: Vec<String>, min: f32, limit: usize) -> Result<Vec<(String, f32)>, String> {
    let vs = vs.share();
    blocking(move || {
        let skip: std::collections::HashSet<String> = skip.into_iter().collect();
        with_tag_index(&vs, Path::new(&root), |ix| ix.rank(&queries, candidates.as_deref(), &groups, &skip, min, limit, false))
    })
    .await
}

/// Each item's likeness to each of some vectors (text prompts, say).
#[tauri::command]
async fn tags_scores(vs: VS<'_>, root: String, keys: Vec<String>, vectors: Vec<Vec<f32>>, groups: tagindex::Groups) -> Result<Vec<Option<Vec<f32>>>, String> {
    let vs = vs.share();
    blocking(move || with_tag_index(&vs, Path::new(&root), |ix| ix.scores(&keys, &vectors, &groups))).await
}

/// What the tags file says, as learning needs it: what carries each tag, what was turned down, and the
/// pages that stand for each album. Read again whenever the tags are saved.
#[derive(Default)]
struct TagsView {
    root: PathBuf,
    generation: u64,
    by_tag: std::collections::HashMap<String, Vec<String>>,
    denied: std::collections::HashMap<String, Vec<String>>,
    groups: tagindex::Groups,
    /// Bucket folders: their tags follow where a picture is, never suggested, never learned.
    places: std::collections::HashSet<String>,
}

/// Bumped on every save of the tags: the learning view is read again.
static TAGS_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static TAGS_VIEW: Mutex<Option<std::sync::Arc<TagsView>>> = Mutex::new(None);

fn tags_view(vs: &VaultLock, root: &Path) -> Result<std::sync::Arc<TagsView>, String> {
    let generation = TAGS_GENERATION.load(std::sync::atomic::Ordering::Relaxed);
    if let Some(v) = TAGS_VIEW.lock().unwrap_or_else(|p| p.into_inner()).as_ref().filter(|v| v.root == root && v.generation == generation) {
        return Ok(v.clone());
    }
    let data = load_json(vs, &root.to_string_lossy(), "tags")?;
    let mut view = TagsView { root: root.to_path_buf(), generation, ..Default::default() };
    if let Some(tags) = data["tags"].as_object() {
        for (key, list) in tags {
            for t in list.as_array().into_iter().flatten().filter_map(|t| t.as_str()) {
                let keys = view.by_tag.entry(t.to_string()).or_default();
                // An empty key holds tags made before anything carries them.
                if !key.is_empty() {
                    keys.push(key.clone());
                }
            }
        }
    }
    if let Some(denied) = data["denied"].as_object() {
        for (tag, keys) in denied {
            view.denied.insert(tag.clone(), keys.as_array().into_iter().flatten().filter_map(|k| k.as_str().map(String::from)).collect());
        }
    }
    view.places = data["places"].as_array().into_iter().flatten().filter_map(|p| p.as_str().map(String::from)).collect();
    if let Some(albums) = data["albums"].as_object() {
        for (album, pages) in albums {
            view.groups.insert(format!("album:{album}"), pages.as_array().into_iter().flatten().filter_map(|k| k.as_str().map(String::from)).collect());
        }
    }
    let view = std::sync::Arc::new(view);
    *TAGS_VIEW.lock().unwrap_or_else(|p| p.into_inner()) = Some(view.clone());
    Ok(view)
}

fn learned() -> std::sync::MutexGuard<'static, learn::Cache> {
    static CACHE: std::sync::LazyLock<Mutex<learn::Cache>> = std::sync::LazyLock::new(Default::default);
    CACHE.lock().unwrap_or_else(|p| p.into_inner())
}

/// Tag names in the pictures' space ("a photo of …"), by model and tag, made by the engine as needed.
type Words = std::collections::HashMap<(String, String), Vec<f32>>;
static WORDS: std::sync::LazyLock<Mutex<Words>> = std::sync::LazyLock::new(Default::default);
/// At most this many new names are put into words per question: the rest come with the next one.
const WORDS_AT_ONCE: usize = 24;

fn words_for(app: &tauri::AppHandle, embedder: &str, tags: &[String]) -> std::collections::HashMap<String, Vec<f32>> {
    let mut out = std::collections::HashMap::new();
    let mut made = 0;
    for t in tags {
        let k = (embedder.to_string(), t.clone());
        if let Some(v) = WORDS.lock().unwrap_or_else(|p| p.into_inner()).get(&k) {
            out.insert(t.clone(), v.clone());
            continue;
        }
        if made >= WORDS_AT_ONCE || embedder.is_empty() {
            continue;
        }
        made += 1;
        let name = t.split_once('/').map_or(t.as_str(), |(_, n)| n).replace(['-', '_'], " ");
        let Ok(v) = engine::embed_text(app, &app.state::<engine::EngineState>(), &format!("a photo of {name}"), embedder) else { break };
        WORDS.lock().unwrap_or_else(|p| p.into_inner()).insert(k, v.clone());
        out.insert(t.clone(), v);
    }
    out
}

/// A tag's examples in one mode (albums, or pictures and videos): what carries it, what was turned down.
fn examples(view: &TagsView, tag: &str, albums: bool) -> (Vec<String>, Vec<String>) {
    let of = |keys: Option<&Vec<String>>| keys.into_iter().flatten().filter(|k| k.starts_with("album:") == albums).cloned().collect::<Vec<_>>();
    (of(view.by_tag.get(tag)), of(view.denied.get(tag)))
}

/// What to compare a tag's examples with: the albums, or every picture and video indexed.
fn others(ix: &tagindex::Index, view: &TagsView, albums: bool) -> Vec<String> {
    if albums { view.groups.keys().cloned().collect() } else { ix.keys().filter(|k| !k.starts_with("album:")).cloned().collect() }
}

/// The models for these tags, trained (several at once) where their examples changed.
fn models_for(ix: &tagindex::Index, view: &TagsView, tags: &[String], albums: bool) -> std::collections::HashMap<String, std::sync::Arc<Option<learn::Model>>> {
    let others = others(ix, view, albums);
    let mode = if albums { "albums" } else { "images" };
    let mut out = std::collections::HashMap::new();
    let mut todo = Vec::new();
    {
        let cache = learned();
        for t in tags {
            let (yes, no) = examples(view, t, albums);
            let id = format!("{mode}|{t}");
            let sig = learn::signature(ix, &yes, &no);
            match cache.lookup(&id, sig) {
                Some(m) => {
                    out.insert(t.clone(), m);
                }
                None => todo.push((t.clone(), id, sig, yes, no)),
            }
        }
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let kinds = learned().kinds(ix);
    let trained: Vec<(String, String, u64, Option<learn::Model>)> = std::thread::scope(|s| {
        let chunks: Vec<_> = todo.chunks(todo.len().div_ceil(threads).max(1)).collect();
        let handles: Vec<_> = chunks
            .into_iter()
            .map(|chunk| {
                let (others, kinds) = (&others, &kinds);
                s.spawn(move || chunk.iter().map(|(t, id, sig, yes, no)| (t.clone(), id.clone(), *sig, learn::train(ix, &view.groups, kinds, t, yes, no, others))).collect::<Vec<_>>())
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut cache = learned();
    for (t, id, sig, m) in trained {
        out.insert(t, cache.store(id, sig, m));
    }
    out
}

/// One tag's chance for an item.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Chance {
    tag: String,
    p: f32,
    /// Learned from its examples (else from its name).
    examples: bool,
}

/// Tags these items (all pictures, or all albums) may carry, each with how sure: what each tag learned
/// from your yeses and noes, and while it is young its name. The mean over the items, best first.
#[tauri::command]
async fn tags_predict(app: tauri::AppHandle, vs: VS<'_>, root: String, keys: Vec<String>) -> Result<Vec<Chance>, String> {
    let Some(first) = keys.first() else { return Ok(Vec::new()) };
    let albums = first.starts_with("album:");
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let view = tags_view(&vs, &root)?;
        let tags: Vec<String> = view.by_tag.keys().filter(|t| !t.split_once('/').is_some_and(|(ty, _)| view.places.contains(ty))).cloned().collect();
        let embedder = with_tag_index(&vs, &root, |ix| ix.embedder.clone())?;
        let young: Vec<String> = tags.iter().filter(|t| examples(&view, t, albums).0.len() < learn::YOUNG).cloned().collect();
        let words = words_for(&app, &embedder, &young);
        // Loaded above (by `with_tag_index`).
        let g = tag_index_lock();
        let ix = g.as_ref().filter(|i| i.root == root).ok_or("the tag index changed folders")?;
        let models = models_for(ix, &view, &tags, albums);
        let groups = &view.groups;
        let mut out = Vec::new();
        for t in &tags {
            let model = models.get(t).and_then(|m| m.as_ref().as_ref());
            let (mut sum, mut n, mut by_examples) = (0.0f32, 0, false);
            for k in &keys {
                let learned = model.and_then(|m| m.logit(ix, k, groups));
                let cos = words.get(t).and_then(|w| ix.likeness(k, groups, w));
                if let Some((p, ex)) = learn::blend(learned, model.map_or(0, |m| m.yes), cos, &ix.embedder) {
                    sum += p;
                    n += 1;
                    by_examples |= ex;
                }
            }
            if n > 0 && sum / n as f32 >= 0.05 {
                out.push(Chance { tag: t.clone(), p: sum / n as f32, examples: by_examples });
            }
        }
        out.sort_by(|a, b| b.p.total_cmp(&a.p));
        Ok(out)
    })
    .await
}

/// One item's chance of carrying a tag.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    key: String,
    p: f32,
    examples: bool,
}

/// What might carry a tag (pictures and videos, or albums), with how sure, best first: at least `min`,
/// `skip` left out (what carries it and what was turned down).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn tags_candidates(app: tauri::AppHandle, vs: VS<'_>, root: String, tag: String, albums: bool, skip: Vec<String>, min: f32, limit: usize) -> Result<Vec<Candidate>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let view = tags_view(&vs, &root)?;
        let embedder = with_tag_index(&vs, &root, |ix| ix.embedder.clone())?;
        let young = examples(&view, &tag, albums).0.len() < learn::YOUNG;
        let words = if young { words_for(&app, &embedder, std::slice::from_ref(&tag)) } else { Default::default() };
        // Loaded above (by `with_tag_index`).
        let g = tag_index_lock();
        let ix = g.as_ref().filter(|i| i.root == root).ok_or("the tag index changed folders")?;
        let models = models_for(ix, &view, std::slice::from_ref(&tag), albums);
        let model = models.get(&tag).and_then(|m| m.as_ref().as_ref());
        let w = words.get(&tag);
        if model.is_none() && w.is_none() {
            return Ok(Vec::new());
        }
        let skip: std::collections::HashSet<String> = skip.into_iter().collect();
        let mut out: Vec<Candidate> = others(ix, &view, albums)
            .into_iter()
            .filter(|k| !skip.contains(k))
            .filter_map(|k| {
                let learned = model.and_then(|m| m.logit(ix, &k, &view.groups));
                let cos = w.and_then(|w| ix.likeness(&k, &view.groups, w));
                let (p, examples) = learn::blend(learned, model.map_or(0, |m| m.yes), cos, &ix.embedder)?;
                (p >= min).then_some(Candidate { key: k, p, examples })
            })
            .collect();
        out.sort_by(|a, b| b.p.total_cmp(&a.p));
        out.truncate(limit);
        Ok(out)
    })
    .await
}

/// Search by words: in the index's own picture-and-word model, crops and frames counting (something
/// small in a picture is found). Albums by their pages when `albums`.
#[tauri::command]
async fn tags_search(app: tauri::AppHandle, vs: VS<'_>, root: String, text: String, albums: bool, limit: usize) -> Result<Vec<(String, f32)>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let embedder = with_tag_index(&vs, &root, |ix| ix.embedder.clone())?;
        if embedder.is_empty() {
            return Ok(Vec::new());
        }
        let view = tags_view(&vs, &root)?;
        let v = engine::embed_text(&app, &app.state::<engine::EngineState>(), &text, &embedder)?;
        // Where a match starts, by model: SigLIP's cosines run lower than CLIP's.
        let min = if embedder == "siglip2" { 0.06 } else { 0.17 };
        let candidates: Option<Vec<String>> = albums.then(|| view.groups.keys().cloned().collect());
        with_tag_index(&vs, &root, |ix| ix.rank(&[tagindex::Query::Vector(v)], candidates.as_deref(), &view.groups, &Default::default(), min, limit, true))
    })
    .await
}

/// Seconds long, from ffprobe; None when it can't tell.
fn probe_duration(input: &Path) -> Option<f64> {
    use std::process::{Command, Stdio};
    let tools = edit::tools();
    let ffprobe = tools.ffprobe.as_deref()?;
    let out = Command::new(ffprobe).args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(input).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    String::from_utf8(out.stdout).ok()?.trim().parse::<f64>().ok().filter(|d| d.is_finite() && *d > 0.0)
}

/// Run ffmpeg on `input` (a file, or a vault's video as `video_input` serves it) with these
/// arguments before and after it, giving what it wrote to stdout.
fn run_ffmpeg_to_stdout(ffmpeg: &str, input: &Path, before_input: &[String], after_input: &[String]) -> Result<Vec<u8>, String> {
    use std::process::{Command, Stdio};
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin"])
        .args(before_input)
        .arg("-i")
        .arg(input)
        .args(after_input)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("start ffmpeg: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed").trim().to_string();
        return Err(format!("ffmpeg: {last}"));
    }
    Ok(output.stdout)
}

use std::fs;

/// Where ffmpeg reads a video from: its file, or in a vault the video served piece by piece as
/// ffmpeg asks for it (`serve`), so nothing of it is decrypted to disk or read whole into memory.
/// The server lives as long as this value.
struct VideoInput {
    arg: PathBuf,
    _served: Option<serve::Served>,
}

fn video_input(vs: &VaultLock, root: &Path, path: &Path) -> Result<VideoInput, String> {
    let served = with_ctx_read(vs, root, |ctx| -> Result<Option<serve::Served>, String> {
        let (Some(v), Some(id)) = (ctx.vault.as_deref(), ctx.vault_id(path)) else { return Ok(None) };
        let size = v.entry_by_id(&id).map(|e| e.size).ok_or("the video isn't in the vault")?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
        serve::serve(Arc::new(v.keys()), id, size, ext).map(Some)
    })?;
    Ok(match served {
        Some(s) => VideoInput { arg: PathBuf::from(&s.url), _served: Some(s) },
        None => VideoInput { arg: path.to_path_buf(), _served: None },
    })
}

/// `count` frames spread over a video, as PNGs 1024 wide, for the tag index.
fn video_frames(input: &Path, count: usize) -> Result<Vec<Vec<u8>>, String> {
    video_frames_timed(input, count).map(|v| v.into_iter().map(|(_, png)| png).collect())
}

/// A video's picture for its tile in an open vault, made once and kept in the vault, encrypted,
/// beside its pictures' thumbnails (`Vault::write_thumb`; they go with the video). ffmpeg reads the
/// video piece by piece as it needs it (`serve`), so nothing of it is decrypted to disk. Outside a
/// vault the window makes its own as the tile shows (`lib/poster.ts`), kept in memory only.
fn video_thumb(vs: &VaultLock, root: &Path, path: &Path, width: u32) -> Result<std::sync::Arc<thumbs::Thumb>, (u16, String)> {
    let (key, name, keys, id, size) = {
        let guard = vs.read().unwrap_or_else(|p| p.into_inner());
        let v = guard.as_ref().filter(|v| v.root == root).ok_or((415, "outside a vault the window makes a video's picture".to_string()))?;
        let rel = path.strip_prefix(root).ok().map(|r| media::rel_key(Path::new(""), r)).ok_or((404, "not in this library".to_string()))?;
        let e = v.entry_by_rel(&rel).cloned().ok_or((404, "no such video".to_string()))?;
        let key = thumbs::key(&path.to_string_lossy(), e.size, e.mtime, width);
        if let Some(t) = thumbs::cached(&key) {
            return Ok(t);
        }
        let name = format!("{}-{width}", e.id);
        if let Some(bytes) = v.read_thumb(&name) {
            let t = std::sync::Arc::new(thumbs::Thumb::from_stored(bytes));
            thumbs::keep(key, t.clone());
            return Ok(t);
        }
        (key, name, std::sync::Arc::new(v.keys()), e.id, e.size)
    };
    let made = {
        let _turn = thumbs::Slot::take();
        // Another request may have made it while this one waited.
        if let Some(t) = thumbs::cached(&key) {
            return Ok(t);
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
        let served = serve::serve(keys, id, size, ext).map_err(|e| (500, e))?;
        std::sync::Arc::new(video_poster(Path::new(&served.url), width).map_err(|e| (415, e))?)
    };
    if let Some(v) = vs.read().unwrap_or_else(|p| p.into_inner()).as_ref().filter(|v| v.root == root)
        && let Err(e) = v.write_thumb(&name, &made.bytes)
    {
        eprintln!("[thumb] a video's picture wasn't kept in the vault: {e}");
    }
    thumbs::keep(key, made.clone());
    Ok(made)
}

/// A video's picture for its tile, `width` wide: the frame a moment in, or a later one when that is
/// all but black (a fade in, a title card), as the window picks its own (`lib/poster.ts`).
fn video_poster(input: &Path, width: u32) -> Result<thumbs::Thumb, String> {
    let tools = edit::tools();
    let ffmpeg = tools.ffmpeg.as_deref().ok_or("ffmpeg is needed for videos (brew install ffmpeg)")?;
    let duration = probe_duration(input).unwrap_or(1.0);
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let mut darkest = None;
    for at in [(duration / 10.0).min(0.5), (duration / 3.0).min(1.5), duration / 2.0] {
        let before = s(&["-ss", &format!("{at:.3}")]);
        let after = s(&["-frames:v", "1", "-vf", &format!("scale={width}:-2"), "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
        let Ok(png) = run_ffmpeg_to_stdout(ffmpeg, input, &before, &after) else { continue };
        let Ok(img) = image::load_from_memory(&png) else { continue };
        let img = image::DynamicImage::ImageRgb8(img.to_rgb8());
        if !all_but_black(&img) {
            return thumbs::encode(img);
        }
        darkest = Some(img);
    }
    darkest.map(thumbs::encode).unwrap_or_else(|| Err("ffmpeg gave no frame".into()))
}

/// Whether a frame is all but black: every sixteenth pixel, on average, under 12 of 765.
fn all_but_black(img: &image::DynamicImage) -> bool {
    let rgb = img.to_rgb8();
    let (sum, n) = rgb.pixels().step_by(16).fold((0u64, 0u64), |(s, n), p| (s + p[0] as u64 + p[1] as u64 + p[2] as u64, n + 1));
    n == 0 || sum / n < 12
}

/// One frame of a video at `at` seconds, as a PNG 1024 wide (a face's crop is cut from it).
fn video_frame_at(input: &Path, at: f64) -> Result<Vec<u8>, String> {
    let tools = edit::tools();
    let ffmpeg = tools.ffmpeg.as_deref().ok_or("ffmpeg is needed for videos (brew install ffmpeg)")?;
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let png = run_ffmpeg_to_stdout(ffmpeg, input, &s(&["-ss", &format!("{at:.3}")]), &s(&["-frames:v", "1", "-vf", "scale=1024:-2", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]))?;
    if png.is_empty() {
        return Err("ffmpeg gave no frame".into());
    }
    Ok(png)
}

/// `count` frames spread over a video with the second each is at, as `video_frames`: probed for its
/// length and seeked to each share, so only those frames are decoded.
fn video_frames_timed(input: &Path, count: usize) -> Result<Vec<(f64, Vec<u8>)>, String> {
    let tools = edit::tools();
    let ffmpeg = tools.ffmpeg.as_deref().ok_or("ffmpeg is needed for videos (brew install ffmpeg)")?;
    let count = count.max(1);
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    let duration = probe_duration(input).ok_or("ffprobe could not read the video")?;
    let mut out = Vec::new();
    for i in 0..count {
        let at = (i as f64 + 0.5) / count as f64 * duration;
        let before = s(&["-ss", &format!("{at:.3}")]);
        let after = s(&["-frames:v", "1", "-vf", "scale=1024:-2", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
        if let Ok(png) = run_ffmpeg_to_stdout(ffmpeg, input, &before, &after)
            && !png.is_empty()
        {
            out.push((at, png));
        }
    }
    if out.is_empty() {
        return Err("ffmpeg gave no frame".into());
    }
    Ok(out)
}

#[cfg(test)]
mod video_thumb_tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("quire-video-thumb-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A made-up clip from ffmpeg's own test patterns: `inputs` and how they are joined.
    fn clip(to: &Path, inputs: &[&str], filter: Option<&str>) -> bool {
        let tools = edit::tools();
        let Some(ffmpeg) = tools.ffmpeg.as_deref() else { return false };
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-v", "error"]);
        for i in inputs {
            cmd.args(["-f", "lavfi", "-i", i]);
        }
        if let Some(f) = filter {
            cmd.args(["-filter_complex", f]);
        }
        cmd.args(["-pix_fmt", "yuv420p", "-y"]).arg(to);
        cmd.status().is_ok_and(|s| s.success())
    }

    #[test]
    fn a_vault_videos_picture_is_made_once_and_kept_encrypted() {
        let root = temp("vault");
        fs::create_dir_all(root.join("Clips")).unwrap();
        if !clip(&root.join("Clips/a.mp4"), &["testsrc=duration=3:size=640x360:rate=25"], None) {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let mut v = Vault::create(&root, "correct horse battery staple").unwrap();
        let id = v.add_file(&root.join("Clips/a.mp4"), "Clips/a.mp4").unwrap().id;
        v.flush().unwrap();
        // In a vault the video is only inside it.
        fs::remove_file(root.join("Clips/a.mp4")).unwrap();
        let vs: VaultLock = RwLock::new(Some(v));
        let t = video_thumb(&vs, &root, &root.join("Clips/a.mp4"), 320).unwrap();
        let img = image::load_from_memory(&t.bytes).unwrap();
        assert_eq!((t.mime, img.width(), img.height()), ("image/jpeg", 320, 180));
        assert!(!all_but_black(&img));
        // Kept in the vault: the next time the app opens, it is read rather than made.
        let g = vs.read().unwrap();
        assert_eq!(g.as_ref().unwrap().read_thumb(&format!("{id}-320")).as_deref(), Some(&t.bytes[..]));
        drop(g);
        // Nothing of it in the clear: no picture (or video) anywhere under the vault's folder, the
        // kept picture among what is looked at.
        fn every_file(dir: &Path, out: &mut Vec<PathBuf>) {
            for e in fs::read_dir(dir).unwrap().flatten() {
                if e.file_type().unwrap().is_dir() {
                    every_file(&e.path(), out);
                } else {
                    out.push(e.path());
                }
            }
        }
        let mut files = Vec::new();
        every_file(&root.join(vault::VAULT_DIR), &mut files);
        assert!(files.iter().any(|f| f.to_string_lossy().contains("thumbs") && f.to_string_lossy().contains(&id)), "{files:?}");
        for f in &files {
            let head = fs::read(f).unwrap();
            assert!(!head.starts_with(b"\xff\xd8\xff") && !head.windows(4).take(64).any(|w| w == b"ftyp"), "{} is in the clear", f.display());
        }
        assert!(!root.join("Clips/a.mp4").exists(), "and none of it beside the vault");
        // A video the vault doesn't have, and none outside a vault: the window makes its own.
        assert_eq!(video_thumb(&vs, &root, &root.join("Clips/b.mp4"), 320).err().map(|e| e.0), Some(404));
        let none: VaultLock = RwLock::new(None);
        assert_eq!(video_thumb(&none, &root, &root.join("Clips/a.mp4"), 320).err().map(|e| e.0), Some(415));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_video_that_opens_on_black_shows_a_later_frame() {
        let root = temp("dark");
        let f = root.join("fade.mp4");
        if !clip(&f, &["color=c=black:size=320x180:duration=1:rate=25", "testsrc=size=320x180:duration=3:rate=25"], Some("[0][1]concat=n=2:v=1:a=0")) {
            eprintln!("ffmpeg not installed, skipping");
            return;
        }
        let t = video_poster(&f, 192).unwrap();
        let img = image::load_from_memory(&t.bytes).unwrap();
        assert_eq!(img.width(), 192);
        assert!(!all_but_black(&img), "the black opening was passed over");
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod tag_index_files_tests {
    use super::*;

    #[test]
    fn a_run_killed_between_full_saves_loses_nothing_it_journaled() {
        let root = std::env::temp_dir().join(format!("ms-journal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let ctx = fsx::Ctx::new(&root, None);
        let stamp = tagindex::Stamp { s: 1, m: 2 };
        let mut ix = tagindex::Index::new(&root, "siglip2", "pixai");
        ix.put("a.jpg", Some(&[1.0, 0.0]), &[], Some(&[]), None, stamp);
        write_index(&ctx, &ix).unwrap();
        // Indexed after the full save, journaled, then the app was killed.
        ix.put("b.jpg", Some(&[0.0, 1.0]), &[vec![1.0, 1.0]], Some(&[(3, 0.7)]), Some(&[0.6, 0.8]), stamp);
        ctx.append_meta_record(&journal_name(ix.journal), &serde_json::to_vec(&ix.put_change("b.jpg").unwrap()).unwrap()).unwrap();
        // A quiet journal or two later, another.
        ix.put("c.jpg", Some(&[0.6, 0.8]), &[], Some(&[]), None, stamp);
        ctx.append_meta_record(&journal_name(ix.journal + 3), &serde_json::to_vec(&ix.put_change("c.jpg").unwrap()).unwrap()).unwrap();
        let back = read_index(&ctx, &root).unwrap().unwrap();
        assert!(back.has("a.jpg") && back.has("b.jpg") && back.has("c.jpg"));
        assert_eq!(back.auto["b.jpg"], vec![(3, 0.7)]);
        assert_eq!(back.parts_of("b.jpg").len(), 1);
        assert!(back.dirty());
        // The next full save holds them; its journals go.
        let mut back = back;
        back.journal += 1;
        write_index(&ctx, &back).unwrap();
        drop_journals(&ctx, back.saved_journal, back.journal).unwrap();
        assert!(ctx.load_meta_records(&journal_name(0)).unwrap().is_empty());
        let again = read_index(&ctx, &root).unwrap().unwrap();
        assert!(again.has("b.jpg") && again.has("c.jpg"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pictures_are_made_small_ahead_as_the_engine_would() {
        let big = image::RgbImage::from_fn(3000, 2000, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(big).write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg).unwrap();
        let small = shrunk_for_index(jpeg);
        let back = image::load_from_memory(&small).unwrap();
        assert_eq!((back.width(), back.height()), (1024, 683));
        assert!(small.starts_with(b"BM"));
        // Not a picture this side knows: it goes as it is.
        assert_eq!(shrunk_for_index(b"not a picture".to_vec()), b"not a picture".to_vec());
    }

    fn run(tag: bool) -> engine::IndexOptions {
        engine::IndexOptions { embed: true, tag, min_probability: 0.1, embedder: "siglip2".into(), tagger: if tag { "pixai".into() } else { String::new() }, parts: true, drawn_only: true }
    }

    #[test]
    fn the_anime_tagger_joins_the_index_when_it_is_downloaded() {
        let root = std::env::temp_dir().join(format!("ms-tagger-{}", std::process::id()));
        let stamp = tagindex::Stamp { s: 1, m: 2 };
        // Indexed without the tagger: pictures' vectors, no anime words.
        let mut ix = tagindex::Index::new(&root, "", "");
        models_for_run(&mut ix, &run(false)).unwrap();
        assert_eq!((ix.embedder.as_str(), ix.tagger.as_str()), ("siglip2", ""));
        ix.put("photo.jpg", Some(&[1.0, 0.0]), &[], None, None, stamp);
        // The tagger downloaded: the same index takes it on, what it has kept.
        models_for_run(&mut ix, &run(true)).unwrap();
        assert_eq!(ix.tagger, "pixai");
        ix.put("photo.jpg", Some(&[1.0, 0.0]), &[], Some(&[]), None, stamp);
        ix.put("page.png", Some(&[0.0, 1.0]), &[], Some(&[(7, 0.9)]), Some(&[0.6, 0.8]), stamp);
        assert!(ix.has("photo.jpg") && ix.auto["photo.jpg"].is_empty() && ix.auto["page.png"] == vec![(7, 0.9)]);
        // Removed again: runs go on without it, its words stay.
        models_for_run(&mut ix, &run(false)).unwrap();
        assert_eq!(ix.tagger, "pixai");
        // An index from models this version doesn't have takes nothing beside its own.
        let mut old = tagindex::Index::new(&root, "clip", "wd14");
        old.put("a.jpg", Some(&[1.0, 0.0]), &[], Some(&[(1, 0.5)]), None, stamp);
        assert!(models_for_run(&mut old, &run(true)).unwrap_err().contains("picture and word matcher"));
        let mut half = tagindex::Index::new(&root, "siglip2", "wd14");
        half.put("a.jpg", Some(&[1.0, 0.0]), &[], Some(&[(1, 0.5)]), None, stamp);
        assert!(models_for_run(&mut half, &run(false)).is_ok(), "pictures still join without its words");
        assert!(models_for_run(&mut half, &run(true)).unwrap_err().contains("anime tagger"));
    }

    #[test]
    fn what_an_earlier_version_left_of_a_remade_index_goes_as_it_loads() {
        let root = std::env::temp_dir().join(format!("ms-earlier-index-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let ctx = fsx::Ctx::new(&root, None);
        let tags = r#"{"version":1,"tags":{"a.jpg":["motives/cat"]}}"#;
        ctx.save_meta("tags", tags).unwrap();
        let stamp = tagindex::Stamp { s: 1, m: 2 };
        let mut ix = tagindex::Index::new(&root, "siglip2", "pixai");
        ix.put("a.jpg", Some(&[0.0, 1.0]), &[], Some(&[(7, 0.9)]), None, stamp);
        write_index(&ctx, &ix).unwrap();
        for name in ["tagindex-next", "tagindex-old"] {
            ctx.save_meta(name, "{}").unwrap();
        }
        for name in ["tagvectors-next", "tagvectors-old"] {
            ctx.save_meta_bytes(name, b"old vectors").unwrap();
        }
        let vs: VaultLock = RwLock::new(None);
        ensure_tag_index(&vs, &root).unwrap();
        let mut left: Vec<String> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, [".quire.tagindex.json", ".quire.tags.json", ".quire.tagvectors.bin"]);
        assert_eq!(tag_index_lock().as_ref().unwrap().auto["a.jpg"], vec![(7, 0.9)]);
        assert_eq!(ctx.load_meta("tags").unwrap().as_deref(), Some(tags));
        *tag_index_lock() = None;
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod video_frame_tests {
    use super::*;

    /// A short clip of ffmpeg's test pattern (a counter and a moving bar, so every frame differs).
    fn clip(name: &str, faststart: bool) -> Option<PathBuf> {
        let tools = edit::tools();
        let ffmpeg = tools.ffmpeg.as_deref()?;
        tools.ffprobe.as_deref()?;
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("video-frame-tests");
        fs::create_dir_all(&dir).ok()?;
        let p = dir.join(name);
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=duration=8:size=160x120:rate=10"]);
        if faststart {
            cmd.args(["-movflags", "+faststart"]);
        }
        cmd.arg(&p);
        cmd.status().ok()?.success().then_some(p)
    }

    fn png_dims(png: &[u8]) -> (u32, u32) {
        // IHDR follows the signature: width and height at 16 and 20.
        (u32::from_be_bytes([png[16], png[17], png[18], png[19]]), u32::from_be_bytes([png[20], png[21], png[22], png[23]]))
    }

    fn check(frames: &[Vec<u8>]) {
        assert_eq!(frames.len(), 4, "four frames spread over the clip");
        for f in frames {
            assert!(f.starts_with(&[0x89, b'P', b'N', b'G']), "each a PNG");
            assert!(f.ends_with(&[b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]), "each a whole PNG");
            assert_eq!(png_dims(f), (1024, 768), "scaled to 1024 wide");
        }
        for i in 0..frames.len() {
            for j in i + 1..frames.len() {
                assert_ne!(frames[i], frames[j], "frames {i} and {j} come from different moments");
            }
        }
    }

    /// The video only inside a vault, as a library keeps it there, and the lock it is open under.
    fn in_vault(p: &Path) -> (PathBuf, PathBuf, VaultLock) {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        let root = p.with_file_name(format!("vault-{name}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Clips")).unwrap();
        let mut v = Vault::create(&root, "correct horse battery staple").unwrap();
        v.add_file(p, &format!("Clips/{name}")).unwrap();
        v.flush().unwrap();
        (root.join("Clips").join(&name), root, RwLock::new(Some(v)))
    }

    /// Frames of a vault's video, served to ffmpeg piece by piece: nothing of it on disk in the
    /// clear, before, during or after.
    fn frames_from_the_vault(p: &Path) {
        let (path, root, vs) = in_vault(p);
        assert!(!path.exists());
        let input = video_input(&vs, &root, &path).unwrap();
        assert!(input.arg.to_string_lossy().starts_with("http://127.0.0.1:"), "{}", input.arg.display());
        assert!(probe_duration(&input.arg).is_some());
        check(&video_frames(&input.arg, 4).unwrap());
        drop(input);
        let mut beside: Vec<String> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        beside.sort();
        assert_eq!(beside, [".vault", "Clips"]);
        assert_eq!(fs::read_dir(root.join("Clips")).unwrap().count(), 0, "no copy of it beside the vault");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn frames_of_a_file() {
        let Some(p) = clip("plain.mp4", false) else { return };
        let input = video_input(&RwLock::new(None), p.parent().unwrap(), &p).unwrap();
        assert_eq!(input.arg, p, "outside a vault ffmpeg reads the file itself");
        check(&video_frames(&p, 4).unwrap());
    }

    #[test]
    fn frames_of_a_vault_video_with_the_index_first() {
        let Some(p) = clip("faststart.mp4", true) else { return };
        frames_from_the_vault(&p);
    }

    #[test]
    fn frames_of_a_vault_video_with_the_index_last() {
        // ffmpeg's default MP4 has its index at the end: ffmpeg asks for that part first.
        let Some(p) = clip("index-last.mp4", false) else { return };
        frames_from_the_vault(&p);
    }

    #[test]
    fn frames_of_a_webm() {
        let tools = edit::tools();
        if tools.ffmpeg.is_none() || tools.ffprobe.is_none() {
            return;
        }
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("video-frame-tests");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("clip.webm");
        let ok = std::process::Command::new(tools.ffmpeg.as_deref().unwrap())
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=duration=6:size=160x120:rate=10", "-c:v", "libvpx", "-b:v", "200k"])
            .arg(&p)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return; // no VP8 encoder in this ffmpeg
        }
        check(&video_frames(&p, 4).unwrap());
        frames_from_the_vault(&p);
    }

    #[test]
    fn a_broken_video_is_an_error_not_a_panic() {
        if edit::tools().ffmpeg.is_none() {
            return;
        }
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("video-frame-tests");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.mp4");
        fs::write(&p, b"not a video at all").unwrap();
        assert!(video_frames(&p, 4).is_err());
        let (path, root, vs) = in_vault(&p);
        assert!(video_frames(&video_input(&vs, &root, &path).unwrap().arg, 4).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}

/// The index takes on a run's models: an empty one both, one without the anime tagger's words the
/// tagger when the run brings it (it is optional: downloaded later, it looks at what is indexed
/// already, into the same index). One made with a picture-and-word matcher this app doesn't have
/// can't take the run's pictures beside its own.
fn models_for_run(ix: &mut tagindex::Index, options: &engine::IndexOptions) -> Result<(), String> {
    if ix.is_empty() {
        ix.embedder = options.embedder.clone();
        ix.tagger = String::new();
    }
    if ix.embedder != options.embedder {
        return Err(format!("the tag index was made with a picture and word matcher this version of Quire doesn't have ({})", ix.embedder));
    }
    if options.tag && ix.tagger != options.tagger {
        if !ix.tagger.is_empty() {
            return Err(format!("the tag index has the words of an anime tagger this version of Quire doesn't have ({})", ix.tagger));
        }
        ix.tagger = options.tagger.clone();
        ix.mark_dirty();
    }
    Ok(())
}

/// Index items through the engine, one at a time, in the background: each one's result goes
/// back on `on_item` as it comes, so the app keeps what was done if the job is stopped.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn tags_index(
    app: tauri::AppHandle,
    vs: VS<'_>,
    root: String,
    items: Vec<MediaItem>,
    embed: bool,
    tag: bool,
    embedder: String,
    tagger: String,
    parts: bool,
    drawn_only: bool,
    paused: Option<bool>,
    on_progress: tauri::ipc::Channel<IndexProgress>,
    on_item: tauri::ipc::Channel<IndexedItem>,
) -> Result<usize, String> {
    let vs = vs.share();
    let options = engine::IndexOptions { embed, tag, min_probability: 0.1, embedder, tagger, parts, drawn_only };
    // The whole run on a blocking thread: it waits on the readers and the engine, and writes the
    // journal after every picture.
    blocking(move || index_items(&app, &vs, PathBuf::from(root), items, options, paused, on_progress, on_item)).await
}

#[allow(clippy::too_many_arguments)]
fn index_items(app: &tauri::AppHandle, vs: &VaultLock, rootp: PathBuf, items: Vec<MediaItem>, options: engine::IndexOptions, paused: Option<bool>, on_progress: tauri::ipc::Channel<IndexProgress>, on_item: tauri::ipc::Channel<IndexedItem>) -> Result<usize, String> {
    use std::sync::atomic::Ordering;
    let stop = app.state::<IndexState>();
    // One run at a time: one asked for while another goes (the page was reloaded) stops that one first.
    let asked = std::time::Instant::now();
    while stop.2.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        stop.0.store(true, Ordering::SeqCst);
        if asked.elapsed() > std::time::Duration::from_secs(120) {
            return Err("the indexing run before this one didn't stop".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _running = Running(&stop.2);
    stop.0.store(false, Ordering::SeqCst);
    // A paused run carried on after a restart starts held.
    stop.1.store(paused.unwrap_or(false), Ordering::SeqCst);
    with_tag_index(vs, &rootp, |ix| models_for_run(ix, &options))??;
    let total = items.len();
    // The next items are read and made small by `READERS` threads while the engine works on this one.
    let items = std::sync::Arc::new(items);
    let queues: Vec<_> = (0..READERS)
        .map(|w| {
            let (tx, rx) = std::sync::mpsc::sync_channel::<Prepared>(2);
            let (app, items, root) = (app.clone(), items.clone(), rootp.clone());
            std::thread::spawn(move || {
                let vs = app.state::<VaultState>();
                for item in items.iter().skip(w).step_by(READERS) {
                    if tx.send(prepare(&vs, &root, item)).is_err() {
                        break;
                    }
                }
            });
            std::sync::Arc::new(Mutex::new(rx))
        })
        .collect();
    let mut done = 0usize;
    for (i, item) in items.iter().enumerate() {
        // Paused: wait here, before the next picture; what is done is done.
        while stop.1.load(Ordering::Relaxed) && !stop.0.load(Ordering::Relaxed) {
            let _ = on_progress.send(IndexProgress { done: i, total, current: "paused".into(), key: Some(item.key.clone()) });
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        if stop.0.load(Ordering::Relaxed) {
            break;
        }
        let _ = on_progress.send(IndexProgress { done: i, total, current: item.name.clone(), key: Some(item.key.clone()) });
        let prepared = queues[i % READERS].lock().unwrap_or_else(|p| p.into_inner()).recv();
        let key = item.key.clone();
        let result = match prepared {
            Ok(Prepared { inputs: Ok(frames), video }) => index_frames(app, frames, video, &options),
            Ok(Prepared { inputs: Err(e), .. }) => Err(e),
            Err(_) => Err("the picture could not be read".into()),
        };
        let fatal = result.as_ref().err().is_some_and(|e| e.starts_with("not downloaded") || e.contains("engine"));
        let sent = match result {
            Ok(r) => {
                // Kept here, and in the journal at once; the frontend gets the tagger's words, not the vectors.
                let stamp = tagindex::Stamp { s: item.size, m: item.modified };
                let put = |ix: &mut tagindex::Index| {
                    ix.put(&key, r.embedding.as_deref(), &r.parts, r.tags.as_deref(), r.anime.as_deref(), stamp);
                    (ix.put_change(&key), ix.journal)
                };
                if let Ok((Some(change), seq)) = with_tag_index(vs, &rootp, put) {
                    journal(vs, &rootp, seq, &change);
                }
                let _ = flush_tag_index(vs, false);
                IndexedItem { key, embedding: None, tags: r.tags, error: None }
            }
            Err(e) => IndexedItem { key, embedding: None, tags: None, error: Some(e) },
        };
        let _ = on_item.send(sent);
        done += 1;
        if fatal {
            break;
        }
    }
    // The readers stop as their queues go.
    drop(queues);
    let _ = flush_tag_index(vs, true);
    let _ = on_progress.send(IndexProgress { done, total, current: String::new(), key: None });
    Ok(done)
}

/// Threads reading ahead while the engine works: a large photo takes about as long to decode and
/// shrink as the models take on the GPU.
const READERS: usize = 2;
/// What the models are given at most: their own inputs are 256 and 448 px.
const INDEX_SIDE: u32 = 1024;

/// One item read and made ready for the engine.
struct Prepared {
    inputs: Result<Vec<Vec<u8>>, String>,
    video: bool,
}

/// An item's pictures as the engine wants them: a video's frames, a RAW's preview or the picture,
/// decoded, turned and shrunk here (`shrunk_for_index`).
fn prepare(vs: &VaultLock, root: &Path, item: &MediaItem) -> Prepared {
    // A PDF album's page: drawn from the PDF at the size the index looks at.
    if let Some((pdf, page)) = pdf::split_page(&item.primary) {
        let inputs = with_ctx_read(vs, root, |ctx| ctx.read_all(&pdf)).and_then(|bytes| pdf::render(bytes, page, INDEX_SIDE)).and_then(|img| as_bmp(&img)).map(|b| vec![b]);
        return Prepared { inputs, video: false };
    }
    let p = PathBuf::from(&item.primary);
    let kind = media::classify(&p);
    let video = matches!(kind, Some(media::MediaKind::Video));
    if video {
        // ffmpeg reads the file, or the vault's video as it asks for it: never the whole of it here.
        let inputs = video_input(vs, root, &p).and_then(|input| video_frames(&input.arg, VIDEO_FRAMES));
        return Prepared { inputs, video };
    }
    let inputs = with_ctx_read(vs, root, |ctx| ctx.read_all(&p)).and_then(|bytes| match kind {
        Some(media::MediaKind::Raw) => Ok(vec![shrunk_for_index(preview::embedded_jpeg_bytes(&bytes)?)]),
        _ => Ok(vec![shrunk_for_index(bytes)]),
    });
    Prepared { inputs, video }
}

/// A picture decoded, turned the way its EXIF says and shrunk to `INDEX_SIDE`, as the engine would,
/// and sent as BMP (uncompressed: quick to write and to read). One that can't be decoded here goes as
/// it is: the engine may know its format.
fn shrunk_for_index(bytes: Vec<u8>) -> Vec<u8> {
    use image::ImageDecoder as _;
    let shrunk = || -> Option<Vec<u8>> {
        let mut decoder = image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().ok()?.into_decoder().ok()?;
        let orientation = decoder.orientation().ok();
        let mut img = image::DynamicImage::from_decoder(decoder).ok()?;
        if let Some(o) = orientation {
            img.apply_orientation(o);
        }
        if img.width().max(img.height()) > INDEX_SIDE {
            img = img.resize(INDEX_SIDE, INDEX_SIDE, image::imageops::FilterType::Triangle);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img.to_rgb8()).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Bmp).ok()?;
        Some(out)
    };
    shrunk().unwrap_or(bytes)
}

/// A picture as BMP (uncompressed: quick to write and to read), for the engine.
fn as_bmp(img: &image::RgbImage) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Bmp).map_err(|e| e.to_string())?;
    Ok(out)
}

/// The pages of a PDF album, as pictures of it (for the viewer and the tag index).
#[tauri::command]
async fn pdf_pages(vs: VS<'_>, root: String, path: String) -> Result<Vec<MediaItem>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        with_ctx_read(&vs, &root, |ctx| albums::pdf_pages(ctx, &root, Path::new(&path)))
    })
    .await
}

/// The tagger's words that say "a comic": a PDF whose pages carry them is likely an album.
const COMIC_WORDS: [&str; 6] = ["comic", "4koma", "speech_bubble", "manga", "sound_effects", "onomatopoeia"];

/// How surely a PDF is a comic: the most the tagger says one of COMIC_WORDS on its first four
/// pages (the cover may carry none of them).
#[tauri::command]
async fn pdf_comic(app: tauri::AppHandle, vs: VS<'_>, root: String, path: String, embedder: String, tagger: String) -> Result<f32, String> {
    let vs = vs.share();
    blocking(move || {
        let pdf = PathBuf::from(&path);
        let bytes = with_ctx_read(&vs, Path::new(&root), |ctx| ctx.read_all(&pdf))?;
        let state = app.state::<engine::EngineState>();
        let names = engine::tag_names(&app, &state, &tagger)?;
        let wanted: Vec<usize> = names.as_array().map(|a| a.iter().enumerate().filter(|(_, n)| n["name"].as_str().or(n.as_str()).is_some_and(|n| COMIC_WORDS.contains(&n))).map(|(i, _)| i).collect()).unwrap_or_default();
        if wanted.is_empty() {
            return Err("the tagger isn't downloaded".into());
        }
        let pages = pdf::page_count(|| Ok(bytes.clone()), (&pdf, bytes.len() as u64, 0))?;
        let options = engine::IndexOptions { embed: false, tag: true, min_probability: 0.2, embedder, tagger, parts: false, drawn_only: false };
        let mut best = 0f32;
        for page in 1..=pages.min(4) {
            let img = pdf::render(bytes.clone(), page, INDEX_SIDE)?;
            let r = engine::index(&app, &state, as_bmp(&img)?, &options)?;
            for (i, p) in r.tags.unwrap_or_default() {
                if wanted.contains(&i) {
                    best = best.max(p);
                }
            }
        }
        Ok(best)
    })
    .await
}

/// Frames looked at in a video: the picture-and-word model sees all of them, the anime tagger
/// (slow) the middle ones.
const VIDEO_FRAMES: usize = 4;

/// What the models make of one item, from its picture or a video's frames.
struct ItemIndexed {
    embedding: Option<Vec<f32>>,
    /// Crops of a picture, or a video's frames.
    parts: Vec<Vec<f32>>,
    /// What the tagger saw (empty when it didn't look: a photo), when it was asked.
    tags: Option<Vec<(usize, f32)>>,
    anime: Option<Vec<f32>>,
}

/// A picture as it is; a video's frames pooled: the embedding their mean (unit length again) with each
/// frame kept as a part, the tags at their highest, the tagger's embedding the mean of what it saw.
fn index_frames(app: &tauri::AppHandle, frames: Vec<Vec<u8>>, video: bool, options: &engine::IndexOptions) -> Result<ItemIndexed, String> {
    let state = app.state::<engine::EngineState>();
    if !video {
        let frame = frames.into_iter().next().ok_or("nothing to read")?;
        let r = engine::index(app, &state, frame, options)?;
        return Ok(ItemIndexed { embedding: r.embedding, parts: r.parts, tags: options.tag.then(|| r.tags.unwrap_or_default()), anime: r.anime });
    }
    let n = frames.len();
    let mut emb: Option<Vec<f32>> = None;
    let mut parts = Vec::new();
    let mut tags: std::collections::HashMap<usize, f32> = std::collections::HashMap::new();
    let mut anime: Option<(Vec<f32>, usize)> = None;
    for (i, frame) in frames.into_iter().enumerate() {
        let middle = n < 3 || (i > 0 && i + 1 < n);
        let one = engine::IndexOptions { parts: false, tag: options.tag && middle, ..options.clone() };
        let r = engine::index(app, &state, frame, &one)?;
        if let Some(e) = r.embedding {
            let acc = emb.get_or_insert_with(|| vec![0.0; e.len()]);
            for (a, v) in acc.iter_mut().zip(&e) {
                *a += v / n as f32;
            }
            parts.push(e);
        }
        for (idx, p) in r.tags.unwrap_or_default() {
            let t = tags.entry(idx).or_insert(0.0);
            *t = t.max(p);
        }
        if let Some(a) = r.anime {
            let (acc, k) = anime.get_or_insert_with(|| (vec![0.0; a.len()], 0));
            acc.iter_mut().zip(&a).for_each(|(x, y)| *x += y);
            *k += 1;
        }
    }
    let unit = |mut v: Vec<f32>| {
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
        v.iter_mut().for_each(|x| *x /= norm);
        v
    };
    let mut tags: Vec<(usize, f32)> = tags.into_iter().collect();
    tags.sort_by(|a, b| b.1.total_cmp(&a.1));
    Ok(ItemIndexed { embedding: emb.map(unit), parts, tags: options.tag.then_some(tags), anime: anime.map(|(a, _)| unit(a)) })
}

/// Folders that look like albums (numbered pages) outside the album folders and the trash.
#[tauri::command]
async fn albums_suggest(vs: VS<'_>, root: String, library: Library) -> Result<Vec<albums::AlbumGuess>, String> {
    let vs = vs.share();
    blocking(move || {
        let root = PathBuf::from(root);
        let mut skip = library.album_root_paths(&root);
        skip.push(library.trash_path(&root));
        // Every file under the opened folder, on disk and in the vault, as the Files screen sees them.
        Ok(with_ctx_read(&vs, &root, |ctx| {
            let files = ctx.list_files(&root, &skip);
            // A PDF outside the album folders is offered too (how likely it is a comic is asked after).
            let pdfs: Vec<PathBuf> = files.iter().map(|f| f.path.clone()).filter(|p| pdf::is_pdf(p) && !p.strip_prefix(&root).map(|r| r.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))).unwrap_or(true)).collect();
            let mut out = albums::guess_albums(&root, files, |p| ctx.vault_id(p));
            for p in pdfs {
                let Ok(mut pages) = albums::pdf_pages(ctx, &root, &p) else { continue };
                let count = pages.len();
                pages.truncate(3);
                out.push(albums::AlbumGuess { path: p.to_string_lossy().into_owned(), name: p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), count, ext: "pdf".into(), first: pages });
            }
            out
        }))
    })
    .await
}

/// One ffprobe value of a stream or the format: `-show_entries stream=width -select_streams v:0`.
fn probe_value(ffprobe: &str, path: &Path, select: Option<&str>, entries: &str) -> Option<String> {
    let mut cmd = std::process::Command::new(ffprobe);
    cmd.args(["-v", "error"]);
    if let Some(sel) = select {
        cmd.args(["-select_streams", sel]);
    }
    cmd.args(["-show_entries", entries, "-of", "csv=p=0"]).arg(path);
    let out = cmd.output().ok()?;
    let s = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// One video from two that overlap: what `other` has before `base` starts (its first `head`
/// seconds), then all of `base`, then what `other` has after `base` ends (from `tail_from` on).
/// Written next to `base` as `name`, re-encoded (the two may differ in codec or size).
#[tauri::command]
async fn video_combine(vs: VS<'_>, root: String, base: String, other: String, head: f64, tail_from: Option<f64>, name: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    let base = PathBuf::from(base);
    let other = PathBuf::from(other);
    let name = name.trim().to_string();
    if name.is_empty() || name.contains('/') {
        return Err("give the new video a plain file name".into());
    }
    let vs = vs.share();
    blocking(move || {
        let in_vault = with_ctx_read(&vs, &root, |ctx| ctx.vault_id(&base).is_some() || ctx.vault_id(&other).is_some());
        if in_vault {
            return Err("combining is not available for encrypted videos yet".into());
        }
        let dest = base.parent().ok_or("no folder")?.join(&name);
        if dest.exists() {
            return Err(format!("{name} exists already"));
        }
        let tools = edit::tools();
        let ffmpeg = tools.ffmpeg.as_deref().ok_or("ffmpeg is needed (brew install ffmpeg)")?;
        let ffprobe = tools.ffprobe.as_deref().ok_or("ffprobe is needed (brew install ffmpeg)")?;
        let dims = probe_value(ffprobe, &base, Some("v:0"), "stream=width,height").ok_or("could not read the base video")?;
        let (w, h) = dims.split_once(',').ok_or("could not read the base video's size")?;
        let (w, h): (u32, u32) = (w.trim().parse().map_err(|_| "size")?, h.trim().parse().map_err(|_| "size")?);
        let audio = probe_value(ffprobe, &base, Some("a"), "stream=index").is_some() && probe_value(ffprobe, &other, Some("a"), "stream=index").is_some();
        // The segments in order: [input, start, end]
        let mut segs: Vec<(usize, f64, Option<f64>)> = vec![];
        if head > 0.05 {
            segs.push((1, 0.0, Some(head)));
        }
        segs.push((0, 0.0, None));
        if let Some(t) = tail_from {
            segs.push((1, t, None));
        }
        let mut graph = String::new();
        let mut labels = String::new();
        for (i, (input, start, end)) in segs.iter().enumerate() {
            let range = match end {
                Some(e) => format!("start={start}:end={e}"),
                None => format!("start={start}"),
            };
            let fit = if *input == 1 { format!(",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1") } else { ",setsar=1".to_string() };
            graph.push_str(&format!("[{input}:v]trim={range},setpts=PTS-STARTPTS{fit}[v{i}];"));
            labels.push_str(&format!("[v{i}]"));
            if audio {
                graph.push_str(&format!("[{input}:a]atrim={range},asetpts=PTS-STARTPTS[a{i}];"));
                labels.push_str(&format!("[a{i}]"));
            }
        }
        graph.push_str(&format!("{labels}concat=n={}:v=1:a={}[v]{}", segs.len(), if audio { 1 } else { 0 }, if audio { "[a]" } else { "" }));
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]).arg("-i").arg(&base).arg("-i").arg(&other).args(["-filter_complex", &graph, "-map", "[v]"]);
        if audio {
            cmd.args(["-map", "[a]", "-c:a", "aac", "-b:a", "192k"]);
        }
        cmd.args(["-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]).arg(&dest);
        let out = cmd.output().map_err(|e| format!("start ffmpeg: {e}"))?;
        if !out.status.success() {
            let _ = fs::remove_file(&dest);
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("ffmpeg: {}", err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("failed").trim()));
        }
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
}

/// Small JPEG frames of a video at these seconds, as data URLs ("" where one failed): ffmpeg seeks
/// straight to each, four at a time. A vault's video is served to it piece by piece (`video_input`).
#[tauri::command]
async fn video_thumbs(vs: VS<'_>, root: String, path: String, times: Vec<f64>, width: u32) -> Result<Vec<String>, String> {
    let vs = vs.share();
    blocking(move || {
        use base64::Engine;
        let root = PathBuf::from(root);
        let p = PathBuf::from(&path);
        let tools = edit::tools();
        let ffmpeg = tools.ffmpeg.clone().ok_or("ffmpeg is needed (brew install ffmpeg)")?;
        let input = video_input(&vs, &root, &p)?;
        let src: PathBuf = input.arg.clone();
        let width = width.clamp(32, 640);
        let times: Vec<f64> = times.into_iter().take(64).collect();
        let found: Vec<(usize, String)> = std::thread::scope(|sc| {
            let handles: Vec<_> = (0..4)
                .map(|w| {
                    let (times, src, ffmpeg) = (&times, &src, &ffmpeg);
                    sc.spawn(move || {
                        let mut got = vec![];
                        for (i, t) in times.iter().enumerate().skip(w).step_by(4) {
                            let before = vec!["-ss".to_string(), format!("{:.3}", t.max(0.0))];
                            let after: Vec<String> = ["-frames:v", "1", "-vf", &format!("scale={width}:-2"), "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "pipe:1"].iter().map(|x| x.to_string()).collect();
                            if let Ok(jpg) = run_ffmpeg_to_stdout(ffmpeg, src, &before, &after)
                                && !jpg.is_empty()
                            {
                                got.push((i, format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&jpg))));
                            }
                        }
                        got
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        drop(input);
        let mut out = vec![String::new(); times.len()];
        for (i, url) in found {
            out[i] = url;
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
fn tags_cancel(app: tauri::AppHandle) {
    app.state::<IndexState>().0.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn tags_pause(app: tauri::AppHandle, on: bool) {
    app.state::<IndexState>().1.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// Words in the space of the picture-and-word model the folder's index was made with.
#[tauri::command]
async fn tags_embed_text(app: tauri::AppHandle, vs: VS<'_>, root: String, text: String) -> Result<Vec<f32>, String> {
    let vs = vs.share();
    blocking(move || {
        let embedder = with_tag_index(&vs, Path::new(&root), |ix| ix.embedder.clone())?;
        let embedder = if embedder.is_empty() { tagindex::FIRST_EMBEDDER.to_string() } else { embedder };
        engine::embed_text(&app, &app.state::<engine::EngineState>(), &text, &embedder)
    })
    .await
}

/// A tagger's tag names (the one the folder's index was made with), in the order of its numbers.
#[tauri::command]
async fn tags_tag_names(app: tauri::AppHandle, tagger: String) -> Result<serde_json::Value, String> {
    blocking(move || engine::tag_names(&app, &app.state::<engine::EngineState>(), &tagger)).await
}

/* ---------------- misc ---------------- */

/// Development aid: a passphrase from QUIRE_PASSPHRASE unlocks the launch folder's vault without the prompt.
#[tauri::command]
fn dev_passphrase() -> Option<String> {
    std::env::var("QUIRE_PASSPHRASE").ok().filter(|p| !p.is_empty())
}

/// The folder to open at launch: one given on the command line or in QUIRE_ROOT, else the
/// library open last time (`last`), when it is there (its drive plugged in).
#[tauri::command]
async fn initial_root(last: Option<String>) -> Result<Option<String>, String> {
    let given = std::env::args().nth(1).filter(|a| !a.starts_with('-')).or_else(|| std::env::var("QUIRE_ROOT").ok());
    blocking(move || Ok(given.or(last).filter(|p| Path::new(p).is_dir()))).await
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
/* ---------------- app icon ---------------- */

/// Replace the icon of the running app with a PNG rendered by the frontend in the
/// theme's colours. macOS: the Dock icon (Finder keeps the bundled one). Elsewhere:
/// every window's icon, which is what the taskbar shows.
#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(png) = request.body() else {
        return Err("expected raw PNG bytes".into());
    };
    let png = png.clone();
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(move || {
            use objc2::{AllocAnyThread, MainThreadMarker};
            use objc2_app_kit::{NSApplication, NSImage};
            use objc2_foundation::NSData;
            let Some(mtm) = MainThreadMarker::new() else { return };
            let data = NSData::with_bytes(&png);
            if let Some(img) = NSImage::initWithData(NSImage::alloc(), &data) {
                // SAFETY: called on the main thread with a valid NSImage.
                unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&img)) };
            }
        })
        .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let rgba = image::load_from_memory(&png).map_err(|e| e.to_string())?.to_rgba8();
        let (w, h) = rgba.dimensions();
        let icon = tauri::image::Image::new(rgba.as_raw(), w, h);
        for win in app.webview_windows().values() {
            win.set_icon(icon.clone()).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Whether a request to the app's own protocols (thumb://, vault://) came from the app's own window.
/// Every webview of the app can reach these protocols: a plugin's frame (msplugin://localhost, or
/// http://msplugin.localhost on Windows) and a site's sign-in or browser window too, and neither may
/// have the library's pictures. The Origin and Referer headers say who asked, when they are present:
/// the app's window (tauri://localhost, http://tauri.localhost, or the dev server at
/// http://localhost:<port>, any port) is let through and anyone else is refused. When neither header
/// is present the request is let through: WKWebView leaves both out of some of the main window's own
/// requests (an <img> tag's, say), and thumbnails that never show would be worse than this gap. The
/// plugin frames' own policy (`plugins::frame_csp`) keeps them from asking in the first place.
fn own_window_asked(headers: &tauri::http::HeaderMap) -> bool {
    let present = ["origin", "referer"].into_iter().filter_map(|h| headers.get(h)).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).collect::<Vec<_>>();
    present.iter().all(|v| own_origin(v))
}

/// Whether an Origin or Referer value names the app's own window.
fn own_origin(value: &str) -> bool {
    let v = value.trim();
    ["tauri://localhost", "http://tauri.localhost", "http://localhost"].iter().any(|own| v.strip_prefix(own).is_some_and(|rest| rest.is_empty() || rest.starts_with('/') || rest.starts_with(':') || rest.starts_with('?')))
}

/// The app's own window, when it asked with its Origin (a cross-origin load): named back to it in
/// `Access-Control-Allow-Origin`, so it may draw what it gets onto a canvas (a video's poster, a frame
/// for the duplicate check, a picture to cast or edit). Anyone else is refused (`own_window_asked`).
fn own_cors(headers: &tauri::http::HeaderMap) -> Option<String> {
    let origin = headers.get("origin")?.to_str().ok()?.trim();
    own_origin(origin).then(|| origin.to_string())
}

/// The vault protocol's answer for object `id`: decrypted, the range asked for or all of it.
fn vault_answer(v: Option<&Vault>, id: &str, range: Option<&str>, cors: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    let reply = |status: u16, body: Vec<u8>, extra: Vec<(&str, String)>| {
        let mut b = tauri::http::Response::builder().status(status).header("Accept-Ranges", "bytes");
        if let Some(origin) = cors {
            b = b.header("Access-Control-Allow-Origin", origin);
        }
        for (k, v) in extra {
            b = b.header(k, v);
        }
        b.body(body).unwrap()
    };
    let Some(v) = v else {
        return reply(423, b"vault is locked".to_vec(), vec![]);
    };
    let Some(entry) = v.entry_by_id(id).cloned() else {
        return reply(404, b"no such object".to_vec(), vec![]);
    };
    let ct = content_type(&entry.rel).to_string();
    match vault::parse_range(range, entry.size) {
        Some((start, end)) => match v.read_range(id, start, end) {
            Ok(bytes) => reply(206, bytes, vec![("Content-Type", ct), ("Content-Range", format!("bytes {start}-{}/{}", end - 1, entry.size)), ("Content-Length", (end - start).to_string())]),
            Err(e) => reply(500, e.into_bytes(), vec![]),
        },
        None if range.is_some() => reply(416, vec![], vec![("Content-Range", format!("bytes */{}", entry.size))]),
        None => match v.read_all(id) {
            Ok(bytes) => reply(200, bytes, vec![("Content-Type", ct), ("Content-Length", entry.size.to_string())]),
            Err(e) => reply(500, e.into_bytes(), vec![]),
        },
    }
}

/// The answer to a request from anywhere but the app's own window.
fn refused() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder().status(403).header("Content-Type", "text/plain").body(b"only the app's own window may ask for this".to_vec()).unwrap()
}

pub fn run() {
    // Before the window opens, which reads its saved settings as it does.
    #[cfg(target_os = "macos")]
    formerly::adopt_webview_data();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(VaultState::default())
        .manage(Claim::default())
        .manage(update::UpdateState::default())
        .manage(engine::EngineState::default())
        .manage(IndexState::default())
        .manage(CastState::default())
        .setup(|app| {
            // A bundled app ships pdfium among its resources.
            if let Ok(dir) = app.path().resource_dir() {
                pdf::bundled_in(dir);
            }
            formerly::adopt_app_folders(app);
            // Find's downloads waiting for Import are gone with the app: any left (it quit or
            // crashed while they waited) go now.
            if let Ok(dir) = find_staging(app.handle()) {
                let _ = std::fs::remove_dir_all(dir);
            }
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = DATA_DIR.set(dir);
            }
            let base = plugin_base(app);
            app.manage(PluginsState(base));
            Ok(())
        })
        // msplugin://localhost/<id>/<file>: plugin files, plus the frame shell and SDK.
        .register_asynchronous_uri_scheme_protocol("msplugin", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            std::thread::spawn(move || {
                let resp = match registry(&app).ok().and_then(|reg| plugins::serve(&reg, &path)) {
                    // The plugin's frame policy on everything of its (see `plugins::frame_csp`).
                    Some(served) => tauri::http::Response::builder().status(200).header("Content-Type", served.content_type).header("Cache-Control", "no-store").header("Content-Security-Policy", served.csp).body(served.body).unwrap(),
                    None => tauri::http::Response::builder().status(404).body(b"not found".to_vec()).unwrap(),
                };
                if std::env::var_os("QUIRE_DEBUG").is_some() {
                    eprintln!("[msplugin://] {path} -> {}", resp.status());
                }
                responder.respond(resp);
            });
        })
        // vault://localhost/<id>  (http://vault.localhost/<id> on Windows): decrypts on demand with Range support.
        // thumb://localhost/<path>?w=<width>&root=<root>: a small copy of a picture for the grids.
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, request, responder| {
            if !own_window_asked(request.headers()) {
                return responder.respond(refused());
            }
            let app = ctx.app_handle().clone();
            let uri = request.uri().clone();
            let cors = own_cors(request.headers());
            tauri::async_runtime::spawn_blocking(move || {
                let (status, mime, body) = match thumb_for(&app, &uri) {
                    Ok(t) => (200, t.mime, t.bytes.clone()),
                    Err((status, msg)) => (status, "text/plain", msg.into_bytes()),
                };
                let mut reply = tauri::http::Response::builder()
                    .status(status)
                    .header("Content-Type", mime)
                    // The URL names the file's version (v=), so a copy stays good.
                    .header("Cache-Control", "private, max-age=86400");
                if let Some(origin) = cors {
                    reply = reply.header("Access-Control-Allow-Origin", origin);
                }
                responder.respond(reply.body(body).unwrap());
            });
        })
        .register_asynchronous_uri_scheme_protocol("vault", |ctx, request, responder| {
            if !own_window_asked(request.headers()) {
                return responder.respond(refused());
            }
            let app = ctx.app_handle().clone();
            let debug = std::env::var_os("QUIRE_DEBUG").is_some();
            if debug {
                eprintln!("[vault://] {} {} range={:?}", request.method(), request.uri(), request.headers().get("range"));
            }
            let id = request.uri().path().trim_start_matches('/').to_string();
            let range = request.headers().get("range").and_then(|v| v.to_str().ok()).map(String::from);
            let cors = own_cors(request.headers());
            // On the shared pool, not a new thread per request; readers share the vault.
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<VaultState>();
                let guard = state.0.read().unwrap_or_else(|p| p.into_inner());
                let reply = vault_answer(guard.as_ref(), &id, range.as_deref(), cors.as_deref());
                if debug {
                    eprintln!("[vault://] -> {} ({} bytes) {:?}", reply.status(), reply.body().len(), reply.headers());
                }
                responder.respond(reply);
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
            drive_open_app,
            pdf_pages,
            pdf_comic,
            backup_plan,
            backup_run,
            cancel_backup,
            vault_status,
            vault_create,
            vault_unlock,
            vault_unlock_recovery,
            vault_unlock_quick,
            vault_remember,
            vault_forget,
            vault_lock,
            vault_change_passphrase,
            vault_reset_passphrase,
            vault_new_recovery_code,
            vault_encrypt_all,
            vault_unsharded,
            vault_adopt,
            vault_shard,
            vault_export,
            vault_remove,
            edit_tools,
            edit_apply,
            plugin_list,
            plugin_inspect,
            plugin_install,
            plugin_set_state,
            plugin_uninstall,
            plugin_check_updates,
            library_claim,
            library_adopt_names,
            library_release,
            update::app_build,
            update::app_update_check,
            update::app_update_download,
            update::app_update_install,
            plugin_update,
            plugin_storage_get,
            plugin_storage_set,
            plugin_settings_get,
            plugin_settings_set,
            plugin_fetch,
            plugin_library_get,
            plugin_library_set,
            plugin_login,
            plugin_check,
            plugin_browse,
            plugin_sites_set,
            plugin_login_close,
            find_image,
            find_image_hash,
            find_state_load,
            find_state_save,
            artists_load,
            artists_save,
            faces_load,
            faces_scan,
            faces_mark,
            faces_sort,
            faces_rename,
            faces_forget,
            people_load,
            people_save,
            home_load,
            home_save,
            artist_avatar_save,
            find_download,
            find_clear,
            plugin_engine_run,
            engine_models,
            hardware,
            engine_store_get,
            engine_store_set,
            media_info,
            load_tags,
            save_tags,
            tags_index,
            tags_cancel,
            tags_pause,
            tags_embed_text,
            tags_tag_names,
            albums_suggest,
            video_combine,
            video_thumbs,
            engine_choose,
            engine_download,
            engine_cancel_download,
            engine_remove,
            plugin_log,
            read_media_image,
            write_media_file,
            replace_media_file,
            versions_load,
            version_info,
            version_revert,
            kept_originals,
            kept_originals_forget,
            list_dir,
            fs_mkdir,
            fs_move,
            fs_rename,
            fs_delete,
            initial_root,
            dev_passphrase,
            set_app_icon,
            tags_index_load,
            tags_index_rename,
            tags_index_forget,
            views_load,
            views_save,
            plugin_library_forget,
            versions_follow,
            tags_predict,
            tags_candidates,
            tags_search,
            tags_index_restamp,
            scrapbook_load,
            scrapbook_save,
            scrapbook_blob,
            scrapbook_blob_put,
            scrapbook_blob_delete,
            scrapbook_export,
            snapshot_load,
            cast_start,
            cast_stop,
            cast_frame,
            cast_status,
            cast_decide,
            cast_remote,
            snapshot_save,
            import_scan,
            import_fingerprints,
            import_files,
            scrapbook_cutout,
            tags_rank,
            tags_scores,
            job_pause,
            job_stop
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // What indexing found since its last save is written before the app goes.
            if let tauri::RunEvent::Exit = event {
                let vs = app.state::<VaultState>();
                let _ = flush_tag_index(&vs, true);
                if let Some(v) = vs.0.write().unwrap_or_else(|p| p.into_inner()).as_mut() {
                    let _ = v.flush();
                }
            }
        });
}

#[cfg(test)]
mod import_tests {
    use super::*;

    #[test]
    fn names_from_a_platform_stay_file_names() {
        assert_eq!(safe_file_name("12345_1.png"), "12345_1.png");
        assert_eq!(safe_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_file_name(".hidden"), "hidden");
        assert_eq!(safe_file_name("  "), "file");
        assert_eq!(safe_file_name(&"x".repeat(300)).len(), 120);
    }

    #[test]
    fn a_copied_file_keeps_its_time_and_takes_a_free_name() {
        let dir = std::env::temp_dir().join(format!("ms-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (from, to) = (dir.join("card"), dir.join("lib/Private/2026/2026-10-28"));
        std::fs::create_dir_all(&from).unwrap();
        let src = from.join("IMG_0001.JPG");
        std::fs::write(&src, b"picture").unwrap();
        let then = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        std::fs::File::options().write(true).open(&src).unwrap().set_modified(then).unwrap();
        let a = copy_plain(&src, &to).unwrap();
        assert_eq!(a, to.join("IMG_0001.JPG"));
        assert_eq!(std::fs::metadata(&a).unwrap().modified().unwrap(), then);
        // The same name again: beside it, not over it.
        let b = copy_plain(&src, &to).unwrap();
        assert_ne!(a, b);
        assert!(b.file_name().unwrap().to_string_lossy().starts_with("IMG_0001"));
        assert_eq!(std::fs::read(&b).unwrap(), b"picture");
        assert!(src.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}


#[cfg(test)]
mod own_protocol_tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> tauri::http::HeaderMap {
        let mut h = tauri::http::HeaderMap::new();
        for (k, v) in pairs {
            h.insert(tauri::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), tauri::http::HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn only_the_apps_own_window_gets_its_pictures() {
        // The app's window, on each platform and from the dev server.
        assert!(own_window_asked(&headers(&[("origin", "tauri://localhost")])));
        assert!(own_window_asked(&headers(&[("origin", "http://tauri.localhost")])));
        assert!(own_window_asked(&headers(&[("origin", "http://localhost:1420")])));
        assert!(own_window_asked(&headers(&[("referer", "http://localhost:1420/browse?x=1")])));
        assert!(own_window_asked(&headers(&[("referer", "tauri://localhost/")])));
        // Nothing said: let through (the main window's own <img> requests may carry neither).
        assert!(own_window_asked(&headers(&[])));
        // A plugin's frame (opaque origin, or its protocol), a site's window, a look-alike host.
        assert!(!own_window_asked(&headers(&[("origin", "null")])));
        assert!(!own_window_asked(&headers(&[("origin", "msplugin://localhost")])));
        assert!(!own_window_asked(&headers(&[("origin", "http://msplugin.localhost")])));
        assert!(!own_window_asked(&headers(&[("referer", "https://example.org/page")])));
        assert!(!own_window_asked(&headers(&[("origin", "http://localhost.example.org")])));
        assert!(!own_window_asked(&headers(&[("origin", "http://tauri.localhost.example.org")])));
        // One good header does not excuse a bad one.
        assert!(!own_window_asked(&headers(&[("origin", "tauri://localhost"), ("referer", "https://example.org/")])));
    }

    #[test]
    fn the_window_may_draw_what_its_own_protocols_send() {
        // A cross-origin load from the app's window (a video's poster, a frame for the duplicate check,
        // a picture to cast) is told it may read what it gets; without that the webview won't draw it.
        assert_eq!(own_cors(&headers(&[("origin", "tauri://localhost")])).as_deref(), Some("tauri://localhost"));
        assert_eq!(own_cors(&headers(&[("origin", "http://localhost:1420")])).as_deref(), Some("http://localhost:1420"));
        // Nobody else, and nothing to name when the window didn't say.
        assert_eq!(own_cors(&headers(&[("origin", "null")])), None);
        assert_eq!(own_cors(&headers(&[("origin", "msplugin://localhost")])), None);
        assert_eq!(own_cors(&headers(&[("referer", "tauri://localhost/")])), None);
    }

    #[test]
    fn a_video_in_the_vault_comes_in_ranges_the_window_may_draw() {
        let root = std::env::temp_dir().join(format!("quire-vault-answer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let clip: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(root.join("clip.mp4"), &clip).unwrap();
        let mut v = Vault::create(&root, "correct horse battery staple").unwrap();
        let id = v.add_file(&root.join("clip.mp4"), "Clips/clip.mp4").unwrap().id;
        let own = Some("tauri://localhost");
        let header = |r: &tauri::http::Response<Vec<u8>>, k: &str| r.headers().get(k).map(|v| v.to_str().unwrap().to_string());

        // The poster's <video> asks for a range: it gets it, decrypted, and may draw it.
        let r = vault_answer(Some(&v), &id, Some("bytes=100-199"), own);
        assert_eq!(r.status(), 206);
        assert_eq!(r.body(), &clip[100..200]);
        assert_eq!(header(&r, "Access-Control-Allow-Origin").as_deref(), own);
        assert_eq!(header(&r, "Content-Type").as_deref(), Some("video/mp4"));
        assert_eq!(header(&r, "Content-Range").as_deref(), Some("bytes 100-199/5000"));
        // All of it, as a picture to cast would be.
        let r = vault_answer(Some(&v), &id, None, own);
        assert_eq!((r.status().as_u16(), r.body().len()), (200, clip.len()));
        assert_eq!(header(&r, "Access-Control-Allow-Origin").as_deref(), own);
        // An <img> or <video> without crossorigin names no origin, and none is named back.
        assert_eq!(header(&vault_answer(Some(&v), &id, None, None), "Access-Control-Allow-Origin"), None);
        // Past the end, a missing object, a locked vault.
        assert_eq!(vault_answer(Some(&v), &id, Some("bytes=9000-"), own).status(), 416);
        assert_eq!(vault_answer(Some(&v), "nope", None, own).status(), 404);
        assert_eq!(vault_answer(None, &id, None, own).status(), 423);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod encrypt_tests {
    use super::*;

    #[test]
    fn a_vault_kept_in_one_folder_reads_as_it_is_and_moves_into_folders() {
        let root = std::env::temp_dir().join(format!("ms-shard-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let mut v = Vault::create(&root, "a long enough passphrase").unwrap();
        let keys = v.keys();
        let objects = v.objects_dir();
        let thumbs = root.join(vault::VAULT_DIR).join("meta").join("thumbs");
        // As an earlier version kept them: every object and thumbnail in the folder itself.
        let mut ids = Vec::new();
        for n in 0..30u8 {
            let s = keys.seal_stream(&mut &[n; 100][..], 1).unwrap();
            let id = v.commit(s, &format!("p/{n}.jpg")).unwrap().id;
            fs::rename(vault::shard(&objects, &id), objects.join(&id)).unwrap();
            v.write_thumb(&format!("{id}-192"), &[n; 5]).unwrap();
            fs::rename(vault::shard(&thumbs, &format!("{id}-192.enc")), thumbs.join(format!("{id}-192.enc"))).unwrap();
            ids.push(id);
        }
        v.flush().unwrap();
        assert!(v.has_unsharded());
        assert_eq!(v.read_all(&ids[3]).unwrap(), [3u8; 100], "read where it is");
        assert_eq!(v.read_thumb(&format!("{}-192", ids[3])).unwrap(), [3u8; 5]);
        // A new one goes into its folder at once.
        let s = keys.seal_stream(&mut &b"new"[..], 1).unwrap();
        assert!(vault::shard(&objects, s.id()).is_file());
        keys.discard(s);

        let plan = v.unsharded();
        assert_eq!(plan.len(), 60);
        // Stopped after ten, then the rest.
        assert_eq!(move_into_folders(&plan, &objects, |i| i < 10, |_| {}).unwrap(), 10);
        assert_eq!(move_into_folders(&v.unsharded(), &objects, |_| true, |_| {}).unwrap(), 50);
        assert!(!v.has_unsharded());
        assert!(fs::read_dir(&objects).unwrap().flatten().all(|e| e.file_type().unwrap().is_dir()), "only folders left in the objects folder");
        for (n, id) in ids.iter().enumerate() {
            assert_eq!(v.read_all(id).unwrap(), [n as u8; 100]);
            assert_eq!(v.read_thumb(&format!("{id}-192")).unwrap(), [n as u8; 5]);
        }
        // Taken out of the vault, from its folder.
        v.remove("p/3.jpg").unwrap();
        assert!(!vault::shard(&objects, &ids[3]).exists() && !vault::shard(&thumbs, &format!("{}-192.enc", ids[3])).exists());
        let _ = fs::remove_dir_all(&root);
    }

    /// On a FAT drive (`MS_FAT_DIR` names a folder on one, a disk image made with hdiutil, say):
    /// thumbnails written from many threads at once take their turn, and a vault of thousands of
    /// files kept in one folder moves into its folders.
    #[test]
    #[ignore]
    fn on_a_fat_drive() {
        let Some(dir) = std::env::var_os("MS_FAT_DIR") else { return };
        let root = PathBuf::from(dir).join(format!("vault-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(fsx::fs_kind(&root).as_deref(), Some("msdos"));
        assert!(fsx::is_fat(&root) && fsx::one_at_a_time(&root).is_some());
        let v = Vault::create(&root, "a long enough passphrase").unwrap();
        let t = std::time::Instant::now();
        std::thread::scope(|s| {
            for k in 0..16u32 {
                let v = &v;
                s.spawn(move || {
                    for n in 0..100u32 {
                        v.write_thumb(&format!("{:032x}-192", k * 1000 + n), &[k as u8; 3000]).unwrap();
                    }
                });
            }
        });
        eprintln!("1,600 thumbnails from 16 threads at once: {:?}", t.elapsed());
        assert_eq!(v.read_thumb(&format!("{:032x}-192", 15 * 1000 + 99)).unwrap(), [15u8; 3000]);
        // 3,000 objects as earlier versions kept them, all in the objects folder.
        let objects = v.objects_dir();
        for n in 0..3000u32 {
            fs::write(objects.join(format!("{n:032x}")), b"x").unwrap();
        }
        let t = std::time::Instant::now();
        let plan = v.unsharded();
        assert_eq!(plan.len(), 3000);
        assert_eq!(move_into_folders(&plan, &objects, |_| true, |_| {}).unwrap(), 3000);
        assert!(!v.has_unsharded());
        eprintln!("3,000 objects moved into their folders: {:?}", t.elapsed());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_encrypted_file_is_its_size_and_a_tag_a_chunk() {
        assert_eq!(vault::encrypted_size(0), 32 + 16);
        assert_eq!(vault::encrypted_size(vault::CHUNK as u64), 32 + vault::CHUNK as u64 + 16);
        assert_eq!(vault::encrypted_size(vault::CHUNK as u64 + 1), 32 + vault::CHUNK as u64 + 1 + 32);
        // Just under 4 GB in the clear is over FAT32's limit encrypted.
        assert!(vault::encrypted_size(FAT32_MAX_FILE - 1000) > FAT32_MAX_FILE);
    }

    #[test]
    fn a_folder_is_encrypted_in_batches_and_every_original_goes_once_named() {
        let root = std::env::temp_dir().join(format!("ms-encrypt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let content = |n: usize| vec![n as u8; 1000 + n];
        for n in 0..40 {
            let dir = root.join(format!("d{}", n % 4));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(format!("{n}.jpg")), content(n)).unwrap();
        }
        let pass = "a long enough passphrase";
        let vs: VaultLock = RwLock::new(Some(Vault::create(&root, pass).unwrap()));
        // A name already in the vault: the file that still has it is kept beside it, not over it.
        let outside = std::env::temp_dir().join(format!("ms-encrypt-earlier-{}", std::process::id()));
        fs::write(&outside, b"earlier").unwrap();
        vs.write().unwrap().as_mut().unwrap().add_file(&outside, "d0/0.jpg").unwrap();
        let _ = fs::remove_file(&outside);

        let quiet = tauri::ipc::Channel::new(|_| Ok(()));
        assert_eq!(encrypt_all(&vs, root.clone(), None, quiet).unwrap(), 40);
        assert!(fsx::plaintext_files(&root).is_empty(), "every original is gone");

        // Read back from the drive, not from memory: the index naming them was written.
        let v = Vault::unlock(&root, pass).unwrap();
        assert_eq!(v.entries().len(), 41);
        assert_eq!(v.read_all(&v.entry_by_rel("d0/0.jpg").unwrap().id.clone()).unwrap(), b"earlier");
        for n in 1..40 {
            let e = v.entry_by_rel(&format!("d{}/{n}.jpg", n % 4)).unwrap_or_else(|| panic!("{n} is named"));
            assert_eq!(v.read_all(&e.id.clone()).unwrap(), content(n));
        }
        let kept = v.entries().iter().find(|e| e.rel.starts_with("d0/0") && e.rel != "d0/0.jpg").expect("the second 0.jpg under a name of its own");
        assert_eq!(v.read_all(&kept.id.clone()).unwrap(), content(0));
        let objects = root.join(vault::VAULT_DIR).join("objects");
        let files = fs::read_dir(&objects).unwrap().flatten().flat_map(|d| fs::read_dir(d.path()).into_iter().flatten().flatten()).count();
        assert_eq!(files, 41, "no object left over, each in its folder");
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod claim_tests {
    use super::*;

    fn dirs(tag: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("ms-claim-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (lib, other, dir) = (base.join("Library"), base.join("Other"), base.join("data"));
        fs::create_dir_all(&lib).unwrap();
        fs::create_dir_all(&other).unwrap();
        (base, lib, other, dir)
    }

    #[test]
    fn a_second_copy_of_the_app_cant_open_the_same_library() {
        let (base, lib, other, dir) = dirs("two");
        let (mut first, mut second) = (None, None);
        take_claim(&mut first, &lib, &dir).unwrap();
        let lib_name = first.as_ref().unwrap().name.clone();
        // The same library with its path written another way is still this copy's own.
        take_claim(&mut first, &lib.join("."), &dir).unwrap();
        let refused = take_claim(&mut second, &lib, &dir).unwrap_err();
        assert!(refused.contains("another copy") && refused.contains(&format!("process {}", std::process::id())), "{refused}");
        assert!(refused.contains(if cfg!(debug_assertions) { "a dev build" } else { "the released app" }), "it says which copy: {refused}");
        assert!(second.is_none());
        take_claim(&mut second, &other, &dir).unwrap();
        // The first opens another library: the first one is free for the second copy.
        assert!(take_claim(&mut first, &other, &dir).is_err(), "taken by the second copy");
        assert_eq!(first.as_ref().map(|h| h.name.clone()), Some(lib_name), "a refused claim keeps the one held");
        first = None;
        take_claim(&mut second, &lib, &dir).unwrap();
        assert!(first.is_none());
        let _ = fs::remove_dir_all(&base);
    }

    // Windows lets a lock go with the process that held it, and no copy there is stuck quitting.
    #[cfg(unix)]
    #[test]
    fn a_copy_stuck_quitting_or_gone_doesnt_keep_the_library_shut() {
        let (base, lib, _, dir) = dirs("stuck");
        let mut stuck = None;
        take_claim(&mut stuck, &lib, &dir).unwrap();
        // That copy's lock is still held (as by a process that can't finish quitting), but its note
        // names a process that is no longer running.
        let name = &stuck.as_ref().unwrap().name;
        Holder { pid: 2_000_000_000, dev: false, since: 0 }.write(&dir.join(format!("{name}.holder")));
        let mut here = None;
        take_claim(&mut here, &lib, &dir).unwrap();
        // It is held again, by this copy: a third copy is still turned away.
        let refused = take_claim(&mut None, &lib, &dir).unwrap_err();
        assert!(refused.contains(&format!("process {}", std::process::id())), "{refused}");
        drop(stuck);
        let _ = fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod document_safety_tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-docsafety-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn nothing_is_written_in_the_clear_beside_a_locked_vault() {
        let root = tmp("locked");
        drop(Vault::create(&root, "a long enough passphrase").unwrap());
        // As a save still waiting when the vault was locked, or a job still running, would try.
        let vs: VaultLock = RwLock::new(None);
        let library = Library::default();
        assert_eq!(with_ctx(&vs, &root, |ctx| ctx.save_meta("history", "{}")).unwrap_err(), fsx::LOCKED);
        assert!(with_ctx(&vs, &root, |ctx| ctx.save_meta_bytes("tagvectors", &[1])).is_err());
        assert!(with_ctx(&vs, &root, |ctx| ctx.append_meta_record("tagjournal.1", b"x")).is_err());
        assert!(with_ctx(&vs, &root, |ctx| ctx.save_blob("sticker-a1.png", b"x")).is_err());
        assert!(with_ctx(&vs, &root, |ctx| if ctx.vault.is_some() { Ok(()) } else { ctx.not_beside_a_locked_vault().and_then(|_| library.save(&root)) }).is_err());
        let clear: Vec<String> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != vault::VAULT_DIR).collect();
        assert!(clear.is_empty(), "written in the clear: {clear:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_document_that_wont_read_is_never_saved_over_until_it_reads() {
        let root = tmp("unreadable");
        let v = Vault::create(&root, "a long enough passphrase").unwrap();
        v.write_meta("home", br#"{"blocks":[1,2,3]}"#).unwrap();
        let meta = root.join(vault::VAULT_DIR).join("meta").join("home.enc");
        let good = fs::read(&meta).unwrap();
        // The drive gives back something else for a moment: it won't decrypt.
        fs::write(&meta, b"garbage that isn't the document").unwrap();
        let vs: VaultLock = RwLock::new(Some(v));
        let r = root.to_string_lossy().into_owned();
        assert!(load_json(&vs, &r, "home").is_err());
        // The screen started empty, and tries to save that.
        assert!(save_json(&vs, &r, "home", &serde_json::json!({ "blocks": [] })).unwrap_err().contains("not saved over it"));
        assert_eq!(fs::read(&meta).unwrap(), b"garbage that isn't the document", "left as it was");
        // It reads again: saves go through.
        fs::write(&meta, &good).unwrap();
        assert_eq!(load_json(&vs, &r, "home").unwrap(), serde_json::json!({ "blocks": [1, 2, 3] }));
        save_json(&vs, &r, "home", &serde_json::json!({ "blocks": [1] })).unwrap();
        let _ = fs::remove_dir_all(&root);
    }
}
