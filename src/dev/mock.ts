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
  { rel: "Albums/Z%C3%BCrich%20Trip/IMG_1004.png", kind: "image", files: ["Albums/Z%C3%BCrich%20Trip/IMG_1004.png"] },
  // A deep archive tree (4 years x 12 months) to exercise the folder picker and virtualised grid.
  ...[2021, 2022, 2023, 2024].flatMap((y) =>
    Array.from({ length: 12 }, (_, m) => {
      const mm = String(m + 1).padStart(2, "0");
      return { rel: `Archive/${y}/${mm}/IMG_${y}${mm}.png`, kind: "image" as const, files: [`Archive/${y}/${mm}/IMG_${y}${mm}.png`] };
    }),
  ),
  { rel: "Albums/Caf%C3%A9%20Night/IMG_1006.png", kind: "image", files: ["Albums/Caf%C3%A9%20Night/IMG_1006.png"] },
];

let library: Library = { version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: ["Albums"], albumRatings: {}, autoDecodeAlbumNames: false, backupDest: null, lastBackup: null, ids: {} };
let items: MediaItem[] = seed.map((e) => toItem(e.files.map((f) => `${ROOT}/${f}`), `${ROOT}/${e.rel}`, e.kind));
let pickCount = 0;
let mockVault = { exists: false, unlocked: false, remembered: false };
let history: { version: number; viewed: Record<string, number> } | null = null;

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
  if (e.rel.startsWith("Archive/")) {
    origin.set(`${ROOT}/${e.rel}`, `${ROOT}/DCIM/100CANON/IMG_100${(e.rel.length % 6) + 2}.png`);
    continue;
  }
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
  const next = { ...toItem(files, primary, item.kind), vaultId: item.vaultId };
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
    case "album_rename_plan": {
      const lib = args.library as Library;
      const plan = [];
      for (const r of lib.albumRoots) {
        const dir = resolve(r);
        const names = [...new Set(items.filter((i) => under(i.primary, dir)).map((i) => i.primary.slice(dir.length + 1).split("/")[0]))];
        for (const n of names) {
          if (!/%[0-9a-f]{2}/i.test(n)) continue;
          let to = n;
          try {
            to = decodeURIComponent(n);
          } catch {
            continue;
          }
          plan.push({ from: `${dir}/${n}`, to: `${dir}/${to}`, fromKey: `${r}/${n}`, toKey: `${r}/${to}` });
        }
      }
      return plan;
    }
    case "album_rename_apply": {
      const plan = args.plan as { from: string; to: string }[];
      for (const r of plan) {
        items = items.map((i) => {
          if (!under(i.primary, r.from)) return i;
          const files = i.files.map((f) => r.to + f.slice(r.from.length));
          files.forEach((f, k) => origin.set(f, served(i.files[k])));
          return toItem(files, r.to + i.primary.slice(r.from.length), i.kind);
        });
      }
      return plan;
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
    case "backup_plan": {
      const files = items.flatMap((i) => i.files.map((f) => ({ rel: f.slice(ROOT.length + 1), size: 150_000, mtime: 1_700_000_000 })));
      const copy = files.slice(0, 4);
      const update = files.slice(4, 6);
      return { copy, update, moves: [["DCIM/100CANON/IMG_1000.jpg", "Keep/IMG_1000.jpg"]], extra: [{ rel: "old/leftover.jpg", size: 1000, mtime: 1 }], unchanged: files.length - 6, unchangedBytes: (files.length - 6) * 150_000, bytesToCopy: 6 * 150_000, sourceFiles: files.length, sourceBytes: files.length * 150_000 };
    }
    case "backup_run": {
      const ch = args.onProgress as { onmessage: (p: unknown) => void };
      const plan = args.plan as { copy: unknown[]; update: unknown[]; moves: unknown[]; bytesToCopy: number };
      const total = plan.copy.length + plan.update.length + plan.moves.length;
      for (let i = 0; i < total; i++) {
        await new Promise((r) => setTimeout(r, 120));
        ch.onmessage({ stage: "copying", doneFiles: i + 1, totalFiles: total, doneBytes: Math.round(((i + 1) / total) * plan.bytesToCopy), totalBytes: plan.bytesToCopy, current: `file ${i + 1}`, errors: 0 });
      }
      return { copied: plan.copy.length, updated: plan.update.length, moved: plan.moves.length, deleted: 0, bytes: plan.bytesToCopy, millis: total * 120, verified: plan.copy.length + plan.update.length, errors: [], cancelled: false };
    }
    case "cancel_backup":
      return null;
    case "vault_status":
      return { exists: mockVault.exists, unlocked: mockVault.unlocked, hasRecovery: mockVault.exists, plaintextFiles: mockVault.exists ? items.filter((i) => !i.vaultId).length : 0, plaintextBytes: 0, encryptedFiles: items.filter((i) => i.vaultId).length, quickMethod: "touchid", quickRemembered: mockVault.remembered };
    case "vault_create":
      mockVault = { exists: true, unlocked: true, remembered: false };
      return "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789";
    case "vault_unlock":
      if (args.passphrase !== "mock") throw new Error("wrong passphrase");
      mockVault.unlocked = true;
      return null;
    case "vault_unlock_recovery":
    case "vault_unlock_quick":
      mockVault.unlocked = true;
      return null;
    case "vault_remember":
      mockVault.remembered = true;
      return null;
    case "vault_forget":
      mockVault.remembered = false;
      return null;
    case "vault_lock":
      mockVault.unlocked = false;
      return null;
    case "vault_change_passphrase":
    case "vault_reset_passphrase":
      return null;
    case "vault_new_recovery_code":
      return "NEW0-CODE-NEW0-CODE-NEW0-CODE-NEW0-CODE";
    case "vault_encrypt_all": {
      const ch = args.onProgress as { onmessage: (p: unknown) => void };
      const plain = items.filter((i) => !i.vaultId);
      for (let i = 0; i < plain.length; i++) {
        await new Promise((r) => setTimeout(r, 60));
        ch.onmessage({ done: i, total: plain.length, bytes: i * 150_000, totalBytes: plain.length * 150_000, current: plain[i].name });
      }
      items = items.map((i) => ({ ...i, vaultId: i.vaultId ?? "mock-" + i.key }));
      return plain.length;
    }
    case "vault_export":
      return (args.paths as string[]).length;
    case "vault_remove": {
      items = items.map(({ vaultId: _v, ...rest }) => rest);
      mockVault = { exists: false, unlocked: false, remembered: false };
      return items.length;
    }
    case "edit_tools":
      return { ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe", version: "ffmpeg version 7.1.1", encoders: ["libx264", "libx265", "libvpx-vp9"] };
    case "edit_apply": {
      const ch = args.onProgress as { onmessage: (p: number) => void };
      const it = args.item as MediaItem;
      const op = args.op as { kind: string; degrees?: number; factor?: number; format?: string };
      for (let i = 1; i <= 5; i++) {
        await new Promise((r) => setTimeout(r, 60));
        ch.onmessage(i / 5);
      }
      const ext = op.kind === "convert" ? (op.format!.startsWith("mp4") ? "mp4" : op.format!.startsWith("webm") ? "webm" : op.format!) : it.primary.split(".").pop()!;
      const suffix = args.replace ? "" : op.kind === "rotate" ? ` rot${op.degrees}` : op.kind === "upscale" ? ` x${op.factor}` : "";
      const base = it.primary.replace(/\.[^.]+$/, "");
      const target = `${base}${suffix}.${ext}`;
      const trashed: [string, string][] = [];
      if (args.replace) {
        for (const f of it.files) trashed.push([f, `${ROOT}/_deleted/${f.split("/").pop()}`]);
        items = items.filter((i) => i.key !== it.key);
      }
      const ni = { ...toItem([target], target, it.kind), vaultId: it.vaultId ? "mock-" + target : undefined };
      items.push(ni);
      origin.set(target, served(it.primary));
      return { item: ni, trashed };
    }
    case "list_dir": {
      const dir = resolve(args.dir as string);
      const names = new Set<string>();
      const files: { name: string }[] = [];
      for (const i of items) {
        for (const f of i.files) {
          if (!under(f, dir)) continue;
          const rest = f.slice(dir.length + 1);
          if (rest.includes("/")) names.add(rest.split("/")[0]);
          else files.push({ name: rest, path: f, isDir: false, size: i.size, modified: i.modified, encrypted: !!i.vaultId, count: 0 } as { name: string });
        }
      }
      const dirs = [...names].sort().map((n) => ({ name: n, path: `${dir}/${n}`, isDir: true, size: 0, modified: 0, encrypted: false, count: items.filter((i) => under(i.primary, `${dir}/${n}`)).length }));
      return [...dirs, ...files.sort((a, b) => a.name.localeCompare(b.name))];
    }
    case "fs_mkdir":
      return `${resolve(args.dir as string)}/${args.name}`;
    case "fs_move": {
      const dest = resolve(args.dest as string);
      const out: string[] = [];
      for (const p of args.paths as string[]) {
        const it = items.find((i) => i.files.includes(p));
        if (!it) {
          const name = p.split("/").pop()!;
          items = items.map((i) => (under(i.primary, p) ? { ...toItem(i.files.map((f) => `${dest}/${name}/${f.slice(p.length + 1)}`), `${dest}/${name}/${i.primary.slice(p.length + 1)}`, i.kind), vaultId: i.vaultId } : i));
          out.push(`${dest}/${name}`);
        } else {
          out.push(moveTo(it, dest).item.primary);
        }
      }
      return out;
    }
    case "fs_rename": {
      const p = args.path as string;
      const target = `${p.slice(0, p.lastIndexOf("/"))}/${args.newName}`;
      items = items.map((i) => (i.primary === p ? { ...toItem(i.files.map((f) => (f === p ? target : f)), target, i.kind), vaultId: i.vaultId } : i));
      return target;
    }
    case "fs_delete":
      items = items.filter((i) => !(args.paths as string[]).some((p) => i.files.includes(p) || under(i.primary, p)));
      return (args.paths as string[]).length;
    case "fs_import": {
      const ch = args.onProgress as { onmessage: (p: unknown) => void };
      const srcs = args.sources as string[];
      for (let i = 0; i < srcs.length; i++) {
        await new Promise((r) => setTimeout(r, 80));
        ch.onmessage({ done: i, total: srcs.length, bytes: 0, totalBytes: 0, current: srcs[i].split("/").pop() });
      }
      const dest = resolve(args.dest as string);
      for (const s of srcs) {
        const rel = `${dest}/${s.split("/").pop()}`;
        items.push({ ...toItem([rel], rel, "image"), vaultId: mockVault.unlocked ? "mock-" + rel : undefined });
        origin.set(rel, `${ROOT}/DCIM/100CANON/IMG_1003.png`);
      }
      return srcs.length;
    }
    case "scan_all": {
      const lib = args.library as Library;
      const trash = resolve(lib.trashDir);
      const albumRoots = (args.includeAlbums as boolean) ? [] : lib.albumRoots.map(resolve);
      const albumKeyOf = (p: string) => {
        for (const r of lib.albumRoots) {
          const dir = resolve(r);
          if (under(p, dir)) return `${r}/${p.slice(dir.length + 1).split("/")[0]}`;
        }
        return undefined;
      };
      return items
        .filter((i) => !under(i.primary, trash) && !albumRoots.some((a) => under(i.primary, a)))
        .map((i) => (args.includeAlbums && albumKeyOf(i.primary) ? { ...i, albumKey: albumKeyOf(i.primary) } : i))
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
    case "load_history":
      return history;
    case "save_history":
      history = args.history as typeof history;
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
      if ((args.options as { title?: string } | undefined)?.title?.includes("backup")) return "/Volumes/BACKUP_2TB/CANON_64";
      return `${ROOT}/${names[pickCount++ % names.length]}`;
    }
    case "plugin:event|listen":
      return 1;
    case "plugin:event|unlisten":
      return null;
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
  unregisterListener: () => {},
  convertFileSrc: (p: string, protocol?: string) => {
    if (protocol === "vault") {
      const it = items.find((i) => i.vaultId === p);
      return it ? FILES_BASE + encodeURI(served(it.primary).slice(ROOT.length + 1)) : "";
    }
    return FILES_BASE + encodeURI(served(p).slice(ROOT.length + 1));
  },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  plugins: {},
};
