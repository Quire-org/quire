//! A plugin's pipeline, compiled to WebAssembly (`wasm32-unknown-unknown`) and run by Quire's
//! engine, asks the engine for what it can't do itself through these calls: the request (the
//! plugin's options, as JSON) and its picture, running a model the plugin's manifest declares on
//! tensors, the engine's inpainter, its tools for text in pictures ([`text`]), progress and log
//! lines, and the result. Everything else (the pipeline's own logic) is the module's code. The
//! module has no filesystem or network of its own.
//!
//! A module defines its pipeline and names it with [`main!`]:
//!
//! ```ignore
//! fn run() -> Result<(), String> {
//!     let request = quire_engine_sdk::request();
//!     let page = quire_engine_sdk::input();
//!     // …
//!     quire_engine_sdk::output(Some(&page), &result_json);
//!     Ok(())
//! }
//! quire_engine_sdk::main!(run);
//! ```

#[link(wasm_import_module = "ms")]
unsafe extern "C" {
    fn request_len() -> u32;
    fn request_read(ptr: *mut u8);
    fn input_size(out: *mut u32);
    fn input_read(ptr: *mut u8);
    fn model_run(model: *const u8, model_len: u32, file: *const u8, file_len: u32, input: *const u8, input_len: u32) -> i32;
    fn inpaint(rgb: *const u8, mask: *const u8, width: u32, height: u32) -> i32;
    fn result_read(ptr: *mut u8);
    fn progress(stage: *const u8, stage_len: u32, state: *const u8, state_len: u32, done: i32, total: i32);
    fn log(message: *const u8, len: u32);
    fn env(name: *const u8, len: u32) -> i32;
    #[link_name = "output"]
    fn put_output(rgb: *const u8, rgb_len: u32, width: u32, height: u32, json: *const u8, json_len: u32);
    fn fail(message: *const u8, len: u32);
    fn clock() -> f64;
    fn text_stages(json: *const u8, len: u32) -> i32;
    fn text_drop(json: *const u8, len: u32) -> i32;
    fn text_letter(json: *const u8, len: u32) -> i32;
}

/// The answer of the last call that has one (`model_run`, `inpaint`, `env`), `len` bytes.
fn result(len: i32) -> Result<Vec<u8>, String> {
    let n = len.unsigned_abs() as usize;
    let mut out = vec![0u8; n];
    if n > 0 {
        unsafe { result_read(out.as_mut_ptr()) };
    }
    if len < 0 { Err(String::from_utf8_lossy(&out).into_owned()) } else { Ok(out) }
}

/// The request: the plugin's options as it sent them (JSON).
pub fn request() -> String {
    let mut out = vec![0u8; unsafe { request_len() } as usize];
    unsafe { request_read(out.as_mut_ptr()) };
    String::from_utf8_lossy(&out).into_owned()
}

