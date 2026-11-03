//! Faces in pictures, for People. Real people in photos: SCRFD finds each face and five points on
//! it (the eyes, the nose, the corners of the mouth), the face is turned upright to those points,
//! and AuraFace (Apache 2.0, fal) gives its 512 numbers, close together for the same person's
//! faces. Characters in drawings: deepghs' anime face detector (YOLOv8, MIT) finds the face, and
//! CCIP (deepghs, OpenRAIL; caformer_b36-24) gives 768 numbers for the character around it, its
//! head and upper body (hair and clothes tell a character as much as the face). Both come out unit length: faces compare by their dot product.
//! ONNX on the CPU, like the tagger; on the GPU when converted for it (`tools/face_gpu.py`), the
//! same models made from the same weights, many times faster.

use std::path::Path;

use anyhow::{Context as _, Result, anyhow};
use image::{DynamicImage, RgbImage, imageops::FilterType};
use ort::{session::Session, value::Tensor};
use serde::Serialize;

use crate::tagging::OnGpu;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum FaceKind {
    Photo,
    Drawn,
}

#[derive(Serialize, Debug)]
pub struct Face {
    pub kind: FaceKind,
    /// Where it is, in fractions of the upright picture: left, top, right, bottom.
    pub bbox: [f32; 4],
    pub score: f32,
    /// How wide it is, in pixels of the picture as it was looked at: small faces are less sure.
    pub size: u32,
    /// Unit length.
    pub embedding: Vec<f32>,
}

/// A face found, in pixels, with its five points when the finder gives them.
#[derive(Clone, Debug)]
struct Found {
    bbox: [f32; 4],
    score: f32,
    points: Option<[[f32; 2]; 5]>,
}

const SCRFD_SIZE: usize = 640;
const SCRFD_MIN: f32 = 0.5;
const ANIME_SIZE: usize = 640;
/// deepghs' own threshold for this detector (face_detect_v1.4_s/threshold.json).
const ANIME_MIN: f32 = 0.307;
const CCIP_SIZE: u32 = 384;
const CLIP_MEAN: [f32; 3] = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const CLIP_STD: [f32; 3] = [0.268_629_54, 0.261_302_6, 0.275_777_1];
/// Where ArcFace-style recognisers expect the five points in their 112 × 112 face.
const ARC_POINTS: [[f32; 2]; 5] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
const ARC_SIZE: usize = 112;
/// The models converted for the GPU, as `tools/face_gpu.py` names them: finder, then recogniser.
pub const PHOTO_GPU: [&str; 2] = ["scrfd-10g.pt", "auraface.pt"];
pub const DRAWN_GPU: [&str; 2] = ["anime-face-v1.4s.pt", "ccip-b36.pt"];
/// Faces narrower than this many pixels are left out: too small to tell who they are.
pub const MIN_FACE: f32 = 28.0;

fn run(session: &mut Session, data: Vec<f32>, shape: Vec<usize>) -> Result<Vec<(Vec<i64>, Vec<f32>)>> {
    let input = Tensor::from_array((shape, data)).map_err(|e| anyhow!("{e}"))?;
    let name = session.inputs().first().context("the model has no input")?.name().to_string();
    let outputs = session.run(ort::inputs![name => input]).map_err(|e| anyhow!("{e}"))?;
    outputs
        .iter()
        .map(|(_, v)| {
            let (shape, data) = v.try_extract_tensor::<f32>().map_err(|e| anyhow!("{e}"))?;
            Ok((shape.iter().copied().collect(), data.to_vec()))
        })
        .collect()
}

/// One of the four models: its ONNX file on the CPU, or the same model converted for the GPU.
enum Net {
    Cpu(Session),
    Gpu(OnGpu),
}

impl Net {
    fn load(onnx: &Path, gpu: Option<OnGpu>) -> Result<Net> {
        Ok(match gpu {
            Some(gpu) => Net::Gpu(gpu),
            None => Net::Cpu(crate::tagging::session(onnx)?),
        })
    }

    /// Its outputs for one square picture (RGB planes, `size` pixels a side).
    fn run(&mut self, data: Vec<f32>, size: usize) -> Result<Vec<(Vec<i64>, Vec<f32>)>> {
        match self {
            Net::Cpu(session) => run(session, data, vec![1, 3, size, size]),
            Net::Gpu(gpu) => gpu.outputs(&data, 1, size as u32),
        }
    }
}

