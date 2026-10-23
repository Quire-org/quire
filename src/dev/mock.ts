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
  { rel: "DCIM/101CANON/CLIP_0002.mp4", kind: "video", files: ["DCIM/101CANON/CLIP_0002.mp4"] },
  { rel: "DCIM/101CANON/CLIP_0003.mp4", kind: "video", files: ["DCIM/101CANON/CLIP_0003.mp4"] },
  { rel: "DCIM/100CANON/IMG_1000.jpg", kind: "image", files: ["DCIM/100CANON/IMG_1000.jpg"] },
  { rel: "DCIM/100CANON/IMG_1001.jpg", kind: "image", files: ["DCIM/100CANON/IMG_1001.CR2", "DCIM/100CANON/IMG_1001.jpg", "DCIM/100CANON/IMG_1001.xmp"] },
  ...[1002, 1003, 1004, 1005, 1006, 1007].map((n) => ({ rel: `DCIM/100CANON/IMG_${n}.png`, kind: "image" as const, files: [`DCIM/100CANON/IMG_${n}.png`] })),
  { rel: "DCIM/100CANON/IMG_2000.CR2", kind: "raw", files: ["DCIM/100CANON/IMG_2000.CR2"] },
  ...[1008, 1009, 1010, 1011, 1012].map((n) => ({ rel: `DCIM/101CANON/IMG_${n}.png`, kind: "image" as const, files: [`DCIM/101CANON/IMG_${n}.png`] })),
  // Album folders: served from the same files as the DCIM originals (see `origin`).
  { rel: "Albums/Iceland 2025/IMG_1003.png", kind: "image", files: ["Albums/Iceland 2025/IMG_1003.png"] },
  { rel: "Albums/Iceland 2025/IMG_1005.png", kind: "image", files: ["Albums/Iceland 2025/IMG_1005.png"] },
  { rel: "Albums/Iceland 2025/CLIP_0003.mp4", kind: "video", files: ["Albums/Iceland 2025/CLIP_0003.mp4"] },
  { rel: "Albums/Birthday/IMG_1012.png", kind: "image", files: ["Albums/Birthday/IMG_1012.png"] },
];

let library: Library = { version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: ["Albums"], albumRatings: {} };
let items: MediaItem[] = seed.map((e) => toItem(e.files.map((f) => `${ROOT}/${f}`), `${ROOT}/${e.rel}`, e.kind));
let pickCount = 0;

function fakeHash(text: string): bigint {
  const M = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (const ch of text) h = ((h ^ BigInt(ch.charCodeAt(0))) * 0x100000001b3n) & M;
  // splitmix64 finaliser so names differing in one character give unrelated bits
  h = ((h ^ (h >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  h = ((h ^ (h >> 27n)) * 0x94d049bb133111ebn) & M;
  return h ^ (h >> 31n);
}
/** current path -> path the static server actually has (files never move in the mock). */
const origin = new Map<string, string>();
const served = (p: string) => origin.get(p) ?? p;
for (const e of seed) {
  if (!e.rel.startsWith("Albums/")) continue;
  const base = e.rel.split("/").pop()!;
  const src = seed.find((o) => !o.rel.startsWith("Albums/") && o.rel.endsWith("/" + base));
  if (src) origin.set(`${ROOT}/${e.rel}`, `${ROOT}/${src.rel}`);
}

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
      const ex = [...lib.targets.map((t) => resolve(t.path)), resolve(lib.trashDir), ...lib.albumRoots.map(resolve)];
      return items.filter((i) => !ex.some((d) => under(i.primary, d)));
    }
    case "scan_albums": {
      const lib = args.library as Library;
      const out = [];
      for (const r of lib.albumRoots) {
        const dir = resolve(r);
        const names = [...new Set(items.filter((i) => under(i.primary, dir)).map((i) => i.primary.slice(dir.length + 1).split("/")[0]))].sort();
        for (const n of names) {
          const inside = items.filter((i) => under(i.primary, `${dir}/${n}`)).sort((a, b) => a.name.localeCompare(b.name));
          out.push({
            key: `${r}/${n}`,
            path: `${dir}/${n}`,
            name: n,
            albumRoot: r,
            count: inside.length,
            bytes: inside.reduce((a, i) => a + i.size, 0),
            images: inside.filter((i) => i.kind !== "video").length,
            videos: inside.filter((i) => i.kind === "video").length,
            modified: Math.max(0, ...inside.map((i) => i.modified)),
            cover: inside.find((i) => i.kind !== "video") ?? inside[0] ?? null,
          });
        }
      }
      return out;
    }
    case "move_dir": {
      const dir = args.dir as string;
      const dest = resolve(args.dest as string);
      const name = dir.split("/").pop()!;
      items = items.map((i) => {
        if (!under(i.primary, dir)) return i;
        const files = i.files.map((f) => `${dest}/${name}/${f.slice(dir.length + 1)}`);
        for (let k = 0; k < files.length; k++) origin.set(files[k], served(i.files[k]));
        return toItem(files, `${dest}/${name}/${i.primary.slice(dir.length + 1)}`, i.kind);
      });
      return `${dest}/${name}`;
    }
    case "drive_info":
      return {
        mountPoint: "/Volumes/CANON_64",
        device: "/dev/disk7",
        fileSystem: "exfat",
        totalBytes: 63_900_000_000,
        availableBytes: 21_000_000_000,
        removable: true,
        bus: "sd",
        model: "SD Card Reader",
        solidState: true,
        smartStatus: "Not Supported",
        smartctlAvailable: false,
        smart: null,
      };
    case "read_benchmark":
      await new Promise((r) => setTimeout(r, 600));
      return { bytes: 134_217_728, millis: 1480, mbPerS: 86.5, files: 9 };
    case "verify_readability": {
      const ch = args.onProgress as { onmessage: (p: unknown) => void };
      const total = items.length;
      for (let i = 0; i < total; i++) {
        await new Promise((r) => setTimeout(r, 40));
        ch.onmessage({ files: i + 1, totalFiles: total, bytes: (i + 1) * 150_000, totalBytes: total * 150_000, errors: 0, current: items[i].name });
      }
      return { files: total, bytes: total * 150_000, millis: total * 40, errors: [], cancelled: false };
    }
    case "cancel_verify":
      return null;
    case "scan_all": {
      const lib = args.library as Library;
      const trash = resolve(lib.trashDir);
      const albumRoots = (args.includeAlbums as boolean) ? [] : lib.albumRoots.map(resolve);
      return items
        .filter((i) => !under(i.primary, trash) && !albumRoots.some((a) => under(i.primary, a)))
        .map((i) => {
          const t = lib.targets.find((t) => under(i.primary, resolve(t.path)));
          return t ? { ...i, targetId: t.id } : i;
        });
    }
    case "image_hash": {
      await new Promise((r) => setTimeout(r, 350)); // pretend decoding takes a while
      // Deterministic fake hashes: IMG_1004/IMG_1006 near-identical, IMG_1000 pair shares content.
      const name = (args.path as string).split("/").pop()!.replace(/\.[^.]+$/, "");
      const base = name === "IMG_1006" ? fakeHash("IMG_1004") ^ 0x3n : fakeHash(name);
      return { phash: base.toString(16).padStart(16, "0"), dhash: fakeHash(name + "d").toString(16).padStart(16, "0"), width: 320, height: 200 };
    }
    case "file_fingerprint": {
      const name = (args.path as string).split("/").pop()!;
      const same = name === "IMG_1008.png" ? "IMG_1002.png" : name;
      return "fp-" + same;
    }
    case "load_cache":
      return null;
    case "save_cache":
      return null;
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
