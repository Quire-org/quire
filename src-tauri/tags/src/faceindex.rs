//! The faces the engine's face finder saw in the library's pictures, kept with the library: where
//! each is, how sure it was, and its numbers, 8-bit with a scale (unit length: compared by dot
//! product). Which pictures were looked at, by size and time, so a scan carries on where it was.
//! Also the two things done with many faces at once, a dot product per pair: matching faces no one
//! has named to the people named already, and grouping the rest, for "Who is this?".

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::tagindex::Stamp;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Debug, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A real person's face, in a photo (AuraFace's numbers).
    Photo,
    /// A character's, in a drawing (CCIP's numbers).
    Drawn,
}

impl Kind {
    /// The same person or character: at least this close (measured on public portraits: different
    /// people never came closer than 0.21, the same rarely less than 0.28; and on deepghs' public
    /// character test sets, 143 characters, for CCIP b36 on the head and upper body).
    pub fn same(self) -> f32 {
        match self {
            Kind::Photo => 0.30,
            Kind::Drawn => 0.57,
        }
    }
    /// A face this close to one of a person's own is suggested as theirs (characters: with a second
    /// of theirs at `same`, 99% of suggestions were right on those sets and 93% of the faces found).
    pub fn joins(self) -> f32 {
        match self {
            Kind::Photo => 0.40,
            Kind::Drawn => 0.64,
        }
    }
    fn code(self) -> u8 {
        match self {
            Kind::Photo => 0,
            Kind::Drawn => 1,
        }
    }
    fn from_code(c: u8) -> Option<Kind> {
        match c {
            0 => Some(Kind::Photo),
            1 => Some(Kind::Drawn),
            _ => None,
        }
    }
}

pub struct Face {
    pub id: u64,
    pub key: String,
    pub kind: Kind,
    /// In fractions of the upright picture: left, top, right, bottom.
    pub bbox: [f32; 4],
    pub score: f32,
    /// Width in pixels where it was looked at.
    pub size: u32,
    q: Vec<i8>,
    scale: f32,
    /// Marked by the reader: the part of the picture they drew around it, looked in again whenever
    /// the picture is looked at again (the whole picture's look may not see it).
    pub marked: Option<[f32; 4]>,
    /// In a video: the second of the frame it was seen in.
    pub at: Option<f32>,
}

/// The same moment of a video (or both in a picture).
fn same_moment(a: Option<f32>, b: Option<f32>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => (x - y).abs() <= 0.75,
        _ => false,
    }
}

impl Face {
    fn dot(&self, other: &Face) -> f32 {
        dot_i8(&self.q, &other.q) as f32 * self.scale * other.scale
    }
    /// Good enough to stand for its person in a group: big enough and sure enough.
    fn good(&self) -> bool {
        self.size >= 48 && self.score >= if self.kind == Kind::Photo { 0.6 } else { 0.45 }
    }
}

fn dot_i8(a: &[i8], b: &[i8]) -> i32 {
    a.iter().zip(b).map(|(&x, &y)| i32::from(x) * i32::from(y)).sum()
}

fn quantize(v: &[f32]) -> (Vec<i8>, f32) {
    let max = v.iter().fold(1e-6f32, |m, x| m.max(x.abs()));
    let scale = max / 127.0;
    (v.iter().map(|x| (x / scale).round().clamp(-127.0, 127.0) as i8).collect(), scale)
}

/// What the app shows of a face (not its numbers).
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FaceView {
    pub id: u64,
    pub key: String,
    pub kind: Kind,
    pub bbox: [f32; 4],
    pub score: f32,
    pub size: u32,
    /// Found where the reader marked it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub marked: bool,
    /// In a video: the second it was seen at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<f32>,
}

/// A face found by the engine, to keep (`marked`: in the part of the picture the reader marked).
pub struct Found {
    pub kind: Kind,
    pub bbox: [f32; 4],
    pub score: f32,
    pub size: u32,
    pub embedding: Vec<f32>,
    pub marked: Option<[f32; 4]>,
    /// In a video: the second of the frame it was seen in.
    pub at: Option<f32>,
}

/// Which character model drawn faces' numbers come from: 1 was CCIP caformer-24 on the face, 2 is
/// CCIP caformer_b36-24 on the head and upper body. Numbers of two models don't compare.
const DRAWN_MODEL: u64 = 2;

#[derive(Default)]
pub struct FaceIndex {
    pub faces: Vec<Face>,
    /// Every picture looked at (with faces or without), by key: as it was then.
    pub scanned: HashMap<String, Stamp>,
    pub next_id: u64,
    /// Pictures whose drawn faces still have an older character model's numbers: looked at again,
    /// and those faces left out of matching until then (each keeps its id, and so who it is).
    pub redo: HashSet<String>,
    /// Pictures looked at without the character finder (it is optional): looked at again once it is
    /// there, for the drawn faces in them (the faces found already keep their ids).
    pub no_characters: HashSet<String>,
}

