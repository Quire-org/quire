//! Storage layer that treats plain files on disk and encrypted vault entries
//! the same way. Every path handed around is *logical*: `<root>/<rel>`. For a
//! vault entry no such file exists on disk; the bytes live in a blob.

use crate::media::{self, FileRef, MediaItem};
use crate::ops;
use crate::vault::Vault;
use std::fs;
use std::path::{Path, PathBuf};

pub struct Ctx<'a> {
    pub root: PathBuf,
    pub vault: Option<&'a mut Vault>,
}

impl<'a> Ctx<'a> {
    pub fn new(root: &Path, vault: Option<&'a mut Vault>) -> Ctx<'a> {
        let vault = vault.filter(|v| v.root == root);
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
        let mut out = media::walk_files(dir, exclude);
        if let Some(v) = self.vault.as_deref() {
            let dir_rel = self.rel(dir).unwrap_or_default();
            let prefix = if dir_rel.is_empty() { String::new() } else { format!("{dir_rel}/") };
            let ex_rels: Vec<String> = exclude.iter().filter_map(|e| self.rel(e)).map(|r| format!("{r}/")).collect();
            for e in v.entries() {
                if !e.rel.starts_with(&prefix) {
                    continue;
                }
                if ex_rels.iter().any(|x| e.rel.starts_with(x)) {
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
            for e in v.entries() {
                if let Some(rest) = e.rel.strip_prefix(&prefix) {
                    if let Some((first, _)) = rest.split_once('/') {
                        if !names.iter().any(|n| n == first) {
                            names.push(first.to_string());
                        }
                    }
                }
            }
        }
        names.sort();
        names.into_iter().map(|n| dir.join(n)).collect()
    }

    /// Move a group of files into `dest_dir`, keeping the group together and
    /// giving every member the same ` (n)` suffix on a name collision.
    pub fn move_group(&mut self, files: &[PathBuf], dest_dir: &Path) -> Result<Vec<PathBuf>, String> {
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
        if let (Some(from), Some(to)) = (self.rel(src), self.rel(dst)) {
            if let Some(v) = self.vault.as_deref_mut() {
                if v.entry_by_rel(&from).is_some() {
                    return v.rename(&from, &to);
                }
            }
        }
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p).map_err(|e| format!("create {}: {e}", p.display()))?;
        }
        ops::move_file(src, dst).map_err(|e| format!("move {} -> {}: {e}", src.display(), dst.display()))
    }

    /// Delete files for good (disk or vault).
    pub fn remove(&mut self, p: &Path) -> Result<(), String> {
        if let Some(rel) = self.rel(p) {
            if let Some(v) = self.vault.as_deref_mut() {
                if v.entry_by_rel(&rel).is_some() {
                    return v.remove(&rel);
                }
            }
        }
        fs::remove_file(p).map_err(|e| format!("remove {}: {e}", p.display()))
    }

    /// Move a whole folder (disk part and vault part).
    pub fn move_dir(&mut self, dir: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
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
        if let (Some(from), Some(to)) = (self.rel(dir), self.rel(&target)) {
            if let Some(v) = self.vault.as_deref_mut() {
                v.rename_prefix(&from, &to)?;
            }
        }
        Ok(target)
    }

    /// Rename a folder in place (disk part and vault part).
    pub fn rename_dir(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        if from.is_dir() {
            if to.exists() {
                return Err(format!("{} already exists", to.display()));
            }
            fs::rename(from, to).map_err(|e| format!("rename {}: {e}", from.display()))?;
        }
        if let (Some(f), Some(t)) = (self.rel(from), self.rel(to)) {
            if let Some(v) = self.vault.as_deref_mut() {
                v.rename_prefix(&f, &t)?;
            }
        }
        Ok(())
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

    /// Small JSON documents (library, history, cache): encrypted inside the
    /// vault when one is open, plain dotfiles otherwise.
    pub fn load_meta(&self, name: &str) -> Result<Option<String>, String> {
        if let Some(v) = self.vault.as_deref() {
            return Ok(v.read_meta(name)?.map(|b| String::from_utf8_lossy(&b).into_owned()));
        }
        let p = self.root.join(format!(".mediasorter.{name}.json"));
        if !p.exists() {
            return Ok(None);
        }
        fs::read_to_string(&p).map(Some).map_err(|e| e.to_string())
    }

    pub fn save_meta(&self, name: &str, text: &str) -> Result<(), String> {
        if let Some(v) = self.vault.as_deref() {
            return v.write_meta(name, text.as_bytes());
        }
        let p = self.root.join(format!(".mediasorter.{name}.json"));
        let tmp = self.root.join(format!(".mediasorter.{name}.json.tmp"));
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &p).map_err(|e| e.to_string())
    }
}

/// Plain files outside the vault that could still be encrypted.
pub fn plaintext_files(root: &Path) -> Vec<FileRef> {
    media::walk_files(root, &[])
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!root.join(".mediasorter.history.json").exists());
        assert_eq!(ctx.load_meta("history").unwrap().unwrap(), "{\"viewed\":{}}");
        let _ = fs::remove_dir_all(&root);
    }
}
