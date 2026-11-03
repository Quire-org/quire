//! The local engine (`../engine`), run as its own process: the app's models (tags, faces,
//! stickers) and plugins' own pipelines (WebAssembly modules they bring, for plugins with
//! `engine`). It starts when something first asks for it, stays up while requests keep coming so
//! its models stay loaded, and stops after five idle minutes. Pictures go to it over its pipe and
//! come back the same way; nothing leaves the computer. The models live where the user chose (the
//! app's data folder by default). The user downloads them in Local models
//! (`src/screens/LocalModels.tsx`), which lists, downloads and removes them with one-off runs of
//! the engine; it never downloads anything while it works.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const IDLE: Duration = Duration::from_secs(300);
/// A plugin's pipeline can take a while on a picture, the first one most: its models load before it runs.
const PAGE: Duration = Duration::from_secs(30 * 60);
/// A model's answer for one picture or word (its model loading first, on the CPU, included).
const QUICK: Duration = Duration::from_secs(4 * 60);
const EXE: &str = if cfg!(windows) { "quire-engine.exe" } else { "quire-engine" };

#[derive(Default)]
pub struct EngineState {
    running: Mutex<Option<Running>>,
    /// One request at a time: the engine has the GPU to itself.
    turn: Mutex<()>,
    last_used: Arc<Mutex<Option<Instant>>>,
    /// The download under way, if any: the engine run doing it.
    download: Arc<Mutex<Option<Child>>>,
}

/// Request id -> (plugin that asked, what it asked for, where its answer goes).
type Waiting = Arc<Mutex<HashMap<u64, (String, &'static str, mpsc::Sender<Result<Value, String>>)>>>;

struct Running {
    child: Child,
    stdin: ChildStdin,
    waiting: Waiting,
    next: u64,
}

/// What can be downloaded, what is, and which language model is chosen.
#[derive(Serialize)]
pub struct Catalog {
    /// The engine program is there to run.
    pub available: bool,
    /// `{ id, kind, name, note, size, downloaded }`, as the engine lists them.
    pub models: Vec<Value>,
    /// Bytes the models take on disk.
    pub used: u64,
    pub chosen: String,
    pub downloading: bool,
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub completed: u64,
    pub total: u64,
    /// The file coming in.
    pub name: String,
}

pub fn catalog(app: &AppHandle, state: &EngineState) -> Result<Catalog, String> {
    let downloading = state.download.lock().unwrap_or_else(|p| p.into_inner()).is_some();
    if engine_path(app).is_none() {
        return Ok(Catalog { available: false, models: Vec::new(), used: 0, chosen: String::new(), downloading });
    }
    let listed = once(app, &["--models"])?;
    let models = listed["models"].as_array().cloned().unwrap_or_default();
    let fallback = listed["default"].as_str().unwrap_or_default().to_string();
    let chosen = saved_choice(app).filter(|id| models.iter().any(|m| m["id"] == id.as_str() && m["kind"] == "translator")).unwrap_or(fallback);
    Ok(Catalog { available: true, models, used: listed["used"].as_u64().unwrap_or(0), chosen, downloading })
}

/// Use this language model when a plugin's pipeline doesn't name one.
pub fn choose(app: &AppHandle, state: &EngineState, llm: &str) -> Result<(), String> {
    if !catalog(app, state)?.models.iter().any(|m| m["id"] == llm && m["kind"] == "translator") {
        return Err(format!("unknown language model {llm}"));
    }
    let mut settings = settings(app);
    settings["llm"] = Value::String(llm.to_string());
    save_settings(app, &settings)
}

fn saved_choice(app: &AppHandle) -> Option<String> {
    settings(app)["llm"].as_str().map(str::to_string)
}

/// The engine's settings (`translation.json` in the app's data, named when it only translated): the
/// chosen language model, where the models are.
fn settings(app: &AppHandle) -> Value {
    app.path().app_data_dir().ok().and_then(|d| std::fs::read(d.join("translation.json")).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| serde_json::json!({}))
}

fn save_settings(app: &AppHandle, settings: &Value) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("translation.json"), settings.to_string()).map_err(|e| e.to_string())
}

/// Where the models are kept: the folder chosen, or the app's data folder.
#[derive(Serialize)]
pub struct StoreInfo {
    /// The chosen folder, or null for the app's data folder.
    pub path: Option<String>,
    /// The app's data folder, used when none is chosen.
    pub default: String,
}

