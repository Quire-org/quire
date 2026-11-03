//! Text in pictures, for plugins' pipelines (`wasm.rs`): Koharu's stages on the run's picture, one
//! call at a time. Detection finds the text and the balloons, OCR reads it, translation translates
//! it with a local language model, inpainting paints the original text out, and lettering draws
//! the translation in. Which stages a plugin runs, in what order, and what it makes of the regions
//! are its own; this runs them, checks their models, and says what is on the page.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};

use anyhow::{Context as _, Result, anyhow, bail};
use image::RgbImage;
use koharu_config::Config;
use koharu_pipeline::{
    Committer, DetectionModel, InpaintingModel, KoharuLayoutRFDetrSeg2XLConfig, OcrModel,
    Operation, Pipeline, PipelineConfig, Progress, ProgressSink, Request, Scope, Stage,
    StageOutput, TranslationConfig,
};
use koharu_rasterizer::{RasterOptions, Rasterizer};
use koharu_renderer::{Renderer, TypesettingConfig};
use koharu_scene::{
    AssetInput, AssetMetadata, AssetRole, At, EntityId, Geometry, PageDraft, RemovePolicy, Session,
    Snapshot,
};
use koharu_translator::{GenerationConfig, Language, ModelSelection, Provider, ProvidersConfig};
use serde::{Deserialize, Serialize};

use crate::models;

/// Lettering fonts most computers already have, so nothing is downloaded and
/// there is no licence question. (Koharu's own default, CC Wild Words, is a
/// commercial font its font set marks as unreviewed.)
const DEFAULT_FONTS: &[&str] = &["Comic Sans MS", "Chalkboard SE", "Arial"];

/// The text tools' shared parts: finding the text, painting it out, lettering, and the GPU runtimes.
const SHARED: &str = "base";

/// What a progress report says: the stage, its state, the model at work.
pub type Report = Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>;

/// Kept between runs: the pipeline (its models stay loaded while the choices stay the same), the
/// renderer for the fonts last asked for, and the installed fonts.
#[derive(Default)]
pub struct Tools {
    pipeline: Option<(Choice, Pipeline)>,
    renderer: Option<(Vec<String>, Renderer)>,
    rasterizer: Option<Rasterizer>,
    installed: Option<HashSet<String>>,
}

/// One run's page, in a project in memory.
pub struct Page {
    session: Session,
    page: EntityId,
}

/// What a `stages` call asks for.
#[derive(Deserialize)]
struct Stages {
    stages: Vec<String>,
    /// Stages to come in later calls, whose models are checked now with these, so a missing one is
    /// said before any work (and every missing one at once).
    #[serde(default)]
    need: Vec<String>,
    #[serde(default)]
    ocr: Option<String>,
    #[serde(default)]
    llm: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    instructions: Option<String>,
}

/// The models and settings a pipeline is made with.
#[derive(Clone, PartialEq)]
struct Choice {
    ocr: &'static str,
    llm: String,
    target: String,
    instructions: Option<String>,
    cpu: bool,
}

/// One block of text on the page, in pixels of the picture.
#[derive(Serialize)]
struct Region {
    id: EntityId,
    source: String,
    translation: String,
    /// Where the text was found.
    text: Option<[f64; 4]>,
    /// Where it is lettered.
    frame: Option<[f64; 4]>,
    /// The balloon it sits in, when it has one.
    balloon: Option<[f64; 4]>,
}

/// What a run may use: the files of each model its plugin names that the user downloaded.
pub struct Allowed<'a> {
    pub models: &'a HashMap<String, Vec<PathBuf>>,
    pub named: &'a [String],
    /// The language model the user chose in Local models.
    pub chosen: Option<&'a str>,
    pub cpu: bool,
}

impl Allowed<'_> {
    /// A model the plugin names: whether the user downloaded it.
    fn has(&self, id: &str) -> Result<bool> {
        if self.models.contains_key(id) {
            return Ok(true);
        }
        if self.named.iter().any(|n| n == id) {
            return Ok(false);
        }
        bail!("the plugin doesn't name the model {id} in its plugin.json")
    }
}

/// Refuses while any of `ids` isn't downloaded, naming every one that isn't.
fn downloaded(missing: &[&str]) -> Result<()> {
    if missing.is_empty() { Ok(()) } else { bail!("not downloaded: {}", missing.join(", ")) }
}

fn stage(name: &str) -> Result<Stage> {
    Ok(match name {
        "detection" => Stage::Detection,
        "ocr" => Stage::Ocr,
        "translation" => Stage::Translation,
        "inpainting" => Stage::Inpainting,
        other => bail!("there is no text stage {other} (detection, ocr, translation, inpainting)"),
    })
}

