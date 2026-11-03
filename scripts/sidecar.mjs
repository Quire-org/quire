// The engine as the bundler expects it: src-tauri/binaries/quire-engine-<target triple>, and pdfium beside it.
// tauri-build refuses to compile without that file, so a fresh checkout could not even run the app
// before building the engine (half an hour). This makes the triple-named copy from a built engine,
// or an empty stand-in when none is built: the app treats an empty engine as none (engine.rs) and
// runs with the engine's features off. `npm run engine` replaces the stand-in with the real thing.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "binaries");
const exe = process.platform === "win32" ? "quire-engine.exe" : "quire-engine";
// rustc as on the PATH, else where rustup puts it (an editor's or npm's PATH often lacks it).
const rustc = ["rustc", join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".cargo", "bin", process.platform === "win32" ? "rustc.exe" : "rustc")].find((r) => spawnSync(r, ["-vV"], { encoding: "utf8" }).status === 0) ?? "rustc";
const host = spawnSync(rustc, ["-vV"], { encoding: "utf8" }).stdout?.match(/^host: (\S+)/m)?.[1];
if (!host) {
  console.error("rustc not found: install Rust (rustup.rs), or put ~/.cargo/bin on your PATH.");
  process.exit(1);
}
const named = join(dest, exe.replace(/(\.exe)?$/, `-${host}$1`));
const built = join(dest, exe);
mkdirSync(dest, { recursive: true });
if (existsSync(built) && statSync(built).size > 0) {
  if (!existsSync(named) || statSync(named).size !== statSync(built).size) {
    copyFileSync(built, named);
    chmodSync(named, 0o755);
  }
} else if (!existsSync(named)) {
  writeFileSync(named, "");
  chmodSync(named, 0o755);
  console.log("No engine built yet (npm run engine): running without it.");
}
// pdfium the same way: the bundler wants its resource to exist; an empty one is none (pdf.rs).
const pdfium = { darwin: "libpdfium.dylib", win32: "pdfium.dll", linux: "libpdfium.so" }[process.platform];
if (pdfium && !existsSync(join(dest, pdfium))) {
  writeFileSync(join(dest, pdfium), "");
  console.log("No pdfium yet (npm run pdfium): PDF albums wait for it.");
}
