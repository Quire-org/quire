// Gets the example library ready to open: a copy of examples/library in examples/.work/library
// (the app writes its own files into a library, which mustn't land in the repository), set up as
// a library already: Photos, People and Artworks as targets (keys J, N and Q, as the app suggests
// them: digits rate), Albums as the album folder, and the example tags (examples/tags.json) given.
// Inbox is what is left to sort.
// `npm run example` makes it afresh; then open the folder it prints in Quire.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(repo, "examples", "library");
const to = join(repo, "examples", ".work", "library");

if (!existsSync(from)) {
  console.error("examples/library is missing");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
// The pictures only: not the credits, nor what an app that opened the folder itself kept there.
cpSync(from, to, { recursive: true, filter: (p) => !/(^|\/)(CREDITS\.md|\.quire[^/]*|\.DS_Store)$/.test(p) });

const library = {
  version: 1,
  targets: [
    { id: "photos", name: "Photos", path: "Photos", hotkey: "j" },
    { id: "people", name: "People", path: "People", hotkey: "n" },
    { id: "artworks", name: "Artworks", path: "Artworks", hotkey: "q" },
  ],
  ratings: {},
  trashDir: "_deleted",
  albumRoots: ["Albums"],
  albumRatings: {},
  autoDecodeAlbumNames: false,
  backupDest: null,
  lastBackup: null,
  ids: {},
};
writeFileSync(join(to, ".quire.json"), JSON.stringify(library, null, 1));

// The tags: an album's on the album (its folder, or its PDF), anything else's on the picture.
const given = JSON.parse(readFileSync(join(repo, "examples", "tags.json"), "utf8"));
const tags = {};
for (const [key, ids] of Object.entries(given)) tags[key.startsWith("Albums/") ? `album:${key}` : key] = ids;
const types = [...new Set(Object.values(given).flatMap((ids) => ids.map((id) => id.split("/")[0])))].sort();
writeFileSync(join(to, ".quire.tags.json"), JSON.stringify({ version: 1, types, tags, auto: {}, indexed: {}, autoMap: {}, albums: {} }, null, 1));

console.log(`The example library is ready: ${to}`);
console.log(`Open it in Quire, or: QUIRE_ROOT="${to}" npm run tauri dev`);
