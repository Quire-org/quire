//! What the local models know of each item: its embedding (the whole picture,
//! and crops of it or a video's frames), the anime tagger's words and its own
//! embedding, and the size and time of the file when it was read. Kept here in
//! the backend, in two files next to the tags (inside the vault when there is
//! one): the words and times as JSON, the vectors as bytes. The tags file the
//! frontend saves on every edit stays small, and the embeddings never travel
//! to the frontend: similarity search and learning run here.
//!
//! An index records the models that made it. When better ones are downloaded,
//! a second index is made with them beside the first, which is used until the
//! new one is complete (see `lib.rs`). Tags are never in here: remaking the
//! index can't touch them.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// The file's size and modified time when the item was indexed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Stamp {
    pub s: u64,
    pub m: u64,
}

/// On disk, the JSON half: the models, the tagger's words and the times. (Before version 3 the
/// embeddings were in here too, as base64; such a file still loads.)
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct IndexFile {
    #[serde(default)]
    pub version: u32,
    /// The picture-and-word model ("clip", "siglip2") and the tagger ("wd14", "pixai") it was made with.
    #[serde(default)]
    pub embedder: String,
    #[serde(default)]
    pub tagger: String,
    /// Version 2: key -> 512 signed bytes, base64.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub embeddings: HashMap<String, String>,
    /// Version 2: key -> what one step of those bytes is worth.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub scales: HashMap<String, f32>,
    /// key -> the tagger's (name index, probability) pairs.
    #[serde(default)]
    pub auto: HashMap<String, Vec<(u32, f32)>>,
    #[serde(default)]
    pub indexed: HashMap<String, Stamp>,
    /// The first journal not in these files (see `Change`): it and those after are replayed on load.
    #[serde(default)]
    pub journal: u64,
}

pub const VERSION: u32 = 3;

/// One change to an index, as its journal keeps it between full saves: every picture indexed is
/// appended at once (a few kilobytes), so a run cut short (the app quit, or killed by a restart)
/// loses at most the picture it was on. Replaying one twice does no harm.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Change {
    Put {
        key: String,
        stamp: Stamp,
        /// Vectors as (base64 signed bytes, scale).
        main: Option<(String, f32)>,
        parts: Vec<(String, f32)>,
        auto: Option<Vec<(u32, f32)>>,
        anime: Option<(String, f32)>,
    },
    Rename {
        from: String,
        to: String,
    },
    Restamp {
        key: String,
        stamp: Stamp,
    },
    /// A file gone for good (purged from the trash, deleted): nothing of it is kept.
    Forget {
        key: String,
    },
}
/// What the first indexes were made with (version 2 files don't say).
pub const FIRST_EMBEDDER: &str = "clip";
pub const FIRST_TAGGER: &str = "wd14";
/// The vectors file starts with this.
const MAGIC: &[u8; 4] = b"MSV3";
/// A crop this like the whole picture adds nothing: not kept.
const SAME_PART: f32 = 0.92;
/// A crop's match counts this much less than the whole picture's (cosine): a small thing in a
/// corner is found, but the whole picture wins when both match.
pub const PART_MARGIN: f32 = 0.01;

#[derive(Clone)]
pub struct Emb {
    q: Vec<i8>,
    scale: f32,
    /// 1 / length of q: a vector's direction is all a comparison needs.
    inv: f32,
}

