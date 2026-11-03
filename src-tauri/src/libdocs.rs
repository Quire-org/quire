//! The library's own documents (its library file, history, tags, Home, scrapbook, artists, people,
//! the tag index and its journals, plugins' documents…) and the scrapbook's pictures (covers,
//! stickers, artists' icons): moved into a vault when one is made, and back out when it is taken
//! apart, found by their file names rather than from a list, so every one goes, however many kinds
//! there come to be.
//!
//! Vaults made before this went by a fixed list that predated Tags, Home and Scrapbook: those stayed
//! in the clear beside the vault, unseen by the app (which reads only the vault's), so the library
//! seemed to have lost them. `move_in` brings them in as the vault opens, too (see `theirs_win`).

use crate::vault::Vault;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const PREFIX: &str = ".quire.";
/// The library file has a name of its own (see `library::LIBRARY_FILE`); in a vault it is "library".
const LIBRARY_FILE: &str = crate::library::LIBRARY_FILE;
/// The scrapbook's pictures in the clear (see `fsx::Ctx::save_blob`).
const BLOBS_DIR: &str = ".quire.scrapbook";
/// Documents kept as bytes rather than text (`Ctx::save_meta_bytes`): in the clear they end in `.bin`.
/// (`tagvectors-next` and `-old` are what an earlier version left of a remade tag index: they still
/// move as bytes until the index loads and they go, see `EARLIER_INDEX_FILES` in lib.rs.)
const BYTES: &[&str] = &["faces", "tagvectors", "tagvectors-next", "tagvectors-old"];

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    /// `.quire.<name>.json` (the library file: `.quire.json`).
    Text,
    /// `.quire.<name>.bin`.
    Bytes,
    /// `.quire.<name>.log`: records, each written on its own (`Ctx::append_meta_record`).
    Log,
    /// `.quire.<name>.broken`: one that wouldn't read, set aside (its name ends in `.broken`).
    Broken,
}

struct PlainDoc {
    name: String,
    kind: Kind,
    path: PathBuf,
}

/// What a move into a vault did.
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    /// Documents brought in that the vault didn't have.
    pub documents: Vec<String>,
    /// Ones from before that took the place of the vault's own, made since (kept aside).
    pub restored: Vec<String>,
    /// Ones from before kept aside, the vault's own staying in use.
    pub aside: Vec<String>,
    /// Scrapbook pictures brought in.
    pub pictures: usize,
}

impl Moved {
    /// Whether any of the tag index's files changed.
    pub fn tag_index_changed(&self) -> bool {
        self.documents.iter().chain(&self.restored).any(|n| tag_index_doc(n))
    }
}

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 120 && !n.starts_with('.') && !n.contains("..") && n.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

fn tag_index_doc(name: &str) -> bool {
    name.starts_with("tagindex") || name.starts_with("tagvectors") || name.starts_with("tagjournal")
}

