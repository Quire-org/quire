// The browser preview's files at http://localhost:8787, where the mock (src/dev/mock.ts) looks for
// them: every path of the mock volume is a made-up picture (src/dev/mockPictures.js), and
// /__plugin/<id>/… a plugin from the folder of that name beside this repository, served the way
// the app's msplugin scheme serves it. In the demo mode (`?mock&demo`), the example library's
// pictures are the volume: /__demo/index.json lists them, and each is served as it is (or a face cut
// out of it, as the app's thumbnails do).
// `node e2e/server.mjs` runs it on its own.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { mockSvg } from "../src/dev/mockPictures.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const type = (p) => (p.endsWith(".html") ? "text/html" : p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : "application/octet-stream");

const examples = join(repo, "examples", "library");
const PICTURE = /\.(jpe?g|png|webp)$/i;
const pictureType = (p) => (/\.png$/i.test(p) ? "image/png" : /\.webp$/i.test(p) ? "image/webp" : "image/jpeg");

/** A JPEG's size, from its frame header. */
function jpegSize(b) {
  for (let i = 2; i + 9 < b.length; i += 2 + b.readUInt16BE(i + 2)) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
  }
  return null;
}

/** A face cut out of a JPEG the way the backend cuts one (thumbs.rs): a square `around` times its box, as an SVG over the picture. */
function faceOf(bytes, [a, b, c, d], around) {
  const size = jpegSize(bytes);
  if (!size) return null;
  const { width: W, height: H } = size;
  const side = Math.max(1, Math.min(Math.max((c - a) * W, (d - b) * H) * around, W, H));
  const place = (centre, extent) => Math.min(extent - side, Math.max(0, centre * extent - side / 2));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="${place((a + c) / 2, W)} ${place((b + d) / 2, H)} ${side} ${side}"><image href="data:image/jpeg;base64,${bytes.toString("base64")}" width="${W}" height="${H}"/></svg>`;
}

/** The example library's pictures, as paths in it (its PDF album left out: the preview has no pages for it). */
async function demoIndex() {
  const found = [];
  const walk = async (dir, rel) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) await walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
      else if (PICTURE.test(e.name)) found.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  await walk(examples, "");
  return found.sort();
}

export function startFileServer(port = 8787) {
  const server = createServer(async (req, res) => {
    const send = (code, body, t) => (res.writeHead(code, { "content-type": t, "access-control-allow-origin": "*", "cache-control": "no-store" }), res.end(body));
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const plugin = /^\/__plugin\/([a-z0-9-]+)\/(.+)$/.exec(path);
    try {
      if (plugin) {
        const [, id, rel] = plugin;
        const dir = join(repo, "..", id);
        if (!existsSync(join(dir, "plugin.json"))) return send(404, "no such plugin", "text/plain");
        if (rel === "__frame.html") return send(200, (await readFile(join(repo, "src-tauri/src/plugin_frame.html"), "utf8")).replaceAll("{{ID}}", id).replaceAll("{{ENTRY}}", "index.js"), "text/html");
        if (rel === "__sdk.js") return send(200, await readFile(join(repo, "src/plugins/sdk.js")), "text/javascript");
        const file = normalize(join(dir, rel));
        if (!file.startsWith(dir + "/")) return send(403, "no", "text/plain");
        return send(200, await readFile(file), type(file));
      }
      if (path === "/__demo/index.json") return send(200, JSON.stringify(await demoIndex()), "application/json");
      if (path === "/__demo/tags.json") return send(200, await readFile(join(repo, "examples", "tags.json")), "application/json");
      if (path === "/__demo/faces.json") return send(200, await readFile(join(repo, "examples", "faces.json")), "application/json");
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const box = q.get("face")?.split(",").map(Number);
      const face = box?.length === 4 ? { bbox: box, around: Number(q.get("around") ?? 1.8) } : undefined;
      // A picture of the example library (the demo mode's) as it is, or a face of it.
      const example = normalize(join(examples, path));
      if (example.startsWith(examples + "/") && PICTURE.test(example) && existsSync(example)) {
        const bytes = await readFile(example);
        const cut = face && /\.jpe?g$/i.test(example) ? faceOf(bytes, face.bbox, face.around) : null;
        return cut ? send(200, cut, "image/svg+xml") : send(200, bytes, pictureType(example));
      }
      // Any other path: the made-up picture it stands for (or a face cut out of it).
      return send(200, mockSvg(path.replace(/^\/+/, ""), face), "image/svg+xml");
    } catch {
      send(404, "no", "text/plain");
    }
  });
  return new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startFileServer();
  console.log("mock files on http://localhost:8787");
}