/// The models converted for the GPU, any of them: each one missing runs on the CPU.
#[derive(Default)]
pub struct OnGpus {
    pub detector: Option<OnGpu>,
    pub embedder: Option<OnGpu>,
}

fn unit(mut v: Vec<f32>) -> Vec<f32> {
    let n = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-12);
    v.iter_mut().for_each(|x| *x /= n);
    v
}

fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let w = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let h = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let inter = w * h;
    let area = |r: &[f32; 4]| (r[2] - r[0]).max(0.0) * (r[3] - r[1]).max(0.0);
    inter / (area(a) + area(b) - inter).max(1e-6)
}

/// The best of overlapping finds.
fn nms(mut found: Vec<Found>, overlap: f32) -> Vec<Found> {
    found.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Found> = Vec::new();
    for f in found {
        if kept.iter().all(|k| iou(&k.bbox, &f.bbox) <= overlap) {
            kept.push(f);
        }
    }
    kept
}

/// The similarity transform (turn, scale, shift) taking `from` onto `to` most closely:
/// `x' = a·x − b·y + tx`, `y' = b·x + a·y + ty`, as `[a, b, tx, ty]`.
fn similarity(from: &[[f32; 2]; 5], to: &[[f32; 2]; 5]) -> [f32; 4] {
    let mean = |p: &[[f32; 2]; 5]| [p.iter().map(|q| q[0]).sum::<f32>() / 5.0, p.iter().map(|q| q[1]).sum::<f32>() / 5.0];
    let (mf, mt) = (mean(from), mean(to));
    let (mut num_a, mut num_b, mut den) = (0.0, 0.0, 0.0);
    for i in 0..5 {
        let (x, y) = (from[i][0] - mf[0], from[i][1] - mf[1]);
        let (u, v) = (to[i][0] - mt[0], to[i][1] - mt[1]);
        num_a += x * u + y * v;
        num_b += x * v - y * u;
        den += x * x + y * y;
    }
    let (a, b) = (num_a / den.max(1e-6), num_b / den.max(1e-6));
    [a, b, mt[0] - (a * mf[0] - b * mf[1]), mt[1] - (b * mf[0] + a * mf[1])]
}

/// The picture under `m` (see `similarity`) into a `size` × `size` square, sampled smoothly; black outside.
fn warp(img: &RgbImage, m: [f32; 4], size: usize) -> Vec<[f32; 3]> {
    let [a, b, tx, ty] = m;
    let det = (a * a + b * b).max(1e-12);
    let (w, h) = (img.width() as i64, img.height() as i64);
    let px = |x: i64, y: i64| -> [f32; 3] {
        if x < 0 || y < 0 || x >= w || y >= h {
            [0.0; 3]
        } else {
            let p = img.get_pixel(x as u32, y as u32);
            [f32::from(p[0]), f32::from(p[1]), f32::from(p[2])]
        }
    };
    let mut out = Vec::with_capacity(size * size);
    for v in 0..size {
        for u in 0..size {
            let (du, dv) = (u as f32 - tx, v as f32 - ty);
            let (x, y) = ((a * du + b * dv) / det, (-b * du + a * dv) / det);
            let (x0, y0) = (x.floor(), y.floor());
            let (fx, fy) = (x - x0, y - y0);
            let (x0, y0) = (x0 as i64, y0 as i64);
            let (p00, p10, p01, p11) = (px(x0, y0), px(x0 + 1, y0), px(x0, y0 + 1), px(x0 + 1, y0 + 1));
            let mut c = [0.0; 3];
            for k in 0..3 {
                c[k] = p00[k] * (1.0 - fx) * (1.0 - fy) + p10[k] * fx * (1.0 - fy) + p01[k] * (1.0 - fx) * fy + p11[k] * fx * fy;
            }
            out.push(c);
        }
    }
    out
}

/// Real people's faces in photos.
pub struct Photo {
    detector: Net,
    recogniser: Net,
}

impl Photo {
    pub fn load(detector: &Path, recogniser: &Path, gpu: OnGpus) -> Result<Photo> {
        Ok(Photo { detector: Net::load(detector, gpu.detector)?, recogniser: Net::load(recogniser, gpu.embedder)? })
    }

