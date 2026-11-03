# Quire

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
  recursively. Next time the app starts, the library open last reopens by itself when its
  drive is plugged in; the Welcome card picks another.
- **Home** (`⇧H`, or click QUIRE in the top bar): what a library opens on, a board of
  blocks you build. A first visit offers presets (Everything, Sorting desk, Reading room,
  Collector, Gallery). **Arrange** keeps the board as it is shown and puts its controls in the
  top bar: **Add** opens a menu of every kind of block (click to add, or drag onto the board;
  kinds already there are marked), a block is moved by dragging, sized by its corner and taken
  off by the × over its corner, and a block clicked opens its settings in a panel over the board
  (arrows move it, ⇧ arrows size it, `⌫` takes it off, `Esc` closes the panel, then Arrange);
  `⌘Z` takes a change back. **Fit** (in Arrange) stretches the blocks so the board fills the
  window with no scrolling, as soon as the window is tall enough for every block at its smallest;
  a shorter window scrolls as before. Blocks: what waits to sort, Import, Who is this?, faces to check,
  duplicates, series to decide, what saved Find searches found (each platform under its logo),
  what is in Find's basket (a row per platform under its logo, or the first few of each with
  their logo when small), what extensions share, artists suggested; the albums you were reading
  at their page, recently viewed, newest, where you were, **Jump in** (saved searches you pick,
  from any platform: one click runs it in its platform's Find); this day in other years, a random
  handful, favourites, pictures you choose, pictures not seen in a year, a slideshow, one picture
  (pinned or new each day), Scrapbook covers; Activity, the drive, backup; shortcuts to screens,
  Find platforms and plugins; the Theme, every look drawn in its own colours (its key goes to the
  next). Every picture block narrows its pictures with Browse's own filters
  (where, folders, type, tags, rating, artists, people) or shows one album's pages. Each block
  has its own name, shown or not; a big enough picture block (4×3 cells up) can be a mosaic,
  each picture in its own shape; buttons fit their block (whole names, shortened, icons, then
  "+N"); `1`–`9` do the first nine blocks' actions and `⏎` sorts. **Stickers** go anywhere over
  the board (Stickers in Arrange: one from the shelf, or a random one, a new pick each time the
  Home opens from the categories and cut-outs you choose, the cut-outs narrowed by Browse's
  filters on the pictures they came from); in Arrange each is dragged, sized by a corner, turned
  by its knob, set up by a click (look, cut edge, flipped, front or back); while arranging, a
  random sticker shows the shapes of the stickers it may pick, black with a white edge and a
  question mark, one after another, and is one of its picks once Arrange ends; a pick is kept
  within the square it was placed in. Arrange also says which folders the Home may show pictures from (all, all but some,
  only some). What the library opens on (Home, Sort, or where you were) is set in Settings › Look
  and reading. Kept with the
  library, in its vault when it has one, following folders and pictures through moves. Seeing a
  picture on the Home isn't a view: only the viewer counts one.
- **Nothing is stored inside the app.** Target folders and ratings live in
  `.quire.json` at the root of the folder you opened, so they travel with the
  media. Every rated file also gets an identity (size, modification time, name and a
  content fingerprint), so if you move or rename it outside the app, its rating and
  history are re-attached on the next scan. Duplicate-scan fingerprints are cached in `.quire.cache.json` next to it
  (safe to delete). The only things kept locally are the theme choice, the sound settings
  and the recent-folders list.
- **Sorting moves files** on disk, immediately. The last actions can be undone with
  `⌘Z`. Target folders can be anywhere; folders inside the opened root are excluded from
  the unsorted queue.
- **Buckets** (Professional, Personal…) are target folders that file by the day: what goes
  in lands in `<folder>/<year>/<day>/`, parts of 1000 past that. Inside a bucket you make
  your own folders at any depth (`Professional/Weddings/James & Amy`), and each files the
  same way. Import brings pictures into any of them or a new one (`Weddings > James & Amy`),
  `⇧` and a bucket's key sorts into one, and *Organise what's here* files pictures left
  loose in them (moved there in Finder, say) where they are. A folder of yours can't be
  named like a year or a day (`2019`, `2026-03-14`): the app would take it for its own.
- **Delete** moves to `_deleted/` inside the root. Settings → Trash shows what is there,
  lets you restore items (back to where they came from; an album trashed whole comes back
  whole, with its rating, tags and translation link), and has an *Empty trash* button that
  permanently deletes. A file deleted outside the app keeps its rating and tags for a month,
  in case it comes back; after that they are let go.
- **Pairs travel together.** `IMG_0001.CR2` + `IMG_0001.JPG` (+ `.xmp`), or a live photo's
  `.HEIC` + `.MOV`, are treated as one item and moved as a group.
- **RAW files** are displayed via the JPEG preview embedded in the RAW. HEIC and video
  decoding use the system webview (WebKit on macOS).
- **Going online** (Settings): with "Ask before going online" on, nothing an extension fetches
  (Find's searches, works and pictures, artists' pages on platforms, the basket's pictures, saved
  searches checked, extensions' own requests) goes out until you press Connect, which stands where
  those would show: for every platform at once or each on its own, until the app closes or until
  Disconnect. Kept on this computer, for mobile data or a public Wi-Fi. Platforms' and their
  sites' icons are kept with the library once fetched (on connecting, and as a site is added),
  so they show while nothing may go online.
- **Browse** (`B`) shows everything under the opened folder, including target folders
  and any targets outside it, as one virtualised masonry grid (tiles keep their shape;
  only the visible part is rendered, so thousands of items scroll smoothly). Narrow it
  down by location (unsorted, a target, recently viewed, never viewed), type, folders,
  rating, or a name search; order by name, date, size or rating, or shuffle. ⌘-click,
  ⇧-click or *Select mode* select several tiles; the bar at the top then rates, moves or
  trashes them all, and the usual keys act on the selection. View history is kept in
  `.quire.history.json` next to the media. *Surprise me* (`R`) jumps to a random
  item, favouring ones you have not looked at lately.
- **Top bar** in the viewer: position counter, a slideshow play button with a menu (interval,
  hide HUD while playing, shuffle, surprise me), a *Go to* menu for Browse / Albums /
  Duplicates / Files, Settings and help. Fit/fill, hide HUD, immersive and fullscreen are
  keys only (`X`, `H`, `C`, `F`); fit/fill is also in Settings.
- **Loupe**: click an image to zoom to 200% at the cursor (Lightroom style), click again to
  fit, drag to pan; `Z` cycles fit / 100% / 200%. In edit mode both panes zoom and pan
  together so the same spot can be compared.
- **Viewer extras**: playback speed (`[`, `]`, `\`, or the speed button), frame stepping
  with `,` and `.` while paused, a thumbnail of the frame under the cursor when hovering
  the progress bar, and immersive mode (`C`): black background, no HUD, cursor hidden.
- **Albums** (`A`): pick one or more *album folders* in Settings. Every subfolder of an album
  folder is an album: it never appears in the main grid or the sorting queue, and the Albums
  screen shows it as one card with the first image as cover. Albums get their own 1 to 10
  rating and can be moved to a target folder as a whole. A PDF directly in an album folder is
  an album too (pages drawn by pdfium; tagged, compared for duplicates and encrypted like any
  other), never a picture of its own; Import puts PDFs there, and *Find albums* offers ones
  elsewhere, those the tagger takes for comics first. The sidebar filters albums by
  album folder, content (photos only, videos, both), rating and name, orders by name, date,
  size, count or rating, shuffles, and *Slideshow* flips through everything in the visible
  albums. Folders with URL-escaped names
  (`My%20Trip`, `Z%C3%BCrich`) can be decoded to their real names, either on demand with a
  preview of every rename, or automatically on each album scan (option on the Albums screen).
- **Drive health** (Settings → Drive health) shows the volume's bus (SD, USB, NVMe...),
  maker, model, serial, firmware, file system and capacity, the USB link speed (and whether
  the cable or port holds it back), SMART data when the device reports it (through
  `smartctl` if smartmontools is installed), a cache-bypassing read-speed benchmark with
  typical ranges for the device type, and a readability check (in Activity) that reads every
  byte of every file and lists the ones that fail. The maker's own apps, when installed, open
  from there for firmware and settings, which only they can change. SD cards expose no wear counters to a computer, so the
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
  **Quick unlock**: the Vault dialog can remember the vault on the current computer. On macOS
  the data key is kept in your Keychain and handed out only after Touch ID (or the login
  password); on Windows it is a file only your user can read in the app's data folder, handed
  out after Windows Hello. Linux has no standard prompt, so there the login session is the
  only gate. Only on that machine; passphrase and recovery code keep working. (The Keychain
  binds its trust to the exact binary: an unsigned development build may show an "allow
  access" dialog after a rebuild, which can hide behind the window. A signed release doesn't.)
  What a vault cannot do: stop someone who has your passphrase, or who sits at your unlocked
  Mac, from reading the files. Blob sizes also remain visible.
  The vault spreads its files over 256 folders, so no folder grows huge (a vault from an
  earlier version moves into them by itself, as a job in Activity). A FAT32 drive stores no
  file of 4 GB or more and looks a file up one folder entry at a time: exFAT or APFS suit a
  vault better, and the Vault page says so on a FAT32 drive.
- **Edit mode** (`T`, or Edit in the viewer and the Browse selection bar): the stage splits
  into original and live preview, and the bottom bar becomes the toolbox: rotate, flip,
  crop (free or fixed aspect, drawn on the preview), resize to a width or upscale 2×/4×
  (Lanczos), and for videos trim with in/out sliders, speed 0.25× to 4×, mute, and "Frame"
  to save a still. Convert to JPEG/PNG/WebP/TIFF or MP4 H.264/H.265, WebM, GIF, MP3; the
  quality choice only appears for lossy targets. *Overwrite* puts the result in the
  original's place and carries the rating over, *Save as copy* keeps both and adds a suffix;
  a Browse selection applies the same edits to every item. Plugins that change a picture
  (cleaning up or lettering pages, say) open from the viewer's **Plugins** menu (the puzzle
  piece in its bar, one button however many are installed): picking one opens its panel at the
  right, and `Esc` closes it. Photos in common formats are processed in Rust; videos,
  HEIC and anything else use **ffmpeg** when installed (`brew install ffmpeg`). Rotation,
  trim and mute on videos are lossless (no re-encode) when nothing else is changed. Works
  on vault items too. EXIF metadata is not carried over to edited photos.
- **Versions**: whatever an edit or a plugin makes from a picture remembers what it was made
  from, by both files' content, so the link holds however either is moved or renamed (in
  Finder too). An original that was overwritten is kept out of sight with the library
  (encrypted, in a vault): Info shows what a picture was made from, `O` in the viewer shows
  that picture, and *Revert* puts it back in its place (⌘Z undoes that). It goes for good with
  its version when the trash is emptied; the Trash page says how much is kept and can let it
  all go. The duplicate check pairs each version with its original, and Import knows a picture
  you already have a version of.
- **Files** (`E`): a file manager over the opened folder, for every file and folder, not
  only media. Icon view (thumbnails for media, typed glyphs for the rest, size slider) or
  list view; double-click a media file to open it in the viewer with its folder as the queue. Drag files from the desktop onto it to add them (encrypted on the way in when
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
    per-file *Trash*; clicking a tile opens the group in the viewer. *Whole pictures* shows
    each one at its own shape, uncropped, so a difference at the top or bottom shows.
  - The scope is a location plus an include/exclude folder tree, optionally with album
    folders. Before scanning, the panel shows how many files are already fingerprinted,
    how many are new, and a time estimate (improved by *Measure*, a short read benchmark).
    While running it shows a countdown, and a pill on every other screen shows progress
    so you can keep sorting. Fingerprinted files carry a ✓ badge in Browse.
- **Series**: a few pictures alike that you keep all of (a burst, glasses on and off, an
  artist's variations of a drawing, saved whenever). Sort suggests them under the picture on
  show: the waiting pictures are looked at once (in Activity), and the ones that look like it
  are offered as a series to keep (click one to leave it out) or not (they aren't offered with
  it again). In Duplicates, a group can be kept as one, or just the ones ticked in it with the rest
  trashed; a Browse selection can be made one or split.
  Kept together (Settings → Look and reading), a series is one stacked tile in Browse, comes up
  whole in Sort and the viewer ("SERIES 2/4"), and one target key files all of it, undone as
  one. Apart, each picture comes on its own. A series is no duplicate, and it follows its
  pictures through moves.
- **People** (`P`, in Collections): the real people in the photos and the characters in the
  drawings, together. Faces are found on this computer (SCRFD and AuraFace for photos, and
  for drawings, optionally, deepghs' anime face detector and CCIP; download them in Settings →
  Local models: a picture looked at without the drawings' finder is looked at again once it is
  there), in a scan in Activity that starts by itself once the tag index has nothing to do,
  over the library less the folders you leave out (People or Settings). Videos too, when ffmpeg
  is installed: a few frames spread over each are looked at (one every eight seconds or so),
  the same face in frame after frame kept once, and each face remembers its moment, which its
  crop shows. Faces nobody has named
  come up in groups, "Who is this?": name them (`N`), put them aside (`X`), or, for a drawn
  face, take the anime tagger's guess (`⏎`); `→` `←` move through the groups. "Check all"
  (`C`) shows every face in the group, the ones less like the rest last and marked: untick one
  and it's left out of the name and never found for that person. From then on faces close to
  the faces given someone are suggested for them (on their card and page, least sure first),
  and become theirs only when you say yes (a face double-clicked shows the whole picture it is
  in, the face outlined; right-clicked, it can be said to be someone else's instead); to be
  suggested, two of their faces have to agree,
  and a face more like one you said isn't them (a sister's, say) isn't. A face given someone
  without being checked one by one (from a tag, or with a group named whole) that looks like none
  of their others (someone else in a tagged picture) doesn't count for them until checked: their
  card says how many are "to check". Each person has a page: their pictures
  with the face marked (pick some, or right-click: `X` remove from them, `S` someone else, `U` the portrait), the years
  (click one to see it), who they're often with, rename and "Same as…" (someone with no face yet
  can be made a character or a person), and for a character where they are from (the series in
  their pictures, as the tagger or their platform says, suggested) and their character tag, the
  tagger's name for them that tells the matching who a drawn face is (worked out from their
  pictures or their name, or picked, or none); under a banner from the
  theme's sticker book that takes stickers anywhere (Stickers on it: one clicked or dragged from
  the shelf, then moved, resized, turned, right-clicked for more). A tag folder you used for people can become people ("From tags…"):
  each tag a person, a tagged picture's only face theirs; the tags go, undoably. A tagged picture
  where none of the faces could be said to be theirs (none found, several, or the one there
  someone else's) keeps them in it: their page lists those pictures, "their face not known", to
  open and say which face it is. In the viewer, the faces button (`⇧P`) outlines the faces in the
  picture on show with who each is: click one to name it, say yes to who it looks like, "Not
  them" or "Not a face"; one person can have several faces in a picture (a manga page). A face
  the scan missed (too small, turned away) is marked by dragging over it: it looks there alone,
  close up, and in a drawing the part marked is the face if none is found; a marked face is kept
  with its part and looked for there again on a rescan. Someone in a picture whose face doesn't
  show at all can be added to it all the same ("Someone with no face showing…"), and counts in
  Info and the People filter. Kept with the
  library, in its vault when it has one, and following pictures through moves.
- **Artists** (`W`, in Collections): who made the pictures, one artist a picture. Each artist has a
  page with their pictures, and when linked to their account on a platform Find has, their icon,
  what they say about themselves and their other pages (website, X: a site a line, the several
  addresses of one account together; a site Find has a plugin for shows its icon and links them
  there in one press), downloaded and kept with the library; they are found by name or by their account (in Latin letters, for a name in another
  script), with their icon wherever one is picked. Pictures brought in through Find suggest their
  artist at the top of the screen, to accept or turn down, and a work Find's "Do I have this?"
  surely finds in the library gives its copies the work's artist (undoably; copies with another
  artist are left as they are). Give pictures an artist by hand from a selection in Browse
  (Artist…), the picture on show in Sort (`⇧W`), or an album (right-click it in Albums; an album's
  pages go with it), and from Find's artist pages add them to your artists. Wherever an artist is
  added from a platform (a suggestion, Find's artist page, "Do I have this?"), they can instead be
  linked to one of yours (Link to an existing artist…, names alike first): the account is theirs
  too, and fills in only what they lack. A linked artist's page
  has tabs: *Theirs*; *From* the platform, *in your library*, a look through their works on the platform
  (in Activity, paced for its limits) that finds the ones you have by the duplicate check's
  fingerprints, lenient on a part painted again, to say yes or no to, the
  sure ones at once (each work is fetched once and its fingerprint kept with Find's data, so a
  later look only fetches new works and compares all of them with the library as it is then);
  *Like their style*, your pictures that look like theirs by the tag index (nearer theirs than
  other artists' or ones turned down; guesses, picked and said yes or no to together); and *More
  on* the platform, their newest works not in the library, to look at in Find or put in the basket. Kept
  with the library (in its vault when it has one) and following pictures and albums through moves.
  An artist's page opens with the same banner as a person's, their icon taped on, to put stickers on.
- **Find** (the Find group in the top bar, a tab for each platform) searches and browses
  platforms, one plugin each, added in Settings → Plugins. Sign in once per library, on the platform's own page or with
  what it asks for (a username and key, say), or browse signed out where the platform allows
  (the sign-in is kept with the library, in its vault when it has one, never on this computer); then your feed,
  the artists you follow, your bookmarks, rankings, searches (with tag suggestions) and an
  artist's works show as pictures at their own shapes, and the artists you follow as a list
  with their recent works. Click looks closer (every page, the tags, related works under it,
  a link to the site); `Space` or a tile's corner puts a work in the basket, a shortlist kept
  with the library, and importing is chosen there: `Space` (or `⌘A` for all) chooses works, and
  in a work of several pages, unticking a page leaves it out. `C` asks "Do I have this?"
  (Find's own record, the work's id in a file name, and the picture itself against the
  duplicate check's fingerprints); in the basket, "Look for them all" asks it of every work in
  Activity, and what it said is kept with the basket ("In library", "Not in library"). A
  picture found to be a work it didn't come in as (the same work posted on another platform) keeps
  that one beside its own, so it shows as had on both, and Info lists it under "Also on"; Find
  source looks such pictures up too. A picture's source in Info opens in Find, on its platform.
  Right-click has all of it. `I` imports what is chosen: the
  works download in Activity and come in through Import with the duplicate review, single
  pictures into a bucket, a work of several pages as an album, an animation as an MP4 (needs ffmpeg). Each
  picture keeps where it came from (its id, link, title, artist and tags) through moves, and
  works already in the library are marked. A platform's tags can come typed (artist, series,
  character), shown so on a work, and a character's name tells People who is in it.
  **Find source** (right-click pictures in Browse) looks pictures of yours up on a platform
  that can tell a picture by how it looks, in Activity; what is found waits for a yes (either
  picture clicked shows yours and the work large side by side, to tell whether they are the
  same), and a match said yes to becomes the picture's source as if it had come in through Find (its tags
  linked to yours come in, its artist is suggested). An artist met on two platforms (a page in
  common) is offered to be joined into one on their page in Artists. **Saved searches**: ☆ by a
  search's title (or an artist's page filtered by a tag) keeps it in the side panel; when a
  platform opens they are asked what is new since you last opened them (in Activity, or Check),
  and opening one marks what came since as New. **New to me** hides the works that had passed your
  screen before you opened the list (a work counts once it has been on screen half a second).
  Both, with what has passed your screen, are kept with the library (in its vault when it has one).
  Tile size sets how big the works are. A platform can be one of
  your own sites: Add a site… asks you to allow each one (it and its subdomains, kept with the
  library, in its vault when it has one, and listed in Settings → Plugins to remove), a site behind
  a browser check is passed once in a window of the app's own (then reading the site for the app,
  hidden, from a page of it that runs no scripts), and a platform's galleries can come in as albums with their language. Albums then
  offers to link one work in two languages as original and translation (same artist, about as
  many pages, most tags the same), each on your yes.

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
| `⇧` + a bucket's hotkey (or ⇧-click) | Into a folder of yours in it, or a new one |
| `⌫` / `Delete` | Move to trash |
| `⌘Z` | Undo |
| `←` `→` | Previous / next |
| `Space`, `M`, `,` `.` | Video: play/pause, mute, scrub 5s |
| `S` | Shuffle the queue |
| `B` | Browse everything (`Esc` back) |
| `D` | Find duplicates (`Esc` back) |
| `A` | Albums (`Esc` back) |
| `⇧H` | Home (or click QUIRE in the top bar) |
| `P` | People |
| `⇧P` | Faces in the picture on show: name them, mark one it missed |
| `W` | Artists |
| `E` | Files |
| `T` | Edit mode, with the plugins' tools (`Esc` cancels) |
| `X` | Fit the whole image, or fill the screen (may crop) |
| `Z` / click | Loupe: 200% at the cursor, click again to fit; Z cycles fit / 100% / 200% |
| `⏎` | Slideshow: auto-advance on a timer (2 to 60 s, picked next to the button); videos play to the end. Hides the HUD like H by default (toggle next to the interval); Esc pauses |
| `C` | Immersive mode (hides the HUD, black background, hidden cursor) |
| `H` | Hide / show the HUD in the viewer, or both the top bar and sidebar on the list screens (each also has its own toggle) |
| `R` | Surprise me |
| `[` `]` `\` | Playback speed down / up / reset |
| `G` | Settings |
| `I` | Info, beside the picture: who is in it and made it, where it lives and came from, what it was made from, tags, file and camera |
| `O` | Plugin overlays off and on; on an edited picture, what it was made from |
| `F` | Fullscreen |
| `?` | Key reference |

Target hotkeys are auto-assigned from the folder name and editable in Settings. Buttons
hide their key hints; hold ⌘ to reveal them, or press `?` for the full list.

## Plugins

Plugins add buttons, panels, overlays and platforms for Find, and can bring image pipelines of
their own that run in the local engine. Each lives in a repository of its own; nothing in the
app is any one plugin's (see `docs/plugins.md`).

- **Install** in Settings → Plugins by pasting a GitHub link
  (`https://github.com/owner/repo`, or `…/tree/main/folder` for a plugin in a subfolder)
  or a folder path. There is no plugin store.
- **Updates** come from the same GitHub repository: a new version is offered when its
  `plugin.json` has a higher version, in Settings › Updates (with the app's own) and in
  Settings › Plugins. Those asking for nothing new update together; one asking for more is
  reviewed in Plugins first. Folder plugins run in place and pick up edits on Reload.
- **Sandboxed.** Each plugin runs in an isolated frame and only gets the permissions you
  approve: reading media, drawing overlays, controlling the viewer, its own storage,
  running its own pipeline on this computer, and https access to the hosts it names. Encrypted folders are off limits unless you allow a
  plugin there.
- **Network.** The app itself goes online only to look for updates (its own and its
  plugins', on github.com), when you press Check now in Settings › Updates or, if you turn
  it on there, as it opens. Only plugins you granted a `network:` permission can reach the
  internet, and only the hosts they declared. Installing plugins from GitHub contacts github.com.
- **Find platforms.** A plugin with the `find` permission adds a platform to Find; with
  `login:` it can open that platform's sign-in page in a window of its own, and with
  `library:storage` keep the sign-in with the library.

Plugins and their data live in the app's data folder on this computer, not on the card,
except what a plugin keeps with the library (`library:storage`).
See [docs/plugins.md](docs/plugins.md) to write one.

## Updates

A released app updates itself: Settings › Updates checks GitHub for a newer version (and for
plugins' updates), downloads it as a job in Activity when you say, and puts it in place with a
restart once nothing is running. The download is signed; the app checks the signature, and the
version it was signed for, before replacing anything. Checking as the app opens is off until you
turn it on. A development build doesn't update itself. See [docs/releases.md](docs/releases.md).

## Development

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
update to it (see [docs/releases.md](docs/releases.md)).

A dev build and the released app share the app's data folder (plugins, models, quick unlock), and
only one of them can have a library open at a time: the second is told which copy has it. A copy
that has quit, or is stuck quitting (waiting on a drive that stopped answering), doesn't count.

```sh
```

The bundled icon uses the neutral base palette, because Finder and Explorer cannot follow
the in-app theme. While the app runs, the Dock (macOS) or window and taskbar icon (Windows,
Linux) is re-tinted from the active theme's colours.

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

`npm run e2e` (or `npm run e2e -- people` for the scenes with that in their name) runs the
app against the mock with made-up pictures (`?mock&e2e`, drawn by `e2e/server.mjs`), in the
installed Chrome (`CHROME=` for another), through every screen at 1440×900 and 1100×720 in a
dark and a light theme. It uses the features that need it (saying yes to tag suggestions,
checking and naming a group of faces, the Find basket), checks each screen for anything
spilling out of its box, cut off, laid over something else or past the window
(`e2e/overflow.js`), and leaves a screenshot of each in `e2e/out` to look over.

### Project layout

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

## Roadmap ideas

- EXIF capture date for sorting and info
- Optional in-memory downscaled thumbnails for very large grids
- Write ratings into XMP sidecars for Lightroom and friends
- Side-by-side compare, zoom to 100%
- Duplicate scan: audio fingerprinting for videos, scenes beyond the first 10 minutes
- Linux / Windows: the release workflow builds them, but they have not been run yet (HEIC and
  RAW previews there will need a decoder, since those webviews do not decode HEIC)
