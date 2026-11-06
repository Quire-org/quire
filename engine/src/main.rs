//! Quire's local engine.
//!
//! Runs models on this computer: the app's own (picture and word matching, tagging, faces,
//! stickers) and plugins' pipelines, WebAssembly modules they bring (`wasm.rs`), with the tools
//! the engine offers them (their models, an inpainter, text in pictures). Pictures never leave the
//! machine; the only network use is downloading the models the user chose, into the folder given
//! as `--store`.
//!
//! The app starts the engine when something needs it and stops it when it has been idle for a
//! while. They talk in lines of JSON: requests on stdin, events on stdout, logs on stderr.
//!
//! ```text
//! → {"type":"run","id":2,"input":"/page.jpg","output":"/tmp/out.png","module":"/plugins/x/engine.wasm","models":["…"],"options":{…}}
//! ← {"type":"progress","id":2,"stage":"inpainting","state":"running","done":1,"total":2}
//! ← {"type":"done","id":2,"output":"/tmp/out.png","width":1200,"height":1700,"result":{…},"seconds":3.1}
//! → {"type":"shutdown"}
//! ```
//!
//! `run` runs a plugin's own pipeline on a picture: `options` are the plugin's, and `result` is
//! what the pipeline tells it.
//!
//! The models (see `models.rs`) are managed with one-off runs, which print
//! the same kind of lines and exit:
//!
//! ```text
//! --models               ← {"type":"models","models":[{"id":"qwen3.5-4b","kind":"translator","downloaded":true,…}],"used":5123456789,"default":"qwen3.5-4b"}
//! --download qwen3.5-4b  ← {"type":"download","name":"…","completed":…,"total":…} … {"type":"downloaded"}
//! --remove qwen3.5-4b    ← {"type":"removed"}      ("all" removes everything)
//! --clean                deletes what a stopped download left half-written
//! --declare '[…]'        plugins' own models (their manifests' `ownModels`), before any of these
//! ```

use std::{
    collections::HashMap,
    io::{Cursor, Write as _},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt as _, BufReader};

mod cutout;
mod faces;
mod models;
mod tagging;
mod text;
mod wasm;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Message {
    /// A plugin's own pipeline (a WebAssembly module, `wasm.rs`) on a picture: `options` are passed
    /// to it as they are, `models` are the ones its plugin declares (the pipeline can use those that
    /// are downloaded). The picture comes as a file (`input`) or over the pipe (`input_base64`);
    /// the result goes to `output`, or back over the pipe (`output_base64` in `done`).
    Run {
        id: u64,
        #[serde(default)]
        input: Option<PathBuf>,
        #[serde(default)]
        input_base64: Option<String>,
        #[serde(default)]
        output: Option<PathBuf>,
        module: PathBuf,
        #[serde(default)]
        options: serde_json::Value,
        #[serde(default)]
        models: Vec<String>,
        /// The plugin's own models (its manifest's `ownModels`), declared before the run.
        #[serde(default)]
        declare: Option<serde_json::Value>,
        /// The language model the user chose, for text the pipeline has translated.
        #[serde(default)]
        language_model: Option<String>,
        #[serde(default)]
        cpu: bool,
    },
    /// What a picture is about: its embedding, the tagger's tags, either or both.
    Index {
        id: u64,
        #[serde(default)]
        input: Option<PathBuf>,
        #[serde(default)]
        input_base64: Option<String>,
        #[serde(default)]
        options: IndexOptions,
    },
    /// Words in the pictures' space, for search and zero-shot suggestions, by the picture-and-word
    /// matcher ("siglip2", the only one, when none is named).
    EmbedText {
        id: u64,
        text: String,
        #[serde(default)]
        embedder: Option<String>,
    },
    /// The anime tagger's tag names, in the order its numbers come ("pixai", the only one, when none
    /// is named).
    TagNames {
        id: u64,
        #[serde(default)]
        tagger: Option<String>,
    },
    /// How much each pixel belongs to the picture's subjects, for a sticker: a grey PNG at the
    /// picture's own size, or scaled to fit `max_side`.
    Cutout {
        id: u64,
        #[serde(default)]
        input: Option<PathBuf>,
        #[serde(default)]
        input_base64: Option<String>,
        #[serde(default)]
        max_side: Option<u32>,
        /// Only this part of the picture, `[x0, y0, x1, y1]` in fractions of it (upright): the model
        /// looks closer, and the mask is of that part.
        #[serde(default)]
        crop: Option<[f64; 4]>,
    },
    /// The faces in a picture and who they could be, for People: real people's (`photo`), characters'
    /// (`drawn`), or both when it isn't known which the picture is. The character finder is a download
    /// of its own that the user may not have wanted: without it, a picture of unknown kind is looked at
    /// for real people only, and the answer says that characters weren't looked for. With `area`
    /// (fractions of the upright picture: left, top, right, bottom), only the faces in that part,
    /// looked for there alone; `whole`: a drawing's area with none found is taken as the face.
    Faces {
        id: u64,
        #[serde(default)]
        input: Option<PathBuf>,
        #[serde(default)]
        input_base64: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        area: Option<[f32; 4]>,
        #[serde(default)]
        whole: bool,
    },
    Shutdown,
}