    /// SCRFD: the picture fitted into 640 × 640 (from the top left, the rest left dark), its finds
    /// at three scales of anchors (two per place), each with its box and five points.
    fn find(&mut self, img: &RgbImage) -> Result<Vec<Found>> {
        let (w, h) = (img.width() as f32, img.height() as f32);
        let scale = (SCRFD_SIZE as f32 / w).min(SCRFD_SIZE as f32 / h);
        let (nw, nh) = (((w * scale).round() as u32).max(1), ((h * scale).round() as u32).max(1));
        let small = DynamicImage::ImageRgb8(img.clone()).resize_exact(nw, nh, FilterType::Triangle).to_rgb8();
        let n = SCRFD_SIZE * SCRFD_SIZE;
        let mut data = vec![-127.5 / 128.0; 3 * n];
        for (x, y, p) in small.enumerate_pixels() {
            let i = y as usize * SCRFD_SIZE + x as usize;
            for c in 0..3 {
                data[c * n + i] = (f32::from(p[c]) - 127.5) / 128.0;
            }
        }
        let outputs = self.detector.run(data, SCRFD_SIZE)?;
        // Scores, boxes and points per scale, told apart by how many numbers each anchor has.
        let of = |k: i64| {
            let mut v: Vec<&Vec<f32>> = outputs.iter().filter(|(s, _)| s.last() == Some(&k)).map(|(_, d)| d).collect();
            v.sort_by_key(|d| std::cmp::Reverse(d.len()));
            v
        };
        let (scores, boxes, points) = (of(1), of(4), of(10));
        if scores.len() != 3 || boxes.len() != 3 || points.len() != 3 {
            return Err(anyhow!("the face finder gave {} outputs, not SCRFD's nine", outputs.len()));
        }
        let mut found = Vec::new();
        for (level, stride) in [8usize, 16, 32].into_iter().enumerate() {
            let across = SCRFD_SIZE / stride;
            let s = stride as f32;
            for (i, &score) in scores[level].iter().enumerate() {
                if score < SCRFD_MIN {
                    continue;
                }
                let place = i / 2;
                let (cx, cy) = (((place % across) * stride) as f32, ((place / across) * stride) as f32);
                let b = &boxes[level][i * 4..i * 4 + 4];
                let p = &points[level][i * 10..i * 10 + 10];
                let bbox = [(cx - b[0] * s) / scale, (cy - b[1] * s) / scale, (cx + b[2] * s) / scale, (cy + b[3] * s) / scale];
                let mut pts = [[0.0; 2]; 5];
                for (k, pt) in pts.iter_mut().enumerate() {
                    *pt = [(cx + p[2 * k] * s) / scale, (cy + p[2 * k + 1] * s) / scale];
                }
                found.push(Found { bbox, score, points: Some(pts) });
            }
        }
        Ok(nms(found, 0.4))
    }

    /// The face turned upright to its five points, 112 × 112, and AuraFace's 512 numbers for it.
    fn embed(&mut self, img: &RgbImage, points: &[[f32; 2]; 5]) -> Result<Vec<f32>> {
        let face = warp(img, similarity(points, &ARC_POINTS), ARC_SIZE);
        let n = ARC_SIZE * ARC_SIZE;
        let mut data = vec![0f32; 3 * n];
        for (i, p) in face.iter().enumerate() {
            for c in 0..3 {
                data[c * n + i] = (p[c] - 127.5) / 127.5;
            }
        }
        let out = self.recogniser.run(data, ARC_SIZE)?;
        Ok(unit(out.into_iter().next().context("the recogniser gave nothing")?.1))
    }

    /// The faces in the picture, or in a part of it (`area`: see `in_area`).
    pub fn faces(&mut self, img: &RgbImage, area: Option<[u32; 4]>) -> Result<Vec<Face>> {
        let (w, h) = (img.width() as f32, img.height() as f32);
        let finds = match area {
            Some(a) => in_area(img, a, |part| self.find(part))?,
            None => self.find(img)?,
        };
        let mut out = Vec::new();
        for f in finds {
            let width = f.bbox[2] - f.bbox[0];
            let Some(points) = f.points else { continue };
            if width < MIN_FACE {
                continue;
            }
            out.push(Face { kind: FaceKind::Photo, bbox: [(f.bbox[0] / w).clamp(0.0, 1.0), (f.bbox[1] / h).clamp(0.0, 1.0), (f.bbox[2] / w).clamp(0.0, 1.0), (f.bbox[3] / h).clamp(0.0, 1.0)], score: f.score, size: width.round() as u32, embedding: self.embed(img, &points)? });
        }
        Ok(out)
    }
}

/// Characters' faces in drawings.
pub struct Drawn {
    detector: Net,
    ccip: Net,
}

