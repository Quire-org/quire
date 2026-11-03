let mockTags: unknown = null;
/**
 * Browser-only stand-in for the Tauri bridge, enabled with `?mock` on the
 * Vite dev server (never bundled into the app). It lets the UI be developed
 * and screenshotted in a plain browser. Media files are served from a static
 * HTTP server rooted at the fake volume (see README, "Browser preview").
 */
import type { Library, MediaItem } from "../lib/types";
import { MOCK_WHO, mockPicture } from "./mockPictures.js";

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
// Folders made with nothing in them yet (the rest are known by the files in them).
const emptyDirs = new Set<string>();
let pickCount = 0;
let mockVault = { exists: false, unlocked: false, remembered: false };
// The local engine's models, as `quire-engine --models` lists them (plugins' own join them, `declareOwn`).
const mockModels: { id: string; kind: string; name: string; note: string; size: number | null; downloaded: boolean }[] = [
  { id: "base", kind: "base", name: "Text finder and clean-up", note: "Finds text and balloons in pictures, paints the original text out and letters new text in. Needed with every text reader and language model.", size: 767_871_972, downloaded: true },
  { id: "manga-ocr", kind: "reader", name: "Japanese", note: "Manga OCR, made for Japanese comics.", size: 463_060_870, downloaded: true },
  { id: "hayai-ocr", kind: "reader", name: "Korean, Chinese and others", note: "Hayai OCR, which reads Korean, Chinese, Japanese and English.", size: 623_750_379, downloaded: false },
  { id: "qwen3.5-4b", kind: "translator", name: "Qwen 3.5 4B", note: "The quickest. Runs well on most computers.", size: 3_584_533_344, downloaded: true },
  { id: "gemma4-e4b-it", kind: "translator", name: "Gemma 4 E4B", note: "Translates more naturally. Needs more memory.", size: 5_206_068_448, downloaded: false },
  { id: "gemma4-12b-it", kind: "translator", name: "Gemma 4 12B", note: "Translates best. Needs a strong GPU and plenty of memory.", size: 6_891_472_640, downloaded: false },
];
mockModels.push(
  { id: "siglip2", kind: "embedder", name: "Picture and word matcher", note: "SigLIP 2 (base, 256 px, half precision).", size: 785_356_990, downloaded: true },
  { id: "pixai", kind: "tagger", name: "Anime tagger", note: "PixAI Tagger v0.9.", size: 1_271_962_722, downloaded: true },
  { id: "faces", kind: "faces", name: "Face finder", note: "SCRFD and AuraFace.", size: 277_617_978, downloaded: true },
  { id: "characters", kind: "faces", name: "Character finder", note: "deepghs' anime face detector and CCIP.", size: 428_174_645, downloaded: true },
);
let mockChosen = "qwen3.5-4b";
let mockCancel = false;
let history: { version: number; viewed: Record<string, number> } | null = null;

/* Plugins: the static server serves a plugin folder beside this repository under __plugin/<id>/. */
interface MockPlugin {
  id: string;
  manifest: Record<string, unknown>;
  state: { enabled: boolean; allowVault: boolean; granted: string[]; source: string; linked: string | null; github: Record<string, unknown> | null; commit: string | null; installedAt: number };
  storage: Record<string, unknown>;
  settings: Record<string, unknown>;
}
const mockPlugins = new Map<string, MockPlugin>();
/** The installed plugins' own models (`ownModels` in their manifests) join the catalogue, as the engine declares them. */
function declareOwn() {
  for (const p of mockPlugins.values()) {
    for (const m of (p.manifest.ownModels ?? []) as { id: string; name: string; note?: string; files?: { size?: number }[] }[]) {
      if (mockModels.some((x) => x.id === m.id)) continue;
      mockModels.push({ id: m.id, kind: "plugin", name: m.name, note: m.note ?? "", size: (m.files ?? []).reduce((n, f) => n + (f.size ?? 0), 0), downloaded: false });
    }
  }
}
/** People in the mock: the faces of the made-up pictures (mockPictures.js), by face id. */
let mockPeople: unknown = null;
const mockFaceLabel = new Map<number, string>();