/// What `index` found, as asked for.
struct IndexResult {
    width: u32,
    height: u32,
    embedding: Option<Vec<f32>>,
    /// Crops' embeddings (`parts`).
    parts: Vec<Vec<f32>>,
    /// The tagger's (tag, probability) pairs.
    tags: Option<Vec<(usize, f32)>>,
    /// The tagger's own embedding (PixAI).
    anime: Option<Vec<f32>>,
    /// How much more drawn than photographed it looks (SigLIP; above 0, drawn).
    drawn: Option<f32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct IndexOptions {
    #[serde(default = "yes")]
    embed: bool,
    #[serde(default = "yes")]
    tag: bool,
    /// Tags under this probability are left out of the answer (0.1 by default).
    #[serde(default)]
    min_probability: Option<f32>,
    /// The models: "siglip2" and "pixai", the only ones, when none are named.
    #[serde(default)]
    embedder: Option<String>,
    #[serde(default)]
    tagger: Option<String>,
    /// Also embed four crops of the picture.
    #[serde(default)]
    parts: bool,
    /// The tagger only looks at what SigLIP finds drawn (anime, manga, art), not at photos.
    #[serde(default)]
    drawn_only: bool,
}

/// How drawn a picture must look for the tagger to look at it with `drawn_only` (drawings scored 2 to 4,
/// photos -3 to -11, with half-precision SigLIP): generous, a picture
/// left out loses its anime words, a photo let in only costs time.
const DRAWN_MIN: f32 = -1.0;

fn yes() -> bool {
    true
}

/// The bytes of a request's picture: from its file, or from the pipe.
fn input_bytes(input: &Option<PathBuf>, input_base64: &Option<String>) -> Result<Vec<u8>> {
    use base64::Engine as _;
    if let Some(b64) = input_base64 {
        return base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()).context("the picture's bytes are not base64");
    }
    let path = input.as_ref().context("no input")?;
    std::fs::read(path).with_context(|| format!("could not read {}", path.display()))
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event<'a> {
    Ready {
        version: &'a str,
    },
    Progress {
        id: u64,
        stage: String,
        state: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        seconds: Option<f64>,
        /// How far a stage that goes in steps has got: `done` of `total`.
        #[serde(skip_serializing_if = "Option::is_none")]
        done: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        total: Option<u32>,
    },
    /// What `index` found: the embedding (unit length) and the tags over the threshold as `[index, probability]`.
    Indexed {
        id: u64,
        width: u32,
        height: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        embedding: Option<Vec<f32>>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        parts: Vec<Vec<f32>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        tags: Option<Vec<(usize, f32)>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        anime: Option<Vec<f32>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        drawn: Option<f32>,
        seconds: f64,
    },
    Embedded {
        id: u64,
        embedding: Vec<f32>,
    },
    TagNames {
        id: u64,
        names: Vec<tagging::TagName>,
    },
    /// What `faces` found, each with where it is and its numbers (unit length).
    FacesFound {
        id: u64,
        width: u32,
        height: u32,
        faces: Vec<faces::Face>,
        /// The character finder looked at the picture. When it wasn't downloaded, a picture of unknown
        /// kind was looked at for real people only: no characters found doesn't mean there are none.
        characters: bool,
        seconds: f64,
    },
    /// What `cutout` found: the subjects' mask as a grey PNG, at the size it was asked for.
    CutOut {
        id: u64,
        width: u32,
        height: u32,
        mask_base64: String,
        seconds: f64,
    },
    /// How far a `--download` has got, in bytes over all of its files.
    Download {
        name: String,
        completed: u64,
        total: u64,
    },
    Models {
        models: Vec<models::Listed>,
        used: u64,
        default: &'a str,
    },
    Downloaded,
    Removed,
    Done {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        output: Option<PathBuf>,
        /// The result as PNG, when no output file was asked for.
        #[serde(skip_serializing_if = "Option::is_none")]
        output_base64: Option<String>,
        width: u32,
        height: u32,
        /// What a plugin's pipeline (`run`) tells the plugin.
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        seconds: f64,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        message: String,
    },
}

