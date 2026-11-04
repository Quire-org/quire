// The README's looping clip, out/site/quire-demo.webp (Home, Sort and Browse, from the rendered
// video), and the site's front page, which sends a visitor on to the repository. Needs ffmpeg.
// `npm run loop` (after `npm run video`).
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "out", "site");
const video = join(site, "quire-demo.mp4");
if (!existsSync(video)) {
  console.error("out/site/quire-demo.mp4 is missing: npm run video first");
  process.exit(1);
}
const r = spawnSync(process.env.FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-ss", "2.6", "-t", "14.2", "-i", video, "-vf", "fps=12,scale=840:-1:flags=lanczos", "-c:v", "libwebp_anim", "-q:v", "62", "-loop", "0", "-an", join(site, "quire-demo.webp")], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync(join(site, "index.html"), '<!doctype html><meta charset="utf-8"><title>Quire</title><meta http-equiv="refresh" content="0; url=https://github.com/Quire-org/quire"><a href="https://github.com/Quire-org/quire">Quire on GitHub</a>\n');
console.log("out/site/quire-demo.webp, out/site/index.html");
