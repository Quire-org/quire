// Renders a demo with Remotion into <work>/out/site, what GitHub Pages serves for its README:
// `node render.mjs video` (<name>-demo.mp4), `stills` (the screenshots, screenshots/*.jpg) or
// `studio` (to look at it while editing). <work> is this folder, or another demo's with
// `--work <folder>` (a plugin's: its script.json and the frames its capture kept in public/).
// Remotion's rendering doesn't load when its packages' path has a space in it, so in a checkout
// whose path has one, it runs from a copy of this folder in the temp folder (cloned, where the
// disk can), and so does a work folder's public/ whose path has one.
import { spawnSync } from "node:child_process";
import { constants, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [what, ...rest] = process.argv.slice(2);
const flag = rest.indexOf("--work");
const work = flag >= 0 ? resolve(rest[flag + 1]) : here;
const site = join(work, "out", "site");
const script = JSON.parse(readFileSync(join(work, "script.json"), "utf8"));
const scenes = JSON.parse(readFileSync(join(work, "public", "scenes.json"), "utf8"));

const clone = (from, to) => {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: (p) => !p.startsWith(join(from, "out")) });
  return to;
};
const cwd = /\s/.test(here) ? clone(here, join(tmpdir(), "quire-demo")) : here;
let pub = join(work, "public");
if (/\s/.test(pub)) pub = work === here ? join(cwd, "public") : clone(pub, join(tmpdir(), "quire-demo-public"));
const props = (extra = {}) => {
  const file = join(tmpdir(), `quire-demo-props-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ script, scenes, ...extra }));
  return `--props=${file}`;
};
const remotion = (args) => {
  const r = spawnSync(join(cwd, "node_modules", ".bin", "remotion"), [...args, `--public-dir=${pub}`], { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (what === "video") {
  mkdirSync(site, { recursive: true });
  remotion(["render", "src/index.ts", "Demo", join(site, `${script.name}-demo.mp4`), props(), "--codec=h264", "--crf=26", "--x264-preset=slow", "--log=warn"]);
  console.log(`${site}/${script.name}-demo.mp4`);
} else if (what === "stills") {
  mkdirSync(join(site, "screenshots"), { recursive: true });
  for (const [name, id] of Object.entries(script.stills)) {
    remotion(["still", "src/index.ts", "Screenshot", join(site, "screenshots", `${name}.jpg`), props({ id }), "--image-format=jpeg", "--jpeg-quality=86", "--log=warn"]);
    console.log(`${site}/screenshots/${name}.jpg`);
  }
} else if (what === "studio") {
  remotion(["studio", "src/index.ts", props()]);
} else {
  console.error("node render.mjs video | stills | studio [--work <folder>]");
  process.exit(2);
}
