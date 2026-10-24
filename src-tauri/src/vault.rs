//! Vault mode: every file in the folder becomes an opaque blob under
//! `.vault/objects/<random id>`; names, folders, sizes and times live only in
//! an encrypted index. The library, history and hash cache are encrypted too.
//!
//! Keys: Argon2id(passphrase, salt) -> key-encryption key; a random data key
//! is wrapped with it, so the passphrase can change without re-encrypting.
//! Objects: XChaCha20-Poly1305 per 64 KiB chunk, nonce = 20 random bytes ||
//! chunk index, so any byte range can be decrypted without the rest.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use zeroize::{Zeroize, ZeroizeOnDrop};

pub const VAULT_DIR: &str = ".vault";
pub const CHUNK: usize = 64 * 1024;
const TAG: usize = 16;
const MAGIC: &[u8; 4] = b"MSV1";
const OBJ_HEADER: usize = 4 + 20 + 8;

#[derive(Debug, Serialize, Deserialize)]
struct Header {
    version: u32,
    salt: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    wrap_nonce: String,
    wrapped_key: String,
    created: u64,
    /// Second slot: the data key wrapped with a key derived from the recovery code.
    #[serde(default)]
    recovery_salt: Option<String>,
    #[serde(default)]
    recovery_nonce: Option<String>,
    #[serde(default)]
    recovery_wrapped: Option<String>,
}

/// Crockford base32 without the ambiguous letters; 32 chars = 160 bits.
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ0123456789";

pub fn new_recovery_code() -> String {
    let bytes = random(32);
    let chars: String = bytes.iter().map(|b| CODE_ALPHABET[(*b % 32) as usize] as char).collect();
    chars.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

/// Accept what people type: lower case, missing dashes, O for 0, I/L for 1.
pub fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            'U' => 'V',
            c => c,
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// Original path relative to the root, forward slashes.
    pub rel: String,
    pub size: u64,
    /// Modified, ms since epoch.
    pub mtime: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    entries: Vec<Entry>,
}

#[derive(Zeroize, ZeroizeOnDrop)]
struct DataKey([u8; 32]);

/// An unlocked vault: the data key plus the decrypted index.
pub struct Vault {
    pub root: PathBuf,
    key: DataKey,
    index: Index,
    by_rel: BTreeMap<String, usize>,
    by_id: BTreeMap<String, usize>,
}

fn cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.into())
}

fn random(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut v);
    v
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn derive_kek(passphrase: &str, salt: &[u8], m: u32, t: u32, p: u32) -> Result<[u8; 32], String> {
    let params = Params::new(m, t, p, Some(32)).map_err(|e| e.to_string())?;
    let a = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    a.hash_password_into(passphrase.as_bytes(), salt, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// Encrypt a small blob (index, library): nonce || ciphertext.
fn seal_small(key: &[u8; 32], plain: &[u8], aad: &[u8]) -> Vec<u8> {
    let nonce = random(24);
    let ct = cipher(key).encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad }).expect("encrypt");
    [nonce, ct].concat()
}

fn open_small(key: &[u8; 32], data: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 24 + TAG {
        return Err("encrypted data too short".into());
    }
    cipher(key)
        .decrypt(XNonce::from_slice(&data[..24]), Payload { msg: &data[24..], aad })
        .map_err(|_| "wrong passphrase or corrupted data".to_string())
}

fn chunk_nonce(base: &[u8], i: u32) -> XNonce {
    let mut n = [0u8; 24];
    n[..20].copy_from_slice(&base[..20]);
    n[20..].copy_from_slice(&i.to_le_bytes());
    XNonce::from(n)
}

pub fn exists(root: &Path) -> bool {
    root.join(VAULT_DIR).join("vault.json").is_file()
}

impl Vault {
    fn dir(root: &Path) -> PathBuf {
        root.join(VAULT_DIR)
    }
    pub fn objects_dir(&self) -> PathBuf {
        Self::dir(&self.root).join("objects")
    }
    fn meta_dir(&self) -> PathBuf {
        Self::dir(&self.root).join("meta")
    }

