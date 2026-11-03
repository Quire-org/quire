//! Small copies of pictures for the grids. A tile shows a picture a few hundred
//! pixels wide; decoding a 40-megapixel original for it is what made scrolling
//! heavy. Thumbnails are made on demand and kept in memory only (never on disk
//! for plain folders); inside an open vault they are also kept encrypted, so
//! reopening the vault doesn't make them again.

use crate::preview;
use image::{DynamicImage, ImageFormat};
use std::collections::{HashMap, VecDeque};
use std::io::Cursor;
use std::sync::{Arc, Condvar, Mutex, OnceLock};

/// The widths thumbnails are made at: a requested width goes up to the next one,
/// so nearby tile sizes share one copy.
pub const WIDTHS: [u32; 5] = [192, 320, 480, 720, 1024];

pub fn bucket(w: u32) -> u32 {
    WIDTHS.iter().copied().find(|&b| b >= w).unwrap_or(WIDTHS[WIDTHS.len() - 1])
}

pub struct Thumb {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

impl Thumb {
    pub fn from_stored(bytes: Vec<u8>) -> Thumb {
        let mime = if bytes.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" };
        Thumb { bytes, mime }
    }
}

/// A picture's bytes (the file as stored) to a thumbnail `width` wide, turned
/// the way the camera says. Raw files use the preview embedded in them.
pub fn make(bytes: &[u8], is_raw: bool, width: u32) -> Result<Thumb, String> {
    let orientation = orientation_of(bytes);
    let img = if is_raw {
        let jpeg = preview::embedded_jpeg_bytes(bytes)?;
        image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg)
    } else {
        image::load_from_memory(bytes)
    }
    .map_err(|e| e.to_string())?;
    // Shrink before turning (turning a full-size picture is slow); for a quarter turn
    // the side that ends up as the width is the height now.
    let sideways = matches!(orientation, 5..=8);
    let img = if sideways {
        if img.height() > width { img.thumbnail(u32::MAX, width) } else { img }
    } else if img.width() > width {
        img.thumbnail(width, u32::MAX)
    } else {
        img
    };
    let mut img = img;
    if let Some(o) = image::metadata::Orientation::from_exif(orientation) {
        img.apply_orientation(o);
    }
    encode(img)
}

/// The sides face crops are made at: a requested side goes up to the next one.
pub const FACE_SIDES: [u32; 5] = [64, 128, 256, 384, 512];

pub fn face_side(w: u32) -> u32 {
    FACE_SIDES.iter().copied().find(|&b| b >= w).unwrap_or(FACE_SIDES[FACE_SIDES.len() - 1])
}

/// A face cut out of a picture, for the People screen: the square `around` times the face's box
/// (fractions of the picture the right way up, as the face finder saw it), moved inside the picture
/// where it fits, at most `side` pixels. Only that square is cut, shrunk and turned, so the webview
/// gets a small image instead of the whole picture. Raw files: the preview embedded in them, turned
/// as that preview says (what the face finder was given).
pub fn face(bytes: &[u8], is_raw: bool, bbox: [f32; 4], around: f32, side: u32) -> Result<Thumb, String> {
    let jpeg;
    let bytes = if is_raw {
        jpeg = preview::embedded_jpeg_bytes(bytes)?;
        &jpeg[..]
    } else {
        bytes
    };
    let orientation = orientation_of(bytes);
    let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    // The picture's size the right way up.
    let (uw, uh) = if matches!(orientation, 5..=8) { (h, w) } else { (w, h) };
    let [x0, y0, x1, y1] = bbox;
    let s = (((x1 - x0) * uw as f32).max((y1 - y0) * uh as f32) * around).min(uw.min(uh) as f32).max(1.0);
    let n = (s.round() as u32).clamp(1, uw.min(uh));
    let place = |centre: f32, extent: u32| ((centre * extent as f32 - n as f32 / 2.0).round().max(0.0) as u32).min(extent - n);
    let (l, t) = (place((x0 + x1) / 2.0, uw), place((y0 + y1) / 2.0, uh));
    let (sx, sy, sw, sh) = stored_rect(orientation, w, h, (l, t, n, n));
    let mut cut = img.crop_imm(sx, sy, sw, sh);
    if n > side {
        cut = cut.thumbnail(side, side);
    }
    if let Some(o) = image::metadata::Orientation::from_exif(orientation) {
        cut.apply_orientation(o);
    }
    encode(cut)
}