fn emit(event: &Event<'_>) {
    let mut out = std::io::stdout().lock();
    if let Ok(line) = serde_json::to_string(event) {
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

/// Koharu downloads its runtimes and models over rustls, whose default hello
/// carries a post-quantum key share and is about 1.2 kB larger for it. Some
/// VPNs and firewalls stall on a hello that size, and the download then never
/// starts. These are public files, so the classic key exchanges are enough.
fn classic_tls() {
    use rustls::crypto::aws_lc_rs::{default_provider, kx_group};
    let provider = rustls::crypto::CryptoProvider { kx_groups: vec![kx_group::X25519, kx_group::SECP256R1, kx_group::SECP384R1], ..default_provider() };
    let _ = provider.install_default();
}

/// What a run of the engine does.
enum Mode {
    Serve,
    Models,
    Download(Vec<String>),
    Remove(String),
    Clean,
}

#[tokio::main]
async fn main() -> Result<()> {
    classic_tls();
    let mut mode = Mode::Serve;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--store" => {
                let store = args.next().context("--store needs a folder")?;
                koharu_runtime::Store::configure(PathBuf::from(store))?;
            }
            "--models" => mode = Mode::Models,
            "--download" => mode = Mode::Download(args.next().context("--download needs model ids")?.split(',').map(str::to_owned).collect()),
            "--remove" => mode = Mode::Remove(args.next().context("--remove needs a model id")?),
            "--clean" => mode = Mode::Clean,
            // Plugins' own models (their manifests' `ownModels`, as a JSON list), for this run.
            "--declare" => models::declare(&args.next().context("--declare needs the models, as JSON")?)?,
            "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            other => bail!("unknown argument {other}"),
        }
    }
    let done = match mode {
        Mode::Serve => return serve().await,
        Mode::Models => Ok(Event::Models {
            models: models::list(),
            used: models::used(),
            default: models::DEFAULT_TRANSLATOR,
        }),
        Mode::Download(ids) => models::download(&ids, |completed, total, name| emit(&Event::Download { name: name.to_owned(), completed, total })).await.map(|()| Event::Downloaded),
        Mode::Remove(id) => models::remove(&id).map(|()| Event::Removed),
        Mode::Clean => {
            models::clean();
            return Ok(());
        }
    };
    match done {
        Ok(event) => {
            emit(&event);
            Ok(())
        }
        Err(error) => {
            emit(&Event::Error { id: None, message: format!("{error:#}") });
            std::process::exit(1);
        }
    }
}

/// A model converted for the GPU, loaded there; None (and the CPU's ONNX one is used) when it isn't
/// there or doesn't load.
fn on_gpu(name: &str, device: koharu_ml::torch::Device) -> Option<tagging::OnGpu> {
    let path = models::gpu_file(name)?;
    tagging::OnGpu::load(&path, device).map_err(|error| eprintln!("models: {name} stays on the CPU: {error:#}")).ok()
}

/// A downloaded model's files, in the order its catalogue entry lists them.
fn downloaded(id: &str) -> Result<Vec<PathBuf>> {
    let model = models::find(id)?;
    if !model.downloaded() {
        bail!("not downloaded: {id}");
    }
    Ok(model.paths())
}

