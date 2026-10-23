mod dupes;
mod library;
mod media;
mod ops;
mod preview;

use library::{resolve, Library};
use media::MediaItem;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::Response;

#[tauri::command]
fn load_library(root: String) -> Result<Library, String> {
    Library::load(Path::new(&root))
}

#[tauri::command]
fn save_library(root: String, library: Library) -> Result<(), String> {
    library.save(Path::new(&root))
}

/// Scan the unsorted part of the root: everything except the trash folder and
/// the target folders that live inside the root.
#[tauri::command]
async fn scan_unsorted(root: String, library: Library) -> Result<Vec<MediaItem>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let mut exclude: Vec<PathBuf> = library.targets.iter().map(|t| resolve(&root, &t.path)).collect();
    exclude.push(library.trash_path(&root));
    Ok(media::scan(&root, &root, &exclude))
}

/// Everything under the root (minus the trash folder) plus any target folders
/// that live outside the root. Items inside a target folder carry its id.
#[tauri::command]
async fn scan_all(root: String, library: Library) -> Result<Vec<MediaItem>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let trash = library.trash_path(&root);
    let targets: Vec<(String, PathBuf)> = library
        .targets
        .iter()
        .map(|t| (t.id.clone(), resolve(&root, &t.path)))
        .collect();
    let mut items = media::scan(&root, &root, &[trash.clone()]);
    for (_, dir) in &targets {
        if !dir.starts_with(&root) && dir.is_dir() {
            items.extend(media::scan(&root, dir, &[trash.clone()]));
        }
    }
    for item in &mut items {
        let p = Path::new(&item.primary);
        // Deepest matching target wins when targets are nested.
        item.target_id = targets
            .iter()
            .filter(|(_, dir)| p.starts_with(dir))
            .max_by_key(|(_, dir)| dir.components().count())
            .map(|(id, _)| id.clone());
    }
    Ok(items)
}

/// Scan one target folder (sorted media).
#[tauri::command]
async fn scan_dir(root: String, dir: String) -> Result<Vec<MediaItem>, String> {
    let root = PathBuf::from(root);
    let dir = resolve(&root, &dir);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    Ok(media::scan(&root, &dir, &[]))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveResult {
    /// (old absolute path, new absolute path) pairs
    moved: Vec<(String, String)>,
    item: MediaItem,
}

fn rebuild_item(root: &Path, item: &MediaItem, new_files: &[PathBuf]) -> MediaItem {
    let idx = item
        .files
        .iter()
        .position(|f| f == &item.primary)
        .unwrap_or(0);
    let primary = &new_files[idx];
    let parent = primary.parent().unwrap_or(root);
    MediaItem {
        key: media::rel_key(root, primary),
        primary: primary.to_string_lossy().into_owned(),
        files: new_files.iter().map(|f| f.to_string_lossy().into_owned()).collect(),
        dir: media::rel_key(root, parent),
        ..item.clone()
    }
}

/// Move an item (all of its files) into `dest`, a stored target path.
#[tauri::command]
async fn move_item(root: String, item: MediaItem, dest: String) -> Result<MoveResult, String> {
    let root = PathBuf::from(root);
    let dest_dir = resolve(&root, &dest);
    let files: Vec<PathBuf> = item.files.iter().map(PathBuf::from).collect();
    let new_files = ops::move_group(&files, &dest_dir)?;
    let moved = files
        .iter()
        .zip(new_files.iter())
        .map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()))
        .collect();
    Ok(MoveResult { moved, item: rebuild_item(&root, &item, &new_files) })
}

/// Move an item into the trash folder inside the opened root.
#[tauri::command]
async fn trash_item(root: String, library: Library, item: MediaItem) -> Result<MoveResult, String> {
    let root = PathBuf::from(root);
    let trash = library.trash_path(&root);
    let files: Vec<PathBuf> = item.files.iter().map(PathBuf::from).collect();
    let new_files = ops::move_group(&files, &trash)?;
    let moved = files
        .iter()
        .zip(new_files.iter())
        .map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()))
        .collect();
    Ok(MoveResult { moved, item: rebuild_item(&root, &item, &new_files) })
}

