# Media Sorter

A keyboard-driven desktop app for culling photos and videos on an external volume:
look at each file full screen, rate it 1 to 10, send it to a target folder with one
key, or drop it in the volume's trash. Then browse what you sorted in a grid, filter by
folder and rating, and flip through it in order or shuffled.

Built with [Tauri 2](https://tauri.app) (Rust backend, React + TypeScript frontend),
so the same code builds for macOS, Linux and Windows.

## How it works

- **Open a folder** (your SD card, external drive, or any directory). The app scans it
  recursively.
- **Nothing is stored inside the app.** Target folders and ratings live in
  `.mediasorter.json` at the root of the folder you opened, so they travel with the
  volume. The only things kept locally are the theme choice and the recent-folders list.
- **Sorting moves files** on disk, immediately. The last actions can be undone with
  `⌘Z`. Target folders can be anywhere; folders inside the opened root are excluded from
  the unsorted queue.
- **Delete** moves to `_deleted/` inside the root. Settings → Trash shows what is there,
  lets you restore items, and has an *Empty trash* button that permanently deletes.
- **Pairs travel together.** `IMG_0001.CR2` + `IMG_0001.JPG` (+ `.xmp`), or a live photo's
  `.HEIC` + `.MOV`, are treated as one item and moved as a group.
- **RAW files** are displayed via the JPEG preview embedded in the RAW. HEIC and video
  decoding use the system webview (WebKit on macOS).

### Formats

| Kind  | Extensions |
|-------|-----------|
| Image | jpg jpeg png heic heif webp gif bmp tif tiff avif |
| RAW   | cr2 cr3 nef nrw arw srf sr2 dng raf orf rw2 pef srw 3fr erf kdc mrw x3f |
| Video | mp4 mov m4v webm mkv avi mts m2ts mpg mpeg |
| Sidecar (moved with their item) | xmp aae thm lrv pp3 dop |

### Keyboard

| Key | Action |
|-----|--------|
| `1`–`9`, `0` | Rate 1–10 |
| `U` | Clear rating |
| Target hotkey (shown on each button) | Move to that folder |
| `⌫` / `Delete` | Move to trash |
| `⌘Z` | Undo |
| `←` `→` | Previous / next |
| `Space`, `M`, `,` `.` | Video: play/pause, mute, scrub 5s |
| `S` | Shuffle the queue |
| `B` | Browse sorted media (`Esc` back) |
| `G` | Settings |
| `I` | File info |
| `H` | Hide / show HUD |
| `F` | Fullscreen |
| `?` | Key reference |

Target hotkeys are auto-assigned from the folder name and editable in Settings.

## Development

Requirements: Node 20+, Rust stable, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```sh
npm install
npm run tauri dev                       # run the app
MEDIA_SORTER_ROOT=/Volumes/CARD npm run tauri dev   # open a folder at launch
npm run tauri build                     # bundle (.app on macOS, deb/AppImage, NSIS)
npm run tauri build -- --bundles dmg    # also produce a .dmg (needs Finder automation permission)
cd src-tauri && cargo test              # backend unit tests
```

The app also accepts a folder as its first command line argument.

### Browser preview (no Tauri)

For fast UI work, the frontend can run in a plain browser against a mocked bridge:

```sh
npm run dev
# open http://localhost:1420/?mock
```

The mock (`src/dev/mock.ts`) serves a fake volume with in-memory move/trash semantics
and expects a static file server for the media on `http://localhost:8787`. It is only
loaded in dev mode with `?mock` and is never bundled.

### Project layout

```
src-tauri/src/
  lib.rs       Tauri commands (scan, move, trash, library, preview)
  media.rs     Recursive scan + grouping of RAW/JPEG/sidecar/live-photo pairs
  library.rs   .mediasorter.json on the volume (targets, ratings, trash dir)
  ops.rs       Group moves with collision-safe renaming, trash purge
  preview.rs   Embedded JPEG extraction from RAW files
src/
  store.ts     App state (zustand): queue, ratings, moves, undo
  screens/     Welcome, Viewer (full-screen sorting), Browse (grid), Settings, Trash, Help
  components/  MediaStage (image/raw/video), RatingBar, TargetBar, Thumb, Modal, Toasts
  themes/      base.css (tokens + components), cp2077.css, ghost.css, index.ts (registry)
  dev/mock.ts  Browser-only Tauri bridge mock
```

### Themes

All styling reads CSS custom properties defined in `src/themes/base.css`. A theme is a
CSS file that overrides those properties under `[data-theme="<id>"]` and may add
decorations (overlays, clip paths). To add one: create `src/themes/<id>.css`, import it
in `src/main.tsx`, and add an entry to `themes` in `src/themes/index.ts`. Shipped themes:
**Night City** (Cyberpunk 2077: acid yellow, cyan, red, cut corners, scanlines) and
**Ghost** (quiet monochrome).

## Roadmap ideas

- EXIF capture date for sorting and info
- Optional in-memory downscaled thumbnails for very large grids
- Write ratings into XMP sidecars for Lightroom and friends
- Side-by-side compare, zoom to 100%
- Linux / Windows builds (HEIC and RAW previews there will need a decoder, since those
  webviews do not decode HEIC)
