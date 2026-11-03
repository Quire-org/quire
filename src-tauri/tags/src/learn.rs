//! Each tag learned from what you said about it: the things that carry it
//! (yes), the suggestions you turned down (no), and a light sample of
//! everything else (mostly no, but some may simply not be tagged yet). A
//! logistic regression over the index's vectors: the picture-and-word model's,
//! with the anime tagger's beside it where it looked. Its answer is a
//! probability, so every tag has its own cut and scores mean the same for all
//! of them. While a tag has few examples, its name counts too.
//!
//! A picture is seen as how it differs from others of its kind (drawn, or a
//! photo): every manga page looks like manga, so a tag's first manga would
//! otherwise teach "manga" rather than what is in it. Whether a tag goes with
//! drawn pictures or photos is counted apart, and only weighs once many of its
//! examples agree.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use crate::tagindex::{Groups, Index};

/// Examples a tag needs before its name stops counting.
pub const YOUNG: usize = 3;
/// At most this many of each kind of example: enough to learn from, quick to train.
const MAX_YES: usize = 400;
const MAX_NO: usize = 400;
const BACKGROUND: usize = 300;
/// A crop or frame counts this much less (in logits) than the whole picture: a small thing is found,
/// the whole picture wins when both match.
const PART_MARGIN: f32 = 1.0;
const STEPS: usize = 120;
/// After a fit, what of the rest it gives at least this chance is no longer taken for a no; up to
/// this many times (it settles quickly).
const SUSPECT: f32 = 0.2;
const PASSES: usize = 3;
const RATE: f32 = 0.1;
const DECAY: f32 = 1e-3;
/// SigLIP 2's (base, 256 px) logit scale and bias, from its weights: a picture and words go together
/// with probability σ(scale · cosine + bias). A tag's name is short ("a photo of cat"), and SigLIP is
/// strict about short texts, so a name counts as `WORDS_LIFT` more; still never sure on its own.
const SIGLIP_SCALE: f32 = 112.901_18;
const SIGLIP_BIAS: f32 = -16.771_803;
const WORDS_LIFT: f32 = 5.0;
const WORDS_MAX: f32 = 0.7;
/// Beside a tag's first examples, a name that doesn't fit a picture only counts this much against it
/// (a name like "grandma" says little about a photo): it lifts more than it holds back.
const WORDS_FLOOR: f32 = -4.0;
/// How many examples' worth the library's own mix of drawn pictures and photos counts for, against a
/// tag's examples: a tag's kind weighs once well more than that many agree.
const KIND_PRIOR: f32 = 4.0;

pub fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

fn logit(p: f32) -> f32 {
    let p = p.clamp(1e-4, 1.0 - 1e-4);
    (p / (1.0 - p)).ln()
}

/// What a tag's name says about a picture, as a logit, from their cosine.
pub fn words_logit(embedder: &str, cos: f32) -> f32 {
    let l = match embedder {
        "siglip2" => SIGLIP_SCALE * cos + SIGLIP_BIAS + WORDS_LIFT,
        // CLIP: what the first suggestions used (a cosine of 0.2 nothing, 0.4 sure).
        _ => logit((cos - 0.2) * 5.0),
    };
    l.min(logit(WORDS_MAX))
}

/// The average picture of each kind, drawn (the anime tagger looked at it) and photo, and of the
/// tagger's view; and how many are drawn. An older tagger looked at everything: no kinds then.
pub struct Kinds {
    drawn: Option<Vec<f32>>,
    photo: Option<Vec<f32>>,
    anime: Option<Vec<f32>>,
    anime_dim: usize,
    share: Option<f32>,
}