impl Emb {
    fn quantize(v: &[f32]) -> Emb {
        let max = v.iter().fold(1e-6f32, |m, x| m.max(x.abs()));
        let scale = max / 127.0;
        let q: Vec<i8> = v.iter().map(|x| (x / scale).round().clamp(-127.0, 127.0) as i8).collect();
        Emb::new(q, scale)
    }
    fn new(q: Vec<i8>, scale: f32) -> Emb {
        let norm = q.iter().map(|&x| (x as f32) * (x as f32)).sum::<f32>().sqrt();
        Emb { q, scale, inv: if norm > 0.0 { 1.0 / norm } else { 0.0 } }
    }
    pub fn unit(&self) -> Vec<f32> {
        self.q.iter().map(|&x| x as f32 * self.inv).collect()
    }
    /// Cosine with a unit vector.
    pub fn dot(&self, u: &[f32]) -> f32 {
        self.q.iter().zip(u).map(|(&a, &b)| a as f32 * b).sum::<f32>() * self.inv
    }
    fn cos(&self, o: &Emb) -> f32 {
        self.q.iter().zip(&o.q).map(|(&a, &b)| a as f32 * b as f32).sum::<f32>() * self.inv * o.inv
    }
}

/// A vector to compare with: given, or the mean of some items (an album: its pages).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Query {
    Vector(Vec<f32>),
    Keys(Vec<String>),
}

/// The items of an album tag key ("album:…"): their mean stands for the album.
pub type Groups = HashMap<String, Vec<String>>;

pub struct Index {
    pub root: PathBuf,
    /// The journal changes go to now; and the first one not yet in a full save.
    pub journal: u64,
    pub saved_journal: u64,
    /// The models it is made with ("" while empty and not yet chosen).
    pub embedder: String,
    pub tagger: String,
    vecs: HashMap<String, Emb>,
    /// Crops of a picture, or a video's frames.
    parts: HashMap<String, Vec<Emb>>,
    /// The anime tagger's own embedding, for what it looked at.
    anime: HashMap<String, Emb>,
    pub auto: HashMap<String, Vec<(u32, f32)>>,
    pub indexed: HashMap<String, Stamp>,
    dirty: bool,
    saved: Instant,
}

fn unit(mut v: Vec<f32>) -> Option<Vec<f32>> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n <= 0.0 || !n.is_finite() {
        return None;
    }
    v.iter_mut().for_each(|x| *x /= n);
    Some(v)
}

/// Read the vectors file: `MAGIC`, then records of (key length u16, key, kind u8: 0 the picture,
/// 1 a part, 2 the tagger's, dimensions u16, scale f32, that many signed bytes), little-endian.
type Vectors = (HashMap<String, Emb>, HashMap<String, Vec<Emb>>, HashMap<String, Emb>);

fn read_vectors(bytes: &[u8]) -> Result<Vectors, String> {
    let mut out: Vectors = Default::default();
    if bytes.len() < 4 || &bytes[..4] != MAGIC {
        return Err("not a vectors file".into());
    }
    let mut at = 4;
    let mut take = |n: usize| -> Result<&[u8], String> {
        let s = bytes.get(at..at + n).ok_or("the vectors file is cut short")?;
        at += n;
        Ok(s)
    };
    while let Ok(len) = take(2) {
        let len = u16::from_le_bytes([len[0], len[1]]) as usize;
        let key = String::from_utf8(take(len)?.to_vec()).map_err(|e| e.to_string())?;
        let kind = take(1)?[0];
        let dim = take(2)?;
        let dim = u16::from_le_bytes([dim[0], dim[1]]) as usize;
        let sc = take(4)?;
        let scale = f32::from_le_bytes([sc[0], sc[1], sc[2], sc[3]]);
        let e = Emb::new(take(dim)?.iter().map(|&b| b as i8).collect(), scale);
        match kind {
            0 => {
                out.0.insert(key, e);
            }
            1 => out.1.entry(key).or_default().push(e),
            _ => {
                out.2.insert(key, e);
            }
        }
    }
    Ok(out)
}

fn write_record(out: &mut Vec<u8>, key: &str, kind: u8, e: &Emb) {
    out.extend_from_slice(&(key.len() as u16).to_le_bytes());
    out.extend_from_slice(key.as_bytes());
    out.push(kind);
    out.extend_from_slice(&(e.q.len() as u16).to_le_bytes());
    out.extend_from_slice(&e.scale.to_le_bytes());
    out.extend(e.q.iter().map(|&x| x as u8));
}

