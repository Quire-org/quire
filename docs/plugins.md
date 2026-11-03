# Writing Quire plugins

A plugin is a folder with a `plugin.json` manifest and a JavaScript file. It can add buttons to the app, read the images the user is looking at, draw text and images over them, change how the viewer turns pages, keep its own data, talk to the web hosts it declares, and add a platform to Find (searching and browsing a site, signing in there, and handing picks to Import). It cannot touch files, the app or the network in any other way.

Plugins live in repositories of their own; nothing in Quire is any one plugin's. This document is the whole API.

## How plugins run

Each enabled plugin runs in its own sandboxed frame with an opaque origin. The frame has no access to the app's page, its storage, Tauri, or the network: its content security policy blocks every connection. The only way out is the global `ms` object, which sends messages to the app. The app checks every call against the permissions the user approved before doing anything.

Plugins are added by pasting a GitHub link or a folder path in Settings → Plugins. There is no plugin store. Plugins from GitHub are downloaded into the app's data folder on this computer. Plugins from a folder run from that folder. Plugin data and settings stay on this computer, never on the card or folder being sorted, except what a plugin keeps with the library (`library:storage`, such as a sign-in), which stays with the library on its drive instead. The core app makes no network requests. A plugin can only reach the hosts named in its `network:` permissions, over https, through the app.

## The manifest

