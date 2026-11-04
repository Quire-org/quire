// The workflow videos: each folder in workflows/ is a demo of its own (a capture.mjs on kit.mjs and a
// script.json), rendered into this demo's site beside Quire's own video, with its screenshots and a
// card-sized looping clip (which plays by itself in the README, where a video can't).
// `npm run workflows` makes them all; `npm run workflows -- <name>…` only those.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const asked = process.argv.slice(2);
const names = readdirSync(join(here, "workflows")).filter((n) => !n.startsWith(".") && (!asked.length || asked.includes(n)));
const run = (...args) => {
  const r = spawnSync(process.execPath, args, { cwd: here, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
for (const name of names) {
  const work = join(here, "workflows", name);
  console.log(`— ${name}`);
  run(join(work, "capture.mjs"));
  run("render.mjs", "video", "--work", work, "--site", join(here, "out", "site"));
  run("render.mjs", "stills", "--work", work, "--site", join(here, "out", "site"));
  run("loop.mjs", "--work", work, "--site", join(here, "out", "site"), "--width", "560", "--fps", "12");
}