impl Index {
    /// An index from its files (`vectors`: the bytes file, which version 2 didn't have).
    pub fn from_files(root: &Path, f: IndexFile, vectors: Option<&[u8]>) -> Index {
        let b64 = base64::engine::general_purpose::STANDARD;
        let (mut vecs, parts, anime) = vectors.and_then(|b| read_vectors(b).ok()).unwrap_or_default();
        for (k, s) in f.embeddings {
            let Ok(bytes) = b64.decode(s) else { continue };
            let scale = f.scales.get(&k).copied().unwrap_or(1.0);
            vecs.entry(k).or_insert_with(|| Emb::new(bytes.into_iter().map(|b| b as i8).collect(), scale));
        }
        let known = !vecs.is_empty() || !f.auto.is_empty() || !f.indexed.is_empty();
        let (embedder, tagger) = match (f.embedder.is_empty(), known) {
            (false, _) => (f.embedder, f.tagger),
            (true, true) => (FIRST_EMBEDDER.into(), FIRST_TAGGER.into()),
            (true, false) => (String::new(), String::new()),
        };
        Index { root: root.to_path_buf(), journal: f.journal, saved_journal: f.journal, embedder, tagger, vecs, parts, anime, auto: f.auto, indexed: f.indexed, dirty: false, saved: Instant::now() }
    }

    pub fn from_file(root: &Path, f: IndexFile) -> Index {
        Index::from_files(root, f, None)
    }

    /// An empty index for these models.
    pub fn new(root: &Path, embedder: &str, tagger: &str) -> Index {
        let mut ix = Index::from_file(root, IndexFile::default());
        ix.embedder = embedder.into();
        ix.tagger = tagger.into();
        ix.dirty = true;
        ix
    }

    /// Its two files: the JSON half and the vectors.
    pub fn to_files(&self) -> (IndexFile, Vec<u8>) {
        let mut bytes = MAGIC.to_vec();
        for (k, e) in &self.vecs {
            write_record(&mut bytes, k, 0, e);
        }
        for (k, ps) in &self.parts {
            for e in ps {
                write_record(&mut bytes, k, 1, e);
            }
        }
        for (k, e) in &self.anime {
            write_record(&mut bytes, k, 2, e);
        }
        let file = IndexFile { version: VERSION, embedder: self.embedder.clone(), tagger: self.tagger.clone(), auto: self.auto.clone(), indexed: self.indexed.clone(), journal: self.journal, ..Default::default() };
        (file, bytes)
    }

    pub fn len(&self) -> usize {
        self.vecs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.vecs.is_empty() && self.auto.is_empty() && self.indexed.is_empty()
    }

    /// About how many bytes its vectors take: a long run saves less often as this grows.
    pub fn weight(&self) -> usize {
        let one = |e: &Emb| e.q.len() + 32;
        self.vecs.values().map(one).sum::<usize>() + self.parts.values().flatten().map(one).sum::<usize>() + self.anime.values().map(one).sum::<usize>()
    }

    /// One item's results from the models. `tags`: what the tagger saw, empty when it didn't look (a
    /// photo); None leaves the tagger's words as they were (a run that only embeds).
    pub fn put(&mut self, key: &str, embedding: Option<&[f32]>, parts: &[Vec<f32>], tags: Option<&[(usize, f32)]>, anime: Option<&[f32]>, stamp: Stamp) {
        if let Some(v) = embedding {
            let main = Emb::quantize(v);
            // Crops much like the whole picture add nothing.
            let kept: Vec<Emb> = parts.iter().map(|p| Emb::quantize(p)).filter(|p| p.cos(&main) < SAME_PART).collect();
            if kept.is_empty() {
                self.parts.remove(key);
            } else {
                self.parts.insert(key.to_string(), kept);
            }
            self.vecs.insert(key.to_string(), main);
        }
        if let Some(tags) = tags {
            self.auto.insert(key.to_string(), tags.iter().map(|&(i, p)| (i as u32, (p * 1000.0).round() / 1000.0)).collect());
            match anime {
                Some(a) => self.anime.insert(key.to_string(), Emb::quantize(a)),
                None => self.anime.remove(key),
            };
        }
        self.indexed.insert(key.to_string(), stamp);
        self.dirty = true;
    }