pub fn store_info(app: &AppHandle) -> Result<StoreInfo, String> {
    Ok(StoreInfo { path: settings(app)["store"].as_str().map(str::to_string), default: default_store(app)?.to_string_lossy().into_owned() })
}

/// Keep the models in this folder (null: the app's data folder) from now on. Downloaded models stay
/// where they are; the engine starts again with the new folder when next used.
pub fn set_store(app: &AppHandle, state: &EngineState, path: Option<String>) -> Result<(), String> {
    if let Some(p) = &path {
        let dir = PathBuf::from(p);
        if !dir.is_absolute() {
            return Err("the models folder must be a full path".into());
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("could not use {}: {e}", dir.display()))?;
    }
    let mut settings = settings(app);
    match &path {
        Some(p) => settings["store"] = Value::String(p.clone()),
        None => {
            settings.as_object_mut().map(|o| o.remove("store"));
        }
    }
    save_settings(app, &settings)?;
    stop(state);
    Ok(())
}

/// Download a model, and the shared parts every model needs if they aren't there yet. Blocks until it is done or cancelled.
pub fn download(app: &AppHandle, state: &EngineState, id: &str, ctl: std::sync::Arc<crate::jobctl::Control>, progress: impl Fn(DownloadProgress)) -> Result<(), String> {
    let exe = engine_path(app).ok_or(NOT_INSTALLED)?;
    let (stdout, pid) = {
        let mut slot = state.download.lock().unwrap_or_else(|p| p.into_inner());
        if slot.is_some() {
            return Err("a download is already under way".to_string());
        }
        let mut child = engine(app, &exe)?.arg("--download").arg(id).stdout(Stdio::piped()).spawn().map_err(|e| format!("could not start the local engine: {e}"))?;
        let stdout = child.stdout.take().ok_or("no engine output")?;
        let pid = child.id();
        *slot = Some(child);
        (stdout, pid)
    };
    // Paused from Activity: the engine is suspended where it is (a long pause may need the download started again).
    let _watch = crate::jobctl::watch_child(ctl, pid);
    let mut failed = None;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        match event["type"].as_str() {
            Some("download") => progress(DownloadProgress {
                completed: event["completed"].as_u64().unwrap_or(0),
                total: event["total"].as_u64().unwrap_or(0),
                name: event["name"].as_str().unwrap_or_default().to_string(),
            }),
            Some("error") => failed = event["message"].as_str().map(str::to_string),
            _ => {}
        }
    }
    let child = state.download.lock().unwrap_or_else(|p| p.into_inner()).take();
    // Cancelling took the child already and killed it.
    let Some(mut child) = child else { return Err("cancelled".to_string()) };
    let status = child.wait().map_err(|e| e.to_string())?;
    match failed {
        Some(message) => Err(message),
        None if status.success() => Ok(()),
        None => Err("the download stopped".to_string()),
    }
}

/// Stop the download under way and delete what it left half-written.
pub fn cancel_download(app: &AppHandle, state: &EngineState) -> Result<(), String> {
    let Some(mut child) = state.download.lock().unwrap_or_else(|p| p.into_inner()).take() else { return Ok(()) };
    let _ = child.kill();
    let _ = child.wait();
    once(app, &["--clean"]).map(|_| ())
}

/// Delete a model's files ("all": every model and the runtimes).
pub fn remove(app: &AppHandle, state: &EngineState, id: &str) -> Result<(), String> {
    if state.download.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        return Err("wait for the download to finish first".to_string());
    }
    // The engine may have the model open; it lets go between pages.
    let _turn = state.turn.lock().unwrap_or_else(|p| p.into_inner());
    stop(state);
    once(app, &["--remove", id]).map(|_| ())
}

const NOT_INSTALLED: &str = "The local engine is not installed. Build it with `npm run engine` in Quire's source folder.";

/// The engine, told where the models are.
fn engine(app: &AppHandle, exe: &Path) -> Result<Command, String> {
    let store = store(app)?;
    std::fs::create_dir_all(&store).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.arg("--store").arg(&store).stdin(Stdio::null()).stderr(if std::env::var_os("QUIRE_DEBUG").is_some() { Stdio::inherit() } else { Stdio::null() });
    // The models installed plugins bring, in its catalogue for this run.
    let own = crate::own_models(app);
    if !own.is_empty() {
        cmd.arg("--declare").arg(Value::Array(own).to_string());
    }
    Ok(cmd)
}

