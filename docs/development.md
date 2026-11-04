# Developing Quire

Requirements: Node 20+, Rust stable, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
npm install
npm run pdfium                          # fetch pdfium (draws PDF albums' pages) into src-tauri/binaries
npm run tauri dev                       # run the app
npm run example                         # the example library (examples/, see its CREDITS.md), set up to open
QUIRE_ROOT=/Volumes/CARD npm run tauri dev   # open a folder at launch
npm run engine                          # build the local engine into src-tauri/binaries (a bundle ships it beside the app; until then the app runs without it)
npm run tauri build                     # bundle (.app on macOS, deb/AppImage, NSIS), pdfium among its resources
npm run tauri build -- --bundles dmg    # also produce a .dmg (needs Finder automation permission)
cd src-tauri && cargo test              # backend unit tests
npm test                                # frontend unit tests (vitest)
npm run e2e                             # end-to-end: every screen in Chrome against the mock
npm run icon                            # regenerate src-tauri/icons from src/assets/app-icon.svg
```

GitHub Actions: `.github/workflows/ci.yml` runs the frontend and backend tests on every push and
pull request (the backend on macOS, Windows and Linux), `engine.yml` the engine's when it changes,
and `release.yml` bundles the app for all three platforms when a `v*` tag matching the version in
`src-tauri/tauri.conf.json` is pushed, attaching them to a draft release with what the app needs to
update to it (see [docs/releases.md](releases.md)).

A dev build and the released app share the app's data folder (plugins, models, quick unlock), and
only one of them can have a library open at a time: the second is told which copy has it. A copy
that has quit, or is stuck quitting (waiting on a drive that stopped answering), doesn't count.


The bundled icon uses the neutral base palette, because Finder and Explorer cannot follow
the in-app theme. While the app runs, the Dock (macOS) or window and taskbar icon (Windows,
Linux) is re-tinted from the active theme's colours.

The app also accepts a folder as its first command line argument.

## Browser preview (no Tauri)

For fast UI work, the frontend can run in a plain browser against a mocked bridge:

```sh
npm run dev
# open http://localhost:1420/?mock
```

The mock (`src/dev/mock.ts`) serves a fake volume with in-memory move/trash semantics
and expects a static file server for the media on `http://localhost:8787`
(`node e2e/server.mjs`). It is only loaded in dev mode with `?mock` and is never bundled.
`?mock&demo` shows the example library instead of the made-up pictures (see below).

`npm run e2e` (or `npm run e2e -- people` for the scenes with that in their name) runs the
app against the mock with made-up pictures (`?mock&e2e`, drawn by `e2e/server.mjs`), in the
installed Chrome (`CHROME=` for another), through every screen at 1440×900 and 1100×720 in a
dark and a light theme. It uses the features that need it (saying yes to tag suggestions,
checking and naming a group of faces, the Find basket), checks each screen for anything
spilling out of its box, cut off, laid over something else or past the window
(`e2e/overflow.js`), and leaves a screenshot of each in `e2e/out` to look over.

## Screenshots, the demo video and the web demo

The README's screenshots, its looping clip, the demo video and the web demo come from the browser
preview's demo mode: `?mock&demo` shows the example library (`examples/library`, openly licensed:
see its `CREDITS.md`) in place of the made-up test volume, set up as `npm run example` sets it up.
The `Demo` workflow (`.github/workflows/demo.yml`) makes them when a release is published, or when
run by hand, and publishes them with GitHub Pages at <https://quire-org.github.io/quire/>, where the
README shows them; nothing of them is kept in the repository. The tooling is in `demo/`, with
packages of its own, and runs the same way here:

```sh
cd demo
npm install
npm run all        # capture, then render into out/site what the workflow publishes
```

- `npm run capture` walks through the preview in Chrome with Playwright (`capture.mjs`, on the
  helpers in `kit.mjs`) and keeps each step as a frame, with the key pressed or the click that led
  to it (`public/scenes`). `script.json` says how the frames make the video: its title and end,
  each part's caption, frames, zoom and scrolling, the screenshots and the loop.
- `npm run video` renders the video with [Remotion](https://www.remotion.dev) (`src/`):
  `out/site/quire-demo.mp4`.
- `npm run stills` renders the screenshots into `out/site/screenshots`.
- `npm run loop` makes the README's looping clip, `out/site/quire-demo.webp` (needs ffmpeg).
- `npm run web` builds the web demo into `out/site/demo` (<https://quire-org.github.io/quire/demo/>):
  the app built for a plain browser with `VITE_DEMO`, so it always runs on the mock in its demo
  mode, with the example library's pictures beside it. Nothing done there is saved.
- `npm run studio` opens Remotion's studio, to watch the video while changing it.

- `npm run workflows` makes the workflow videos the README links to, one per folder in
  `workflows/` (a capture and a `script.json` each, on the same kit), into `out/site` beside
  Quire's own with a screenshot each; `npm run workflows -- manga` makes only that one. Two of them
  show official plugins, which the Demo workflow clones beside the checkout, where the preview's
  file server finds a plugin by its id. A capture can set the demo mode's hooks before the app
  loads (`init`): `__demoFiles` adds files served from elsewhere on the file server (the manga
  video's album is an official plugin's test pages) and `__demoEngine` answers the engine's runs (there
  with the run recorded beside each page). The faces in the demo mode are the ones Quire's face
  finder found in the example library, kept in `examples/faces.json`.

A plugin's repository can make its own the same way: a capture on `kit.mjs` (from a checkout of
Quire beside the plugin, where the preview's file server finds it by its id; `?mock&demo&find=<id>`
runs a Find plugin against the made-up site in its `test/fake-site.js`) and a `script.json`, then
`node render.mjs video --work <its demo folder>` (and `stills`, and `loop.mjs --work`) in Quire's
`demo/`, which write into that folder's `out/site`.