```json
{
  "id": "page-reader",
  "name": "Page Reader",
  "version": "1.0.0",
  "description": "One line shown in the plugin list.",
  "author": "You",
  "homepage": "https://example.com",
  "entry": "index.js",
  "permissions": ["media:read", "overlay", "network:api.example.org"],
  "settings": [
    { "key": "apiKey", "type": "secret", "label": "API key" },
    { "key": "language", "type": "select", "label": "Language", "options": ["English", "German"], "default": "English" }
  ],
  "minAppVersion": "0.1.0",
  "icon": "icon.png"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | 2 to 48 characters of `a-z`, `0-9` and `-`. Must stay the same across versions. |
| `name` | yes | Up to 60 characters. |
| `version` | yes | Semantic version. Raise it to publish an update. |
| `entry` | no | Script to run, relative to the folder. Defaults to `index.js`. |
| `permissions` | no | See below. The user approves them at install. |
| `settings` | no | Fields for the plugin's Settings form. Types: `text`, `secret`, `select` (with `options`), `boolean`, `number`. |
| `minAppVersion` | no | Refuse to install on older versions of the app. |
| `icon` | no | The plugin's logo, a picture in its folder: PNG, JPEG, WebP, GIF or SVG, up to 256 KB, square at best. Shown with its name in Settings → Plugins, and on its Find tab when the platform brings no icon of its own. Without one, a Find platform shows its site's icon there, and other plugins the plugin mark. |
| `engine` | no | The plugin's own image pipeline, a WebAssembly module in its folder (`engine.wasm`), run with `ms.engine.run` (below). |
| `models` | no | Ids of the local engine's models the plugin uses, its own included. Listed under it in Settings → Local models; a pipeline can only run these. |
| `ownModels` | no | Models the plugin brings (up to 10): `id`, `name`, `note`, `runtimes: true` when they need the Torch runtime, and `files` (up to 20), each `{ repository, revision, name, size }` on Hugging Face. Each must also be in `models`. |

## Permissions

| Permission | Allows |
| --- | --- |
| `media:read` | File names, folders and other details of items, and reading image pixels. Without it a plugin only sees opaque item keys. |
| `media:write` | Saving new files next to an item. An existing file is replaced only when the reader chooses Overwrite (`media.keep`); the app keeps the original, and Revert in Info brings it back. |
| `overlay` | Drawing text and images over images. |
| `viewer` | Next and previous page, the reading direction, and asking the reader to mark part of an image. |
| `storage` | A private key-value store of up to 5 MB. |
| `engine` | Running the plugin's own image pipeline on images, in the local engine (below). |
| `network:<host>` | https requests to that host. `network:*.example.org` covers its subdomains. |
| `login:<host>` | Opening that host's sign-in page in a window of its own, and receiving the address it ends on (below). |
| `library:storage` | Up to 1 MB kept with the library on its drive (below): in its vault when it has one, otherwise unencrypted. |
| `find` | Adding a platform to Find (below). |
| `sites` | Asking the reader to allow sites they add (a platform of the reader's own sites, below): each one, when allowed, is the plugin's to contact with its subdomains (`network:*.<site>`) and to open in a window of its own (`login:*.<site>`). They are the library's: kept with it (in its vault when it has one), never on this computer, and another library has its own. Settings → Plugins lists the open library's, to remove. |

Encrypted folders are off limits to every plugin until the user turns on "Allow on encrypted folders" for it. Until then, media calls fail while an encrypted folder is unlocked. Plugin storage and settings are not encrypted.

When an update asks for more permissions, the user is asked again. If they decline, the update is not installed.

## Events

```js
ms.on("ready", (info) => {});    // info: { id, manifest, granted, settings, appVersion, theme, mode } (mode: "light" | "dark")
ms.on("item", ({ item }) => {}); // the viewer moved to another item, or closed (item is null)
ms.on("button", (e) => {});      // one of your buttons was pressed
ms.on("settings", (values) => {}); // the user saved your settings
ms.on("cancel", ({ id }) => {});   // Stop was pressed on one of your jobs (ui.progress)
ms.on("pause", ({ id, paused }) => {}); // Pause or Resume on one of your jobs (one shown with pausable: true)
ms.on("model", ({ id, name }) => {}); // the user chose another language model in Settings → Local models (plugins with "engine")
ms.on("moved", ({ moves }) => {});  // files or folders moved: [old key, new key] pairs; a folder's pair covers everything under it
ms.on("forgotten", ({ keys, folders }) => {}); // gone for good (purged from the trash, deleted, missing a month): forget what you keep of these keys, and of everything in these folders
ms.on("engine", ({ stage, state, done, total }) => {}); // your pipeline's progress on engine.run: the stages it reports, and "model" while one of its models loads
ms.on("home", ({ panel, id }) => {}); // one of your things on the Home's shared panels was clicked (one without a work)
ms.on("panelopen", ({ open }) => {}); // your panel opened or closed (start it afresh when it opens, say)
```

A `button` event carries `{ id, location }` and the context of the button: `item` in the viewer, `items` for a Browse selection, `album: { key, name, count }` for an album (its buttons are entries of the album's right-click menu). In the viewer every plugin sits behind one Plugins button in the bar, so the bar stays the same however many are installed: its menu lists a plugin's buttons (under the plugin's name when it has several) and, for a plugin with a panel, the panel.

Items look like `{ key, name, kind, dir, albumKey, size, modified, hasRaw, hasVideo, encrypted }`. Without `media:read` they are just `{ key }`. `kind` is `image`, `raw` or `video`. `albumKey` is set when the item is inside an album.

## API

All calls return promises and reject with a readable message when something is not allowed.

```js
ms.log("anything");                          // shown in the plugin's Log
ms.ui.toast("Saved", "ok");                  // tone: info | ok | warn | error
ms.ui.addButton({ id, location, label, tooltip, icon }); // icon: SVG markup, tinted to the theme
ms.ui.updateButton(id, { label, tooltip, icon, active, busy });
ms.ui.removeButton(id);
ms.ui.progress(id, { label, done, total, detail, item, pausable }); // a long job in Activity (item: the key it is on, for a thumbnail; pausable: you handle "pause"); null ends it

ms.overlay.set(itemKey, [{ x, y, w, h, text, vertical }]); // fractions 0..1 of the image
ms.overlay.set(itemKey, [{ x: 0, y: 0, w: 1, h: 1, image: bytes, mime: "image/png" }]); // an image in place of text
ms.overlay.clear(itemKey);                   // or clear() for all of yours