/// Answer requests as they come, until told to stop.
async fn serve() -> Result<()> {
    emit(&Event::Ready {
        version: env!("CARGO_PKG_VERSION"),
    });

    let mut engine = Engine::default();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    // Requests run one at a time: a page has the GPU to itself.
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Message>(&line) {
            Ok(Message::Shutdown) => break,
            Ok(Message::Index { id, input, input_base64, options }) => {
                let started = Instant::now();
                let indexed = match input_bytes(&input, &input_base64) {
                    Ok(bytes) => engine.index(bytes, &options).await,
                    Err(error) => Err(error),
                };
                match indexed {
                    Ok(r) => emit(&Event::Indexed { id, width: r.width, height: r.height, embedding: r.embedding, parts: r.parts, tags: r.tags, anime: r.anime, drawn: r.drawn, seconds: started.elapsed().as_secs_f64() }),
                    Err(error) => emit(&Event::Error { id: Some(id), message: format!("{error:#}") }),
                }
            }
            Ok(Message::EmbedText { id, text, embedder }) => match engine.embed_text(&text, embedder.as_deref().unwrap_or("siglip2")) {
                Ok(embedding) => emit(&Event::Embedded { id, embedding }),
                Err(error) => emit(&Event::Error { id: Some(id), message: format!("{error:#}") }),
            },
            Ok(Message::TagNames { id, tagger }) => match engine.tag_names(tagger.as_deref().unwrap_or("pixai")) {
                Ok(names) => emit(&Event::TagNames { id, names }),
                Err(error) => emit(&Event::Error { id: Some(id), message: format!("{error:#}") }),
            },
            Ok(Message::Faces { id, input, input_base64, kind, area, whole }) => {
                let started = Instant::now();
                let found = match input_bytes(&input, &input_base64) {
                    Ok(bytes) => engine.faces(bytes, kind.as_deref(), area, whole).await,
                    Err(error) => Err(error),
                };
                match found {
                    Ok((width, height, faces, characters)) => emit(&Event::FacesFound { id, width, height, faces, characters, seconds: started.elapsed().as_secs_f64() }),
                    Err(error) => emit(&Event::Error { id: Some(id), message: format!("{error:#}") }),
                }
            }
            Ok(Message::Cutout { id, input, input_base64, max_side, crop }) => {
                let started = Instant::now();
                match input_bytes(&input, &input_base64).and_then(|bytes| engine.cutout(bytes, max_side, crop)) {
                    Ok((width, height, mask_base64)) => emit(&Event::CutOut { id, width, height, mask_base64, seconds: started.elapsed().as_secs_f64() }),
                    Err(error) => emit(&Event::Error { id: Some(id), message: format!("{error:#}") }),
                }
            }

            Ok(Message::Run { id, input, input_base64, output, module, options, models, declare, language_model, cpu }) => {
                let started = Instant::now();
                if let Some(Err(error)) = declare.map(|d| models::declare(&d.to_string())) {
                    emit(&Event::Error { id: Some(id), message: format!("{error:#}") });
                    continue;
                }
                match input_bytes(&input, &input_base64) {
                    Err(error) => emit(&Event::Error { id: Some(id), message: format!("{error:#}") }),
                    Ok(bytes) => match engine.run(id, bytes, output.as_deref(), &module, options, &models, language_model, cpu).await {
                        Ok((width, height, result, output_base64)) => emit(&Event::Done {
                            id,
                            output: output.filter(|_| output_base64.is_none()),
                            output_base64,
                            width,
                            height,
                            result: Some(result),
                            seconds: started.elapsed().as_secs_f64(),
                        }),
                        Err(error) => emit(&Event::Error { id: Some(id), message: format!("{error:#}") }),
                    },
                }
            }

            Err(error) => emit(&Event::Error {
                id: None,
                message: format!("not a request: {error}"),
            }),
        }
    }
    Ok(())
}

/// Embeddings of the words for drawn pictures, and for photos.
type DrawnWords = (Vec<Vec<f32>>, Vec<Vec<f32>>);

#[derive(Default)]
struct Engine {
    /// The picture-and-word matcher and the anime tagger, loaded on first use.
    embedder: Option<tagging::Embedder>,
    tagger: Option<tagging::Tagger>,
    /// SigLIP's embeddings of the drawn and photo words (`tagging::DRAWN`, `PHOTO`).
    drawn_words: Option<DrawnWords>,
    /// The GPU the converted models run on, once looked for (None inside: none to use).
    gpu: Option<Option<koharu_ml::torch::Device>>,
    cutter: Option<cutout::Cutter>,
    photo_faces: Option<faces::Photo>,
    drawn_faces: Option<faces::Drawn>,
    /// Plugins' own pipelines, and what they keep loaded.
    plugins: wasm::Host,
}

