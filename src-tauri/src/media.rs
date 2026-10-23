//! Media discovery: walks a directory tree and groups files that belong
//! together (RAW + JPEG, live-photo HEIC + MOV, XMP sidecars) into items.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff", "avif",
];
pub const RAW_EXTS: &[&str] = &[
    "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "pef", "srw",
    "3fr", "erf", "kdc", "mrw", "x3f",
];
pub const VIDEO_EXTS: &[&str] = &[
    "mp4", "mov", "m4v", "webm", "mkv", "avi", "mts", "m2ts", "mpg", "mpeg",
];
/// Files that never stand alone but travel with a media file of the same stem.
pub const SIDECAR_EXTS: &[&str] = &["xmp", "aae", "thm", "lrv", "pp3", "dop"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Image,
    Raw,
    Video,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    /// Stable key used for ratings: path of the primary file relative to the
    /// library root (or absolute when the file lives outside the root).
    pub key: String,
    /// Absolute path of the file that gets displayed.
    pub primary: String,
    /// All absolute paths that belong to this item (primary included).
    pub files: Vec<String>,
    pub kind: MediaKind,
    /// Display name (file stem).
    pub name: String,
    /// Directory of the item relative to the scanned directory.
    pub dir: String,
    pub size: u64,
    /// Modification time in milliseconds since the epoch.
    pub modified: u64,
    pub has_raw: bool,
    pub has_video: bool,
    /// Id of the target folder containing this item, when known (scan_all).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
}

fn ext_of(p: &Path) -> Option<String> {
    p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
}

pub fn classify(p: &Path) -> Option<MediaKind> {
    let ext = ext_of(p)?;
    let e = ext.as_str();
    if IMAGE_EXTS.contains(&e) {
        Some(MediaKind::Image)
    } else if RAW_EXTS.contains(&e) {
        Some(MediaKind::Raw)
    } else if VIDEO_EXTS.contains(&e) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

fn is_sidecar(p: &Path) -> bool {
    ext_of(p).map(|e| SIDECAR_EXTS.contains(&e.as_str())).unwrap_or(false)
}

/// Key for a file relative to `root`, with forward slashes so it is identical
/// on every platform (the library file travels with the volume).
pub fn rel_key(root: &Path, p: &Path) -> String {
    match p.strip_prefix(root) {
        Ok(rel) => rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => p.to_string_lossy().into_owned(),
    }
}

fn is_hidden(p: &Path) -> bool {
    p.file_name()
        .map(|n| n.to_string_lossy().starts_with('.'))
        .unwrap_or(false)
}

/// Rank used to decide which file of a group is displayed: a developed image
/// beats a video (live photo) which beats a RAW file.
fn display_rank(kind: MediaKind) -> u8 {
    match kind {
        MediaKind::Image => 0,
        MediaKind::Video => 1,
        MediaKind::Raw => 2,
    }
}

/// Scan `dir` recursively. `exclude` holds absolute directories that are
/// skipped entirely (the trash folder, target folders inside the root).
pub fn scan(root: &Path, dir: &Path, exclude: &[PathBuf]) -> Vec<MediaItem> {
    // (directory, lowercase stem) -> files
    let mut groups: BTreeMap<(PathBuf, String), Vec<PathBuf>> = BTreeMap::new();

    let walker = WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let p = e.path();
            if p == dir {
                return true;
            }
            if is_hidden(p) {
                return false;
            }
            if e.file_type().is_dir() && exclude.iter().any(|x| x == p) {
                return false;
            }
            true
        });

    for entry in walker.filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        if classify(p).is_none() && !is_sidecar(p) {
            continue;
        }
        let parent = p.parent().unwrap_or(dir).to_path_buf();
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        groups.entry((parent, stem)).or_default().push(p.to_path_buf());
    }

    let mut items = Vec::with_capacity(groups.len());
    for ((parent, _stem), mut files) in groups {
        files.sort();
        // Pick the display file.
        let mut best: Option<(u8, &PathBuf, MediaKind)> = None;
        let mut has_raw = false;
        let mut has_video = false;
        for f in &files {
            if let Some(kind) = classify(f) {
                has_raw |= kind == MediaKind::Raw;
                has_video |= kind == MediaKind::Video;
                let r = display_rank(kind);
                if best.map(|(br, _, _)| r < br).unwrap_or(true) {
                    best = Some((r, f, kind));
                }
            }
        }
        // Group consisting only of sidecars: nothing to show.
        let Some((_, primary, kind)) = best else { continue };

        let meta = std::fs::metadata(primary).ok();
        let size = files
            .iter()
            .filter_map(|f| std::fs::metadata(f).ok())
            .map(|m| m.len())
            .sum();
        let modified = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        items.push(MediaItem {
            key: rel_key(root, primary),
            primary: primary.to_string_lossy().into_owned(),
            files: files.iter().map(|f| f.to_string_lossy().into_owned()).collect(),
            kind,
            name: primary
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            dir: rel_key(dir, &parent),
            size,
            modified,
            has_raw,
            has_video,
            target_id: None,
        });
    }
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mediasorter-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn groups_pairs_and_skips_excluded_dirs() {
        let root = tmp("scan");
        let dcim = root.join("DCIM");
        fs::create_dir_all(&dcim).unwrap();
        for f in ["a.JPG", "a.CR2", "a.xmp", "b.cr2", "c.mov", "d.txt", "e.heic", "e.mov"] {
            fs::write(dcim.join(f), b"x").unwrap();
        }
        let keep = root.join("Keep");
        fs::create_dir_all(&keep).unwrap();
        fs::write(keep.join("z.jpg"), b"x").unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join(".hidden/h.jpg"), b"x").unwrap();

        let items = scan(&root, &root, &[keep.clone()]);
        let mut names: Vec<_> = items.iter().map(|i| i.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["a", "b", "c", "e"]);

        let a = items.iter().find(|i| i.name == "a").unwrap();
        assert_eq!(a.kind, MediaKind::Image);
        assert!(a.has_raw);
        assert_eq!(a.files.len(), 3);
        assert_eq!(a.key, "DCIM/a.JPG");
        assert_eq!(a.dir, "DCIM");

        let b = items.iter().find(|i| i.name == "b").unwrap();
        assert_eq!(b.kind, MediaKind::Raw);

        let e = items.iter().find(|i| i.name == "e").unwrap();
        assert_eq!(e.kind, MediaKind::Image);
        assert!(e.has_video);

        let _ = fs::remove_dir_all(&root);
    }
}