/** A made-up still's fingerprint (as the duplicate check makes one), the same every time; `off`, `doff`: bits changed, as a picture with a part painted again. */
function mockSig(it: { key: string; primary: string }, off = 0, doff = 0) {
  let h = 2166136261;
  for (const c of it.key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  const flip = (x: string, n: number) => (BigInt("0x" + x) ^ ((1n << BigInt(n)) - 1n)).toString(16).padStart(16, "0");
  const phash = flip(hex(h) + hex(Math.imul(h, 2654435761)), off);
  const pic = it.primary ? mockPicture(served(it.primary).slice(ROOT.length + 1)) : { width: 1200, height: 1700 };
  return { phash, quads: [phash, phash, phash, phash], dhash: flip("0f0f0f0f0f0f0f0f", doff), width: pic.width, height: pic.height };
}

/** A face in each made-up still (who is in it, from mockPictures), the same every time. */
function mockFaces() {
  const stills = items.filter((i) => i.kind !== "video");
  const faces = stills.map((it, n) => {
    const pic = mockPicture(served(it.primary).slice(ROOT.length + 1));
    mockFaceLabel.set(n + 1, pic.who.label);
    return { id: n + 1, key: it.key, kind: pic.who.kind, bbox: pic.bbox, score: pic.score, size: pic.size };
  });
  return { faces: [...faces, ...mockMarked], scanned: Object.fromEntries(stills.map((i) => [i.key, [i.size, i.modified]])), noCharacters: [] };
}
/** Faces marked by hand in the mock: the part marked is the face. */
const mockMarked: { id: number; key: string; kind: "photo" | "drawn"; bbox: [number, number, number, number]; score: number; size: number; marked: true }[] = [];
/** `?mock&e2e`: a library with tags, people and an artist already, for the end-to-end tests. */
const E2E = new URLSearchParams(location.search).has("e2e");
/** The Home's board kept with the library, in the mock: for the end-to-end tests, a library that opens on Sort (as their scenes start there), its board still to make. */
let mockHome: unknown = E2E ? { version: 1, blocks: [], folders: { mode: "all", list: [] }, opensOn: "sort" } : null;
/** The library's artists, and files kept with the library (artists' icons), in the mock. */
let mockArtists: unknown = null;
const mockBlobs = new Map<string, ArrayBuffer>();
/** Find's state kept with the library (the basket), in the mock. */
let mockFindState: unknown = null;
/** What plugins keep with the library, in the mock: `id:key` → value. */
const mockLibraryStore: Record<string, unknown> = {};
const pluginIdOf = (source: string) => source.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, "");
async function mockManifest(source: string) {
  const id = pluginIdOf(source);
  const r = await fetch(`${FILES_BASE}__plugin/${id}/plugin.json`);
  if (!r.ok) throw `no plugin.json in ${source}`;
  return r.json() as Promise<Record<string, unknown>>;
}

/**
 * `?mock&find=<id>`: the Find plugin in the folder of that name beside this repository, installed,
 * against the made-up site it brings for this (its `test/fake-site.js`): its answers to the
 * plugin's requests, its pictures, where its sign-in ends, and a work and an artist on it.
 */
