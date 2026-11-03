// Fetches pdfium (Chromium's PDF engine, BSD licence, built by bblanchon/pdfium-binaries) for this
// computer and puts it where the app looks for it while developing, beside the engine:
// src-tauri/binaries. PDF albums' pages are drawn with it.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "chromium/8100";
const ASSETS = { "darwin-arm64": "pdfium-mac-arm64.tgz", "darwin-x64": "pdfium-mac-x64.tgz", "win32-x64": "pdfium-win-x64.tgz", "linux-x64": "pdfium-linux-x64.tgz", "linux-arm64": "pdfium-linux-arm64.tgz" };
const LIB = { darwin: ["lib", "libpdfium.dylib"], win32: ["bin", "pdfium.dll"], linux: ["lib", "libpdfium.so"] }[process.platform];

const asset = ASSETS[`${process.platform}-${process.arch}`];
if (!asset || !LIB) {
  console.error(`no prebuilt pdfium for ${process.platform}-${process.arch}`);
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "src-tauri", "binaries");
const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${encodeURIComponent(RELEASE)}/${asset}`;
const res = await fetch(url);
if (!res.ok) {
  console.error(`could not download ${url}: ${res.status}`);
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "pdfium-"));
try {
  writeFileSync(join(work, asset), Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xzf", join(work, asset), "-C", work]);
  mkdirSync(dest, { recursive: true });
  // Copied beside it and renamed over it, as the engine is: a running app keeps its old file.
  copyFileSync(join(work, ...LIB), join(dest, `${LIB[1]}.new`));
  renameSync(join(dest, `${LIB[1]}.new`), join(dest, LIB[1]));
  console.log(`pdfium ${RELEASE} ready: ${join(dest, LIB[1])}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
