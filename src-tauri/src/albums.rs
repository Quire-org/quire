//! Albums: every immediate subfolder of an "album root" is one album, rated
//! and moved as a whole, and so is every PDF directly in one (its pages drawn
//! from it). Their contents never appear in the main grid.

use crate::fsx::Ctx;
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
    /// A PDF, not a folder: its pages are `<its path>#<n>`.
    pub pdf: bool,
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
        pdf: false,
    }
}

/// A PDF directly in an album folder: an album of its own. One that can't be read (pdfium missing,
/// a broken file) still shows, empty, so it isn't lost from sight.
pub fn album_from_pdf(ctx: &Ctx, root: &Path, pdf: &Path, stored_root: &str) -> Album {
    let (size, modified) = ctx.stat(pdf).unwrap_or((0, 0));
    let key = media::rel_key(root, pdf);
    let pages = crate::pdf::page_count(|| ctx.read_all(pdf), (pdf, size, modified)).unwrap_or(0);
    Album {
        cover: (pages > 0).then(|| pdf_page(ctx, root, pdf, 1, (size, modified))),
        key,
        path: pdf.to_string_lossy().into_owned(),
        name: pdf.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        album_root: stored_root.to_string(),
        count: pages as usize,
        bytes: size,
        images: pages as usize,
        videos: 0,
        modified,
        pdf: true,
    }
}

/// Page `n` (from 1) of a PDF album, as a picture of the album: `<path>#<n>`, keyed `<key>#<n>`.
pub fn pdf_page(ctx: &Ctx, root: &Path, pdf: &Path, n: u32, (size, modified): (u64, u64)) -> MediaItem {
    let key = media::rel_key(root, pdf);
    let at = format!("{}#{n}", pdf.to_string_lossy());
    MediaItem {
        key: format!("{key}#{n}"),
        primary: at.clone(),
        files: vec![at],
        kind: MediaKind::Image,
        name: format!("{:03}", n),
        dir: String::new(),
        size,
        modified,
        has_raw: false,
        has_video: false,
        target_id: None,
        album_key: Some(key),
        vault_id: ctx.vault_id(pdf),
    }
}

/// Every page of a PDF album.
pub fn pdf_pages(ctx: &Ctx, root: &Path, pdf: &Path) -> Result<Vec<MediaItem>, String> {
    let stat = ctx.stat(pdf).ok_or_else(|| format!("{} isn't there", pdf.display()))?;
    let n = crate::pdf::page_count(|| ctx.read_all(pdf), (pdf, stat.0, stat.1))?;
    Ok((1..=n).map(|i| pdf_page(ctx, root, pdf, i, stat)).collect())
}

/// The PDFs directly in a folder (on disk and in the vault).
pub fn pdfs_in(ctx: &Ctx, dir: &Path) -> Vec<PathBuf> {
    let below = ctx.subdirs(dir);
    let mut out: Vec<PathBuf> = ctx.list_files(dir, &below).into_iter().map(|f| f.path).filter(|p| p.parent() == Some(dir) && crate::pdf::is_pdf(p)).collect();
    out.sort();
    out.dedup();
    out
}

/// Every album under the album folders (each with the path it is stored as), its items in order.
pub fn scan_albums(ctx: &Ctx, root: &Path, album_roots: &[(String, PathBuf)]) -> Vec<Album> {
    let mut out = vec![];
    for (stored, dir) in album_roots {
        for sub in ctx.subdirs(dir) {
            let mut items = ctx.scan(&sub, &[]);
            items.sort_by(|a, b| a.dir.cmp(&b.dir).then_with(|| a.name.cmp(&b.name)));
            out.push(album_from_items(root, &sub, stored, items));
        }
        for pdf in pdfs_in(ctx, dir) {
            out.push(album_from_pdf(ctx, root, &pdf, stored));
        }
    }
    out
}

/// A folder that looks like an album but isn't under an album folder: numbered pages of one type.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumGuess {
    pub path: String,
    pub name: String,
    pub count: usize,
    pub ext: String,
    /// The first pages, for a look.
    pub first: Vec<MediaItem>,
}

/// Where the run of digits ending at byte `end` starts: just after the last other character,
/// stepping over that character whole (it may take several bytes, as Japanese does).
fn digits_start(stem: &str, end: usize) -> usize {
    stem[..end].char_indices().rev().find(|(_, c)| !c.is_ascii_digit()).map(|(i, c)| i + c.len_utf8()).unwrap_or(0)
}

/// The page number of a file name: the last run of digits in its stem ("page_012.jpg" → 12).
pub fn page_number(name: &str) -> Option<u64> {
    let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
    let end = stem.rfind(|c: char| c.is_ascii_digit())? + 1;
    let start = digits_start(stem, end);
    stem[start..end].parse().ok()
}