impl Drawn {
    pub fn load(detector: &Path, ccip: &Path, gpu: OnGpus) -> Result<Drawn> {
        Ok(Drawn { detector: Net::load(detector, gpu.detector)?, ccip: Net::load(ccip, gpu.embedder)? })
    }

    /// The anime face detector: the picture stretched to 640 × 640 (as deepghs runs it), its finds as
    /// centre, size and score for each of its 8400 places.
    fn find(&mut self, img: &RgbImage) -> Result<Vec<Found>> {
        let (w, h) = (img.width() as f32, img.height() as f32);
        let small = DynamicImage::ImageRgb8(img.clone()).resize_exact(ANIME_SIZE as u32, ANIME_SIZE as u32, FilterType::Triangle).to_rgb8();
        let n = ANIME_SIZE * ANIME_SIZE;
        let mut data = vec![0f32; 3 * n];
        for (i, p) in small.pixels().enumerate() {
            for c in 0..3 {
                data[c * n + i] = f32::from(p[c]) / 255.0;
            }
        }
        let (shape, out) = self.detector.run(data, ANIME_SIZE)?.into_iter().next().context("the anime face detector gave nothing")?;
        let places = *shape.last().context("the anime face detector gave no shape")? as usize;
        if out.len() < 5 * places {
            return Err(anyhow!("the anime face detector gave {} numbers for {places} places", out.len()));
        }
        let (sx, sy) = (w / ANIME_SIZE as f32, h / ANIME_SIZE as f32);
        let mut found = Vec::new();
        for i in 0..places {
            let score = out[4 * places + i];
            if score < ANIME_MIN {
                continue;
            }
            let (cx, cy, bw, bh) = (out[i], out[places + i], out[2 * places + i], out[3 * places + i]);
            found.push(Found { bbox: [(cx - bw / 2.0) * sx, (cy - bh / 2.0) * sy, (cx + bw / 2.0) * sx, (cy + bh / 2.0) * sy], score, points: None });
        }
        Ok(nms(found, 0.5))
    }

    /// CCIP's numbers for the character around a face: the head and upper body (clothes tell a
    /// character as much as the face: on public test sets this told more than the face with its hair
    /// alone), stretched to 384 × 384 and normalised as CLIP is.
    fn embed(&mut self, img: &RgbImage, bbox: &[f32; 4]) -> Result<Vec<f32>> {
        let (fw, fh) = (bbox[2] - bbox[0], bbox[3] - bbox[1]);
        let (cx, cy) = ((bbox[0] + bbox[2]) / 2.0, (bbox[1] + bbox[3]) / 2.0 + fh * 1.6);
        let (cw, ch) = (fw * 4.5, fh * 6.0);
        let x0 = (cx - cw / 2.0).max(0.0) as u32;
        let y0 = (cy - ch / 2.0).max(0.0) as u32;
        let x1 = ((cx + cw / 2.0).min(img.width() as f32) as u32).max(x0 + 1);
        let y1 = ((cy + ch / 2.0).min(img.height() as f32) as u32).max(y0 + 1);
        let crop = image::imageops::crop_imm(img, x0, y0, x1 - x0, y1 - y0).to_image();
        let square = DynamicImage::ImageRgb8(crop).resize_exact(CCIP_SIZE, CCIP_SIZE, FilterType::Triangle).to_rgb8();
        let n = (CCIP_SIZE * CCIP_SIZE) as usize;
        let mut data = vec![0f32; 3 * n];
        for (i, p) in square.pixels().enumerate() {
            for c in 0..3 {
                data[c * n + i] = (f32::from(p[c]) / 255.0 - CLIP_MEAN[c]) / CLIP_STD[c];
            }
        }
        let out = self.ccip.run(data, CCIP_SIZE as usize)?;
        Ok(unit(out.into_iter().next().context("CCIP gave nothing")?.1))
    }

    /// The faces in the picture, or in a part of it (`area`: see `in_area`).
    pub fn faces(&mut self, img: &RgbImage, area: Option<[u32; 4]>) -> Result<Vec<Face>> {
        let (w, h) = (img.width() as f32, img.height() as f32);
        let finds = match area {
            Some(a) => in_area(img, a, |part| self.find(part))?,
            None => self.find(img)?,
        };
        let mut out = Vec::new();
        for f in finds {
            let width = f.bbox[2] - f.bbox[0];
            if width < MIN_FACE {
                continue;
            }
            out.push(Face { kind: FaceKind::Drawn, bbox: [(f.bbox[0] / w).clamp(0.0, 1.0), (f.bbox[1] / h).clamp(0.0, 1.0), (f.bbox[2] / w).clamp(0.0, 1.0), (f.bbox[3] / h).clamp(0.0, 1.0)], score: f.score, size: width.round() as u32, embedding: self.embed(img, &f.bbox)? });
        }
        Ok(out)
    }