ms.viewer.current();                         // item in the viewer, or null
ms.viewer.next(); ms.viewer.prev();
ms.viewer.setDirection("rtl", albumKey);     // without albumKey: everywhere
ms.ui.panel({ title, icon, controls });    // the plugin's panel at the right of the viewer; "panel" and "stroke" events come back
ms.home.share(panel, { title, items: [{ id, title, thumb, image, mime, work }] }); // the plugin's part of a shared panel on the Home; null takes it away
ms.ui.panelPatch(id, patch); ms.ui.panelOpen(open); ms.ui.brushClear();

ms.media.list();                             // items in the viewer's queue
ms.media.albums();                           // every album: [{ key, name, count, modified, translation, language }]; translation: the album the user set as its translated version; language: its language code ("ja", "en" …) when known
ms.media.album(albumKey);                    // the pages of an album, in reading order
ms.media.readImage(itemKey, { maxEdge, quality }); // { base64, mime, width, height, originalWidth, originalHeight }
ms.media.readImageBytes(itemKey);            // { bytes: ArrayBuffer, mime }
ms.media.save(itemKey, "name.png", data, { note, was }); // data: ArrayBuffer, Uint8Array or base64; linked to the item as its version
ms.media.keep(itemKey, "name.png", data, { choice, note, was }); // choice "replace" | "copy", or the app asks → { name, key, replaced } or null; was: { size, modified } of the item as read, so a result never lands on a picture that took its key meanwhile
ms.media.versions(itemKey);                  // { madeFrom: { name, note, mine, kept } or null, made: [{ name, note, mine }] }: mine when this plugin made it
ms.media.revert(itemKey);                    // a version this plugin made, its original kept: the original back in its place (as Revert in Info); { reverted } (needs media:write)


ms.engine.run(itemKey, options);             // { bytes (PNG) or null, mime, width, height, result, seconds }: your pipeline on the image
ms.engine.languageModel();                   // { id, name }: the language model the user chose, which the text tools use unless the pipeline names one

ms.dupes.versions({ id, label, tooltip, prefix, keys, note }); // versions of pictures it makes, for the duplicate check (needs media:write); null removes it

ms.storage.get(key); ms.storage.all(); ms.storage.set(key, value);
ms.settings.get();

ms.library.get(key); ms.library.set(key, value); // kept with the library on its drive (null removes)
ms.login.open({ url, until, name, cookies });  // the address the sign-in ended on (with `cookies`: { url, cookies }), or null when closed
ms.login.check({ url, name });  // a site's browser check passed in the app's window: { cookies, userAgent }, or null
ms.sites.list(); ms.sites.add(url); ms.sites.remove(domain); // sites the reader allowed (sites): add asks them, and gives the domain or null
const page = await ms.net.browse(url, { cookies }); // a page of a site it may open, fetched by the site's browser session (below)
ms.find.provide({ name, platform, site, imageHeaders, sections, artist, follow, signIn, taggerWords, lookup }, handlers); // a platform in Find

const res = await ms.net.fetch(url, { method, headers, body }); // body is a string, or bytes (ArrayBuffer or typed array)
res.status; res.ok; res.headers; await res.text(); await res.json(); await res.bytes();
```

`ui.panel` gives a plugin a panel at the right of the viewer, with the panel's `icon` and title. The viewer's Plugins menu lists it by that title and icon, and picking it opens and closes it; Esc or its X closes it too, and opening Edit does (one tool at a time). The plugin hears `panelopen` as it opens and closes. A plugin with a panel keeps its viewer-bar buttons in the panel instead. The panel is replaced whole on every call and holds up to 24 controls in the order given: `heading`, `text`, `button` (`label`, `tooltip`, `primary`, `active`, `busy`, `disabled`), `toggle` (`value`), `choice` (`options`, `value`), `input` (a line of text: `value`, `placeholder`; each change comes back as a `panel` event), one `brush` (needs the `viewer` permission): `modes` say what a stroke means, each mode painted into its own mask; and `colour` (needs `viewer` too): a swatch with an eyedropper, which the reader arms and then clicks on the image, giving `#rrggbb` back as the control's value. Buttons, toggles, choices, inputs and the brush's mode come back as the `panel` event `{ id, value }`; `ui.panelPatch(id, patch)` changes one control without redrawing the rest. While the panel is open the reader paints on the image with a round brush (size with `[` and `]` or the slider; a stroke that circles something fills the circle; Backspace, Undo and Clear take strokes back), and after each change the `stroke` event brings `{ id, itemKey, masks, shapes, count }`: `masks` has, per mode painted in, a PNG (`Uint8Array`, white where painted, 1024 wide, stretched to the image), `shapes` the strokes as shapes in fractions of the image. Strokes belong to the image they were painted on and go when the viewer moves on; `ui.brushClear()` forgets them once they are used. Overlay boxes with `outline: true` draw only an outline, for highlighting what was found.