/// A one-off run of the engine: its last line, or the error it gave.
fn once(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    let exe = engine_path(app).ok_or(NOT_INSTALLED)?;
    let out = engine(app, &exe)?.args(args).output().map_err(|e| format!("could not start the local engine: {e}"))?;
    let last = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).next_back().unwrap_or(Value::Null);
    if last["type"] == "error" || !out.status.success() {
        return Err(last["message"].as_str().unwrap_or("the local engine failed").to_string());
    }
    Ok(last)
}

/// Where the engine program is: `QUIRE_ENGINE`, beside the app (bundled), or `src-tauri/binaries`
/// while developing. An empty file is no engine: the bundler wants a sidecar file to exist, so a
/// checkout without a built engine stands an empty one in (scripts/sidecar.mjs).
fn engine_path(_app: &AppHandle) -> Option<PathBuf> {
    let real = |p: PathBuf| std::fs::metadata(&p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false).then_some(p);
    if let Some(p) = std::env::var_os("QUIRE_ENGINE") {
        return real(PathBuf::from(p));
    }
    if let Some(beside) = std::env::current_exe().ok()?.parent().map(|d| d.join(EXE)).and_then(real) {
        return Some(beside);
    }
    real(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(EXE))
}

fn store(app: &AppHandle) -> Result<PathBuf, String> {
    match settings(app)["store"].as_str() {
        Some(p) if !p.is_empty() => Ok(PathBuf::from(p)),
        _ => default_store(app),
    }
}

/// `translation` in the app's data: named when the engine only translated, and kept so the models
/// downloaded then stay where they are.
fn default_store(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("translation"))
}

/// What a plugin's own pipeline gave back: the picture (PNG, as base64; none when it gave none), its
/// size, and what it tells the plugin.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ran {
    pub png_base64: Option<String>,
    pub width: u32,
    pub height: u32,
    pub result: Value,
    pub seconds: f64,
}

/// A plugin's own pipeline (`module`, a WebAssembly file in its folder) on a picture, with the models
/// it declares and the language model the user chose. Blocks until the engine is done with it.
#[allow(clippy::too_many_arguments)]
pub fn run(app: &AppHandle, state: &EngineState, plugin: &str, module: &std::path::Path, models: &[String], own: &[Value], bytes: Vec<u8>, options: Value) -> Result<Ran, String> {
    use base64::Engine;
    let mut body = serde_json::json!({ "options": options, "module": module, "models": models, "declare": own, "language_model": saved_choice(app) });
    if !bytes.is_empty() {
        body["input_base64"] = Value::String(base64::engine::general_purpose::STANDARD.encode(&bytes));
    }
    let done = exchange(app, state, plugin, "run", body)?;
    Ok(Ran {
        png_base64: done["output_base64"].as_str().map(String::from),
        width: done["width"].as_u64().unwrap_or(0) as u32,
        height: done["height"].as_u64().unwrap_or(0) as u32,
        result: done["result"].clone(),
        seconds: done["seconds"].as_f64().unwrap_or(0.0),
    })
}

/// A request as a JSON object (its `type` and `id` added here), its answering event.
fn exchange(app: &AppHandle, state: &EngineState, plugin: &str, kind: &'static str, mut body: Value) -> Result<Value, String> {
    let _turn = state.turn.lock().unwrap_or_else(|p| p.into_inner());
    let answer = (|| {
        let rx = {
            let mut guard = state.running.lock().unwrap_or_else(|p| p.into_inner());
            if guard.as_mut().is_some_and(|r| matches!(r.child.try_wait(), Ok(Some(_)))) {
                *guard = None; // it exited on its own
            }
            if guard.is_none() {
                *guard = Some(start(app)?);
            }
            let run = guard.as_mut().expect("started above");
            run.next += 1;
            let id = run.next;
            let (tx, rx) = mpsc::channel();
            run.waiting.lock().unwrap_or_else(|p| p.into_inner()).insert(id, (plugin.to_string(), kind, tx));
            body["type"] = Value::String(kind.to_string());
            body["id"] = Value::from(id);
            if writeln!(run.stdin, "{body}").and_then(|_| run.stdin.flush()).is_err() {
                *guard = None;
                return Err("the local engine stopped".to_string());
            }
            rx
        };
        // A plugin's pipeline can take long (its models load first); the quick requests can't. One that doesn't
        // answer in time leaves the engine stuck, and every other request waits behind it: it is
        // stopped, and the next request starts it afresh.
        let patience = match kind {
            "run" => PAGE,
            _ => QUICK,
        };
        rx.recv_timeout(patience).map_err(|_| {
            stop(state);
            format!("the local engine did not answer in {} minutes, so it was restarted", patience.as_secs() / 60)
        })?
    })();
    let done = answer?;
    *state.last_used.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    stop_when_idle(app.clone());
    Ok(done)
}