interface FakeSite {
  platform: string;
  fetch: (url: string, body: string | null) => { status: number; headers: Record<string, string>; body: string; bodyBase64: null } | null;
  image: (url: string) => Promise<ArrayBuffer>;
  signIn: (url: string) => string;
  examples: { work: { id: string; url: string }; artist: { id: string; account: string; url: string } };
}
const FIND_PLUGIN = new URLSearchParams(location.search).get("find") || null;
/** `?mock&update`: the app finds a made-up newer version of itself, to see Settings › Updates with one. */
const UPDATE = new URLSearchParams(location.search).has("update");
const fakeSite: Promise<FakeSite | null> = FIND_PLUGIN ? import(/* @vite-ignore */ `${FILES_BASE}__plugin/${FIND_PLUGIN}/test/fake-site.js`).catch(() => null) : Promise.resolve(null);
/** Where the mock's library says its works came from without a Find plugin: a platform no plugin has. */
const NO_SITE = { platform: "example", examples: { work: { id: "1000", url: "https://example.org/works/1000" }, artist: { id: "100", account: "kazestudio", url: "https://example.org/users/100" } } };

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
    // The end-to-end tests' file server draws any path, so there each is a picture of its own.
    if (!E2E) origin.set(`${ROOT}/${e.rel}`, `${ROOT}/DCIM/100CANON/IMG_100${(e.rel.length % 6) + 2}.png`);
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
    case "set_app_icon":
      return null;
    case "initial_root":
      return ROOT;
    case "library_claim":
    case "library_release":
      return null;
    case "library_adopt_names":
      return { renamed: 0, kept: [] };
    case "vault_unsharded":
      return false;
    case "vault_adopt":
      return { documents: [], restored: [], aside: [], pictures: 0 };
    case "vault_shard":
      return 0;
    case "app_build":
      return { version: "0.1.0", cannot: UPDATE ? null : "This is the browser preview: updates come with the released app." };
    case "app_update_check":
      return UPDATE ? { version: "0.2.0", notes: "Made-up notes for the preview:\n- one thing better\n- another thing fixed", date: Date.now() - 2 * 86_400_000, downloaded: false } : null;
    case "app_update_download": {
      const ch = args.onProgress as { onmessage: (p: unknown) => void };
      const total = 120_000_000;
      for (let done = 0; done < total; done += 12_000_000) {
        await new Promise((r) => setTimeout(r, 100));
        ch.onmessage({ done: done + 12_000_000, total });
      }
      return null;
    }
    case "app_update_install":
      console.info("[mock] the update would go in place and the app restart now");
      return null;
    case "dev_passphrase":
      return null;
    case "load_library":
      // For the end-to-end tests: one picture known to be the first work of Find's feed (as if
      // imported from it), so "Do I have this?" finds it.
      if (E2E && !library.sources) {
        const it = items.filter((i) => i.kind === "image" && !i.albumKey)[5];
        const site = (await fakeSite) ?? NO_SITE;
        const work = site.examples.work;
        if (it) library = { ...library, sources: { [it.key]: { platform: site.platform, id: work.id, url: work.url, title: "Made up", author: { id: "0", name: "Someone" }, tags: [], date: null, adult: false, added: 1 } } };
      }
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
        vendor: null,
        serial: null,
        firmware: null,
        usbVersion: null,
        linkGbps: null,
        vendorApps: [],
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
    case "drive_open_app":
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
      return { exists: mockVault.exists, unlocked: mockVault.unlocked, hasRecovery: mockVault.exists, plaintextFiles: mockVault.exists ? items.filter((i) => !i.vaultId).length : 0, plaintextBytes: 0, encryptedFiles: items.filter((i) => i.vaultId).length, quickMethod: "touchid", quickRemembered: mockVault.remembered, format: "apfs" };
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
      const op = args.op as { rotate: number; flipH: boolean; crop: unknown; upscale: number | null; resizeWidth: number | null; format: string | null; extractFrame: number | null };
      for (let i = 1; i <= 5; i++) {
        await new Promise((r) => setTimeout(r, 60));
        ch.onmessage(i / 5);
      }
      const fmt = op.format ?? (op.extractFrame != null ? "jpg" : null);
      const ext = fmt ? (fmt.startsWith("mp4") ? "mp4" : fmt.startsWith("webm") ? "webm" : fmt) : it.primary.split(".").pop()!;
      const parts = [op.rotate ? `rot${op.rotate}` : "", op.flipH ? "flip" : "", op.crop ? "crop" : "", op.upscale ? `x${op.upscale}` : op.resizeWidth ? `${op.resizeWidth}w` : ""].filter(Boolean);
      const suffix = args.replace || !parts.length ? "" : " " + parts.join(" ");
      const base = it.primary.replace(/\.[^.]+$/, "");
      const target = `${base}${suffix}.${ext}`;
      const trashed: [string, string][] = [];
      if (args.replace) {
        for (const f of it.files) trashed.push([f, `${ROOT}/_deleted/${f.split("/").pop()}`]);
        items = items.filter((i) => i.key !== it.key);
      }
      const ni = { ...toItem([target], target, op.extractFrame != null ? "image" : it.kind), vaultId: it.vaultId ? "mock-" + target : undefined };
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
          else files.push({ name: rest, path: f, isDir: false, size: i.size, modified: i.modified, encrypted: !!i.vaultId, vaultId: i.vaultId ?? null, count: 0 } as { name: string });
        }
      }
      for (const d of emptyDirs) if (under(d, dir)) names.add(d.slice(dir.length + 1).split("/")[0]);
      const dirs = [...names].sort().map((n) => ({ name: n, path: `${dir}/${n}`, isDir: true, size: 0, modified: 0, encrypted: false, count: items.filter((i) => under(i.primary, `${dir}/${n}`)).length }));
      return [...dirs, ...files.sort((a, b) => a.name.localeCompare(b.name))];
    }
    case "hardware":
      // A made-up Mac: an M2 with 16 GB (the preview's own machine isn't asked).
      return { memory: 16 * 1024 ** 3, chip: "Apple M2", os: "macos", arch: "aarch64", unified: true };
    case "fs_mkdir": {
      const made = `${resolve(args.dir as string)}/${args.name}`;
      emptyDirs.add(made);
      return made;
    }
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
          // The deepest target holding it, as the scan finds it.
          const t = lib.targets.filter((t) => under(i.primary, resolve(t.path))).sort((a, b) => resolve(b.path).length - resolve(a.path).length)[0];
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
    case "media_info":
      return { width: 4000, height: 3000, format: "JPEG", exif: { dateTaken: "2024-05-04 12:33:10", make: "Canon", model: "EOS R6", lens: "RF 35mm F1.8", exposure: "1/250 s", fNumber: "f/2.8", iso: "200", focal: "35 mm", software: null, gps: null, orientation: null } };
    case "load_tags":
      if (E2E && !mockTags) {
        // Tags on a third of the pictures, one with a very long name (to be cut short wherever it shows).
        const tags: Record<string, string[]> = {};
        items.forEach((it, i) => {
          if (i % 3 === 0) tags[it.key] = ["motives/sea", "places/lisbon", "motives/a very long tag name that goes on and on past any tile"];
          else if (i % 3 === 1) tags[it.key] = ["motives/cat"];
        });
        // A person's tag, to make a person of (From tags…): on their pictures, and on one whose only
        // face is someone else's (they were turned away), as happens.
        const whoIn = (it: MediaItem) => mockPicture(served(it.primary).slice(ROOT.length + 1)).who.label;
        const theirs = items.filter((it) => it.kind !== "video" && whoIn(it) === "p2");
        const other = items.find((it) => it.kind !== "video" && whoIn(it) === "p5");
        for (const it of [...theirs, ...(other ? [other] : [])]) tags[it.key] = [...(tags[it.key] ?? []), "people/kai_ito"];
        // A "pick one" folder with a name of some length, whose head has a badge and counts to fit.
        items.forEach((it, i) => {
          if (i % 4 === 0) tags[it.key] = [...(tags[it.key] ?? []), i % 8 ? "status/finished" : "status/work in progress"];
        });
        mockTags = { version: 1, types: ["motives", "places", "people", "status"], exclusive: ["status"], tags, auto: {}, indexed: {}, autoMap: {}, albums: {} };
      }
      return mockTags;
    case "save_tags":
      mockTags = args.data as unknown;
      return null;
    case "tags_tag_names":
      return [{ name: "general", category: 9 }, { name: "1girl", category: 0 }, { name: "cat", category: 0 }, { name: "smile", category: 0 }];
    case "tags_embed_text":
      return Array.from({ length: 512 }, (_, i) => Math.sin(i + (args.text as string).length) / 16);
    case "tags_cancel":
    case "tags_pause":
      return null;
    // The tag index in the browser: nothing learned (suggestions come from the tagger's words).
    case "tags_index_load":
      return { auto: {}, indexed: {}, embedded: 0, embedder: "siglip2", tagger: "pixai" };
    case "tags_candidates": {
      // Everything not skipped, more or less likely (by name): suggestions to say yes or no to.
      const skip = new Set(args.skip as string[]);
      return items.filter((i) => i.kind !== "video" && !skip.has(i.key)).map((i) => ({ key: i.key, p: 0.3 + ([...i.key].reduce((a, c) => a + c.charCodeAt(0), 0) % 65) / 100, examples: true })).filter((c) => c.p >= (args.min as number));
    }
    case "tags_rank": {
      // How pictures look, made up: the same person or character very alike, the same kind (photo,
      // drawing) somewhat, the rest not.
      const r = args as unknown as { queries: { keys?: string[] }[]; candidates: string[] | null; skip: string[]; min: number; limit: number };
      const look = (key: string) => {
        const it = items.find((i) => i.key === key);
        return it ? mockPicture(served(it.primary).slice(ROOT.length + 1)).who : null;
      };
      const qs = r.queries.flatMap((q) => q.keys ?? []).map((k) => [k, look(k)] as const).filter((q) => q[1]);
      const skip = new Set(r.skip);
      const pool = r.candidates ?? items.filter((i) => i.kind !== "video").map((i) => i.key);
      const wobble = (k: string) => ([...k].reduce((a, c) => a + c.charCodeAt(0), 0) % 10) / 100;
      return pool
        .filter((k) => !skip.has(k))
        .map((k) => {
          const w = look(k);
          const best = Math.max(...qs.map(([, q]) => (!w || !q ? 0 : q.label === w.label ? 0.85 : q.kind === w.kind ? 0.55 : 0.25)));
          return [k, Math.round((best + wobble(k)) * 1000) / 1000] as [string, number];
        })
        .filter(([, sc]) => sc >= r.min)
        .sort((a, b) => b[1] - a[1])
        .slice(0, r.limit);
    }
    case "tags_predict":
    case "tags_search":
      return [];
    case "tags_index": {
      const progress = args.onProgress as { onmessage: (p: unknown) => void };
      const item = args.onItem as { onmessage: (r: unknown) => void };
      const list = args.items as MediaItem[];
      for (let i = 0; i < list.length; i++) {
        await new Promise((r) => setTimeout(r, 30));
        progress.onmessage({ done: i, total: list.length, current: list[i].name });
        item.onmessage({ key: list[i].key, embedding: Array.from({ length: 512 }, (_, k) => Math.sin(k * (i + 1)) / 16), tags: [[1, 0.9], [2, 0.6], [3, 0.4]], error: null });
      }
      progress.onmessage({ done: list.length, total: list.length, current: "" });
      return list.length;
    }
    case "load_cache":
      // For the end-to-end tests: every still fingerprinted (as the duplicate check would have).
      return E2E ? { version: 1, sigs: Object.fromEntries(items.filter((i) => i.kind !== "video").map((i) => [i.key, { size: i.size, modified: i.modified, image: mockSig(i) }])) } : null;
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
    case "plugin_list":
      // `?mock&find=<id>`: that Find plugin (served beside the media under __plugin/), installed.
      if (FIND_PLUGIN && !mockPlugins.has(FIND_PLUGIN)) {
        const manifest = await mockManifest(FIND_PLUGIN).catch(() => null);
        if (manifest) mockPlugins.set(FIND_PLUGIN, { id: FIND_PLUGIN, manifest, state: { enabled: true, allowVault: false, granted: manifest.permissions as string[], source: `../${FIND_PLUGIN}`, linked: `../${FIND_PLUGIN}`, github: null, commit: null, installedAt: Date.now() }, storage: {}, settings: {} });
      }
      // As the backend reads a manifest: what it leaves out, empty.
      return [...mockPlugins.values()].map((p) => ({ id: p.id, manifest: { permissions: [], settings: [], models: [], ...(p.manifest as object) }, state: p.state, dir: p.state.linked ?? `/mock/app-data/plugins/installed/${p.id}`, error: null }));
    case "plugin_inspect": {
      const source = String(args.source);
      const github = source.includes("github.com");
      return { manifest: await mockManifest(source), kind: github ? "github" : "local", location: source };
    }
    case "plugin_install": {
      const source = String(args.source);
      const manifest = await mockManifest(source);
      const github = source.includes("github.com");
      const perms = manifest.permissions as string[];
      mockPlugins.set(manifest.id as string, {
        id: manifest.id as string,
        manifest,
        state: { enabled: true, allowVault: false, granted: (args.granted as string[]).filter((g) => perms.includes(g)), source, linked: github ? null : source, github: github ? { owner: "you", repo: pluginIdOf(source) } : null, commit: github ? "3f9c2ab71e0d4c5b8a6f1e2d3c4b5a6978877665" : null, installedAt: Date.now() },
        storage: {},
        settings: {},
      });
      return manifest;
    }
    case "plugin_set_state": {
      const p = mockPlugins.get(String(args.id));
      if (!p) throw "plugin is not installed";
      if (args.enabled != null) p.state.enabled = args.enabled as boolean;
      if (args.allowVault != null) p.state.allowVault = args.allowVault as boolean;
      if (args.granted != null) p.state.granted = args.granted as string[];
      return p.state;
    }
    case "plugin_uninstall":
      mockPlugins.delete(String(args.id));
      return null;
    case "plugin_check_updates":
      return [...mockPlugins.values()].map((p) =>
        p.state.github
          ? { id: p.id, update: { id: p.id, current: p.manifest.version, latest: "1.1.0", newPermissions: [], manifest: { ...p.manifest, version: "1.1.0" }, commit: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b" }, error: null }
          : { id: p.id, update: null, error: null },
      );
    case "plugin_update": {
      const p = mockPlugins.get(String(args.id))!;
      p.manifest = { ...p.manifest, version: "1.1.0" };
      p.state.commit = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";
      return p.manifest;
    }
    case "plugin_storage_get":
      return { ...(mockPlugins.get(String(args.id))?.storage ?? {}) };
    case "plugin_storage_set": {
      const st = mockPlugins.get(String(args.id))!.storage;
      if (args.value == null) delete st[String(args.key)];
      else st[String(args.key)] = args.value;
      return null;
    }
    case "plugin_settings_get":
      return { ...(mockPlugins.get(String(args.id))?.settings ?? {}) };
    case "plugin_settings_set":
      mockPlugins.get(String(args.id))!.settings = args.values as Record<string, unknown>;
      return null;
    case "plugin_fetch": {
      const req = args.request as { url: string; body: string | null };
      const answer = (await fakeSite)?.fetch(req.url, req.body);
      if (answer) return answer;
      throw "mock: no network";
    }
    case "plugin_library_get":
      return mockLibraryStore[`${args.id}:${args.key}`] ?? null;
    case "plugin_library_set":
      if (args.value == null) delete mockLibraryStore[`${args.id}:${args.key}`];
      else mockLibraryStore[`${args.id}:${args.key}`] = args.value;
      return null;
    case "plugin_login":
      // The made-up reader signs in after a moment.
      await new Promise((r) => setTimeout(r, 1200));
      {
        const url = (await fakeSite)?.signIn(String(args.url)) ?? null;
        // A website sign-in for each address whose cookies were asked for.
        return url && { url, cookies: Object.fromEntries(((args.cookies as string[]) ?? []).map((c) => [c, "session=made-up"])) };
      }
    case "plugin_login_close":
      return null;
    case "find_image": {
      const site = await fakeSite;
      if (!site) throw "mock: no network";
      return site.image(String(args.url));
    }
    case "find_clear":
      return null;
    case "faces_load":
      return mockFaces();
    case "faces_sort": {
      // Who is in the made-up pictures stands in for the face finder's numbers. The first group has
      // someone else in it, less like the rest (a wrong one to find), and found faces vary in how sure.
      const l = args.labels as { assigned: [number, string, boolean][]; no: number[]; not: [number, string][] };
      // A face given someone, not checked, of another person than most of theirs: a doubt, and it
      // doesn't stand for them (as the backend does with the faces' numbers).
      const labelsOf = new Map<string, string[]>();
      for (const [f, p] of l.assigned) labelsOf.set(p, [...(labelsOf.get(p) ?? []), mockFaceLabel.get(f)!]);
      const mostOf = (p: string) => {
        const n = new Map<string, number>();
        for (const x of labelsOf.get(p) ?? []) n.set(x, (n.get(x) ?? 0) + 1);
        return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
      };
      const doubts = l.assigned.filter(([f, p, ok]) => !ok && (labelsOf.get(p)?.length ?? 0) >= 3 && mockFaceLabel.get(f) !== mostOf(p)).map(([f, p]) => ({ face: f, person: p, score: 0.12 }));
      const doubted = new Set(doubts.map((d) => d.face));
      const personOf = new Map(l.assigned.filter(([f]) => !doubted.has(f)).map(([f, p]) => [mockFaceLabel.get(f)!, p]));
      const taken = new Set([...l.assigned.map(([f]) => f), ...l.no]);
      const nots = new Set(l.not.map(([f, p]) => `${f}:${p}`));
      const matches: { face: number; person: string; score: number }[] = [];
      const groups = new Map<string, number[]>();
      for (const [id, label] of mockFaceLabel) {
        if (taken.has(id)) continue;
        const p = personOf.get(label);
        if (p && !nots.has(`${id}:${p}`)) matches.push({ face: id, person: p, score: 0.4 + ((id * 37) % 40) / 100 });
        else if (!p) groups.set(label, [...(groups.get(label) ?? []), id]);
      }
      const kindOf = (label: string) => MOCK_WHO.find((w) => w.label === label)?.kind ?? "photo";
      const sorted = [...groups.entries()].filter(([, f]) => f.length >= 2).sort((a, b) => b[1].length - a[1].length);
      const out = sorted.map(([label, faces]) => ({ kind: kindOf(label), faces: [...faces], scores: faces.map((f) => 0.8 + ((f * 13) % 18) / 100) }));
      const intruder = out[0] && sorted.slice(1).find(([label]) => kindOf(label) === out[0].kind)?.[1][0];
      if (out[0] && intruder) (out[0].faces.push(intruder), out[0].scores.push(0.31), out[1].faces.splice(out[1].faces.indexOf(intruder), 1), out[1].scores.pop());
      return { matches, doubts, groups: out.filter((g) => g.faces.length >= 2) };
    }
    case "faces_scan":
      return 0;
    case "faces_mark": {
      const area = args.area as [number, number, number, number];
      const face = { id: 100_000 + mockMarked.length, key: String(args.key), kind: args.kind === "drawn" ? ("drawn" as const) : ("photo" as const), bbox: area, score: 1, size: Math.round((area[2] - area[0]) * 1000), marked: true as const };
      mockMarked.push(face);
      return [face];
    }
    case "faces_rename":
    case "faces_forget":
      return null;
    case "home_load":
      return mockHome;
    case "home_save":
      mockHome = args.data;
      return null;
    case "people_load":
      if (E2E && !mockPeople) {
        if (!mockFaceLabel.size) mockFaces();
        // Lena: three faces given her and one of someone else's, as a tag would (the rest of hers are
        // found by themselves, some less sure; the other one is a doubt).
        const hers = [...[...mockFaceLabel].filter(([, l]) => l === "p0").slice(0, 8), ...[...mockFaceLabel].filter(([, l]) => l === "p3").slice(0, 1)].map(([id]) => id);
        mockPeople = { version: 1, people: { pelena: { id: "pelena", name: "Lena Marie Johansson-Fairweather", kind: "person", from: null, portrait: null, added: 1 } }, faces: Object.fromEntries(hers.map((f) => [String(f), { p: "pelena" }])), no: [], not: {}, exclude: [], converted: null };
      }
      return mockPeople;
    case "people_save":
      mockPeople = args.data;
      return null;
    case "artists_load":
      if (E2E && !mockArtists) {
        const key = items.find((i) => i.kind !== "video")?.key;
        const site = (await fakeSite) ?? NO_SITE;
        const { id, account, url } = site.examples.artist;
        mockArtists = { version: 1, artists: { arkaze: { id: "arkaze", name: "Kaze Studio of the Very Long Name Indeed", renamed: false, links: [{ platform: site.platform, id, account, url }], avatar: null, avatarAt: 0, bio: "Made up for the tests: draws hills, suns and the light between them.\nCommissions closed.", region: "Made-up Land", pages: [{ label: "Website", url: "https://example.org" }], fetched: 1, added: 1 } }, items: key ? { [key]: ["arkaze"] } : {}, dismissed: [] };
      }
      return mockArtists;
    case "artists_save":
      mockArtists = args.data;
      return null;
    case "artist_avatar_save":
      const site = await fakeSite;
      if (!site) throw "mock: no network";
      mockBlobs.set(String(args.name), await site.image(String(args.url)));
      return null;
    case "scrapbook_blob": {
      const b = mockBlobs.get(String(args.name));
      if (!b) throw `${args.name} is gone`;
      return b;
    }
    case "scrapbook_blob_delete":
      mockBlobs.delete(String(args.name));
      return null;
    case "find_state_load":
      return mockFindState;
    case "find_state_save":
      mockFindState = args.data;
      return null;
    case "find_image_hash": {
      // Two of Kaze's works (user 100) are pictures of the library: one as it is, one with a part
      // painted again; the rest are like nothing here.
      const work = Number(new URL(String(args.url)).pathname.split("/").pop()?.replace(/\D/g, "") || 0);
      const stills = items.filter((i) => i.kind === "image" && !i.albumKey);
      if (E2E && work === 97703 && stills[2]) return mockSig(stills[2]);
      if (E2E && work === 97707 && stills[9]) return mockSig(stills[9], 8, 7);
      if (E2E && work >= 97700 && work < 97800) return { ...mockSig({ key: `w${work}`, primary: "" }), width: 1201, height: 1700 };
      return { phash: "a5a5a5a5a5a5a5a5", quads: ["a5a5a5a5a5a5a5a5", "5a5a5a5a5a5a5a5a", "a5a5a5a5a5a5a5a5", "5a5a5a5a5a5a5a5a"], dhash: "0f0f0f0f0f0f0f0f", width: 540, height: 540 };
    }
    case "find_download": {
      // Each pick's files "downloaded" to the cache (paths only: Import below doesn't read them).
      const works = args.works as { key: string; files: { name: string }[]; animation?: { name: string } }[];
      await new Promise((r) => setTimeout(r, 600));
      return works.map((w, n) => ({ key: w.key, files: (w.animation ? [w.animation.name] : w.files.map((f) => f.name)).map((name) => `/mock/cache/find/${n}/${name}`), error: null }));
    }
    case "import_scan":
      return (args.sources as string[]).map((path, i) => ({ path, size: 2_000_000 + i * 1000, inside: path.startsWith(ROOT + "/") }));
    case "import_fingerprints":
      return (args.paths as string[]).map(() => null);
    case "import_files":
      // In the library from now on (shown with one of the volume's pictures).
      return (args.items as { src: string; dest: string }[]).map((it) => {
        const to = `${resolve(it.dest)}/${it.src.split("/").pop()}`;
        origin.set(to, `${ROOT}/DCIM/100CANON/IMG_1003.png`);
        items.push(toItem([to], to, /\.mp4$/i.test(to) ? "video" : "image"));
        return to;
      });
    case "plugin_log":
      console.log(`[plugin ${args.id}] ${args.level}: ${args.message}`);
      return null;
    case "read_media_image":
      return fetch(FILES_BASE + encodeURI(served(String(args.path)).slice(ROOT.length + 1))).then((r) => r.arrayBuffer());
    case "write_media_file":
      return `${args.dir}/${args.name}`;
    case "replace_media_file": {
      const it = args.item as MediaItem;
      const target = `${it.primary.slice(0, it.primary.lastIndexOf("/") + 1)}${args.name as string}`;
      const trashed: [string, string][] = it.files.map((f) => [f, `${ROOT}/_deleted/${f.split("/").pop()}`]);
      items = items.filter((i) => i.key !== it.key);
      const ni = toItem([target], target, "image");
      items.push(ni);
      origin.set(target, served(it.primary));
      return { item: ni, trashed };
    }
    case "versions_load":
      return { links: {} };
    case "version_info":
      return { fp: null, link: null, kept: null, original: null, versions: [] };
    case "kept_originals":
      return { originals: 0, bytes: 0 };
    case "raw_preview":
      return fetch(FILES_BASE + "DCIM/100CANON/IMG_1000.jpg").then((r) => r.arrayBuffer());
    case "plugin:dialog|open": {
      const names = ["Keep", "Portfolio", "Family", "Maybe"];
      if ((args.options as { title?: string } | undefined)?.title?.includes("backup")) return "/Volumes/BACKUP_2TB/CANON_64";
      return `${ROOT}/${names[pickCount++ % names.length]}`;
    }
    case "engine_models":
      declareOwn();
      return {
        available: true,
        models: mockModels,
        used: mockModels.filter((m) => m.downloaded).reduce((n, m) => n + (m.size ?? 0), 0),
        chosen: mockChosen,
        downloading: false,
      };
    case "engine_choose":
      mockChosen = String(args.llm);
      return null;
    case "engine_download": {
      // A few seconds of progress, then the model (and the shared parts) are there.
      declareOwn();
      const ch = args.onProgress as { onmessage: (p: unknown) => void };
      const ids = mockModels.find((m) => m.id === args.id)?.kind === "plugin" ? [String(args.id)] : ["base", String(args.id)];
      const total = mockModels.filter((m) => ids.includes(m.id) && !m.downloaded).reduce((n, m) => n + (m.size ?? 0), 0);
      mockCancel = false;
      for (let i = 1; i <= 20; i++) {
        await new Promise((r) => setTimeout(r, 150));
        if (mockCancel) throw "cancelled";
        ch.onmessage({ completed: Math.round((total * i) / 20), total, name: "model.safetensors" });
      }
      for (const m of mockModels) if (ids.includes(m.id)) m.downloaded = true;
      return null;
    }
    case "engine_cancel_download":
      mockCancel = true;
      return null;
    case "engine_remove":
      for (const m of mockModels) if (args.id === "all" || m.id === args.id) m.downloaded = false;
      return null;
    case "plugin_engine_run": {
      // The page with a grey box drawn on it, as a plugin's pipeline might give back, or the refusal the
      // real engine gives while a model the plugin names isn't downloaded.
      declareOwn();
      const named = (mockPlugins.get(String(args.id))?.manifest.models ?? []) as string[];
      const missing = mockModels.find((m) => named.includes(m.id) && !m.downloaded);
      if (missing) throw `not downloaded: ${missing.id}`;
      const res = await fetch(FILES_BASE + encodeURI(served(String(args.path)).slice(ROOT.length + 1)));
      const bmp = await createImageBitmap(await res.blob());
      const W = bmp.width, H = bmp.height;
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      ctx.fillStyle = "#c8c8c8";
      ctx.fillRect(W * 0.4, H * 0.45, W * 0.2, H * 0.05);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await new Promise((r) => setTimeout(r, 400));
      return { pngBase64: btoa(bin), width: W, height: H, result: {}, seconds: 0.4 };
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

(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
};
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke,
  transformCallback: () => 0,
  unregisterListener: () => {},
  convertFileSrc: (p: string, protocol?: string) => {
    if (protocol === "msplugin") return `${FILES_BASE}__plugin/${p}`;
    if (protocol === "vault") {
      const it = items.find((i) => i.vaultId === p);
      return it ? FILES_BASE + encodeURI(served(it.primary).slice(ROOT.length + 1)) : "";
    }
    return FILES_BASE + encodeURI(served(p).slice(ROOT.length + 1));
  },
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  plugins: {},
};