    /// Create a new, empty vault in `root`.
    pub fn create(root: &Path, passphrase: &str) -> Result<Vault, String> {
        if exists(root) {
            return Err("this folder already has a vault".into());
        }
        if passphrase.chars().count() < 12 {
            return Err("use a passphrase of at least 12 characters".into());
        }
        let dir = Self::dir(root);
        fs::create_dir_all(dir.join("objects")).map_err(|e| e.to_string())?;
        fs::create_dir_all(dir.join("meta")).map_err(|e| e.to_string())?;
        let salt = random(16);
        // ~200 ms per guess on a 2024 laptop (measured), 128 MiB per guess: well above
        // the OWASP minimum and still fine for an interactive unlock. Existing vaults keep
        // the parameters stored in their header.
        let (m, t, p) = (128 * 1024, 3, 1);
        let kek = derive_kek(passphrase, &salt, m, t, p)?;
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        let wrap_nonce = random(24);
        let wrapped = cipher(&kek).encrypt(XNonce::from_slice(&wrap_nonce), key.as_slice()).map_err(|e| e.to_string())?;
        let header = Header { version: 1, salt: hex::encode(&salt), m_cost: m, t_cost: t, p_cost: p, wrap_nonce: hex::encode(&wrap_nonce), wrapped_key: hex::encode(&wrapped), created: now_ms(), recovery_salt: None, recovery_nonce: None, recovery_wrapped: None };
        fs::write(dir.join("vault.json"), serde_json::to_vec_pretty(&header).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut v = Vault { root: root.to_path_buf(), key: DataKey(key), index: Index::default(), by_rel: BTreeMap::new(), by_id: BTreeMap::new() };
        v.save_index()?;
        Ok(v)
    }

    fn read_header(root: &Path) -> Result<Header, String> {
        serde_json::from_slice(&fs::read(Self::dir(root).join("vault.json")).map_err(|_| "no vault in this folder".to_string())?).map_err(|e| e.to_string())
    }

    fn write_header(root: &Path, header: &Header) -> Result<(), String> {
        let dir = Self::dir(root);
        let tmp = dir.join("vault.json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(header).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&tmp, dir.join("vault.json")).map_err(|e| e.to_string())
    }

    /// Issue a (new) recovery code: wraps the data key in the second slot and
    /// returns the code. Shown once; it is not stored anywhere.
    pub fn set_recovery_code(&self) -> Result<String, String> {
        let mut header = Self::read_header(&self.root)?;
        let code = new_recovery_code();
        let salt = random(16);
        let kek = derive_kek(&normalize_code(&code), &salt, header.m_cost, header.t_cost, header.p_cost)?;
        let nonce = random(24);
        let wrapped = cipher(&kek).encrypt(XNonce::from_slice(&nonce), self.key.0.as_slice()).map_err(|e| e.to_string())?;
        header.recovery_salt = Some(hex::encode(&salt));
        header.recovery_nonce = Some(hex::encode(&nonce));
        header.recovery_wrapped = Some(hex::encode(&wrapped));
        Self::write_header(&self.root, &header)?;
        Ok(code)
    }

    pub fn has_recovery(root: &Path) -> bool {
        Self::read_header(root).map(|h| h.recovery_wrapped.is_some()).unwrap_or(false)
    }

    /// Unlock with the recovery code instead of the passphrase.
    pub fn unlock_with_recovery(root: &Path, code: &str) -> Result<Vault, String> {
        let header = Self::read_header(root)?;
        let (Some(salt), Some(nonce), Some(wrapped)) = (&header.recovery_salt, &header.recovery_nonce, &header.recovery_wrapped) else {
            return Err("this vault has no recovery code".into());
        };
        let kek = derive_kek(&normalize_code(code), &hex::decode(salt).map_err(|e| e.to_string())?, header.m_cost, header.t_cost, header.p_cost)?;
        let key_vec = cipher(&kek)
            .decrypt(XNonce::from_slice(&hex::decode(nonce).map_err(|e| e.to_string())?), hex::decode(wrapped).map_err(|e| e.to_string())?.as_slice())
            .map_err(|_| "recovery code is wrong".to_string())?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_vec);
        let mut v = Vault { root: root.to_path_buf(), key: DataKey(key), index: Index::default(), by_rel: BTreeMap::new(), by_id: BTreeMap::new() };
        v.load_index()?;
        Ok(v)
    }

    /// Set a new passphrase without knowing the old one (after a recovery unlock).
    pub fn reset_passphrase(&self, new: &str) -> Result<(), String> {
        if new.chars().count() < 12 {
            return Err("use a passphrase of at least 12 characters".into());
        }
        let mut header = Self::read_header(&self.root)?;
        let salt = random(16);
        let kek = derive_kek(new, &salt, header.m_cost, header.t_cost, header.p_cost)?;
        let nonce = random(24);
        let wrapped = cipher(&kek).encrypt(XNonce::from_slice(&nonce), self.key.0.as_slice()).map_err(|e| e.to_string())?;
        header.salt = hex::encode(&salt);
        header.wrap_nonce = hex::encode(&nonce);
        header.wrapped_key = hex::encode(&wrapped);
        Self::write_header(&self.root, &header)
    }

    pub fn unlock(root: &Path, passphrase: &str) -> Result<Vault, String> {
        let dir = Self::dir(root);
        let header: Header = serde_json::from_slice(&fs::read(dir.join("vault.json")).map_err(|_| "no vault in this folder".to_string())?).map_err(|e| e.to_string())?;
        let salt = hex::decode(&header.salt).map_err(|e| e.to_string())?;
        let kek = derive_kek(passphrase, &salt, header.m_cost, header.t_cost, header.p_cost)?;
        let wrap_nonce = hex::decode(&header.wrap_nonce).map_err(|e| e.to_string())?;
        let wrapped = hex::decode(&header.wrapped_key).map_err(|e| e.to_string())?;
        let key_vec = cipher(&kek).decrypt(XNonce::from_slice(&wrap_nonce), wrapped.as_slice()).map_err(|_| "wrong passphrase".to_string())?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_vec);
        let mut v = Vault { root: root.to_path_buf(), key: DataKey(key), index: Index::default(), by_rel: BTreeMap::new(), by_id: BTreeMap::new() };
        v.load_index()?;
        Ok(v)
    }