/// What a picture is about: its embedding (and its crops'), and the anime tagger's tags over
/// `min_probability` with its own embedding, when it looked.
#[derive(Serialize, serde::Deserialize)]
pub struct Indexed {
    pub width: u32,
    pub height: u32,
    pub embedding: Option<Vec<f32>>,
    #[serde(default)]
    pub parts: Vec<Vec<f32>>,
    /// `[tag index, probability]`, highest first.
    pub tags: Option<Vec<(usize, f32)>>,
    #[serde(default)]
    pub anime: Option<Vec<f32>>,
    pub seconds: f64,
}

/// What to ask of the models for one picture.
#[derive(Clone, Serialize)]
pub struct IndexOptions {
    pub embed: bool,
    pub tag: bool,
    pub min_probability: f32,
    /// "siglip2"; "pixai", or "" without the anime tagger (it is optional, used with `tag`).
    pub embedder: String,
    pub tagger: String,
    /// Also crops of the picture.
    pub parts: bool,
    /// The tagger only looks at drawn pictures.
    pub drawn_only: bool,
}

pub fn index(app: &AppHandle, state: &EngineState, bytes: Vec<u8>, options: &IndexOptions) -> Result<Indexed, String> {
    use base64::Engine;
    let body = serde_json::json!({ "input_base64": base64::engine::general_purpose::STANDARD.encode(&bytes), "options": options });
    let done = exchange(app, state, "app", "index", body)?;
    serde_json::from_value(done).map_err(|e| e.to_string())
}

/// Words in the pictures' space of this picture-and-word model.
pub fn embed_text(app: &AppHandle, state: &EngineState, text: &str, embedder: &str) -> Result<Vec<f32>, String> {
    let done = exchange(app, state, "app", "embed_text", serde_json::json!({ "text": text, "embedder": embedder }))?;
    serde_json::from_value(done["embedding"].clone()).map_err(|e| e.to_string())
}

/// How much each pixel of a picture belongs to its subjects: a grey PNG, scaled to fit `max_side`.
#[derive(Serialize, serde::Deserialize)]
pub struct CutOut {
    pub width: u32,
    pub height: u32,
    pub mask_base64: String,
    pub seconds: f64,
}

pub fn cutout(app: &AppHandle, state: &EngineState, bytes: Vec<u8>, max_side: u32, crop: Option<[f64; 4]>) -> Result<CutOut, String> {
    use base64::Engine;
    let body = serde_json::json!({ "input_base64": base64::engine::general_purpose::STANDARD.encode(&bytes), "max_side": max_side, "crop": crop });
    let done = exchange(app, state, "app", "cutout", body)?;
    serde_json::from_value(done).map_err(|e| e.to_string())
}

/// A face the engine found: real person's (`photo`) or character's (`drawn`), where it is in
/// fractions of the upright picture, how sure, how wide in pixels, and its numbers (unit length).
#[derive(Serialize, serde::Deserialize)]
pub struct FoundFace {
    pub kind: String,
    pub bbox: [f32; 4],
    pub score: f32,
    pub size: u32,
    pub embedding: Vec<f32>,
}

#[derive(Serialize, serde::Deserialize)]
pub struct FacesFound {
    pub width: u32,
    pub height: u32,
    pub faces: Vec<FoundFace>,
    pub seconds: f64,
    /// Whether the character finder looked: not when it isn't downloaded (it is optional) and the
    /// picture wasn't known to be drawn.
    #[serde(default)]
    pub characters: bool,
}

