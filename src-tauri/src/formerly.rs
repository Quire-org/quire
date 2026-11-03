//! What the app kept under the name it had before it was Quire (Media Sorter), taken over so the
//! rename leaves nothing behind:
//! - a library's files on its drive (`.mediasorter.json`, `.mediasorter.<name>.json`, the scrapbook's
//!   and kept originals' folders, models kept on the drive) get Quire's names as the library opens;
//! - a vault's kept originals, stored under Media Sorter's folder name, move under Quire's as the
//!   vault opens;
//! - the app's own folders (data, cache, logs) and the window's saved settings are taken over as the
//!   app starts;
//! - quick unlock's Keychain items move to Quire's name the next time they are used (`quick.rs`).
//!
//! Nothing is copied or deleted: each is renamed where it is, and only where Quire has nothing of its
//! own by that name yet.

use crate::vault::Vault;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// How every name of a library's files on its drive began (`.mediasorter.json`,
/// `.mediasorter.tags.json`, `.mediasorter.scrapbook/`…), and how Quire's begin.
const LIBRARY_PREFIX: (&str, &str) = (".mediasorter.", ".quire.");
/// The folder for models kept on the library's drive, and Quire's.
const MODELS_DIR: (&str, &str) = (".media-sorter", ".quire");
/// Where a vault kept replaced originals (Quire's is `versions::KEPT_DIR`).
const KEPT_DIR: &str = ".mediasorter.originals";
/// Quick unlock's Keychain service (Quire's is `quick::KEYCHAIN_SERVICE`).
#[cfg(target_os = "macos")]
pub const KEYCHAIN_SERVICE: &str = "Media Sorter quick unlock";

/// What giving a library's files Quire's names did.
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
    /// Files and folders that have Quire's names now.
    pub renamed: usize,
    /// Old ones left as they were, because Quire has its own by that name already.
    pub kept: Vec<String>,
    /// The models folder on the drive, where it was and where it is now.
    #[serde(skip)]
    pub models: Option<(PathBuf, PathBuf)>,
}

/// Give a library's files on its drive Quire's names. Each is renamed where it is, so stopping
/// halfway loses nothing: the rest is renamed the next time the library opens. A file that can't be
/// renamed fails the call once the others are done, because the library would otherwise open without
/// it, its ratings or tags looking lost.
pub fn rename_library_files(root: &Path) -> Result<Renamed, String> {
    let entries = fs::read_dir(root).map_err(|e| format!("could not read {}: {e}", root.display()))?;
    let mut out = Renamed::default();
    let mut failed = Vec::new();
    for e in entries.flatten() {
        let Some(name) = e.file_name().to_str().map(String::from) else { continue };
        let new = match name.strip_prefix(LIBRARY_PREFIX.0) {
            Some(rest) => format!("{}{rest}", LIBRARY_PREFIX.1),
            None if name == MODELS_DIR.0 => MODELS_DIR.1.to_string(),
            None => continue,
        };
        let to = root.join(&new);
        // Anything there already, a link to nowhere too, is Quire's own and stays.
        if fs::symlink_metadata(&to).is_ok() {
            out.kept.push(name);
            continue;
        }
        match fs::rename(e.path(), &to) {
            Ok(()) => {
                out.renamed += 1;
                if name == MODELS_DIR.0 {
                    out.models = Some((e.path(), to));
                }
            }
            Err(err) => failed.push(format!("{name}: {err}")),
        }
    }
    out.kept.sort();
    if !failed.is_empty() {
        failed.sort();
        return Err(format!(
            "This library's files from Media Sorter couldn't all get Quire's names, so it didn't open. Nothing of it is lost: the rest is tried again when it next opens. {}",
            failed.join("; ")
        ));
    }
    Ok(out)
}

/// Move a vault's kept originals from Media Sorter's folder name to Quire's, so Revert finds them.
/// Changes nothing when a name under Quire's is taken (see `Vault::rename_prefix`).
pub fn rename_vault_originals(v: &mut Vault) -> Result<usize, String> {
    let prefix = format!("{KEPT_DIR}/");
    if v.entries_under(&prefix).next().is_none() {
        return Ok(0);
    }
    let n = v.rename_prefix(KEPT_DIR, crate::versions::KEPT_DIR)?;
    v.flush()?;
    Ok(n)
}

