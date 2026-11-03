//! File operations: moving items into target folders, trashing, purging.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub fn with_suffix(file: &Path, n: u32) -> PathBuf {
    let name = file.file_name().map(|s| s.to_os_string()).unwrap_or_default();
    if n == 0 {
        return PathBuf::from(name);
    }
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    match file.extension() {
        Some(ext) => PathBuf::from(format!("{stem} ({n}).{}", ext.to_string_lossy())),
        None => PathBuf::from(format!("{stem} ({n})")),
    }
}

/// Rename, falling back to copy + delete when crossing devices.
pub fn move_file(src: &Path, dst: &Path) -> io::Result<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(e) if is_cross_device(&e) => {
            // A copy cut short (the other drive full) is taken away again, so no half of a file is
            // left to be scanned as a picture; a whole one keeps the file's own time, its identity.
            if let Err(e) = fs::copy(src, dst) {
                let _ = fs::remove_file(dst);
                return Err(e);
            }
            if let Ok(m) = fs::metadata(src).and_then(|m| m.modified()) {
                let _ = fs::File::options().write(true).open(dst).and_then(|f| f.set_modified(m));
            }
            fs::remove_file(src)
        }
        Err(e) => Err(e),
    }
}

fn is_cross_device(e: &io::Error) -> bool {
    // EXDEV on unix; Windows reports ERROR_NOT_SAME_DEVICE (17).
    matches!(e.raw_os_error(), Some(18) | Some(17))
        || e.kind() == io::ErrorKind::CrossesDevices
}

/// Permanently delete everything inside `trash_dir`. Returns number of files removed.
pub fn purge_dir(trash_dir: &Path) -> Result<usize, String> {
    if !trash_dir.exists() {
        return Ok(0);
    }
    let mut count = 0usize;
    for entry in fs::read_dir(trash_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            count += count_files(&p);
            fs::remove_dir_all(&p).map_err(|e| format!("remove {}: {e}", p.display()))?;
        } else {
            fs::remove_file(&p).map_err(|e| format!("remove {}: {e}", p.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

fn count_files(dir: &Path) -> usize {
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_group_with_shared_suffix_on_collision() {
        let root = std::env::temp_dir().join(format!("quire-ops-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let src = root.join("src");
        let dst = root.join("dst");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir_all(&dst).unwrap();
        fs::write(src.join("a.jpg"), b"1").unwrap();
        fs::write(src.join("a.cr2"), b"2").unwrap();
        fs::write(dst.join("a.jpg"), b"old").unwrap();

        let moved = crate::fsx::Ctx::new(&root, None).move_group(&[src.join("a.jpg"), src.join("a.cr2")], &dst).unwrap();
        assert_eq!(moved[0], dst.join("a (1).jpg"));
        assert_eq!(moved[1], dst.join("a (1).cr2"));
        assert!(moved.iter().all(|p| p.exists()));
        assert!(!src.join("a.jpg").exists());
        assert_eq!(fs::read(dst.join("a.jpg")).unwrap(), b"old");

        assert_eq!(purge_dir(&dst).unwrap(), 3);
        assert_eq!(fs::read_dir(&dst).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&root);
    }
}
