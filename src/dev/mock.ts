/**
 * Browser-only stand-in for the Tauri bridge, enabled with `?mock` on the
 * Vite dev server (never bundled into the app). It lets the UI be developed
 * and screenshotted in a plain browser. Media files are served from a static
 * HTTP server rooted at the fake volume (see README, "Browser preview").
 */
import type { Library, MediaItem } from "../lib/types";

const ROOT = "/mock/testvol";
const FILES_BASE = "http://localhost:8787/";

interface Entry {
  rel: string;
  kind: MediaItem["kind"];
  files: string[];
}

// Mirrors the generated test volume.
const seed: Entry[] = [
  { rel: "DCIM/100CANON/CLIP_0001.mp4", kind: "video", files: ["DCIM/100CANON/CLIP_0001.mp4"] },
  { rel: "DCIM/100CANON/IMG_1000.jpg", kind: "image", files: ["DCIM/100CANON/IMG_1000.jpg"] },
  { rel: "DCIM/100CANON/IMG_1001.jpg", kind: "image", files: ["DCIM/100CANON/IMG_1001.CR2", "DCIM/100CANON/IMG_1001.jpg", "DCIM/100CANON/IMG_1001.xmp"] },
  ...[1002, 1003, 1004, 1005, 1006, 1007].map((n) => ({ rel: `DCIM/100CANON/IMG_${n}.png`, kind: "image" as const, files: [`DCIM/100CANON/IMG_${n}.png`] })),
  { rel: "DCIM/100CANON/IMG_2000.CR2", kind: "raw", files: ["DCIM/100CANON/IMG_2000.CR2"] },
  ...[1008, 1009, 1010, 1011].map((n) => ({ rel: `DCIM/101CANON/IMG_${n}.png`, kind: "image" as const, files: [`DCIM/101CANON/IMG_${n}.png`] })),
];

let library: Library = { version: 1, targets: [], ratings: {}, trashDir: "_deleted" };
let items: MediaItem[] = seed.map((e) => toItem(e.files.map((f) => `${ROOT}/${f}`), `${ROOT}/${e.rel}`, e.kind));
let pickCount = 0;
/** current path -> path the static server actually has (files never move in the mock). */
const origin = new Map<string, string>();
const served = (p: string) => origin.get(p) ?? p;

function toItem(files: string[], primary: string, kind: MediaItem["kind"]): MediaItem {
  const rel = primary.slice(ROOT.length + 1);
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  return {
    key: rel,
    primary,
    files,
    kind,
    name: rel.split("/").pop()!.replace(/\.[^.]+$/, ""),
    dir,
    size: 120_000 + rel.length * 1000,
    modified: Date.now() - rel.length * 3_600_000,
    hasRaw: files.some((f) => /\.cr2$/i.test(f)),
    hasVideo: files.some((f) => /\.(mp4|mov)$/i.test(f)),
  };
}

const resolve = (stored: string) => (stored.startsWith("/") ? stored : `${ROOT}/${stored}`.replace(/\/$/, ""));
const under = (p: string, dir: string) => p.startsWith(dir + "/");

function moveTo(item: MediaItem, destDir: string) {
  const moved: [string, string][] = item.files.map((f) => [f, `${destDir}/${f.split("/").pop()}`]);
  for (const [from, to] of moved) origin.set(to, served(from));
  const files = moved.map((m) => m[1]);
  const primary = moved.find((m) => m[0] === item.primary)![1];
  const next = toItem(files, primary, item.kind);
  items = items.map((i) => (i.key === item.key ? next : i));
  return { moved, item: next };
}

async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 30));
  switch (cmd) {
    case "initial_root":
      return ROOT;
    case "load_library":
      return library;
    case "save_library":
      library = args.library as Library;
      return null;
    case "scan_unsorted": {
      const lib = args.library as Library;
      const ex = [...lib.targets.map((t) => resolve(t.path)), resolve(lib.trashDir)];
      return items.filter((i) => !ex.some((d) => under(i.primary, d)));
    }
    case "scan_dir": {
      const d = resolve(args.dir as string);
      return items.filter((i) => under(i.primary, d));
    }
    case "scan_trash":
      return items.filter((i) => under(i.primary, resolve((args.library as Library).trashDir)));
    case "move_item":
      return moveTo(args.item as MediaItem, resolve(args.dest as string));
    case "trash_item":
      return moveTo(args.item as MediaItem, resolve((args.library as Library).trashDir));
    case "restore_files": {
      for (const [orig, cur] of args.moves as [string, string][]) {
        items = items.map((i) => {
          if (!i.files.includes(cur)) return i;
          const files = i.files.map((f) => (f === cur ? orig : f));
          return toItem(files, i.primary === cur ? orig : i.primary, i.kind);
        });
      }
      return null;
    }
    case "trash_info": {
      const t = items.filter((i) => under(i.primary, resolve(library.trashDir)));
      return { path: resolve(library.trashDir), files: t.length, bytes: t.reduce((a, i) => a + i.size, 0) };
    }
    case "empty_trash": {
      const d = resolve(library.trashDir);
      const n = items.filter((i) => under(i.primary, d)).length;
      items = items.filter((i) => !under(i.primary, d));
      return n;
    }
    case "raw_preview":
      return fetch(FILES_BASE + "DCIM/100CANON/IMG_1000.jpg").then((r) => r.arrayBuffer());
    case "path_exists":
      return true;
    case "create_dir":
      return null;
    case "resolve_path":
      return resolve(args.stored as string);
    case "plugin:dialog|open": {
      const names = ["Keep", "Portfolio", "Family", "Maybe"];
      return `${ROOT}/${names[pickCount++ % names.length]}`;
    }
    case "plugin:window|is_fullscreen":
      return false;
    case "plugin:window|set_fullscreen":
      return null;
    default:
      console.warn("[mock] unhandled command", cmd, args);
      return null;
  }
}

(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: () => 0,
  convertFileSrc: (p: string) => FILES_BASE + encodeURI(served(p).slice(ROOT.length + 1)),
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  plugins: {},
};
