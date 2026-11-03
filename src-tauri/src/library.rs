//! The library file lives next to the media (`<root>/.quire.json`),
//! whether that is an SD card, an external drive or a local folder, so
//! nothing accumulates inside the app.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const LIBRARY_FILE: &str = ".quire.json";
pub const DEFAULT_TRASH_DIR: &str = "_deleted";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub name: String,
    /// Relative to the root when inside it, absolute otherwise.
    pub path: String,
    pub hotkey: String,
    /// A bucket (Professional, Private…): what is sorted or imported into it is filed in a folder
    /// for the year and the day it came in, `<bucket>/2026/2026-10-28/`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bucket: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub version: u32,
    #[serde(default)]
    pub targets: Vec<Target>,
    /// item key -> rating 1..=10
    #[serde(default)]
    pub ratings: BTreeMap<String, u8>,
    #[serde(default = "default_trash_dir")]
    pub trash_dir: String,
    /// Folders whose immediate subfolders are albums (kept out of the main grid).
    #[serde(default)]
    pub album_roots: Vec<String>,
    /// album key (relative path) -> rating 1..=10
    #[serde(default)]
    pub album_ratings: BTreeMap<String, u8>,
    /// Decode URL-escaped album folder names (`My%20Trip`) whenever albums are scanned.
    #[serde(default)]
    pub auto_decode_album_names: bool,
    /// Where this folder is backed up to, and when that last finished (ms).
    /// item key -> identity (size, mtime, name, fingerprint) so ratings follow moved files
    #[serde(default)]
    pub ids: BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    pub backup_dest: Option<String>,
    #[serde(default)]
    pub last_backup: Option<u64>,
    /// Album key → the album that is its translated version.
    #[serde(default)]
    pub album_translations: BTreeMap<String, String>,
    /// Album key → its language ("ja", "en" …).
    #[serde(default)]
    pub album_languages: BTreeMap<String, String>,
    /// Album key → its Scrapbook cover (the scrapbook's id).
    #[serde(default)]
    pub album_covers: BTreeMap<String, String>,
    /// Albums said not to be one work in two languages, though they looked it: "<key>|<key>".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub album_not_versions: Vec<String>,
    /// Series: pictures alike that are kept on purpose (a burst, an artist's variations), by item key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub series: Vec<Vec<String>>,
    /// Pictures said not to be a series, though they looked it: "<key>|<key>".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub series_not: Vec<String>,
    /// Item key → where it came from (a platform in Find: its id, link, title, artist, tags).
    #[serde(default)]
    pub sources: BTreeMap<String, serde_json::Value>,
    /// Everything else the app keeps in the library file (the trash's note of where each thing came
    /// from, `trashFrom`, say), kept as it came: a field the app writes that this struct doesn't name
    /// still comes back on the next load, rather than being dropped by every save.
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

fn default_trash_dir() -> String {
    DEFAULT_TRASH_DIR.to_string()
}

impl Default for Library {
    fn default() -> Self {
        Library {
            version: 1,
            targets: vec![],
            ratings: BTreeMap::new(),
            trash_dir: default_trash_dir(),
            album_roots: vec![],
            album_ratings: BTreeMap::new(),
            auto_decode_album_names: false,
            ids: BTreeMap::new(),
            backup_dest: None,
            last_backup: None,
            album_translations: BTreeMap::new(),
            album_languages: BTreeMap::new(),
            album_covers: BTreeMap::new(),
            album_not_versions: vec![],
            series: vec![],
            series_not: vec![],
            sources: BTreeMap::new(),
            rest: serde_json::Map::new(),
        }
    }
}

impl Library {
    pub fn path_for(root: &Path) -> PathBuf {
        root.join(LIBRARY_FILE)
    }

    pub fn load(root: &Path) -> Result<Library, String> {
        let p = Self::path_for(root);
        if !p.exists() {
            return Ok(Library::default());
        }
        let text = std::fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", p.display()))
    }

    pub fn save(&self, root: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::fsx::write_atomic(&Self::path_for(root), text.as_bytes())
    }

    pub fn trash_path(&self, root: &Path) -> PathBuf {
        resolve(root, &self.trash_dir)
    }

    pub fn album_root_paths(&self, root: &Path) -> Vec<PathBuf> {
        self.album_roots.iter().map(|a| resolve(root, a)).collect()
    }
}

/// Resolve a stored path (relative to root or absolute) to an absolute path.
pub fn resolve(root: &Path, stored: &str) -> PathBuf {
    let p = Path::new(stored);
    if p.is_absolute() { p.to_path_buf() } else { root.join(p) }
}

/// Whether a path is inside the opened folder: judged on the path as it would be with `..` and `.`
/// taken out (not on where symlinks lead: a library on a linked drive stays usable), so a stored
/// `../../Documents` or a path handed over as absolute can't reach outside. Where a command writes,
/// moves or deletes, this is the line.
pub fn inside(root: &Path, p: &Path) -> bool {
    use std::path::Component;
    let mut clean = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                clean.pop();
            }
            Component::CurDir => {}
            other => clean.push(other.as_os_str()),
        }
    }
    let mut root_clean = PathBuf::new();
    for c in root.components() {
        match c {
            Component::ParentDir => {
                root_clean.pop();
            }
            Component::CurDir => {}
            other => root_clean.push(other.as_os_str()),
        }
    }
    clean.starts_with(&root_clean)
}

/// A path a command may change: inside the opened folder, or an error naming it.
pub fn confined(root: &Path, p: &Path) -> Result<PathBuf, String> {
    if inside(root, p) { Ok(p.to_path_buf()) } else { Err(format!("{} is outside the opened folder", p.display())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_app_keeps_in_the_library_comes_back_as_it_was_saved() {
        let root = std::env::temp_dir().join(format!("ms-library-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // As the app sends it: series and the choices said about look-alikes among the rest.
        let sent = r#"{"version":1,"targets":[],"ratings":{},"albumRoots":[],"albumRatings":{},"ids":{},"series":[["a/1.jpg","a/2.jpg"]],"seriesNot":["a/1.jpg|a/3.jpg"],"albumNotVersions":["Albums/A|Albums/B"]}"#;
        let lib: Library = serde_json::from_str(sent).unwrap();
        lib.save(&root).unwrap();
        let back = Library::load(&root).unwrap();
        assert_eq!(back.series, vec![vec!["a/1.jpg".to_string(), "a/2.jpg".to_string()]]);
        assert_eq!(back.series_not, ["a/1.jpg|a/3.jpg"]);
        assert_eq!(back.album_not_versions, ["Albums/A|Albums/B"]);
        // A field this struct doesn't name (the trash's notes, say) comes back too.
        let sent = r#"{"version":1,"trashFrom":{"_deleted/a.jpg":"Pics/a.jpg"},"someLaterField":[1,2]}"#;
        serde_json::from_str::<Library>(sent).unwrap().save(&root).unwrap();
        let back = serde_json::to_value(Library::load(&root).unwrap()).unwrap();
        assert_eq!(back["trashFrom"]["_deleted/a.jpg"], "Pics/a.jpg");
        assert_eq!(back["someLaterField"], serde_json::json!([1, 2]));
        // None of them yet: nothing written for them.
        Library::default().save(&root).unwrap();
        assert!(!std::fs::read_to_string(Library::path_for(&root)).unwrap().contains("series"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
