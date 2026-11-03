//! The models Quire offers, and the files each is made of.
//!
//! Nothing is downloaded unless the user asks for it in Quire
//! (`--download`), and work is refused while something it needs is missing,
//! so a picture never starts a download of its own.
//!
//! The files are listed where Koharu's crates look for them in the store, at
//! the revisions of the Koharu `rev` in Cargo.toml. When raising `rev`, check
//! them against Koharu's `model_repository!` lists, its font set and its local
//! catalog (koharu-translator/src/local/catalog.rs): a file Koharu asks for that
//! is missing here would still be downloaded the first time a page needs it.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{Context as _, Result, bail};
use koharu_runtime::{HuggingFaceFile, Store};
use serde::Serialize;

/// The language model used when the user has not chosen one.
pub const DEFAULT_TRANSLATOR: &str = "qwen3.5-4b";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// The text tools' shared parts: finding the text, painting it out, lettering, and the GPU runtimes.
    Base,
    /// Reads the text (OCR); which one depends on the language of the page.
    Reader,
    /// A language model, which translates text the text tools found.
    Translator,
    /// A plugin's own model, as its manifest declares it (`ownModels`): its files and where they come from.
    Plugin,
    /// Puts pictures and words in one space, for the app's tag suggestions and search by text. ONNX, CPU.
    Embedder,
    /// Names what is in anime and manga pictures, as tags (characters included). ONNX, CPU.
    Tagger,
    /// Finds the subjects of a picture, for Scrapbook's stickers. ONNX, CPU.
    Cutout,
    /// Finds faces and tells whose they are, for People: real people in photos, characters in drawings. ONNX, CPU.
    Faces,
}

struct File {
    repository: &'static str,
    revision: &'static str,
    name: &'static str,
    dataset: bool,
    size: u64,
    /// The model it is part of, for a file not published for download (no `repository`) that is looked
    /// for locally instead.
    owner: &'static str,
}

impl File {
    const fn model(repository: &'static str, revision: &'static str, name: &'static str, size: u64) -> Self {
        Self { repository, revision, name, dataset: false, size, owner: "" }
    }

    fn hf(&self) -> HuggingFaceFile<'static> {
        if self.dataset {
            HuggingFaceFile::pinned_dataset(self.repository, self.revision, self.name)
        } else {
            HuggingFaceFile::pinned(self.repository, self.revision, self.name)
        }
    }

    fn exists(&self) -> bool {
        match self.local() {
            Some(path) => path.is_file(),
            None => self.hf().exists(),
        }
    }

    /// A file not published for download (a plugin's model before it is uploaded): in the folder
    /// `QUIRE_MODEL_<ID>` names (`MY_MODEL` for `my-model`), else in the store's `local/<id>/`.
    fn local(&self) -> Option<PathBuf> {
        if !self.repository.is_empty() {
            return None;
        }
        let var = format!("QUIRE_MODEL_{}", self.owner.to_uppercase().replace(['-', '.'], "_"));
        Some(match std::env::var_os(&var) {
            Some(dir) => PathBuf::from(dir).join(self.name),
            None => local_dir(self.owner).join(self.name),
        })
    }

    /// Where Koharu keeps it (`koharu-runtime`'s `HuggingFaceFile::path`, which is private).
    fn path(&self) -> PathBuf {
        if let Some(path) = self.local() {
            return path;
        }
        Store::root()
            .join("hugging-face")
            .join(if self.dataset { "datasets" } else { "models" })
            .join(self.repository.replace(['/', '\\'], "--"))
            .join("snapshots")
            .join(self.revision)
            .join(self.name)
    }
}

pub struct Model {
    pub id: &'static str,
    pub kind: Kind,
    pub name: &'static str,
    pub note: &'static str,
    files: &'static [File],
    /// It runs on the GPU runtimes itself (a plugin's model may say so).
    runtimes: bool,
}

/// Where a model's files not published for download are put by hand.
pub fn local_dir(id: &str) -> PathBuf {
    Store::root().join("local").join(id)
}

/// A plugin's own model as its manifest declares it (`ownModels` in plugin.json).
#[derive(serde::Deserialize)]
struct Declared {
    id: String,
    name: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    runtimes: bool,
    files: Vec<DeclaredFile>,
}