/// Who is who, as the app's People keeps it: each face given to a person (by the user, or found
/// close enough by itself), each face that isn't a face or isn't wanted, and the people each face
/// is not.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Labels {
    /// `[face, person, checked by the user]`: a checked face is always theirs and stands for them; an
    /// unchecked one (from a tag, or a group named whole) stands for them only if it's like the rest.
    #[serde(default)]
    pub assigned: Vec<(u64, String, bool)>,
    #[serde(default)]
    pub no: Vec<u64>,
    /// `[face, person it isn't]`.
    #[serde(default)]
    pub not: Vec<(u64, String)>,
    /// `[face, people]`: characters the anime tagger names in the face's picture. A face as close to
    /// one of theirs as `same` goes with them: the tagger agreeing makes up the rest of `joins`.
    #[serde(default)]
    pub named: Vec<(u64, Vec<String>)>,
    /// `[face, people]`: the tagger surely names someone else in its picture, so not these.
    #[serde(default)]
    pub ruled_out: Vec<(u64, Vec<String>)>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Match {
    pub face: u64,
    pub person: String,
    pub score: f32,
}

#[derive(Serialize, Debug)]
pub struct Group {
    pub kind: Kind,
    /// Best first (biggest and surest).
    pub faces: Vec<u64>,
    /// How close each face is to the group as a whole (its dot product with the group's middle), in
    /// the order of `faces`: the ones least like the rest are the ones to check.
    pub scores: Vec<f32>,
}

#[derive(Serialize, Debug, Default)]
pub struct Sorted {
    /// Faces no one has named that are close enough to a person to go with them.
    pub matches: Vec<Match>,
    /// Faces given a person, not checked, that are like none of their others (the score: how close
    /// the closest of them is): perhaps someone else, so they don't stand for them until checked.
    pub doubts: Vec<Match>,
    /// The rest, in groups of two or more alike, biggest group first.
    pub groups: Vec<Group>,
}

/// At most this many of a person's faces stand for them when matching (their biggest, the user's own first).
const EXEMPLARS: usize = 32;
/// A person's faces checked against this many of theirs (the user's own first, then the biggest)
/// to find the ones like none of the others.
const REFERENCE: usize = 64;
/// At most this many faces of each kind are grouped at once (the best of them): the rest wait for the next look.
const GROUPED: usize = 4000;

impl FaceIndex {
    /// A picture looked at: its faces, in place of any it had.
    pub fn put(&mut self, key: &str, stamp: Stamp, found: Vec<Found>) {
        // A face found again where it was keeps its id, and so who it was said to be.
        let mut before: Vec<(u64, Kind, [f32; 4], Option<f32>)> = self.faces.iter().filter(|f| f.key == key).map(|f| (f.id, f.kind, f.bbox, f.at)).collect();
        self.faces.retain(|f| f.key != key);
        for f in found {
            let (q, scale) = quantize(&f.embedding);
            let again = before.iter().position(|(_, kind, bbox, at)| *kind == f.kind && overlap(bbox, &f.bbox) >= 0.5 && same_moment(*at, f.at));
            let id = match again {
                Some(i) => before.swap_remove(i).0,
                None => {
                    self.next_id += 1;
                    self.next_id
                }
            };
            self.faces.push(Face { id, key: key.to_string(), kind: f.kind, bbox: f.bbox, score: f.score, size: f.size, q, scale, marked: f.marked, at: f.at });
        }
        self.scanned.insert(key.to_string(), stamp);
        self.redo.remove(key);
        self.no_characters.remove(key);
    }

    /// The picture just looked at (`put`) was looked at without the character finder.
    pub fn without_characters(&mut self, key: &str) {
        self.no_characters.insert(key.to_string());
    }

    /// Faces the reader marked in a picture, beside those it has: one where a face is already (the
    /// same kind, mostly overlapping) takes its place and id. Their ids.
    pub fn add(&mut self, key: &str, found: Vec<Found>) -> Vec<u64> {
        let mut ids = Vec::new();
        for f in found {
            let (q, scale) = quantize(&f.embedding);
            let there = self.faces.iter().position(|x| x.key == key && x.kind == f.kind && overlap(&x.bbox, &f.bbox) >= 0.5);
            let id = match there {
                Some(i) => self.faces.swap_remove(i).id,
                None => {
                    self.next_id += 1;
                    self.next_id
                }
            };
            self.faces.push(Face { id, key: key.to_string(), kind: f.kind, bbox: f.bbox, score: f.score, size: f.size, q, scale, marked: f.marked, at: f.at });
            ids.push(id);
        }
        ids
    }

    /// The parts of a picture the reader marked faces in, to look in again with the picture.
    pub fn marked_in(&self, key: &str) -> Vec<(Kind, [f32; 4])> {
        self.faces.iter().filter(|f| f.key == key).filter_map(|f| f.marked.map(|m| (f.kind, m))).collect()
    }

    pub fn views(&self) -> Vec<FaceView> {
        self.faces.iter().map(|f| FaceView { id: f.id, key: f.key.clone(), kind: f.kind, bbox: f.bbox, score: f.score, size: f.size, marked: f.marked.is_some(), at: f.at }).collect()
    }

    /// Pictures moved: a pair is a file, or a folder and everything under it.
    pub fn rename(&mut self, pairs: &[(String, String)]) -> bool {
        let moved = |k: &str| -> Option<String> {
            pairs.iter().find_map(|(from, to)| if k == from { Some(to.clone()) } else { k.strip_prefix(&format!("{from}/")).map(|rest| format!("{to}/{rest}")) })
        };
        let mut changed = false;
        for f in &mut self.faces {
            if let Some(to) = moved(&f.key) {
                f.key = to;
                changed = true;
            }
        }
        let keys: Vec<String> = self.scanned.keys().filter(|k| moved(k).is_some()).cloned().collect();
        for k in keys {
            if let (Some(stamp), Some(to)) = (self.scanned.remove(&k), moved(&k)) {
                self.scanned.insert(to, stamp);
                changed = true;
            }
        }
        for set in [&mut self.redo, &mut self.no_characters] {
            let waiting: Vec<String> = set.iter().filter(|k| moved(k).is_some()).cloned().collect();
            for k in waiting {
                set.remove(&k);
                set.extend(moved(&k));
                changed = true;
            }
        }
        changed
    }