impl Engine {
    /// A plugin's pipeline on a picture: the picture read the right way up (its colour profile kept
    /// for the result), the plugin's models checked, then the module run (`wasm.rs`). What it tells
    /// the plugin, and the picture it gives back, as PNG to `output` or over the pipe.
    #[allow(clippy::too_many_arguments)]
    async fn run(&mut self, id: u64, bytes: Vec<u8>, output: Option<&Path>, module: &Path, options: serde_json::Value, model_ids: &[String], language_model: Option<String>, cpu: bool) -> Result<(u32, u32, serde_json::Value, Option<String>)> {
        use image::ImageDecoder as _;
        let mut decoder = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format()?.into_decoder().context("not a picture Quire can read")?;
        let icc = decoder.icc_profile().ok().flatten();
        let orientation = decoder.orientation().ok();
        let mut decoded = image::DynamicImage::from_decoder(decoder).context("not a picture Quire can read")?;
        let upright = orientation.is_none_or(|o| o == image::metadata::Orientation::NoTransforms);
        if let Some(orientation) = orientation {
            decoded.apply_orientation(orientation);
        }
        let picture = decoded.to_rgb8();
        let (width, height) = picture.dimensions();
        // The pipeline can use the models its plugin declares that are downloaded; one that isn't is
        // said when it is asked for ("not downloaded: …").
        let mut models = HashMap::new();
        for m in model_ids {
            let model = models::find(m)?;
            if model.downloaded() {
                models.insert(m.clone(), model.paths());
            }
        }
        if model_ids.iter().any(|m| models.contains_key(m)) || models::find("base")?.downloaded() {
            koharu_ml::init().await.context("could not start the model runtimes")?;
        }
        let source = upright.then(|| image::guess_format(&bytes).ok()).flatten().map(|f| (bytes.clone(), f.to_mime_type().to_owned()));
        let request = wasm::Request { options: options.to_string(), picture, source, models, named: model_ids.to_vec(), language_model, cpu };
        let progress: wasm::Progress = Arc::new(move |stage, state, model, step| {
            let state = match state {
                "finished" => "finished",
                "loading" => "loading",
                "skipped" => "skipped",
                _ => "running",
            };
            emit(&Event::Progress { id, stage: stage.to_owned(), state, model: model.map(str::to_owned), seconds: None, done: step.map(|s| s.0), total: step.map(|s| s.1) });
        });
        let out = self.plugins.run(module, request, progress)?;
        let result = serde_json::from_str(&out.result).unwrap_or(serde_json::Value::String(out.result));
        let output_base64 = match (out.picture, output) {
            (None, _) => None,
            (Some(p), Some(path)) => {
                write_png(&p, icc, path).with_context(|| format!("could not write {}", path.display()))?;
                None
            }
            (Some(p), None) => Some(base64_png(&image::DynamicImage::ImageRgb8(p), icc)?),
        };
        Ok((width, height, result, output_base64))
    }

    /// The picture-and-word matcher or the tagger a request names, loaded on first use (CPU, ONNX: no
    /// runtimes to start).
    fn embedder(&mut self, id: &str) -> Result<&mut tagging::Embedder> {
        tagging::check_embedder(id)?;
        if self.embedder.is_none() {
            let paths = downloaded(id)?;
            self.embedder = Some(tagging::Embedder::load(&paths[0], &paths[1], &paths[2])?);
        }
        Ok(self.embedder.as_mut().expect("loaded above"))
    }

    fn tagger(&mut self, id: &str) -> Result<&mut tagging::Tagger> {
        tagging::check_tagger(id)?;
        if self.tagger.is_none() {
            let paths = downloaded(id)?;
            let gpu = self.gpu.flatten().and_then(|device| on_gpu("pixai.pt", device));
            self.tagger = Some(tagging::Tagger::load(&paths[0], &paths[1], gpu)?);
        }
        Ok(self.tagger.as_mut().expect("loaded above"))
    }

