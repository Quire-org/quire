//! Storage layer that treats plain files on disk and encrypted vault entries
//! the same way. Every path handed around is *logical*: `<root>/<rel>`. For a
//! vault entry no such file exists on disk; the bytes live in a blob.

use crate::media::{self, FileRef, MediaItem};
use crate::ops;
use crate::vault::Vault;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Held while a move picks a free name and takes it. Commands on plain folders run in parallel,
/// and a rename replaces what is there: two moves into one folder must not choose the same name.
static MOVES: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn moves_lock() -> std::sync::MutexGuard<'static, ()> {
    MOVES.lock().unwrap_or_else(|p| p.into_inner())
}

/// A log's records: each a little-endian u32 length and that many bytes. A record cut short (the
/// write was interrupted) ends it.
pub fn records(bytes: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(len) = bytes.get(at..at + 4) {
        let len = u32::from_le_bytes([len[0], len[1], len[2], len[3]]) as usize;
        let Some(record) = bytes.get(at + 4..at + 4 + len) else { break };
        out.push(record);
        at += 4 + len;
    }
    out
}

/// Write through a temp file and a rename. The temp name is unique per write, so two saves of the same
/// file running at once (commands run in parallel) can't trip over each other's temp file.
/// What a write refused beside a locked vault says (see `Ctx::not_beside_a_locked_vault`).
pub const LOCKED: &str = "The vault is locked: nothing of this library is written in the clear beside it. Unlock it to save.";

pub fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    static N: AtomicU64 = AtomicU64::new(0);
    let _turn = p.parent().and_then(one_at_a_time);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = p.with_file_name(format!("{name}.{}.{}.tmp", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    // Written and brought to the disk before it takes the file's place: a drive pulled or power
    // gone right after leaves the old file whole, never an empty new one (exFAT and FAT drives can
    // rename before the data has landed). Through the one handle that wrote it: Windows brings a
    // file to the disk only through a handle that may write it.
    let written = (|| {
        use std::io::Write;
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", tmp.display()));
    }
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {}: {e}", p.display())
    })?;
    sync_dir(p);
    Ok(())
}

/// Write a file that can be made again (a thumbnail, say) through a temp file and a rename, so it is
/// never seen half written, but without bringing it to the disk: a cache lost with the power is made
/// again, and on a FAT drive the two syncs were most of a write's time.
pub fn write_cache(p: &Path, bytes: &[u8]) -> Result<(), String> {
    static N: AtomicU64 = AtomicU64::new(0);
    let _turn = p.parent().and_then(one_at_a_time);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = p.with_file_name(format!("{name}.{}.{}.tmp", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    if let Err(e) = fs::write(&tmp, bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", tmp.display()));
    }
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {}: {e}", p.display())
    })
}

/// The kind of filesystem a path is on, as the system names it: "apfs", "msdos" (FAT), "exfat"…;
/// None where it can't tell.
pub fn fs_kind(p: &Path) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        Some(unsafe { std::ffi::CStr::from_ptr(st.f_fstypename.as_ptr()) }.to_string_lossy().into_owned())
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        Some(match st.f_type as i64 {
            0x4d44 => "msdos",
            0x2011_BAB0 => "exfat",
            _ => "other",
        }.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = p;
        None
    }
}

/// Whether a path is on a FAT or exFAT drive (cached by the drive's place: its first folders).
pub fn is_fat(p: &Path) -> bool {
    static SEEN: std::sync::Mutex<Option<std::collections::HashMap<PathBuf, bool>>> = std::sync::Mutex::new(None);
    let key: PathBuf = p.components().take(3).collect();
    if let Some(&fat) = SEEN.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(&key)) {
        return fat;
    }
    let Some(kind) = fs_kind(p) else { return false };
    let fat = kind == "msdos" || kind == "exfat";
    SEEN.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default).insert(key, fat);
    fat
}

