//! PDFs as albums: each page a picture of the album. pdfium (Chromium's PDF engine, BSD licence)
//! draws them; it is loaded at run time from beside the app (`npm run pdfium` puts it in
//! `binaries/` while developing). A page is addressed as the PDF's path and its number from 1,
//! `…/Book.pdf#3`; the PDF itself is read through the library, so from the vault too.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use image::{DynamicImage, RgbImage};
use pdfium_render::prelude::*;

static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();
/// The bundled app's resource folder (told at start-up): pdfium ships there, under `binaries/`.
static BUNDLED: OnceLock<PathBuf> = OnceLock::new();

/// Where a bundled app keeps its resources; said once at start-up, before any PDF is opened.
pub fn bundled_in(dir: PathBuf) {
    let _ = BUNDLED.set(dir);
}

/// An empty file is no pdfium: the bundler wants the resource to exist, so a checkout without it
/// stands an empty one in (scripts/sidecar.mjs) until `npm run pdfium`.
fn library_path() -> Option<PathBuf> {
    let real = |p: PathBuf| std::fs::metadata(&p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false).then_some(p);
    if let Some(p) = std::env::var_os("QUIRE_PDFIUM") {
        return real(PathBuf::from(p));
    }
    let name = Pdfium::pdfium_platform_library_name();
    if let Some(beside) = std::env::current_exe().ok()?.parent().map(|d| d.join(&name)).and_then(real) {
        return Some(beside);
    }
    if let Some(dir) = BUNDLED.get() {
        for p in [dir.join("binaries").join(&name), dir.join(&name)] {
            if let Some(p) = real(p) {
                return Some(p);
            }
        }
    }
    real(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(&name))
}

fn pdfium() -> Result<&'static Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            let path = library_path().ok_or("PDFs need pdfium beside the app (npm run pdfium while developing)")?;
            Pdfium::bind_to_library(path).map(Pdfium::new).map_err(|e| format!("pdfium couldn't be loaded: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Whether a path is a PDF (by its name).
pub fn is_pdf(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// A page of a PDF album: the PDF's path and the page's number (from 1).
pub fn split_page(path: &str) -> Option<(PathBuf, u32)> {
    let (pdf, n) = path.rsplit_once('#')?;
    let n: u32 = n.parse().ok().filter(|n| *n >= 1)?;
    let pdf = PathBuf::from(pdf);
    is_pdf(&pdf).then_some((pdf, n))
}

/// How many pages a PDF has; remembered by its size and date (an album scan asks often).
pub fn page_count(bytes: impl FnOnce() -> Result<Vec<u8>, String>, key: (&Path, u64, u64)) -> Result<u32, String> {
    /// A PDF (its path, size and date) and how many pages it has.
    type Counts = HashMap<(PathBuf, u64, u64), u32>;
    static COUNTS: Mutex<Option<Counts>> = Mutex::new(None);
    let k = (key.0.to_path_buf(), key.1, key.2);
    if let Some(n) = COUNTS.lock().unwrap_or_else(|p| p.into_inner()).as_ref().and_then(|m| m.get(&k)) {
        return Ok(*n);
    }
    let doc = pdfium()?.load_pdf_from_byte_vec(bytes()?, None).map_err(|e| format!("not a PDF that can be read: {e}"))?;
    let n = doc.pages().len().max(0) as u32;
    COUNTS.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(HashMap::new).insert(k, n);
    Ok(n)
}

/// A page drawn so its longer side is `side` pixels (a page larger than that is shrunk; one smaller
/// is drawn sharp at that size), on white.
pub fn render(bytes: Vec<u8>, page: u32, side: u32) -> Result<RgbImage, String> {
    let doc = pdfium()?.load_pdf_from_byte_vec(bytes, None).map_err(|e| format!("not a PDF that can be read: {e}"))?;
    let p = doc.pages().get((page.max(1) - 1) as PdfPageIndex).map_err(|_| format!("the PDF has no page {page}"))?;
    let side = side.clamp(16, 8000) as i32;
    let config = PdfRenderConfig::new().set_target_width(side).set_maximum_height(side);
    let img = p.render_with_config(&config).and_then(|b| b.as_image()).map_err(|e| format!("page {page} couldn't be drawn: {e}"))?;
    Ok(on_white(img))
}

/// A drawn page's transparency (pdfium leaves the paper see-through) put on white paper.
fn on_white(img: DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (o, p) in out.pixels_mut().zip(rgba.pixels()) {
        let a = u16::from(p[3]);
        for c in 0..3 {
            o[c] = ((u16::from(p[c]) * a + 255 * (255 - a)) / 255) as u8;
        }
    }
    out
}

/// A page as JPEG, for showing.
pub fn render_jpeg(bytes: Vec<u8>, page: u32, side: u32) -> Result<Vec<u8>, String> {
    let img = render(bytes, page, side)?;
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 88).encode_image(&img).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_its_pdf_and_number() {
        assert_eq!(split_page("/v/Albums/Book.pdf#3"), Some((PathBuf::from("/v/Albums/Book.pdf"), 3)));
        assert_eq!(split_page("/v/Albums/Book.PDF#12"), Some((PathBuf::from("/v/Albums/Book.PDF"), 12)));
        assert_eq!(split_page("/v/Albums/Book.pdf#0"), None);
        assert_eq!(split_page("/v/Albums/a#1.jpg"), None);
        assert_eq!(split_page("/v/Albums/Book.pdf"), None);
    }

    #[test]
    fn see_through_paper_is_white() {
        let mut img = image::RgbaImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgba([0, 0, 0, 0]));
        img.put_pixel(1, 0, image::Rgba([10, 20, 30, 255]));
        let out = on_white(DynamicImage::ImageRgba8(img));
        assert_eq!(out.get_pixel(0, 0).0, [255, 255, 255]);
        assert_eq!(out.get_pixel(1, 0).0, [10, 20, 30]);
    }
}