/// Where a rectangle of the picture the right way up (left, top, width, height) lies in the picture
/// as stored (`w` × `h`), turned or flipped the way the EXIF orientation says.
fn stored_rect(orientation: u8, w: u32, h: u32, (u, v, rw, rh): (u32, u32, u32, u32)) -> (u32, u32, u32, u32) {
    match orientation {
        2 => (w - u - rw, v, rw, rh),
        3 => (w - u - rw, h - v - rh, rw, rh),
        4 => (u, h - v - rh, rw, rh),
        5 => (v, u, rh, rw),
        6 => (v, h - u - rw, rh, rw),
        7 => (w - v - rh, h - u - rw, rh, rw),
        8 => (w - v - rh, u, rh, rw),
        _ => (u, v, rw, rh),
    }
}

fn orientation_of(bytes: &[u8]) -> u8 {
    exif::Reader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok()
        .and_then(|r| r.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)))
        .map(|v| v as u8)
        .unwrap_or(1)
}

pub fn encode(img: DynamicImage) -> Result<Thumb, String> {
    let mut out = Vec::new();
    if img.color().has_alpha() {
        // Keeps transparency; small at these sizes.
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).map_err(|e| e.to_string())?;
        return Ok(Thumb { bytes: out, mime: "image/png" });
    }
    let rgb = img.to_rgb8();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82).encode_image(&rgb).map_err(|e| e.to_string())?;
    Ok(Thumb { bytes: out, mime: "image/jpeg" })
}

/* ---------------- memory cache ---------------- */

/// What the thumbnails in memory may take, at most.
const BUDGET: usize = 256 << 20;

#[derive(Default)]
struct Cache {
    map: HashMap<String, Arc<Thumb>>,
    /// Oldest first; the first ones go when the budget is reached.
    order: VecDeque<String>,
    bytes: usize,
}

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// The key a thumbnail is kept under: the file, its size and time (an edited file is a new
/// key), and the width.
pub fn key(path: &str, size: u64, modified: u64, width: u32) -> String {
    format!("{path}|{size}|{modified}|{width}")
}

pub fn cached(key: &str) -> Option<Arc<Thumb>> {
    cache().lock().unwrap_or_else(|p| p.into_inner()).map.get(key).cloned()
}

pub fn keep(key: String, t: Arc<Thumb>) {
    let mut c = cache().lock().unwrap_or_else(|p| p.into_inner());
    if c.map.contains_key(&key) {
        return;
    }
    c.bytes += t.bytes.len();
    c.order.push_back(key.clone());
    c.map.insert(key, t);
    while c.bytes > BUDGET {
        let Some(old) = c.order.pop_front() else { break };
        if let Some(gone) = c.map.remove(&old) {
            c.bytes -= gone.bytes.len();
        }
    }
}

/* ---------------- how many at once ---------------- */

/// Decoding takes a core and the full picture's memory: only so many at once, the
/// rest wait their turn instead of all starting together when a grid opens.
pub struct Slot;

static SLOTS: (Mutex<usize>, Condvar) = (Mutex::new(0), Condvar::new());

fn max_slots() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8)
}

impl Slot {
    pub fn take() -> Slot {
        let (lock, cv) = &SLOTS;
        let mut n = lock.lock().unwrap_or_else(|p| p.into_inner());
        while *n >= max_slots() {
            n = cv.wait(n).unwrap_or_else(|p| p.into_inner());
        }
        *n += 1;
        Slot
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let (lock, cv) = &SLOTS;
        *lock.lock().unwrap_or_else(|p| p.into_inner()) -= 1;
        cv.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(w, h, |x, _| if x < w / 2 { Rgb([255, 0, 0]) } else { Rgb([0, 0, 255]) });
        let mut out = Vec::new();
        DynamicImage::ImageRgb8(img).write_to(&mut Cursor::new(&mut out), ImageFormat::Jpeg).unwrap();
        out
    }