    /// Look for the GPU once, before the tag or face models load: the Torch runtime installed (starting
    /// it downloads nothing then) and models converted for it. `MS_CPU=1` keeps them all on the CPU.
    async fn find_gpu(&mut self) {
        if self.gpu.is_some() {
            return;
        }
        let mut found = None;
        if std::env::var_os("MS_CPU").is_none() && models::runtimes_installed() && models::any_gpu_file() {
            match koharu_ml::init().await {
                Ok(()) => {
                    let device = koharu_ml::device(false);
                    found = match device.backend {
                        koharu_ml::Backend::Metal if cfg!(all(target_os = "macos", target_arch = "aarch64")) => Some(koharu_ml::torch::Device::Mps),
                        koharu_ml::Backend::Cuda => Some(koharu_ml::torch::Device::Cuda(device.index)),
                        _ => None,
                    };
                }
                Err(error) => eprintln!("models: the GPU runtime didn't start, so the CPU it is: {error:#}"),
            }
        }
        eprintln!("models: {}", if found.is_some() { "on the GPU" } else { "on the CPU" });
        self.gpu = Some(found);
    }

    /// How drawn a picture looks, from its SigLIP embedding.
    fn drawn(&mut self, embedder: &str, picture: &[f32]) -> Result<f32> {
        if self.drawn_words.is_none() {
            let e = self.embedder(embedder)?;
            let drawn = tagging::DRAWN.iter().map(|w| e.text(w)).collect::<Result<Vec<_>>>()?;
            let photo = tagging::PHOTO.iter().map(|w| e.text(w)).collect::<Result<Vec<_>>>()?;
            self.drawn_words = Some((drawn, photo));
        }
        let (drawn, photo) = self.drawn_words.as_ref().expect("made above");
        Ok(tagging::drawn_score(picture, drawn, photo))
    }

    /// A picture's embedding and tags. Big pictures are scaled down first: the models see 256 and 448 px anyway.
    async fn index(&mut self, bytes: Vec<u8>, options: &IndexOptions) -> Result<IndexResult> {
        self.find_gpu().await;
        use image::ImageDecoder as _;
        // `MS_INDEX_TIMING=1`: how long each step took, on stderr.
        let timing = std::env::var_os("MS_INDEX_TIMING").is_some();
        let mut lap = Instant::now();
        let mut step = |name: &str| {
            if timing {
                eprintln!("index: {name} {:.0} ms", lap.elapsed().as_secs_f64() * 1000.0);
            }
            lap = Instant::now();
        };
        let mut decoder = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format()?.into_decoder().context("not an image Quire can index")?;
        let orientation = decoder.orientation().ok();
        let mut decoded = image::DynamicImage::from_decoder(decoder).context("not an image Quire can index")?;
        if let Some(orientation) = orientation {
            decoded.apply_orientation(orientation);
        }
        let (width, height) = (decoded.width(), decoded.height());
        step("decode");
        let small = if width.max(height) > 1024 { decoded.resize(1024, 1024, image::imageops::FilterType::Triangle) } else { decoded };
        let rgb = small.to_rgb8();
        step("shrink");
        let embedder = options.embedder.as_deref().unwrap_or("siglip2");
        if let Some(device) = self.gpu.flatten() {
            let e = self.embedder(embedder)?;
            if !e.on_gpu()
                && let Some(gpu) = on_gpu("siglip2-vision.pt", device)
            {
                e.use_gpu(gpu);
            }
        }
        let (embedding, parts) = if options.embed {
            let (whole, parts) = self.embedder(embedder)?.picture(&rgb, options.parts)?;
            (Some(whole), parts)
        } else {
            (None, Vec::new())
        };
        step("picture and crops");
        let drawn = match &embedding {
            Some(e) if options.drawn_only => Some(self.drawn(embedder, e)?),
            _ => None,
        };
        step("drawn");
        let (mut tags, mut anime) = (None, None);
        if options.tag && drawn.is_none_or(|d| d >= DRAWN_MIN) {
            let seen = self.tagger(options.tagger.as_deref().unwrap_or("pixai"))?.tag(&rgb)?;
            let min = options.min_probability.unwrap_or(0.1);
            let mut found: Vec<(usize, f32)> = seen.probs.iter().enumerate().filter(|(_, p)| **p >= min).map(|(i, p)| (i, *p)).collect();
            found.sort_by(|a, b| b.1.total_cmp(&a.1));
            found.truncate(96);
            tags = Some(found);
            anime = Some(seen.embedding);
        }
        step("tagger");
        Ok(IndexResult { width, height, embedding, parts, tags, anime, drawn })
    }

