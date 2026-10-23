//! The library file lives next to the media (`<root>/.mediasorter.json`),
//! whether that is an SD card, an external drive or a local folder, so
//! nothing accumulates inside the app.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const LIBRARY_FILE: &str = ".mediasorter.json";
pub const DEFAULT_TRASH_DIR: &str = "_deleted";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub name: String,
    /// Relative to the root when inside it, absolute otherwise.
    pub path: String,
    pub hotkey: String,
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
        let p = Self::path_for(root);
        let tmp = root.join(format!("{LIBRARY_FILE}.tmp"));
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| format!("write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &p).map_err(|e| format!("rename {}: {e}", p.display()))?;
        Ok(())
    }

    pub fn trash_path(&self, root: &Path) -> PathBuf {
        resolve(root, &self.trash_dir)
    }
}

/// Resolve a stored path (relative to root or absolute) to an absolute path.
pub fn resolve(root: &Path, stored: &str) -> PathBuf {
    let p = Path::new(stored);
    if p.is_absolute() { p.to_path_buf() } else { root.join(p) }
}