impl Page {
    /// A page made from the picture's own file (`bytes`, as `mime`), `width` × `height`.
    pub async fn new(bytes: Vec<u8>, mime: &str, width: u32, height: u32) -> Result<Self> {
        let mut session = Session::memory().await?;
        let mut added = None;
        let patch = session.snapshot().patch(|edit| {
            let page = edit.add_page(PageDraft::new("page", f64::from(width), f64::from(height)), At::End)?;
            edit.set_asset(
                page,
                &AssetRole::new("source")?,
                AssetInput::new(Arc::<[u8]>::from(bytes), mime, AssetMetadata { width: Some(width), height: Some(height), attributes: BTreeMap::new() }),
            )?;
            added = Some(page);
            Ok(())
        })?;
        session.commit(patch).await?;
        Ok(Self { session, page: added.context("the page was not added")? })
    }

    /// What is on the page now, as the SDK's `text` calls answer.
    fn regions(&self, model: Option<&str>) -> Result<Vec<u8>> {
        let regions = regions(&self.session.snapshot(), self.page)?;
        let mut answer = serde_json::json!({ "regions": regions });
        if let Some(m) = model {
            answer["model"] = m.into();
        }
        Ok(answer.to_string().into_bytes())
    }

    /// Take regions (text layers, by id) off the page, with what was read in them.
    pub async fn drop(&mut self, json: &str) -> Result<Vec<u8>> {
        let ids: Vec<EntityId> = serde_json::from_str(json).context("the regions to drop must be a list of their ids")?;
        let snapshot = self.session.snapshot();
        let mut drop = Vec::new();
        if let Some(group) = snapshot.page(self.page)?.text_group()? {
            for layer in group.text_layers()? {
                if ids.contains(&layer.id()) {
                    drop.push((layer.id(), layer.content()?.id()));
                }
            }
        }
        if !drop.is_empty() {
            let patch = snapshot.patch(|edit| {
                for (layer, content) in &drop {
                    edit.remove_entity(*layer, RemovePolicy::Cascade)?;
                    edit.remove_entity(*content, RemovePolicy::Cascade)?;
                }
                Ok(())
            })?;
            self.session.commit(patch).await?;
        }
        self.regions(None)
    }
}

impl Tools {
    /// Run stages on the page: their models checked, then the pipeline (made again only when the
    /// choices change). The regions after them, and the language model when it translated.
    pub async fn stages(&mut self, page: &mut Page, json: &str, allowed: &Allowed<'_>, report: Report) -> Result<Vec<u8>> {
        let ask: Stages = serde_json::from_str(json).context("the stages asked for couldn't be read")?;
        let stages = ask.stages.iter().map(|s| stage(s)).collect::<Result<Vec<_>>>()?;
        let needed = ask.need.iter().map(|s| stage(s)).collect::<Result<Vec<_>>>()?;
        let uses = |s: Stage| stages.contains(&s) || needed.contains(&s);
        // Only models the catalogue knows, so nothing is fetched without asking.
        let ocr = match ask.ocr.as_deref() {
            Some("manga-ocr") => "manga-ocr",
            Some("hayai-ocr") => "hayai-ocr",
            Some(other) => bail!("there is no text reader {other} (manga-ocr, hayai-ocr)"),
            None if uses(Stage::Ocr) => bail!("say which text reader reads it (\"ocr\": manga-ocr or hayai-ocr)"),
            None => "manga-ocr",
        };
        let llm = ask.llm.clone().or_else(|| allowed.chosen.map(str::to_owned)).unwrap_or_else(|| models::DEFAULT_TRANSLATOR.to_owned());
        if uses(Stage::Translation) && !matches!(models::find(&llm), Ok(m) if m.kind == models::Kind::Translator) {
            bail!("there is no language model {llm}");
        }
        let mut missing = Vec::new();
        if !models::find(SHARED)?.downloaded() {
            missing.push(SHARED);
        }
        if uses(Stage::Ocr) && !allowed.has(ocr)? {
            missing.push(ocr);
        }
        if uses(Stage::Translation) && !allowed.has(&llm)? {
            missing.push(llm.as_str());
        }
        downloaded(&missing)?;
        let choice = Choice { ocr, llm, target: ask.target.unwrap_or_else(|| "en".into()), instructions: ask.instructions, cpu: allowed.cpu };
        let pipeline = self.pipeline(&choice)?;
        let progress: ProgressSink = Arc::new(move |event| {
            let (stage, state, model) = match event {
                Progress::Loading { stage, model, .. } => (stage, "loading", Some(model)),
                Progress::Running { stage, model, .. } => (stage, "running", Some(model)),
                Progress::Finished { stage, model, .. } => (stage, "finished", Some(model)),
                Progress::Skipped { stage, .. } => (stage, "skipped", None),
                Progress::Started { .. } => return,
            };
            report(&stage.to_string(), state, model.as_deref());
        });
        let snapshot = page.session.snapshot();
        let mut committer = SessionCommitter(&mut page.session);
        let request = Request { operation: Operation::Stages { stages: stages.clone() }, scope: Scope::Pages(vec![page.page]), progress: Some(progress), ..Request::default() };
        pipeline.execute(snapshot, request, &mut committer).await?;
        page.regions(stages.contains(&Stage::Translation).then_some(choice.llm.as_str()))
    }