/// Whether these file names look like the pages of an album: media files numbered 1…N without a
/// gap (from 0, 1 or 2: a first page deleted), in one pattern ("1.jpg", "001.jpg", "page_01.png",
/// "ページ1.jpg"), of one type (jpg and jpeg are one), three or more. Files that aren't media don't
/// count; up to two other pictures (or one in five pages) are fine. Gives the type and the page count.
pub fn looks_like_pages(names: &[String]) -> Option<(String, usize)> {
    use std::collections::HashMap;
    let media: Vec<&String> = names.iter().filter(|n| media::classify(Path::new(n.as_str())).is_some()).collect();
    if media.len() < 3 {
        return None;
    }
    // The pattern around the number, and the type: (prefix, suffix, ext) → numbers.
    let mut groups: HashMap<(String, String, String), Vec<u64>> = HashMap::new();
    for n in &media {
        let Some((stem, ext)) = n.rsplit_once('.') else { continue };
        let Some(end) = stem.rfind(|c: char| c.is_ascii_digit()).map(|i| i + 1) else { continue };
        let start = digits_start(stem, end);
        let Ok(num) = stem[start..end].parse::<u64>() else { continue };
        let mut ext = ext.to_ascii_lowercase();
        if ext == "jpeg" {
            ext = "jpg".into();
        }
        groups.entry((stem[..start].trim().to_lowercase(), stem[end..].trim().to_lowercase(), ext)).or_default().push(num);
    }
    let ((_, _, ext), mut nums) = groups.into_iter().max_by_key(|(_, v)| v.len())?;
    let count = nums.len();
    // A couple of other pictures (a cover, a credits page) are fine; one in five at most beyond that.
    if count < 3 || media.len() - count > (count / 5).max(2) {
        return None;
    }
    nums.sort_unstable();
    nums.dedup();
    if nums.len() != count {
        return None; // "1.jpg" and "01.jpg": two numberings, not one album
    }
    let (first, last) = (nums[0], nums[count - 1]);
    let missing = (last - first + 1) as usize - count;
    if first > 2 || missing > 0 {
        return None;
    }
    Some((ext, count))
}

/// Folders that look like albums among these files (each folder judged by its own files only),
/// with their first three pages. Folders directly in `root` count; `root` itself and hidden folders don't.
pub fn guess_albums(root: &Path, files: Vec<media::FileRef>, vault_id: impl Fn(&Path) -> Option<String>) -> Vec<AlbumGuess> {
    use std::collections::BTreeMap;
    let mut by_dir: BTreeMap<PathBuf, Vec<media::FileRef>> = BTreeMap::new();
    for f in files {
        let Some(dir) = f.path.parent() else { continue };
        if dir == root || dir.strip_prefix(root).map(|r| r.components().any(|c| c.as_os_str().to_string_lossy().starts_with('.'))).unwrap_or(true) {
            continue;
        }
        by_dir.entry(dir.to_path_buf()).or_default().push(f);
    }
    let mut out = vec![];
    for (dir, files) in by_dir {
        let names: Vec<String> = files.iter().filter_map(|f| f.path.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
        let Some((ext, count)) = looks_like_pages(&names) else { continue };
        let mut items = media::build_items(root, &dir, files);
        for it in &mut items {
            it.vault_id = vault_id(Path::new(&it.primary));
        }
        items.sort_by_key(|i| page_number(&i.name).unwrap_or(u64::MAX));
        items.truncate(3);
        out.push(AlbumGuess { path: dir.to_string_lossy().into_owned(), name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), count, ext, first: items });
    }
    out
}