/// Changes to a FAT or exFAT drive's folders, one at a time: held while a file is made, renamed or
/// brought to the disk there. Their drivers look a name up entry by entry, and macOS's FAT driver
/// was seen to deadlock for good (until a restart) under many writes into one folder at once: a
/// burst of thumbnails into a vault as its library opened. Elsewhere no one waits.
pub fn one_at_a_time(dir: &Path) -> Option<std::sync::MutexGuard<'static, ()>> {
    static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    is_fat(dir).then(|| TURN.lock().unwrap_or_else(|e| e.into_inner()))
}

/// The folder a file was just renamed into, brought to the disk too (unix; elsewhere a no-op).
pub fn sync_dir(p: &Path) {
    #[cfg(unix)]
    if let Some(dir) = p.parent()
        && let Ok(d) = fs::File::open(dir)
    {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = p;
}

pub struct Ctx<'a> {
    pub root: PathBuf,
    pub vault: Option<VaultAccess<'a>>,
}

/// The open vault, for reading only (commands that read share it) or for changing it.
pub enum VaultAccess<'a> {
    Read(&'a Vault),
    Write(&'a mut Vault),
}

impl std::ops::Deref for VaultAccess<'_> {
    type Target = Vault;
    fn deref(&self) -> &Vault {
        match self {
            VaultAccess::Read(v) => v,
            VaultAccess::Write(v) => v,
        }
    }
}

impl std::ops::DerefMut for VaultAccess<'_> {
    fn deref_mut(&mut self) -> &mut Vault {
        match self {
            VaultAccess::Write(v) => v,
            // Only read-only commands get Read; one that changes the vault is a bug to find.
            VaultAccess::Read(_) => panic!("the vault was opened for reading only"),
        }
    }
}

impl<'a> Ctx<'a> {
    pub fn new(root: &Path, vault: Option<&'a mut Vault>) -> Ctx<'a> {
        let vault = vault.filter(|v| v.root == root).map(VaultAccess::Write);
        Ctx { root: root.to_path_buf(), vault }
    }

    /// A context that only reads (the vault shared with other readers).
    pub fn reading(root: &Path, vault: Option<&'a Vault>) -> Ctx<'a> {
        let vault = vault.filter(|v| v.root == root).map(VaultAccess::Read);
        Ctx { root: root.to_path_buf(), vault }
    }

    fn rel(&self, p: &Path) -> Option<String> {
        p.strip_prefix(&self.root).ok().map(|r| media::rel_key(Path::new(""), r))
    }

    /// Vault entry id for a logical path, when it is encrypted.
    pub fn vault_id(&self, p: &Path) -> Option<String> {
        let v = self.vault.as_deref()?;
        v.entry_by_rel(&self.rel(p)?).map(|e| e.id.clone())
    }

    fn exists_any(&self, p: &Path) -> bool {
        p.exists() || self.vault_id(p).is_some()
    }

    /// Every file under `dir` (disk and vault), minus excluded directories.
    pub fn list_files(&self, dir: &Path, exclude: &[PathBuf]) -> Vec<FileRef> {
        // Files changed in place under the opened folder are noticed from here on.
        crate::listing::watch(&self.root);
        let mut out = media::walk_files(dir, exclude);
        if let Some(v) = self.vault.as_deref() {
            let dir_rel = self.rel(dir).unwrap_or_default();
            let prefix = if dir_rel.is_empty() { String::new() } else { format!("{dir_rel}/") };
            let ex_rels: Vec<String> = exclude.iter().filter_map(|e| self.rel(e)).map(|r| format!("{r}/")).collect();
            for e in v.entries_under(&prefix) {
                // As on disk, nothing under a hidden folder (the originals kept for Revert, say).
                if ex_rels.iter().any(|x| e.rel.starts_with(x)) || hidden(&e.rel) {
                    continue;
                }
                out.push(FileRef { path: self.root.join(&e.rel), size: e.size, modified: e.mtime });
            }
        }
        out
    }

    /// Items under `dir`, with vault ids filled in.
    pub fn scan(&self, dir: &Path, exclude: &[PathBuf]) -> Vec<MediaItem> {
        let mut items = media::build_items(&self.root, dir, self.list_files(dir, exclude));
        if self.vault.is_some() {
            for it in &mut items {
                it.vault_id = self.vault_id(Path::new(&it.primary));
            }
        }
        items
    }

    /// Immediate subfolders of `dir` (disk and vault).
    pub fn subdirs(&self, dir: &Path) -> Vec<PathBuf> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| !n.starts_with('.'))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(v) = self.vault.as_deref() {
            let dir_rel = self.rel(dir).unwrap_or_default();
            let prefix = if dir_rel.is_empty() { String::new() } else { format!("{dir_rel}/") };
            for e in v.entries_under(&prefix) {
                if let Some(rest) = e.rel.strip_prefix(&prefix)
                    && let Some((first, _)) = rest.split_once('/')
                        && !first.starts_with('.') && !names.iter().any(|n| n == first) {
                            names.push(first.to_string());
                        }
            }
        }
        names.sort();
        names.into_iter().map(|n| dir.join(n)).collect()
    }

