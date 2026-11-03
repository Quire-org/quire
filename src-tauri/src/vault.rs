//! Vault mode: every file in the folder becomes an opaque blob under
//! `.vault/objects/<random id>`; names, folders, sizes and times live only in
//! an encrypted index. The library, history and hash cache are encrypted too.
//!
//! Keys: Argon2id(passphrase, salt) -> key-encryption key; a random data key
//! is wrapped with it, so the passphrase can change without re-encrypting.
//! Objects: XChaCha20-Poly1305 per 64 KiB chunk, nonce = 20 random bytes ||
//! chunk index, so any byte range can be decrypted without the rest.

use quire_crypto::Cipher;
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
/// The metadata log of objects sealed but not yet named by the index (see `Vault::note_pending`).
const PENDING: &str = "pending";

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
    /// Index changes (renames) not written yet: one write per command, not one per file.
    unsaved: bool,
}

/// An object written to the vault but not in its index yet (see `seal`, `commit`).
pub struct Sealed {
    id: String,
    size: u64,
    mtime: u64,
}

impl Sealed {
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// The key and the objects folder, apart from the vault (see `Vault::keys`).
pub struct Keys {
    key: DataKey,
    objects: PathBuf,
}

impl Keys {
    /// Encrypt everything `src` gives into a new object, its length not known in advance (ffmpeg
    /// writing an edit, say): the length in the header is filled in at the end. Written as a
    /// .part file and renamed when complete; a .part left by a crash is removed when the vault
    /// next opens. Nothing is written in the clear.
    pub fn seal_stream(&self, src: &mut dyn Read, mtime: u64) -> Result<Sealed, String> {
        let id = hex::encode(random(16));
        let out_path = shard(&self.objects, &id);
        let tmp = out_path.with_extension("part");
        let written = (|| -> Result<u64, String> {
            let mut out = {
                let _turn = crate::fsx::one_at_a_time(&self.objects);
                fs::create_dir_all(out_path.parent().unwrap_or(&self.objects)).map_err(|e| e.to_string())?;
                fs::File::create(&tmp).map_err(|e| e.to_string())?
            };
            let base = random(20);
            out.write_all(MAGIC).map_err(|e| e.to_string())?;
            out.write_all(&base).map_err(|e| e.to_string())?;
            out.write_all(&0u64.to_le_bytes()).map_err(|e| e.to_string())?;
            let c = cipher(&self.key.0);
            let mut buf = vec![0u8; CHUNK];
            let mut i: u32 = 0;
            let mut size = 0u64;
            loop {
                let mut filled = 0;
                while filled < CHUNK {
                    let n = src.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    filled += n;
                }
                if filled == 0 && i > 0 {
                    break;
                }
                let ct = c.encrypt(&chunk_nonce(&base, i), &buf[..filled], &[]).map_err(|e| e.to_string())?;
                out.write_all(&ct).map_err(|e| e.to_string())?;
                size += filled as u64;
                i += 1;
                if filled < CHUNK {
                    break;
                }
            }
            out.seek(SeekFrom::Start((MAGIC.len() + 20) as u64)).map_err(|e| e.to_string())?;
            out.write_all(&size.to_le_bytes()).map_err(|e| e.to_string())?;
            Ok(size)
        })();
        let _turn = crate::fsx::one_at_a_time(&self.objects);
        let size = match written.and_then(|n| fs::File::options().write(true).open(&tmp).and_then(|f| f.sync_all()).map(|_| n).map_err(|e| e.to_string())) {
            Ok(n) => n,
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        };
        if let Err(e) = fs::rename(&tmp, &out_path) {
            let _ = fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(Sealed { id, size, mtime })
    }

    /// An object written but never put in the index (a failed edit, say): removed.
    pub fn discard(&self, s: Sealed) {
        remove_either(&self.objects, &s.id);
    }

    /// Decrypt `[start, end)` of object `id` (`size` long).
    pub fn read_range(&self, id: &str, size: u64, start: u64, end: u64) -> Result<Vec<u8>, String> {
        read_object(&self.key.0, &self.objects, id, size, start, end)
    }
}

/// How big a file is once encrypted: the header, and a tag for each chunk (one at least).
pub fn encrypted_size(plain: u64) -> u64 {
    OBJ_HEADER as u64 + plain + TAG as u64 * plain.div_ceil(CHUNK as u64).max(1)
}

/// Where a file of the vault named by an id goes: in a folder named by the id's first two
/// characters (256 of them), so no folder holds more than a sliver of the vault. FAT and exFAT look
/// a name up entry by entry, so every file made in a folder of thousands takes longer than the last
/// (on a FAT32 test drive, 1 ms at first and 5 ms by the 16,000th), and a big library in one folder
/// once left macOS's FAT driver deadlocked. A name that doesn't start with an id stays in the
/// folder itself.
pub fn shard(dir: &Path, name: &str) -> PathBuf {
    match name.get(..2) {
        Some(p) if p.bytes().all(|b| b.is_ascii_hexdigit()) => dir.join(p).join(name),
        _ => dir.join(name),
    }
}

/// A file of the vault where it is now: in its folder (see `shard`), else where earlier versions
/// kept every file, the folder itself, until it has been moved (see `Vault::unsharded`).
fn either(dir: &Path, name: &str) -> PathBuf {
    let s = shard(dir, name);
    let flat = dir.join(name);
    if !s.exists() && flat.exists() { flat } else { s }
}

/// Opened where it is now: in its folder, else in the old place, else in its folder again (moved
/// there meanwhile).
fn open_either(dir: &Path, name: &str) -> std::io::Result<fs::File> {
    let s = shard(dir, name);
    match fs::File::open(&s) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => match fs::File::open(dir.join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::File::open(&s),
            r => r,
        },
        r => r,
    }
}

/// A file of the vault gone, from wherever it is.
pub fn remove_either(dir: &Path, name: &str) {
    let _ = fs::remove_file(shard(dir, name));
    let _ = fs::remove_file(dir.join(name));
}

/// Decrypt `[start, end)` of object `id` in `objects`, `size` bytes long in the clear.
fn read_object(key: &[u8; 32], objects: &Path, id: &str, size: u64, start: u64, end: u64) -> Result<Vec<u8>, String> {
    let end = end.min(size);
    if start >= end {
        return Ok(vec![]);
    }
    let mut f = open_either(objects, id).map_err(|e| e.to_string())?;
    let mut head = [0u8; OBJ_HEADER];
    f.read_exact(&mut head).map_err(|e| e.to_string())?;
    if &head[..4] != MAGIC {
        return Err("not a vault object".into());
    }
    let base = &head[4..24];
    let c = cipher(key);
    let first = (start / CHUNK as u64) as u32;
    let last = ((end - 1) / CHUNK as u64) as u32;
    let mut out = Vec::with_capacity((end - start) as usize);
    let mut buf = vec![0u8; CHUNK + TAG];
    for i in first..=last {
        let off = OBJ_HEADER as u64 + i as u64 * (CHUNK + TAG) as u64;
        let plain_len = ((size - i as u64 * CHUNK as u64).min(CHUNK as u64)) as usize;
        f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
        f.read_exact(&mut buf[..plain_len + TAG]).map_err(|e| e.to_string())?;
        let plain = c.decrypt(&chunk_nonce(base, i), &buf[..plain_len + TAG], &[]).map_err(|_| "object is corrupted".to_string())?;
        let cs = i as u64 * CHUNK as u64;
        let a = start.saturating_sub(cs) as usize;
        let b = (end - cs).min(plain.len() as u64) as usize;
        out.extend_from_slice(&plain[a..b]);
    }
    Ok(out)
}

impl Drop for Vault {
    /// Locking the vault (or quitting) writes what is still unsaved.
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

fn cipher(key: &[u8; 32]) -> Cipher {
    Cipher::new(key)
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
    quire_crypto::derive_key(passphrase.as_bytes(), salt, m, t, p)
}

/// Encrypt a small blob (index, library): nonce || ciphertext.
fn seal_small(key: &[u8; 32], plain: &[u8], aad: &[u8]) -> Vec<u8> {
    let nonce = random(24);
    let ct = cipher(key).encrypt(&nonce, plain, aad).expect("encrypt");
    [nonce, ct].concat()
}

fn open_small(key: &[u8; 32], data: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 24 + TAG {
        return Err("encrypted data too short".into());
    }
    cipher(key)
        .decrypt(&data[..24], &data[24..], aad)
        .map_err(|_| "wrong passphrase or corrupted data".to_string())
}

fn chunk_nonce(base: &[u8], i: u32) -> [u8; 24] {
    let mut n = [0u8; 24];
    n[..20].copy_from_slice(&base[..20]);
    n[20..].copy_from_slice(&i.to_le_bytes());
    n
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
        let wrapped = cipher(&kek).encrypt(&wrap_nonce, key.as_slice(), &[]).map_err(|e| e.to_string())?;
        let header = Header { version: 1, salt: hex::encode(&salt), m_cost: m, t_cost: t, p_cost: p, wrap_nonce: hex::encode(&wrap_nonce), wrapped_key: hex::encode(&wrapped), created: now_ms(), recovery_salt: None, recovery_nonce: None, recovery_wrapped: None };
        fs::write(dir.join("vault.json"), serde_json::to_vec_pretty(&header).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let mut v = Vault { root: root.to_path_buf(), key: DataKey(key), index: Index::default(), by_rel: BTreeMap::new(), by_id: BTreeMap::new(), unsaved: false };
        v.save_index()?;
        Ok(v)
    }

    fn read_header(root: &Path) -> Result<Header, String> {
        serde_json::from_slice(&fs::read(Self::dir(root).join("vault.json")).map_err(|_| "no vault in this folder".to_string())?).map_err(|e| e.to_string())
    }

    fn write_header(root: &Path, header: &Header) -> Result<(), String> {
        crate::fsx::write_atomic(&Self::dir(root).join("vault.json"), &serde_json::to_vec_pretty(header).map_err(|e| e.to_string())?)
    }

    /// Issue a (new) recovery code: wraps the data key in the second slot and
    /// returns the code. Shown once; it is not stored anywhere.
    pub fn set_recovery_code(&self) -> Result<String, String> {
        let mut header = Self::read_header(&self.root)?;
        let code = new_recovery_code();
        let salt = random(16);
        let kek = derive_kek(&normalize_code(&code), &salt, header.m_cost, header.t_cost, header.p_cost)?;
        let nonce = random(24);
        let wrapped = cipher(&kek).encrypt(&nonce, self.key.0.as_slice(), &[]).map_err(|e| e.to_string())?;
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
            .decrypt(&hex::decode(nonce).map_err(|e| e.to_string())?, hex::decode(wrapped).map_err(|e| e.to_string())?.as_slice(), &[])
            .map_err(|_| "recovery code is wrong".to_string())?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_vec);
        let mut v = Vault { root: root.to_path_buf(), key: DataKey(key), index: Index::default(), by_rel: BTreeMap::new(), by_id: BTreeMap::new(), unsaved: false };
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
        let wrapped = cipher(&kek).encrypt(&nonce, self.key.0.as_slice(), &[]).map_err(|e| e.to_string())?;
        header.salt = hex::encode(&salt);
        header.wrap_nonce = hex::encode(&nonce);
        header.wrapped_key = hex::encode(&wrapped);
        Self::write_header(&self.root, &header)
    }

