//! Albums: every immediate subfolder of an "album root" is one album, rated
//! and moved as a whole. Their contents never appear in the main grid.

use crate::media::{self, MediaItem, MediaKind};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    /// Rating key: album folder relative to the root.
    pub key: String,
    pub path: String,
    pub name: String,
    /// Which album root it belongs to (stored path).
    pub album_root: String,
    pub count: usize,
    pub bytes: u64,
    pub images: usize,
    pub videos: usize,
    pub modified: u64,
    pub cover: Option<MediaItem>,
}

pub fn scan_albums(root: &Path, album_roots: &[(String, PathBuf)]) -> Vec<Album> {
    let mut out = vec![];
    for (stored, dir) in album_roots {
        let Ok(rd) = fs::read_dir(dir) else { continue };
        let mut subdirs: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| !p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(true))
            .collect();
        subdirs.sort();
        for sub in subdirs {
            let mut items = media::scan(root, &sub, &[]);
            items.sort_by(|a, b| a.dir.cmp(&b.dir).then_with(|| a.name.cmp(&b.name)));
            let cover = items
                .iter()
                .find(|i| i.kind != MediaKind::Video)
                .or_else(|| items.first())
                .cloned();
            out.push(Album {
                key: media::rel_key(root, &sub),
                path: sub.to_string_lossy().into_owned(),
                name: sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                album_root: stored.clone(),
                count: items.len(),
                bytes: items.iter().map(|i| i.size).sum(),
                images: items.iter().filter(|i| i.kind != MediaKind::Video).count(),
                videos: items.iter().filter(|i| i.kind == MediaKind::Video).count(),
                modified: items.iter().map(|i| i.modified).max().unwrap_or(0),
                cover,
            });
        }
    }
    out
}

/// Move a whole folder into `dest_dir`, keeping its name (suffixed on collision).
pub fn move_dir(dir: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dest_dir).map_err(|e| format!("create {}: {e}", dest_dir.display()))?;
    let name = dir.file_name().ok_or("folder has no name")?.to_string_lossy().into_owned();
    let mut target = dest_dir.join(&name);
    let mut n = 1;
    while target.exists() {
        target = dest_dir.join(format!("{name} ({n})"));
        n += 1;
    }
    if dest_dir.starts_with(dir) {
        return Err("cannot move a folder into itself".into());
    }
    match fs::rename(dir, &target) {
        Ok(()) => Ok(target),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices || e.raw_os_error() == Some(18) => {
            copy_recursive(dir, &target)?;
            fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
            Ok(target)
        }
        Err(e) => Err(format!("move {}: {e}", dir.display())),
    }
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let to = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_recursive(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn albums_are_subfolders_with_cover_and_counts() {
        let root = std::env::temp_dir().join(format!("ms-albums-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let ar = root.join("Albums");
        fs::create_dir_all(ar.join("Trip/sub")).unwrap();
        fs::create_dir_all(ar.join("Party")).unwrap();
        fs::create_dir_all(ar.join(".hidden")).unwrap();
        fs::write(ar.join("Trip/b.jpg"), b"x").unwrap();
        fs::write(ar.join("Trip/a.mov"), b"xy").unwrap();
        fs::write(ar.join("Trip/sub/c.png"), b"xyz").unwrap();
        fs::write(ar.join("loose.jpg"), b"x").unwrap();

        let albums = scan_albums(&root, &[("Albums".into(), ar.clone())]);
        assert_eq!(albums.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["Party", "Trip"]);
        let trip = &albums[1];
        assert_eq!(trip.count, 3);
        assert_eq!(trip.videos, 1);
        assert_eq!(trip.bytes, 6);
        assert_eq!(trip.key, "Albums/Trip");
        assert_eq!(trip.cover.as_ref().unwrap().name, "b");

        let moved = move_dir(&ar.join("Trip"), &root.join("Keep")).unwrap();
        assert_eq!(moved, root.join("Keep/Trip"));
        assert!(moved.join("sub/c.png").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
