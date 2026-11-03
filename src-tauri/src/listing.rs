//! The folder tree, remembered between scans. Opening a library, and every move,
//! trash or rename, used to walk the whole tree again with a read of every file's
//! size and time. Now each folder's listing is kept, and a scan only checks each
//! folder's own modified time: adding, removing or renaming anything in a folder
//! changes it, so an unchanged folder's listing is used as is. A file changed in
//! place leaves its folder's time alone; the file watcher catches those.
//! Folders not known yet are read on several threads at once.

use crate::media::FileRef;
use notify::{RecursiveMode, Watcher};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

struct Listing {
    /// The folder's modified time when it was read.
    stamp: SystemTime,
    files: Vec<FileRef>,
    dirs: Vec<PathBuf>,
}

fn known() -> &'static Mutex<HashMap<PathBuf, Arc<Listing>>> {
    static K: OnceLock<Mutex<HashMap<PathBuf, Arc<Listing>>>> = OnceLock::new();
    K.get_or_init(Default::default)
}

fn hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// One folder's files and subfolders (hidden ones and links left out), from memory when the
/// folder hasn't changed since.
fn listing(dir: &Path) -> Option<Arc<Listing>> {
    // The time first, then the entries: a change while reading leaves an older time, so the
    // next scan reads the folder again.
    let stamp = fs::symlink_metadata(dir).ok()?.modified().ok()?;
    if let Some(l) = known().lock().unwrap_or_else(|p| p.into_inner()).get(dir)
        && l.stamp == stamp
    {
        return Some(l.clone());
    }
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for e in fs::read_dir(dir).ok()?.flatten() {
        if hidden(&e.file_name()) {
            continue;
        }
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            dirs.push(e.path());
        } else if t.is_file()
            && let Ok(m) = e.metadata()
        {
            files.push(FileRef { path: e.path(), size: m.len(), modified: m.modified().map(ms).unwrap_or(0) });
        }
    }
    let l = Arc::new(Listing { stamp, files, dirs });
    known().lock().unwrap_or_else(|p| p.into_inner()).insert(dir.to_path_buf(), l.clone());
    Some(l)
}

/// Listings for many folders, read side by side.
fn listings(dirs: &[PathBuf]) -> Vec<Arc<Listing>> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
    if dirs.len() < 8 {
        return dirs.iter().filter_map(|d| listing(d)).collect();
    }
    let chunk = dirs.len().div_ceil(threads);
    std::thread::scope(|s| {
        let parts: Vec<_> = dirs.chunks(chunk).map(|part| s.spawn(move || part.iter().filter_map(|d| listing(d)).collect::<Vec<_>>())).collect();
        parts.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

/// Every file under `dir` (not hidden, not under an `exclude` folder), level by level.
pub fn walk(dir: &Path, exclude: &[PathBuf]) -> Vec<FileRef> {
    let mut out = Vec::new();
    let mut level = vec![dir.to_path_buf()];
    while !level.is_empty() {
        let mut next = Vec::new();
        for l in listings(&level) {
            out.extend(l.files.iter().cloned());
            next.extend(l.dirs.iter().filter(|d| !exclude.contains(d)).cloned());
        }
        level = next;
    }
    out
}

/// Forget what is known under `path` (itself, its folder, and anything below it).
pub fn forget(path: &Path) {
    let mut k = known().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(parent) = path.parent() {
        k.remove(parent);
    }
    k.retain(|d, _| !d.starts_with(path));
}

/// Watch the opened folder, so files changed in place (same name, new content) are read again.
/// One folder at a time: opening another one moves the watch.
pub fn watch(root: &Path) {
    static WATCH: Mutex<Option<(PathBuf, notify::RecommendedWatcher)>> = Mutex::new(None);
    let mut w = WATCH.lock().unwrap_or_else(|p| p.into_inner());
    if w.as_ref().is_some_and(|(r, _)| r == root) {
        return;
    }
    let made = notify::recommended_watcher(|res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in &ev.paths {
                forget(p);
            }
        }
    });
    let Ok(mut watcher) = made else {
        *w = None;
        return;
    };
    if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
        // Whatever was known from before the watch may be old.
        known().lock().unwrap_or_else(|p| p.into_inner()).retain(|d, _| !d.starts_with(root));
        *w = Some((root.to_path_buf(), watcher));
    } else {
        *w = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(files: &[FileRef], root: &Path) -> Vec<String> {
        let mut v: Vec<String> = files.iter().map(|f| f.path.strip_prefix(root).unwrap().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn walks_the_tree_and_sees_what_changes() {
        let root = std::env::temp_dir().join(format!("ms-listing-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::create_dir_all(root.join("skip")).unwrap();
        for p in ["one.jpg", "a/two.jpg", "a/b/three.jpg", ".hidden/no.jpg", "skip/no.jpg", "a/.dot.jpg"] {
            fs::write(root.join(p), b"x").unwrap();
        }
        let ex = [root.join("skip")];
        assert_eq!(names(&walk(&root, &ex), &root), ["a/b/three.jpg", "a/two.jpg", "one.jpg"]);

        // Added, removed and renamed: the folders' times change, so the next walk sees it.
        fs::write(root.join("a/b/four.jpg"), b"x").unwrap();
        fs::remove_file(root.join("one.jpg")).unwrap();
        fs::rename(root.join("a/two.jpg"), root.join("a/2.jpg")).unwrap();
        assert_eq!(names(&walk(&root, &ex), &root), ["a/2.jpg", "a/b/four.jpg", "a/b/three.jpg"]);

        // Changed in place: the folder's time stays; forgetting it (as the watcher does) reads it again.
        fs::write(root.join("a/2.jpg"), b"longer").unwrap();
        forget(&root.join("a/2.jpg"));
        let two = walk(&root, &ex).into_iter().find(|f| f.path.ends_with("a/2.jpg")).unwrap();
        assert_eq!(two.size, 6);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn many_folders_are_read_side_by_side() {
        let root = std::env::temp_dir().join(format!("ms-listing-wide-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for i in 0..40 {
            fs::create_dir_all(root.join(format!("d{i}"))).unwrap();
            fs::write(root.join(format!("d{i}/p.jpg")), b"x").unwrap();
        }
        assert_eq!(walk(&root, &[]).len(), 40);
        let _ = fs::remove_dir_all(&root);
    }
}