#[derive(serde::Deserialize)]
struct DeclaredFile {
    #[serde(default)]
    repository: String,
    #[serde(default)]
    revision: String,
    name: String,
    #[serde(default)]
    dataset: bool,
    #[serde(default)]
    size: u64,
}

/// Plugins' own models, declared while the engine runs: they live as long as it does.
static DECLARED: Mutex<Vec<&'static Model>> = Mutex::new(Vec::new());

/// Plugins' own models (a JSON list of `ownModels` entries), added to the catalogue. One declared
/// already keeps its first declaration; an id of the engine's own models is refused.
pub fn declare(json: &str) -> Result<()> {
    let list: Vec<Declared> = serde_json::from_str(json).context("a plugin's models couldn't be read")?;
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    let mut declared = DECLARED.lock().unwrap_or_else(|p| p.into_inner());
    for m in list {
        if MODELS.iter().any(|b| b.id == m.id) {
            bail!("{} is one of the engine's own models, not a plugin's", m.id);
        }
        if m.id.is_empty() || m.id.len() > 64 || !m.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
            bail!("a plugin's model id must be 1-64 of a-z, 0-9, - and .");
        }
        if declared.iter().any(|d| d.id == m.id) {
            continue;
        }
        let owner = leak(m.id.clone());
        let files: Vec<File> = m
            .files
            .into_iter()
            .filter(|f| !f.name.is_empty() && !f.name.contains("..") && !f.name.starts_with('/'))
            .map(|f| File { repository: leak(f.repository), revision: leak(f.revision), name: leak(f.name), dataset: f.dataset, size: f.size, owner })
            .collect();
        declared.push(Box::leak(Box::new(Model { id: owner, kind: Kind::Plugin, name: leak(m.name), note: leak(m.note), files: Box::leak(files.into_boxed_slice()), runtimes: m.runtimes })));
    }
    Ok(())
}

/// Every model: the engine's own, then the plugins'.
fn all() -> Vec<&'static Model> {
    MODELS.iter().chain(DECLARED.lock().unwrap_or_else(|p| p.into_inner()).iter().copied()).collect()
}

const LAYOUT: &str = "mayocream/koharu-layout-rfdetr-seg-2xl-1152";
const LAYOUT_REV: &str = "aed55fdb8ca953c6bec33cf6ed6dd52a9b72bfa2";
const LAMA: &str = "mayocream/lama-manga";
const LAMA_REV: &str = "f91c85b26913b3e83f9877867b4c336da3675238";
const MANGA_OCR: &str = "mayocream/manga-ocr";
const MANGA_OCR_REV: &str = "4380edba990b959c508752350955350c1c80c31c";
const HAYAI_OCR: &str = "JustANormalTinkerer/hayai-ocr-v2";
const HAYAI_OCR_REV: &str = "4a4ce477c9a8841f208b94e1d9ed5c0938965e05";
const QWEN_4B: &str = "unsloth/Qwen3.5-4B-GGUF";
const QWEN_4B_REV: &str = "e87f176479d0855a907a41277aca2f8ee7a09523";
const GEMMA_E4B: &str = "unsloth/gemma-4-E4B-it-qat-GGUF";
const GEMMA_E4B_REV: &str = "8c5a9e4fd5482e2be20fe0bf013b4c262a8f4265";
const GEMMA_12B: &str = "unsloth/gemma-4-12B-it-qat-GGUF";
const GEMMA_12B_REV: &str = "980b060c40a8539ac159e0501a3e0f66a6365af3";
const SIGLIP: &str = "onnx-community/siglip2-base-patch16-256-ONNX";
const SIGLIP_REV: &str = "d1114256522a37ffa257a0a58017348ab0058db2";
pub const SIGLIP_VISION: &str = "onnx/vision_model_fp16.onnx";
pub const SIGLIP_TEXT: &str = "onnx/text_model_fp16.onnx";
pub const SIGLIP_TOKENIZER: &str = "tokenizer.json";
const PIXAI: &str = "deepghs/pixai-tagger-v0.9-onnx";
const PIXAI_REV: &str = "d8cf666911a2c3d10d586d7823259192313c7eb7";
pub const PIXAI_MODEL: &str = "model.onnx";
pub const PIXAI_TAGS: &str = "selected_tags.csv";
const CUTOUT: &str = "onnx-community/BiRefNet_lite-ONNX";
const CUTOUT_REV: &str = "de15b22ba131738a16dff04aab8bdf8dc32e3ac1";
pub const CUTOUT_MODEL: &str = "onnx/model.onnx";
const AURAFACE: &str = "fal/AuraFace-v1";
const AURAFACE_REV: &str = "af6d057c9b0ec4071d4c49c80e3539258798b609";
pub const SCRFD_MODEL: &str = "scrfd_10g_bnkps.onnx";
pub const AURAFACE_MODEL: &str = "glintr100.onnx";
const ANIME_FACE: &str = "deepghs/anime_face_detection";
const ANIME_FACE_REV: &str = "784dc4c0bb692351ddcdbe6131a050b17d3025d5";
pub const ANIME_FACE_MODEL: &str = "face_detect_v1.4_s/model.onnx";
const CCIP: &str = "deepghs/ccip_onnx";
const CCIP_REV: &str = "eb2acdd29af1703388d3d0c04221add322bc9110";
// The larger CCIP: on deepghs' public character test sets it found 93% of a character's faces at 99%
// right, where caformer-24 found 76–80%.
pub const CCIP_MODEL: &str = "ccip-caformer_b36-24/model_feat.onnx";

