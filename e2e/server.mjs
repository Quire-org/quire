// The browser preview's files at http://localhost:8787, where the mock (src/dev/mock.ts) looks for
// them: every path of the mock volume is a made-up picture (src/dev/mockPictures.js), and
// /__plugin/<id>/… a plugin from the folder of that name beside this repository, served the way
// the app's msplugin scheme serves it. `node e2e/server.mjs` runs it on its own.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { mockSvg } from "../src/dev/mockPictures.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const type = (p) => (p.endsWith(".html") ? "text/html" : p.endsWith(".js") ? "text/javascript" : p.endsWith(".json") ? "application/json" : "application/octet-stream");

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