/// The picture to work on, the right way up, as RGB bytes (`width * height * 3`).
pub struct Picture {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// The request's picture.
pub fn input() -> Picture {
    let mut size = [0u32; 2];
    unsafe { input_size(size.as_mut_ptr()) };
    let mut rgb = vec![0u8; size[0] as usize * size[1] as usize * 3];
    unsafe { input_read(rgb.as_mut_ptr()) };
    Picture { width: size[0], height: size[1], rgb }
}

/// Numbers in a shape (row-major, 32-bit floats), in and out of a model.
#[derive(Clone, Debug, PartialEq)]
pub struct Tensor {
    pub shape: Vec<i64>,
    pub data: Vec<f32>,
}

impl Tensor {
    pub fn new(shape: Vec<i64>, data: Vec<f32>) -> Self {
        Self { shape, data }
    }
}

/// Tensors as bytes: how many, then each one's rank, its dimensions and its numbers (little-endian).
pub fn pack(tensors: &[Tensor]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + tensors.iter().map(|t| 4 + t.shape.len() * 8 + t.data.len() * 4).sum::<usize>());
    out.extend_from_slice(&(tensors.len() as u32).to_le_bytes());
    for t in tensors {
        out.extend_from_slice(&(t.shape.len() as u32).to_le_bytes());
        for d in &t.shape {
            out.extend_from_slice(&d.to_le_bytes());
        }
        for v in &t.data {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out
}

/// The tensors packed by `pack`.
pub fn unpack(bytes: &[u8]) -> Result<Vec<Tensor>, String> {
    let bad = || "a model's answer couldn't be read".to_string();
    let mut at = 0usize;
    let mut take = |n: usize| -> Result<&[u8], String> {
        let s = bytes.get(at..at + n).ok_or_else(bad)?;
        at += n;
        Ok(s)
    };
    let count = u32::from_le_bytes(take(4)?.try_into().map_err(|_| bad())?) as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let rank = u32::from_le_bytes(take(4)?.try_into().map_err(|_| bad())?) as usize;
        let mut shape = Vec::with_capacity(rank);
        for _ in 0..rank {
            shape.push(i64::from_le_bytes(take(8)?.try_into().map_err(|_| bad())?));
        }
        let n = shape.iter().product::<i64>().max(0) as usize;
        let data = take(n * 4)?.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().expect("four bytes"))).collect();
        out.push(Tensor { shape, data });
    }
    Ok(out)
}

/// Run `file` of `model` (one the plugin's manifest declares, downloaded in Local models) on these
/// inputs, on the engine's device; its outputs. The model is loaded once and kept between pages.
pub fn run_model(model: &str, file: &str, inputs: &[Tensor]) -> Result<Vec<Tensor>, String> {
    let packed = pack(inputs);
    let len = unsafe { model_run(model.as_ptr(), model.len() as u32, file.as_ptr(), file.len() as u32, packed.as_ptr(), packed.len() as u32) };
    unpack(&result(len)?)
}

/// The engine's inpainter (a manga LaMa) on a crop: `rgb` (`width * height * 3`) with what `mask`
/// (`width * height`, 255 to redraw) covers painted again; the crop redrawn, as RGB.
pub fn inpaint_lama(rgb: &[u8], mask: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    if rgb.len() != width as usize * height as usize * 3 || mask.len() != width as usize * height as usize {
        return Err("the crop and its mask aren't the size given".into());
    }
    result(unsafe { inpaint(rgb.as_ptr(), mask.as_ptr(), width, height) })
}

/// What stage the work is at (`"detection"`, `"inpainting"`…, `"running"` or `"finished"`), and how
/// far along when it can count: the app shows it.
pub fn report(stage: &str, state: &str, step: Option<(u32, u32)>) {
    let (done, total) = step.map_or((-1, -1), |(d, t)| (d as i32, t as i32));
    unsafe { progress(stage.as_ptr(), stage.len() as u32, state.as_ptr(), state.len() as u32, done, total) };
}

/// A line for the engine's log (stderr).
pub fn say(message: &str) {
    unsafe { log(message.as_ptr(), message.len() as u32) };
}

/// A setting from the engine's environment, for debugging a pipeline: only names starting with `MS_`.
pub fn var(name: &str) -> Option<String> {
    let len = unsafe { env(name.as_ptr(), name.len() as u32) };
    if len < 0 { None } else { result(len).ok().map(|b| String::from_utf8_lossy(&b).into_owned()) }
}

/// Seconds since the run began (WebAssembly has no clock of its own), for timing a pipeline's steps.
pub fn seconds() -> f64 {
    unsafe { clock() }
}

/// The result: a picture (RGB, the input's size or another) or none, and what the plugin is told (JSON).
pub fn output(picture: Option<&Picture>, json: &str) {
    match picture {
        Some(p) => unsafe { put_output(p.rgb.as_ptr(), p.rgb.len() as u32, p.width, p.height, json.as_ptr(), json.len() as u32) },
        None => unsafe { put_output(std::ptr::null(), 0, 0, 0, json.as_ptr(), json.len() as u32) },
    }
}

