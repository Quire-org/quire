//! Plugins' own pipelines: WebAssembly modules a plugin brings (built with `engine/sdk`), run here
//! with a small host API and nothing else, no filesystem or network of their own. The module asks for
//! its request (the plugin's options) and picture, runs the models its plugin declares on tensors,
//! the engine's inpainter on crops and its tools for text in pictures (`text.rs`) on the picture,
//! reports progress, and hands back a picture and what the plugin is told. What a pipeline knows
//! about what it looks for, and what it makes of it, stays in the plugin; the engine stays a runtime.
//!
//! The calls are those `engine/sdk/src/lib.rs` imports from the module `ms`. Answers that come back
//! (a model's tensors, a redrawn crop, a setting) are kept until the module reads them with
//! `result_read`; a negative length means an error, its message read the same way.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use anyhow::{Context as _, Result, anyhow, bail};
use image::{GrayImage, RgbImage};
use koharu_ml::{
    Backend,
    lama::{HDStrategy, InpaintRequest, LaMa},
    torch::{CModule, Device, Kind, Tensor},
};
use wasmtime::{Caller, Config, Engine, Linker, Memory, Module, Store, StoreLimits, StoreLimitsBuilder};

use crate::{models, text};

/// How a run reports progress: the stage, its state, the model at work, and how far a stage that
/// counts has got.
pub type Progress = Arc<dyn Fn(&str, &str, Option<&str>, Option<(u32, u32)>) + Send + Sync>;

/// What a run is given.
pub struct Request {
    /// The plugin's options, as it sent them (JSON).
    pub options: String,
    pub picture: RgbImage,
    /// The picture's own file and its type, when it is already the right way up (the text tools
    /// start from it; otherwise from `picture`).
    pub source: Option<(Vec<u8>, String)>,
    /// The files of each model the plugin declares that the user downloaded, by model id.
    pub models: HashMap<String, Vec<PathBuf>>,
    /// Every model the plugin declares, downloaded or not.
    pub named: Vec<String>,
    /// The language model the user chose, for text to be translated with.
    pub language_model: Option<String>,
    pub cpu: bool,
}

/// What a run hands back.
pub struct Output {
    pub picture: Option<RgbImage>,
    /// What the plugin is told (JSON).
    pub result: String,
}

/// Kept between runs: the compiled modules (by file, made again when it changes), the models loaded
/// (by file and device), the inpainter and the text tools, so a second page doesn't load them again.
#[derive(Default)]
pub struct Host {
    engine: Option<Engine>,
    modules: HashMap<PathBuf, (Option<SystemTime>, Module)>,
    kept: Kept,
}

#[derive(Default)]
struct Kept {
    models: HashMap<(PathBuf, String), CModule>,
    lama: Option<(bool, LaMa)>,
    text: text::Tools,
}

/// One run's state, inside the module's store.
struct State {
    request: Request,
    device: Device,
    kept: Kept,
    /// The last answer, for `result_read`.
    last: Vec<u8>,
    output: Option<Output>,
    failed: Option<String>,
    started: std::time::Instant,
    progress: Progress,
    /// The picture as the text tools see it, made on their first call.
    page: Option<text::Page>,
    /// How much memory the module may take (`MAX_MEMORY`).
    limits: StoreLimits,
}

/// The most memory a plugin's pipeline may grow to: as much as a 32-bit module can address, so a
/// 64-bit one can't take the whole machine's.
const MAX_MEMORY: usize = 4 << 30;

/// The longest a pipeline may run on a picture, in seconds (`Host::run`'s ticker counts them): less
/// than the app waits for a page (30 minutes), so a pipeline that never ends is stopped and the engine,
/// with its models loaded, goes on.
const MAX_RUN: u64 = 25 * 60;

/// The device the models run on: the GPU when there is one and the CPU wasn't asked for.
fn device_for(cpu: bool) -> Device {
    let ml = koharu_ml::device(cpu);
    match ml.backend {
        Backend::Cuda | Backend::Rocm => Device::Cuda(ml.index),
        Backend::Metal if cfg!(all(target_os = "macos", target_arch = "aarch64")) => Device::Mps,
        _ => Device::Cpu,
    }
}

