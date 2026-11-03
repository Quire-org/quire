# The local engine

Quire runs models on this computer through one helper program, `engine/` (Rust, built by `npm run engine` into `src-tauri/binaries`). The app starts it when something first asks for it, keeps it up while requests keep coming so its models stay loaded, and stops it when idle. It speaks JSON lines on stdin/stdout:

```
→ {"type":"run","id":1,"input_base64":"…","module":"/…/engine.wasm","options":{…},"models":["my-model"],"declare":[…],"language_model":"qwen3.5-4b"}
← {"type":"progress","id":1,"stage":"model","state":"loading","model":"my-model"}
← {"type":"done","id":1,"output_base64":"…","width":1200,"height":1700,"result":{…},"seconds":3.1}
```

Besides `run` (a plugin's own pipeline, below) it answers `index` (a picture's embedding, and crops' with `parts`; the anime tagger's tags and its own embedding, only for drawn pictures with `drawn_only`; for the app's Tags screen), `embed_text` (words in the pictures' space, for search and young tags' names), `tag_names`, `faces` and `cutout`. Each names its models (`embedder`: `siglip2`; `tagger`: `pixai`, which is optional: the app indexes without it, and an index takes it on when it is downloaded). Pictures go in over the pipe as base64 (`input_base64`) and results come back the same way (`output_base64`), so nothing of an encrypted folder touches the disk; a file path (`input`, `output`) still works for tools and tests.

Plugins never talk to it directly: the app checks their permission (`engine`), passes the picture and the options through, and gives the answer back (`ms.engine.run`). Models are downloaded once, in Settings → Local models, where they are listed under the plugins whose manifests name them (`"models": [...]`), and kept where the user chooses (the app's data folder, the opened folder, or a folder of their choice). Nothing is downloaded while a picture is worked on.

## Plugin pipelines (WebAssembly)


A plugin brings its own image pipeline as a WebAssembly module; the engine is only its runtime and its toolbox. Nothing in the core knows what a pipeline is for.

```
plugin repo
├── plugin.json        permissions ["engine", ...], "engine": "engine.wasm", models, ownModels
├── index.js           the UI, in the app's sandbox
└── engine.wasm        the pipeline, run by the engine
```

- `engine/src/wasm.rs` runs the module with wasmtime (compiled once per file and kept while the engine runs). It has no filesystem, network or clock of its own; its only imports are the host's `ms` functions below. Imports it doesn't use (wasm-bindgen glue some crates pull in) are traps.
- The host API (`engine/sdk`, the crate a pipeline is written against): `request()` (the options as JSON), `input()` (the picture, upright, as RGB), `run_model(model, file, tensors)` (a TorchScript file of a model the manifest names and the user downloaded, on the GPU when there is one; kept loaded between pictures), `inpaint_lama(rgb, mask, w, h)` (the engine's LaMa inpainter), the text tools (`text::stages`, `text::drop`, `text::letter`, below), `report(stage, state, step)` (progress, shown in the plugin and in Activity), `say` (the engine's log), `var("MS_…")` (only `MS_` variables, for a pipeline's own debug switches), `seconds()`, `output(picture, json)` and `main!(run)`. Tensors cross as packed `f32` (shape, then data). `main!` defines the entry point only in the WebAssembly build, so a pipeline's own logic can be tested natively with `cargo test`.
- The app gives the module a path inside the plugin's folder (`"engine"` in plugin.json, checked to be a relative `.wasm` path) and the files of the models the manifest names; the plugin can't name another file. A model is checked when the pipeline uses it: one the manifest names but the user hasn't downloaded fails with `not downloaded: <id>`, and the app then opens Local models with it marked.
- A plugin's own models (`ownModels` in plugin.json: id, name, note, `runtimes` when they need the Torch runtime, and up to 20 files each with a Hugging Face repository and revision) are added to the catalogue while it is installed (`--declare` on the command line, `declare` in each `run`). One whose files aren't published yet (`"repository": ""`) is looked for in `QUIRE_MODEL_<ID>` (`MY_MODEL` for `my-model`), else in the store's `local/<id>/`.
- Building one: `cargo build --release --target wasm32-unknown-unknown` with a `cdylib` crate that depends on `quire-engine-sdk`. Plain Rust crates that do pixel work (image, imageproc, rustfft) build for it as they are; anything needing threads, files or the network doesn't.
- Installing a plugin from GitHub installs its `.wasm` with it; no native code is downloaded or built.

### Text in pictures

`text.rs` offers Koharu's stages to pipelines, on the run's picture, one call at a time; which stages run, in what order, and what is made of the regions is the pipeline's own.

- `text::stages({ stages, ocr, llm, target, instructions, need })` runs any of `detection` (finds the text and the balloons), `ocr` (reads it: `manga-ocr` or `hayai-ocr`), `translation` (translates what was read with a local language model: `llm`, else the one the user chose in Local models, which the app sends as `language_model`) and `inpainting` (paints the original text out). `need` names the stages of later calls, whose models are checked now with these, so a picture that can't be finished fails before any work and names every model missing at once.
- Each answers with the regions on the page then: `{ id, source, translation, text, frame, balloon }`, boxes `[x, y, w, h]` in pixels (`text` where it was found, `frame` where it is lettered), and `model` after a translation.
- `text::drop(ids)` takes regions off the page (their text isn't lettered; the original under them is still painted out).
- `text::letter({ fonts })` gives the page as it is now with each translation lettered into its frame. Only installed fonts are used (a font from Koharu's own set would be downloaded); without any, fonts most computers have.
- The models: the text tools' shared parts (`base`: the layout detector, LaMa and the font index, with the GPU runtimes), the readers and the language models in `models.rs`. A pipeline must name the reader and language model it uses in its manifest's `models`; the shared parts come with them.

## What is generic and what is not

Generic, and staying in the core:

- the process, the protocol, progress events, one request at a time, idle shutdown;
- the model store: catalogue (the engine's own and plugins' declared ones), download, verification, removal, the chosen folder;
- the runtimes (libtorch for TorchScript models, ONNX Runtime, llama.cpp) and the device choice;
- the WebAssembly host and its API: models, the LaMa inpainter, and the text tools on Koharu (find, read, translate, paint out, letter);
- the picture-and-word model and the anime tagger (`tagging.rs`, ONNX Runtime on the CPU): SigLIP 2 (base, 256 px, half precision: the 8-bit export sees noticeably worse) and PixAI Tagger v0.9 (full precision: 8-bit wrecks its first blocks; Core ML can't build it), the tagger optional (for anime, manga and art). Generic intents used by the app itself, so they stay in the core. What a tag means is learned in the app (`src-tauri/tags/src/learn.rs`), not here. Both also run on the GPU, about five times faster, when converted for it with `tools/tag_gpu.py` (TorchScript from the same weights, checked against the ONNX files on the pictures given) into `target/gpu` (or `QUIRE_GPU_MODELS`) and the Torch runtime is installed; otherwise on the CPU as before. `MS_CPU=1` keeps every converted model on the CPU, `MS_INDEX_TIMING=1` prints each step's time, `MS_THREADS` sets ONNX Runtime's threads.

Nothing in the core is any one plugin's: a plugin's own logic lives in its pipeline and its `index.js`. Anything added to `engine/src` for plugins should be a tool any of them could use, with model access only through `models.rs`.

## Faces (People)

`{"type":"faces","id":1,"input":"…","kind":"photo"}` (or `input_base64`; `kind` `photo`, `drawn`, or left out for both, or for the photo finder alone when the character finder isn't downloaded: it is optional) answers `faces_found` with the picture's size, `characters` (whether the character finder looked), and its faces: `kind`, `bbox` (fractions of the upright picture), `score`, `size` (width in pixels, the picture shrunk to at most 2048) and `embedding` (unit length). Photos: SCRFD 10G finds each face and its five points, the face is turned upright to them (112 × 112, ArcFace's points) and AuraFace gives 512 numbers. Drawings: deepghs' anime face detector (YOLOv8 s, v1.4, at its own threshold 0.307) finds the face, and CCIP (caformer_b36) gives 768 numbers for the head and upper body around it (4.5 × 6 the face, centred 1.6 faces below it: hair and clothes tell a character). Faces narrower than 28 px are left out. The models are ONNX on the CPU (`faces` and `characters` in `models.rs`), loaded on first use; converted with `tools/face_gpu.py` into the same folder as the tag models, they run on the GPU instead, each one that is there (on an M1 Pro a photo takes about 0.1 s instead of 0.33, a drawing 0.2 s instead of 1.45). The conversion keeps them the same models: SCRFD, AuraFace and the anime detector are converted from their ONNX files as they are, CCIP is timm's CAFormer with CCIP's weights from its file plus its own head, and each is checked against its ONNX file before it is written (on deepghs' public character sets the scores are the same to the third decimal), so an index can mix faces found either way.

Measured on public pictures: 20 official portraits of five people (decades apart for some, a painting for one) all found, every face's nearest the same person, different people never closer than 0.21 while the same rarely under 0.28 (about 0.2 s a picture); CCIP's test set (337 pictures, 45 characters) faces found in 93%, the nearest the same character for 98%, different characters kept apart 99.8% of the time at CCIP's threshold (a dot product of 0.643; its difference model is `(1 - cos) / 2`). The app's thresholds are in `faceindex.rs`.

