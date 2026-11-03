// Builds the local engine (engine/: models, plugin pipelines, Koharu) and puts it where
// the app looks for it while developing: src-tauri/binaries. Set
// CARGO_TARGET_DIR to build somewhere other than engine/target.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(root, "engine");
const exe = process.platform === "win32" ? "quire-engine.exe" : "quire-engine";
const env = { ...process.env, CARGO_NET_GIT_FETCH_WITH_CLI: process.env.CARGO_NET_GIT_FETCH_WITH_CLI ?? "true" };
// bindgen in Koharu's native-library crates needs libclang; on a Mac the command line tools have one.
if (process.platform === "darwin" && !env.LIBCLANG_PATH) env.LIBCLANG_PATH = "/Library/Developer/CommandLineTools/usr/lib";

const build = spawnSync("cargo", ["build", "--release"], { cwd: engine, env, stdio: "inherit" });
if (build.error) {
  console.error(`could not run cargo: ${build.error.message}. Install Rust (rustup.rs), or put ~/.cargo/bin on your PATH.`);
  process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);
const target = env.CARGO_TARGET_DIR || join(engine, "target");
const dest = join(root, "src-tauri", "binaries");
mkdirSync(dest, { recursive: true });
// Copied beside it and renamed over it: an engine the app is running keeps its old file instead of crashing.
copyFileSync(join(target, "release", exe), join(dest, `${exe}.new`));
chmodSync(join(dest, `${exe}.new`), 0o755);
renameSync(join(dest, `${exe}.new`), join(dest, exe));
// The bundler (tauri build) wants the same file named for the build target, e.g.
// quire-engine-aarch64-apple-darwin; it is put beside the app under its plain name.
// rustc as on the PATH, else where rustup puts it (an editor's or npm's PATH often lacks it).
const rustc = ["rustc", join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".cargo", "bin", process.platform === "win32" ? "rustc.exe" : "rustc")].find((r) => spawnSync(r, ["-vV"], { encoding: "utf8" }).status === 0) ?? "rustc";
const host = spawnSync(rustc, ["-vV"], { encoding: "utf8" }).stdout?.match(/^host: (\S+)/m)?.[1];
if (host) {
  const named = exe.replace(/(\.exe)?$/, `-${host}$1`);
  copyFileSync(join(dest, exe), join(dest, `${named}.new`));
  chmodSync(join(dest, `${named}.new`), 0o755);
  renameSync(join(dest, `${named}.new`), join(dest, named));
}
console.log(`engine ready: ${join(dest, exe)}`);
