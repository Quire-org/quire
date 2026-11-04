<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="104" alt="">
</p>

<h1 align="center">Quire</h1>

<p align="center">A private picture library for your drives.</p>

<p align="center">
  <a href="https://github.com/Quire-org/quire/releases/latest">Download</a> ·
  <a href="docs/guide.md">Guide</a> ·
  <a href="docs/plugins.md">Plugins</a> ·
  <a href="docs/development.md">Develop</a>
</p>

<p align="center">
  <a href="https://github.com/Quire-org/quire/releases/latest"><img src="https://img.shields.io/github/v/release/Quire-org/quire?label=release" alt="Latest release"></a>
  <a href="https://github.com/Quire-org/quire/actions/workflows/ci.yml"><img src="https://github.com/Quire-org/quire/actions/workflows/ci.yml/badge.svg" alt="Tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="MIT licence"></a>
</p>

<p align="center">
  <img src="https://quire-org.github.io/quire/quire-demo.webp" width="840" alt="Quire's Home, a picture rated and filed with two keys, and the library browsed and filtered by a tag">
  <br>
  <a href="https://quire-org.github.io/quire/quire-demo.mp4">Watch the whole demo (33 seconds)</a>
</p>

Quire keeps a large collection of pictures and videos in order where it already lives: an SD card,
an external drive or any folder. You go through what's new full screen, rating and filing each
picture with a key, then browse, tag and read the whole library in one place. What Quire knows
about your pictures is kept with them on the drive, so it goes wherever they go, and nothing
leaves your computer unless you ask it to.

## Download