`home.share` puts things on the Home, in a **shared panel**: a panel any number of plugins fill together, each with its own part. Plugins that use the same `panel` name (a few lowercase words with dashes: `new-from-followed`, say) and the same kind of items share one Home block, which shows each plugin's part as a row under its icon and name when the block is big enough, and otherwise the first few of each, every picture with its plugin's icon on it. The reader adds the block ("From extensions") and picks the panel by name. Each call replaces the plugin's part of that panel; `null` takes it away, and a plugin that is disabled or removed loses its parts. Up to 60 items each: `id`, `title`, and a picture as `thumb` (an address, fetched like the plugin's other requests, so its host must be one of its `network:` hosts; a Find platform's image headers apply) or `image` (bytes, with `mime`, up to 300 KB). An item with `work` (a work's id on the plugin's Find platform) opens that work in Find when clicked; any other comes back as the `home` event `{ panel, id }`. Parts are not kept: share again on `ready`.

`engine.run` runs the plugin's own pipeline on an image, on this computer: the WebAssembly module `engine` names, inside the local engine, with no files, network or clock of its own. It gets the image upright as RGB and `options` as JSON (an `ArrayBuffer` or typed array becomes base64; functions and the like become null; up to 32 MB), and can run the models the manifest names that the user has downloaded (TorchScript, on the GPU when there is one, kept loaded between images), the engine's LaMa inpainter, its text tools (find the text and balloons in the image, read it, translate it with a local language model, paint it out, letter new text in), and report progress, which comes as `engine` events and shows in Activity. It answers with the image it made as PNG bytes, if it made one, and `result`, whatever JSON it gave back. It never leaves the computer, downloads nothing while it runs (a call fails, and Local models opens with the model marked, until its models are downloaded), and runs one image at a time. The pipeline is written in Rust against Quire's engine SDK, `engine/sdk` (see `docs/engine.md`).

Keys are paths, so they change when files move. `moved` tells a plugin about moves made in the app, and about files the app found moved outside it (in Finder). Anything a plugin keeps by key in its storage should follow: a pair `[old, new]` stands for a file, or for a folder and everything under it (`old/…` becomes `new/…`).