pub fn kinds(ix: &Index) -> Kinds {
    let anime_dim = ix.anime_dim();
    let none = Groups::new();
    let add = |acc: &mut Option<Vec<f32>>, v: &[f32]| {
        let s = acc.get_or_insert_with(|| vec![0.0; v.len()]);
        s.iter_mut().zip(v).for_each(|(a, b)| *a += b);
    };
    let (mut drawn, mut photo, mut anime) = (None, None, None);
    let (mut nd, mut np) = (0usize, 0usize);
    for k in ix.keys() {
        let Some(v) = ix.vector(k, &none) else { continue };
        match (anime_dim > 0).then(|| ix.anime_vector(k, &none)).flatten() {
            Some(a) => {
                add(&mut drawn, &v);
                add(&mut anime, &a);
                nd += 1;
            }
            None => {
                add(&mut photo, &v);
                np += 1;
            }
        }
    }
    let mean = |s: Option<Vec<f32>>, n: usize| s.map(|v| v.into_iter().map(|x| x / n.max(1) as f32).collect());
    Kinds { drawn: mean(drawn, nd), photo: mean(photo, np), anime: mean(anime, nd), anime_dim, share: (anime_dim > 0 && nd + np > 0).then(|| nd as f32 / (nd + np) as f32) }
}

fn minus(v: Vec<f32>, m: &Option<Vec<f32>>) -> Vec<f32> {
    match m {
        Some(m) if m.len() == v.len() => v.iter().zip(m).map(|(a, b)| a - b).collect(),
        _ => v,
    }
}

/// A picture as the learner sees it: how it differs from the average of its kind (the picture-and-
/// word vector, then the tagger's view where it looked, zeros elsewhere); and whether it is drawn.
fn features(ix: &Index, key: &str, groups: &Groups, k: &Kinds) -> Option<(Vec<f32>, bool)> {
    let v = ix.vector(key, groups)?;
    let anime = (k.anime_dim > 0).then(|| ix.anime_vector(key, groups).filter(|a| a.len() == k.anime_dim)).flatten();
    let drawn = anime.is_some();
    let mut f = minus(v, if drawn { &k.drawn } else { &k.photo });
    if k.anime_dim > 0 {
        match anime {
            Some(a) => f.extend(minus(a, &k.anime)),
            None => f.extend(std::iter::repeat_n(0.0, k.anime_dim)),
        }
    }
    Some((f, drawn))
}

/// What was learned of one tag.
pub struct Model {
    w: Vec<f32>,
    b: f32,
    kinds: std::sync::Arc<Kinds>,
    /// What being drawn, or a photo, says about it (logits): little until many examples agree.
    drawn: f32,
    photo: f32,
    /// How many things carry it (with vectors).
    pub yes: usize,
}

impl Model {
    fn z(&self, f: &[f32]) -> f32 {
        self.w.iter().zip(f).map(|(w, x)| w * x).sum::<f32>() + self.b
    }

    /// The logit for an item: its whole picture, or one of its crops or frames (`PART_MARGIN` less),
    /// and what its kind says.
    pub fn logit(&self, ix: &Index, key: &str, groups: &Groups) -> Option<f32> {
        let (f, drawn) = features(ix, key, groups, &self.kinds)?;
        let whole = self.z(&f);
        let main = ix.vector(key, groups).map_or(0, |v| v.len());
        let average = if drawn { &self.kinds.drawn } else { &self.kinds.photo };
        let best = ix
            .parts_of(key)
            .into_iter()
            .map(|p| {
                // The part as its kind differs, with the item's own tagger view beside it.
                let mut p = minus(p, average);
                p.extend_from_slice(&f[main..]);
                self.z(&p) - PART_MARGIN
            })
            .fold(whole, f32::max);
        Some(best + if drawn { self.drawn } else { self.photo })
    }
}

/// A stable pseudo-random order for sampling (the same sample each time, unlike `rand`).
fn hashed(tag: &str, key: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (tag, key).hash(&mut h);
    h.finish()
}

/// Up to `n` of `keys`, the same ones every time for this tag.
fn sample<'a>(tag: &str, keys: impl Iterator<Item = &'a String>, n: usize) -> Vec<&'a String> {
    let mut all: Vec<(u64, &String)> = keys.map(|k| (hashed(tag, k), k)).collect();
    if all.len() > n {
        all.select_nth_unstable_by_key(n, |x| x.0);
        all.truncate(n);
    }
    all.into_iter().map(|x| x.1).collect()
}

fn norm(x: &[f32]) -> f32 {
    x.iter().map(|a| a * a).sum::<f32>().sqrt().max(1e-6)
}

/// The mean direction of some vectors, of unit length.
fn centre(xs: &[Vec<f32>]) -> Vec<f32> {
    let mut c = vec![0.0f32; xs[0].len()];
    for x in xs {
        let n = norm(x);
        c.iter_mut().zip(x).for_each(|(a, b)| *a += b / n);
    }
    let n = norm(&c);
    c.iter_mut().for_each(|a| *a /= n);
    c
}