Pick the file for your computer from the [latest release](https://github.com/Quire-org/quire/releases/latest).

| Computer | File | The first time |
| --- | --- | --- |
| Mac with Apple silicon | `Quire_…_aarch64.dmg` | The app is self-signed: right-click it, choose Open, then Open again. |
| Windows 10 or 11, 64-bit | `Quire_…_x64-setup.exe` | Windows may warn about an unknown publisher: More info, then Run anyway. |
| Linux, x86-64 | `Quire_…_amd64.AppImage` or `.deb` | Needs Ubuntu 24.04, Debian 13, Fedora 39 or newer. |

Intel Macs aren't supported: the runtime behind Quire's models isn't built for them. Once
installed, Quire updates itself: Settings › Updates looks for a new version when you ask, or each
time a library opens if you turn that on.

## What it does

**Sort.** Open a card or a drive and go through what's new, one picture at a time. A digit rates
it 1 to 10, a letter moves it into one of your folders, ⌫ puts it in the library's own trash, and
⌘Z takes any of it back. RAW and JPEG pairs, sidecars and Live Photos move together.

**Browse.** The whole library in one grid, in rows that keep each picture's shape or in squares,
narrowed by folder, type, rating, tags, people or artists. Play it as a slideshow, shuffle it, or
narrow it to what you've never looked at.

**Albums and comics.** Folders and PDFs are albums, read page by page, with your place in each
kept. Album names that arrived garbled are put right.

**Home.** A board of blocks you arrange yourself: what waits to be sorted, this day in other
years, favourites, the album you're reading, the drive's health, and more.

**Tags and people.** Quire suggests tags and finds faces with models that run on your own
computer once downloaded. It learns from the suggestions you accept and never names anyone by
itself.

**Duplicates and versions.** Exact copies, near-identical photos and clips cut from longer videos,
found across the library. An edited picture stays linked to its original, which is kept so you
can go back to it.

**A vault.** A library can be encrypted, pictures, thumbnails and everything Quire knows about
them, and unlocked with a passphrase, Touch ID or Windows Hello.

**Themes.** Seven of them, each with a light and a dark side, from a quiet white gallery to a neon
night city.

And: backups to another drive, a drive's health and read speed, a scrapbook of album covers and
stickers, and showing a picture on another screen on the same network.

<table>
  <tr>
    <td width="50%"><img src="https://quire-org.github.io/quire/screenshots/sort.jpg" alt="Sorting: a photo full screen, rated 9, with the folders it can be filed into below"></td>
    <td width="50%"><img src="https://quire-org.github.io/quire/screenshots/browse.jpg" alt="Browse: the library in rows that keep each picture's shape"></td>
  </tr>
  <tr>
    <td align="center">Sort, a key for each folder</td>
    <td align="center">Browse everything</td>
  </tr>
  <tr>
    <td><img src="https://quire-org.github.io/quire/screenshots/albums.jpg" alt="Albums: four comics, each shown by its cover"></td>
    <td><img src="https://quire-org.github.io/quire/screenshots/reader.jpg" alt="A comic page open in the reader"></td>
  </tr>
  <tr>
    <td align="center">Albums</td>
    <td align="center">Reading, page by page</td>
  </tr>
  <tr>
    <td><img src="https://quire-org.github.io/quire/screenshots/tags.jpg" alt="Tags: every tag of the library, grouped by kind"></td>
    <td><img src="https://quire-org.github.io/quire/screenshots/themes.jpg" alt="The Home in the Night City theme"></td>
  </tr>
  <tr>
    <td align="center">Tags</td>
    <td align="center">The Home, in another theme</td>
  </tr>
</table>

## Private by design

- **Kept with your pictures.** Folders, ratings, tags, people and settings live in small files at
  the top of the library (`.quire.json` and its siblings), inside its vault when it has one. Move
  or rename pictures in Finder or Explorer, and Quire finds them again by their content.
- **Offline.** No account and no tracking. Quire itself goes online only when you ask it to: to
  download a model or a plugin, or to look for updates (also each time a library opens, if you
  turn that on). Plugins reach only the sites they name, once you've approved them, and with
  "Ask before going online" on, nothing goes out until you press Connect.
- **Models on your computer.** Tags, faces and the other models are downloaded once, when you ask
  for them, and run on your own computer. No picture is sent anywhere to be looked at.

## Plugins

Plugins add buttons, panels and overlays, platforms for Find, and image pipelines of their own
that run in Quire's local engine. Each runs sandboxed, with only the permissions you approve. Add
one by pasting its GitHub link in Settings › Plugins; [docs/plugins.md](docs/plugins.md) explains
how to write one.

The official plugins, made alongside Quire:

| Plugin | What it does |
| --- | --- |
| [Manga Translate](https://github.com/Quire-org/manga-translate) | Albums read as manga, right to left, and their pages translated on your own computer: over the balloons, or saved as lettered pages. |
| [Pixiv](https://github.com/Quire-org/pixiv-find) | Pixiv in Find: your feed, bookmarks, rankings, artists and searches. Picks come into the library through Import, with where they came from. |

## Build from source

You need Node 20 or newer, Rust, and [Tauri's prerequisites](https://tauri.app/start/prerequisites/)
for your system.

```sh
git clone https://github.com/Quire-org/quire.git
cd quire
npm install
npm run tauri dev
```

`npm run example` sets up a library of openly licensed pictures to try it on. The app runs
without its local engine at first: `npm run engine` builds it (tags, faces and the other models;
it takes a while), and `npm run pdfium` adds PDF albums' pages. [docs/development.md](docs/development.md)
covers the tests, bundles and the browser preview.

## Documentation

| | |
| --- | --- |
| [Guide](docs/guide.md) | Every screen and key |
| [Plugins](docs/plugins.md) | Writing a plugin |
| [Engine](docs/engine.md) | The local engine and its models |
| [Activity](docs/activity.md) | How long jobs report, pause and stop |
| [Releases](docs/releases.md) | Releases and how Quire updates |
| [Development](docs/development.md) | Building, testing, the browser preview, the demo |
| [Brand](docs/brand.md) | The mark and how it's used |

## Credits

The screenshots and the demo show the example library: comics and art from
[Pepper&Carrot](https://www.peppercarrot.com) by David Revoy (CC BY 4.0), *Little Nemo in
Slumberland* by Winsor McCay (public domain), and photos from Wikimedia Commons, each with its
author and licence in [examples/library/CREDITS.md](examples/library/CREDITS.md).

Quire is built with [Tauri](https://tauri.app), React and Rust; its engine with
[Koharu](https://github.com/koharu-rs/koharu) and [ONNX Runtime](https://onnxruntime.ai).
Interface sounds by [Kenney](https://kenney.nl) (CC0), stickers from Microsoft's
[Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (MIT).

## Licence

MIT, © 2026 Kile. See [LICENSE](LICENSE). The example pictures keep their own licences.