    /// The raw data key, for the quick-unlock store on this machine.
    pub fn data_key(&self) -> [u8; 32] {
        self.key.0
    }

    /// Open with the data key itself (quick unlock). The header still has to exist.
    pub fn unlock_with_key(root: &Path, key: [u8; 32]) -> Result<Vault, String> {
        Self::read_header(root)?;
        let mut v = Vault { root: root.to_path_buf(), key: DataKey(key), index: Index::default(), by_rel: BTreeMap::new(), by_id: BTreeMap::new() };
        v.load_index().map_err(|_| "stored key does not open this vault".to_string())?;
        Ok(v)
    }

    pub fn change_passphrase(&self, old: &str, new: &str) -> Result<(), String> {
        if new.chars().count() < 12 {
            return Err("use a passphrase of at least 12 characters".into());
        }
        let mut header = Self::read_header(&self.root)?;
        let salt = hex::decode(&header.salt).map_err(|e| e.to_string())?;
        let kek_old = derive_kek(old, &salt, header.m_cost, header.t_cost, header.p_cost)?;
        let wrap_nonce = hex::decode(&header.wrap_nonce).map_err(|e| e.to_string())?;
        let wrapped = hex::decode(&header.wrapped_key).map_err(|e| e.to_string())?;
        cipher(&kek_old).decrypt(XNonce::from_slice(&wrap_nonce), wrapped.as_slice()).map_err(|_| "current passphrase is wrong".to_string())?;
        let new_salt = random(16);
        let kek_new = derive_kek(new, &new_salt, header.m_cost, header.t_cost, header.p_cost)?;
        let new_nonce = random(24);
        let new_wrapped = cipher(&kek_new).encrypt(XNonce::from_slice(&new_nonce), self.key.0.as_slice()).map_err(|e| e.to_string())?;
        header.salt = hex::encode(&new_salt);
        header.wrap_nonce = hex::encode(&new_nonce);
        header.wrapped_key = hex::encode(&new_wrapped);
        Self::write_header(&self.root, &header)
    }