    pub fn unlock(root: &Path, passphrase: &str) -> Result<Vault, String> {
        let dir = Self::dir(root);
        let header: Header = serde_json::from_slice(&fs::read(dir.join("vault.json")).map_err(|_| "no vault in this folder".to_string())?).map_err(|e| e.to_string())?;
        let salt = hex::decode(&header.salt).map_err(|e| e.to_string())?;
        // The header comes from the drive, unauthenticated: costs beyond what this app ever writes
        // (a tampered file) would ask for terabytes of memory and kill the app.
        if header.m_cost > 1 << 20 || header.t_cost > 64 || header.p_cost > 16 {
            return Err("the vault's header isn't one Quire wrote".into());
        }
        let kek = derive_kek(passphrase, &salt, header.m_cost, header.t_cost, header.p_cost)?;
        let wrap_nonce = hex::decode(&header.wrap_nonce).map_err(|e| e.to_string())?;
        let wrapped = hex::decode(&header.wrapped_key).map_err(|e| e.to_string())?;
        let key_vec = cipher(&kek).decrypt(&wrap_nonce, wrapped.as_slice(), &[]).map_err(|_| "wrong passphrase".to_string())?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_vec);
        let mut v = Vault { root: root.to_path_buf(), key: DataKey(key), index: Index::default(), by_rel: BTreeMap::new(), by_id: BTreeMap::new(), unsaved: false };
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
        let mut v = Vault { root: root.to_path_buf(), key: DataKey(key), index: Index::default(), by_rel: BTreeMap::new(), by_id: BTreeMap::new(), unsaved: false };
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
        cipher(&kek_old).decrypt(&wrap_nonce, wrapped.as_slice(), &[]).map_err(|_| "current passphrase is wrong".to_string())?;
        let new_salt = random(16);
        let kek_new = derive_kek(new, &new_salt, header.m_cost, header.t_cost, header.p_cost)?;
        let new_nonce = random(24);
        let new_wrapped = cipher(&kek_new).encrypt(&new_nonce, self.key.0.as_slice(), &[]).map_err(|e| e.to_string())?;
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
        // Objects a crash left half written (always encrypted) are of no use: gone, from the objects
        // folder and the folders in it.
        let mut dirs = vec![self.objects_dir()];
        if let Ok(rd) = fs::read_dir(self.objects_dir()) {
            dirs.extend(rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
        }
        for dir in dirs {
            if let Ok(rd) = fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.path().extension().is_some_and(|x| x == "part") {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
        // So are whole objects a crash left before the index named them (see `note_pending`): their
        // files were still in the clear, and encrypting them again makes new objects.
        for id in self.read_meta_records(PENDING).unwrap_or_default() {
            let id = String::from_utf8_lossy(&id).into_owned();
            if !self.by_id.contains_key(&id) && id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
                remove_either(&self.objects_dir(), &id);
            }
        }
        // A drive that won't take the write (read-only, say) still opens; the note waits for next time.
        let _ = self.remove_meta(PENDING);
        Ok(())
    }

    fn save_index(&mut self) -> Result<(), String> {
        let dir = Self::dir(&self.root);
        let plain = serde_json::to_vec(&self.index).map_err(|e| e.to_string())?;
        let data = seal_small(&self.key.0, &plain, b"index");
        // The index names every object: it is never left half written (see fsx::write_atomic).
        crate::fsx::write_atomic(&dir.join("index.enc"), &data)
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
        either(&self.objects_dir(), id)
    }

    /// Rename an entry (a move within the vault). Fails when the target exists.
    pub fn rename(&mut self, from_rel: &str, to_rel: &str) -> Result<(), String> {
        if from_rel == to_rel {
            return Ok(());
        }
        if self.by_rel.contains_key(to_rel) {
            return Err(format!("{to_rel} already exists"));
        }
        let i = self.by_rel.remove(from_rel).ok_or_else(|| format!("{from_rel} is not in the vault"))?;
        self.index.entries[i].rel = to_rel.to_string();
        self.by_rel.insert(to_rel.to_string(), i);
        self.unsaved = true;
        Ok(())
    }

    /// The index changed: lookups follow now, the write comes with `flush`.
    fn changed(&mut self) {
        self.rebuild_maps();
        self.unsaved = true;
    }

    /// Write the index if anything changed since it was last written.
    pub fn flush(&mut self) -> Result<(), String> {
        if !self.unsaved {
            return Ok(());
        }
        self.save_index()?;
        self.unsaved = false;
        Ok(())
    }

    /// Rename a folder prefix for every entry under it. Fails, changing nothing, when a name under the
    /// new prefix is taken already: two entries with one name would hide one of them for good.
    pub fn rename_prefix(&mut self, from: &str, to: &str) -> Result<usize, String> {
        let from_p = format!("{}/", from.trim_end_matches('/'));
        let to_p = format!("{}/", to.trim_end_matches('/'));
        if from_p == to_p {
            return Ok(0);
        }
        // Every destination is looked up before any entry moves. An entry that is itself under the old
        // prefix frees its name, so only names outside the folder being renamed can collide.
        for e in &self.index.entries {
            if let Some(rest) = e.rel.strip_prefix(&from_p) {
                let dest = format!("{to_p}{rest}");
                if self.by_rel.get(&dest).is_some_and(|&i| !self.index.entries[i].rel.starts_with(&from_p)) {
                    return Err(format!("{dest} already exists"));
                }
            }
        }
        let mut n = 0;
        for e in &mut self.index.entries {
            if e.rel.starts_with(&from_p) {
                e.rel = format!("{to_p}{}", &e.rel[from_p.len()..]);
                n += 1;
            }
        }
        self.changed();
        Ok(n)
    }

    pub fn remove(&mut self, rel: &str) -> Result<(), String> {
        let i = *self.by_rel.get(rel).ok_or_else(|| format!("{rel} is not in the vault"))?;
        // The index first: a save that fails (the drive full) leaves the entry and its object as they
        // were, rather than an entry whose object is gone.
        let e = self.index.entries[i].clone();
        self.index.entries.remove(i);
        self.rebuild_maps();
        if let Err(err) = self.save_index() {
            self.index.entries.insert(i, e);
            self.rebuild_maps();
            return Err(err);
        }
        remove_either(&self.objects_dir(), &e.id);
        self.forget_thumbs(&e.id);
        Ok(())
    }

    /* ---------- objects ---------- */

    /// Encrypt a plaintext file into the vault and add it to the index (written before this
    /// returns). The source is left in place; the caller deletes it once satisfied.
    pub fn add_file(&mut self, src: &Path, rel: &str) -> Result<Entry, String> {
        if self.by_rel.contains_key(rel) {
            return Err(format!("{rel} is already in the vault"));
        }
        let sealed = self.seal(src)?;
        let e = self.commit(sealed, rel)?;
        self.flush()?;
        Ok(e)
    }

    /// Encrypt a file into an object, not yet in the index. Only reads the vault, so a long job
    /// can do this while other commands use the vault, and lock it just for `commit`.
    pub fn seal(&self, src: &Path) -> Result<Sealed, String> {
        let meta = fs::metadata(src).map_err(|e| e.to_string())?;
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        let mut inp = fs::File::open(src).map_err(|e| e.to_string())?;
        self.keys().seal_stream(&mut inp, mtime)
    }

    /// What a job needs to read and write objects without holding the vault: a copy of the key
    /// (wiped when dropped) and where the objects are.
    pub fn keys(&self) -> Keys {
        Keys { key: DataKey(self.key.0), objects: self.objects_dir() }
    }


    /// Put a sealed object in the index under `rel` (written with `flush`). A name taken since
    /// gets the object deleted and an error.
    pub fn commit(&mut self, s: Sealed, rel: &str) -> Result<Entry, String> {
        if self.by_rel.contains_key(rel) {
            remove_either(&self.objects_dir(), &s.id);
            return Err(format!("{rel} is already in the vault"));
        }
        let e = Entry { id: s.id, rel: rel.to_string(), size: s.size, mtime: s.mtime };
        let i = self.index.entries.len();
        self.by_rel.insert(e.rel.clone(), i);
        self.by_id.insert(e.id.clone(), i);
        self.index.entries.push(e.clone());
        self.unsaved = true;
        Ok(e)
    }

    /// Entries committed but not written yet, taken back (their write failed): out of the index and
    /// their objects deleted, as if never added.
    pub fn uncommit(&mut self, ids: &[String]) {
        let gone: std::collections::BTreeSet<&str> = ids.iter().map(String::as_str).collect();
        self.index.entries.retain(|e| !gone.contains(e.id.as_str()));
        self.rebuild_maps();
        for id in ids {
            remove_either(&self.objects_dir(), id);
        }
    }

    /// A sealed object noted before the index names it, so a crash in between can't leave it behind
    /// unnamed (it is removed the next time the vault opens). Cleared with `clear_pending` once the
    /// index naming it is written. Not synced on its own: an app that crashes still has it written.
    pub fn note_pending(&self, id: &str) -> Result<(), String> {
        self.append_meta_record(PENDING, id.as_bytes())
    }

    pub fn clear_pending(&self) -> Result<(), String> {
        self.remove_meta(PENDING)
    }

    /// The entries under a folder (`prefix` ends in "/", or is empty for all), found in the
    /// sorted index rather than by looking at every entry.
    pub fn entries_under<'a>(&'a self, prefix: &'a str) -> impl Iterator<Item = &'a Entry> + 'a {
        self.by_rel.range::<str, _>((std::ops::Bound::Included(prefix), std::ops::Bound::Unbounded)).take_while(move |(k, _)| k.starts_with(prefix)).map(|(_, &i)| &self.index.entries[i])
    }

