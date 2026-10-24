# Media Sorter

A keyboard-driven desktop app for culling photos and videos in any folder, whether that
is an SD card, an external drive or a directory on your machine: look at each file full
screen, rate it 1 to 10, send it to a target folder with one key, or drop it in the
folder's own trash. Browse everything in one grid and filter it down by location, type,
subfolder, rating or name, flip through it in order or shuffled, and find duplicates,
including near-identical photos and video clips cut from longer videos.

Built with [Tauri 2](https://tauri.app) (Rust backend, React + TypeScript frontend),
so the same code builds for macOS, Linux and Windows.

## How it works

- **Open a folder** (SD card, external drive, or any directory). The app scans it
  recursively.
- **Nothing is stored inside the app.** Target folders and ratings live in
  `.mediasorter.json` at the root of the folder you opened, so they travel with the
  media. Every rated file also gets an identity (size, modification time, name and a
  content fingerprint), so if you move or rename it outside the app, its rating and
  history are re-attached on the next scan. Duplicate-scan fingerprints are cached in `.mediasorter.cache.json` next to it
  (safe to delete). The only things kept locally are the theme choice and the
  recent-folders list.
- **Sorting moves files** on disk, immediately. The last actions can be undone with
  `⌘Z`. Target folders can be anywhere; folders inside the opened root are excluded from
  the unsorted queue.
- **Delete** moves to `_deleted/` inside the root. Settings → Trash shows what is there,
  lets you restore items, and has an *Empty trash* button that permanently deletes.
- **Pairs travel together.** `IMG_0001.CR2` + `IMG_0001.JPG` (+ `.xmp`), or a live photo's
  `.HEIC` + `.MOV`, are treated as one item and moved as a group.
- **RAW files** are displayed via the JPEG preview embedded in the RAW. HEIC and video
  decoding use the system webview (WebKit on macOS).
- **Browse** (`B`) shows everything under the opened folder, including target folders
  and any targets outside it, as one virtualised masonry grid (tiles keep their shape;
  only the visible part is rendered, so thousands of items scroll smoothly). Narrow it
  down by location (unsorted, a target, recently viewed, never viewed), type, folders,
  rating, or a name search; order by name, date, size or rating, or shuffle. ⌘-click,
  ⇧-click or *Select mode* select several tiles; the bar at the top then rates, moves or
  trashes them all, and the usual keys act on the selection. View history is kept in
  `.mediasorter.history.json` next to the media. *Surprise me* (`R`) jumps to a random
  item, favouring ones you have not looked at lately.
- **Viewer extras**: playback speed (`[`, `]`, `\`, or the speed button), frame stepping
  with `,` and `.` while paused, a thumbnail of the frame under the cursor when hovering
  the progress bar, and immersive mode (`C`): black background, no HUD, cursor hidden.
- **Albums** (`A`): pick one or more *album folders* in Settings. Every subfolder of an album
  folder is an album: it never appears in the main grid or the sorting queue, and the Albums
  screen shows it as one card with the first image as cover. Albums get their own 1 to 10
  rating and can be moved to a target folder as a whole. The sidebar filters albums by
  album folder, content (photos only, videos, both), rating and name, orders by name, date,
  size, count or rating, shuffles, and *Slideshow* flips through everything in the visible
  albums. Folders with URL-escaped names
  (`My%20Trip`, `Z%C3%BCrich`) can be decoded to their real names, either on demand with a
  preview of every rename, or automatically on each album scan (option on the Albums screen).
- **Drive health** (Settings → Drive health) shows the volume's bus (SD, USB, NVMe...),
  model, file system and capacity, SMART data when the device reports it (through
  `smartctl` if smartmontools is installed), a cache-bypassing read-speed benchmark with
  typical ranges for the device type, and a readability check that reads every byte of every
  file and lists the ones that fail. SD cards expose no wear counters to a computer, so the
  panel says so instead of guessing; read errors and sharp slowdowns are the reliable early
  warnings, and the recommendations reflect that.
- **Vault** (Settings → Encrypt folder…): optional per-folder encryption. Every file becomes
  an opaque blob with a random name under `.vault/objects/`; file names, folders, sizes and
  times exist only in an encrypted index, and the library, history and hash cache are
  encrypted too. Keys: Argon2id from your passphrase wraps a random data key, so the
  passphrase can change without re-encrypting; files use XChaCha20-Poly1305 in 64 KiB chunks
  so videos stay seekable, served to the viewer through a `vault://` protocol with Range
  support. A **recovery code** is shown once at creation (a second key slot); it unlocks the
  vault and lets you set a new passphrase. Files the camera writes later stay plain until
  you press *Encrypt new files*; they still show and sort in the meantime. *Export* writes
  readable copies elsewhere, *Remove vault* decrypts everything back in place. Forgetting
  both passphrase and code means the files are gone: there is no other way in, by design.
  **Quick unlock**: the Vault dialog can remember the vault on the current computer. The data
  key is written to a file only your user can read in the app's data folder and handed out
  only after a local prompt: Touch ID (or the login password) on macOS, Windows Hello on
  Windows. Linux has no standard prompt, so there the login session is the only gate. Only on
  that machine; passphrase and recovery code keep working. (The macOS Keychain was avoided on
  purpose: its trust is bound to the exact binary, and unsigned builds get an "allow access"
  dialog that can hide behind the window.)
  What a vault cannot do: stop someone who has your passphrase, or who sits at your unlocked
  Mac, from reading the files. Blob sizes also remain visible.
- **Edit** (`T`, or the Edit button in the viewer and the Browse selection bar): rotate 90°
  left/right/180°, upscale 2× or 4× (Lanczos), and convert: JPEG/PNG/WebP/TIFF for photos,
  MP4 H.264 or H.265, WebM VP9, GIF or MP3 for videos, with small/balanced/high quality.
  Photos in common formats are processed in Rust; videos, HEIC and anything else use
  **ffmpeg** when installed (`brew install ffmpeg`), with video rotation as a lossless
  display flag. Results are saved next to the original with a suffix, or replace it (the
  original goes to the trash and the rating carries over). Works on vault items too.
  EXIF metadata is not carried over to edited photos.
- **Files** (`E`): a file manager over the opened folder, for every file and folder, not
  only media. Drag files from the desktop onto it to add them (encrypted on the way in when
  a vault is open), drag rows onto folders or breadcrumbs to move them, rename, delete,
  export, new folder.
- **Backup** (top bar or Settings → Backup…) mirrors the opened folder into a folder on
  another drive, remembered in the library file. A plan is shown first: unchanged files
  (same path, size and time) are skipped, new and changed files copied, files you moved
  between folders are renamed in the backup instead of copied again, and files only in the
  backup are listed and removed only when *Mirror deletions* is on. Copies keep the source
  modification time, go through a temporary name, and can be verified by fingerprint.
  Progress, throughput-based time remaining and a cancel button while it runs.
- **Duplicates** (`D`) scans a scope and groups:
  - *exact copies*: identical content fingerprint (size plus hashed head, middle and
    tail chunks), works for any file type including large videos;
  - *similar photos*: perceptual hash (DCT pHash) distance within the chosen
    sensitivity, so re-encoded, resized or lightly edited copies match. HEIC and other
    formats the Rust side cannot decode are hashed by the webview instead;
  - *videos*: one frame hash per second of footage. Two videos with matching frame
    sequences are the same footage; a shorter clip whose sequence appears inside a
    longer video is reported as contained in it, with the offset. The first 10 minutes
    of each video are analysed. Each group offers *Keep this* (trash the rest) and
    per-file *Trash*; clicking a tile opens the group in the viewer.
  - The scope is a location plus an include/exclude folder tree, optionally with album
    folders. Before scanning, the panel shows how many files are already fingerprinted,
    how many are new, and a time estimate (improved by *Measure*, a short read benchmark).
    While running it shows a countdown, and a pill on every other screen shows progress
    so you can keep sorting. Fingerprinted files carry a ✓ badge in Browse.

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
| `B` | Browse everything (`Esc` back) |
| `D` | Find duplicates (`Esc` back) |
| `A` | Albums (`Esc` back) |
| `E` | Files |
| `T` | Edit: rotate, upscale, convert |
| `X` | Fit the whole image, or fill the screen (may crop) |
| `⏎` | Slideshow: auto-advance on a timer (2 to 60 s, picked next to the button); videos play to the end. Hides the HUD like H by default (toggle next to the interval); Esc pauses |
| `C` | Immersive mode (hides the HUD, black background, hidden cursor) |
| `H` | Hide / show the HUD in the viewer, or the top bar and sidebar on the list screens |
| `R` | Surprise me |
| `[` `]` `\` | Playback speed down / up / reset |
| `G` | Settings |
| `I` | File info |
| `F` | Fullscreen |
| `?` | Key reference |

Target hotkeys are auto-assigned from the folder name and editable in Settings. Buttons
hide their key hints; hold ⌘ to reveal them, or press `?` for the full list.

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
npm test                                # frontend unit tests (vitest)
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
  lib.rs       Tauri commands (scan, move, trash, library, preview, hashes, cache)
  dupes.rs     Content fingerprints and perceptual image hashes (pHash, dHash)
  albums.rs    Album folders: scan subfolders, move a folder as a whole
  drive.rs     Drive info (sysinfo + diskutil + smartctl), read benchmark, readability check
  backup.rs    Incremental backup: plan (new/changed/moved/extra), run with progress, mirror
  vault.rs     Encrypted vault: key slots (passphrase, recovery code), chunked objects, index, meta
  fsx.rs       Storage layer treating plain files and vault entries alike (scan, move, read)
  media.rs     Recursive scan + grouping of RAW/JPEG/sidecar/live-photo pairs
  library.rs   .mediasorter.json on the volume (targets, ratings, trash dir)
  ops.rs       Group moves with collision-safe renaming, trash purge
  preview.rs   Embedded JPEG extraction from RAW files
src/
  store.ts     App state (zustand): queue, ratings, moves, undo, full item list
  dupesStore.ts Duplicate scan: fingerprint/hash passes, cache, grouping
  lib/dupes.ts Hash helpers, canvas/video hashing, group and subset matching
  screens/     Welcome, Viewer, Browse, Dupes, Albums, Drive, Settings, Trash, Help
  components/  FolderPicker (include/exclude tree), ScanPill (background scan), Thumb, …
  lib/poster.ts Video poster frames for tiles (WebKit paints nothing until play)
  components/  MediaStage (image/raw/video), RatingBar, TargetBar, Thumb, Modal, Toasts
  themes/      base.css (tokens + components), cp2077.css, ghost.css, index.ts (registry)
  dev/mock.ts  Browser-only Tauri bridge mock
```

### Themes

All styling reads CSS custom properties defined in `src/themes/base.css`. A theme is a
CSS file that overrides those properties under `[data-theme="<id>"]` and may add
decorations (overlays, clip paths). To add one: create `src/themes/<id>.css`, import it
in `src/main.tsx`, and add an entry to `themes` in `src/themes/index.ts`. Shipped themes:
**Night City** (Cyberpunk 2077: acid yellow, cyan, red, cut corners, scanlines),
**Ghost** (quiet monochrome), **Cozy** (light, warm cream with dusty rose and sage,
rounded corners, Nunito), **Midnight** (Night City's cuts in cool blue and silver,
Orbitron), **Sunset** (peach, apricot and plum, gradients, Quicksand) and **Gallery**
(white, nearly chromeless, Manrope). Icons are Phosphor, with the weight chosen per theme
(fill for Night City, bold for Midnight, duotone for Cozy and Sunset, thin for Gallery), and
the two dark themes add a subtle film-grain overlay.

## Roadmap ideas

- EXIF capture date for sorting and info
- Optional in-memory downscaled thumbnails for very large grids
- Write ratings into XMP sidecars for Lightroom and friends
- Side-by-side compare, zoom to 100%
- Duplicate scan: audio fingerprinting for videos, scenes beyond the first 10 minutes
- Linux / Windows builds (HEIC and RAW previews there will need a decoder, since those
  webviews do not decode HEIC)