pub static MODELS: &[Model] = &[
    Model {
        id: "base",
        kind: Kind::Base,
        runtimes: false,
        name: "Text finder and clean-up",
        note: "Finds text and balloons in pictures, paints the original text out and letters new text in. Needed with every text reader and language model.",
        files: &[
            File::model(LAYOUT, LAYOUT_REV, "inference_config.json", 551),
            File::model(LAYOUT, LAYOUT_REV, "model.safetensors", 161_292_684),
            File::model(LAMA, LAMA_REV, "lama-manga.safetensors", 204_332_996),
            File { repository: "mayocream/fonts", revision: "304901a868bebd5f31f95664a462e5839873d939", name: "index.json", dataset: true, size: 6_502_901, owner: "" },
        ],
    },
    Model {
        id: "manga-ocr",
        kind: Kind::Reader,
        runtimes: false,
        name: "Japanese",
        note: "Manga OCR, made for Japanese comics.",
        files: &[
            File::model(MANGA_OCR, MANGA_OCR_REV, "config.json", 77_546),
            File::model(MANGA_OCR, MANGA_OCR_REV, "model.safetensors", 462_959_024),
            File::model(MANGA_OCR, MANGA_OCR_REV, "preprocessor_config.json", 228),
            File::model(MANGA_OCR, MANGA_OCR_REV, "vocab.txt", 24_072),
        ],
    },
    Model {
        id: "hayai-ocr",
        kind: Kind::Reader,
        runtimes: false,
        name: "Korean, Chinese and others",
        note: "Hayai OCR, which reads Korean, Chinese, Japanese and English.",
        files: &[
            File::model(HAYAI_OCR, HAYAI_OCR_REV, "config.json", 342),
            File::model(HAYAI_OCR, HAYAI_OCR_REV, "model.safetensors", 622_502_784),
            File::model(HAYAI_OCR, HAYAI_OCR_REV, "tokenizer.json", 1_247_253),
        ],
    },
    Model {
        id: "qwen3.5-4b",
        kind: Kind::Translator,
        runtimes: false,
        name: "Qwen 3.5 4B",
        note: "The quickest. Runs well on most computers.",
        files: &[
            File::model(QWEN_4B, QWEN_4B_REV, "Qwen3.5-4B-UD-Q4_K_XL.gguf", 2_912_109_728),
            File::model(QWEN_4B, QWEN_4B_REV, "mmproj-F16.gguf", 672_423_616),
        ],
    },
    Model {
        id: "gemma4-e4b-it",
        kind: Kind::Translator,
        runtimes: false,
        name: "Gemma 4 E4B",
        note: "Translates more naturally. Needs more memory.",
        files: &[
            File::model(GEMMA_E4B, GEMMA_E4B_REV, "gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf", 4_215_695_776),
            File::model(GEMMA_E4B, GEMMA_E4B_REV, "mmproj-F16.gguf", 990_372_672),
        ],
    },
    Model {
        id: "gemma4-12b-it",
        kind: Kind::Translator,
        runtimes: false,
        name: "Gemma 4 12B",
        note: "Translates best. Needs a strong GPU and plenty of memory.",
        files: &[
            File::model(GEMMA_12B, GEMMA_12B_REV, "gemma-4-12B-it-qat-UD-Q4_K_XL.gguf", 6_716_356_800),
            File::model(GEMMA_12B, GEMMA_12B_REV, "mmproj-F16.gguf", 175_115_840),
        ],
    },
    Model {
        id: "siglip2",
        kind: Kind::Embedder,
        runtimes: false,
        name: "Picture and word matcher",
        note: "SigLIP 2 (base, 256 px, half precision: its 8-bit version sees noticeably worse). Learns your tags from what you say yes and no to, and finds pictures from words in any language.",
        files: &[
            File::model(SIGLIP, SIGLIP_REV, SIGLIP_VISION, 186_131_676),
            File::model(SIGLIP, SIGLIP_REV, SIGLIP_TEXT, 564_862_230),
            File::model(SIGLIP, SIGLIP_REV, SIGLIP_TOKENIZER, 34_363_039),
        ],
    },
    Model {
        id: "pixai",
        kind: Kind::Tagger,
        runtimes: false,
        name: "Anime tagger",
        note: "PixAI Tagger v0.9: names what is in anime and manga pictures as tags, characters included.",
        files: &[File::model(PIXAI, PIXAI_REV, PIXAI_MODEL, 1_271_365_854), File::model(PIXAI, PIXAI_REV, PIXAI_TAGS, 596_868)],
    },
    Model {
        id: "cutout",
        kind: Kind::Cutout,
        runtimes: false,
        name: "Sticker cutter",
        note: "BiRefNet lite: finds the subjects of a picture, so Scrapbook can cut them out as stickers.",
        files: &[File::model(CUTOUT, CUTOUT_REV, CUTOUT_MODEL, 224_005_088)],
    },
    Model {
        id: "faces",
        kind: Kind::Faces,
        runtimes: false,
        name: "Face finder",
        note: "Finds faces in photos (SCRFD) and tells whose they are (AuraFace, Apache 2.0): People's real people. Runs on this computer.",
        files: &[File::model(AURAFACE, AURAFACE_REV, SCRFD_MODEL, 16_923_827), File::model(AURAFACE, AURAFACE_REV, AURAFACE_MODEL, 260_694_151)],
    },
    Model {
        id: "characters",
        kind: Kind::Faces,
        runtimes: false,
        name: "Character finder",
        note: "Finds faces in drawings (deepghs' anime face detector, MIT) and tells which character they are (CCIP): People's characters. Runs on this computer.",
        files: &[File::model(ANIME_FACE, ANIME_FACE_REV, ANIME_FACE_MODEL, 44_583_229), File::model(CCIP, CCIP_REV, CCIP_MODEL, 383_591_416)],
    },
];

