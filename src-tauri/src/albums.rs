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

/// Build an album card from the items found under `sub`.
pub fn album_from_items(root: &Path, sub: &Path, stored_root: &str, items: Vec<MediaItem>) -> Album {
    let cover = items.iter().find(|i| i.kind != MediaKind::Video).or_else(|| items.first()).cloned();
    Album {
        key: media::rel_key(root, sub),
        path: sub.to_string_lossy().into_owned(),
        name: sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        album_root: stored_root.to_string(),
        count: items.len(),
        bytes: items.iter().map(|i| i.size).sum(),
        images: items.iter().filter(|i| i.kind != MediaKind::Video).count(),
        videos: items.iter().filter(|i| i.kind == MediaKind::Video).count(),
        modified: items.iter().map(|i| i.modified).max().unwrap_or(0),
        cover,
    }
}

#[allow(dead_code)]
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
#[allow(dead_code)]
pub fn move_dir(dir: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(dest_dir).map_err(|e| format!("create {}: {e}", dest_dir.display()))?;
    let name = dir.file_name().ok_or("folder has no name")?.to_string_lossy().into_owned();
    let mut target = dest_dir.join(&name);
    let mut n = 1;
    while target.exists() {
        target = dest_dir.join(format!("{name} ({n})"));
        n += 1;
    }
    move_dir_to(dir, &target)?;
    Ok(target)
}

/// Move a folder to an exact target path (rename, or copy + delete across devices).
pub fn move_dir_to(dir: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(dir) {
        return Err("cannot move a folder into itself".into());
    }
    match fs::rename(dir, target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices || e.raw_os_error() == Some(18) => {
            copy_recursive(dir, target)?;
            fs::remove_dir_all(dir).map_err(|e| e.to_string())
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

/// A planned or performed folder rename, with the rating keys it affects.
#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub from: String,
    pub to: String,
    pub from_key: String,
    pub to_key: String,
}

/// Decode percent-escapes in a folder name (`Z%C3%BCrich%20Trip` -> `Zürich Trip`).
/// Returns None when the name would not change. Control characters and path
/// separators that appear after decoding are replaced so the result is a
/// valid single path component.
pub fn decode_name(name: &str) -> Option<String> {
    if !name.contains('%') {
        return None;
    }
    let bytes = name.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut changed = false;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && name.is_char_boundary(i + 1) && name.is_char_boundary(i + 3) {
            let hex = &name[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                changed = true;
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    if !changed {
        return None;
    }
    let decoded = String::from_utf8_lossy(&out).into_owned();
    let cleaned: String = decoded
        .chars()
        .map(|c| if c.is_control() || c == '/' || c == '\\' || c == ':' { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned = cleaned.trim_matches(|c| c == '.' || c == ' ').to_string();
    if cleaned.is_empty() || cleaned == name {
        return None;
    }
    Some(cleaned)
}

/// Album folders whose names contain URL escapes, with the decoded name they
/// would get. Collisions get a ` (n)` suffix.
#[allow(dead_code)]
pub fn rename_plan(root: &Path, album_roots: &[PathBuf]) -> Vec<Rename> {
    let mut plan = vec![];
    for dir in album_roots {
        let Ok(rd) = fs::read_dir(dir) else { continue };
        let mut subdirs: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        subdirs.sort();
        let mut taken: Vec<String> = subdirs.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
        for sub in subdirs {
            let name = sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let Some(mut new_name) = decode_name(&name) else { continue };
            let mut n = 1;
            let base = new_name.clone();
            while taken.iter().any(|t| t != &name && t.eq_ignore_ascii_case(&new_name)) {
                new_name = format!("{base} ({n})");
                n += 1;
            }
            taken.push(new_name.clone());
            let to = dir.join(&new_name);
            plan.push(Rename {
                from: sub.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
                from_key: media::rel_key(root, &sub),
                to_key: media::rel_key(root, &to),
            });
        }
    }
    plan
}

/// Perform renames from a plan. Entries whose source vanished or whose
/// destination now exists are skipped; the performed ones are returned.
#[allow(dead_code)]
pub fn rename_apply(plan: &[Rename]) -> Result<Vec<Rename>, String> {
    let mut done = vec![];
    for r in plan {
        let from = Path::new(&r.from);
        let to = Path::new(&r.to);
        if !from.is_dir() || to.exists() {
            continue;
        }
        fs::rename(from, to).map_err(|e| format!("rename {}: {e}", from.display()))?;
        done.push(r.clone());
    }
    Ok(done)
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    #[test]
    fn decodes_escapes_and_cleans() {
        assert_eq!(decode_name("Z%C3%BCrich%20Trip").as_deref(), Some("Zürich Trip"));
        assert_eq!(decode_name("Plain name"), None);
        assert_eq!(decode_name("100%"), None); // not an escape
        assert_eq!(decode_name("a%2Fb%12c").as_deref(), Some("a b c")); // slash and control char
        assert_eq!(decode_name("%20%20").is_none(), true); // decodes to nothing
    }

    #[test]
    fn plans_and_applies_with_collisions() {
        let root = std::env::temp_dir().join(format!("ms-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let ar = root.join("Albums");
        fs::create_dir_all(ar.join("My%20Trip")).unwrap();
        fs::create_dir_all(ar.join("My Trip")).unwrap();
        fs::create_dir_all(ar.join("Caf%C3%A9")).unwrap();
        fs::create_dir_all(ar.join("Fine")).unwrap();

        let plan = rename_plan(&root, &[ar.clone()]);
        let names: Vec<(String, String)> = plan
            .iter()
            .map(|r| (Path::new(&r.from).file_name().unwrap().to_string_lossy().into_owned(), Path::new(&r.to).file_name().unwrap().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(names, vec![("Caf%C3%A9".to_string(), "Café".to_string()), ("My%20Trip".to_string(), "My Trip (1)".to_string())]);
        assert_eq!(plan[0].to_key, "Albums/Café");

        let done = rename_apply(&plan).unwrap();
        assert_eq!(done.len(), 2);
        assert!(ar.join("Café").is_dir());
        assert!(ar.join("My Trip (1)").is_dir());
        assert!(!ar.join("My%20Trip").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
