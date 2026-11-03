//! What a picture is about, for the app's tags: an embedding of it by SigLIP 2,
//! which puts pictures and words in one space (so the same model also serves
//! search by text), and the tags the PixAI anime tagger sees in it, with its
//! own embedding of the picture. Both are ONNX models run on the CPU through
//! ONNX Runtime; the app does whole libraries in the background. SigLIP's
//! picture half and PixAI also run on the GPU when they have been converted for
//! it (`tools/tag_gpu.py`) and the Torch runtime is installed: the same
//! vectors, several times faster.

use std::path::Path;

use std::sync::OnceLock;

use anyhow::{Context as _, Result, anyhow, bail};
use image::{RgbImage, imageops::FilterType};
use koharu_ml::torch::{CModule, Device as TorchDevice, IValue, Kind, Tensor as TorchTensor};
use ort::{environment::Environment, session::Session, value::Tensor};

/// SigLIP 2's input: the whole picture squeezed to this square (as its own processor does).
const SIGLIP_SIZE: u32 = 256;
/// SigLIP 2's text window, and the end token every text finishes with.
const SIGLIP_TOKENS: usize = 64;
const SIGLIP_EOS: i64 = 1;
/// SigLIP 2's (base, 256 px) logit scale (e^4.7265), from its weights: what a step in cosine is worth.
pub const SIGLIP_SCALE: f32 = 112.901_18;
/// PixAI's input: the picture squeezed to this square; its embedding's length.
const PIXAI_SIZE: u32 = 448;
const PIXAI_EMBEDDING: usize = 1024;
/// What a crop of the picture covers, of its width and height: four of them, one in each corner.
const PART: f32 = 0.6;

/// The picture-and-word matcher a request names must be SigLIP 2 ("siglip2"), the only one: a request
/// made for some other model is refused rather than answered with SigLIP's numbers, which would not
/// compare with that model's.
pub fn check_embedder(id: &str) -> Result<()> {
    if id != "siglip2" {
        bail!("unknown picture and word matcher {id}");
    }
    Ok(())
}

/// The same for the anime tagger: PixAI ("pixai") is the only one.
pub fn check_tagger(id: &str) -> Result<()> {
    if id != "pixai" {
        bail!("unknown anime tagger {id}");
    }
    Ok(())
}

pub struct Embedder {
    vision: Session,
    text: Session,
    tokenizer: tokenizers::Tokenizer,
    /// The picture half on the GPU, when it is there.
    gpu: Option<OnGpu>,
}

/// One of the tagger's tags: its name and category (0 general, 4 character, 9 rating).
#[derive(Clone, Debug, serde::Serialize)]
pub struct TagName {
    pub name: String,
    pub category: u8,
}

pub struct Tagger {
    model: std::path::PathBuf,
    /// The ONNX model, loaded the first time the GPU can't be used.
    session: Option<Session>,
    gpu: Option<OnGpu>,
    pub names: Vec<TagName>,
}

/// A model on the GPU: TorchScript made by `tools/tag_gpu.py` or `tools/face_gpu.py` from the same
/// weights as the ONNX one (checked against it there), run in half precision.
pub struct OnGpu {
    module: CModule,
    device: TorchDevice,
}

impl OnGpu {
    pub fn load(path: &Path, device: TorchDevice) -> Result<OnGpu> {
        let mut module = CModule::load_on_device(path, device).with_context(|| format!("could not load {}", path.display()))?;
        module.set_eval();
        Ok(OnGpu { module, device })
    }

    /// `n` square pictures (RGB planes, `size` pixels a side, one after the other) through the model:
    /// its output for each.
    fn run(&self, data: &[f32], n: usize, size: u32) -> Result<Vec<Vec<f32>>> {
        let (shape, flat) = self.outputs(data, n, size)?.into_iter().next().context("the model gave nothing")?;
        let width = *shape.last().context("the model gave nothing")? as usize;
        Ok(flat.chunks(width.max(1)).map(<[f32]>::to_vec).collect())
    }