/// What the GPU runtimes take on a Mac (Torch, llama.cpp and stable-diffusion.cpp for Metal).
/// Elsewhere it depends on the graphics card, so it isn't known until they download.
const RUNTIMES_SIZE: Option<u64> = if cfg!(target_os = "macos") { Some(395_742_840) } else { None };

pub fn find(id: &str) -> Result<&'static Model> {
    all().into_iter().find(|m| m.id == id).with_context(|| format!("unknown model {id}"))
}

/// Koharu installs the runtimes the first time they are started; this marks that it happened.
fn runtimes_marker() -> PathBuf {
    Store::root().join(".runtimes")
}

/// Where the engine's inpainter (Koharu's manga LaMa) is kept.
pub fn lama_file() -> PathBuf {
    File::model(LAMA, LAMA_REV, "lama-manga.safetensors", 0).path()
}

/// The GPU runtimes are installed (starting them then downloads nothing).
pub fn runtimes_installed() -> bool {
    runtimes_marker().is_file()
}

/// Where the models converted for the GPU are: by `tools/tag_gpu.py` (`siglip2-vision.pt`, `pixai.pt`)
/// and `tools/face_gpu.py` (the four face models): `QUIRE_GPU_MODELS`, else a checkout's own
/// `target/gpu`. Until they are published they are local; without them those models run on the CPU.
fn gpu_dir() -> PathBuf {
    std::env::var_os("QUIRE_GPU_MODELS").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("gpu"))
}