    /// The page as it is now, lettered with the first of `fonts` that are installed (fonts from
    /// Koharu's own set would be downloaded, so they are left out): width, height, RGB.
    pub async fn letter(&mut self, page: &Page, json: &str) -> Result<Vec<u8>> {
        #[derive(Deserialize, Default)]
        struct Letter {
            #[serde(default)]
            fonts: Vec<String>,
        }
        let ask: Letter = if json.trim().is_empty() { Letter::default() } else { serde_json::from_str(json).context("the lettering asked for couldn't be read")? };
        downloaded(if models::find(SHARED)?.downloaded() { &[] } else { &[SHARED] })?;
        let installed = self.installed.get_or_insert_with(|| {
            let mut collection = fontique::Collection::new(fontique::CollectionOptions::default());
            collection.family_names().map(str::to_lowercase).collect()
        });
        let mut fonts: Vec<String> = ask.fonts.into_iter().filter(|f| installed.contains(&f.to_lowercase())).take(8).collect();
        if fonts.is_empty() {
            fonts = DEFAULT_FONTS.iter().map(|f| f.to_string()).collect();
        }
        if self.renderer.as_ref().is_none_or(|(current, _)| current != &fonts) {
            self.renderer = Some((fonts.clone(), Renderer::from_config(Config::memory(TypesettingConfig { font_families: fonts }))?));
        }
        if self.rasterizer.is_none() {
            self.rasterizer = Some(Rasterizer::new()?);
        }
        let snapshot = page.session.snapshot();
        let frame = self.renderer.as_ref().expect("set above").1.render(&snapshot, page.page).await?;
        let raster = self.rasterizer.as_ref().expect("set above").rasterize(&frame.raster_frame()?, RasterOptions::default())?;
        let rgb: RgbImage = image::DynamicImage::ImageRgba8(raster.image).to_rgb8();
        let mut out = Vec::with_capacity(8 + rgb.as_raw().len());
        out.extend_from_slice(&rgb.width().to_le_bytes());
        out.extend_from_slice(&rgb.height().to_le_bytes());
        out.extend_from_slice(rgb.as_raw());
        Ok(out)
    }

    /// The pipeline for these choices, made again (with fresh models) only when they change.
    fn pipeline(&mut self, choice: &Choice) -> Result<Pipeline> {
        if let Some((current, pipeline)) = &self.pipeline
            && current == choice
        {
            return Ok(pipeline.clone());
        }
        // Let go of the old models before loading new ones.
        self.pipeline = None;
        let target_language = choice.target.parse::<Language>().map_err(|_| anyhow!("unknown target language {}", choice.target))?;
        let config = PipelineConfig {
            detection: DetectionModel::KoharuLayoutRFDetrSeg2XL(KoharuLayoutRFDetrSeg2XLConfig::default()),
            ocr: if choice.ocr == "manga-ocr" { OcrModel::MangaOcr } else { OcrModel::HayaiOcr },
            translation: TranslationConfig {
                // Only the local provider: pictures never leave the computer.
                model: ModelSelection { provider: Provider::Local, model: Some(choice.llm.clone()), quantization: None, vision: true, reasoning: true },
                generation: GenerationConfig::default(),
                target_language,
                instructions: choice.instructions.clone(),
            },
            inpainting: InpaintingModel::LaMa {},
            processor: Default::default(),
        };
        let pipeline = Pipeline::from_config(Config::memory(config), Config::memory(ProvidersConfig::default()), koharu_ml::device(choice.cpu))?;
        self.pipeline = Some((choice.clone(), pipeline.clone()));
        Ok(pipeline)
    }
}

struct SessionCommitter<'a>(&'a mut Session);

#[async_trait::async_trait]
impl Committer for SessionCommitter<'_> {
    async fn commit(&mut self, output: StageOutput) -> Result<Snapshot> {
        Ok(self.0.commit(output.patch).await?.snapshot)
    }
}

/// Each text layer on the page with its source, translation and where it is.
fn regions(snapshot: &Snapshot, page: EntityId) -> Result<Vec<Region>> {
    let mut out = Vec::new();
    let Some(group) = snapshot.page(page)?.text_group()? else {
        return Ok(out);
    };
    for layer in group.text_layers()? {
        let content = layer.content()?;
        let text = match content.source_region()? {
            Some(region) => bounds(&region.geometry()?),
            None => None,
        };
        let balloon = match layer.balloon_target()? {
            Some(region) => bounds(&region.geometry()?),
            None => None,
        };
        out.push(Region {
            id: layer.id(),
            source: content.source()?.map(|s| s.text.value).unwrap_or_default(),
            translation: content.translation()?.map(|t| t.text.value).unwrap_or_default(),
            text,
            frame: layer.frame()?.as_ref().and_then(bounds),
            balloon,
        });
    }
    Ok(out)
}

fn bounds(geometry: &Geometry) -> Option<[f64; 4]> {
    let mut points = geometry.points.iter();
    let first = points.next()?;
    let (mut x0, mut y0, mut x1, mut y1) = (first.x, first.y, first.x, first.y);
    for p in points {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    Some([x0, y0, x1 - x0, y1 - y0])
}
