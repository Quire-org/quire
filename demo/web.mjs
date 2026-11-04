// The web demo: the app built for a plain browser in its demo mode (the example library, kept in
// memory: nothing is saved), with the library's pictures beside it, into out/site/demo, where the
// Demo workflow publishes it (https://quire-org.github.io/quire/demo/). `npm run web`.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const out = join(here, "out", "site", "demo");
const { build } = await import(pathToFileURL(join(repo, "node_modules/vite/dist/node/index.js")).href);

process.env.VITE_DEMO = "1";
rmSync(out, { recursive: true, force: true });
await build({ root: repo, base: process.env.DEMO_BASE ?? "/quire/demo/", logLevel: "warn", build: { outDir: out, emptyOutDir: true, target: "es2022" } });

// The pictures (the PDF album left out: the demo has no pages for it), their list and the tags.
const library = join(repo, "examples", "library");
const files = join(out, "files");
const found = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(jpe?g|png|webp)$/i.test(e.name)) found.push(relative(library, p).split("\\").join("/"));
  }
};
walk(library);
for (const rel of found) {
  mkdirSync(dirname(join(files, rel)), { recursive: true });
  cpSync(join(library, rel), join(files, rel));
}
mkdirSync(join(files, "__demo"), { recursive: true });
writeFileSync(join(files, "__demo", "index.json"), JSON.stringify(found.sort()));
cpSync(join(repo, "examples", "tags.json"), join(files, "__demo", "tags.json"));
cpSync(join(repo, "examples", "faces.json"), join(files, "__demo", "faces.json"));
console.log(`out/site/demo: the app and ${found.length} pictures`);