    /// The model's outputs (one, or each of the several it gives) as shape and numbers, as ONNX
    /// Runtime gives them.
    pub fn outputs(&self, data: &[f32], n: usize, size: u32) -> Result<Vec<(Vec<i64>, Vec<f32>)>> {
        koharu_ml::torch::no_grad(|| {
            let input = TorchTensor::from_slice(data).view([n as i64, 3, i64::from(size), i64::from(size)]).to_device(self.device).to_kind(Kind::Half);
            let tensors = match self.module.forward_is(&[IValue::Tensor(input)]).map_err(|e| anyhow!("{e}"))? {
                IValue::Tensor(t) => vec![t],
                IValue::Tuple(all) | IValue::GenericList(all) => all
                    .into_iter()
                    .map(|v| match v {
                        IValue::Tensor(t) => Ok(t),
                        _ => Err(anyhow!("the model gave something other than tensors")),
                    })
                    .collect::<Result<_>>()?,
                IValue::TensorList(all) => all,
                _ => bail!("the model gave something other than tensors"),
            };
            tensors
                .into_iter()
                .map(|t| {
                    let t = t.to_kind(Kind::Float).to_device(TorchDevice::Cpu);
                    Ok((t.size(), Vec::<f32>::try_from(&t.view([-1])).map_err(|e| anyhow!("{e}"))?))
                })
                .collect()
        })
    }
}

/// What the tagger saw: each tag's probability in the order of its names, and its own embedding of
/// the picture, which knows anime far better than the picture-and-word model.
pub struct Seen {
    pub probs: Vec<f32>,
    pub embedding: Vec<f32>,
}

/// One ONNX Runtime for the process. Its errors carry the builder and don't travel, so they are
/// turned into messages here.
fn environment() -> Result<&'static Environment> {
    static ENV: OnceLock<Environment> = OnceLock::new();
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let env = ort::init().with_name("quire").build().map_err(|e| anyhow!("ONNX Runtime did not start: {e}"))?;
    Ok(ENV.get_or_init(|| env))
}

pub(crate) fn session(path: &Path) -> Result<Session> {
    let builder = Session::builder(environment()?).map_err(|e| anyhow!("{e}"))?;
    // Every core: the two models run one after the other per picture, each with the whole machine
    // (`MS_THREADS` to try another number).
    let threads = std::env::var("MS_THREADS").ok().and_then(|t| t.parse().ok()).unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4));
    let builder = builder.with_intra_threads(threads).map_err(|e| anyhow!("{e}"))?;
    // Core ML (`MS_COREML=1`) was tried: these 8-bit and ViT models fall back to the CPU anyway (PixAI
    // splits into 76 pieces and won't build, or runs at a third of the CPU's speed), so the CPU is the
    // default; the switch stays for other models. ONNX Runtime would otherwise pick a device itself,
    // which on a Mac is always Core ML: every model compiled for the Neural Engine first, which takes
    // minutes for these (out of process, so the engine looked idle while the app waited on it).
    let mut builder = if cfg!(target_os = "macos") && std::env::var_os("MS_COREML").is_some() {
        with_core_ml(builder)?
    } else {
        builder.with_auto_device(ort::session::builder::AutoDevicePolicy::PreferCPU).map_err(|e| anyhow!("{e}"))?
    };
    builder.commit_from_file(path).map_err(|e| anyhow!("could not load {}: {e}", path.display()))
}

/// Core ML for a session: ONNX Runtime comes built with it on macOS alone.
#[cfg(target_os = "macos")]
fn with_core_ml(builder: ort::session::builder::SessionBuilder) -> Result<ort::session::builder::SessionBuilder> {
    builder.with_execution_providers([ort::ep::CoreML::default().build()]).map_err(|e| anyhow!("{e}"))
}

#[cfg(not(target_os = "macos"))]
fn with_core_ml(builder: ort::session::builder::SessionBuilder) -> Result<ort::session::builder::SessionBuilder> {
    Ok(builder)
}

/// The output by one of these names (the first that is there), else the first; as numbers.
fn output(outputs: &ort::session::SessionOutputs, names: &[&str]) -> Result<Vec<f32>> {
    let (name, value) = names
        .iter()
        .find_map(|n| outputs.iter().find(|(name, _)| name == n))
        .or_else(|| outputs.iter().next())
        .context("the model gave no output")?;
    let (_shape, data) = value.try_extract_tensor::<f32>().map_err(|e| anyhow!("output {name} is not float: {e}"))?;
    Ok(data.to_vec())
}

/// The embedding of a picture or of words: SigLIP's `pooler_output` (past its head), L2-normalised.
fn embedding(outputs: &ort::session::SessionOutputs) -> Result<Vec<f32>> {
    Ok(unit(output(outputs, &["pooler_output"])?))
}

fn unit(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-6);
    for x in &mut v {
        *x /= norm;
    }
    v
}

/// RGB in planes (NCHW), each channel as (value / 255 − mean) / std.
fn planes(image: &RgbImage, mean: [f32; 3], std: [f32; 3]) -> Vec<f32> {
    let n = (image.width() * image.height()) as usize;
    let mut data = vec![0f32; 3 * n];
    for (i, p) in image.pixels().enumerate() {
        for c in 0..3 {
            data[c * n + i] = (f32::from(p[c]) / 255.0 - mean[c]) / std[c];
        }
    }
    data
}

