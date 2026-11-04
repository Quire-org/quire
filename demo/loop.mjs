// A demo's looping clip for its README, <name>-demo.webp beside its video (the whole rendered video,
// or the part its script.json's `loop` names): an animated picture, which plays by itself where a
// README can't embed a video. <work> is this folder, or another demo's with `--work <folder>`;
// `--site <folder>` is where its video is and the clip goes (a workflow's: Quire's own site), else
// <work>/out/site, which also gets the front page that sends a visitor on to the repository.
// `--width` and `--fps` size the clip (840 and 15: the README's top clip; a card's is smaller).
// Needs ffmpeg. `npm run loop` (after `npm run video`).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const work = resolve(option("--work") ?? here);
const own = !option("--site");
const site = resolve(option("--site") ?? join(work, "out", "site"));
const width = Number(option("--width") ?? 840);
const fps = Number(option("--fps") ?? 15);
const script = JSON.parse(readFileSync(join(work, "script.json"), "utf8"));
const video = join(site, `${script.name}-demo.mp4`);
if (!existsSync(video)) {
  console.error(`${video} is missing: render the video first`);
  process.exit(1);
}
const part = script.loop ? ["-ss", String(script.loop.from), "-t", String(script.loop.length)] : [];
const clip = join(site, `${script.name}-demo.webp`);
const r = spawnSync(process.env.FFMPEG ?? "ffmpeg", ["-v", "error", "-y", ...part, "-i", video, "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos`, "-c:v", "libwebp_anim", "-q:v", "62", "-loop", "0", "-an", clip], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);
if (own) writeFileSync(join(site, "index.html"), `<!doctype html><meta charset="utf-8"><title>${script.title.title}</title><meta http-equiv="refresh" content="0; url=${script.repository}"><a href="${script.repository}">${script.title.title} on GitHub</a>\n`);
console.log(own ? `${clip}, index.html` : clip);
