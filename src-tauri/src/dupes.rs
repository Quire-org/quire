//! Fingerprints for duplicate detection.
//!
//! * `file_fingerprint`: cheap content hash (size + head/middle/tail chunks) to
//!   catch byte-identical copies of any file, including large videos.
//! * `image_hash`: perceptual hashes (pHash via DCT, dHash via gradients) of a
//!   downscaled grayscale rendition, so re-encoded, resized or slightly edited
//!   images still match. RAW files are hashed through their embedded preview.

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView};
use serde::Serialize;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageHash {
    /// 64-bit hashes as 16 hex chars (JSON numbers cannot hold 64 bits).
    pub phash: String,
    pub dhash: String,
    pub width: u32,
    pub height: u32,
}

const CHUNK: usize = 1024 * 1024;

pub fn file_fingerprint(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    fingerprint_with(size, |off, buf| {
        f.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
        let mut read = 0;
        while read < buf.len() {
            let n = f.read(&mut buf[read..]).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            read += n;
        }
        Ok(read)
    })
}

/// Fingerprint over any random-access source: size + hashed head, middle and tail chunks.
pub fn fingerprint_with(size: u64, mut read_at: impl FnMut(u64, &mut [u8]) -> Result<usize, String>) -> Result<String, String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    size.hash(&mut h);
    let mut buf = vec![0u8; CHUNK];
    let offsets: Vec<u64> = if size <= 3 * CHUNK as u64 { vec![0] } else { vec![0, size / 2 - CHUNK as u64 / 2, size - CHUNK as u64] };
    for off in offsets {
        let n = read_at(off, &mut buf)?;
        buf[..n].hash(&mut h);
    }
    Ok(format!("{size:x}-{:016x}", h.finish()))
}

pub fn image_hash(path: &Path, is_raw: bool) -> Result<ImageHash, String> {
    let img = if is_raw {
        let bytes = crate::preview::embedded_jpeg(path)?;
        image::load_from_memory(&bytes).map_err(|e| e.to_string())?
    } else {
        image::ImageReader::open(path)
            .map_err(|e| e.to_string())?
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .decode()
            .map_err(|e| format!("decode: {e}"))?
    };
    Ok(hash_image(&img))
}

pub fn image_hash_bytes(bytes: &[u8], is_raw: bool) -> Result<ImageHash, String> {
    let img = if is_raw {
        image::load_from_memory(&crate::preview::embedded_jpeg_bytes(bytes)?).map_err(|e| e.to_string())?
    } else {
        image::load_from_memory(bytes).map_err(|e| format!("decode: {e}"))?
    };
    Ok(hash_image(&img))
}

fn hash_image(img: &DynamicImage) -> ImageHash {
    let (width, height) = img.dimensions();
    ImageHash { phash: format!("{:016x}", phash(img)), dhash: format!("{:016x}", dhash(img)), width, height }
}

/// pHash: 32x32 grayscale -> DCT -> top-left 8x8 (minus DC) compared to median.
fn phash(img: &DynamicImage) -> u64 {
    const N: usize = 32;
    let small = img.resize_exact(N as u32, N as u32, FilterType::Triangle).to_luma8();
    let px: Vec<f64> = small.pixels().map(|p| p.0[0] as f64).collect();

    // Precompute cosine table.
    let mut cos = vec![0f64; N * N];
    for u in 0..N {
        for x in 0..N {
            cos[u * N + x] = (((2 * x + 1) as f64) * u as f64 * std::f64::consts::PI / (2.0 * N as f64)).cos();
        }
    }
    // Separable 2D DCT, only the 8x8 low-frequency block is needed.
    let mut rows = vec![0f64; N * 8];
    for y in 0..N {
        for u in 0..8 {
            let mut s = 0.0;
            for x in 0..N {
                s += px[y * N + x] * cos[u * N + x];
            }
            rows[y * 8 + u] = s;
        }
    }
    let mut dct = [0f64; 64];
    for v in 0..8 {
        for u in 0..8 {
            let mut s = 0.0;
            for y in 0..N {
                s += rows[y * 8 + u] * cos[v * N + y];
            }
            dct[v * 8 + u] = s;
        }
    }
    let mut vals: Vec<f64> = dct[1..].to_vec();
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = (vals[31] + vals[32]) / 2.0;
    let mut bits = 0u64;
    for (i, v) in dct.iter().enumerate().skip(1) {
        if *v > median {
            bits |= 1 << (63 - i);
        }
    }
    bits
}

/// dHash: 9x8 grayscale, bit = left pixel brighter than right neighbour.
fn dhash(img: &DynamicImage) -> u64 {
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut bits = 0u64;
    let mut i = 0;
    for y in 0..8 {
        for x in 0..8 {
            if small.get_pixel(x, y).0[0] > small.get_pixel(x + 1, y).0[0] {
                bits |= 1 << (63 - i);
            }
            i += 1;
        }
    }
    bits
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;

    /// Textured test image: deterministic pseudo-random 20x15 blocks, smoothed,
    /// so the DCT has real mid-frequency content like a photo.
    fn textured(w: u32, h: u32, seed: u32) -> DynamicImage {
        let mut cells = vec![0u8; 20 * 15];
        let mut x = seed.wrapping_mul(2654435761).wrapping_add(12345);
        for c in cells.iter_mut() {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            *c = (x >> 24) as u8;
        }
        let blocks = DynamicImage::ImageLuma8(
            ImageBuffer::from_fn(20, 15, |cx, cy| image::Luma([cells[(cy * 20 + cx) as usize]])),
        );
        blocks.resize_exact(w, h, FilterType::CatmullRom)
    }

    #[test]
    fn resized_copy_is_close_and_different_image_is_far() {
        let a = textured(400, 300, 1);
        let a_small = a.resize_exact(160, 120, FilterType::Lanczos3);
        let b = textured(400, 300, 2);
        let d_same = (phash(&a) ^ phash(&a_small)).count_ones();
        let d_diff = (phash(&a) ^ phash(&b)).count_ones();
        assert!(d_same <= 6, "resized copy distance {d_same}");
        assert!(d_diff > 12, "different image distance {d_diff}");
    }

    #[test]
    fn fingerprint_matches_identical_bytes_only() {
        let d = std::env::temp_dir();
        let p1 = d.join(format!("ms-fp1-{}", std::process::id()));
        let p2 = d.join(format!("ms-fp2-{}", std::process::id()));
        let p3 = d.join(format!("ms-fp3-{}", std::process::id()));
        std::fs::write(&p1, vec![7u8; 5_000_000]).unwrap();
        std::fs::write(&p2, vec![7u8; 5_000_000]).unwrap();
        let mut v = vec![7u8; 5_000_000];
        v[2_500_000] = 8;
        std::fs::write(&p3, v).unwrap();
        assert_eq!(file_fingerprint(&p1).unwrap(), file_fingerprint(&p2).unwrap());
        assert_ne!(file_fingerprint(&p1).unwrap(), file_fingerprint(&p3).unwrap());
        for p in [p1, p2, p3] {
            let _ = std::fs::remove_file(p);
        }
    }
}