    /// Pictures gone for good (the trash emptied, under `prefix`), or no longer in the library.
    pub fn forget(&mut self, gone: impl Fn(&str) -> bool) -> bool {
        let (faces, scanned) = (self.faces.len(), self.scanned.len());
        self.faces.retain(|f| !gone(&f.key));
        self.scanned.retain(|k, _| !gone(k));
        self.redo.retain(|k| !gone(k));
        self.no_characters.retain(|k| !gone(k));
        faces != self.faces.len() || scanned != self.scanned.len()
    }

    /// Faces close to a person named already, and the rest in groups alike. Drawn faces waiting to be
    /// looked at again with the newer model are left out: their numbers don't compare.
    pub fn sort(&self, labels: &Labels) -> Sorted {
        let current = |f: &&Face| !(f.kind == Kind::Drawn && self.redo.contains(&f.key));
        let by_id: HashMap<u64, &Face> = self.faces.iter().filter(current).map(|f| (f.id, f)).collect();
        let assigned: HashSet<u64> = labels.assigned.iter().map(|(f, _, _)| *f).collect();
        let no: HashSet<u64> = labels.no.iter().copied().collect();
        let mut not: HashMap<u64, HashSet<&str>> = HashMap::new();
        for (f, p) in &labels.not {
            not.entry(*f).or_default().insert(p.as_str());
        }
        // Each person's faces: the user's own first, then the biggest.
        let mut people: HashMap<&str, Vec<(&Face, bool)>> = HashMap::new();
        for (f, p, said) in &labels.assigned {
            if let Some(face) = by_id.get(f) {
                people.entry(p.as_str()).or_default().push((face, *said));
            }
        }
        let mut out = Sorted::default();
        // The faces that stand for each person. One not checked that is like none of their others
        // (a tagged picture's only face being someone else's, say) doesn't: it would bring in more
        // like it. It is a doubt, to check.
        let exemplars: Vec<(&str, Vec<&Face>)> = people
            .into_iter()
            .map(|(p, mut faces)| {
                faces.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.size.cmp(&a.0.size)));
                let reference: Vec<&Face> = faces.iter().take(REFERENCE).map(|(f, _)| *f).collect();
                let mut stand = Vec::new();
                for (f, said) in faces {
                    let closest = reference.iter().filter(|r| r.id != f.id && r.kind == f.kind).map(|r| r.dot(f)).fold(None, |m: Option<(f32, usize)>, s| Some(m.map_or((s, 1), |(b, n)| (b.max(s), n + 1))));
                    match closest {
                        Some((best, n)) if !said && n >= 2 && best < f.kind.same() => out.doubts.push(Match { face: f.id, person: p.to_string(), score: best }),
                        _ => stand.push(f),
                    }
                }
                (p, stand.into_iter().take(EXEMPLARS).collect())
            })
            .collect();
        // The faces the user said aren't each person (the biggest, so many): a face more like one of
        // those than like any of theirs isn't theirs either (a sister's other pictures, once one is
        // turned down).
        let mut rejected: HashMap<&str, Vec<&Face>> = HashMap::new();
        for (f, p) in &labels.not {
            if let Some(face) = by_id.get(f) {
                rejected.entry(p.as_str()).or_default().push(face);
            }
        }
        for faces in rejected.values_mut() {
            faces.sort_by_key(|f| std::cmp::Reverse(f.size));
            faces.truncate(REFERENCE);
        }
        let named: HashMap<u64, HashSet<&str>> = labels.named.iter().map(|(f, ps)| (*f, ps.iter().map(String::as_str).collect())).collect();
        for (f, ps) in &labels.ruled_out {
            not.entry(*f).or_default().extend(ps.iter().map(String::as_str));
        }
        let open: Vec<&Face> = self.faces.iter().filter(current).filter(|f| !assigned.contains(&f.id) && !no.contains(&f.id)).collect();
        // Close to one of the person's faces, and a second one agreeing that it's them (where they
        // have two): one face alone, perhaps a wrong one, doesn't bring others in. And not as close to
        // a face said not to be them. Close enough: `joins`, or `same` when the tagger names them in
        // the picture too.
        let best_of = |f: &&Face| {
            exemplars
                .iter()
                .filter(|(p, _)| !not.get(&f.id).is_some_and(|n| n.contains(p)))
                .filter_map(|(p, ex)| {
                    let (mut first, mut second) = (f32::MIN, f32::MIN);
                    for s in ex.iter().filter(|e| e.kind == f.kind).map(|e| e.dot(f)) {
                        if s > first {
                            (first, second) = (s, first);
                        } else if s > second {
                            second = s;
                        }
                    }
                    let unlike = rejected.get(p).is_none_or(|r| r.iter().filter(|e| e.kind == f.kind).all(|e| e.dot(f) < first));
                    let enough = if named.get(&f.id).is_some_and(|n| n.contains(p)) { f.kind.same() } else { f.kind.joins() };
                    (first >= enough && (second == f32::MIN || second >= f.kind.same()) && unlike).then_some((*p, first))
                })
                .max_by(|a, b| a.1.total_cmp(&b.1))
        };
        // Every open face against everyone's faces is most of the work: shared out over the cores, in
        // order.
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
        let best: Vec<Option<(&str, f32)>> = std::thread::scope(|s| {
            let parts: Vec<_> = open.chunks(open.len().div_ceil(threads).max(512)).map(|part| s.spawn(|| part.iter().map(&best_of).collect::<Vec<_>>())).collect();
            parts.into_iter().flat_map(|h| h.join().expect("a matching thread doesn't fail")).collect()
        });
        let mut matched = HashSet::new();
        for (f, b) in open.iter().zip(best) {
            if let Some((p, s)) = b {
                out.matches.push(Match { face: f.id, person: p.to_string(), score: s });
                matched.insert(f.id);
            }
        }
        for kind in [Kind::Photo, Kind::Drawn] {
            let mut faces: Vec<&Face> = open.iter().copied().filter(|f| f.kind == kind && f.good() && !matched.contains(&f.id)).collect();
            faces.sort_by(|a, b| (b.size as f32 * b.score).total_cmp(&(a.size as f32 * a.score)));
            faces.truncate(GROUPED);
            out.groups.extend(group(&faces, kind));
        }
        out.groups.sort_by_key(|g| std::cmp::Reverse(g.faces.len()));
        out
    }

    /* ---------- on disk: "MSF1", the length of a JSON header, the header, then the faces ---------- */

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut keys: Vec<&str> = self.faces.iter().map(|f| f.key.as_str()).collect();
        keys.sort_unstable();
        keys.dedup();
        let index: HashMap<&str, u32> = keys.iter().enumerate().map(|(i, k)| (*k, i as u32)).collect();
        // The parts marked by the reader, by face id: in the header, so the faces themselves keep their layout.
        let marked: HashMap<String, [f32; 4]> = self.faces.iter().filter_map(|f| f.marked.map(|m| (f.id.to_string(), m))).collect();
        // Faces in videos, their moments, by face id: in the header too (older files have none).
        let at: HashMap<String, f32> = self.faces.iter().filter_map(|f| f.at.map(|t| (f.id.to_string(), t))).collect();
        let header = serde_json::json!({ "version": 1, "nextId": self.next_id, "keys": keys, "scanned": self.scanned.iter().map(|(k, s)| (k.clone(), [s.s, s.m])).collect::<HashMap<_, _>>(), "drawn": DRAWN_MODEL, "redo": self.redo, "noCharacters": self.no_characters, "marked": marked, "at": at });
        let header = serde_json::to_vec(&header).expect("a JSON value serialises");
        let mut out = Vec::with_capacity(8 + header.len() + self.faces.len() * 560);
        out.extend_from_slice(b"MSF1");
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(&header);
        for f in &self.faces {
            out.extend_from_slice(&f.id.to_le_bytes());
            out.extend_from_slice(&index[f.key.as_str()].to_le_bytes());
            out.push(f.kind.code());
            for v in f.bbox {
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.extend_from_slice(&f.score.to_le_bytes());
            out.extend_from_slice(&f.size.to_le_bytes());
            out.extend_from_slice(&f.scale.to_le_bytes());
            out.extend_from_slice(&(f.q.len() as u16).to_le_bytes());
            out.extend(f.q.iter().map(|&b| b as u8));
        }
        out
    }

    pub fn from_bytes(b: &[u8]) -> Result<FaceIndex, String> {
        let bad = || "the face index is damaged".to_string();
        if b.len() < 8 || &b[..4] != b"MSF1" {
            return Err(bad());
        }
        let hlen = u32::from_le_bytes(b[4..8].try_into().map_err(|_| bad())?) as usize;
        let header: serde_json::Value = serde_json::from_slice(b.get(8..8 + hlen).ok_or_else(bad)?).map_err(|_| bad())?;
        let keys: Vec<String> = serde_json::from_value(header["keys"].clone()).map_err(|_| bad())?;
        let scanned: HashMap<String, [u64; 2]> = serde_json::from_value(header["scanned"].clone()).unwrap_or_default();
        let redo: HashSet<String> = serde_json::from_value(header["redo"].clone()).unwrap_or_default();
        let no_characters: HashSet<String> = serde_json::from_value(header["noCharacters"].clone()).unwrap_or_default();
        let marked: HashMap<String, [f32; 4]> = serde_json::from_value(header["marked"].clone()).unwrap_or_default();
        let moments: HashMap<String, f32> = serde_json::from_value(header["at"].clone()).unwrap_or_default();
        let mut ix = FaceIndex { faces: Vec::new(), scanned: scanned.into_iter().map(|(k, [s, m])| (k, Stamp { s, m })).collect(), next_id: header["nextId"].as_u64().unwrap_or(0), redo, no_characters };
        let mut at = 8 + hlen;
        let take = |at: &mut usize, n: usize| -> Result<&[u8], String> {
            let s = b.get(*at..*at + n).ok_or_else(bad)?;
            *at += n;
            Ok(s)
        };
        let f32_at = |s: &[u8]| f32::from_le_bytes(s.try_into().expect("four bytes"));
        while at < b.len() {
            let id = u64::from_le_bytes(take(&mut at, 8)?.try_into().map_err(|_| bad())?);
            let key = keys.get(u32::from_le_bytes(take(&mut at, 4)?.try_into().map_err(|_| bad())?) as usize).ok_or_else(bad)?.clone();
            let kind = Kind::from_code(take(&mut at, 1)?[0]).ok_or_else(bad)?;
            let mut bbox = [0f32; 4];
            for v in &mut bbox {
                *v = f32_at(take(&mut at, 4)?);
            }
            let score = f32_at(take(&mut at, 4)?);
            let size = u32::from_le_bytes(take(&mut at, 4)?.try_into().map_err(|_| bad())?);
            let scale = f32_at(take(&mut at, 4)?);
            let dim = u16::from_le_bytes(take(&mut at, 2)?.try_into().map_err(|_| bad())?) as usize;
            let q = take(&mut at, dim)?.iter().map(|&x| x as i8).collect();
            ix.faces.push(Face { id, key, kind, bbox, score, size, q, scale, marked: marked.get(&id.to_string()).copied(), at: moments.get(&id.to_string()).copied() });
        }
        // Made with an older character model: its pictures with drawn faces are looked at again.
        if header["drawn"].as_u64().unwrap_or(1) < DRAWN_MODEL {
            let old: HashSet<String> = ix.faces.iter().filter(|f| f.kind == Kind::Drawn).map(|f| f.key.clone()).collect();
            for k in &old {
                ix.scanned.remove(k);
            }
            ix.redo.extend(old);
        }
        Ok(ix)
    }
}