    /* ---------- index ---------- */

    fn rebuild_maps(&mut self) {
        self.by_rel = self.index.entries.iter().enumerate().map(|(i, e)| (e.rel.clone(), i)).collect();
        self.by_id = self.index.entries.iter().enumerate().map(|(i, e)| (e.id.clone(), i)).collect();
    }

    fn load_index(&mut self) -> Result<(), String> {
        let p = Self::dir(&self.root).join("index.enc");
        if p.exists() {
            let data = fs::read(&p).map_err(|e| e.to_string())?;
            let plain = open_small(&self.key.0, &data, b"index")?;
            self.index = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
        }
        self.rebuild_maps();
        Ok(())
    }

    fn save_index(&mut self) -> Result<(), String> {
        self.rebuild_maps();
        let dir = Self::dir(&self.root);
        let plain = serde_json::to_vec(&self.index).map_err(|e| e.to_string())?;
        let data = seal_small(&self.key.0, &plain, b"index");
        let tmp = dir.join("index.enc.tmp");
        fs::write(&tmp, data).map_err(|e| e.to_string())?;
        fs::rename(&tmp, dir.join("index.enc")).map_err(|e| e.to_string())
    }

    pub fn entries(&self) -> &[Entry] {
        &self.index.entries
    }
    pub fn entry_by_rel(&self, rel: &str) -> Option<&Entry> {
        self.by_rel.get(rel).map(|&i| &self.index.entries[i])
    }
    pub fn entry_by_id(&self, id: &str) -> Option<&Entry> {
        self.by_id.get(id).map(|&i| &self.index.entries[i])
    }
    pub fn object_path(&self, id: &str) -> PathBuf {
        self.objects_dir().join(id)
    }

    /// Rename an entry (a move within the vault). Fails when the target exists.
    pub fn rename(&mut self, from_rel: &str, to_rel: &str) -> Result<(), String> {
        if from_rel == to_rel {
            return Ok(());
        }
        if self.by_rel.contains_key(to_rel) {
            return Err(format!("{to_rel} already exists"));
        }
        let i = *self.by_rel.get(from_rel).ok_or_else(|| format!("{from_rel} is not in the vault"))?;
        self.index.entries[i].rel = to_rel.to_string();
        self.save_index()
    }

    /// Rename a folder prefix for every entry under it.
    pub fn rename_prefix(&mut self, from: &str, to: &str) -> Result<usize, String> {
        let from_p = format!("{}/", from.trim_end_matches('/'));
        let to_p = format!("{}/", to.trim_end_matches('/'));
        let mut n = 0;
        for e in &mut self.index.entries {
            if e.rel.starts_with(&from_p) {
                e.rel = format!("{to_p}{}", &e.rel[from_p.len()..]);
                n += 1;
            }
        }
        self.save_index()?;
        Ok(n)
    }

    pub fn remove(&mut self, rel: &str) -> Result<(), String> {
        let i = *self.by_rel.get(rel).ok_or_else(|| format!("{rel} is not in the vault"))?;
        let e = self.index.entries.remove(i);
        let _ = fs::remove_file(self.object_path(&e.id));
        self.save_index()
    }

    /* ---------- objects ---------- */