    /// What `put` did to a key, for the journal.
    pub fn put_change(&self, key: &str) -> Option<Change> {
        let b64 = base64::engine::general_purpose::STANDARD;
        let enc = |e: &Emb| (b64.encode(e.q.iter().map(|&x| x as u8).collect::<Vec<u8>>()), e.scale);
        Some(Change::Put {
            key: key.to_string(),
            stamp: *self.indexed.get(key)?,
            main: self.vecs.get(key).map(enc),
            parts: self.parts.get(key).map(|ps| ps.iter().map(enc).collect()).unwrap_or_default(),
            auto: self.auto.get(key).cloned(),
            anime: self.anime.get(key).map(enc),
        })
    }

    /// A change from the journal, made again.
    pub fn apply(&mut self, change: Change) {
        let b64 = base64::engine::general_purpose::STANDARD;
        let dec = |(s, scale): (String, f32)| b64.decode(s).ok().map(|bytes| Emb::new(bytes.into_iter().map(|b| b as i8).collect(), scale));
        match change {
            Change::Put { key, stamp, main, parts, auto, anime } => {
                match main.and_then(dec) {
                    Some(e) => self.vecs.insert(key.clone(), e),
                    None => self.vecs.remove(&key),
                };
                let parts: Vec<Emb> = parts.into_iter().filter_map(dec).collect();
                if parts.is_empty() {
                    self.parts.remove(&key);
                } else {
                    self.parts.insert(key.clone(), parts);
                }
                match auto {
                    Some(a) => self.auto.insert(key.clone(), a),
                    None => self.auto.remove(&key),
                };
                match anime.and_then(dec) {
                    Some(e) => self.anime.insert(key.clone(), e),
                    None => self.anime.remove(&key),
                };
                self.indexed.insert(key, stamp);
            }
            Change::Rename { from, to } => self.rename(&from, &to),
            Change::Restamp { key, stamp } => self.restamp(&key, stamp),
            Change::Forget { key } => self.forget(&key),
        }
        self.dirty = true;
    }

    /// A file's size and time as they are now, when only those changed (its sidecars were tidied
    /// away, or another drive rounded its time): what was indexed of it still holds.
    pub fn restamp(&mut self, key: &str, stamp: Stamp) {
        if let Some(e) = self.indexed.get_mut(key)
            && *e != stamp
        {
            *e = stamp;
            self.dirty = true;
        }
    }

    /// A file gone for good: what the models made of it goes too (its vectors are of the picture).
    pub fn forget(&mut self, key: &str) {
        let gone = [self.vecs.remove(key).is_some(), self.parts.remove(key).is_some(), self.anime.remove(key).is_some(), self.auto.remove(key).is_some(), self.indexed.remove(key).is_some()];
        if gone.iter().any(|&g| g) {
            self.dirty = true;
        }
    }

    /// Files that moved: what is known of them goes along.
    pub fn rename(&mut self, from: &str, to: &str) {
        if from == to {
            return;
        }
        fn mv<T>(m: &mut HashMap<String, T>, from: &str, to: &str) -> bool {
            match m.remove(from) {
                Some(v) => {
                    m.insert(to.to_string(), v);
                    true
                }
                None => false,
            }
        }
        let moved = [mv(&mut self.vecs, from, to), mv(&mut self.parts, from, to), mv(&mut self.anime, from, to), mv(&mut self.auto, from, to), mv(&mut self.indexed, from, to)];
        if moved.iter().any(|&m| m) {
            self.dirty = true;
        }
    }