/// One of the models converted for the GPU, when it is there.
pub fn gpu_file(name: &str) -> Option<PathBuf> {
    Some(gpu_dir().join(name)).filter(|p| p.is_file())
}

/// Any model converted for the GPU is there.
pub fn any_gpu_file() -> bool {
    std::fs::read_dir(gpu_dir()).is_ok_and(|d| d.flatten().any(|e| e.path().extension().is_some_and(|x| x == "pt")))
}

impl Model {
    /// It needs the GPU runtimes: the text tools' shared parts, and a plugin's model that says so.
    fn needs_runtimes(&self) -> bool {
        self.kind == Kind::Base || self.runtimes
    }

    pub fn downloaded(&self) -> bool {
        self.files.iter().all(File::exists) && (!self.needs_runtimes() || runtimes_marker().is_file())
    }

    /// Download size, when known: a plugin's model that needs the runtimes includes them until they are there.
    fn size(&self) -> Option<u64> {
        let files: u64 = self.files.iter().map(|f| f.size).sum();
        match self.kind {
            Kind::Base => RUNTIMES_SIZE.map(|r| r + files),
            Kind::Plugin if self.runtimes && !runtimes_marker().is_file() => RUNTIMES_SIZE.map(|r| r + files),
            _ => Some(files),
        }
    }

    /// Where its files are, in the order `files` lists them.
    pub fn paths(&self) -> Vec<PathBuf> {
        self.files.iter().map(File::path).collect()
    }
}

#[derive(Serialize)]
pub struct Listed {
    id: &'static str,
    kind: Kind,
    name: &'static str,
    note: &'static str,
    size: Option<u64>,
    downloaded: bool,
}

pub fn list() -> Vec<Listed> {
    all()
        .into_iter()
        .map(|m| Listed { id: m.id, kind: m.kind, name: m.name, note: m.note, size: m.size(), downloaded: m.downloaded() })
        .collect()
}

/// Bytes the store takes on disk.
pub fn used() -> u64 {
    fn walk(dir: &std::path::Path) -> u64 {
        let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
        entries
            .flatten()
            .map(|e| match e.file_type() {
                Ok(t) if t.is_dir() => walk(&e.path()),
                Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
                _ => 0,
            })
            .sum()
    }
    walk(Store::root())
}

/// How far a download has got, over all of its files.
#[derive(Default)]
struct Tally {
    /// Bytes of the downloads that have finished.
    done: u64,
    /// Download id -> (completed, total) while it runs.
    running: HashMap<u64, (u64, u64)>,
    /// Still to come after the running ones: the files not started yet.
    ahead: u64,
    name: String,
}

impl Tally {
    fn completed(&self) -> u64 {
        self.done + self.running.values().map(|(c, _)| c).sum::<u64>()
    }

    fn total(&self) -> u64 {
        (self.done + self.running.values().map(|(_, t)| t).sum::<u64>() + self.ahead).max(self.completed())
    }
}