    /// Encrypt a plaintext file into the vault and add it to the index.
    /// The source is left in place; the caller deletes it once satisfied.
    pub fn add_file(&mut self, src: &Path, rel: &str) -> Result<Entry, String> {
        if self.by_rel.contains_key(rel) {
            return Err(format!("{rel} is already in the vault"));
        }
        let meta = fs::metadata(src).map_err(|e| e.to_string())?;
        let size = meta.len();
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        let id = hex::encode(random(16));
        let out_path = self.object_path(&id);
        let tmp = out_path.with_extension("part");
        {
            let mut inp = fs::File::open(src).map_err(|e| e.to_string())?;
            let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
            let base = random(20);
            out.write_all(MAGIC).map_err(|e| e.to_string())?;
            out.write_all(&base).map_err(|e| e.to_string())?;
            out.write_all(&size.to_le_bytes()).map_err(|e| e.to_string())?;
            let c = cipher(&self.key.0);
            let mut buf = vec![0u8; CHUNK];
            let mut i: u32 = 0;
            loop {
                let mut filled = 0;
                while filled < CHUNK {
                    let n = inp.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    filled += n;
                }
                if filled == 0 && i > 0 {
                    break;
                }
                let ct = c.encrypt(&chunk_nonce(&base, i), &buf[..filled]).map_err(|e| e.to_string())?;
                out.write_all(&ct).map_err(|e| e.to_string())?;
                i += 1;
                if filled < CHUNK {
                    break;
                }
            }
            out.flush().map_err(|e| e.to_string())?;
        }
        fs::rename(&tmp, &out_path).map_err(|e| e.to_string())?;
        let e = Entry { id, rel: rel.to_string(), size, mtime };
        self.index.entries.push(e.clone());
        self.save_index()?;
        Ok(e)
    }

    /// Decrypt `[start, end)` of an object. `end` is clamped to the size.
    pub fn read_range(&self, id: &str, start: u64, end: u64) -> Result<Vec<u8>, String> {
        let e = self.entry_by_id(id).ok_or("unknown object")?;
        let end = end.min(e.size);
        if start >= end {
            return Ok(vec![]);
        }
        let mut f = fs::File::open(self.object_path(id)).map_err(|e| e.to_string())?;
        let mut head = [0u8; OBJ_HEADER];
        f.read_exact(&mut head).map_err(|e| e.to_string())?;
        if &head[..4] != MAGIC {
            return Err("not a vault object".into());
        }
        let base = &head[4..24];
        let c = cipher(&self.key.0);
        let first = (start / CHUNK as u64) as u32;
        let last = ((end - 1) / CHUNK as u64) as u32;
        let mut out = Vec::with_capacity((end - start) as usize);
        let mut buf = vec![0u8; CHUNK + TAG];
        for i in first..=last {
            let off = OBJ_HEADER as u64 + i as u64 * (CHUNK + TAG) as u64;
            let plain_len = ((e.size - i as u64 * CHUNK as u64).min(CHUNK as u64)) as usize;
            f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
            f.read_exact(&mut buf[..plain_len + TAG]).map_err(|e| e.to_string())?;
            let plain = c.decrypt(&chunk_nonce(base, i), &buf[..plain_len + TAG]).map_err(|_| "object is corrupted".to_string())?;
            let cs = i as u64 * CHUNK as u64;
            let a = start.saturating_sub(cs) as usize;
            let b = (end - cs).min(plain.len() as u64) as usize;
            out.extend_from_slice(&plain[a..b]);
        }
        Ok(out)
    }

    pub fn read_all(&self, id: &str) -> Result<Vec<u8>, String> {
        let size = self.entry_by_id(id).ok_or("unknown object")?.size;
        self.read_range(id, 0, size)
    }

