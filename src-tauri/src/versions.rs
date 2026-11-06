//! Versions: a picture made from another (an edit, a plugin's result) keeps a link to the one it was
//! made from. Both are known by their content fingerprints, so the link follows either file through
//! any move or rename, in the app or outside it, and no file is ever written into to hold it.
//!
//! An original that was replaced is kept in `.quire.originals/<its fingerprint>/` under its
//! own file names (in the vault, encrypted, when there is one), so Revert puts it back as it was.
//! When the version is deleted for good, its kept original goes with it.

use crate::fsx::Ctx;
use crate::media::{self, FileRef, MediaItem};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub const KEPT_DIR: &str = ".quire.originals";
const DOC: &str = "versions";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    /// The picture it was made from: its fingerprint, and its file name then.
    pub from: String,
    pub from_name: String,
    /// Where each was when the link was made (keys): where to look first.
    pub made_at: String,
    pub from_at: String,
    /// What made it ("edit", or a plugin's id) and what such a version is called ("edited").
    pub by: String,
    pub note: String,
    pub at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Versions {
    /// A version's fingerprint -> what it was made from.
    #[serde(default)]
    pub links: BTreeMap<String, Link>,
}

/// The links; an unreadable document is an error, never taken for an empty one (and written over).
/// A link whose original isn't named by a fingerprint isn't one this app made (the file is on the
/// drive, for anyone to write): it is left out, so its name is never made into a path.
pub fn load(ctx: &Ctx) -> Result<Versions, String> {
    let mut v: Versions = match ctx.load_meta(DOC)? {
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("the versions file can't be read: {e}"))?,
        None => return Ok(Versions::default()),
    };
    v.links.retain(|_, l| is_fingerprint(&l.from));
    Ok(v)
}

/// A fingerprint as `dupes::fingerprint_with` makes one: the size in hex, a dash, 16 hex digits.
/// Nothing else names a kept original's folder.
fn is_fingerprint(s: &str) -> bool {
    let hex = |p: &str| p.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    s.split_once('-').is_some_and(|(size, hash)| (1..=16).contains(&size.len()) && hash.len() == 16 && hex(size) && hex(hash))
}

