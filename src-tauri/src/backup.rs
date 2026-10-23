//! Incremental backup of the opened folder into another folder.
//!
//! A plan compares both trees by relative path, size and modification time:
//! unchanged files are skipped, changed ones re-copied, files that vanished
//! from the source but exist in the backup with the same name, size and time
//! are treated as moves and renamed in the backup, and files only in the
//! backup are listed as extras (deleted only when mirroring is requested).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub static BACKUP_CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub rel: String,
    pub size: u64,
    /// Seconds since the epoch, whole seconds (FAT stores 2 s resolution).
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub copy: Vec<FileEntry>,
    pub update: Vec<FileEntry>,
    /// (backup rel path now, backup rel path it should get)
    pub moves: Vec<(String, String)>,
    /// Only in the backup.
    pub extra: Vec<FileEntry>,
    pub unchanged: usize,
    pub unchanged_bytes: u64,
    pub bytes_to_copy: u64,
    pub source_files: usize,
    pub source_bytes: u64,
}

fn mtime_secs(m: &fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn same_time(a: u64, b: u64) -> bool {
    a.abs_diff(b) <= 2
}

fn walk(root: &Path, skip_trash: Option<&Path>) -> Vec<FileEntry> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            if e.depth() > 0 && (n == ".Spotlight-V100" || n == ".fseventsd" || n == ".Trashes" || n == ".DS_Store" || n.ends_with(".tmp")) {
                return false;
            }
            !matches!(skip_trash, Some(t) if e.path() == t)
        })
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some(FileEntry { rel: crate::media::rel_key(root, e.path()), size: m.len(), mtime: mtime_secs(&m) })
        })
        .collect()
}

pub fn plan(src: &Path, dest: &Path, skip_trash: Option<&Path>) -> Result<Plan, String> {
    if !src.is_dir() {
        return Err("source is not a folder".into());
    }
    if dest.starts_with(src) || src.starts_with(dest) {
        return Err("the backup folder must not be inside the source (or the other way round)".into());
    }
    let source = walk(src, skip_trash);
    let backup = if dest.is_dir() { walk(dest, None) } else { vec![] };
    let mut in_backup: HashMap<&str, &FileEntry> = backup.iter().map(|f| (f.rel.as_str(), f)).collect();

    let mut p = Plan { source_files: source.len(), source_bytes: source.iter().map(|f| f.size).sum(), ..Default::default() };
    let mut missing: Vec<&FileEntry> = vec![];
    for f in &source {
        match in_backup.remove(f.rel.as_str()) {
            Some(b) if b.size == f.size && same_time(b.mtime, f.mtime) => {
                p.unchanged += 1;
                p.unchanged_bytes += f.size;
            }
            Some(_) => {
                p.bytes_to_copy += f.size;
                p.update.push(f.clone());
            }
            None => missing.push(f),
        }
    }
    // Whatever is left in `in_backup` is not in the source any more: a move candidate or an extra.
    let mut leftovers: Vec<&FileEntry> = in_backup.into_values().collect();
    for f in missing {
        let name = Path::new(&f.rel).file_name().map(|n| n.to_os_string());
        let found = leftovers.iter().position(|b| b.size == f.size && same_time(b.mtime, f.mtime) && Path::new(&b.rel).file_name().map(|n| n.to_os_string()) == name);
        match found {
            Some(i) => {
                let b = leftovers.remove(i);
                p.moves.push((b.rel.clone(), f.rel.clone()));
            }
            None => {
                p.bytes_to_copy += f.size;
                p.copy.push(f.clone());
            }
        }
    }
    p.extra = leftovers.into_iter().cloned().collect();
    p.copy.sort_by(|a, b| a.rel.cmp(&b.rel));
    p.update.sort_by(|a, b| a.rel.cmp(&b.rel));
    p.extra.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(p)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub done_files: usize,
    pub total_files: usize,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub current: String,
    pub errors: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub copied: usize,
    pub updated: usize,
    pub moved: usize,
    pub deleted: usize,
    pub bytes: u64,
    pub millis: u64,
    pub verified: usize,
    pub errors: Vec<(String, String)>,
    pub cancelled: bool,
}

/// Copy to a temporary name, then rename into place, keeping the source mtime
/// so the next plan recognises the file as unchanged.
fn copy_file(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = dst.with_extension(format!("{}.mediasorter-part", dst.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()));
    fs::copy(src, &tmp).map_err(|e| format!("copy {}: {e}", src.display()))?;
    if let Ok(m) = fs::metadata(src) {
        if let Ok(t) = m.modified() {
            let f = fs::File::options().write(true).open(&tmp).map_err(|e| e.to_string())?;
            let _ = f.set_modified(t);
        }
    }
    fs::rename(&tmp, dst).map_err(|e| format!("finish {}: {e}", dst.display()))
}