    /// Decrypt an object to a plaintext file (export, or leaving vault mode).
    pub fn export(&self, id: &str, dest: &Path) -> Result<(), String> {
        let e = self.entry_by_id(id).ok_or("unknown object")?.clone();
        if let Some(p) = dest.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let tmp = dest.with_extension(format!("{}.part", dest.extension().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()));
        let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut pos = 0u64;
        while pos < e.size {
            let chunk = self.read_range(&e.id, pos, pos + 8 * CHUNK as u64)?;
            if chunk.is_empty() {
                break;
            }
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            pos += chunk.len() as u64;
        }
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        if let Ok(f) = fs::File::options().write(true).open(&tmp) {
            let _ = f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(e.mtime));
        }
        fs::rename(&tmp, dest).map_err(|e| e.to_string())
    }

    /* ---------- encrypted metadata (library, history, cache) ---------- */

    pub fn read_meta(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let p = self.meta_dir().join(format!("{name}.enc"));
        if !p.exists() {
            return Ok(None);
        }
        let data = fs::read(&p).map_err(|e| e.to_string())?;
        open_small(&self.key.0, &data, name.as_bytes()).map(Some)
    }

    pub fn write_meta(&self, name: &str, plain: &[u8]) -> Result<(), String> {
        let dir = self.meta_dir();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let tmp = dir.join(format!("{name}.enc.tmp"));
        fs::write(&tmp, seal_small(&self.key.0, plain, name.as_bytes())).map_err(|e| e.to_string())?;
        fs::rename(&tmp, dir.join(format!("{name}.enc"))).map_err(|e| e.to_string())
    }
}