/// How much two boxes overlap: their shared area over their joint area.
pub fn overlap(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let w = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let h = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let inter = w * h;
    let union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    if union <= 0.0 { 0.0 } else { inter / union }
}

/// Faces alike, best first: each joins the group whose middle it is closest to, if close enough,
/// else starts one. Groups of one are left out: nothing to ask about yet.
fn group(faces: &[&Face], kind: Kind) -> Vec<Group> {
    // Each group's middle: the sum of its faces' numbers (as floats), and that sum's direction kept
    // in whole numbers as a face's are, which a face is compared with (a group of one being its face;
    // whole numbers are summed many at a time, floats one by one).
    let middle = |sum: &[f32]| {
        let norm = sum.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
        quantize(&sum.iter().map(|x| x / norm).collect::<Vec<f32>>())
    };
    let mut sums: Vec<Vec<f32>> = Vec::new();
    let mut middles: Vec<(Vec<i8>, f32)> = Vec::new();
    let mut members: Vec<Vec<u64>> = Vec::new();
    for f in faces {
        let v: Vec<f32> = f.q.iter().map(|&x| f32::from(x) * f.scale).collect();
        let mut best: Option<(usize, f32)> = None;
        for (g, (q, scale)) in middles.iter().enumerate() {
            let s = dot_i8(&f.q, q) as f32 * f.scale * scale;
            if best.is_none_or(|(_, b)| s > b) {
                best = Some((g, s));
            }
        }
        match best {
            Some((g, s)) if s >= kind.same() => {
                sums[g].iter_mut().zip(&v).for_each(|(a, b)| *a += b);
                middles[g] = middle(&sums[g]);
                members[g].push(f.id);
            }
            _ => {
                middles.push(middle(&v));
                sums.push(v);
                members.push(vec![f.id]);
            }
        }
    }
    let by_id: HashMap<u64, &Face> = faces.iter().map(|f| (f.id, *f)).collect();
    members
        .into_iter()
        .zip(sums)
        .filter(|(m, _)| m.len() >= 2)
        .map(|(faces, sum)| {
            let norm = sum.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
            let scores = faces.iter().map(|id| by_id[id].q.iter().zip(&sum).map(|(&q, s)| f32::from(q) * by_id[id].scale * s).sum::<f32>() / norm).collect();
            Group { kind, faces, scores }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit vector mostly along `axis`, a little along `twist`.
    fn vec_of(axis: usize, twist: usize, by: f32) -> Vec<f32> {
        let mut v = [0.0f32; 16];
        v[axis] = 1.0;
        v[twist] += by;
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / n).collect()
    }
    fn found(kind: Kind, v: Vec<f32>) -> Found {
        Found { kind, bbox: [0.1, 0.1, 0.3, 0.4], score: 0.9, size: 120, embedding: v, marked: None, at: None }
    }
    fn stamp() -> Stamp {
        Stamp { s: 1, m: 2 }
    }

    #[test]
    fn faces_alike_group_and_a_named_persons_join_them() {
        let mut ix = FaceIndex::default();
        ix.put("a.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 1, 0.1))]);
        ix.put("b.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 2, 0.2)), found(Kind::Photo, vec_of(5, 6, 0.1))]);
        ix.put("c.jpg", stamp(), vec![found(Kind::Photo, vec_of(5, 7, 0.2))]);
        ix.put("d.jpg", stamp(), vec![found(Kind::Photo, vec_of(9, 1, 0.0))]);
        let sorted = ix.sort(&Labels::default());
        assert!(sorted.matches.is_empty());
        let groups: Vec<Vec<u64>> = sorted.groups.iter().map(|g| { let mut f = g.faces.clone(); f.sort(); f }).collect();
        assert!(sorted.groups.iter().all(|g| g.scores.len() == g.faces.len() && g.scores.iter().all(|s| *s > 0.9)), "each face says how close it is to its group");
        assert_eq!(groups.len(), 2, "{groups:?}");
        assert!(groups.contains(&vec![1, 2]) && groups.contains(&vec![3, 4]), "{groups:?}");
        // Named: face 1 is Lena; face 2 joins her, face 3 and 4 still wait; face 5 is no one's.
        let labels = Labels { assigned: vec![(1, "lena".into(), true)], ..Default::default() };
        let sorted = ix.sort(&labels);
        assert_eq!(sorted.matches.iter().map(|m| (m.face, m.person.as_str())).collect::<Vec<_>>(), vec![(2, "lena")]);
        // "Not Lena" on face 2: it no longer goes with her.
        let labels = Labels { assigned: vec![(1, "lena".into(), true)], not: vec![(2, "lena".into())], ..Default::default() };
        assert!(ix.sort(&labels).matches.is_empty());
    }

    #[test]
    fn the_tagger_naming_a_character_lets_a_closer_call_through_or_rules_one_out() {
        let mut ix = FaceIndex::default();
        ix.put("a.jpg", stamp(), vec![found(Kind::Drawn, vec_of(0, 1, 0.0))]);
        // About 0.60 like her: between `same` and `joins`.
        ix.put("b.jpg", stamp(), vec![found(Kind::Drawn, vec_of(0, 1, 1.333))]);
        // About 0.80 like her: past `joins`.
        ix.put("c.jpg", stamp(), vec![found(Kind::Drawn, vec_of(0, 2, 0.75))]);
        let pepper = |named: Vec<(u64, Vec<String>)>, ruled_out: Vec<(u64, Vec<String>)>| Labels { assigned: vec![(1, "pepper".into(), true)], named, ruled_out, ..Default::default() };
        let matched = |l: &Labels| ix.sort(l).matches.iter().map(|m| m.face).collect::<Vec<_>>();
        assert_eq!(matched(&pepper(vec![], vec![])), vec![3], "by likeness alone, only the close one");
        assert_eq!(matched(&pepper(vec![(2, vec!["pepper".into()])], vec![])), vec![2, 3], "the tagger naming her brings the nearer call in");
        assert_eq!(matched(&pepper(vec![], vec![(3, vec!["pepper".into()])])), Vec::<u64>::new(), "the tagger sure it's someone else keeps even a close one out");
    }

    #[test]
    fn a_face_found_again_where_it_was_keeps_its_id() {
        let mut ix = FaceIndex::default();
        ix.put("a.jpg", stamp(), vec![found(Kind::Drawn, vec_of(0, 1, 0.0)), found(Kind::Photo, vec_of(3, 1, 0.0))]);
        let ids: Vec<u64> = ix.faces.iter().map(|f| f.id).collect();
        // Looked at again (a newer model): the same places, new numbers; and a face not there before.
        let mut moved = found(Kind::Drawn, vec_of(5, 1, 0.0));
        moved.bbox = [0.11, 0.1, 0.31, 0.41];
        let mut other = found(Kind::Drawn, vec_of(6, 1, 0.0));
        other.bbox = [0.6, 0.5, 0.9, 0.9];
        ix.put("a.jpg", stamp(), vec![moved, found(Kind::Photo, vec_of(3, 2, 0.0)), other]);
        let now: Vec<u64> = ix.faces.iter().map(|f| f.id).collect();
        assert_eq!(&now[..2], &ids[..], "the same faces keep their ids");
        assert!(now[2] > ids[1], "a new face gets a new one");
    }

    #[test]
    fn an_index_from_the_older_character_model_looks_at_its_drawn_faces_again() {
        let mut ix = FaceIndex::default();
        ix.put("drawn.png", stamp(), vec![found(Kind::Drawn, vec_of(0, 1, 0.0))]);
        ix.put("photo.jpg", stamp(), vec![found(Kind::Photo, vec_of(3, 1, 0.0))]);
        // Saved as the older model's: its header says drawn 1.
        let bytes = ix.to_bytes();
        let hlen = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let mut header: serde_json::Value = serde_json::from_slice(&bytes[8..8 + hlen]).unwrap();
        header["drawn"] = 1.into();
        let h = serde_json::to_vec(&header).unwrap();
        let old = [&b"MSF1"[..], &(h.len() as u32).to_le_bytes(), &h, &bytes[8 + hlen..]].concat();
        let mut back = FaceIndex::from_bytes(&old).unwrap();
        assert!(!back.scanned.contains_key("drawn.png") && back.scanned.contains_key("photo.jpg"), "only the picture with drawn faces is looked at again");
        assert_eq!(back.redo.iter().collect::<Vec<_>>(), vec!["drawn.png"]);
        let labels = Labels::default();
        assert!(back.sort(&labels).groups.iter().all(|g| g.kind == Kind::Photo), "its old numbers stay out of matching");
        // Looked at again: it counts, and the index says so when saved.
        back.put("drawn.png", stamp(), vec![found(Kind::Drawn, vec_of(0, 1, 0.0))]);
        assert!(back.redo.is_empty());
        assert!(FaceIndex::from_bytes(&back.to_bytes()).unwrap().redo.is_empty());
    }

    #[test]
    fn a_face_unlike_the_rest_of_a_persons_is_a_doubt_and_brings_no_one_in() {
        // Lena's tag: three pictures of her, and one whose only face is Kai's (she was turned away).
        let mut ix = FaceIndex::default();
        for (i, by) in [0.05, 0.1, 0.15].iter().enumerate() {
            ix.put(&format!("lena{i}.jpg"), stamp(), vec![found(Kind::Photo, vec_of(0, 1, *by))]);
        }
        ix.put("kai-in-lenas.jpg", stamp(), vec![found(Kind::Photo, vec_of(5, 6, 0.1))]);
        // Not tagged: another of Lena, and two more of Kai.
        ix.put("lena-new.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 2, 0.1))]);
        ix.put("kai1.jpg", stamp(), vec![found(Kind::Photo, vec_of(5, 7, 0.1))]);
        ix.put("kai2.jpg", stamp(), vec![found(Kind::Photo, vec_of(5, 6, 0.2))]);
        let from_tag = |checked: bool| Labels { assigned: (1..=4).map(|f| (f, "lena".to_string(), checked)).collect(), ..Default::default() };
        let sorted = ix.sort(&from_tag(false));
        assert_eq!(sorted.doubts.iter().map(|d| (d.face, d.person.as_str())).collect::<Vec<_>>(), vec![(4, "lena")]);
        assert_eq!(sorted.matches.iter().map(|m| m.face).collect::<Vec<_>>(), vec![5], "Lena's new picture joins her, Kai's don't");
        // Checked by the user, it's hers after all: no doubt. Still, one face alone, unlike her
        // others, brings no one in.
        let sorted = ix.sort(&from_tag(true));
        assert!(sorted.doubts.is_empty());
        assert_eq!(sorted.matches.iter().map(|m| m.face).collect::<Vec<_>>(), vec![5]);
    }

    #[test]
    fn one_close_face_alone_brings_no_one_in_when_the_others_disagree() {
        // Lena's two faces: one close to the newcomer, the other nothing like it.
        let mut ix = FaceIndex::default();
        ix.put("a.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 1, 0.1))]);
        ix.put("b.jpg", stamp(), vec![found(Kind::Photo, vec_of(3, 4, 0.1))]);
        ix.put("new.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 2, 0.1))]);
        let labels = Labels { assigned: vec![(1, "lena".into(), true), (2, "lena".into(), true)], ..Default::default() };
        assert!(ix.sort(&labels).matches.is_empty());
        // With a third of hers like it, two agree: it joins.
        ix.put("c.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 3, 0.1))]);
        let labels = Labels { assigned: vec![(1, "lena".into(), true), (2, "lena".into(), true), (4, "lena".into(), true)], ..Default::default() };
        assert_eq!(ix.sort(&labels).matches.iter().map(|m| m.face).collect::<Vec<_>>(), vec![3]);
    }

    #[test]
    fn a_face_turned_down_keeps_faces_like_it_off_too() {
        // Lena's three faces; her sister Mia looks a lot like her.
        let mut ix = FaceIndex::default();
        for (i, by) in [0.05, 0.1, 0.15].iter().enumerate() {
            ix.put(&format!("lena{i}.jpg"), stamp(), vec![found(Kind::Photo, vec_of(0, 1, *by))]);
        }
        ix.put("mia1.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 9, 0.5))]);
        ix.put("mia2.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 9, 0.55))]);
        ix.put("lena-new.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 2, 0.1))]);
        let lena = |not: Vec<(u64, String)>| Labels { assigned: (1..=3).map(|f| (f, "lena".to_string(), true)).collect(), not, ..Default::default() };
        let suggested = |l: &Labels| ix.sort(l).matches.iter().map(|m| m.face).collect::<Vec<_>>();
        assert_eq!(suggested(&lena(vec![])), vec![4, 5, 6], "Mia's pictures look like Lena's");
        // One of Mia's turned down: the other goes too, Lena's own new one stays.
        assert_eq!(suggested(&lena(vec![(4, "lena".into())])), vec![6]);
    }

    #[test]
    fn photos_and_drawings_never_mix() {
        let mut ix = FaceIndex::default();
        ix.put("a.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 1, 0.1))]);
        ix.put("b.png", stamp(), vec![found(Kind::Drawn, vec_of(0, 1, 0.1))]);
        let labels = Labels { assigned: vec![(1, "lena".into(), true)], ..Default::default() };
        assert!(ix.sort(&labels).matches.is_empty());
    }

    #[test]
    fn keeps_its_faces_on_disk_and_follows_moves() {
        let mut ix = FaceIndex::default();
        ix.put("Inbox/a.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 1, 0.3)), found(Kind::Drawn, vec_of(3, 4, 0.2))]);
        ix.put("Inbox/empty.jpg", stamp(), vec![]);
        let back = FaceIndex::from_bytes(&ix.to_bytes()).unwrap();
        assert_eq!(back.faces.len(), 2);
        assert_eq!(back.next_id, 2);
        assert_eq!(back.scanned.len(), 2);
        assert!((back.faces[0].dot(&ix.faces[0]) - 1.0).abs() < 0.02);
        assert_eq!(back.faces[1].kind, Kind::Drawn);
        let mut ix = back;
        assert!(ix.rename(&[("Inbox".into(), "Private/2026".into())]));
        assert!(ix.faces.iter().all(|f| f.key == "Private/2026/a.jpg"));
        assert!(ix.scanned.contains_key("Private/2026/empty.jpg"));
        assert!(ix.forget(|k| k.ends_with("a.jpg")));
        assert!(ix.faces.is_empty());
        assert!(FaceIndex::from_bytes(b"MSF1junk").is_err());
    }

    #[test]
    fn a_picture_looked_at_without_the_character_finder_waits_for_it_and_keeps_its_faces() {
        let mut ix = FaceIndex::default();
        // Looked at with the face finder alone: its photo face, and a note to look again.
        ix.put("Inbox/page.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 1, 0.3))]);
        ix.without_characters("Inbox/page.jpg");
        ix.put("Inbox/photo.jpg", stamp(), vec![]);
        let id = ix.faces[0].id;
        // Kept on disk, and following a move.
        let mut ix = FaceIndex::from_bytes(&ix.to_bytes()).unwrap();
        assert_eq!(ix.no_characters, HashSet::from(["Inbox/page.jpg".to_string()]));
        assert!(ix.rename(&[("Inbox".into(), "Comics".into())]));
        assert_eq!(ix.no_characters, HashSet::from(["Comics/page.jpg".to_string()]));
        // The finder downloaded, the picture looked at again: its photo face keeps its id (and who it
        // is), the drawn one joins it, and nothing waits any more.
        let mut drawn = found(Kind::Drawn, vec_of(3, 4, 0.2));
        drawn.bbox = [0.6, 0.5, 0.9, 0.9];
        ix.put("Comics/page.jpg", stamp(), vec![found(Kind::Photo, vec_of(0, 1, 0.3)), drawn]);
        assert_eq!(ix.faces.iter().find(|f| f.kind == Kind::Photo).unwrap().id, id);
        assert_eq!(ix.faces.len(), 2);
        assert!(ix.no_characters.is_empty());
        // Gone for good: nothing left waiting for it either.
        ix.without_characters("Comics/page.jpg");
        assert!(ix.forget(|k| k.starts_with("Comics/")));
        assert!(ix.no_characters.is_empty());
    }

    #[test]
    fn a_face_marked_by_the_reader_joins_the_others_and_is_kept_with_its_part() {
        let mut ix = FaceIndex::default();
        ix.put("a.jpg", stamp(), vec![found(Kind::Drawn, vec_of(0, 1, 0.0))]);
        let first = ix.faces[0].id;
        // A small face the whole look missed, marked: beside the other, not in its place.
        let mut small = found(Kind::Drawn, vec_of(1, 1, 0.0));
        small.bbox = [0.7, 0.7, 0.75, 0.76];
        small.marked = Some([0.65, 0.65, 0.8, 0.8]);
        let ids = ix.add("a.jpg", vec![small]);
        assert_eq!(ix.faces.len(), 2);
        assert_ne!(ids[0], first);
        assert_eq!(ix.marked_in("a.jpg"), vec![(Kind::Drawn, [0.65, 0.65, 0.8, 0.8])]);
        // Marked again where it is: the same face, its id kept.
        let mut again = found(Kind::Drawn, vec_of(1, 2, 0.0));
        again.bbox = [0.7, 0.7, 0.75, 0.76];
        again.marked = Some([0.66, 0.66, 0.8, 0.8]);
        assert_eq!(ix.add("a.jpg", vec![again]), ids);
        assert_eq!(ix.faces.len(), 2);
        // On disk with its part, and shown as marked.
        let back = FaceIndex::from_bytes(&ix.to_bytes()).unwrap();
        assert_eq!(back.marked_in("a.jpg"), vec![(Kind::Drawn, [0.66, 0.66, 0.8, 0.8])]);
        assert_eq!(back.views().iter().filter(|v| v.marked).count(), 1);
    }
}

#[cfg(test)]
mod video_tests {
    use super::*;

    fn seen(at: Option<f32>, bbox: [f32; 4], score: f32) -> Found {
        Found { kind: Kind::Photo, bbox, score, size: 120, embedding: vec![0.5; 8], marked: None, at }
    }

    #[test]
    fn a_face_in_a_video_keeps_its_moment_through_the_bytes_and_its_id_when_seen_again_there() {
        let mut ix = FaceIndex::default();
        ix.put("clip.mp4", Stamp { s: 1, m: 2 }, vec![seen(Some(12.5), [0.1, 0.1, 0.3, 0.3], 0.9), seen(Some(40.0), [0.1, 0.1, 0.3, 0.3], 0.8)]);
        let back = FaceIndex::from_bytes(&ix.to_bytes()).unwrap();
        let mut ats: Vec<Option<f32>> = back.views().iter().map(|v| v.at).collect();
        ats.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(ats, vec![Some(12.5), Some(40.0)]);
        // The same place at the same moment is the same face (its id stays); at another moment it is another.
        let ids: Vec<u64> = ix.views().iter().map(|v| v.id).collect();
        ix.put("clip.mp4", Stamp { s: 1, m: 3 }, vec![seen(Some(12.6), [0.1, 0.1, 0.3, 0.3], 0.9), seen(Some(70.0), [0.1, 0.1, 0.3, 0.3], 0.8)]);
        let again: Vec<u64> = ix.views().iter().map(|v| v.id).collect();
        assert!(again.contains(&ids[0]) || again.contains(&ids[1]));
        assert_eq!(again.iter().filter(|i| ids.contains(i)).count(), 1);
    }
}