    /// Decrypt `[start, end)` of an object. `end` is clamped to the size.
    pub fn read_range(&self, id: &str, start: u64, end: u64) -> Result<Vec<u8>, String> {
        let e = self.entry_by_id(id).ok_or("unknown object")?;
        read_object(&self.key.0, &self.objects_dir(), id, e.size, start, end)
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
        // One set aside by an earlier version was moved without being written again: still sealed
        // with the name it had.
        open_small(&self.key.0, &data, name.as_bytes())
            .or_else(|e| match name.strip_suffix(".broken") {
                Some(was) => open_small(&self.key.0, &data, was.as_bytes()),
                None => Err(e),
            })
            .map(Some)
    }

    /* ---------- folders (see `shard`) ---------- */

    /// The folders that earlier versions kept every file of in the folder itself: objects, then
    /// thumbnails.
    fn shared_out(&self) -> [PathBuf; 2] {
        [self.objects_dir(), self.thumbs_dir()]
    }

    /// Files still where earlier versions kept them, each with where it goes now.
    pub fn unsharded(&self) -> Vec<(PathBuf, PathBuf)> {
        let mut out = Vec::new();
        for dir in self.shared_out() {
            for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let to = shard(&dir, &name);
                if e.file_type().is_ok_and(|t| t.is_file()) && !name.ends_with(".part") && !name.ends_with(".tmp") && to != e.path() {
                    out.push((e.path(), to));
                }
            }
        }
        out
    }