impl Host {
    /// Run `module` on a request. `progress` hears the module's reports.
    pub fn run(&mut self, module: &Path, request: Request, progress: Progress) -> Result<Output> {
        let engine = match &self.engine {
            Some(e) => e.clone(),
            None => {
                let mut config = Config::new();
                config.epoch_interruption(true);
                let e = Engine::new(&config).map_err(|e| anyhow!("the WebAssembly runtime couldn't start: {e:?}"))?;
                // The engine's clock for the runs' deadlines: a tick a second, for as long as the engine runs.
                let ticking = e.clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        ticking.increment_epoch();
                    }
                });
                self.engine = Some(e.clone());
                e
            }
        };
        let stamp = std::fs::metadata(module).and_then(|m| m.modified()).ok();
        let compiled = match self.modules.get(module) {
            Some((at, m)) if *at == stamp => m.clone(),
            _ => {
                let m = Module::from_file(&engine, module).map_err(|e| anyhow!("could not load the plugin's pipeline {}: {e:?}", module.display()))?;
                self.modules.insert(module.to_path_buf(), (stamp, m.clone()));
                m
            }
        };
        let device = device_for(request.cpu);
        let limits = StoreLimitsBuilder::new().memory_size(MAX_MEMORY).build();
        let state = State { request, device, kept: std::mem::take(&mut self.kept), last: Vec::new(), output: None, failed: None, started: std::time::Instant::now(), progress, page: None, limits };
        let mut store = Store::new(&engine, state);
        store.limiter(|s| &mut s.limits);
        store.set_epoch_deadline(MAX_RUN);
        let mut linker = linker(&engine).map_err(|e| anyhow!("{e:?}"))?;
        // Imports the engine doesn't offer (glue some crates bring for a JavaScript host, which a
        // pipeline never calls) fail if called, rather than keep the module from starting.
        linker.define_unknown_imports_as_traps(&compiled).map_err(|e| anyhow!("{e:?}"))?;
        let outcome = (|| -> Result<i32> {
            let instance = linker.instantiate(&mut store, &compiled).map_err(|e| anyhow!("the plugin's pipeline couldn't start: {e:?}"))?;
            let run = instance.get_typed_func::<(), i32>(&mut store, "ms_run").map_err(|e| anyhow!("the plugin's pipeline has no ms_run: {e:?}"))?;
            // A panic in a host call it made (a model given what it can't take) ends this run, not the engine.
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| koharu_ml::torch::no_grad(|| run.call(&mut store, ()))));
            called.map_err(|_| anyhow!("the plugin's pipeline made the engine fail, and was stopped"))?.map_err(|e| anyhow!("the plugin's pipeline stopped: {e:#}"))
        })();
        let state = store.into_data();
        self.kept = state.kept;
        let code = outcome?;
        if code != 0 {
            bail!("{}", state.failed.unwrap_or_else(|| "the plugin's pipeline failed".into()));
        }
        state.output.context("the plugin's pipeline gave no result")
    }
}

/// The runtime's own errors, for a host call.
type Wr<T> = wasmtime::Result<T>;
fn trap(message: impl std::fmt::Display) -> wasmtime::Error {
    wasmtime::Error::msg(message.to_string())
}

fn memory(caller: &mut Caller<'_, State>) -> Wr<Memory> {
    caller.get_export("memory").and_then(|e| e.into_memory()).ok_or_else(|| trap("the module has no memory"))
}

fn read(caller: &mut Caller<'_, State>, ptr: u32, len: u32) -> Wr<Vec<u8>> {
    // Within the module's memory before anything is set aside for it (a length it made up can't make
    // the engine allocate gigabytes).
    let mem = memory(caller)?;
    let at = ptr as usize;
    let end = at.checked_add(len as usize).filter(|&e| e <= mem.data_size(&caller)).ok_or_else(|| trap("the module asked for memory it doesn't have"))?;
    Ok(mem.data(&caller)[at..end].to_vec())
}

fn write(caller: &mut Caller<'_, State>, ptr: u32, bytes: &[u8]) -> Wr<()> {
    let mem = memory(caller)?;
    mem.write(caller, ptr as usize, bytes).map_err(|_| trap("the module gave memory it doesn't have"))
}

fn string(caller: &mut Caller<'_, State>, ptr: u32, len: u32) -> Wr<String> {
    Ok(String::from_utf8_lossy(&read(caller, ptr, len)?).into_owned())
}

/// Keep an answer for `result_read`: its length, or minus it for an error's message.
fn answer(caller: &mut Caller<'_, State>, outcome: Result<Vec<u8>>) -> i32 {
    match outcome {
        Ok(bytes) => {
            let n = bytes.len() as i32;
            caller.data_mut().last = bytes;
            n
        }
        Err(e) => {
            let message = format!("{e:#}").into_bytes();
            let n = -(message.len().max(1) as i32);
            caller.data_mut().last = if message.is_empty() { b"failed".to_vec() } else { message };
            n
        }
    }
}

