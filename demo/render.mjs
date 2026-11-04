// Renders with Remotion into out/site, what GitHub Pages serves for the README: `node render.mjs
// video` (quire-demo.mp4), `stills` (the screenshots, screenshots/*.jpg) or `studio` (to look at
// it while editing). Remotion's
// rendering doesn't load when its packages' path has a space in it, so in a checkout whose path
// has one, it runs from a copy of this folder in the temp folder (cloned, where the disk can).
import { spawnSync } from "node:child_process";
import { constants, cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "out", "site");
let cwd = here;
if (/\s/.test(here)) {
  cwd = join(tmpdir(), "quire-demo");
  rmSync(cwd, { recursive: true, force: true });
  cpSync(here, cwd, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: (p) => !p.startsWith(join(here, "out")) });
}
const remotion = (args) => {
  const r = spawnSync(join(cwd, "node_modules", ".bin", "remotion"), args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** The screenshots: name → frame. */
const STILLS = { sort: "sort-2", browse: "browse", albums: "albums", reader: "reader-1", tags: "tags", themes: "look-cp2077-dark" };

const what = process.argv[2];
if (what === "video") {
  mkdirSync(site, { recursive: true });
  remotion(["render", "src/index.ts", "Demo", join(site, "quire-demo.mp4"), "--codec=h264", "--crf=26", "--x264-preset=slow", "--log=warn"]);
} else if (what === "stills") {
  mkdirSync(join(site, "screenshots"), { recursive: true });
  for (const [name, id] of Object.entries(STILLS)) {
    remotion(["still", "src/index.ts", "Screenshot", join(site, "screenshots", `${name}.jpg`), `--props=${JSON.stringify({ id })}`, "--image-format=jpeg", "--jpeg-quality=86", "--log=warn"]);
    console.log(`out/site/screenshots/${name}.jpg`);
  }
} else if (what === "studio") {
  remotion(["studio", "src/index.ts"]);
} else {
  console.error("node render.mjs video | stills | studio");
  process.exit(2);
}
