// Regenerates src-tauri/icons/* from src/assets/app-icon.svg, and from app-icon-small.svg the 16
// and 32 px sizes macOS shows in lists, where the gathered pages would be under a pixel apart.
// The bundled icon (Finder, Launchpad, Explorer) cannot follow the in-app theme, so it uses the
// neutral base palette from src/themes/base.css. While the app runs, the Dock / taskbar icon is
// re-tinted from the active theme (see src/lib/appIcon.ts).
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const icons = join(repo, "src-tauri", "icons");
const work = mkdtempSync(join(tmpdir(), "app-icon-"));
const palette = { bg: "#14161c", ink: "#e8eaf0" };

function filled(name) {
  const template = readFileSync(join(repo, "src", "assets", name), "utf8");
  const out = join(work, name);
  writeFileSync(out, template.replace(/\{\{(\w+)\}\}/g, (_, k) => palette[k] ?? "magenta"));
  return out;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: repo });
  if (r.error) console.error(r.error);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const main = filled("app-icon.svg");
const small = filled("app-icon-small.svg");
// Every icon from the full one.
run("npx", ["tauri", "icon", main]);
// A desktop app: the phone icons it makes too aren't kept.
for (const phone of ["android", "ios"]) rmSync(join(icons, phone), { recursive: true, force: true });
if (process.platform === "darwin") {
  // The macOS icon again, its small sizes from the small one.
  const big = join(work, "big");
  const little = join(work, "small");
  run("npx", ["tauri", "icon", main, "-o", big, "-p", "128", "-p", "256", "-p", "512", "-p", "1024"]);
  run("npx", ["tauri", "icon", small, "-o", little, "-p", "16", "-p", "32", "-p", "64"]);
  const set = join(work, "icon.iconset");
  mkdirSync(set);
  const sizes = [
    ["icon_16x16.png", little, 16],
    ["icon_16x16@2x.png", little, 32],
    ["icon_32x32.png", little, 32],
    ["icon_32x32@2x.png", little, 64],
    ["icon_128x128.png", big, 128],
    ["icon_128x128@2x.png", big, 256],
    ["icon_256x256.png", big, 256],
    ["icon_256x256@2x.png", big, 512],
    ["icon_512x512.png", big, 512],
    ["icon_512x512@2x.png", big, 1024],
  ];
  for (const [name, dir, px] of sizes) copyFileSync(join(dir, `${px}x${px}.png`), join(set, name));
  run("iconutil", ["-c", "icns", set, "-o", join(icons, "icon.icns")]);
  copyFileSync(join(little, "32x32.png"), join(icons, "32x32.png"));
}