fn linker(engine: &Engine) -> Wr<Linker<State>> {
    let mut l = Linker::new(engine);
    l.func_wrap("ms", "request_len", |c: Caller<'_, State>| c.data().request.options.len() as u32)?;
    l.func_wrap("ms", "request_read", |mut c: Caller<'_, State>, ptr: u32| -> Wr<()> {
        let bytes = c.data().request.options.clone().into_bytes();
        write(&mut c, ptr, &bytes)
    })?;
    l.func_wrap("ms", "input_size", |mut c: Caller<'_, State>, ptr: u32| -> Wr<()> {
        let (w, h) = c.data().request.picture.dimensions();
        let bytes: Vec<u8> = [w.to_le_bytes(), h.to_le_bytes()].concat();
        write(&mut c, ptr, &bytes)
    })?;
    l.func_wrap("ms", "input_read", |mut c: Caller<'_, State>, ptr: u32| -> Wr<()> {
        let bytes = std::mem::take(&mut c.data_mut().request.picture);
        let out = write(&mut c, ptr, bytes.as_raw());
        c.data_mut().request.picture = bytes;
        out
    })?;
    l.func_wrap("ms", "result_read", |mut c: Caller<'_, State>, ptr: u32| -> Wr<()> {
        let bytes = std::mem::take(&mut c.data_mut().last);
        write(&mut c, ptr, &bytes)
    })?;
    l.func_wrap("ms", "model_run", |mut c: Caller<'_, State>, model: u32, model_len: u32, file: u32, file_len: u32, input: u32, input_len: u32| -> Wr<i32> {
        let model = string(&mut c, model, model_len)?;
        let file = string(&mut c, file, file_len)?;
        let input = read(&mut c, input, input_len)?;
        let outcome = run_model(c.data_mut(), &model, &file, &input);
        Ok(answer(&mut c, outcome))
    })?;
    l.func_wrap("ms", "inpaint", |mut c: Caller<'_, State>, rgb: u32, mask: u32, width: u32, height: u32| -> Wr<i32> {
        let n = width as usize * height as usize;
        let rgb = read(&mut c, rgb, (n * 3) as u32)?;
        let mask = read(&mut c, mask, n as u32)?;
        let outcome = inpaint(c.data_mut(), rgb, mask, width, height);
        Ok(answer(&mut c, outcome))
    })?;
    l.func_wrap("ms", "progress", |mut c: Caller<'_, State>, stage: u32, stage_len: u32, state: u32, state_len: u32, done: i32, total: i32| -> Wr<()> {
        let stage = string(&mut c, stage, stage_len)?;
        let state = string(&mut c, state, state_len)?;
        let step = (done >= 0 && total >= 0).then_some((done as u32, total as u32));
        (c.data().progress)(&stage, &state, None, step);
        Ok(())
    })?;
    l.func_wrap("ms", "log", |mut c: Caller<'_, State>, ptr: u32, len: u32| -> Wr<()> {
        eprintln!("plugin: {}", string(&mut c, ptr, len)?);
        Ok(())
    })?;
    l.func_wrap("ms", "env", |mut c: Caller<'_, State>, ptr: u32, len: u32| -> Wr<i32> {
        let name = string(&mut c, ptr, len)?;
        // Only the engine's own debugging settings, never the rest of the environment.
        Ok(match std::env::var(&name).ok().filter(|_| name.starts_with("MS_")) {
            Some(v) => answer(&mut c, Ok(v.into_bytes())),
            None => -1,
        })
    })?;
    l.func_wrap("ms", "output", |mut c: Caller<'_, State>, rgb: u32, rgb_len: u32, width: u32, height: u32, json: u32, json_len: u32| -> Wr<()> {
        let result = string(&mut c, json, json_len)?;
        let picture = if rgb_len == 0 {
            None
        } else {
            if rgb_len as u64 != u64::from(width) * u64::from(height) * 3 {
                return Err(trap("the picture handed back isn't the size given"));
            }
            Some(RgbImage::from_raw(width, height, read(&mut c, rgb, rgb_len)?).ok_or_else(|| trap("the picture handed back couldn't be read"))?)
        };
        c.data_mut().output = Some(Output { picture, result });
        Ok(())
    })?;
    l.func_wrap("ms", "clock", |c: Caller<'_, State>| c.data().started.elapsed().as_secs_f64())?;
    l.func_wrap("ms", "fail", |mut c: Caller<'_, State>, ptr: u32, len: u32| -> Wr<()> {
        let message = string(&mut c, ptr, len)?;
        c.data_mut().failed = Some(message);
        Ok(())
    })?;
    l.func_wrap("ms", "text_stages", |mut c: Caller<'_, State>, ptr: u32, len: u32| -> Wr<i32> {
        let json = string(&mut c, ptr, len)?;
        let outcome = text_stages(c.data_mut(), &json);
        Ok(answer(&mut c, outcome))
    })?;
    l.func_wrap("ms", "text_drop", |mut c: Caller<'_, State>, ptr: u32, len: u32| -> Wr<i32> {
        let json = string(&mut c, ptr, len)?;
        let outcome = page(c.data_mut()).and_then(|page| block(page.drop(&json)));
        Ok(answer(&mut c, outcome))
    })?;
    l.func_wrap("ms", "text_letter", |mut c: Caller<'_, State>, ptr: u32, len: u32| -> Wr<i32> {
        let json = string(&mut c, ptr, len)?;
        let state = c.data_mut();
        let outcome = page(state).map(|_| ()).and_then(|()| block(state.kept.text.letter(state.page.as_ref().expect("made above"), &json)));
        Ok(answer(&mut c, outcome))
    })?;
    Ok(l)
}