Remotion is free for individuals and small teams; a larger company needs its company licence.

## Project layout

```
src-tauri/src/
  lib.rs       Tauri commands (scan, move, trash, library, preview, hashes, cache)
  dupes.rs     Content fingerprints and perceptual image hashes (pHash, dHash)
  albums.rs    Album folders: scan subfolders, decode escaped names, move a folder as a whole
  drive.rs     Drive info (sysinfo + diskutil + ioreg + smartctl), maker apps, read benchmark, readability check
  backup.rs    Incremental backup: plan (new/changed/moved/extra), run with progress, mirror
  vault.rs     Encrypted vault: key slots (passphrase, recovery code), chunked objects, index, meta
  update.rs    The app updating itself from its GitHub releases
  fsx.rs       Storage layer treating plain files and vault entries alike (scan, move, read)
  media.rs     Recursive scan + grouping of RAW/JPEG/sidecar/live-photo pairs
  library.rs   .quire.json on the volume (targets, ratings, trash dir)
  ops.rs       Collision-safe names, moves across drives, trash purge
  preview.rs   Embedded JPEG extraction from RAW files
  plugins.rs   Plugin registry: GitHub/folder install, updates, storage, network proxy
src-tauri/crypto/  The vault's cipher and passphrase hashing (optimised in dev builds too)
src/
  store.ts     App state (zustand): queue, ratings, moves, undo, full item list
  dupesStore.ts Duplicate scan: fingerprint/hash passes, cache, grouping
  lib/dupes.ts Hash helpers, canvas/video hashing, group and subset matching
  screens/     Welcome, Viewer, Browse, Dupes, Albums, Drive, Settings, Trash, Help
  components/  FolderPicker (include/exclude tree), Activity (long jobs), Thumb, …
  lib/poster.ts Video poster frames for tiles (WebKit paints nothing until play)
  components/  MediaStage (image/raw/video), RatingBar, TargetBar, Thumb, Modal, Toasts
  themes/      base.css (tokens + components), cp2077.css, ghost.css, index.ts (registry)
  plugins/     Plugin bridge: sdk.js (runs in the plugin frame), host.ts (permission checks)
  dev/mock.ts  Browser-only Tauri bridge mock
docs/plugins.md    Plugin API reference
demo/              Screenshots, the demo video and the web demo (above)
```

## Themes

All styling reads CSS custom properties defined in `src/themes/base.css`. A theme is a
CSS file that overrides those properties under `[data-theme="<id>"]` and may add
decorations (overlays, clip paths). To add one: create `src/themes/<id>.css`, import it
in `src/main.tsx`, and add an entry to `themes` in `src/themes/index.ts`. Shipped themes:
**Night City** (Cyberpunk 2077: acid yellow, cyan, red, cut corners, scanlines),
**Ghost** (quiet monochrome), **Cozy** (light, warm cream with dusty rose and sage,
rounded corners, Nunito), **Midnight** (Night City's cuts in cool blue and silver,
Orbitron), **Sunset** (peach, apricot and plum, gradients, Quicksand) and **Gallery**
(white, nearly chromeless, Manrope), **Manga** (paper and ink, screentone, a sakura accent).
Every theme has a light and a dark side: its own take, not an inversion (a daylight Night City
is pale concrete under the same acid yellow; a dark Manga is white ink on black paper). The
mode is chosen after the theme, in Settings or the Home's Theme block: Light, Dark, or System,
which follows macOS as it changes; the theme's stylesheet keeps the other mode's tokens under
`[data-theme="<id>"][data-mode="<light|dark>"]`. Icons are Phosphor, with the weight chosen per
theme (fill for Night City, bold for Midnight, duotone for Cozy and Sunset, thin for Gallery),
and the dark looks add a subtle film-grain overlay. Each theme also has its own sounds, off until
turned on in Settings → Look and reading (menus' and sorting's each on by themselves, one
volume), all low and soft, a touch rather than a feature: Night City muted synth, Midnight slow
sweeps and a low chime, Cozy drops of water, Sunset rounded tones, Manga paper, Gallery and Ghost
almost nothing. A theme's sounds are named in `THEME_SOUNDS` (`src/lib/sounds.ts`); the files are
[Kenney's Interface Sounds](https://kenney.nl/assets/interface-sounds) (CC0), in
`src/assets/sounds` with their licence.


## Ideas

- EXIF capture date for sorting and info
- Optional in-memory downscaled thumbnails for very large grids
- Write ratings into XMP sidecars for Lightroom and friends
- Side-by-side compare, zoom to 100%
- Duplicate scan: audio fingerprinting for videos, scenes beyond the first 10 minutes
- Linux / Windows: the release workflow builds them, but they have not been run yet (HEIC and
  RAW previews there will need a decoder, since those webviews do not decode HEIC)