impl Embedder {
    pub fn load(vision: &Path, text: &Path, tokenizer: &Path) -> Result<Embedder> {
        let tokenizer = tokenizers::Tokenizer::from_file(tokenizer).map_err(|e| anyhow::anyhow!("could not load the tokenizer: {e}"))?;
        Ok(Embedder { vision: session(vision)?, text: session(text)?, tokenizer, gpu: None })
    }

    /// Run the picture half on the GPU from now on.
    pub fn use_gpu(&mut self, gpu: OnGpu) {
        self.gpu = Some(gpu);
    }

    pub fn on_gpu(&self) -> bool {
        self.gpu.is_some()
    }

    /// The picture's embedding, and with `parts` its four crops' (see `parts`), in one go: on the GPU
    /// all five at once.
    pub fn picture(&mut self, image: &RgbImage, parts: bool) -> Result<(Vec<f32>, Vec<Vec<f32>>)> {
        let mut pictures = vec![image.clone()];
        if parts {
            pictures.extend(crops(image));
        }
        let mut all = match &self.gpu {
            Some(gpu) => {
                let data: Vec<f32> = pictures.iter().flat_map(|p| planes(&image::imageops::resize(p, SIGLIP_SIZE, SIGLIP_SIZE, FilterType::Triangle), [0.5; 3], [0.5; 3])).collect();
                gpu.run(&data, pictures.len(), SIGLIP_SIZE)?.into_iter().map(unit).collect()
            }
            None => pictures.iter().map(|p| self.image(p)).collect::<Result<Vec<_>>>()?,
        };
        let whole = all.remove(0);
        Ok((whole, all))
    }

    /// The picture's embedding, of unit length (768 numbers).
    pub fn image(&mut self, image: &RgbImage) -> Result<Vec<f32>> {
        let scaled = image::imageops::resize(image, SIGLIP_SIZE, SIGLIP_SIZE, FilterType::Triangle);
        let data = planes(&scaled, [0.5; 3], [0.5; 3]);
        let input = Tensor::from_array((vec![1usize, 3, SIGLIP_SIZE as usize, SIGLIP_SIZE as usize], data)).map_err(|e| anyhow!("{e}"))?;
        let name = self.vision.inputs().first().context("the vision model has no input")?.name().to_string();
        let outputs = self.vision.run(ort::inputs![name => input]).map_err(|e| anyhow!("{e}"))?;
        embedding(&outputs)
    }

    /// The words' embedding, in the same space as the pictures'. SigLIP reads lower case, ending in
    /// its end token and padded to its window (its tokenizer adds both); a longer text is cut, the end
    /// token kept last. No mask: it was trained on padding.
    pub fn text(&mut self, text: &str) -> Result<Vec<f32>> {
        let enc = self.tokenizer.encode(text.to_lowercase(), true).map_err(|e| anyhow::anyhow!("could not tokenize: {e}"))?;
        let mut ids: Vec<i64> = enc.get_ids().iter().map(|&i| i64::from(i)).collect();
        if ids.len() > SIGLIP_TOKENS {
            ids.truncate(SIGLIP_TOKENS);
            ids[SIGLIP_TOKENS - 1] = SIGLIP_EOS;
        }
        ids.resize(SIGLIP_TOKENS, 0);
        let name = self.text.inputs().first().context("the text model has no input")?.name().to_string();
        let ids_t = Tensor::from_array((vec![1usize, SIGLIP_TOKENS], ids)).map_err(|e| anyhow!("{e}"))?;
        let outputs = self.text.run(ort::inputs![name => ids_t]).map_err(|e| anyhow!("{e}"))?;
        embedding(&outputs)
    }
}

/// Four crops of a picture, one in each corner, each `PART` of its width and height: something small
/// in the picture fills much more of one of them.
fn crops(image: &RgbImage) -> Vec<RgbImage> {
    let (w, h) = image.dimensions();
    let (cw, ch) = (((w as f32) * PART).round().max(1.0) as u32, ((h as f32) * PART).round().max(1.0) as u32);
    [(0, 0), (w - cw, 0), (0, h - ch), (w - cw, h - ch)].into_iter().map(|(x, y)| image::imageops::crop_imm(image, x, y, cw, ch).to_image()).collect()
}