#[cfg(test)]
mod guess_tests {
    use super::*;
    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn numbered_pages() {
        assert_eq!(looks_like_pages(&names(&["1.jpg", "2.JPG", "3.jpg"])), Some(("jpg".into(), 3)));
        assert_eq!(looks_like_pages(&names(&["0.png", "1.png", "2.png", "3.png"])), Some(("png".into(), 4)));
        assert_eq!(looks_like_pages(&names(&["01.jpg", "02.jpeg", "03.jpg"])), Some(("jpg".into(), 3)), "jpg and jpeg are one type");
        assert_eq!(looks_like_pages(&names(&["page_01.png", "page_02.png", "page_03.png", "page_04.png"])), Some(("png".into(), 4)), "a prefix");
        assert_eq!(looks_like_pages(&names(&["Page 1.jpg", "Page 2.jpg", "Page 3.jpg"])), Some(("jpg".into(), 3)));
        assert_eq!(looks_like_pages(&names(&["2.jpg", "3.jpg", "4.jpg", "5.jpg"])), Some(("jpg".into(), 4)), "the first page deleted");
        assert_eq!(looks_like_pages(&names(&["ページ1.jpg", "ページ2.jpg", "ページ3.jpg"])), Some(("jpg".into(), 3)), "Japanese around the number");
        assert_eq!(looks_like_pages(&names(&["1.jpg", "2.jpg", "3.jpg", "表紙.jpg", "credits.png"])), Some(("jpg".into(), 3)), "two other pictures");
        assert_eq!(looks_like_pages(&names(&["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg", "info.txt", "ComicInfo.xml"])), Some(("jpg".into(), 5)), "other files don't count");
        let mut many: Vec<String> = (1..=20).map(|i| format!("{i}.jpg")).collect();
        many.push("cover.jpg".into());
        assert_eq!(looks_like_pages(&many), Some(("jpg".into(), 20)), "a stray cover");
    }
    #[test]
    fn not_pages() {
        assert!(looks_like_pages(&names(&["1.jpg", "2.jpg"])).is_none(), "too few");
        assert!(looks_like_pages(&names(&["1.jpg", "2.png", "3.jpg", "4.png"])).is_none(), "mixed types");
        assert!(looks_like_pages(&names(&["1.jpg", "4.jpg", "7.jpg"])).is_none(), "big gaps");
        assert!(looks_like_pages(&names(&["1.jpg", "2.jpg", "4.jpg", "5.jpg"])).is_none(), "a page missing");
        assert!(looks_like_pages(&names(&["1.jpg", "2.jpg", "3.jpg", "a.jpg", "b.jpg", "c.jpg"])).is_none(), "three other pictures to three pages");
        assert!(looks_like_pages(&names(&["5.jpg", "6.jpg", "7.jpg"])).is_none(), "doesn't start near 1");
        assert!(looks_like_pages(&names(&["IMG_4031.jpg", "IMG_4032.jpg", "IMG_4033.jpg"])).is_none(), "camera numbering");
        assert!(looks_like_pages(&names(&["1.jpg", "01.jpg", "2.jpg", "3.jpg"])).is_none(), "two numberings");
    }
    #[test]
    fn page_numbers() {
        assert_eq!(page_number("page_012.jpg"), Some(12));
        assert_eq!(page_number("Chapter 3 - 07.png"), Some(7));
        assert_eq!(page_number("cover.jpg"), None);
        assert_eq!(page_number("第3話_ページ12.jpg"), Some(12));
        assert_eq!(page_number("表紙.jpg"), None);
    }
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

        let mut ctx = Ctx::new(&root, None);
        let albums = scan_albums(&ctx, &root, &[("Albums".into(), ar.clone())]);
        assert_eq!(albums.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), vec!["Party", "Trip"]);
        let trip = &albums[1];
        assert_eq!(trip.count, 3);
        assert_eq!(trip.videos, 1);
        assert_eq!(trip.bytes, 6);
        assert_eq!(trip.key, "Albums/Trip");
        assert_eq!(trip.cover.as_ref().unwrap().name, "b");

        let moved = ctx.move_dir(&ar.join("Trip"), &root.join("Keep")).unwrap();
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
pub fn rename_plan(ctx: &Ctx, root: &Path, album_roots: &[PathBuf]) -> Vec<Rename> {
    let mut plan = vec![];
    for dir in album_roots {
        let subs = ctx.subdirs(dir);
        let mut taken: Vec<String> = subs.iter().filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
        for sub in subs {
            let name = sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let Some(mut new_name) = decode_name(&name) else { continue };
            let base = new_name.clone();
            let mut n = 1;
            while taken.iter().any(|t| t != &name && t.eq_ignore_ascii_case(&new_name)) {
                new_name = format!("{base} ({n})");
                n += 1;
            }
            taken.push(new_name.clone());
            let to = dir.join(&new_name);
            plan.push(Rename { from: sub.to_string_lossy().into_owned(), to: to.to_string_lossy().into_owned(), from_key: media::rel_key(root, &sub), to_key: media::rel_key(root, &to) });
        }
    }
    plan
}

/// Perform renames from a plan. Entries whose destination now exists, or that
/// can't be renamed, are skipped; the performed ones are returned.
pub fn rename_apply(ctx: &mut Ctx, plan: &[Rename]) -> Vec<Rename> {
    let mut done = vec![];
    for r in plan {
        let (from, to) = (Path::new(&r.from), Path::new(&r.to));
        if to.exists() {
            continue;
        }
        if ctx.rename_dir(from, to).is_ok() {
            done.push(r.clone());
        }
    }
    done
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
        assert!(decode_name("%20%20").is_none()); // decodes to nothing
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

        let mut ctx = Ctx::new(&root, None);
        let plan = rename_plan(&ctx, &root, std::slice::from_ref(&ar));
        let names: Vec<(String, String)> = plan
            .iter()
            .map(|r| (Path::new(&r.from).file_name().unwrap().to_string_lossy().into_owned(), Path::new(&r.to).file_name().unwrap().to_string_lossy().into_owned()))
            .collect();
        assert_eq!(names, vec![("Caf%C3%A9".to_string(), "Café".to_string()), ("My%20Trip".to_string(), "My Trip (1)".to_string())]);
        assert_eq!(plan[0].to_key, "Albums/Café");

        let done = rename_apply(&mut ctx, &plan);
        assert_eq!(done.len(), 2);
        assert!(ar.join("Café").is_dir());
        assert!(ar.join("My Trip (1)").is_dir());
        assert!(!ar.join("My%20Trip").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
