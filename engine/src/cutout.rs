//! Cutting subjects out of a picture, for Scrapbook's stickers: BiRefNet lite (MIT,
//! ZhengPeng7/BiRefNet_lite, as ONNX by onnx-community), a salient-object segmentation model.
//! It marks how much each pixel belongs to the picture's subjects; the app finds the separate
//! subjects in that and cuts them out. ONNX on the CPU, like the tagger.

use std::path::Path;

use anyhow::{Context as _, Result, anyhow};
use image::{DynamicImage, GrayImage, RgbImage, imageops::FilterType};
use ort::{session::Session, value::Tensor};

/// The model sees the picture at this size, whatever its own.
const SIZE: u32 = 1024;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

pub struct Cutter {
    session: Session,
}

impl Cutter {
    pub fn load(model: &Path) -> Result<Cutter> {
        Ok(Cutter { session: crate::tagging::session(model)? })
    }

    /// How much each pixel belongs to the subjects (0 not at all, 255 wholly), at `width` × `height`.
    pub fn mask(&mut self, image: &RgbImage, width: u32, height: u32) -> Result<GrayImage> {
        let scaled = DynamicImage::ImageRgb8(image.clone()).resize_exact(SIZE, SIZE, FilterType::Triangle).to_rgb8();
        let n = (SIZE * SIZE) as usize;
        // NCHW, scaled to 0..1 and normalised as the model was trained.
        let mut data = vec![0f32; 3 * n];
        for (i, p) in scaled.pixels().enumerate() {
            for c in 0..3 {
                data[c * n + i] = (f32::from(p[c]) / 255.0 - MEAN[c]) / STD[c];
            }
        }
        let input = Tensor::from_array((vec![1usize, 3, SIZE as usize, SIZE as usize], data)).map_err(|e| anyhow!("{e}"))?;
        let name = self.session.inputs().first().context("the cutout model has no input")?.name().to_string();
        let outputs = self.session.run(ort::inputs![name => input]).map_err(|e| anyhow!("{e}"))?;
        // The last output is the finest of the model's maps (the only one in this export).
        let (_, value) = outputs.iter().last().context("the cutout model gave no output")?;
        let (_shape, logits) = value.try_extract_tensor::<f32>().map_err(|e| anyhow!("{e}"))?;
        if logits.len() != n {
            return Err(anyhow!("the cutout model gave {} values for {n} pixels", logits.len()));
        }
        let mask = GrayImage::from_fn(SIZE, SIZE, |x, y| {
            let v = logits[(y * SIZE + x) as usize];
            image::Luma([(255.0 / (1.0 + (-v).exp())).round() as u8])
        });
        Ok(DynamicImage::ImageLuma8(mask).resize_exact(width.max(1), height.max(1), FilterType::Triangle).to_luma8())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the real model when `MS_CUTOUT_MODEL` names its file: a light square on a dark
    /// background should come out as the subject, the background not.
    #[test]
    fn cuts_out_a_subject() {
        let Some(model) = std::env::var_os("MS_CUTOUT_MODEL") else { return };
        let mut cutter = Cutter::load(Path::new(&model)).unwrap();
        let img = RgbImage::from_fn(400, 300, |x, y| if (120..280).contains(&x) && (80..220).contains(&y) { image::Rgb([230, 60, 40]) } else { image::Rgb([20, 30, 40]) });
        let mask = cutter.mask(&img, 200, 150).unwrap();
        assert_eq!(mask.dimensions(), (200, 150));
        let inside = mask.get_pixel(100, 75)[0];
        let outside = mask.get_pixel(5, 5)[0];
        eprintln!("inside {inside}, outside {outside}");
        assert!(inside > 128 && outside < 128, "inside {inside}, outside {outside}");
    }
}