    #[test]
    fn shrinks_to_the_width_and_keeps_the_shape() {
        let t = make(&jpeg(2000, 1000), false, 320).unwrap();
        assert_eq!(t.mime, "image/jpeg");
        let back = image::load_from_memory(&t.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (320, 160));
    }

    #[test]
    fn leaves_small_pictures_their_size() {
        let back = image::load_from_memory(&make(&jpeg(100, 50), false, 320).unwrap().bytes).unwrap();
        assert_eq!((back.width(), back.height()), (100, 50));
    }

    #[test]
    fn keeps_transparency_as_png() {
        let img = RgbaImage::from_pixel(600, 600, Rgba([0, 0, 0, 0]));
        let mut png = Vec::new();
        DynamicImage::ImageRgba8(img).write_to(&mut Cursor::new(&mut png), ImageFormat::Png).unwrap();
        let t = make(&png, false, 192).unwrap();
        assert_eq!(t.mime, "image/png");
        assert_eq!(image::load_from_memory(&t.bytes).unwrap().width(), 192);
    }

    #[test]
    fn rejects_what_is_not_a_picture() {
        assert!(make(b"not a picture", false, 320).is_err());
    }

    #[test]
    fn a_rectangle_the_right_way_up_is_found_in_the_picture_as_stored() {
        // A picture as stored with one marked block; each turn shows it somewhere else.
        let (w, h) = (40u32, 30u32);
        let block = (5u32, 7u32, 9u32, 4u32);
        let stored = RgbImage::from_fn(w, h, |x, y| if (block.0..block.0 + block.2).contains(&x) && (block.1..block.1 + block.3).contains(&y) { Rgb([255, 255, 255]) } else { Rgb([0, 0, 0]) });
        for o in 1..=8u8 {
            let mut shown = DynamicImage::ImageRgb8(stored.clone());
            shown.apply_orientation(image::metadata::Orientation::from_exif(o).unwrap());
            let shown = shown.to_rgb8();
            let marked: Vec<(u32, u32)> = shown.enumerate_pixels().filter(|p| p.2[0] > 128).map(|p| (p.0, p.1)).collect();
            let (u, v) = (marked.iter().map(|p| p.0).min().unwrap(), marked.iter().map(|p| p.1).min().unwrap());
            let (rw, rh) = (marked.iter().map(|p| p.0).max().unwrap() - u + 1, marked.iter().map(|p| p.1).max().unwrap() - v + 1);
            assert_eq!(stored_rect(o, w, h, (u, v, rw, rh)), block, "orientation {o}");
        }
    }

    #[test]
    fn cuts_the_face_out_and_keeps_inside_the_picture() {
        // Red on the left half, blue on the right: a face near the right edge comes out blue, square.
        let t = face(&jpeg(2000, 1000), false, [0.9, 0.4, 0.98, 0.6], 2.0, 128).unwrap();
        let back = image::load_from_memory(&t.bytes).unwrap().to_rgb8();
        assert_eq!((back.width(), back.height()), (128, 128));
        let p = back.get_pixel(64, 64);
        assert!(p[2] > 200 && p[0] < 60, "{p:?}");
        // Bigger than the picture can give: as big as fits.
        let t = face(&jpeg(300, 200), false, [0.4, 0.4, 0.6, 0.6], 9.0, 512).unwrap();
        let back = image::load_from_memory(&t.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (200, 200));
    }

    #[test]
    fn face_sides_round_up() {
        assert_eq!(face_side(100), 128);
        assert_eq!(face_side(9000), 512);
    }

    #[test]
    fn widths_round_up_to_a_bucket() {
        assert_eq!(bucket(100), 192);
        assert_eq!(bucket(321), 480);
        assert_eq!(bucket(5000), 1024);
    }

    #[test]
    fn the_cache_lets_the_oldest_go_past_its_budget() {
        let big = Arc::new(Thumb { bytes: vec![0; BUDGET / 2 + 1], mime: "image/jpeg" });
        keep("t-a".into(), big.clone());
        keep("t-b".into(), big);
        assert!(cached("t-a").is_none());
        assert!(cached("t-b").is_some());
    }
}