pub fn run(src: &Path, dest: &Path, plan: &Plan, mirror: bool, verify: bool, mut progress: impl FnMut(Progress)) -> Outcome {
    BACKUP_CANCEL.store(false, Ordering::SeqCst);
    let start = Instant::now();
    let mut out = Outcome { copied: 0, updated: 0, moved: 0, deleted: 0, bytes: 0, millis: 0, verified: 0, errors: vec![], cancelled: false };
    let total_files = plan.moves.len() + plan.copy.len() + plan.update.len() + if mirror { plan.extra.len() } else { 0 };
    let total_bytes = plan.bytes_to_copy;
    let mut done_files = 0usize;
    let mut last = Instant::now();
    let mut report = |stage: &str, current: &str, done_files: usize, done_bytes: u64, errors: usize, force: bool, progress: &mut dyn FnMut(Progress)| {
        if force || last.elapsed().as_millis() > 150 {
            last = Instant::now();
            progress(Progress { stage: stage.into(), done_files, total_files, done_bytes, total_bytes, current: current.into(), errors });
        }
    };
    let cancelled = || BACKUP_CANCEL.load(Ordering::SeqCst);

    let _ = fs::create_dir_all(dest);
    for (from, to) in &plan.moves {
        if cancelled() {
            out.cancelled = true;
            break;
        }
        let (a, b) = (dest.join(from), dest.join(to));
        if let Some(parent) = b.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match fs::rename(&a, &b) {
            Ok(()) => out.moved += 1,
            Err(e) => out.errors.push((from.clone(), e.to_string())),
        }
        done_files += 1;
        report("moving", to, done_files, out.bytes, out.errors.len(), false, &mut progress);
    }
    for (list, is_update) in [(&plan.copy, false), (&plan.update, true)] {
        for f in list {
            if cancelled() {
                out.cancelled = true;
                break;
            }
            let (a, b) = (src.join(&f.rel), dest.join(&f.rel));
            report("copying", &f.rel, done_files, out.bytes, out.errors.len(), true, &mut progress);
            match copy_file(&a, &b) {
                Ok(()) => {
                    if is_update {
                        out.updated += 1
                    } else {
                        out.copied += 1
                    }
                    out.bytes += f.size;
                    if verify {
                        match (crate::dupes::file_fingerprint(&a), crate::dupes::file_fingerprint(&b)) {
                            (Ok(x), Ok(y)) if x == y => out.verified += 1,
                            (Ok(_), Ok(_)) => out.errors.push((f.rel.clone(), "copy does not match the source".into())),
                            (Err(e), _) | (_, Err(e)) => out.errors.push((f.rel.clone(), format!("verify: {e}"))),
                        }
                    }
                }
                Err(e) => out.errors.push((f.rel.clone(), e)),
            }
            done_files += 1;
        }
        if out.cancelled {
            break;
        }
    }
    if mirror && !out.cancelled {
        for f in &plan.extra {
            if cancelled() {
                out.cancelled = true;
                break;
            }
            match fs::remove_file(dest.join(&f.rel)) {
                Ok(()) => out.deleted += 1,
                Err(e) => out.errors.push((f.rel.clone(), e.to_string())),
            }
            done_files += 1;
            report("removing", &f.rel, done_files, out.bytes, out.errors.len(), false, &mut progress);
        }
        prune_empty_dirs(dest);
    }
    report("done", "", done_files, out.bytes, out.errors.len(), true, &mut progress);
    out.millis = start.elapsed().as_millis() as u64;
    out
}

fn prune_empty_dirs(dir: &Path) {
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.filter_map(Result::ok) {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                prune_empty_dirs(&e.path());
                let _ = fs::remove_dir(e.path()); // only succeeds when empty
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: PathBuf, data: &[u8], secs: u64) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, data).unwrap();
        let f = fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(secs)).unwrap();
    }

    #[test]
    fn plans_copies_updates_moves_and_extras_then_syncs() {
        let base = std::env::temp_dir().join(format!("ms-backup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let src = base.join("card");
        let dst = base.join("backup");
        write(src.join("DCIM/a.jpg"), b"aaaa", 1_700_000_000);
        write(src.join("DCIM/b.jpg"), b"bb", 1_700_000_100);
        write(src.join("Keep/c.jpg"), b"cccccc", 1_700_000_200); // moved from DCIM in the source
        write(src.join("_deleted/x.jpg"), b"x", 1_700_000_300);
        write(dst.join("DCIM/a.jpg"), b"aaaa", 1_700_000_001); // same (within 2 s)
        write(dst.join("DCIM/b.jpg"), b"old", 1_600_000_000); // changed
        write(dst.join("DCIM/c.jpg"), b"cccccc", 1_700_000_200); // old location of c
        write(dst.join("DCIM/gone.jpg"), b"g", 1_700_000_400); // extra

        let p = plan(&src, &dst, Some(&src.join("_deleted"))).unwrap();
        assert_eq!(p.unchanged, 1);
        assert_eq!(p.update.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), vec!["DCIM/b.jpg"]);
        assert_eq!(p.moves, vec![("DCIM/c.jpg".to_string(), "Keep/c.jpg".to_string())]);
        assert!(p.copy.is_empty());
        assert_eq!(p.extra.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), vec!["DCIM/gone.jpg"]);
        assert_eq!(p.source_files, 3);
        assert_eq!(p.bytes_to_copy, 2);

        let out = run(&src, &dst, &p, true, true, |_| {});
        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!((out.copied, out.updated, out.moved, out.deleted, out.verified), (0, 1, 1, 1, 1));
        assert_eq!(fs::read(dst.join("DCIM/b.jpg")).unwrap(), b"bb");
        assert!(dst.join("Keep/c.jpg").exists());
        assert!(!dst.join("DCIM/c.jpg").exists());
        assert!(!dst.join("DCIM/gone.jpg").exists());
        assert!(!dst.join("_deleted").exists());

        // Second pass: nothing to do.
        let p2 = plan(&src, &dst, Some(&src.join("_deleted"))).unwrap();
        assert_eq!(p2.unchanged, 3);
        assert!(p2.copy.is_empty() && p2.update.is_empty() && p2.moves.is_empty() && p2.extra.is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn refuses_nested_destination() {
        let base = std::env::temp_dir().join(format!("ms-backup-nested-{}", std::process::id()));
        fs::create_dir_all(base.join("card/sub")).unwrap();
        assert!(plan(&base.join("card"), &base.join("card/sub"), None).is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