    /// The faces of a picture, upright: real people's, characters', or both ("photo", "drawn", else both).
    /// With `area` (fractions), the faces in that part (a margin around it looked at too, for the
    /// finder to see the face whole): `whole`, a drawing's area with none is taken as its face. The last
    /// value says whether the character finder looked, which it doesn't at a photo, nor at a picture of
    /// unknown kind while it isn't downloaded.
    async fn faces(&mut self, bytes: Vec<u8>, kind: Option<&str>, area: Option<[f32; 4]>, whole: bool) -> Result<(u32, u32, Vec<faces::Face>, bool)> {
        self.find_gpu().await;
        let device = self.gpu.flatten();
        let gpu = |[finder, recogniser]: [&str; 2]| faces::OnGpus { detector: device.and_then(|d| on_gpu(finder, d)), embedder: device.and_then(|d| on_gpu(recogniser, d)) };
        use image::ImageDecoder as _;
        let mut decoder = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format()?.into_decoder().context("not a picture Quire can look for faces in")?;
        let orientation = decoder.orientation().ok();
        let mut decoded = image::DynamicImage::from_decoder(decoder).context("not a picture Quire can look for faces in")?;
        if let Some(orientation) = orientation {
            decoded.apply_orientation(orientation);
        }
        let (width, height) = (decoded.width(), decoded.height());
        // Big enough for a small face to be read well; the finders shrink it further themselves. A part
        // of it marked for a face is read sharper still: that face is likely a small one.
        let most = if area.is_some() { 4096 } else { 2048 };
        let rgb = if width.max(height) > most { decoded.resize(most, most, image::imageops::FilterType::Triangle) } else { decoded }.to_rgb8();
        let (rw, rh) = (rgb.width() as f32, rgb.height() as f32);
        let px = |a: [f32; 4]| [(a[0] * rw).max(0.0) as u32, (a[1] * rh).max(0.0) as u32, ((a[2] * rw).min(rw) as u32).max(1), ((a[3] * rh).min(rh) as u32).max(1)];
        // The marked part with a margin a quarter its size each way, and which finds are in the part itself.
        let around = area.map(|[l, t, r, b]| {
            let (mw, mh) = ((r - l) * 0.25, (b - t) * 0.25);
            px([(l - mw).max(0.0), (t - mh).max(0.0), (r + mw).min(1.0), (b + mh).min(1.0)])
        });
        let inside = |f: &faces::Face| {
            area.is_none_or(|[l, t, r, b]| {
                let (cx, cy) = ((f.bbox[0] + f.bbox[2]) / 2.0, (f.bbox[1] + f.bbox[3]) / 2.0);
                cx >= l && cx <= r && cy >= t && cy <= b
            })
        };
        let mut found = Vec::new();
        if kind != Some("drawn") {
            if self.photo_faces.is_none() {
                let model = models::find("faces")?;
                if !model.downloaded() {
                    bail!("not downloaded: faces");
                }
                let paths = model.paths();
                self.photo_faces = Some(faces::Photo::load(&paths[0], &paths[1], gpu(faces::PHOTO_GPU))?);
            }
            found.extend(self.photo_faces.as_mut().expect("loaded above").faces(&rgb, around)?.into_iter().filter(inside));
        }
        // The character finder is optional: someone with only photos need not download it. A picture
        // of unknown kind is then looked at with the photo finder alone, and the answer says so. One
        // known to be drawn has nothing else to be looked at with, so it still needs it.
        let characters = match kind {
            Some("photo") => false,
            Some("drawn") => true,
            _ => self.drawn_faces.is_some() || models::find("characters")?.downloaded(),
        };
        if characters {
            if self.drawn_faces.is_none() {
                let model = models::find("characters")?;
                if !model.downloaded() {
                    bail!("not downloaded: characters");
                }
                let paths = model.paths();
                self.drawn_faces = Some(faces::Drawn::load(&paths[0], &paths[1], gpu(faces::DRAWN_GPU))?);
            }
            let drawn = self.drawn_faces.as_mut().expect("loaded above");
            found.extend(drawn.faces(&rgb, around)?.into_iter().filter(inside));
            if found.is_empty() && whole && let Some(a) = area {
                found.push(drawn.marked(&rgb, px(a))?);
            }
        }
        Ok((width, height, found, characters))
    }