/// Learn a tag: `yes` carries it, `no` was turned down, `others` are what else there is to compare
/// with (album keys in album mode); `kinds` the library's (see `kinds`). None: nothing that carries it
/// is indexed.
pub fn train(ix: &Index, groups: &Groups, kinds: &std::sync::Arc<Kinds>, tag: &str, yes: &[String], no: &[String], others: &[String]) -> Option<Model> {
    let feat = |k: &String| features(ix, k, groups, kinds).map(|f| f.0);
    let seen: Vec<(Vec<f32>, bool)> = sample(tag, yes.iter(), MAX_YES).into_iter().filter_map(|k| features(ix, k, groups, kinds)).collect();
    if seen.is_empty() {
        return None;
    }
    // Drawn or photo: the library's mix, moved by the tag's examples as they agree.
    let n = seen.len() as f32;
    let nd = seen.iter().filter(|x| x.1).count() as f32;
    let (drawn, photo) = match kinds.share {
        Some(q) => {
            let q = q.clamp(0.02, 0.98);
            (((nd + KIND_PRIOR * q) / (n + KIND_PRIOR) / q).ln(), ((n - nd + KIND_PRIOR * (1.0 - q)) / (n + KIND_PRIOR) / (1.0 - q)).ln())
        }
        None => (0.0, 0.0),
    };
    let pos: Vec<Vec<f32>> = seen.into_iter().map(|x| x.0).collect();
    let neg: Vec<Vec<f32>> = sample(tag, no.iter(), MAX_NO).into_iter().filter_map(feat).collect();
    let taken: std::collections::HashSet<&String> = yes.iter().chain(no).collect();
    // The rest is mostly no, but what isn't tagged yet is in there too. Nothing as like the tag's
    // examples as most of them are to each other counts as a no; then, learned once, what that finds
    // fairly likely is left out too (it may well carry the tag), and it is learned again.
    let rest: Vec<Vec<f32>> = sample(tag, others.iter().filter(|k| !taken.contains(k)), BACKGROUND).into_iter().filter_map(feat).collect();
    let centre = centre(&pos);
    let cos = |x: &[f32]| x.iter().zip(&centre).map(|(a, b)| a * b).sum::<f32>() / norm(x);
    let mut own: Vec<f32> = pos.iter().map(|x| cos(x)).collect();
    own.sort_by(f32::total_cmp);
    let like = own[own.len() / 5];
    let mut back: Vec<Vec<f32>> = rest.into_iter().filter(|x| cos(x) < like).collect();
    let (mut w, mut b) = fit(&pos, &neg, &back, None);
    for _ in 0..PASSES {
        let z = |x: &[f32]| w.iter().zip(x).map(|(a, c)| a * c).sum::<f32>() + b;
        let sure_no: Vec<Vec<f32>> = back.iter().filter(|x| sigmoid(z(x)) < SUSPECT).cloned().collect();
        if sure_no.len() == back.len() {
            break;
        }
        back = sure_no;
        (w, b) = fit(&pos, &neg, &back, Some((w, b)));
    }
    Some(Model { w, b, kinds: kinds.clone(), drawn, photo, yes: pos.len() })
}