/// Async work from inside a host call (the engine runs on a multi-threaded runtime).
fn block<F: std::future::Future>(future: F) -> F::Output {
    tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(future))
}

/// The run's picture as the text tools see it: made from the picture's own file when it is upright
/// as it is, otherwise from the picture turned upright.
fn page(state: &mut State) -> Result<&mut text::Page> {
    if state.page.is_none() {
        let (w, h) = state.request.picture.dimensions();
        let (bytes, mime) = match state.request.source.take() {
            Some(file) => file,
            None => {
                let mut png = Vec::new();
                image::DynamicImage::ImageRgb8(state.request.picture.clone()).write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
                (png, "image/png".to_owned())
            }
        };
        state.page = Some(block(text::Page::new(bytes, &mime, w, h))?);
    }
    Ok(state.page.as_mut().expect("made above"))
}

fn text_stages(state: &mut State, json: &str) -> Result<Vec<u8>> {
    page(state)?;
    let State { request, kept, page, progress, .. } = state;
    let allowed = text::Allowed { models: &request.models, named: &request.named, chosen: request.language_model.as_deref(), cpu: request.cpu };
    let progress = progress.clone();
    let report: text::Report = Arc::new(move |stage, state, model| progress(stage, state, model, None));
    block(kept.text.stages(page.as_mut().expect("made above"), json, &allowed, report))
}

/// A model the plugin declares and the user downloaded: its files, or why not.
fn files<'a>(request: &'a Request, model: &str) -> Result<&'a [PathBuf]> {
    if let Some(files) = request.models.get(model) {
        return Ok(files);
    }
    if request.named.iter().any(|n| n == model) {
        bail!("not downloaded: {model}");
    }
    bail!("the plugin doesn't declare the model {model} in its plugin.json")
}

/// Tensors packed as the SDK packs them.
fn unpack(bytes: &[u8]) -> Result<Vec<(Vec<i64>, Vec<f32>)>> {
    let mut at = 0usize;
    let mut take = |n: usize| -> Result<&[u8]> {
        let end = at.checked_add(n).context("the tensors given couldn't be read")?;
        let s = bytes.get(at..end).context("the tensors given couldn't be read")?;
        at = end;
        Ok(s)
    };
    let count = u32::from_le_bytes(take(4)?.try_into()?) as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let rank = u32::from_le_bytes(take(4)?.try_into()?) as usize;
        let shape: Vec<i64> = (0..rank).map(|_| take(8).and_then(|b| Ok(i64::from_le_bytes(b.try_into()?)))).collect::<Result<_>>()?;
        // Every size given (none negative: the shape is the data's own, not one to work out), and as
        // many values as they make, counted without overflowing.
        let n = shape.iter().try_fold(1usize, |n, &d| n.checked_mul(usize::try_from(d).ok()?)).context("the tensors given have a size that can't be")?;
        let data = take(n.checked_mul(4).context("the tensors given are too large")?)?.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
        out.push((shape, data));
    }
    Ok(out)
}

fn pack(tensors: &[(Vec<i64>, Vec<f32>)]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(tensors.len() as u32).to_le_bytes());
    for (shape, data) in tensors {
        out.extend_from_slice(&(shape.len() as u32).to_le_bytes());
        for d in shape {
            out.extend_from_slice(&d.to_le_bytes());
        }
        for v in data {
            out.extend_from_slice(&v.to_le_bytes());
        }
    }
    out
}