/// The app's folders named by its identifier (data, cache, logs), taken over from an earlier
/// identifier when the app has none of its own yet: a folder beside each named `app.media-sorter`,
/// else any other `….media-sorter` from before that, is renamed into place, so the models, plugins,
/// settings and quick-unlock keys come along.
pub fn adopt_app_folders(app: &tauri::App) {
    use tauri::Manager;
    let paths = app.path();
    for dir in [paths.app_data_dir(), paths.app_local_data_dir(), paths.app_cache_dir(), paths.app_log_dir()].into_iter().flatten() {
        if dir.exists() {
            continue;
        }
        let (Some(parent), Some(name)) = (dir.parent(), dir.file_name().and_then(|n| n.to_str())) else { continue };
        if let Some(from) = earlier_folder(parent, name) {
            match fs::rename(&from, &dir) {
                Ok(()) => eprintln!("the app's folder {} is now {}", from.display(), dir.display()),
                Err(e) => eprintln!("could not move {} to {}: {e}", from.display(), dir.display()),
            }
        }
    }
}

/// The folder in `parent` an earlier identifier left, for the one named `name`.
fn earlier_folder(parent: &Path, name: &str) -> Option<PathBuf> {
    let exact = parent.join("app.media-sorter");
    if name != "app.media-sorter" && exact.is_dir() {
        return Some(exact);
    }
    let mut others: Vec<PathBuf> = fs::read_dir(parent)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n != name && n.ends_with(".media-sorter")))
        .collect();
    others.sort();
    others.into_iter().next()
}

/// The window's saved settings (its local storage), cookies and caches, which WebKit keeps in
/// folders named after the app: its bundle id when it is bundled, its program's name in a dev build.
/// Taken over before the window opens, which reads them as it opens.
#[cfg(target_os = "macos")]
pub fn adopt_webview_data() {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
    let library = home.join("Library");
    for (old, new) in [("app.media-sorter", "app.quire"), ("media-sorter", "quire")] {
        adopt_named(&library.join("WebKit"), old, new);
        adopt_named(&library.join("HTTPStorages"), old, new);
        adopt_named(&library.join("HTTPStorages"), &format!("{old}.binarycookies"), &format!("{new}.binarycookies"));
        adopt_named(&library.join("Caches"), old, new);
    }
}