`media.save` and `media.keep` write a version of an item, and the app links the two by their content, so the link follows both through moves. Info shows what a version was made from, called by `note` ("cleaned", say; without one, the `note` the plugin gave `dupes.versions`, or "edited"), and the duplicate check pairs each version with its original outright. `media.versions` tells a plugin what the app knows of an item: a page it already cleaned keeps no mark in its name once written over its original, and after Revert the original is back. Overwrite puts the version in the original's place under the original's name (with the version's extension), so an album's pages stay in order, and keeps the original out of sight with the library (encrypted, in a vault), so Revert in Info puts it back; it goes for good when the version does.

`dupes.versions` tells the duplicate check about versions of pictures the plugin makes, which differ from their original more than copies usually do (a page a plugin painted over differs where it painted). The Duplicates screen shows a toggle with the given `label` and `tooltip`, and while the reader has it on, the versions are matched with their pictures. A file named `prefix` plus a picture's name, beside that picture (`Cleaned 012.png` next to `012.jpg`), is matched with it outright. Every version is matched with other pictures at the loose sensitivity's distances. That covers files named with the prefix, and files listed in `keys` (versions written in place of their original under its name). Versions come first in their group, with `note` ("cleaned", say) as their badge. A name travels with the file when it is moved and a key doesn't, so prefer a prefix. Call it again to update it, for example with more keys; one per plugin. A plugin that saves its results under a prefix calls it once on `ready`.

`net.fetch` requests time out after 5 minutes, and responses over 20 MB are refused. No cookies are sent but the ones a plugin sets itself in `headers` (its own sign-in on a website, from `login.open`), and only to its `network:` hosts.

## Platforms in Find

Find searches and browses platforms, one plugin each (each a tab of its own in the Find group), and brings what the reader picks into the library through Import. A platform plugin needs `find`, `network:` for its API and image hosts, and usually `login:` and `library:storage` to sign in.

`ms.find.provide(info, handlers)` adds the platform. `info` gives its `name` (shown in Find and the top bar), `platform` (a short id, such as the site's name in lower case, stamped on what comes in from it), `site`, `imageHeaders` (headers the app sends when it fetches the platform's images, such as a `Referer`), `sections` (`[{ id, label, query?, options?, kind? }]`: a feed, bookmarks, rankings; `query: true` for search; `options` as `{ value, label }`; `kind: "artists"` for a section that lists artists, such as the ones followed) `artist: { options, tags }` (an artist's works, opened from a work; `tags: true` when their page lists their tags, its `artistTags` handler) and `follow: true` when artists can be followed from the app (its `follow` handler). `signIn: { fields: [{ id, label, secret }], help, link: { label, url }, optional }` is for a platform signed in with what the reader types (a username and API key, say) rather than a sign-in page: Find shows the fields (a `secret` one hidden), the help and the link, says where the sign-in will be kept, and its `signIn` handler gets `{ fields: { id: value } }`; with `optional: true`, it can be browsed signed out, with Sign in in the corner. `accounts: false` says it has no accounts at all: Find browses it as it is, with no sign-in. `albums: true` says its works are albums: Find reads one as an album (a page at a time, turned as the theme's book turns its pages, right to left unless the reader says otherwise, its pages small below), and it comes in whole, as an album; pages picked from it (their ticks below, or P) come in instead, each a single picture. Another platform's work of several pages comes in page by page unless chosen as an album, and its pages can be left out. `icon` is its icon (the site's own), shown on its tab and in the menus: an address on one of its hosts, or a small picture it brings along (`data:image/svg+xml,…` or a PNG, up to 32 KB), which shows even when the site turns the request away. `sites: { list: [{ id, name, icon }], current, add: { help } }` makes it a platform of the reader's own sites (its `icon` then the picked site's), one shown at a time: Find shows them to pick from (its `site` handler) and Add a site… (its `addSite` handler, given the address typed; the plugin asks `ms.sites.add` to have it allowed, and provides itself again with the new list). `taggerWords: true` says the platform's tags are the app's anime tagger's own words, so a tagger word linked to a tag of the reader's links the platform's tag too. `lookup: true` says it can look a picture up by how it looks (its `lookup` handler): Find source. Find asks `handlers` what it needs, each given its arguments and returning its answer, or a promise of it:

| Handler | Asked with | Answers |
| --- | --- | --- |
| `account` | | `{ signedIn, name, account, avatar, premium }` |
| `signIn` / `signOut` | | anything; Find asks `account` after |
| `list` | `{ section, query, option, author, tag, cursor, site }` | `{ items, next, title, total }`: `site`, for a platform of several sites, asks for one of them other than the one shown (a saved search of it, checked for what is new); `next` comes back as `cursor` for the next page; `total`, how many there are in all when the platform says (shown in place of a count of the ones loaded); `tag`, on an artist's page, only their works with it. A search's `query` is its terms separated by spaces, each one needed, and a word starting with `-` left out (`flower -sketch`), as the search box's chips make it. A section of `kind: "artists"` answers `artists` in place of `items`; an artist's page (`section: "artist"`) may add `artist`, who they are |
| `related` | `{ id, cursor }` | `{ items, next }`: works like this one, shown under it when looking closer |
| `artist` | `{ id }` or `{ url }` (the address of their page), and `site` for a platform of several sites (that site's, not the one shown) | an artist in full, with `bio`, `region` and `links: [{ label, url }]` (their other pages), for the library's Artists: its icon is downloaded and kept with the library |
| `work` | `{ id }` | `{ item, pages: [{ preview }], caption }`, for looking closer |
| `files` | `{ id }` | `{ source, folder, files: [{ url, name }] }`, or `animation: { zip, name, frames: [{ file, delay }] }` in place of `files` |
| `suggest` | `{ query }` | `[{ value, label }]` as the reader types |
| `artistTags` | `{ id }` | `[{ name, translated, count }]`: the artist's tags, most used first, shown on their page to pick one |
| `follow` | `{ id, follow, private, site }`: the artist, follow or stop, (following) only where the reader sees it, and on which of a platform's several sites | `{ followed }`: Follow and Unfollow on an artist's page in Find and in Artists |
| `site` | `{ id }`: another of its sites picked | anything, once it has provided itself again with it as `current` |
| `addSite` | `{ url }`: a site's address the reader typed | `{ id }`, once allowed (`ms.sites.add`), checked, and provided again with it as `current` |
| `lookup` | `{ image, mime }`: a picture of the reader's as a small JPEG (its long side 512 px), base64 | `{ matches: [{ item, similarity }] }`: works that look like it, `similarity` from 0 to 1 (Find source offers ones of 0.5 and more, and says ones of 0.9 and more are surely it) |

An item is `{ id, title, author: { id, name }, url, thumb, width, height, pages, kind: "image" | "pages" | "animation", tags: [{ name, translated, kind }], date, adult, ai, likes, views, language }` (`language` an ISO 639-1 code such as `ja`, where the platform says: an album that comes in from it takes it, and the app offers to link one work in two languages), a tag's `kind` (where the platform says) `artist`, `series`, `character`, `general` or `meta`: Find shows a work's tags by kind, and People takes a `character` tag as who is in the picture. An artist is `{ id, name, account, avatar, followed, works, url, recent }`, `recent` a few of their works as items. The app fetches `thumb`, `preview` and the files itself, with `imageHeaders`, and only from the plugin's `network:` hosts: anything else is left out. Items without a usable `thumb` are dropped.

Find source sends a picture only when the reader asks for it, picture by picture, and, while an encrypted folder is open, only to a platform allowed on encrypted folders. A match said yes to becomes the picture's `source`, as if it had come in through Find.

A pick's `files` are downloaded as an Activity job, then go through Import: single pictures into a bucket's folder like any import, a work of several files as an album of its own (named `folder`), an animation's frames made into an MP4 at their own timings (a frame not in the zip by its name is taken by its place among the zip's pictures). Each picture keeps `source` (`{ id, url, title, author, tags, date, adult }`) with it from then on, through moves in and outside the app; Find marks works already in the library by it. "Do I have this?" also looks for the work's id in file names and for the picture itself among the duplicate check's fingerprints, so it finds copies that came in some other way; the basket (works kept to look at later) is Find's own, kept with the library.