/// Undo helper: move exact files back to exact paths (no renaming).
#[tauri::command]
async fn restore_files(moves: Vec<(String, String)>) -> Result<(), String> {
    // moves are (original, current); put them back.
    for (orig, cur) in &moves {
        let orig = PathBuf::from(orig);
        let cur = PathBuf::from(cur);
        if let Some(parent) = orig.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if orig.exists() {
            return Err(format!("cannot restore, {} already exists", orig.display()));
        }
        std::fs::rename(&cur, &orig).map_err(|e| format!("restore {}: {e}", orig.display()))?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrashInfo {
    path: String,
    files: usize,
    bytes: u64,
}

#[tauri::command]
fn trash_info(root: String, library: Library) -> TrashInfo {
    let root = PathBuf::from(root);
    let trash = library.trash_path(&root);
    let (files, bytes) = if trash.exists() { ops::dir_size(&trash) } else { (0, 0) };
    TrashInfo { path: trash.to_string_lossy().into_owned(), files, bytes }
}

#[tauri::command]
async fn empty_trash(root: String, library: Library) -> Result<usize, String> {
    let root = PathBuf::from(root);
    ops::purge_dir(&library.trash_path(&root))
}

#[tauri::command]
async fn scan_trash(root: String, library: Library) -> Result<Vec<MediaItem>, String> {
    let root = PathBuf::from(root);
    let trash = library.trash_path(&root);
    if !trash.is_dir() {
        return Ok(vec![]);
    }
    Ok(media::scan(&root, &trash, &[]))
}

/// Perceptual hashes of an image (or a RAW file's embedded preview).
#[tauri::command]
async fn image_hash(path: String, is_raw: bool) -> Result<dupes::ImageHash, String> {
    tauri::async_runtime::spawn_blocking(move || dupes::image_hash(Path::new(&path), is_raw))
        .await
        .map_err(|e| e.to_string())?
}

/// Cheap content fingerprint for exact-duplicate detection.
#[tauri::command]
async fn file_fingerprint(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || dupes::file_fingerprint(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

const CACHE_FILE: &str = ".mediasorter.cache.json";

/// Opaque JSON cache (fingerprints, hashes) stored next to the library file.
#[tauri::command]
fn load_cache(root: String) -> Result<serde_json::Value, String> {
    let p = Path::new(&root).join(CACHE_FILE);
    if !p.exists() {
        return Ok(serde_json::Value::Null);
    }
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
fn save_cache(root: String, cache: serde_json::Value) -> Result<(), String> {
    let p = Path::new(&root).join(CACHE_FILE);
    let tmp = Path::new(&root).join(format!("{CACHE_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(&cache).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Raw bytes of the JPEG embedded in a RAW file, for display.
#[tauri::command]
async fn raw_preview(path: String) -> Result<Response, String> {
    preview::embedded_jpeg(Path::new(&path)).map(Response::new)
}

/// Folder to open at launch: first CLI argument or MEDIA_SORTER_ROOT.
#[tauri::command]
fn initial_root() -> Option<String> {
    std::env::args()
        .nth(1)
        .filter(|a| !a.starts_with('-'))
        .or_else(|| std::env::var("MEDIA_SORTER_ROOT").ok())
        .filter(|p| Path::new(p).is_dir())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_library,
            save_library,
            scan_unsorted,
            scan_all,
            scan_dir,
            move_item,
            trash_item,
            restore_files,
            trash_info,
            empty_trash,
            scan_trash,
            raw_preview,
            image_hash,
            file_fingerprint,
            load_cache,
            save_cache,
            initial_root,
            path_exists,
            create_dir,
            resolve_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
