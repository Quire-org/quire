// A demo's looping clip for its README, <work>/out/site/<name>-demo.webp (the whole rendered video,
// or the part its script.json's `loop` names), and the site's front page, which sends a visitor on to the
// repository. <work> is this folder, or another demo's with `--work <folder>`. Needs ffmpeg.
// `npm run loop` (after `npm run video`).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const flag = process.argv.indexOf("--work");
const work = flag >= 0 ? resolve(process.argv[flag + 1]) : here;
const script = JSON.parse(readFileSync(join(work, "script.json"), "utf8"));
const site = join(work, "out", "site");
const video = join(site, `${script.name}-demo.mp4`);
if (!existsSync(video)) {
  console.error(`${video} is missing: render the video first`);
  process.exit(1);
}
const part = script.loop ? ["-ss", String(script.loop.from), "-t", String(script.loop.length)] : [];
const r = spawnSync(process.env.FFMPEG ?? "ffmpeg", ["-v", "error", "-y", ...part, "-i", video, "-vf", "fps=15,scale=840:-1:flags=lanczos", "-c:v", "libwebp_anim", "-q:v", "62", "-loop", "0", "-an", join(site, `${script.name}-demo.webp`)], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>${script.title.title}</title><meta http-equiv="refresh" content="0; url=${script.repository}"><a href="${script.repository}">${script.title.title} on GitHub</a>\n`);
console.log(`${site}/${script.name}-demo.webp, index.html`);