/// The tagger's tag names, from its list (`id,tag_id,name,category,count,ips`). The columns are found
/// by their names in the header, so a list without them is refused rather than read wrong.
pub fn tag_names(tags_csv: &Path) -> Result<Vec<TagName>> {
    let csv = std::fs::read_to_string(tags_csv).with_context(|| format!("could not read {}", tags_csv.display()))?;
    let mut lines = csv.lines();
    let header: Vec<&str> = lines.next().context("the tag list is empty")?.split(',').map(str::trim).collect();
    let col = |name: &str| header.iter().position(|h| *h == name).with_context(|| format!("no {name} column in {}", tags_csv.display()));
    let (name_at, category_at) = (col("name")?, col("category")?);
    // Split only as far as needed: the last columns (PixAI's franchises) hold commas of their own.
    let fields = name_at.max(category_at) + 2;
    let mut names = Vec::new();
    for line in lines.filter(|l| !l.trim().is_empty()) {
        let parts: Vec<&str> = line.splitn(fields, ',').collect();
        if parts.len() <= name_at.max(category_at) {
            bail!("bad line in {}: {line}", tags_csv.display());
        }
        names.push(TagName { name: parts[name_at].trim_matches('"').to_string(), category: parts[category_at].trim().parse().unwrap_or(0) });
    }
    Ok(names)
}

impl Tagger {
    /// The tagger, on the GPU when `gpu` is given, else its ONNX model on the CPU.
    pub fn load(model: &Path, tags_csv: &Path, gpu: Option<OnGpu>) -> Result<Tagger> {
        let session = if gpu.is_some() { None } else { Some(session(model)?) };
        Ok(Tagger { model: model.to_path_buf(), names: tag_names(tags_csv)?, session, gpu })
    }

    /// Each tag's probability, in the order of `names`.
    pub fn tag(&mut self, image: &RgbImage) -> Result<Seen> {
        if let Some(gpu) = &self.gpu {
            let scaled = image::imageops::resize(image, PIXAI_SIZE, PIXAI_SIZE, FilterType::Triangle);
            let out = gpu.run(&planes(&scaled, [0.5; 3], [0.5; 3]), 1, PIXAI_SIZE)?.pop().context("the tagger gave nothing")?;
            // Its embedding, then each tag's probability.
            if out.len() != PIXAI_EMBEDDING + self.names.len() {
                bail!("the tagger gave {} numbers for {} tags", out.len(), self.names.len());
            }
            let (embedding, probs) = out.split_at(PIXAI_EMBEDDING);
            return Ok(Seen { probs: probs.to_vec(), embedding: unit(embedding.to_vec()) });
        }
        if self.session.is_none() {
            self.session = Some(session(&self.model)?);
        }
        let session = self.session.as_mut().expect("loaded above");
        // Squeezed to its square, RGB in planes around 0 (its preprocess.json).
        let scaled = image::imageops::resize(image, PIXAI_SIZE, PIXAI_SIZE, FilterType::Triangle);
        let input = Tensor::from_array((vec![1usize, 3, PIXAI_SIZE as usize, PIXAI_SIZE as usize], planes(&scaled, [0.5; 3], [0.5; 3]))).map_err(|e| anyhow!("{e}"))?;
        let name = session.inputs().first().context("the tagger has no input")?.name().to_string();
        let outputs = session.run(ort::inputs![name => input]).map_err(|e| anyhow!("{e}"))?;
        let (probs, embedding) = (output(&outputs, &["prediction"])?, unit(output(&outputs, &["embedding"])?));
        if probs.len() != self.names.len() {
            bail!("the tagger gave {} numbers for {} tags", probs.len(), self.names.len());
        }
        Ok(Seen { probs, embedding })
    }
}

/// Words that describe a drawn picture, and words that describe a photo: SigLIP tells which a picture
/// is, so the anime tagger (slow) only looks at drawn ones.
pub const DRAWN: &[&str] = &["an anime illustration", "a manga page", "a drawing", "a cartoon", "a comic", "digital art of a character", "an anime screenshot"];
pub const PHOTO: &[&str] = &["a photo", "a photo of a person", "a photo of a place", "a photo of food", "a photo of an animal", "a selfie"];

/// How much more a picture looks drawn than photographed, as the difference of the best logits of
/// the two lists' words (`drawn` and `photo` their embeddings): above 0, drawn.
pub fn drawn_score(picture: &[f32], drawn: &[Vec<f32>], photo: &[Vec<f32>]) -> f32 {
    let best = |words: &[Vec<f32>]| words.iter().map(|w| w.iter().zip(picture).map(|(a, b)| a * b).sum::<f32>()).fold(f32::MIN, f32::max);
    SIGLIP_SCALE * (best(drawn) - best(photo))
}