    /// A face where the reader marked one (`area`, in the picture's pixels) though the detector sees
    /// none there: the box taken as the face. CCIP tells a character by the head and body around a
    /// face, not by the face's points, so the box is enough; a photo's recogniser would need them.
    pub fn marked(&mut self, img: &RgbImage, area: [u32; 4]) -> Result<Face> {
        let (w, h) = (img.width() as f32, img.height() as f32);
        let bbox = area.map(|v| v as f32);
        Ok(Face { kind: FaceKind::Drawn, bbox: [bbox[0] / w, bbox[1] / h, bbox[2] / w, bbox[3] / h].map(|v| v.clamp(0.0, 1.0)), score: 1.0, size: (bbox[2] - bbox[0]).round() as u32, embedding: self.embed(img, &bbox)? })
    }
}

/// What a finder finds in a part of the picture (`area`, in its pixels: left, top, right, bottom),
/// looked for in that part alone: enlarged as the finder takes it, a face too small to see in the
/// whole picture is found there. Where they are is said of the whole picture.
fn in_area(img: &RgbImage, area: [u32; 4], mut find: impl FnMut(&RgbImage) -> Result<Vec<Found>>) -> Result<Vec<Found>> {
    let [l, t, r, b] = area;
    let (r, b) = (r.min(img.width()).max(l + 1), b.min(img.height()).max(t + 1));
    let part = image::imageops::crop_imm(img, l, t, r - l, b - t).to_image();
    let (ox, oy) = (l as f32, t as f32);
    Ok(find(&part)?
        .into_iter()
        .map(|f| Found { bbox: [f.bbox[0] + ox, f.bbox[1] + oy, f.bbox[2] + ox, f.bbox[3] + oy], score: f.score, points: f.points.map(|p| p.map(|[x, y]| [x + ox, y + oy])) })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_five_points_land_on_the_template() {
        // A face twice the template's size, turned a quarter and moved: the transform undoes it.
        let from: [[f32; 2]; 5] = ARC_POINTS.map(|[x, y]| [300.0 - 2.0 * y, 100.0 + 2.0 * x]);
        let m = similarity(&from, &ARC_POINTS);
        for (p, q) in from.iter().zip(ARC_POINTS.iter()) {
            let (x, y) = (m[0] * p[0] - m[1] * p[1] + m[2], m[1] * p[0] + m[0] * p[1] + m[3]);
            assert!((x - q[0]).abs() < 1e-3 && (y - q[1]).abs() < 1e-3, "{p:?} went to ({x}, {y}), not {q:?}");
        }
    }

    #[test]
    fn a_face_found_in_a_marked_part_is_placed_in_the_whole_picture() {
        let img = RgbImage::new(400, 300);
        let mut seen = (0, 0);
        let found = in_area(&img, [100, 50, 300, 250], |part| {
            seen = (part.width(), part.height());
            Ok(vec![Found { bbox: [10.0, 20.0, 40.0, 60.0], score: 0.9, points: Some([[15.0, 30.0]; 5]) }])
        })
        .unwrap();
        assert_eq!(seen, (200, 200), "the finder sees the part alone");
        assert_eq!(found[0].bbox, [110.0, 70.0, 140.0, 110.0]);
        assert_eq!(found[0].points.unwrap()[0], [115.0, 80.0]);
        // A part running past the picture's edge is cut to it.
        in_area(&img, [350, 250, 500, 400], |part| {
            assert_eq!((part.width(), part.height()), (50, 50));
            Ok(vec![])
        })
        .unwrap();
    }

    #[test]
    fn overlapping_finds_keep_the_best() {
        let f = |x: f32, score: f32| Found { bbox: [x, 0.0, x + 10.0, 10.0], score, points: None };
        let kept = nms(vec![f(0.0, 0.6), f(1.0, 0.9), f(30.0, 0.7)], 0.4);
        assert_eq!(kept.iter().map(|k| k.score).collect::<Vec<_>>(), vec![0.9, 0.7]);
    }
}