/// Parse an HTTP Range header against a known length. Returns [start, end).
pub fn parse_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let h = header?.strip_prefix("bytes=")?;
    let (a, b) = h.split_once('-')?;
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        return Some((len.saturating_sub(n), len));
    }
    let start: u64 = a.parse().ok()?;
    let end = if b.is_empty() { len } else { b.parse::<u64>().ok()?.saturating_add(1).min(len) };
    if start >= len || start >= end {
        return None;
    }
    Some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn create_unlock_add_read_rename_export() {
        let root = tmp("rt");
        let src = root.join("DCIM/IMG_1.bin");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        let data: Vec<u8> = (0..(CHUNK * 2 + 777)).map(|i| (i * 31 % 251) as u8).collect();
        fs::write(&src, &data).unwrap();

        let mut v = Vault::create(&root, "correct horse battery").unwrap();
        let e = v.add_file(&src, "DCIM/IMG_1.bin").unwrap();
        assert_eq!(e.size, data.len() as u64);
        assert!(v.object_path(&e.id).exists());
        // Blob is opaque: no plaintext run of the source inside it.
        let blob = fs::read(v.object_path(&e.id)).unwrap();
        assert!(!blob.windows(64).any(|w| w == &data[1000..1064]));

        assert_eq!(v.read_all(&e.id).unwrap(), data);
        assert_eq!(v.read_range(&e.id, CHUNK as u64 - 5, CHUNK as u64 + 5).unwrap(), &data[CHUNK - 5..CHUNK + 5]);
        assert_eq!(v.read_range(&e.id, data.len() as u64 - 3, u64::MAX).unwrap(), &data[data.len() - 3..]);

        v.rename("DCIM/IMG_1.bin", "Keep/IMG_1.bin").unwrap();
        drop(v);
        assert!(Vault::unlock(&root, "wrong").is_err());
        let v2 = Vault::unlock(&root, "correct horse battery").unwrap();
        assert!(v2.entry_by_rel("Keep/IMG_1.bin").is_some());
        assert!(v2.entry_by_rel("DCIM/IMG_1.bin").is_none());

        let out = root.join("export/IMG_1.bin");
        v2.export(&e.id, &out).unwrap();
        assert_eq!(fs::read(&out).unwrap(), data);

        v2.write_meta("library", b"{\"ratings\":{}}").unwrap();
        assert_eq!(v2.read_meta("library").unwrap().unwrap(), b"{\"ratings\":{}}");
        assert!(fs::read(root.join(".vault/meta/library.enc")).unwrap().windows(7).all(|w| w != b"ratings"));

        v2.change_passphrase("correct horse battery", "new passphrase!").unwrap();
        assert!(Vault::unlock(&root, "correct horse battery").is_err());
        assert!(Vault::unlock(&root, "new passphrase!").is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recovery_code_unlocks_and_resets_passphrase() {
        let root = tmp("rec");
        let v = Vault::create(&root, "first passphrase").unwrap();
        assert!(!Vault::has_recovery(&root));
        let code = v.set_recovery_code().unwrap();
        assert_eq!(code.len(), 32 + 7);
        assert!(Vault::has_recovery(&root));
        drop(v);
        // Typed sloppily: lower case, no dashes, O for 0.
        let sloppy = code.to_lowercase().replace('-', "").replace('0', "o");
        let r = Vault::unlock_with_recovery(&root, &sloppy).unwrap();
        assert!(Vault::unlock_with_recovery(&root, "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH").is_err());
        r.reset_passphrase("second passphrase").unwrap();
        assert!(Vault::unlock(&root, "first passphrase").is_err());
        assert!(Vault::unlock(&root, "second passphrase").is_ok());
        assert!(Vault::unlock_with_recovery(&root, &code).is_ok(), "code keeps working after a reset");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Some((0, 100)));
        assert_eq!(parse_range(Some("bytes=500-"), 1000), Some((500, 1000)));
        assert_eq!(parse_range(Some("bytes=-10"), 1000), Some((990, 1000)));
        assert_eq!(parse_range(Some("bytes=0-5000"), 1000), Some((0, 1000)));
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), None);
        assert_eq!(parse_range(None, 1000), None);
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::*;
    use rand::{Rng, RngCore, SeedableRng};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ms-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Every size around the chunk boundaries, plus random ones, with random
    /// bytes (so "strange formats" are covered: the cipher never looks at
    /// content). Full reads, random ranges and exports must be byte-exact.
    #[test]
    fn roundtrip_is_byte_exact_for_all_sizes() {
        let root = tmp("sizes");
        let mut v = Vault::create(&root, "integrity test passphrase").unwrap();
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let mut sizes = vec![0usize, 1, 2, 15, 16, 17, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK - 1, 2 * CHUNK, 2 * CHUNK + 1, 3 * CHUNK + 12345];
        for _ in 0..6 {
            sizes.push(rng.gen_range(0..4 * CHUNK));
        }
        for (n, size) in sizes.iter().enumerate() {
            let mut data = vec![0u8; *size];
            rng.fill_bytes(&mut data);
            let src = root.join(format!("in/f{n}.bin"));
            fs::create_dir_all(src.parent().unwrap()).unwrap();
            fs::write(&src, &data).unwrap();
            let e = v.add_file(&src, &format!("f{n}.bin")).unwrap();
            assert_eq!(e.size as usize, *size);
            assert_eq!(v.read_all(&e.id).unwrap(), data, "size {size}: full read");
            for _ in 0..20 {
                if *size == 0 {
                    break;
                }
                let a = rng.gen_range(0..*size);
                let b = rng.gen_range(a..=*size);
                assert_eq!(v.read_range(&e.id, a as u64, b as u64).unwrap(), &data[a..b], "size {size}: range {a}..{b}");
            }
            // Past the end is clamped, never garbage.
            assert_eq!(v.read_range(&e.id, 0, u64::MAX).unwrap(), data);
            let out = root.join(format!("out/f{n}.bin"));
            v.export(&e.id, &out).unwrap();
            assert_eq!(fs::read(&out).unwrap(), data, "size {size}: export");
            let (ms, me) = (fs::metadata(&src).unwrap().modified().unwrap(), fs::metadata(&out).unwrap().modified().unwrap());
            assert!(ms.duration_since(me).unwrap_or_default().as_millis() < 2 && me.duration_since(ms).unwrap_or_default().as_millis() < 2, "mtime preserved");
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// Any damage to a blob is detected by the authentication tag: the read
    /// fails instead of returning altered bytes. Truncation fails too.
    #[test]
    fn tampering_is_detected_never_silently_decrypted() {
        let root = tmp("tamper");
        let mut v = Vault::create(&root, "integrity test passphrase").unwrap();
        let data: Vec<u8> = (0..(2 * CHUNK + 100)).map(|i| (i % 253) as u8).collect();
        let src = root.join("x.bin");
        fs::write(&src, &data).unwrap();
        let e = v.add_file(&src, "x.bin").unwrap();
        let blob_path = v.object_path(&e.id);
        let good = fs::read(&blob_path).unwrap();

        // Flip one bit in each region: header nonce, first chunk, tag of the last chunk.
        for pos in [10usize, OBJ_HEADER + 100, good.len() - 1, OBJ_HEADER + CHUNK + TAG + 5] {
            let mut bad = good.clone();
            bad[pos] ^= 0x01;
            fs::write(&blob_path, &bad).unwrap();
            let r = v.read_all(&e.id);
            assert!(r.is_err(), "flipped byte at {pos} must fail, not decrypt");
        }
        // Truncated blob.
        fs::write(&blob_path, &good[..good.len() - 7]).unwrap();
        assert!(v.read_all(&e.id).is_err());
        // Restore: reads again byte-exact.
        fs::write(&blob_path, &good).unwrap();
        assert_eq!(v.read_all(&e.id).unwrap(), data);
        let _ = fs::remove_dir_all(&root);
    }

    /// Two files with identical content get different blobs (fresh nonces),
    /// and the passphrase derivation is deliberately slow.
    #[test]
    fn nonces_are_fresh_and_kdf_is_slow() {
        let root = tmp("nonce");
        let mut v = Vault::create(&root, "integrity test passphrase").unwrap();
        let data = vec![7u8; 5000];
        fs::write(root.join("a.bin"), &data).unwrap();
        fs::write(root.join("b.bin"), &data).unwrap();
        let a = v.add_file(&root.join("a.bin"), "a.bin").unwrap();
        let b = v.add_file(&root.join("b.bin"), "b.bin").unwrap();
        let (ba, bb) = (fs::read(v.object_path(&a.id)).unwrap(), fs::read(v.object_path(&b.id)).unwrap());
        assert_ne!(ba, bb);
        assert_ne!(&ba[OBJ_HEADER..], &bb[OBJ_HEADER..], "same plaintext must not give the same ciphertext");

        let t = std::time::Instant::now();
        let _ = Vault::unlock(&root, "wrong guess");
        let per_guess = t.elapsed();
        eprintln!("one passphrase guess costs {:?} (128 MiB Argon2id, t=3)", per_guess);
        let _ = fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod kdf_bench {
    #[test]
    #[ignore]
    fn kdf_cost_table() {
        for (m, t) in [(64 * 1024u32, 3u32), (128 * 1024, 3), (256 * 1024, 3), (256 * 1024, 4)] {
            let s = std::time::Instant::now();
            super::derive_kek("benchmark passphrase", &[1u8; 16], m, t, 1).unwrap();
            eprintln!("m={} MiB t={} -> {:?}", m / 1024, t, s.elapsed());
        }
    }
}

#[cfg(test)]
mod fixture {
    /// `MS_FIXTURE_DIR=/path cargo test --release make_vault_fixture -- --ignored` builds a
    /// small vault (passphrase "fixture passphrase") from the plain files already in that folder.
    #[test]
    #[ignore]
    fn make_vault_fixture() {
        let Some(dir) = std::env::var_os("MS_FIXTURE_DIR") else { return };
        let root = std::path::PathBuf::from(dir);
        let mut v = super::Vault::create(&root, "fixture passphrase").unwrap();
        for f in crate::media::walk_files(&root, &[]) {
            let rel = crate::media::rel_key(&root, &f.path);
            v.add_file(&f.path, &rel).unwrap();
            std::fs::remove_file(&f.path).unwrap();
        }
        eprintln!("fixture vault with {} entries at {}", v.entries().len(), root.display());
    }
}