`ms.login.check({ url, name })` opens a site in a window of the app's own, on a host the plugin may open, for the reader to answer what it asks before it shows itself: its browser check (Cloudflare's "Just a moment…"), an age question. A bar at the foot of its pages says so, with Done; Done, or closing the window, ends it (ten minutes at most). The window stays on the site (it and its subdomains, and Cloudflare's check): where an ad would send it, it doesn't go, and it opens no other windows. It answers `{ cookies, userAgent }`, the window's cookies for the site then (null when it set none). Done, the window stays, hidden, as the site's browser session, waiting on a page of the site that runs nothing (its `robots.txt`: none of the site's ads or tracking): `ms.net.browse(url, { cookies })` fetches a page of the site in it, as the browser's own request (some checks turn away any other, whatever cookies it carries), and answers `{ status, ok, text() }`. Given the cookies kept from the check, a session gone (the app restarted) is opened again with them, hidden; with none, it is refused ("no browser session…") until the check is passed.

`ms.login.open({ url, until, name })` opens `url`, which must be on a `login:` host, in a window of its own that keeps no cookies. When the window goes to an address starting with one of `until` (where the platform sends the sign-in back, such as its OAuth callback), the window closes and the call answers with that address. Beside it the app explains where the sign-in will be kept and offers signing in with the browser instead, for accounts (Google, Apple) that refuse an app's window: then the call answers with what the reader pastes, an address or a code. It answers null when the reader closes the window or chooses Not now. With `cookies` (up to four addresses on the plugin's `network:` hosts), it answers `{ url, cookies }` instead: the window's cookies for each address as one `name=value; …` line, read just before it closes, for a plugin that also asks the platform's website as the reader. Signed in with the browser, `cookies` is empty.

`ms.library` keeps up to 1 MB per plugin with the library open, on its drive: in its vault (encrypted) when it has one, otherwise in its state files beside the media, unencrypted. While the library's vault is locked it refuses rather than write in plain sight. A sign-in kept there signs the reader in with that library only, wherever it is opened.

## Developing

1. In Settings → Plugins, press Browse and choose your plugin's folder, or paste its path. The plugin runs from that folder.
2. Edit the files, then press Reload on the plugin's card.
3. Errors and `ms.log` output appear under Log. Start the app with `QUIRE_DEBUG=1` to also print them in the terminal.

`QUIRE_PLUGIN_DIR=/some/folder` makes the app keep its plugin list and data somewhere else, which is handy for testing without touching your real setup.

## Publishing on GitHub

Push the plugin's folder to a public GitHub repository. Users paste one of these links:

| Link | Installs |
| --- | --- |
| `https://github.com/you/page-reader` | `plugin.json` at the root of the default branch |
| `https://github.com/you/plugins/tree/main/page-reader` | a plugin in a subfolder, from the `main` branch |
| `https://github.com/you/page-reader/tree/v1.2.0` | a fixed tag or branch |

The app looks up the commit the link points at, reads `plugin.json` from that commit to ask for permissions, and then downloads that same commit. What the user approved is exactly what runs.

"Check for updates" asks GitHub for the link's latest commit. When the `version` in its `plugin.json` is higher than the installed one, the plugin card offers an update. Commits that don't raise the version are ignored, so you can push work in progress and release by bumping the version. If an update asks for more permissions, the user is asked again. A link to a tag never changes, so it never updates.

Private repositories are not supported. Downloads use https, are limited to 50 MB, and archives with symlinks or paths outside the plugin's folder are refused.


## Models

A plugin that runs its own pipeline names the local engine's models it uses in its manifest, `"models": ["manga-ocr", "qwen3.5-4b"]` (ids as Local models lists them). They are shown under the plugin in Settings → Local models, where the user downloads them and chooses where models are kept (the app's data folder, the opened folder, or a folder of their choice). A model no installed plugin names is only shown there while it is downloaded.

A plugin can bring models of its own with `ownModels`: they join the engine's catalogue while the plugin is installed and download from the Hugging Face repository at the revision given (a commit, so the files can't change under it; the sizes are for the progress). A model whose files aren't published yet (`"repository": ""`) is looked for in the model store's `local/<id>/` folder, or in the folder the environment variable `QUIRE_MODEL_<ID>` names (`QUIRE_MODEL_MY_MODEL` for `my-model`), for trying a model out before publishing it. An id the engine already has can't be taken.