/// The faces in a picture: `kind` "photo" or "drawn" when it is known which the picture is, else both
/// are looked for. `area` (fractions of the upright picture): only in that part, looked at alone;
/// `whole`: a drawing's part with none found is taken as its face.
pub fn faces(app: &AppHandle, state: &EngineState, bytes: Vec<u8>, kind: Option<&str>, area: Option<[f32; 4]>, whole: bool) -> Result<FacesFound, String> {
    use base64::Engine;
    let body = serde_json::json!({ "input_base64": base64::engine::general_purpose::STANDARD.encode(&bytes), "kind": kind, "area": area, "whole": whole });
    let done = exchange(app, state, "app", "faces", body)?;
    serde_json::from_value(done).map_err(|e| e.to_string())
}

pub fn tag_names(app: &AppHandle, state: &EngineState, tagger: &str) -> Result<Value, String> {
    let done = exchange(app, state, "app", "tag_names", serde_json::json!({ "tagger": tagger }))?;
    Ok(done["names"].clone())
}

fn start(app: &AppHandle) -> Result<Running, String> {
    let exe = engine_path(app).ok_or(NOT_INSTALLED)?;
    let mut child = engine(app, &exe)?.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().map_err(|e| format!("could not start the local engine: {e}"))?;
    let stdin = child.stdin.take().ok_or("no engine input")?;
    let stdout = child.stdout.take().ok_or("no engine output")?;
    let waiting: Waiting = Arc::default();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

    let pending = waiting.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
            let id = event["id"].as_u64();
            match (event["type"].as_str().unwrap_or(""), id) {
                ("ready", _) => {
                    let _ = ready_tx.send(Ok(()));
                }
                ("progress", Some(id)) => {
                    let asked = pending.lock().unwrap_or_else(|p| p.into_inner()).get(&id).map(|(p, kind, _)| (p.clone(), *kind));
                    if let Some((plugin, task)) = asked {
                        let _ = app2.emit("engine-progress", serde_json::json!({ "plugin": plugin, "task": task, "stage": event["stage"], "state": event["state"], "model": event["model"], "done": event["done"], "total": event["total"] }));
                    }
                }
                ("done" | "indexed" | "embedded" | "tag_names" | "cut_out" | "faces_found", Some(id)) => {
                    if let Some((_, _, tx)) = pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id) {
                        let _ = tx.send(Ok(event));
                    }
                }
                ("error", Some(id)) => {
                    if let Some((_, _, tx)) = pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id) {
                        let _ = tx.send(Err(event["message"].as_str().unwrap_or("the local engine failed").to_string()));
                    }
                }
                ("error", None) => {
                    let _ = ready_tx.send(Err(event["message"].as_str().unwrap_or("the local engine failed").to_string()));
                }
                _ => {}
            }
        }
        // The engine is gone: whoever is still waiting hears about it.
        let _ = ready_tx.send(Err("the local engine exited".to_string()));
        for (_, (_, _, tx)) in pending.lock().unwrap_or_else(|p| p.into_inner()).drain() {
            let _ = tx.send(Err("the local engine stopped".to_string()));
        }
    });

    match ready_rx.recv_timeout(Duration::from_secs(60)) {
        Ok(Ok(())) => Ok(Running { child, stdin, waiting, next: 0 }),
        Ok(Err(e)) => {
            let _ = child.kill();
            Err(e)
        }
        Err(_) => {
            let _ = child.kill();
            Err("the local engine did not start".to_string())
        }
    }
}

/// Stop the engine once nothing has asked it for anything for a while, so its models leave memory.
fn stop_when_idle(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(IDLE);
        let state = app.state::<EngineState>();
        let idle = state.last_used.lock().unwrap_or_else(|p| p.into_inner()).is_some_and(|t| t.elapsed() >= IDLE);
        let Ok(_turn) = state.turn.try_lock() else { return };
        if idle {
            stop(&state);
        }
    });
}

pub fn stop(state: &EngineState) {
    if let Some(mut run) = state.running.lock().unwrap_or_else(|p| p.into_inner()).take() {
        let _ = writeln!(run.stdin, "{}", serde_json::json!({ "type": "shutdown" }));
        let _ = run.stdin.flush();
        for _ in 0..50 {
            if matches!(run.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = run.child.kill();
    }
}