    /// Whether any file is still where earlier versions kept them: stops at the first.
    pub fn has_unsharded(&self) -> bool {
        self.shared_out().iter().any(|dir| {
            fs::read_dir(dir).into_iter().flatten().flatten().any(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                e.file_type().is_ok_and(|t| t.is_file()) && !name.ends_with(".part") && !name.ends_with(".tmp") && shard(dir, &name) != e.path()
            })
        })
    }

    /* ---------- the library's documents as a whole (see `libdocs`) ---------- */

    /// The documents in the vault, by name, each with whether it is a log of records. The vault's
    /// own note of objects in the making (`PENDING`) is not one.
    pub fn meta_docs(&self) -> Vec<(String, bool)> {
        let mut out = Vec::new();
        for e in fs::read_dir(self.meta_dir()).into_iter().flatten().flatten() {
            if !e.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let file = e.file_name().to_string_lossy().into_owned();
            if let Some(n) = file.strip_suffix(".enc") {
                out.push((n.to_string(), false));
            } else if let Some(n) = file.strip_suffix(".log")
                && n != PENDING
            {
                out.push((n.to_string(), true));
            }
        }
        out.sort();
        out
    }

    pub fn has_meta(&self, name: &str) -> bool {
        self.meta_dir().join(format!("{name}.enc")).is_file()
    }

    pub fn has_meta_log(&self, name: &str) -> bool {
        self.meta_dir().join(format!("{name}.log")).is_file()
    }

    /// A document under another name (kept aside), its log of records too. Each is sealed with its
    /// name, so it is written again under the new one rather than renamed.
    pub fn rename_meta(&self, from: &str, to: &str) -> Result<(), String> {
        if let Some(bytes) = self.read_meta(from)? {
            self.write_meta(to, &bytes)?;
            fs::remove_file(self.meta_dir().join(format!("{from}.enc"))).map_err(|e| e.to_string())?;
        }
        if self.has_meta_log(from) {
            for r in self.read_meta_records(from)? {
                self.append_meta_record(to, &r)?;
            }
            fs::remove_file(self.meta_dir().join(format!("{from}.log"))).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// The scrapbook's pictures in the vault, by name.
    pub fn blob_names(&self) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(self.blobs_dir()).into_iter().flatten().flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".enc").map(String::from)).collect();
        out.sort();
        out
    }

    pub fn has_blob(&self, name: &str) -> bool {
        self.blobs_dir().join(format!("{name}.enc")).is_file()
    }

    /* ---------- thumbnails ---------- */

    fn thumbs_dir(&self) -> PathBuf {
        self.meta_dir().join("thumbs")
    }

    /// A thumbnail kept for an object, encrypted like the object (named after its id and width).
    pub fn read_thumb(&self, name: &str) -> Option<Vec<u8>> {
        let mut data = Vec::new();
        open_either(&self.thumbs_dir(), &format!("{name}.enc")).ok()?.read_to_end(&mut data).ok()?;
        open_small(&self.key.0, &data, name.as_bytes()).ok()
    }

    pub fn write_thumb(&self, name: &str, plain: &[u8]) -> Result<(), String> {
        let path = shard(&self.thumbs_dir(), &format!("{name}.enc"));
        if let Some(dir) = path.parent() {
            let _turn = crate::fsx::one_at_a_time(&self.thumbs_dir());
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        crate::fsx::write_cache(&path, &seal_small(&self.key.0, plain, name.as_bytes()))
    }

    fn forget_thumbs(&self, id: &str) {
        for w in crate::thumbs::WIDTHS {
            remove_either(&self.thumbs_dir(), &format!("{id}-{w}.enc"));
        }
    }

    /* ---------- Scrapbook's pictures ---------- */

    fn blobs_dir(&self) -> PathBuf {
        self.meta_dir().join("scrapbook")
    }

    /// A rendered cover or a sticker, encrypted like everything else in the vault.
    pub fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let p = self.blobs_dir().join(format!("{name}.enc"));
        if !p.exists() {
            return Ok(None);
        }
        let data = fs::read(&p).map_err(|e| e.to_string())?;
        open_small(&self.key.0, &data, name.as_bytes()).map(Some)
    }

    pub fn write_blob(&self, name: &str, plain: &[u8]) -> Result<(), String> {
        let dir = self.blobs_dir();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        crate::fsx::write_atomic(&dir.join(format!("{name}.enc")), &seal_small(&self.key.0, plain, name.as_bytes()))
    }

    pub fn remove_blob(&self, name: &str) -> Result<(), String> {
        match fs::remove_file(self.blobs_dir().join(format!("{name}.enc"))) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    pub fn write_meta(&self, name: &str, plain: &[u8]) -> Result<(), String> {
        let dir = self.meta_dir();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        crate::fsx::write_atomic(&dir.join(format!("{name}.enc")), &seal_small(&self.key.0, plain, name.as_bytes()))
    }

    /// A metadata document that won't read, set aside as `<name>.broken.enc` (see `fsx::Ctx::set_aside_meta`).
    pub fn set_aside_meta(&self, name: &str) {
        // Written again under its new name (each is sealed with its name); one that won't even
        // decrypt is moved as it is, still read under its old name (see `read_meta`).
        let aside = format!("{name}.broken");
        if self.rename_meta(name, &aside).is_err() {
            let dir = self.meta_dir();
            let _ = fs::rename(dir.join(format!("{name}.enc")), dir.join(format!("{aside}.enc")));
        }
    }

    pub fn remove_meta(&self, name: &str) -> Result<(), String> {
        for p in [self.meta_dir().join(format!("{name}.enc")), self.meta_dir().join(format!("{name}.log"))] {
            match fs::remove_file(p) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
                _ => {}
            }
        }
        Ok(())
    }

    /// A record added to the end of a metadata log, encrypted on its own (see `fsx::Ctx::append_meta_record`).
    pub fn append_meta_record(&self, name: &str, plain: &[u8]) -> Result<(), String> {
        use std::io::Write;
        let dir = self.meta_dir();
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let sealed = seal_small(&self.key.0, plain, name.as_bytes());
        let _turn = crate::fsx::one_at_a_time(&dir);
        let mut f = fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{name}.log"))).map_err(|e| e.to_string())?;
        let mut record = (sealed.len() as u32).to_le_bytes().to_vec();
        record.extend_from_slice(&sealed);
        f.write_all(&record).map_err(|e| e.to_string())
    }

    pub fn read_meta_records(&self, name: &str) -> Result<Vec<Vec<u8>>, String> {
        let bytes = match fs::read(self.meta_dir().join(format!("{name}.log"))) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        Ok(crate::fsx::records(&bytes).into_iter().map_while(|r| open_small(&self.key.0, r, name.as_bytes()).ok()).collect())
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
    fn streams_of_any_length_round_trip_and_half_written_objects_are_swept() {
        let root = tmp("stream");
        let mut v = Vault::create(&root, "a long enough passphrase").unwrap();
        let keys = v.keys();
        // Around the chunk boundaries, where the length and the last chunk are easiest to get wrong.
        for (n, len) in [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 7].into_iter().enumerate() {
            let data: Vec<u8> = (0..len).map(|i| (i * 7 + n) as u8).collect();
            let s = keys.seal_stream(&mut &data[..], 5).unwrap();
            let e = v.commit(s, &format!("s{n}.bin")).unwrap();
            assert_eq!(e.size, len as u64);
            assert_eq!(v.read_all(&e.id).unwrap(), data, "length {len}");
            assert_eq!(keys.read_range(&e.id, e.size, 0, e.size).unwrap(), data);
            if len > 10 {
                assert_eq!(v.read_range(&e.id, 3, 9).unwrap(), &data[3..9]);
            }
            // Encrypted on disk: not the data itself.
            let raw = fs::read(v.object_path(&e.id)).unwrap();
            assert_eq!(&raw[..4], MAGIC);
            if len > 64 {
                assert!(!raw.windows(32).any(|w| w == &data[..32]));
            }
        }
        // A discarded object is gone; a half-written one (a crash) goes when the vault opens.
        let d = keys.seal_stream(&mut &b"never indexed"[..], 0).unwrap();
        let path = shard(&v.objects_dir(), &d.id);
        assert!(path.exists(), "in its folder");
        keys.discard(d);
        assert!(!path.exists());
        // Half-written ones in the objects folder (as earlier versions left them) and in its folders.
        let part = v.objects_dir().join("deadbeef.part");
        fs::write(&part, b"half").unwrap();
        let part_in = shard(&v.objects_dir(), "deadbeef.part");
        fs::create_dir_all(part_in.parent().unwrap()).unwrap();
        fs::write(&part_in, b"half").unwrap();
        v.flush().unwrap();
        drop(v);
        let v = Vault::unlock(&root, "a long enough passphrase").unwrap();
        assert!(!part.exists() && !part_in.exists());
        assert_eq!(v.entries().len(), 7);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn renames_are_written_once_and_kept_when_the_vault_closes() {
        let root = tmp("batch");
        let mut v = Vault::create(&root, "a long enough passphrase").unwrap();
        for n in ["a", "b"] {
            fs::write(root.join(format!("{n}.jpg")), n.as_bytes()).unwrap();
            v.add_file(&root.join(format!("{n}.jpg")), &format!("{n}.jpg")).unwrap();
        }
        v.rename("a.jpg", "Trip/a.jpg").unwrap();
        v.rename("b.jpg", "Trip/b.jpg").unwrap();
        // Looked up right away, though not written yet.
        assert_eq!(v.entries_under("Trip/").count(), 2);
        assert!(v.unsaved);
        drop(v); // locking writes what is left
        let v = Vault::unlock(&root, "a long enough passphrase").unwrap();
        assert_eq!(v.entries_under("Trip/").map(|e| e.rel.as_str()).collect::<Vec<_>>(), ["Trip/a.jpg", "Trip/b.jpg"]);
        assert_eq!(v.entries_under("").count(), 2);
        assert_eq!(v.read_all(&v.entry_by_rel("Trip/b.jpg").unwrap().id.clone()).unwrap(), b"b");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn renaming_a_folder_onto_a_taken_name_changes_nothing() {
        let root = tmp("prefix");
        let mut v = Vault::create(&root, "a long enough passphrase").unwrap();
        for rel in ["Old/a.jpg", "Old/b.jpg", "New/b.jpg", "Other/c.jpg"] {
            let p = root.join(rel.replace('/', "-"));
            fs::write(&p, rel.as_bytes()).unwrap();
            v.add_file(&p, rel).unwrap();
        }
        // New/b.jpg is taken by an entry that stays: the whole rename is refused, naming it.
        let err = v.rename_prefix("Old", "New").unwrap_err();
        assert!(err.contains("New/b.jpg"), "{err}");
        assert_eq!(v.entries_under("Old/").count(), 2);
        assert_eq!(v.entries_under("New/").count(), 1);
        assert!(v.entry_by_rel("Old/a.jpg").is_some());
        // A name freed by the rename itself is no collision: Old/ into Old/Inner/ works.
        assert_eq!(v.rename_prefix("Old", "Old/Inner").unwrap(), 2);
        assert_eq!(v.entries_under("Old/Inner/").map(|e| e.rel.as_str()).collect::<Vec<_>>(), ["Old/Inner/a.jpg", "Old/Inner/b.jpg"]);
        // And a free destination still renames everything under the prefix.
        assert_eq!(v.rename_prefix("Old/Inner", "Moved").unwrap(), 2);
        assert!(v.entry_by_rel("Moved/a.jpg").is_some());
        assert!(v.entry_by_rel("Other/c.jpg").is_some());
        let _ = fs::remove_dir_all(&root);
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

    #[test]
    fn objects_sealed_before_a_crash_go_when_the_vault_opens_and_named_ones_stay() {
        let root = tmp("pending");
        let pass = "a long enough passphrase";
        let (named, stray) = {
            let mut v = Vault::create(&root, pass).unwrap();
            let keys = v.keys();
            let a = keys.seal_stream(&mut &b"named"[..], 1).unwrap();
            v.note_pending(&a.id).unwrap();
            let b = keys.seal_stream(&mut &b"never named"[..], 1).unwrap();
            v.note_pending(&b.id).unwrap();
            let stray = b.id.clone();
            let e = v.commit(a, "a.jpg").unwrap();
            v.flush().unwrap();
            // The app is gone here, before the second one was named and the note cleared.
            (e.id, stray)
        };
        let v = Vault::unlock(&root, pass).unwrap();
        assert!(v.object_path(&named).exists(), "an object the index names stays");
        assert!(!v.object_path(&stray).exists(), "an object never named goes");
        assert_eq!(v.read_all(&named).unwrap(), b"named");
        assert!(v.read_meta_records(PENDING).unwrap().is_empty(), "the note is cleared");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_document_set_aside_still_reads_under_its_new_name() {
        let root = tmp("aside");
        let v = Vault::create(&root, "a long enough passphrase").unwrap();
        v.write_meta("home", b"{ not json").unwrap();
        v.set_aside_meta("home");
        assert_eq!(v.read_meta("home.broken").unwrap().unwrap(), b"{ not json");
        assert!(v.read_meta("home").unwrap().is_none());
        // As an earlier version set one aside: moved, still sealed with its old name.
        v.write_meta("tags", b"{ not json either").unwrap();
        fs::rename(v.meta_dir().join("tags.enc"), v.meta_dir().join("tags.broken.enc")).unwrap();
        assert_eq!(v.read_meta("tags.broken").unwrap().unwrap(), b"{ not json either");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn lookups_follow_commits_renames_and_entries_taken_back() {
        let root = tmp("lookups");
        let mut v = Vault::create(&root, "a long enough passphrase").unwrap();
        let keys = v.keys();
        let mut ids = Vec::new();
        for n in 0..5 {
            let s = keys.seal_stream(&mut &[n as u8; 10][..], 1).unwrap();
            ids.push(v.commit(s, &format!("d/{n}.jpg")).unwrap().id);
        }
        v.rename("d/1.jpg", "e/1.jpg").unwrap();
        assert!(v.entry_by_rel("d/1.jpg").is_none());
        assert_eq!(v.entry_by_rel("e/1.jpg").unwrap().id, ids[1]);
        assert_eq!(v.entries_under("d/").count(), 4);
        // The write failed (say): the last two are taken back, objects and all.
        v.uncommit(&ids[3..]);
        assert!(v.entry_by_rel("d/3.jpg").is_none() && v.entry_by_id(&ids[4]).is_none());
        assert!(!v.object_path(&ids[3]).exists());
        assert_eq!(v.entry_by_id(&ids[2]).unwrap().rel, "d/2.jpg");
        assert_eq!(v.read_all(&ids[2]).unwrap(), [2u8; 10]);
        let _ = fs::remove_dir_all(&root);
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