/// The library's documents in the clear in `root`, by their file names.
fn plain_docs(root: &Path) -> Vec<PlainDoc> {
    let mut out = Vec::new();
    for e in fs::read_dir(root).into_iter().flatten().flatten() {
        if !e.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let file = e.file_name().to_string_lossy().into_owned();
        let doc = if file == LIBRARY_FILE {
            Some(("library".to_string(), Kind::Text))
        } else if let Some(rest) = file.strip_prefix(PREFIX) {
            if let Some(n) = rest.strip_suffix(".json") {
                Some((n.to_string(), Kind::Text))
            } else if let Some(n) = rest.strip_suffix(".bin") {
                Some((n.to_string(), Kind::Bytes))
            } else if let Some(n) = rest.strip_suffix(".log") {
                Some((n.to_string(), Kind::Log))
            } else if rest.ends_with(".broken") {
                Some((rest.to_string(), Kind::Broken))
            } else {
                None
            }
        } else {
            None
        };
        // "library" in the clear is only ever the library file itself.
        if let Some((name, kind)) = doc
            && valid_name(&name)
            && (name != "library" || file == LIBRARY_FILE)
        {
            out.push(PlainDoc { name, kind, path: e.path() });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A document's file in the clear.
fn plain_file(name: &str, kind: Kind) -> String {
    match kind {
        _ if name == "library" => LIBRARY_FILE.to_string(),
        Kind::Text => format!("{PREFIX}{name}.json"),
        Kind::Bytes => format!("{PREFIX}{name}.bin"),
        Kind::Log => format!("{PREFIX}{name}.log"),
        Kind::Broken => format!("{PREFIX}{name}"),
    }
}

/// Documents that hold the reader's own work, found in the clear beside a vault that has its own:
/// the one in the clear is from before the vault (an earlier version's move left it behind, and the
/// vault's own was made since, empty or remade), so it comes back and the vault's is kept aside.
/// Nothing is written in the clear beside a vault any more (see `fsx::LOCKED`). The library file,
/// what was seen, the cache and the snapshot stay the vault's (those it always took in, or ones
/// remade as the library is used), the one in the clear kept aside.
fn theirs_win(name: &str) -> bool {
    !matches!(name, "library" | "history" | "cache" | "snapshot" | "views") && !name.ends_with(".broken")
}

/// A free name to keep a document aside under: `<name>.<why>`, numbered when taken.
fn aside_name(v: &Vault, name: &str, why: &str) -> String {
    let mut n = format!("{name}.{why}");
    let mut k = 2;
    while v.has_meta(&n) || v.has_meta_log(&n) {
        n = format!("{name}.{why}{k}");
        k += 1;
    }
    n
}

/// A free name for a picture kept aside: `<stem>-leftover.<ext>`, numbered when taken.
fn aside_blob(v: &Vault, name: &str) -> String {
    let (stem, ext) = name.rsplit_once('.').unwrap_or((name, "png"));
    let mut n = format!("{stem}-leftover.{ext}");
    let mut k = 2;
    while v.has_blob(&n) {
        n = format!("{stem}-leftover{k}.{ext}");
        k += 1;
    }
    n
}

/// Every document and scrapbook picture of the library in the clear, into the vault, each gone from
/// the clear once it is in. Into a vault that already has its own of some (one opening with what an
/// earlier version left out), see `theirs_win`: nothing is dropped, whichever stays in use.
pub fn move_in(v: &Vault, root: &Path) -> Result<Moved, String> {
    let mut m = Moved::default();
    for d in plain_docs(root) {
        let bytes = fs::read(&d.path).map_err(|e| format!("read {}: {e}", d.path.display()))?;
        let there = if d.kind == Kind::Log { v.has_meta_log(&d.name) } else { v.has_meta(&d.name) };
        let target = if !there {
            m.documents.push(d.name.clone());
            d.name.clone()
        } else if theirs_win(&d.name) {
            v.rename_meta(&d.name, &aside_name(v, &d.name, "replaced"))?;
            m.restored.push(d.name.clone());
            d.name.clone()
        } else {
            let aside = aside_name(v, &d.name, "leftover");
            m.aside.push(aside.clone());
            aside
        };
        if d.kind == Kind::Log {
            for r in crate::fsx::records(&bytes) {
                v.append_meta_record(&target, r)?;
            }
        } else {
            v.write_meta(&target, &bytes)?;
        }
        fs::remove_file(&d.path).map_err(|e| format!("remove {}: {e}", d.path.display()))?;
    }
    let dir = root.join(BLOBS_DIR);
    for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !e.file_type().is_ok_and(|t| t.is_file()) || name.starts_with('.') || name.ends_with(".tmp") {
            continue;
        }
        let bytes = fs::read(e.path()).map_err(|e| e.to_string())?;
        if !v.has_blob(&name) {
            v.write_blob(&name, &bytes)?;
        } else if v.read_blob(&name)?.as_deref() != Some(&bytes[..]) {
            v.write_blob(&aside_blob(v, &name), &bytes)?;
        }
        fs::remove_file(e.path()).map_err(|e| e.to_string())?;
        m.pictures += 1;
    }
    // Gone when empty (only the system's own files left in it, say, it stays).
    let _ = fs::remove_dir(&dir);
    Ok(m)
}

/// Every document and scrapbook picture in the vault, back in the clear beside the library (as the
/// vault is taken apart). One already there in the clear is kept, renamed `….leftover`. How many.
pub fn move_out(v: &Vault, root: &Path) -> Result<usize, String> {
    let mut n = 0;
    for (name, log) in v.meta_docs() {
        let (bytes, kind) = if log {
            let mut out = Vec::new();
            for r in v.read_meta_records(&name)? {
                out.extend_from_slice(&(r.len() as u32).to_le_bytes());
                out.extend_from_slice(&r);
            }
            (out, Kind::Log)
        } else {
            let bytes = v.read_meta(&name)?.unwrap_or_default();
            let kind = if name.ends_with(".broken") {
                Kind::Broken
            } else if BYTES.contains(&name.as_str()) || std::str::from_utf8(&bytes).is_err() {
                Kind::Bytes
            } else {
                Kind::Text
            };
            (bytes, kind)
        };
        let p = root.join(plain_file(&name, kind));
        if p.exists() {
            let file = p.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
            fs::rename(&p, p.with_file_name(format!("{file}.leftover"))).map_err(|e| e.to_string())?;
        }
        crate::fsx::write_atomic(&p, &bytes)?;
        n += 1;
    }
    let names = v.blob_names();
    if !names.is_empty() {
        fs::create_dir_all(root.join(BLOBS_DIR)).map_err(|e| e.to_string())?;
    }
    for name in names {
        if let Some(bytes) = v.read_blob(&name)? {
            crate::fsx::write_atomic(&root.join(BLOBS_DIR).join(&name), &bytes)?;
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-libdocs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A library's documents in the clear, as the app writes them without a vault: made through the
    /// app's own storage layer, so every kind there is (text, bytes, logs, pictures) is covered.
    fn plain_library(root: &Path) {
        let ctx = crate::fsx::Ctx::new(root, None);
        fs::write(root.join(LIBRARY_FILE), br#"{"version":1,"ratings":{"a.jpg":5}}"#).unwrap();
        for (name, text) in [("tags", r#"{"tags":["sky"]}"#), ("home", r#"{"blocks":[1]}"#), ("scrapbook", r#"{"stickers":[1]}"#), ("snapshot", "{}"), ("artists", r#"{"a":1}"#), ("tagindex", r#"{"seq":3}"#), ("plugin-page-reader", "{}")] {
            ctx.save_meta(name, text).unwrap();
        }
        ctx.save_meta_bytes("tagvectors", &[0, 159, 255]).unwrap();
        ctx.save_meta_bytes("faces", &[1, 2, 3]).unwrap();
        ctx.append_meta_record("tagjournal.3", b"one").unwrap();
        ctx.append_meta_record("tagjournal.3", b"two").unwrap();
        ctx.save_blob("sticker-b2.png", b"PNG sticker").unwrap();
        ctx.save_blob("artist-x1.jpg", b"JPEG icon").unwrap();
        fs::write(root.join(".quire.home.broken"), b"{ not json").unwrap();
        // Not documents: media, a hidden file of the system's, a half-written save.
        fs::write(root.join("a.jpg"), b"picture").unwrap();
        fs::write(root.join(".DS_Store"), b"x").unwrap();
        fs::write(root.join(".quire.tags.json.12.0.tmp"), b"half").unwrap();
    }

    /// What the app would read for each, through its storage layer.
    fn read_all(root: &Path, v: Option<&mut Vault>) -> Vec<String> {
        let ctx = crate::fsx::Ctx::new(root, v);
        let mut out = vec![];
        for name in ["tags", "home", "scrapbook", "snapshot", "artists", "tagindex", "plugin-page-reader"] {
            out.push(format!("{name}={}", ctx.load_meta(name).unwrap().unwrap_or_default()));
        }
        out.push(format!("tagvectors={:?}", ctx.load_meta_bytes("tagvectors").unwrap()));
        out.push(format!("faces={:?}", ctx.load_meta_bytes("faces").unwrap()));
        out.push(format!("journal={:?}", ctx.load_meta_records("tagjournal.3").unwrap()));
        out.push(format!("sticker={:?}", ctx.load_blob("sticker-b2.png").unwrap()));
        out.push(format!("icon={:?}", ctx.load_blob("artist-x1.jpg").unwrap()));
        out
    }

    #[test]
    fn every_document_and_picture_goes_into_a_new_vault_and_back_out() {
        let root = tmp("both-ways");
        plain_library(&root);
        let before = read_all(&root, None);
        let mut v = Vault::create(&root, "a long enough passphrase").unwrap();
        let m = move_in(&v, &root).unwrap();
        assert_eq!(m.pictures, 2);
        assert!(m.restored.is_empty() && m.aside.is_empty());
        // Nothing of the library left in the clear but its media (and what isn't the app's).
        let left: Vec<String> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != ".vault").collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        assert_eq!(left, [".DS_Store", ".quire.tags.json.12.0.tmp", "a.jpg"]);
        assert_eq!(read_all(&root, Some(&mut v)), before, "the app reads the same from the vault");
        assert_eq!(v.read_meta("library").unwrap().unwrap(), br#"{"version":1,"ratings":{"a.jpg":5}}"#);
        assert_eq!(v.read_meta("home.broken").unwrap().unwrap(), b"{ not json");

        // Taken apart: all of it back in the clear, read as before.
        let n = move_out(&v, &root).unwrap();
        assert!(n >= 13, "{n}");
        assert_eq!(read_all(&root, None), before);
        assert_eq!(fs::read(root.join(LIBRARY_FILE)).unwrap(), br#"{"version":1,"ratings":{"a.jpg":5}}"#);
        assert_eq!(fs::read(root.join(".quire.home.broken")).unwrap(), b"{ not json");
        assert!(root.join(".quire.tagvectors.bin").is_file() && root.join(".quire.faces.bin").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn what_an_earlier_vault_left_in_the_clear_comes_in_as_it_opens() {
        let root = tmp("adopt");
        plain_library(&root);
        let before = read_all(&root, None);
        let mut v = Vault::create(&root, "a long enough passphrase").unwrap();
        // As the old list did: only the library file, history, artists, people, faces… moved in.
        for name in ["library", "artists", "faces", "plugin-page-reader"] {
            let file = root.join(plain_file(name, if name == "faces" { Kind::Bytes } else { Kind::Text }));
            v.write_meta(name, &fs::read(&file).unwrap()).unwrap();
            fs::remove_file(file).unwrap();
        }
        // Since then, with the rest unseen: an empty Home, a remade tag index and artists in the vault,
        // and a snapshot of where files are (remade as the library is used).
        v.write_meta("home", br#"{"blocks":[]}"#).unwrap();
        v.write_meta("tagindex", br#"{"seq":9}"#).unwrap();
        v.write_meta("artists", br#"{"a":2}"#).unwrap();
        fs::write(root.join(".quire.artists.json"), br#"{"a":1}"#).unwrap();
        v.write_meta("snapshot", br#"{"new":1}"#).unwrap();

        let m = move_in(&v, &root).unwrap();
        assert_eq!(m.restored, ["artists", "home", "tagindex"]);
        assert_eq!(m.aside, ["snapshot.leftover"]);
        assert!(m.documents.contains(&"tags".to_string()) && m.documents.contains(&"scrapbook".to_string()));
        assert_eq!(m.pictures, 2);
        assert!(m.tag_index_changed());
        // The reader's own work as it was; the vault's snapshot stays; nothing dropped.
        let mut after = read_all(&root, Some(&mut v));
        assert_eq!(after.remove(3), r#"snapshot={"new":1}"#);
        let mut expected = before.clone();
        expected.remove(3);
        assert_eq!(after, expected);
        assert_eq!(v.read_meta("home.replaced").unwrap().unwrap(), br#"{"blocks":[]}"#);
        assert_eq!(v.read_meta("tagindex.replaced").unwrap().unwrap(), br#"{"seq":9}"#);
        assert_eq!(v.read_meta("artists.replaced").unwrap().unwrap(), br#"{"a":2}"#);
        assert_eq!(v.read_meta("snapshot.leftover").unwrap().unwrap(), b"{}");
        assert!(!root.join(".quire.tags.json").exists() && !root.join(BLOBS_DIR).exists(), "nothing of it left in the clear");
        // Opening again finds nothing more to do.
        let again = move_in(&v, &root).unwrap();
        assert!(again.documents.is_empty() && again.restored.is_empty() && again.aside.is_empty() && again.pictures == 0);
        let _ = fs::remove_dir_all(&root);
    }
}