/// Changes to the links one at a time: plain folders take commands side by side.
fn changing() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn save(ctx: &Ctx, v: &Versions) -> Result<(), String> {
    ctx.save_meta(DOC, &serde_json::to_string(v).map_err(|e| e.to_string())?)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// A fingerprint starts with the file's size: files of no other size are never read to look for one.
fn sized(size: u64) -> String {
    format!("{size:x}-")
}

/// The kept original's folder: in `KEPT_DIR`, named by its fingerprint. Anything that isn't one (see
/// `load`) is a folder that never exists there, never a path out of it.
pub fn kept_dir(root: &Path, from: &str) -> PathBuf {
    root.join(KEPT_DIR).join(if is_fingerprint(from) { from } else { ".not-a-fingerprint" })
}

/// The kept original's files (on disk or in the vault); none when it isn't kept.
pub fn kept_files(ctx: &Ctx, from: &str) -> Vec<FileRef> {
    let dir = kept_dir(&ctx.root, from);
    let mut out: Vec<FileRef> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false) && !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| ctx.stat(&e.path()).map(|(size, modified)| FileRef { path: e.path(), size, modified }))
        .collect();
    if let Some(v) = ctx.vault.as_deref() {
        out.extend(v.entries_under(&format!("{KEPT_DIR}/{from}/")).map(|e| FileRef { path: ctx.root.join(&e.rel), size: e.size, modified: e.mtime }));
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// The kept original as an item (which of its files is shown, and what it is).
fn kept_item(ctx: &Ctx, from: &str) -> Option<MediaItem> {
    let files = kept_files(ctx, from);
    media::build_items(&ctx.root, &kept_dir(&ctx.root, from), files).into_iter().next()
}

/// Where an original goes as it is replaced: kept under its fingerprint; or, when that picture is
/// kept already, the trash (the kept one is all Revert needs).
pub fn put_away_to(ctx: &Ctx, from: &str, trash: &Path) -> PathBuf {
    if kept_files(ctx, from).is_empty() { kept_dir(&ctx.root, from) } else { trash.to_path_buf() }
}

/// The version just written at `made` was made from the picture whose fingerprint is `from`, which
/// was at `from_at` then. Nothing to link when the two are the same bytes.
pub fn note_made(ctx: &Ctx, made: &Path, from: &str, from_at: &Path, by: &str, note: &str) -> Result<(), String> {
    let fp = ctx.fingerprint(made)?;
    if fp == from {
        return Ok(());
    }
    let _one = changing();
    let mut v = load(ctx)?;
    v.links.insert(
        fp,
        Link { from: from.to_string(), from_name: name_of(from_at), made_at: media::rel_key(&ctx.root, made), from_at: media::rel_key(&ctx.root, from_at), by: by.to_string(), note: note.to_string(), at: now_ms() },
    );
    save(ctx, &v)
}

/// The file at `p`'s fingerprint, when a version or an original could have it.
fn fingerprint_if(ctx: &Ctx, p: &Path, mut could: impl FnMut(&str) -> bool) -> Option<String> {
    let (size, _) = ctx.stat(p)?;
    if !could(&sized(size)) {
        return None;
    }
    ctx.fingerprint(p).ok()
}

/// What the file at `p` was made from, when it is a version.
fn link_of(ctx: &Ctx, v: &Versions, p: &Path) -> Option<(String, Link)> {
    let fp = fingerprint_if(ctx, p, |s| v.links.keys().any(|k| k.starts_with(s)))?;
    v.links.get(&fp).map(|l| (fp, l.clone()))
}

/// The first of `places` that holds the picture whose fingerprint is `fp`.
fn found(ctx: &Ctx, fp: &str, places: &[PathBuf]) -> Option<PathBuf> {
    places.iter().find(|p| ctx.stat(p).is_some_and(|(s, _)| fp.starts_with(&sized(s))) && ctx.fingerprint(p).ok().as_deref() == Some(fp)).cloned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Made {
    /// Its fingerprint.
    pub made: String,
    pub link: Link,
    /// Where it is, when it is still where it was made.
    pub path: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// Its fingerprint, when it is a version or an original (read only then).
    pub fp: Option<String>,
    /// What it was made from, when it is a version.
    pub link: Option<Link>,
    /// The original, kept for Revert: the file that shows it.
    pub kept: Option<String>,
    /// The original where it is in the library (a copy was saved beside it), when it is still there.
    pub original: Option<String>,
    /// Versions made from it.
    pub versions: Vec<Made>,
}

/// What is known of the file at `p`: what it was made from, whether that is kept, and what was made from it.
pub fn info(ctx: &Ctx, p: &Path) -> Result<Info, String> {
    let v = load(ctx)?;
    let Some(fp) = fingerprint_if(ctx, p, |s| v.links.iter().any(|(k, l)| k.starts_with(s) || l.from.starts_with(s))) else {
        return Ok(Info::default());
    };
    let mut out = Info { fp: Some(fp.clone()), ..Info::default() };
    if let Some(l) = v.links.get(&fp) {
        out.kept = kept_item(ctx, &l.from).map(|i| i.primary);
        if out.kept.is_none() {
            let beside = p.parent().map(|d| d.join(&l.from_name)).into_iter();
            out.original = found(ctx, &l.from, &std::iter::once(ctx.root.join(&l.from_at)).chain(beside).collect::<Vec<_>>()).map(|p| p.to_string_lossy().into_owned());
        }
        out.link = Some(l.clone());
    }
    out.versions = v.links.iter().filter(|(_, l)| l.from == fp).map(|(made, l)| Made { made: made.clone(), link: l.clone(), path: found(ctx, made, &[ctx.root.join(&l.made_at)]).map(|p| p.to_string_lossy().into_owned()) }).collect();
    Ok(out)
}

pub struct Reverted {
    /// (where it was, where it is now) for every file moved, in the order Undo moves them back.
    pub moves: Vec<(PathBuf, PathBuf)>,
    /// The original's files, back in the folder.
    pub restored: Vec<PathBuf>,
}

/// The version at `primary` (with its `files`) replaced by the original kept for it: the version to
/// the trash, the original back in the folder under its own names.
pub fn revert(ctx: &mut Ctx, primary: &Path, files: &[PathBuf], trash: &Path) -> Result<Reverted, String> {
    let v = load(ctx)?;
    let (_, link) = link_of(ctx, &v, primary).ok_or("It wasn't made from another picture here.")?;
    let kept: Vec<PathBuf> = kept_files(ctx, &link.from).into_iter().map(|f| f.path).collect();
    if kept.is_empty() {
        return Err(format!("{} isn't kept.", link.from_name));
    }
    let dir = primary.parent().ok_or("no folder")?.to_path_buf();
    let trashed = ctx.move_group(files, trash)?;
    let restored = match ctx.move_group(&kept, &dir) {
        Ok(r) => r,
        Err(e) => {
            for (f, t) in files.iter().zip(&trashed) {
                let _ = ctx.move_one(t, f);
            }
            return Err(e);
        }
    };
    let _ = std::fs::remove_dir_all(kept_dir(&ctx.root, &link.from));
    let mut moves: Vec<(PathBuf, PathBuf)> = kept.into_iter().zip(restored.iter().cloned()).collect();
    moves.extend(files.iter().cloned().zip(trashed));
    Ok(Reverted { moves, restored })
}

/// Whether a file of this size could be a version (and is worth a fingerprint before it goes).
/// Files or folders that moved (`[old key, new key]`, a folder's pair covering everything under it):
/// where each link looks first for a version and its original follows them, so Info still finds
/// both. Written only when one changed.
pub fn follow(ctx: &Ctx, pairs: &[(String, String)]) -> Result<bool, String> {
    let _one = changing();
    let mut v = load(ctx)?;
    let moved = |k: &str| {
        pairs.iter().find_map(|(from, to)| {
            if k == from {
                Some(to.clone())
            } else {
                k.strip_prefix(from.as_str()).filter(|rest| rest.starts_with('/')).map(|rest| format!("{to}{rest}"))
            }
        })
    };
    let mut changed = false;
    for link in v.links.values_mut() {
        for at in [&mut link.made_at, &mut link.from_at] {
            if let Some(to) = moved(at) {
                *at = to;
                changed = true;
            }
        }
    }
    if changed {
        save(ctx, &v)?;
    }
    Ok(changed)
}

pub fn could_be_version(v: &Versions, size: u64) -> bool {
    let s = sized(size);
    v.links.keys().any(|k| k.starts_with(&s))
}

/// Versions deleted for good: their links go, and the originals kept for them (an original that was
/// itself a version, with its own).
pub fn forget(ctx: &mut Ctx, gone: Vec<String>) -> Result<(), String> {
    if gone.is_empty() {
        return Ok(());
    }
    let _one = changing();
    let mut v = load(ctx)?;
    let mut todo = gone;
    let mut changed = false;
    while let Some(fp) = todo.pop() {
        let Some(link) = v.links.remove(&fp) else { continue };
        changed = true;
        let kept = kept_files(ctx, &link.from);
        if kept.is_empty() {
            continue;
        }
        for f in &kept {
            ctx.remove(&f.path)?;
        }
        let _ = std::fs::remove_dir_all(kept_dir(&ctx.root, &link.from));
        todo.push(link.from);
    }
    if changed {
        save(ctx, &v)?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub originals: usize,
    pub bytes: u64,
}

/// Every original kept, by its folder: on disk, and in the vault.
fn all_kept(ctx: &Ctx) -> Vec<(String, FileRef)> {
    let dir = ctx.root.join(KEPT_DIR);
    let mut out: Vec<(String, FileRef)> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .flat_map(|e| {
            let from = e.file_name().to_string_lossy().into_owned();
            kept_files(&Ctx::reading(&ctx.root, None), &from).into_iter().map(move |f| (from.clone(), f))
        })
        .collect();
    if let Some(v) = ctx.vault.as_deref() {
        let prefix = format!("{KEPT_DIR}/");
        out.extend(v.entries_under(&prefix).filter_map(|e| {
            let from = e.rel[prefix.len()..].split('/').next()?.to_string();
            Some((from, FileRef { path: ctx.root.join(&e.rel), size: e.size, modified: e.mtime }))
        }));
    }
    out
}

pub fn kept(ctx: &Ctx) -> Kept {
    let all = all_kept(ctx);
    Kept { originals: all.iter().map(|(f, _)| f).collect::<BTreeSet<_>>().len(), bytes: all.iter().map(|(_, f)| f.size).sum() }
}

/// Every kept original deleted (the links stay: a version still says what it was made from).
pub fn forget_kept(ctx: &mut Ctx) -> Result<usize, String> {
    let all = all_kept(ctx);
    let n = all.iter().map(|(f, _)| f).collect::<BTreeSet<_>>().len();
    for (_, f) in &all {
        ctx.remove(&f.path)?;
    }
    let _ = std::fs::remove_dir_all(ctx.root.join(KEPT_DIR));
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;
    use std::fs;

    fn root(name: &str) -> PathBuf {
        let r = std::env::temp_dir().join(format!("ms-versions-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&r);
        fs::create_dir_all(r.join("Album")).unwrap();
        r
    }

    #[test]
    fn a_kept_original_named_by_anything_but_a_fingerprint_stays_in_the_kept_folder() {
        let lib = Path::new("/library");
        assert!(is_fingerprint("1a2b-0123456789abcdef"));
        for name in ["../..", "../../Documents", "/Users/someone", "1a2b-0123456789abcdeg", "1a2b-0123", "-0123456789abcdef", ""] {
            assert!(!is_fingerprint(name), "{name}");
            assert_eq!(kept_dir(lib, name).parent(), Some(lib.join(KEPT_DIR).as_path()), "{name}");
        }
    }

    /// An edit's result written beside its original, as edit.rs and the plugin host do.
    fn replace(ctx: &mut Ctx, original: &[PathBuf], made: &Path, bytes: &[u8], trash: &Path) -> String {
        let from = ctx.fingerprint(&original[0]).unwrap();
        let to = put_away_to(ctx, &from, trash);
        ctx.move_group(original, &to).unwrap();
        fs::write(made, bytes).unwrap();
        note_made(ctx, made, &from, &original[0], "edit", "edited").unwrap();
        from
    }

    #[test]
    fn a_replaced_original_is_kept_out_of_sight_and_reverts_by_its_link_wherever_the_version_went() {
        let r = root("plain");
        let trash = r.join("_deleted");
        let page = r.join("Album/012.jpg");
        fs::write(&page, b"original page").unwrap();
        fs::write(r.join("Album/012.xmp"), b"sidecar").unwrap();
        let mut ctx = Ctx::new(&r, None);
        let made = r.join("Album/Cleaned 012.png");
        let from = replace(&mut ctx, &[page.clone(), r.join("Album/012.xmp")], &made, b"clean page", &trash);
        // Kept hidden: no scan sees it, and the album holds the version alone.
        assert!(kept_dir(&r, &from).join("012.jpg").is_file());
        assert_eq!(ctx.scan(&r, std::slice::from_ref(&trash)).iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["Cleaned 012"]);
        assert_eq!(kept(&ctx).originals, 1);

        // Moved and renamed outside the app: the link still finds it.
        fs::create_dir_all(r.join("Elsewhere")).unwrap();
        let moved = r.join("Elsewhere/renamed.png");
        fs::rename(&made, &moved).unwrap();
        let i = info(&ctx, &moved).unwrap();
        assert_eq!(i.link.as_ref().map(|l| l.from_name.as_str()), Some("012.jpg"));
        assert_eq!(i.kept.as_deref(), Some(kept_dir(&r, &from).join("012.jpg").to_string_lossy().as_ref()));

        // Revert: the version to the trash, the original back with its own names, in the version's folder.
        let back = revert(&mut ctx, &moved, std::slice::from_ref(&moved), &trash).unwrap();
        assert_eq!(fs::read(r.join("Elsewhere/012.jpg")).unwrap(), b"original page");
        assert!(r.join("Elsewhere/012.xmp").is_file() && !moved.exists());
        assert!(!kept_dir(&r, &from).exists());
        assert_eq!(back.restored.len(), 2);
        // Undo moves each back, kept original first.
        assert_eq!(back.moves[0].0, kept_dir(&r, &from).join("012.jpg"));
        assert_eq!(back.moves.last().unwrap().1, trash.join("renamed.png"));
        // The original knows the version made from it.
        assert_eq!(info(&ctx, &r.join("Elsewhere/012.jpg")).unwrap().versions.len(), 1);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn a_copy_names_its_original_and_the_original_its_copies() {
        let r = root("copy");
        let page = r.join("Album/012.jpg");
        fs::write(&page, b"original page").unwrap();
        let ctx = Ctx::new(&r, None);
        let made = r.join("Album/Cleaned 012.png");
        fs::write(&made, b"clean page").unwrap();
        let from = ctx.fingerprint(&page).unwrap();
        note_made(&ctx, &made, &from, &page, "plugin-x", "cleaned").unwrap();
        let i = info(&ctx, &made).unwrap();
        assert_eq!(i.original.as_deref(), Some(page.to_string_lossy().as_ref()));
        assert!(i.kept.is_none());
        assert_eq!(info(&ctx, &page).unwrap().versions[0].path.as_deref(), Some(made.to_string_lossy().as_ref()));
        // Nothing to revert to: the original is the reader's own file, beside it.
        assert!(revert(&mut Ctx::new(&r, None), &made, std::slice::from_ref(&made), &r.join("_deleted")).is_err());
        // A picture no version has the size of is never read.
        fs::write(r.join("Album/other.jpg"), b"x").unwrap();
        assert!(info(&ctx, &r.join("Album/other.jpg")).unwrap().fp.is_none());
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn deleting_a_version_for_good_lets_its_kept_original_go_and_its_own_before_it() {
        let r = root("forget");
        let trash = r.join("_deleted");
        let page = r.join("Album/012.jpg");
        fs::write(&page, b"original page").unwrap();
        let mut ctx = Ctx::new(&r, None);
        let first = r.join("Album/Cleaned 012.png");
        let orig = replace(&mut ctx, std::slice::from_ref(&page), &first, b"clean page", &trash);
        // Edited again in place: the cleaned page is kept in turn.
        let second = r.join("Album/Cleaned 012 crop.png");
        let mid = replace(&mut ctx, std::slice::from_ref(&first), &second, b"cropped clean page", &trash);
        assert_eq!(kept(&ctx).originals, 2);
        let gone = ctx.fingerprint(&second).unwrap();
        forget(&mut ctx, vec![gone]).unwrap();
        assert!(!kept_dir(&r, &orig).exists() && !kept_dir(&r, &mid).exists());
        assert!(load(&ctx).unwrap().links.is_empty());
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn in_a_vault_the_original_is_kept_encrypted_and_never_listed() {
        let r = root("vault");
        let trash = r.join("_deleted");
        let mut v = Vault::create(&r, "passphrase-123").unwrap();
        let src = r.join("plain.jpg");
        fs::write(&src, b"secret original page").unwrap();
        v.add_file(&src, "Album/012.jpg").unwrap();
        fs::remove_file(&src).unwrap();
        let mut ctx = Ctx::new(&r, Some(&mut v));
        let page = r.join("Album/012.jpg");
        let from = ctx.fingerprint(&page).unwrap();
        let to = put_away_to(&ctx, &from, &trash);
        ctx.move_group(std::slice::from_ref(&page), &to).unwrap();
        assert!(ctx.vault_id(&kept_dir(&r, &from).join("012.jpg")).is_some(), "still encrypted, under its new name");
        assert!(ctx.list_files(&r, &[]).is_empty());
        assert!(ctx.subdirs(&r).iter().all(|d| !d.to_string_lossy().contains(KEPT_DIR)));
        assert_eq!(kept(&ctx).originals, 1);
        // One kept plain (replaced before the vault had it) is still among the files to encrypt.
        fs::create_dir_all(kept_dir(&r, "9-0123456789abcdef")).unwrap();
        fs::write(kept_dir(&r, "9-0123456789abcdef").join("013.jpg"), b"plain page").unwrap();
        assert!(crate::fsx::plaintext_files(&r).iter().any(|f| f.path == kept_dir(&r, "9-0123456789abcdef").join("013.jpg")));
        assert_eq!(kept(&ctx).originals, 2);
        assert_eq!(forget_kept(&mut ctx).unwrap(), 2);
        assert_eq!(kept(&ctx).bytes, 0);
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn an_unreadable_versions_file_is_never_written_over() {
        let r = root("broken");
        fs::write(r.join(".quire.versions.json"), b"{ not json").unwrap();
        let ctx = Ctx::new(&r, None);
        fs::write(r.join("Album/a.png"), b"a").unwrap();
        assert!(note_made(&ctx, &r.join("Album/a.png"), "1-00", &r.join("Album/b.jpg"), "edit", "edited").is_err());
        assert_eq!(fs::read(r.join(".quire.versions.json")).unwrap(), b"{ not json");
        let _ = fs::remove_dir_all(&r);
    }

    #[test]
    fn where_a_version_and_its_original_are_follows_them_when_they_move() {
        let root = std::env::temp_dir().join(format!("ms-versions-follow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let ctx = Ctx::new(&root, None);
        let link = |made: &str, from: &str| Link { from: "1a-0123456789abcdef".into(), from_name: "a.jpg".into(), made_at: made.into(), from_at: from.into(), by: "edit".into(), note: "edited".into(), at: 1 };
        let mut v = Versions::default();
        v.links.insert("v1".into(), link("Pics/a edited.jpg", "Pics/a.jpg"));
        v.links.insert("v2".into(), link("Other/b.png", "Other/b.jpg"));
        save(&ctx, &v).unwrap();
        // The folder moved, and one picture elsewhere renamed; a folder of a similar name is no match.
        assert!(follow(&ctx, &[("Pics".into(), "Albums/Pics".into()), ("Other/b.jpg".into(), "Other/b2.jpg".into()), ("Oth".into(), "X".into())]).unwrap());
        let back = load(&ctx).unwrap();
        assert_eq!((back.links["v1"].made_at.as_str(), back.links["v1"].from_at.as_str()), ("Albums/Pics/a edited.jpg", "Albums/Pics/a.jpg"));
        assert_eq!((back.links["v2"].made_at.as_str(), back.links["v2"].from_at.as_str()), ("Other/b.png", "Other/b2.jpg"));
        assert!(!follow(&ctx, &[("Nowhere".into(), "Else".into())]).unwrap(), "nothing moved: not written");
        let _ = std::fs::remove_dir_all(&root);
    }
}