/// Text in the picture, with the engine's models for it (Koharu's): the stages run on the picture
/// in place, one call at a time, and each answers with what is on the page then, as JSON:
///
/// ```text
/// {"regions": [{"id": "…", "source": "…", "translation": "…",
///               "text": [x, y, w, h] | null,     where the text was found (pixels of the picture)
///               "frame": [x, y, w, h] | null,    where it is lettered
///               "balloon": [x, y, w, h] | null}],
///  "model": "…"}                                 the language model that translated, after "translation"
/// ```
///
/// The models a stage uses must be ones the plugin's manifest names and the user downloaded; the
/// text tools' shared parts (finding the text, painting it out, lettering) come with them.
pub mod text {
    /// Run stages on the picture: `{"stages": ["detection", "ocr", "translation", "inpainting"],
    /// "ocr": "manga-ocr" | "hayai-ocr", "llm": a language model (the one the user chose when left
    /// out), "target": "en", "instructions": "…", "need": [stages of later calls]}`. Detection finds
    /// the text and balloons, OCR reads it, translation translates what was read, inpainting paints
    /// the original text out. The models of `need`'s stages are checked with these, so a page that
    /// can't be finished fails before any work, naming every model missing ("not downloaded: …").
    pub fn stages(json: &str) -> Result<String, String> {
        let len = unsafe { super::text_stages(json.as_ptr(), json.len() as u32) };
        super::result(len).map(|b| String::from_utf8_lossy(&b).into_owned())
    }

    /// Take regions off the page (a JSON list of their ids): their text isn't read, translated or
    /// lettered, though the original text found there is still painted out.
    pub fn drop(ids_json: &str) -> Result<String, String> {
        let len = unsafe { super::text_drop(ids_json.as_ptr(), ids_json.len() as u32) };
        super::result(len).map(|b| String::from_utf8_lossy(&b).into_owned())
    }

    /// The page as it is now, with each region's translation lettered into its frame: `{"fonts":
    /// ["Comic Sans MS", …]}`, installed fonts most preferred first (fonts most computers have when
    /// left out).
    pub fn letter(json: &str) -> Result<super::Picture, String> {
        let bytes = super::result(unsafe { super::text_letter(json.as_ptr(), json.len() as u32) })?;
        if bytes.len() < 8 {
            return Err("the lettered page couldn't be read".into());
        }
        let width = u32::from_le_bytes(bytes[0..4].try_into().expect("four bytes"));
        let height = u32::from_le_bytes(bytes[4..8].try_into().expect("four bytes"));
        let rgb = bytes[8..].to_vec();
        if rgb.len() != width as usize * height as usize * 3 {
            return Err("the lettered page isn't the size it says".into());
        }
        Ok(super::Picture { width, height, rgb })
    }
}

/// Why it failed, for the plugin.
#[doc(hidden)]
pub fn failed(message: &str) {
    unsafe { fail(message.as_ptr(), message.len() as u32) };
}

/// Names the pipeline: the engine calls it once per request. Only in the WebAssembly build, so a
/// pipeline's own logic can be tested natively (`cargo test`).
#[macro_export]
macro_rules! main {
    ($run:path) => {
        #[cfg(target_arch = "wasm32")]
        #[unsafe(no_mangle)]
        pub extern "C" fn ms_run() -> i32 {
            match $run() {
                Ok(()) => 0,
                Err(e) => {
                    $crate::failed(&e.to_string());
                    1
                }
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tensors_pack_and_unpack() {
        let t = vec![Tensor::new(vec![1, 2, 3], (0..6).map(|i| i as f32 / 2.0).collect()), Tensor::new(vec![], vec![7.0])];
        assert_eq!(unpack(&pack(&t)).unwrap(), t);
        assert!(unpack(&pack(&t)[..10]).is_err());
    }
}