/// The weights telling `pos` from `neg` (turned down: a sure no) and `back` (the rest: a guess at no),
/// from scratch or carrying on from an earlier fit (`start`, which needs fewer steps).
fn fit(pos: &[Vec<f32>], neg: &[Vec<f32>], back: &[Vec<f32>], start: Option<(Vec<f32>, f32)>) -> (Vec<f32>, f32) {
    // Yes weighs more than the background; what was turned down is a sure no.
    let (wn, wb) = match (neg.is_empty(), back.is_empty()) {
        (false, false) => (0.7, 0.3),
        (false, true) => (1.0, 0.0),
        _ => (0.0, 0.5),
    };
    let mut xs: Vec<(&[f32], f32, f32)> = Vec::new();
    xs.extend(pos.iter().map(|x| (x.as_slice(), 1.0, 1.0 / pos.len() as f32)));
    xs.extend(neg.iter().map(|x| (x.as_slice(), 0.0, wn / neg.len().max(1) as f32)));
    xs.extend(back.iter().map(|x| (x.as_slice(), 0.0, wb / back.len().max(1) as f32)));
    let dim = pos[0].len();
    let total: f32 = xs.iter().map(|x| x.2).sum();
    let ones = xs.iter().filter(|x| x.1 > 0.5).count() < xs.len();
    // Start from the difference of the means (what tells them apart), then refine.
    let mean = |label: f32| {
        let mut m = vec![0.0f32; dim];
        let mut wsum = 0.0;
        for (x, y, w) in &xs {
            if (*y - label).abs() < 0.5 {
                m.iter_mut().zip(x.iter()).for_each(|(a, b)| *a += w * b);
                wsum += w;
            }
        }
        m.iter_mut().for_each(|a| *a /= wsum.max(1e-6));
        m
    };
    let steps = if start.is_some() { STEPS / 3 } else { STEPS };
    let (mut w, mut b) = start.unwrap_or_else(|| {
        let (mp, mn) = (mean(1.0), mean(0.0));
        let mut w: Vec<f32> = mp.iter().zip(&mn).map(|(a, b)| a - b).collect();
        let gap: f32 = w.iter().map(|x| x * x).sum::<f32>().max(1e-6);
        w.iter_mut().for_each(|x| *x *= 8.0 / gap);
        let mid: Vec<f32> = mp.iter().zip(&mn).map(|(a, b)| (a + b) / 2.0).collect();
        let b = -w.iter().zip(&mid).map(|(a, c)| a * c).sum::<f32>();
        (w, b)
    });
    if ones {
        // Adam, full batch.
        let (mut m, mut v) = (vec![0.0f32; dim + 1], vec![0.0f32; dim + 1]);
        let (b1, b2) = (0.9f32, 0.999f32);
        for t in 1..=steps {
            let mut g = vec![0.0f32; dim + 1];
            for (x, y, wt) in &xs {
                let z = w.iter().zip(x.iter()).map(|(a, c)| a * c).sum::<f32>() + b;
                let e = (sigmoid(z) - y) * wt / total;
                g.iter_mut().zip(x.iter()).for_each(|(gi, xi)| *gi += e * xi);
                g[dim] += e;
            }
            for (i, gi) in g.iter_mut().enumerate().take(dim) {
                *gi += DECAY * w[i];
            }
            for i in 0..=dim {
                m[i] = b1 * m[i] + (1.0 - b1) * g[i];
                v[i] = b2 * v[i] + (1.0 - b2) * g[i] * g[i];
                let step = RATE * (m[i] / (1.0 - b1.powi(t as i32))) / ((v[i] / (1.0 - b2.powi(t as i32))).sqrt() + 1e-8);
                if i < dim {
                    w[i] -= step;
                } else {
                    b -= step;
                }
            }
        }
    }
    (w, b)
}

/// How sure an item carries a tag: what was learned of it, and while it is young its name.
/// `words`: the cosine of the item with the tag's name. Returns the probability and whether
/// the examples (rather than the name) had the most say.
pub fn blend(learned: Option<f32>, yes: usize, words: Option<f32>, embedder: &str) -> Option<(f32, bool)> {
    let words = words.map(|c| words_logit(embedder, c));
    match (learned, words) {
        (Some(l), Some(wl)) if yes < YOUNG => {
            let k = yes as f32 / YOUNG as f32;
            Some((sigmoid(k * l + (1.0 - k) * wl.max(WORDS_FLOOR)), k >= 0.5))
        }
        (Some(l), _) => Some((sigmoid(l), true)),
        (None, Some(wl)) => Some((sigmoid(wl), false)),
        (None, None) => None,
    }
}

/// Learned tags, kept until what they learned from changes.
#[derive(Default)]
pub struct Cache {
    models: HashMap<String, (u64, std::sync::Arc<Option<Model>>)>,
    kinds: Option<(u64, std::sync::Arc<Kinds>)>,
}

impl Cache {
    /// The library's kinds, worked out again as the index grows.
    pub fn kinds(&mut self, ix: &Index) -> std::sync::Arc<Kinds> {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (&ix.embedder, ix.len() / 200, ix.anime_dim()).hash(&mut h);
        let sig = h.finish();
        match &self.kinds {
            Some((s, k)) if *s == sig => k.clone(),
            _ => {
                let k = std::sync::Arc::new(kinds(ix));
                self.kinds = Some((sig, k.clone()));
                k
            }
        }
    }