    /// Whether a save is due: changed, and not saved for a while (a long indexing run saves
    /// now and then, not after every picture).
    pub fn due(&self, after: std::time::Duration) -> bool {
        self.dirty && self.saved.elapsed() >= after
    }

    pub fn dirty(&self) -> bool {
        self.dirty
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn mark_saved(&mut self) {
        self.dirty = false;
        self.saved = Instant::now();
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.vecs.keys()
    }

    pub fn has(&self, key: &str) -> bool {
        self.vecs.contains_key(key)
    }

    /// The unit vector for a key: its own, or the mean of its group's.
    pub fn vector(&self, key: &str, groups: &Groups) -> Option<Vec<f32>> {
        match groups.get(key) {
            Some(pages) => self.mean(pages),
            None => self.vecs.get(key).map(Emb::unit),
        }
    }

    /// The tagger's embedding for a key (an album: its pages' mean), when the tagger looked.
    pub fn anime_vector(&self, key: &str, groups: &Groups) -> Option<Vec<f32>> {
        match groups.get(key) {
            Some(pages) => {
                let mut sum: Option<Vec<f32>> = None;
                for e in pages.iter().filter_map(|k| self.anime.get(k)) {
                    let s = sum.get_or_insert_with(|| vec![0.0; e.q.len()]);
                    s.iter_mut().zip(&e.q).for_each(|(a, &x)| *a += x as f32 * e.inv);
                }
                unit(sum?)
            }
            None => self.anime.get(key).map(Emb::unit),
        }
    }

    /// How long the tagger's embeddings are (0 when it made none: an older tagger, or no drawn pictures).
    pub fn anime_dim(&self) -> usize {
        self.anime.values().next().map_or(0, |e| e.q.len())
    }

    /// A key's crops or frames, as unit vectors (none for an album).
    pub fn parts_of(&self, key: &str) -> Vec<Vec<f32>> {
        self.parts.get(key).map(|ps| ps.iter().map(Emb::unit).collect()).unwrap_or_default()
    }

    /// The mean direction of some items, as a unit vector.
    pub fn mean(&self, keys: &[String]) -> Option<Vec<f32>> {
        let mut sum: Option<Vec<f32>> = None;
        for k in keys {
            let Some(e) = self.vecs.get(k) else { continue };
            let s = sum.get_or_insert_with(|| vec![0.0; e.q.len()]);
            for (acc, &x) in s.iter_mut().zip(&e.q) {
                *acc += x as f32 * e.inv;
            }
        }
        unit(sum?)
    }

    fn query(&self, q: &Query, groups: &Groups) -> Option<Vec<f32>> {
        match q {
            Query::Vector(v) => unit(v.clone()),
            Query::Keys(keys) if keys.len() == 1 => self.vector(&keys[0], groups),
            Query::Keys(keys) => {
                // Album keys among them count by their pages.
                let vs: Vec<Vec<f32>> = keys.iter().filter_map(|k| self.vector(k, groups)).collect();
                let first = vs.first()?;
                let mut sum = vec![0.0; first.len()];
                for v in &vs {
                    for (a, b) in sum.iter_mut().zip(v) {
                        *a += b;
                    }
                }
                unit(sum)
            }
        }
    }

    /// How like a unit vector an item is: the whole picture, or one of its crops or frames
    /// (`PART_MARGIN` less), whichever is more.
    fn best(&self, key: &str, e: &Emb, q: &[f32]) -> f32 {
        let whole = e.dot(q);
        self.parts.get(key).map_or(whole, |ps| ps.iter().map(|p| p.dot(q) - PART_MARGIN).fold(whole, f32::max))
    }

    /// How like a vector (say, words) a key is: an album by its pages, an item by its whole picture or
    /// one of its crops or frames.
    pub fn likeness(&self, key: &str, groups: &Groups, v: &[f32]) -> Option<f32> {
        let u = unit(v.to_vec())?;
        match groups.get(key) {
            Some(_) => Some(self.vector(key, groups)?.iter().zip(&u).map(|(a, b)| a * b).sum()),
            None => Some(self.best(key, self.vecs.get(key)?, &u)),
        }
    }

    /// The items most like any of the queries (each scored by its best one), at least `min`,
    /// best first. Candidates: the given keys (albums by their pages), else every indexed item.
    /// `parts`: an item's crops and frames count too (for words: something small in it is found).
    #[allow(clippy::too_many_arguments)]
    pub fn rank(&self, queries: &[Query], candidates: Option<&[String]>, groups: &Groups, skip: &HashSet<String>, min: f32, limit: usize, parts: bool) -> Vec<(String, f32)> {
        let qs: Vec<Vec<f32>> = queries.iter().filter_map(|q| self.query(q, groups)).collect();
        if qs.is_empty() {
            return Vec::new();
        }
        let best_direct = |k: &str, e: &Emb| qs.iter().map(|q| if parts { self.best(k, e, q) } else { e.dot(q) }).fold(f32::MIN, f32::max);
        let best_vec = |v: &[f32]| qs.iter().map(|q| v.iter().zip(q).map(|(a, b)| a * b).sum::<f32>()).fold(f32::MIN, f32::max);
        let mut out: Vec<(String, f32)> = match candidates {
            None => self.vecs.iter().filter(|(k, _)| !skip.contains(*k)).map(|(k, e)| (k.clone(), best_direct(k, e))).filter(|(_, s)| *s >= min).collect(),
            Some(keys) => keys
                .iter()
                .filter(|k| !skip.contains(*k))
                .filter_map(|k| {
                    let s = match groups.get(k) {
                        Some(_) => best_vec(&self.vector(k, groups)?),
                        None => best_direct(k, self.vecs.get(k)?),
                    };
                    (s >= min).then(|| (k.clone(), s))
                })
                .collect(),
        };
        out.sort_by(|a, b| b.1.total_cmp(&a.1));
        out.truncate(limit);
        out
    }

    /// For each key, its cosine with each of `vectors` (None: not indexed).
    pub fn scores(&self, keys: &[String], vectors: &[Vec<f32>], groups: &Groups) -> Vec<Option<Vec<f32>>> {
        let us: Vec<Vec<f32>> = vectors.iter().map(|v| unit(v.clone()).unwrap_or_else(|| v.clone())).collect();
        keys.iter().map(|k| self.vector(k, groups).map(|v| us.iter().map(|u| v.iter().zip(u).map(|(a, b)| a * b).sum()).collect())).collect()
    }
}

/// Take the model maps out of an old tags file (they used to live there). None: nothing to move.
pub fn split_old(tags: &mut serde_json::Value) -> Option<IndexFile> {
    let obj = tags.as_object_mut()?;
    let mut moved = serde_json::Map::new();
    for k in ["embeddings", "scales", "auto", "indexed"] {
        if let Some(v) = obj.remove(k) {
            moved.insert(k.to_string(), v);
        }
    }
    if moved.is_empty() {
        return None;
    }
    let f: IndexFile = serde_json::from_value(serde_json::Value::Object(moved)).unwrap_or_default();
    // Version 2's shape (the embeddings as base64): read as such, written as version 3 on the next save.
    Some(IndexFile { version: 2, ..f })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ix() -> Index {
        Index::from_file(Path::new("/r"), IndexFile::default())
    }
    const S: Stamp = Stamp { s: 1, m: 2 };

    fn put(i: &mut Index, k: &str, v: &[f32]) {
        i.put(k, Some(v), &[], None, None, S);
    }

    fn back(i: &Index) -> Index {
        let (f, bytes) = i.to_files();
        Index::from_files(Path::new("/r"), serde_json::from_str(&serde_json::to_string(&f).unwrap()).unwrap(), Some(&bytes))
    }

    #[test]
    fn finds_the_nearest_and_scores_albums_by_their_pages() {
        let mut i = ix();
        put(&mut i, "a", &[1.0, 0.0, 0.0]);
        put(&mut i, "b", &[0.9, 0.1, 0.0]);
        put(&mut i, "c", &[0.0, 0.0, 1.0]);
        let none = HashSet::new();
        let groups = Groups::new();
        let hits = i.rank(&[Query::Keys(vec!["a".into()])], None, &groups, &HashSet::from(["a".to_string()]), 0.5, 10, false);
        assert_eq!(hits.iter().map(|h| h.0.as_str()).collect::<Vec<_>>(), ["b"]);
        // An album of a and c sits between them.
        let groups = Groups::from([("album:X".to_string(), vec!["a".to_string(), "c".to_string()])]);
        let s = i.rank(&[Query::Vector(vec![0.0, 0.0, 1.0])], Some(&["album:X".to_string(), "b".to_string()]), &groups, &none, -1.0, 10, false);
        assert_eq!(s[0].0, "album:X");
        assert!((s[0].1 - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.02);
    }

    #[test]
    fn keeps_what_it_knows_through_its_files_and_a_move() {
        let mut i = Index::new(Path::new("/r"), "siglip2", "pixai");
        i.put("a", Some(&[0.3, -0.4, 0.5]), &[vec![0.0, 1.0, 0.0], vec![0.31, -0.4, 0.5]], Some(&[(7, 0.12345)]), Some(&[0.6, 0.8]), S);
        i.rename("a", "b");
        let back = back(&i);
        assert_eq!((back.embedder.as_str(), back.tagger.as_str()), ("siglip2", "pixai"));
        assert_eq!(back.auto["b"], vec![(7, 0.123)]);
        assert_eq!(back.indexed["b"], S);
        let s = back.scores(&["b".into(), "a".into()], &[vec![0.3, -0.4, 0.5]], &Groups::new());
        assert!((s[0].as_ref().unwrap()[0] - 1.0).abs() < 0.01);
        assert!(s[1].is_none());
        // The crop like the whole picture wasn't kept; the other was, and the tagger's vector.
        assert_eq!(back.parts_of("b").len(), 1);
        assert!((back.parts_of("b")[0][1] - 1.0).abs() < 0.01);
        assert!((back.anime_vector("b", &Groups::new()).unwrap()[1] - 0.8).abs() < 0.01);
        assert_eq!(back.anime_dim(), 2);
    }

    #[test]
    fn finds_something_small_by_a_crop_but_prefers_the_whole_picture() {
        let mut i = ix();
        // "a": the whole picture is something else, a crop shows the thing. "b": the whole of it is the thing.
        i.put("a", Some(&[0.0, 1.0, 0.0]), &[vec![1.0, 0.0, 0.0]], None, None, S);
        put(&mut i, "b", &[1.0, 0.0, 0.0]);
        let q = [Query::Vector(vec![1.0, 0.0, 0.0])];
        let found = i.rank(&q, None, &Groups::new(), &HashSet::new(), 0.5, 10, true);
        assert_eq!(found.iter().map(|h| h.0.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(i.rank(&q, None, &Groups::new(), &HashSet::new(), 0.5, 10, false).len(), 1);
    }

    #[test]
    fn a_photo_the_tagger_skipped_loses_old_words_and_a_run_that_only_embeds_keeps_them() {
        let mut i = ix();
        i.put("a", Some(&[1.0, 0.0]), &[], Some(&[(3, 0.9)]), Some(&[1.0, 0.0]), S);
        i.put("a", Some(&[1.0, 0.0]), &[], None, None, S);
        assert_eq!(i.auto["a"], vec![(3, 0.9)]);
        i.put("a", Some(&[1.0, 0.0]), &[], Some(&[]), None, S);
        assert!(i.auto["a"].is_empty());
        assert_eq!(i.anime_dim(), 0);
    }

    #[test]
    fn a_journal_made_again_gives_the_same_index() {
        let mut i = Index::new(Path::new("/r"), "siglip2", "pixai");
        let mut journal = vec![];
        i.put("a", Some(&[0.3, -0.4, 0.5]), &[vec![0.0, 1.0, 0.0]], Some(&[(7, 0.9)]), Some(&[0.6, 0.8]), S);
        journal.push(i.put_change("a").unwrap());
        i.put("b", Some(&[1.0, 0.0, 0.0]), &[], Some(&[]), None, S);
        journal.push(i.put_change("b").unwrap());
        i.rename("a", "c");
        journal.push(Change::Rename { from: "a".into(), to: "c".into() });
        i.restamp("b", Stamp { s: 9, m: 9 });
        journal.push(Change::Restamp { key: "b".into(), stamp: Stamp { s: 9, m: 9 } });
        // A third, then gone for good: nothing of it is left, after a replay too.
        i.put("d", Some(&[0.0, 1.0, 0.0]), &[], Some(&[(2, 0.5)]), None, S);
        journal.push(i.put_change("d").unwrap());
        i.forget("d");
        journal.push(Change::Forget { key: "d".into() });
        assert!(!i.has("d") && !i.indexed.contains_key("d") && !i.auto.contains_key("d"));
        // From nothing, through JSON (as the journal keeps them), and twice over: the same.
        let mut again = Index::new(Path::new("/r"), "siglip2", "pixai");
        for c in journal.iter().chain(journal.iter()) {
            again.apply(serde_json::from_str(&serde_json::to_string(c).unwrap()).unwrap());
        }
        let (a, b) = (i.to_files(), again.to_files());
        assert_eq!(serde_json::to_value(&a.0.auto).unwrap(), serde_json::to_value(&b.0.auto).unwrap());
        assert_eq!(a.0.indexed, b.0.indexed);
        assert_eq!(a.1.len(), b.1.len());
        assert_eq!(again.parts_of("c").len(), 1);
        assert!(again.anime_vector("c", &Groups::new()).is_some() && !again.has("a"));
        assert!(!again.has("d") && !again.indexed.contains_key("d"));
    }

    #[test]
    fn reads_an_index_from_before_the_vectors_file_as_made_with_the_first_models() {
        let f: IndexFile = serde_json::from_value(serde_json::json!({ "version": 2, "embeddings": { "a": "AQID" }, "scales": { "a": 0.5 }, "auto": { "a": [[3, 0.5]] }, "indexed": { "a": { "s": 1, "m": 2 } } })).unwrap();
        let i = Index::from_file(Path::new("/r"), f);
        assert_eq!((i.embedder.as_str(), i.tagger.as_str()), ("clip", "wd14"));
        assert!(i.has("a"));
        let again = back(&i);
        assert!(again.has("a") && again.indexed.contains_key("a"));
        assert_eq!(again.to_files().0.version, VERSION);
        // An empty one has no models until it is made.
        assert_eq!(ix().embedder, "");
    }

    #[test]
    fn moves_the_model_maps_out_of_an_old_tags_file() {
        let mut old = serde_json::json!({ "version": 1, "tags": { "a": ["x/y"] }, "embeddings": { "a": "AQID" }, "scales": { "a": 0.5 }, "auto": { "a": [[3, 0.5]] }, "indexed": { "a": { "s": 1, "m": 2 } } });
        let f = split_old(&mut old).unwrap();
        assert_eq!(f.embeddings["a"], "AQID");
        assert_eq!(f.auto["a"], vec![(3, 0.5)]);
        assert_eq!(old, serde_json::json!({ "version": 1, "tags": { "a": ["x/y"] } }));
        assert!(split_old(&mut old).is_none());
    }
}