    /// The cutout model, loaded on first use (CPU, ONNX).
    fn cutter(&mut self) -> Result<&mut cutout::Cutter> {
        if self.cutter.is_none() {
            let model = models::find("cutout")?;
            if !model.downloaded() {
                bail!("not downloaded: cutout");
            }
            self.cutter = Some(cutout::Cutter::load(&model.paths()[0])?);
        }
        Ok(self.cutter.as_mut().expect("loaded above"))
    }

    /// The subjects' mask of a picture, upright, at its size or scaled to fit `max_side`: (width, height, grey PNG as base64).
    fn cutout(&mut self, bytes: Vec<u8>, max_side: Option<u32>, crop: Option<[f64; 4]>) -> Result<(u32, u32, String)> {
        use image::ImageDecoder as _;
        let mut decoder = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format()?.into_decoder().context("not a picture Quire can cut out")?;
        let orientation = decoder.orientation().ok();
        let mut decoded = image::DynamicImage::from_decoder(decoder).context("not a picture Quire can cut out")?;
        if let Some(orientation) = orientation {
            decoded.apply_orientation(orientation);
        }
        if let Some([x0, y0, x1, y1]) = crop {
            let (w, h) = (f64::from(decoded.width()), f64::from(decoded.height()));
            let (left, top) = ((x0.clamp(0.0, 1.0) * w) as u32, (y0.clamp(0.0, 1.0) * h) as u32);
            let (right, bottom) = ((x1.clamp(0.0, 1.0) * w).ceil() as u32, (y1.clamp(0.0, 1.0) * h).ceil() as u32);
            if right <= left + 4 || bottom <= top + 4 {
                bail!("the part to look at is too small");
            }
            decoded = decoded.crop_imm(left, top, right - left, bottom - top);
        }
        let (w, h) = (decoded.width(), decoded.height());
        let fit = max_side.unwrap_or(w.max(h)).max(1) as f64 / f64::from(w.max(h));
        let (mw, mh) = if fit < 1.0 { (((f64::from(w) * fit).round() as u32).max(1), ((f64::from(h) * fit).round() as u32).max(1)) } else { (w, h) };
        // The model sees 1024 px: a big picture is scaled down first, so the scaling is cheap.
        let small = if w.max(h) > 2048 { decoded.resize(2048, 2048, image::imageops::FilterType::Triangle) } else { decoded };
        let mask = self.cutter()?.mask(&small.to_rgb8(), mw, mh)?;
        let mut png = Vec::new();
        image::DynamicImage::ImageLuma8(mask).write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)?;
        use base64::Engine as _;
        Ok((mw, mh, base64::engine::general_purpose::STANDARD.encode(&png)))
    }

    fn embed_text(&mut self, text: &str, embedder: &str) -> Result<Vec<f32>> {
        self.embedder(embedder)?.text(text)
    }

    /// The names only: the tagger itself isn't loaded for them.
    fn tag_names(&mut self, tagger: &str) -> Result<Vec<tagging::TagName>> {
        tagging::check_tagger(tagger)?;
        if let Some(t) = &self.tagger {
            return Ok(t.names.clone());
        }
        let paths = downloaded(tagger)?;
        tagging::tag_names(&paths[1])
    }

}

/// The image as a PNG in memory (with the colour profile the original had), base64 for the pipe.
fn base64_png(image: &image::DynamicImage, icc: Option<Vec<u8>>) -> Result<String> {
    use base64::Engine as _;
    use image::ImageEncoder as _;
    let mut out = Vec::new();
    let mut encoder = image::codecs::png::PngEncoder::new(&mut out);
    if let Some(icc) = icc {
        let _ = encoder.set_icc_profile(icc);
    }
    match image {
        image::DynamicImage::ImageRgb8(img) => encoder.write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgb8)?,
        other => {
            let img = other.to_rgba8();
            encoder.write_image(img.as_raw(), img.width(), img.height(), image::ExtendedColorType::Rgba8)?;
        }
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(out))
}

fn write_png(image: &image::RgbImage, icc: Option<Vec<u8>>, path: &Path) -> Result<()> {
    use image::ImageEncoder as _;
    let mut file = std::io::BufWriter::new(std::fs::File::create(path)?);
    let mut encoder = image::codecs::png::PngEncoder::new(&mut file);
    if let Some(icc) = icc {
        let _ = encoder.set_icc_profile(icc);
    }
    encoder.write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgb8)?;
    // The last of it written, or the error said (a dropped BufWriter would lose it silently).
    std::io::Write::flush(&mut file)?;
    Ok(())
}