    /// What was learned of a tag (`id`: its mode and id), if its examples are as they were (`sig`).
    pub fn lookup(&self, id: &str, sig: u64) -> Option<std::sync::Arc<Option<Model>>> {
        self.models.get(id).filter(|(s, _)| *s == sig).map(|(_, m)| m.clone())
    }

    pub fn store(&mut self, id: String, sig: u64, model: Option<Model>) -> std::sync::Arc<Option<Model>> {
        let m = std::sync::Arc::new(model);
        self.models.insert(id, (sig, m.clone()));
        m
    }

    pub fn clear(&mut self) {
        self.models.clear();
        self.kinds = None;
    }
}

/// What a tag's model was learned from, roughly: its examples that are indexed, and the index's
/// size and models. The same: no need to learn again.
pub fn signature(ix: &Index, yes: &[String], no: &[String]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (&ix.embedder, ix.len() / 200, ix.anime_dim()).hash(&mut h);
    let mut ks: Vec<&String> = yes.iter().filter(|k| ix.has(k) || k.starts_with("album:")).collect();
    ks.sort();
    ks.hash(&mut h);
    0u8.hash(&mut h);
    let mut ns: Vec<&String> = no.iter().filter(|k| ix.has(k) || k.starts_with("album:")).collect();
    ns.sort();
    ns.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tagindex::Stamp;
    use std::path::Path;

    const S: Stamp = Stamp { s: 1, m: 1 };

    /// A direction with some wobble: `d` near `centre`.
    fn near(centre: &[f32], i: usize) -> Vec<f32> {
        centre.iter().enumerate().map(|(j, c)| c + 0.15 * (((i * 7 + j * 13) % 11) as f32 / 11.0 - 0.5)).collect()
    }

    fn library() -> (Index, Vec<String>) {
        let mut ix = Index::new(Path::new("/r"), "siglip2", "pixai");
        let mut keys = vec![];
        // Cats near e0, dogs near e1, beaches near e2, 30 of each.
        for (name, c) in [("cat", [1.0, 0.0, 0.0, 0.2]), ("dog", [0.0, 1.0, 0.0, 0.2]), ("beach", [0.0, 0.0, 1.0, 0.2])] {
            for i in 0..30 {
                let k = format!("{name}{i}");
                ix.put(&k, Some(&near(&c, i)), &[], None, None, S);
                keys.push(k);
            }
        }
        (ix, keys)
    }

    fn p(m: &Model, ix: &Index, k: &str) -> f32 {
        sigmoid(m.logit(ix, k, &Groups::new()).unwrap())
    }

    #[test]
    fn learns_a_tag_from_a_few_examples_and_is_sure_where_it_should_be() {
        let (ix, all) = library();
        let yes: Vec<String> = (0..5).map(|i| format!("cat{i}")).collect();
        let m = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "pets/cat", &yes, &[], &all).unwrap();
        assert!(p(&m, &ix, "cat20") > 0.8, "an untagged cat: {}", p(&m, &ix, "cat20"));
        assert!(p(&m, &ix, "dog3") < 0.2 && p(&m, &ix, "beach9") < 0.2);
    }

    #[test]
    fn what_is_turned_down_teaches_it() {
        let (mut ix, mut all) = library();
        // Cats on the beach: mostly cat, so suggested, but they aren't what "cat" means here.
        for i in 0..10 {
            let k = format!("catbeach{i}");
            ix.put(&k, Some(&near(&[0.95, 0.0, 0.3, 0.2], i)), &[], None, None, S);
            all.push(k);
        }
        let yes: Vec<String> = (0..6).map(|i| format!("cat{i}")).collect();
        let before = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "pets/cat", &yes, &[], &all).unwrap();
        let no: Vec<String> = (0..4).map(|i| format!("catbeach{i}")).collect();
        let after = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "pets/cat", &yes, &no, &all).unwrap();
        // The other cat-on-the-beach pictures (not turned down themselves) are no longer suggested.
        let (b, a) = (p(&before, &ix, "catbeach8"), p(&after, &ix, "catbeach8"));
        assert!(b > 0.5 && a < 0.5 && a < b - 0.2, "{b} → {a}");
        assert!(p(&after, &ix, "cat25") > 0.7);
    }

    #[test]
    fn finds_it_in_a_crop_or_a_frame() {
        let (mut ix, all) = library();
        // A beach picture with a cat in a corner, and a video whose second frame shows a cat.
        ix.put("beach-with-cat", Some(&near(&[0.0, 0.0, 1.0, 0.2], 3)), &[near(&[1.0, 0.0, 0.0, 0.2], 9)], None, None, S);
        ix.put("clip", Some(&near(&[0.3, 0.0, 0.95, 0.2], 4)), &[near(&[0.0, 0.0, 1.0, 0.2], 1), near(&[1.0, 0.0, 0.1, 0.2], 2)], None, None, S);
        let yes: Vec<String> = (0..8).map(|i| format!("cat{i}")).collect();
        let m = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "pets/cat", &yes, &[], &all).unwrap();
        assert!(p(&m, &ix, "beach-with-cat") > 0.5, "{}", p(&m, &ix, "beach-with-cat"));
        assert!(p(&m, &ix, "clip") > 0.5, "{}", p(&m, &ix, "clip"));
        // Still less sure than a picture that is all cat.
        assert!(p(&m, &ix, "beach-with-cat") < p(&m, &ix, "cat29"));
    }

    #[test]
    fn uses_the_anime_taggers_view_where_it_looked() {
        let mut ix = Index::new(Path::new("/r"), "siglip2", "pixai");
        let mut all = vec![];
        // Two characters the picture model can't tell apart; the tagger's vectors can.
        for i in 0..40 {
            let k = format!("p{i}");
            let anime = if i % 2 == 0 { [1.0, 0.0] } else { [0.0, 1.0] };
            ix.put(&k, Some(&near(&[0.5, 0.5, 0.5, 0.5], i)), &[], Some(&[]), Some(&anime), S);
            all.push(k);
        }
        let yes: Vec<String> = (0..10).map(|i| format!("p{}", i * 2)).collect();
        let m = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "chars/a", &yes, &[], &all).unwrap();
        assert!(p(&m, &ix, "p30") > 0.7 && p(&m, &ix, "p31") < 0.3, "{} {}", p(&m, &ix, "p30"), p(&m, &ix, "p31"));
    }

    /// Photos, and manga of two kinds of content: every manga page shares a look (and the anime
    /// tagger's view of it shares a lot too), its content is what differs.
    fn manga_and_photos() -> (Index, Vec<String>) {
        let mut ix = Index::new(Path::new("/r"), "siglip2", "pixai");
        let mut all = vec![];
        for i in 0..60 {
            let (k, main, anime) = match i % 3 {
                // [manga look, content A, content B, photo content 1, photo content 2, …]
                0 => (format!("photo{i}"), near(&[0.0, 0.0, 0.0, if i % 2 == 0 { 1.0 } else { 0.0 }, if i % 2 == 0 { 0.0 } else { 1.0 }, 0.3], i), None),
                1 => (format!("mangaA{i}"), near(&[1.0, 0.45, 0.0, 0.0, 0.0, 0.3], i), Some(near(&[1.0, 0.5, 0.0, 0.2], i))),
                _ => (format!("mangaB{i}"), near(&[1.0, 0.0, 0.45, 0.0, 0.0, 0.3], i), Some(near(&[1.0, 0.0, 0.5, 0.2], i))),
            };
            let seen: &[(usize, f32)] = &[];
            ix.put(&k, Some(&main), &[], Some(seen), anime.as_deref(), S);
            all.push(k);
        }
        (ix, all)
    }

    #[test]
    fn a_first_manga_teaches_its_content_not_that_it_is_manga() {
        let (ix, all) = manga_and_photos();
        let mean = |m: &Model, prefix: &str| {
            let ks: Vec<&String> = all.iter().filter(|k| k.starts_with(prefix)).skip(1).collect();
            ks.iter().map(|k| p(m, &ix, k)).sum::<f32>() / ks.len() as f32
        };
        for n in [1, 3] {
            let yes: Vec<String> = all.iter().filter(|k| k.starts_with("mangaA")).take(n).cloned().collect();
            let m = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "chars/a", &yes, &[], &all).unwrap();
            let (a, b, ph) = (mean(&m, "mangaA"), mean(&m, "mangaB"), mean(&m, "photo"));
            println!("{n} tagged: same content {a:.2}, other manga {b:.2}, photos {ph:.2}");
            // Other manga isn't suggested for being manga.
            assert!(b < 0.3 && a > b + 0.3, "{n}: same content {a}, other manga {b}");
            assert!(ph < 0.2);
        }
    }

    #[test]
    fn a_tag_only_ever_on_drawn_pictures_is_kept_off_photos_more_firmly_as_examples_agree() {
        let (ix, all) = manga_and_photos();
        let k = std::sync::Arc::new(kinds(&ix));
        let some = |n: usize| all.iter().filter(|x| x.starts_with("mangaA")).take(n).cloned().collect::<Vec<_>>();
        let (one, many) = (train(&ix, &Groups::new(), &k, "chars/a", &some(1), &[], &all).unwrap(), train(&ix, &Groups::new(), &k, "chars/a", &some(15), &[], &all).unwrap());
        // One manga says little about photos; fifteen say a lot.
        assert!(one.photo > -0.5 && many.photo < -1.2, "{} {}", one.photo, many.photo);
        let mean = |m: &Model, prefix: &str| {
            let ks: Vec<&String> = all.iter().filter(|x| x.starts_with(prefix)).collect();
            ks.iter().map(|x| p(m, &ix, x)).sum::<f32>() / ks.len() as f32
        };
        println!("fifteen tagged: photos {:.2}, other manga {:.2}", mean(&many, "photo"), mean(&many, "mangaB"));
        assert!(mean(&many, "photo") < 0.1 && mean(&many, "mangaB") < 0.2);
    }

    #[test]
    fn a_young_tag_leans_on_its_name_and_never_is_sure_by_it_alone() {
        // No examples: the name alone, capped.
        let (p0, examples) = blend(None, 0, Some(0.25), "siglip2").unwrap();
        assert!(!examples && p0 <= WORDS_MAX + 1e-3 && p0 > 0.5);
        assert!(blend(None, 0, Some(0.02), "siglip2").unwrap().0 < 0.05);
        // With a few examples, they take over: the name no longer counts.
        let (p1, examples) = blend(Some(4.0), 3, Some(0.02), "siglip2").unwrap();
        assert!(examples && p1 > 0.95);
        // With one, both count.
        let (p3, _) = blend(Some(4.0), 1, Some(0.02), "siglip2").unwrap();
        assert!(p3 < p1 && p3 > 0.05);
        let (p2, _) = blend(Some(-4.0), 20, Some(0.3), "siglip2").unwrap();
        assert!(p2 < 0.05);
        assert!(blend(None, 0, None, "siglip2").is_none());
    }

    #[test]
    fn learns_again_only_when_its_examples_change() {
        let (ix, _) = library();
        let yes: Vec<String> = (0..5).map(|i| format!("cat{i}")).collect();
        let more: Vec<String> = (0..6).map(|i| format!("cat{i}")).collect();
        let mut cache = Cache::default();
        let sig = signature(&ix, &yes, &[]);
        assert!(cache.lookup("images|pets/cat", sig).is_none());
        cache.store("images|pets/cat".into(), sig, None);
        assert!(cache.lookup("images|pets/cat", signature(&ix, &yes, &[])).is_some());
        assert!(cache.lookup("images|pets/cat", signature(&ix, &more, &[])).is_none());
        // Something not indexed changes nothing.
        let unknown = [yes.clone(), vec!["nowhere".to_string()]].concat();
        assert_eq!(signature(&ix, &unknown, &[]), sig);
    }

    /// On real SigLIP 2 vectors (made by the engine from public cats-and-dogs photos):
    /// `LEARN_DEMO=indexed.json cargo test --lib learn::tests::on_real_pictures -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn on_real_pictures() {
        let Ok(path) = std::env::var("LEARN_DEMO") else { return };
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut ix = Index::new(Path::new("/r"), "siglip2", "pixai");
        let floats = |x: &serde_json::Value| x.as_array().unwrap().iter().map(|f| f.as_f64().unwrap() as f32).collect::<Vec<f32>>();
        let mut all: Vec<String> = vec![];
        for (k, it) in v["items"].as_object().unwrap() {
            let parts: Vec<Vec<f32>> = it["parts"].as_array().unwrap().iter().map(floats).collect();
            ix.put(k, Some(&floats(&it["embedding"])), &parts, Some(&[]), None, S);
            all.push(k.clone());
        }
        all.sort();
        let cats: Vec<String> = all.iter().filter(|k| k.starts_with("cat")).cloned().collect();
        let dogs: Vec<String> = all.iter().filter(|k| k.starts_with("dog")).cloned().collect();
        let mean = |m: &Model, keys: &[String]| keys.iter().map(|k| p(m, &ix, k)).sum::<f32>() / keys.len() as f32;
        let worst = |m: &Model, keys: &[String], hi: bool| keys.iter().map(|k| p(m, &ix, k)).fold(if hi { 1.0 } else { 0.0 }, |a: f32, b| if hi { a.min(b) } else { a.max(b) });
        for n in [1, 3, 5, 10] {
            let m = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "pets/cat", &cats[..n], &[], &all).unwrap();
            let (held_cats, held_dogs) = (&cats[n..], &dogs[..]);
            println!("{n:2} cats tagged: untagged cats {:.2} (lowest {:.2}), dogs {:.2} (highest {:.2})", mean(&m, held_cats), worst(&m, held_cats, true), mean(&m, held_dogs), worst(&m, held_dogs, false));
            if n >= 3 {
                assert!(mean(&m, held_cats) > 0.7 && mean(&m, held_dogs) < 0.3);
            }
        }
        // A young tag: its name, with and without one example.
        let w = floats(&v["words"]["a photo of cat"]);
        let by_name = |k: &String| blend(None, 0, ix.likeness(k, &Groups::new(), &w), "siglip2").unwrap().0;
        let (nc, nd) = (cats.iter().map(by_name).sum::<f32>() / 30.0, dogs.iter().map(by_name).sum::<f32>() / 30.0);
        println!("by the name alone: cats {nc:.2}, dogs {nd:.2}");
        assert!(nc > nd + 0.2);
        // A name that says nothing of the pictures ("grandma") doesn't stop one example from teaching.
        let g = floats(&v["words"]["a photo of grandma"]);
        let m = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "people/grandma", &cats[..1], &[], &all).unwrap();
        let with = |k: &String| blend(m.logit(&ix, k, &Groups::new()), 1, ix.likeness(k, &Groups::new(), &g), "siglip2").unwrap().0;
        let (gc, gd) = (cats[1..].iter().map(with).sum::<f32>() / 29.0, dogs.iter().map(with).sum::<f32>() / 30.0);
        println!("one example, unhelpful name: cats {gc:.2}, dogs {gd:.2}");
        assert!(gc > gd);
    }

    /// How long learning a tag takes at full size: `cargo test --release --lib learn::tests::timing -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn timing() {
        let mut ix = Index::new(Path::new("/r"), "siglip2", "pixai");
        let v = |i: usize, n: usize| (0..n).map(|j| (((i * 31 + j * 17) % 97) as f32 / 97.0 - 0.5) + if j == i % 7 { 2.0 } else { 0.0 }).collect::<Vec<f32>>();
        let mut all = vec![];
        for i in 0..3000 {
            let k = format!("k{i}");
            ix.put(&k, Some(&v(i, 768)), &[v(i + 1, 768), v(i + 2, 768)], Some(&[]), Some(&v(i, 1024)), S);
            all.push(k);
        }
        let yes: Vec<String> = all.iter().step_by(7).cloned().collect();
        let no: Vec<String> = all.iter().skip(3).step_by(11).take(300).cloned().collect();
        let t = std::time::Instant::now();
        let m = train(&ix, &Groups::new(), &std::sync::Arc::new(kinds(&ix)), "t", &yes, &no, &all).unwrap();
        println!("learned from {} yes, {} no: {:?}", yes.len(), no.len(), t.elapsed());
        let t = std::time::Instant::now();
        for k in &all {
            m.logit(&ix, k, &Groups::new());
        }
        println!("scored {} items: {:?}", all.len(), t.elapsed());
    }
}