/// One of the plugin's models (a TorchScript file) on tensors, on the run's device.
fn run_model(state: &mut State, model: &str, file: &str, input: &[u8]) -> Result<Vec<u8>> {
    let path = files(&state.request, model)?
        .iter().find(|p| p.file_name().is_some_and(|n| n == file)).with_context(|| format!("{model} has no file {file}"))?.clone();
    let device = state.device;
    let key = (path.clone(), format!("{device:?}"));
    if !state.kept.models.contains_key(&key) {
        (state.progress)("model", "loading", Some(model), None);
        let mut module = CModule::load_on_device(&path, device).with_context(|| format!("could not load {}", path.display()))?;
        module.set_eval();
        state.kept.models.insert(key.clone(), module);
    }
    let module = &state.kept.models[&key];
    let inputs: Vec<Tensor> = unpack(input)?.into_iter().map(|(shape, data)| Ok(Tensor::from_slice(&data).f_view(shape.as_slice())?.to_device(device))).collect::<Result<_>>()?;
    let output = module.forward_ts(&inputs)?;
    let out = output.to_kind(Kind::Float).to_device(Device::Cpu).contiguous();
    let shape = out.size();
    let data = Vec::<f32>::try_from(&out.view([-1]))?;
    Ok(pack(&[(shape, data)]))
}

/// The engine's manga LaMa on a crop, loaded the first time (and again when the device changes). Its
/// file comes with the text tools' shared parts, or with a plugin's own model that lists it; it is
/// never fetched here.
fn inpaint(state: &mut State, rgb: Vec<u8>, mask: Vec<u8>, width: u32, height: u32) -> Result<Vec<u8>> {
    let cpu = state.request.cpu;
    if state.kept.lama.as_ref().is_none_or(|(on_cpu, _)| *on_cpu != cpu) {
        let lama = models::lama_file();
        let listed = lama.is_file() && state.request.models.values().flatten().any(|p| *p == lama);
        if !listed && !models::find("base")?.downloaded() {
            match state.request.named.iter().find(|id| models::find(id).is_ok_and(|m| m.paths().contains(&lama))) {
                Some(id) => bail!("not downloaded: {id}"),
                None => bail!("the inpainter comes with none of the models the plugin declares (one must list lama-manga.safetensors)"),
            }
        }
        state.kept.lama = None;
        (state.progress)("model", "loading", Some("lama-manga"), None);
        let ml = koharu_ml::device(cpu);
        let lama = tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(LaMa::load(ml)))?;
        state.kept.lama = Some((cpu, lama));
    }
    let lama = &state.kept.lama.as_ref().expect("loaded above").1;
    let crop = RgbImage::from_raw(width, height, rgb).context("the crop isn't the size given")?;
    let mask = GrayImage::from_raw(width, height, mask).context("the mask isn't the size given")?;
    let request = InpaintRequest { hd_strategy: HDStrategy::Original, ..InpaintRequest::default() };
    Ok(lama.inference(&image::DynamicImage::ImageRgb8(crop), &mask, &request)?.into_raw())
}

#[cfg(test)]
mod tests {
    use super::{pack, unpack};

    /// Tensors as a pipeline gives them: a count, then each one's rank, sizes and values.
    fn given(shape: &[i64], values: usize) -> Vec<u8> {
        let mut b = 1u32.to_le_bytes().to_vec();
        b.extend_from_slice(&(shape.len() as u32).to_le_bytes());
        shape.iter().for_each(|d| b.extend_from_slice(&d.to_le_bytes()));
        b.extend(std::iter::repeat_n(0u8, values * 4));
        b
    }

    #[test]
    fn tensors_given_are_read_only_when_their_sizes_can_be() {
        let ok = pack(&[(vec![2, 3], vec![1.0; 6])]);
        assert_eq!(unpack(&ok).unwrap(), vec![(vec![2, 3], vec![1.0; 6])]);
        // A negative size, one worked out from the rest, and sizes whose product overflows: errors, not a panic later.
        assert!(unpack(&given(&[-2], 0)).is_err());
        assert!(unpack(&given(&[-1, -1], 0)).is_err());
        assert!(unpack(&given(&[1 << 62, 4], 0)).is_err());
        // Fewer values than the sizes make.
        assert!(unpack(&given(&[4], 3)).is_err());
    }
}