/// Rename `base/old` to `base/new` when `new` isn't there yet. Whether it moved.
#[cfg(any(target_os = "macos", test))]
fn adopt_named(base: &Path, old: &str, new: &str) -> bool {
    let (from, to) = (base.join(old), base.join(new));
    if fs::symlink_metadata(&from).is_err() || fs::symlink_metadata(&to).is_ok() {
        return false;
    }
    match fs::rename(&from, &to) {
        Ok(()) => {
            eprintln!("{} is now {}", from.display(), to.display());
            true
        }
        Err(e) => {
            eprintln!("could not move {} to {}: {e}", from.display(), to.display());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("quire-formerly-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    /// A library as Media Sorter left it: its documents, the scrapbook's pictures, kept originals,
    /// models on the drive, a half-written temporary file and a set-aside document, beside the
    /// pictures and the system's own files.
    fn media_sorter_library(root: &Path) {
        fs::write(root.join(".mediasorter.json"), library_json()).unwrap();
        for (f, body) in [
            (".mediasorter.tags.json", r#"{"tags":{"x":1}}"#),
            (".mediasorter.history.json", "{}"),
            (".mediasorter.home.broken", "{ not json"),
            (".mediasorter.tagvectors.bin", "\u{1}\u{2}"),
            (".mediasorter.tagjournal.3.log", "rec"),
            (".mediasorter.tags.json.12.0.tmp", "half"),
            ("a.jpg", "jpeg"),
            (".DS_Store", "ds"),
        ] {
            fs::write(root.join(f), body).unwrap();
        }
        fs::create_dir_all(root.join(".mediasorter.scrapbook")).unwrap();
        fs::write(root.join(".mediasorter.scrapbook/cover-a1.jpg"), "cover").unwrap();
        fs::create_dir_all(root.join(".mediasorter.originals/d-1")).unwrap();
        fs::write(root.join(".mediasorter.originals/d-1/012.jpg"), "orig").unwrap();
        fs::create_dir_all(root.join(".media-sorter/models/siglip")).unwrap();
        fs::write(root.join(".media-sorter/models/siglip/model.onnx"), "w").unwrap();
        fs::create_dir_all(root.join(".vault")).unwrap();
        fs::create_dir_all(root.join("Albums")).unwrap();
        fs::write(root.join("Albums/.mediasorter.json"), "not the library's: inside a folder").unwrap();
    }

    /// A library file as the app writes it, with a rating in it.
    fn library_json() -> String {
        let mut lib = serde_json::to_value(crate::library::Library::default()).unwrap();
        lib["ratings"] = serde_json::json!({ "a.jpg": 7 });
        lib.to_string()
    }

    #[test]
    fn every_file_gets_quires_name_with_its_contents() {
        let root = temp("all");
        media_sorter_library(&root);
        let out = rename_library_files(&root).unwrap();
        assert_eq!(out.renamed, 10);
        assert!(out.kept.is_empty());
        assert_eq!(
            names(&root),
            [
                ".DS_Store",
                ".quire",
                ".quire.history.json",
                ".quire.home.broken",
                ".quire.json",
                ".quire.originals",
                ".quire.scrapbook",
                ".quire.tagjournal.3.log",
                ".quire.tags.json",
                ".quire.tags.json.12.0.tmp",
                ".quire.tagvectors.bin",
                ".vault",
                "Albums",
                "a.jpg",
            ]
        );
        assert_eq!(fs::read_to_string(root.join(".quire.json")).unwrap(), library_json());
        assert_eq!(fs::read_to_string(root.join(".quire.scrapbook/cover-a1.jpg")).unwrap(), "cover");
        assert_eq!(fs::read_to_string(root.join(".quire.originals/d-1/012.jpg")).unwrap(), "orig");
        assert_eq!(fs::read_to_string(root.join(".quire/models/siglip/model.onnx")).unwrap(), "w");
        assert_eq!(out.models, Some((root.join(".media-sorter"), root.join(".quire"))));
        // Only the library's own folder is looked at: a file of that name deeper down isn't its.
        assert!(root.join("Albums/.mediasorter.json").is_file());
        // The library reads as before under its new name.
        let lib = crate::library::Library::load(&root).unwrap();
        assert_eq!(serde_json::to_value(&lib).unwrap()["ratings"], serde_json::json!({ "a.jpg": 7 }));
    }

    #[test]
    fn opening_again_changes_nothing() {
        let root = temp("again");
        media_sorter_library(&root);
        rename_library_files(&root).unwrap();
        let before = names(&root);
        let out = rename_library_files(&root).unwrap();
        assert_eq!((out.renamed, out.kept.len()), (0, 0));
        assert_eq!(names(&root), before);
    }

    #[test]
    fn a_rename_stopped_halfway_finishes_next_time() {
        let root = temp("halfway");
        media_sorter_library(&root);
        // As if the app stopped after the first two.
        fs::rename(root.join(".mediasorter.json"), root.join(".quire.json")).unwrap();
        fs::rename(root.join(".mediasorter.scrapbook"), root.join(".quire.scrapbook")).unwrap();
        let out = rename_library_files(&root).unwrap();
        assert_eq!(out.renamed, 8);
        assert!(out.kept.is_empty());
        assert!(!names(&root).iter().any(|n| n.starts_with(".mediasorter") || n == ".media-sorter"));
    }

    #[test]
    fn quires_own_file_is_never_overwritten() {
        let root = temp("both");
        media_sorter_library(&root);
        // Quire wrote its own since (an older build of the app ran in between, say).
        fs::write(root.join(".quire.tags.json"), r#"{"tags":{"new":1}}"#).unwrap();
        fs::create_dir_all(root.join(".quire.scrapbook")).unwrap();
        let out = rename_library_files(&root).unwrap();
        assert_eq!(out.kept, [".mediasorter.scrapbook", ".mediasorter.tags.json"]);
        assert_eq!(fs::read_to_string(root.join(".quire.tags.json")).unwrap(), r#"{"tags":{"new":1}}"#);
        assert_eq!(fs::read_to_string(root.join(".mediasorter.tags.json")).unwrap(), r#"{"tags":{"x":1}}"#);
        assert!(root.join(".mediasorter.scrapbook/cover-a1.jpg").is_file());
        assert!(root.join(".quire.json").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_file_that_cant_be_renamed_stops_the_library_opening() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp("readonly");
        media_sorter_library(&root);
        // A folder the app may read but not change (a locked card, say).
        fs::set_permissions(&root, fs::Permissions::from_mode(0o555)).unwrap();
        let err = rename_library_files(&root);
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let err = err.unwrap_err();
        assert!(err.contains("didn't open") && err.contains(".mediasorter.json"), "{err}");
        // Nothing moved, nothing lost.
        assert!(root.join(".mediasorter.json").is_file() && !root.join(".quire.json").exists());
    }

    #[test]
    fn a_folder_that_isnt_a_library_is_left_alone() {
        let root = temp("plain");
        fs::write(root.join("a.jpg"), "jpeg").unwrap();
        fs::write(root.join(".mediasorterish"), "not ours").unwrap();
        let out = rename_library_files(&root).unwrap();
        assert_eq!(out.renamed, 0);
        assert_eq!(names(&root), [".mediasorterish", "a.jpg"]);
        assert!(rename_library_files(&root.join("gone")).is_err());
    }

    #[test]
    fn a_vaults_kept_originals_move_under_quires_folder() {
        let root = temp("vault");
        fs::write(root.join("p0.png"), "one").unwrap();
        fs::write(root.join("p1.png"), "two").unwrap();
        let mut v = Vault::create(&root, "correct horse battery staple").unwrap();
        v.add_file(&root.join("p0.png"), &format!("{KEPT_DIR}/d-1/p0.png")).unwrap();
        v.add_file(&root.join("p1.png"), "Albums/Book/p1.png").unwrap();
        v.flush().unwrap();
        assert_eq!(rename_vault_originals(&mut v).unwrap(), 1);
        drop(v);
        // As the vault is unlocked again: the originals are where Revert looks, the rest unmoved.
        let mut v = Vault::unlock(&root, "correct horse battery staple").unwrap();
        let kept = v.entry_by_rel(&format!("{}/d-1/p0.png", crate::versions::KEPT_DIR)).expect("kept original found under Quire's folder").clone();
        assert_eq!(v.read_all(&kept.id).unwrap(), b"one");
        assert!(v.entry_by_rel("Albums/Book/p1.png").is_some());
        assert!(v.entries_under(&format!("{KEPT_DIR}/")).next().is_none());
        assert_eq!(rename_vault_originals(&mut v).unwrap(), 0, "nothing left to move");
    }

    #[test]
    fn what_media_sorter_left_beside_a_vault_still_goes_in() {
        let root = temp("vault-beside");
        let v = Vault::create(&root, "correct horse battery staple").unwrap();
        // An earlier version left the library's tags and a sticker in the clear beside its vault.
        fs::write(root.join(".mediasorter.tags.json"), r#"{"tags":{"x":1}}"#).unwrap();
        fs::create_dir_all(root.join(".mediasorter.scrapbook")).unwrap();
        fs::write(root.join(".mediasorter.scrapbook/sticker-1.png"), "png").unwrap();
        // As the library opens: Quire's names first, then the vault takes in what is beside it.
        rename_library_files(&root).unwrap();
        let moved = crate::libdocs::move_in(&v, &root).unwrap();
        assert!(moved.documents.contains(&"tags".to_string()), "{moved:?}");
        assert_eq!(moved.pictures, 1);
        assert_eq!(v.read_meta("tags").unwrap().unwrap(), br#"{"tags":{"x":1}}"#);
        assert!(!root.join(".quire.tags.json").exists() && !root.join(".quire.scrapbook").exists(), "nothing left in the clear");
    }

    #[test]
    fn a_vault_original_quire_has_already_stays_where_it_is() {
        let root = temp("vault-both");
        fs::write(root.join("p0.png"), "one").unwrap();
        let mut v = Vault::create(&root, "correct horse battery staple").unwrap();
        v.add_file(&root.join("p0.png"), &format!("{KEPT_DIR}/d-1/p0.png")).unwrap();
        v.add_file(&root.join("p0.png"), &format!("{}/d-1/p0.png", crate::versions::KEPT_DIR)).unwrap();
        assert!(rename_vault_originals(&mut v).is_err());
        assert!(v.entry_by_rel(&format!("{KEPT_DIR}/d-1/p0.png")).is_some(), "the old one is still found");
    }

    #[test]
    fn the_apps_folders_come_from_media_sorters() {
        let base = temp("folders");
        fs::create_dir_all(base.join("app.media-sorter/plugins")).unwrap();
        fs::create_dir_all(base.join("com.example.media-sorter")).unwrap();
        assert_eq!(earlier_folder(&base, "app.quire"), Some(base.join("app.media-sorter")), "the latest name first");
        fs::remove_dir_all(base.join("app.media-sorter")).unwrap();
        assert_eq!(earlier_folder(&base, "app.quire"), Some(base.join("com.example.media-sorter")));
        assert_eq!(earlier_folder(&base, "com.example.media-sorter"), None);
    }

    #[test]
    fn the_windows_saved_settings_move_once() {
        let base = temp("webkit");
        fs::create_dir_all(base.join("media-sorter/WebsiteData/LocalStorage")).unwrap();
        fs::write(base.join("media-sorter/WebsiteData/LocalStorage/x.sqlite3"), "theme").unwrap();
        assert!(adopt_named(&base, "media-sorter", "quire"));
        assert_eq!(fs::read_to_string(base.join("quire/WebsiteData/LocalStorage/x.sqlite3")).unwrap(), "theme");
        // Quire's own is never replaced.
        fs::create_dir_all(base.join("media-sorter")).unwrap();
        assert!(!adopt_named(&base, "media-sorter", "quire"));
        assert!(base.join("media-sorter").is_dir() && base.join("quire/WebsiteData").is_dir());
        assert!(!adopt_named(&base, "app.media-sorter", "app.quire"), "nothing there");
    }
}
