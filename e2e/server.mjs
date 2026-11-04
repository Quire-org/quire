// The browser preview's files at http://localhost:8787, where the mock (src/dev/mock.ts) looks for
// them: every path of the mock volume is a made-up picture (src/dev/mockPictures.js), and
// /__plugin/<id>/… a plugin from the folder of that name beside this repository, served the way
// the app's msplugin scheme serves it. In the demo mode (`?mock&demo`), the example library's
// pictures are the volume: /__demo/index.json lists them, and each is served as it is.
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
      // A picture of the example library (the demo mode's) as it is.
      const example = normalize(join(examples, path));
      if (example.startsWith(examples + "/") && PICTURE.test(example) && existsSync(example)) return send(200, await readFile(example), pictureType(example));
      // Any other path: the made-up picture it stands for (or a face cut out of it).
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const box = q.get("face")?.split(",").map(Number);
      const face = box?.length === 4 ? { bbox: box, around: Number(q.get("around") ?? 1.8) } : undefined;
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
