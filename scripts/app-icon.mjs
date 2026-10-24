// Regenerates src-tauri/icons/* from src/assets/app-icon.svg.
// The bundled icon (Finder, Launchpad, Explorer) cannot follow the in-app theme, so it
// uses the neutral base palette from src/themes/base.css. While the app runs, the Dock /
// taskbar icon is re-tinted from the active theme (see src/lib/appIcon.ts).
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const palette = { bg: "#14161c", ink: "#e8eaf0", dim: "#5c6270", dot: "#8ab4ff" };
const template = readFileSync(fileURLToPath(new URL("../src/assets/app-icon.svg", import.meta.url)), "utf8");
const svg = template.replace(/\{\{(\w+)\}\}/g, (_, k) => palette[k] ?? "magenta");
const out = join(mkdtempSync(join(tmpdir(), "app-icon-")), "icon.svg");
writeFileSync(out, svg);
const r = spawnSync("npx", ["tauri", "icon", out], { stdio: "inherit", cwd: fileURLToPath(new URL("..", import.meta.url)) });
if (r.error) console.error(r.error);
process.exit(r.status ?? 1);