    /// Move a group of files into `dest_dir`, keeping the group together and
    /// giving every member the same ` (n)` suffix on a name collision.
    pub fn move_group(&mut self, files: &[PathBuf], dest_dir: &Path) -> Result<Vec<PathBuf>, String> {
        let _one_at_a_time = moves_lock();
        let mut suffix = 0u32;
        let dests: Vec<PathBuf> = loop {
            let cand: Vec<PathBuf> = files.iter().map(|f| dest_dir.join(ops::with_suffix(f, suffix))).collect();
            if cand.iter().all(|c| !self.exists_any(c)) {
                break cand;
            }
            suffix += 1;
            if suffix > 10_000 {
                return Err("too many name collisions".into());
            }
        };
        let mut done: Vec<(PathBuf, PathBuf)> = vec![];
        for (src, dst) in files.iter().zip(dests.iter()) {
            if let Err(e) = self.move_one(src, dst) {
                for (s, d) in done.iter().rev() {
                    let _ = self.move_one(d, s);
                }
                return Err(e);
            }
            done.push((src.clone(), dst.clone()));
        }
        Ok(dests)
    }

    pub fn move_one(&mut self, src: &Path, dst: &Path) -> Result<(), String> {
        if src == dst {
            return Ok(());
        }
        if let (Some(from), Some(to)) = (self.rel(src), self.rel(dst))
            && let Some(v) = self.vault.as_deref_mut()
                && v.entry_by_rel(&from).is_some() {
                    return v.rename(&from, &to);
                }
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p).map_err(|e| format!("create {}: {e}", p.display()))?;
        }
        ops::move_file(src, dst).map_err(|e| format!("move {} -> {}: {e}", src.display(), dst.display()))
    }

    /// Delete files for good (disk or vault).
    pub fn remove(&mut self, p: &Path) -> Result<(), String> {
        if let Some(rel) = self.rel(p)
            && let Some(v) = self.vault.as_deref_mut()
                && v.entry_by_rel(&rel).is_some() {
                    return v.remove(&rel);
                }
        fs::remove_file(p).map_err(|e| format!("remove {}: {e}", p.display()))
    }

    /// Move a whole folder (disk part and vault part).
    pub fn move_dir(&mut self, dir: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
        let _one_at_a_time = moves_lock();
        let name = dir.file_name().ok_or("folder has no name")?.to_string_lossy().into_owned();
        let mut target = dest_dir.join(&name);
        let mut n = 1;
        while self.exists_any(&target) || self.subdirs(dest_dir).iter().any(|d| d == &target) {
            target = dest_dir.join(format!("{name} ({n})"));
            n += 1;
        }
        if dir.is_dir() {
            fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
            crate::albums::move_dir_to(dir, &target)?;
        }
        if let (Some(from), Some(to)) = (self.rel(dir), self.rel(&target))
            && let Some(v) = self.vault.as_deref_mut() {
                v.rename_prefix(&from, &to)?;
            }
        Ok(target)
    }

    /// Rename a folder in place (disk part and vault part).
    pub fn rename_dir(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        let _one_at_a_time = moves_lock();
        if from.is_dir() {
            if to.exists() {
                return Err(format!("{} already exists", to.display()));
            }
            fs::rename(from, to).map_err(|e| format!("rename {}: {e}", from.display()))?;
        }
        if let (Some(f), Some(t)) = (self.rel(from), self.rel(to))
            && let Some(v) = self.vault.as_deref_mut() {
                v.rename_prefix(&f, &t)?;
            }
        Ok(())
    }

    /// A file's size and modified time (ms), on disk or in the vault.
    pub fn stat(&self, p: &Path) -> Option<(u64, u64)> {
        if let Some(e) = self.vault.as_deref().and_then(|v| v.entry_by_rel(&self.rel(p)?)) {
            return Some((e.size, e.mtime));
        }
        let m = fs::metadata(p).ok()?;
        let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        Some((m.len(), modified))
    }

    /// Whole file contents (decrypted when needed).
    pub fn read_all(&self, p: &Path) -> Result<Vec<u8>, String> {
        if let Some(id) = self.vault_id(p) {
            return self.vault.as_deref().unwrap().read_all(&id);
        }
        fs::read(p).map_err(|e| format!("read {}: {e}", p.display()))
    }

    pub fn fingerprint(&self, p: &Path) -> Result<String, String> {
        if let Some(id) = self.vault_id(p) {
            let v = self.vault.as_deref().unwrap();
            let size = v.entry_by_id(&id).map(|e| e.size).unwrap_or(0);
            return crate::dupes::fingerprint_with(size, |off, buf| {
                let bytes = v.read_range(&id, off, off + buf.len() as u64)?;
                buf[..bytes.len()].copy_from_slice(&bytes);
                Ok(bytes.len())
            });
        }
        crate::dupes::file_fingerprint(p)
    }

    /// A library with a vault that isn't open here: nothing of it is written in the clear beside the
    /// vault (a save still waiting as it was locked, a job still running, the tag index in memory).
    pub fn not_beside_a_locked_vault(&self) -> Result<(), String> {
        if crate::vault::exists(&self.root) {
            return Err(LOCKED.into());
        }
        Ok(())
    }

    /// Small JSON documents (library, history, cache): encrypted inside the
    /// vault when one is open, plain dotfiles otherwise.
    pub fn load_meta(&self, name: &str) -> Result<Option<String>, String> {
        if let Some(v) = self.vault.as_deref() {
            return Ok(v.read_meta(name)?.map(|b| String::from_utf8_lossy(&b).into_owned()));
        }
        let p = self.root.join(format!(".quire.{name}.json"));
        if !p.exists() {
            return Ok(None);
        }
        fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
    }

    /// A metadata document that won't read, set aside as `<name>.broken` (the latest such; an older
    /// one goes), so a fresh one can start and the reader keeps what was there.
    pub fn set_aside_meta(&mut self, name: &str) {
        if let Some(v) = self.vault.as_deref_mut() {
            v.set_aside_meta(name);
            return;
        }
        let p = self.root.join(format!(".quire.{name}.json"));
        let _ = fs::rename(&p, self.root.join(format!(".quire.{name}.broken")));
    }

    pub fn save_meta(&self, name: &str, text: &str) -> Result<(), String> {
        if let Some(v) = self.vault.as_deref() {
            return v.write_meta(name, text.as_bytes());
        }
        self.not_beside_a_locked_vault()?;
        write_atomic(&self.root.join(format!(".quire.{name}.json")), text.as_bytes())
    }

    /// Larger binary documents (the tag index's vectors): like `save_meta`, as `.quire.{name}.bin`.
    pub fn load_meta_bytes(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        if let Some(v) = self.vault.as_deref() {
            return v.read_meta(name);
        }
        match fs::read(self.root.join(format!(".quire.{name}.bin"))) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save_meta_bytes(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if let Some(v) = self.vault.as_deref() {
            return v.write_meta(name, bytes);
        }
        self.not_beside_a_locked_vault()?;
        write_atomic(&self.root.join(format!(".quire.{name}.bin")), bytes)
    }

    /// A record added to the end of a metadata log (`.quire.{name}.log`; in a vault, each record
    /// encrypted on its own): cheap to write after every change, read back whole. A record cut short
    /// by a crash is left out.
    pub fn append_meta_record(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        if let Some(v) = self.vault.as_deref() {
            return v.append_meta_record(name, bytes);
        }
        self.not_beside_a_locked_vault()?;
        let mut f = fs::OpenOptions::new().create(true).append(true).open(self.root.join(format!(".quire.{name}.log"))).map_err(|e| e.to_string())?;
        let mut record = (bytes.len() as u32).to_le_bytes().to_vec();
        record.extend_from_slice(bytes);
        f.write_all(&record).map_err(|e| e.to_string())
    }

    pub fn load_meta_records(&self, name: &str) -> Result<Vec<Vec<u8>>, String> {
        if let Some(v) = self.vault.as_deref() {
            return v.read_meta_records(name);
        }
        match fs::read(self.root.join(format!(".quire.{name}.log"))) {
            Ok(b) => Ok(records(&b).into_iter().map(<[u8]>::to_vec).collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// A metadata document gone, JSON, binary or log.
    pub fn remove_meta(&self, name: &str) -> Result<(), String> {
        if let Some(v) = self.vault.as_deref() {
            return v.remove_meta(name);
        }
        for p in [self.root.join(format!(".quire.{name}.json")), self.root.join(format!(".quire.{name}.bin")), self.root.join(format!(".quire.{name}.log"))] {
            match fs::remove_file(&p) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
                _ => {}
            }
        }
        Ok(())
    }

    /// Scrapbook's pictures (rendered covers, stickers): in `.quire.scrapbook/` next to the
    /// library (hidden, so never taken for media), or encrypted in an open vault.
    fn blobs_dir(&self) -> PathBuf {
        self.root.join(".quire.scrapbook")
    }

    pub fn load_blob(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        if let Some(v) = self.vault.as_deref() {
            return v.read_blob(name);
        }
        match fs::read(self.blobs_dir().join(name)) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save_blob(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        if let Some(v) = self.vault.as_deref() {
            return v.write_blob(name, bytes);
        }
        self.not_beside_a_locked_vault()?;
        fs::create_dir_all(self.blobs_dir()).map_err(|e| e.to_string())?;
        write_atomic(&self.blobs_dir().join(name), bytes)
    }

    pub fn remove_blob(&self, name: &str) -> Result<(), String> {
        if let Some(v) = self.vault.as_deref() {
            return v.remove_blob(name);
        }
        match fs::remove_file(self.blobs_dir().join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// A vault entry's path that is under a hidden folder, or is a hidden file.
fn hidden(rel: &str) -> bool {
    rel.split('/').any(|s| s.starts_with('.'))
}

/// Plain files outside the vault that could still be encrypted: the media, and the originals kept
/// for Revert (hidden, so a walk leaves them out).
pub fn plaintext_files(root: &Path) -> Vec<FileRef> {
    let mut out = media::walk_files(root, &[]);
    out.extend(media::walk_files(&root.join(crate::versions::KEPT_DIR), &[]));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_metadata_kept_hidden_or_encrypted_and_removed() {
        let root = std::env::temp_dir().join(format!("ms-metabin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let plain = Ctx::new(&root, None);
        plain.save_meta_bytes("tagvectors", &[0, 159, 255]).unwrap();
        plain.save_meta("tagindex", "{}").unwrap();
        assert_eq!(plain.load_meta_bytes("tagvectors").unwrap().as_deref(), Some(&[0u8, 159, 255][..]));
        assert!(root.join(".quire.tagvectors.bin").is_file());
        plain.remove_meta("tagvectors").unwrap();
        plain.remove_meta("tagindex").unwrap();
        plain.remove_meta("tagindex").unwrap(); // gone already: fine
        assert_eq!(plain.load_meta_bytes("tagvectors").unwrap(), None);
        assert_eq!(plain.load_meta("tagindex").unwrap(), None);
        let mut v = Vault::create(&root, "passphrase-123").unwrap();
        let ctx = Ctx::new(&root, Some(&mut v));
        ctx.save_meta_bytes("tagvectors", b"MSV3 vectors").unwrap();
        assert_eq!(ctx.load_meta_bytes("tagvectors").unwrap().as_deref(), Some(&b"MSV3 vectors"[..]));
        let on_disk: Vec<u8> = walk(&root).iter().flat_map(|p| fs::read(p).unwrap_or_default()).collect();
        assert!(!on_disk.windows(4).any(|w| w == b"MSV3"));
        ctx.remove_meta("tagvectors").unwrap();
        assert_eq!(ctx.load_meta_bytes("tagvectors").unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn logs_take_records_and_leave_out_one_cut_short() {
        let root = std::env::temp_dir().join(format!("ms-metalog-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let plain = Ctx::new(&root, None);
        plain.append_meta_record("tagjournal.3", b"one").unwrap();
        plain.append_meta_record("tagjournal.3", b"two").unwrap();
        // A crash in the middle of a third.
        let mut f = fs::OpenOptions::new().append(true).open(root.join(".quire.tagjournal.3.log")).unwrap();
        std::io::Write::write_all(&mut f, &[9, 0, 0, 0, b'x']).unwrap();
        assert_eq!(plain.load_meta_records("tagjournal.3").unwrap(), vec![b"one".to_vec(), b"two".to_vec()]);
        plain.remove_meta("tagjournal.3").unwrap();
        assert!(plain.load_meta_records("tagjournal.3").unwrap().is_empty());
        let mut v = Vault::create(&root, "passphrase-123").unwrap();
        let ctx = Ctx::new(&root, Some(&mut v));
        ctx.append_meta_record("tagjournal.3", b"secret one").unwrap();
        ctx.append_meta_record("tagjournal.3", b"secret two").unwrap();
        assert_eq!(ctx.load_meta_records("tagjournal.3").unwrap(), vec![b"secret one".to_vec(), b"secret two".to_vec()]);
        let on_disk: Vec<u8> = walk(&root).iter().flat_map(|p| fs::read(p).unwrap_or_default()).collect();
        assert!(!on_disk.windows(6).any(|w| w == b"secret"));
        ctx.remove_meta("tagjournal.3").unwrap();
        assert!(ctx.load_meta_records("tagjournal.3").unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        fs::read_dir(dir).into_iter().flatten().flatten().flat_map(|e| if e.path().is_dir() { walk(&e.path()) } else { vec![e.path()] }).collect()
    }

    #[test]
    fn scrapbook_pictures_kept_hidden_or_encrypted() {
        let root = std::env::temp_dir().join(format!("ms-blobs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // Plain: in a hidden folder next to the library, so a scan never takes a cover for a photo.
        let plain = Ctx::new(&root, None);
        plain.save_blob("cover-a1.jpg", b"jpeg bytes").unwrap();
        assert_eq!(plain.load_blob("cover-a1.jpg").unwrap().as_deref(), Some(&b"jpeg bytes"[..]));
        assert!(root.join(".quire.scrapbook/cover-a1.jpg").is_file());
        assert!(plain.scan(&root, &[]).is_empty());
        plain.remove_blob("cover-a1.jpg").unwrap();
        plain.remove_blob("cover-a1.jpg").unwrap(); // gone already: fine
        assert_eq!(plain.load_blob("cover-a1.jpg").unwrap(), None);
        // In a vault: encrypted, nothing readable on disk.
        let mut v = Vault::create(&root, "passphrase-123").unwrap();
        let sealed = Ctx::new(&root, Some(&mut v));
        sealed.save_blob("sticker-b2.png", b"png bytes of a sticker").unwrap();
        assert_eq!(sealed.load_blob("sticker-b2.png").unwrap().as_deref(), Some(&b"png bytes of a sticker"[..]));
        let on_disk: Vec<u8> = walkdir::WalkDir::new(&root).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()).flat_map(|e| fs::read(e.path()).unwrap()).collect();
        assert!(!on_disk.windows(b"png bytes of a sticker".len()).any(|w| w == b"png bytes of a sticker"));
        sealed.remove_blob("sticker-b2.png").unwrap();
        assert_eq!(sealed.load_blob("sticker-b2.png").unwrap(), None);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mixed_plain_and_vault_scan_move_trash() {
        let root = std::env::temp_dir().join(format!("ms-fsx-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("DCIM")).unwrap();
        fs::write(root.join("DCIM/a.jpg"), b"aaaa").unwrap();
        fs::write(root.join("DCIM/a.cr2"), b"rawraw").unwrap();
        fs::write(root.join("DCIM/b.jpg"), b"bb").unwrap();

        let mut v = Vault::create(&root, "passphrase-123").unwrap();
        // Encrypt a.jpg + a.cr2, leave b.jpg plain.
        v.add_file(&root.join("DCIM/a.jpg"), "DCIM/a.jpg").unwrap();
        v.add_file(&root.join("DCIM/a.cr2"), "DCIM/a.cr2").unwrap();
        fs::remove_file(root.join("DCIM/a.jpg")).unwrap();
        fs::remove_file(root.join("DCIM/a.cr2")).unwrap();

        let mut ctx = Ctx::new(&root, Some(&mut v));
        let items = ctx.scan(&root, &[]);
        let mut names: Vec<_> = items.iter().map(|i| i.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["a", "b"]);
        let a = items.iter().find(|i| i.name == "a").unwrap();
        assert!(a.vault_id.is_some() && a.has_raw && a.files.len() == 2);
        let b = items.iter().find(|i| i.name == "b").unwrap();
        assert!(b.vault_id.is_none());

        // Reading goes through the vault for a, through disk for b.
        assert_eq!(ctx.read_all(Path::new(&a.primary)).unwrap(), b"aaaa");
        assert_eq!(ctx.read_all(Path::new(&b.primary)).unwrap(), b"bb");
        assert_eq!(ctx.fingerprint(Path::new(&a.primary)).unwrap(), crate::dupes::fingerprint_with(4, |_, buf| { buf[..4].copy_from_slice(b"aaaa"); Ok(4) }).unwrap());

        // Move the encrypted pair into Keep: index renames, nothing appears on disk.
        let moved = ctx.move_group(&a.files.iter().map(PathBuf::from).collect::<Vec<_>>(), &root.join("Keep")).unwrap();
        assert_eq!(moved[1], root.join("Keep/a.jpg"));
        assert!(!root.join("Keep/a.jpg").exists());
        assert!(ctx.vault_id(&root.join("Keep/a.jpg")).is_some());
        assert!(ctx.vault_id(&root.join("DCIM/a.jpg")).is_none());
        assert_eq!(ctx.subdirs(&root), vec![root.join("DCIM"), root.join("Keep")]);

        // Plain file moves on disk; a collision with a vault name gets a suffix.
        fs::write(root.join("DCIM/a.jpg"), b"new a").unwrap();
        let moved2 = ctx.move_group(&[root.join("DCIM/a.jpg")], &root.join("Keep")).unwrap();
        assert_eq!(moved2[0], root.join("Keep/a (1).jpg"));
        assert!(root.join("Keep/a (1).jpg").exists());

        // Trash = move into _deleted, then remove for good.
        let t = ctx.move_group(&[root.join("Keep/a.jpg")], &root.join("_deleted")).unwrap();
        assert!(ctx.vault_id(&t[0]).is_some());
        ctx.remove(&t[0]).unwrap();
        assert!(ctx.vault_id(&t[0]).is_none());

        // Metadata is encrypted while the vault is open.
        ctx.save_meta("history", "{\"viewed\":{}}").unwrap();
        assert!(root.join(".vault/meta/history.enc").exists());
        assert!(!root.join(".quire.history.json").exists());
        assert_eq!(ctx.load_meta("history").unwrap().unwrap(), "{\"viewed\":{}}");
        let _ = fs::remove_dir_all(&root);
    }
}