/// Download what these models need (and for a text reader or language model
/// the text tools' shared parts, which every use of them needs), reporting
/// `(completed, total, file)` in bytes as it goes.
pub async fn download(ids: &[String], report: impl Fn(u64, u64, &str) + Send + Sync + 'static) -> Result<()> {
    let mut wanted = Vec::new();
    for id in ids {
        let model = find(id)?;
        if let Some(f) = model.files.iter().find(|f| f.repository.is_empty() && !f.exists()) {
            bail!("{} isn't published for download yet: put {} in {}", model.name, f.name, f.local().map(|p| p.parent().map(|d| d.display().to_string()).unwrap_or_default()).unwrap_or_default());
        }
        if matches!(model.kind, Kind::Reader | Kind::Translator) && !wanted.iter().any(|m: &&Model| m.kind == Kind::Base) {
            wanted.push(find("base")?);
        }
        if !wanted.iter().any(|m| m.id == model.id) {
            wanted.push(model);
        }
    }
    clean();
    let files: Vec<&File> = wanted.iter().flat_map(|m| m.files).filter(|f| !f.exists()).collect();
    // Only for models that run on them: the ONNX ones (tags, stickers) don't.
    let runtimes = wanted.iter().any(|m| m.needs_runtimes()) && !runtimes_marker().is_file();

    let tally = Arc::new(Mutex::new(Tally {
        ahead: files.iter().map(|f| f.size).sum::<u64>() + if runtimes { RUNTIMES_SIZE.unwrap_or(0) } else { 0 },
        ..Tally::default()
    }));
    let report = Arc::new(report);
    let listener = {
        use koharu_runtime::download::{Event as D, subscribe};
        let mut events = subscribe();
        let tally = tally.clone();
        let report = report.clone();
        tokio::spawn(async move {
            let mut last = Instant::now() - Duration::from_secs(1);
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                let mut t = tally.lock().unwrap_or_else(|p| p.into_inner());
                match event {
                    D::Progress { id, name, completed, total } => {
                        t.running.insert(id, (completed, total));
                        t.name = name;
                    }
                    D::Finished { id } => {
                        if let Some((_, total)) = t.running.remove(&id) {
                            t.done += total;
                        }
                    }
                    D::Failed { id, .. } => {
                        t.running.remove(&id);
                    }
                    D::Started { name, .. } => t.name = name,
                }
                if last.elapsed() >= Duration::from_millis(250) {
                    last = Instant::now();
                    report(t.completed(), t.total(), &t.name);
                }
            }
        })
    };

    let result = async {
        if runtimes {
            // Starting the runtimes installs them; their downloads report their own sizes.
            tally.lock().unwrap_or_else(|p| p.into_inner()).ahead -= RUNTIMES_SIZE.unwrap_or(0);
            koharu_ml::init().await.context("could not download the GPU runtimes")?;
            std::fs::write(runtimes_marker(), b"").context("could not note the runtimes as installed")?;
        }
        for file in &files {
            tally.lock().unwrap_or_else(|p| p.into_inner()).ahead -= file.size;
            file.hf().resolve().await.with_context(|| format!("could not download {}", file.name))?;
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    listener.abort();
    let t = tally.lock().unwrap_or_else(|p| p.into_inner());
    if result.is_ok() {
        report(t.total(), t.total(), "");
    }
    result
}

/// Delete a model's files, or with "all" everything in the store.
pub fn remove(id: &str) -> Result<()> {
    if id == "all" {
        let root = Store::root();
        for entry in std::fs::read_dir(root).with_context(|| format!("could not read {}", root.display()))?.flatten() {
            let path = entry.path();
            let gone = if entry.file_type().is_ok_and(|t| t.is_dir()) { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
            gone.with_context(|| format!("could not delete {}", path.display()))?;
        }
        return Ok(());
    }
    let model = find(id)?;
    if model.kind == Kind::Base {
        bail!("the shared parts are needed by every model; remove everything instead");
    }
    for file in model.files {
        if let Some(path) = file.local() {
            bail!("{} was put in {} by hand, not downloaded; it is left where it is", file.name, path.parent().map(|d| d.display().to_string()).unwrap_or_default());
        }
        // A file another downloaded model also uses stays (a plugin's model may list the text tools' LaMa, say).
        let shared = all().into_iter().any(|m| m.id != model.id && m.downloaded() && m.files.iter().any(|f| f.path() == file.path()));
        if shared {
            continue;
        }
        let path = file.path();
        if path.is_file() {
            std::fs::remove_file(&path).with_context(|| format!("could not delete {}", path.display()))?;
        }
        if file.exists() {
            bail!("{} is somewhere this engine doesn't expect; Koharu's store layout has changed", file.name);
        }
        // Folders left empty go too.
        let mut dir = path.parent();
        while let Some(d) = dir.filter(|d| d.starts_with(Store::root()) && *d != Store::root()) {
            if std::fs::remove_dir(d).is_err() {
                break;
            }
            dir = d.parent();
        }
    }
    Ok(())
}

/// Delete what a stopped download left half-written: Koharu stages each file
/// as a `.tmp…` file next to where it goes and renames it when it is complete.
pub fn clean() {
    let mut dirs: Vec<PathBuf> = MODELS.iter().flat_map(|m| m.files).filter(|f| f.local().is_none()).filter_map(|f| f.path().parent().map(PathBuf::from)).collect();
    dirs.dedup();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".tmp") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
