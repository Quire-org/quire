import { create } from "zustand";
import { startJob } from "./lib/jobs";
import { api, mediaUrl, rawPreviewUrl } from "./lib/api";
import {
  cacheValid,
  matchGroups,
  h64ToHex,
  hashImageUrl,
  hashVideoUrl,
  hexToH64,
  SENSITIVITY,
  VIDEO_MAX_FRAMES,
  type DupeEntry,
  type DupeGroup,
  type ImageSig,
  type MatchOptions,
  type SigCache,
  type VersionHint,
  type VideoSig,
} from "./lib/dupes";
import type { Album, MediaItem, VersionLink } from "./lib/types";
import { usePlugins } from "./plugins/store";
import { useStore } from "./store";
import { setView, view } from "./lib/views";
import { useVersions, versionPairs } from "./versionsStore";
import { seriesIndex } from "./lib/series";
import { inTarget } from "./lib/filing";

export type Scope = "all" | "unsorted" | string;
export type Sensitivity = keyof typeof SENSITIVITY;

export interface Progress {
  stage: "idle" | "loading" | "images" | "videos" | "matching" | "done";
  done: number;
  total: number;
  detail?: string;
  /** The item being worked on, for a preview. */
  key?: string;
  /** Each worker's item: a still, or a video with the frame it is on of how many. */
  workers?: { key: string; name: string; frame?: number; frames?: number }[];
  /** Seconds remaining, when known. */
  eta: number | null;
}

export interface Estimate {
  total: number;
  cached: number;
  newStills: number;
  newVideos: number;
  newBytes: number;
  /** Rough seconds for the scan, null while there is nothing to do. */
  seconds: number | null;
  readMBps: number | null;
}

interface DupesState {
  scope: Scope;
  /** Selected folders (item.dir values); null = all. */
  folders: Set<string> | null;
  /** Every folder there was when they were chosen: one that came since takes its parent's choice. */
  foldersKnown: Set<string> | null;
  includeAlbums: boolean;
  sensitivity: Sensitivity;
  /** Which groups to list: all, or only exact copies, similar images, or videos. */
  show: "all" | "exact" | "image" | "video";
  includeVideos: boolean;
  running: boolean;
  progress: Progress;
  groups: DupeGroup[];
  scanned: number;
  entries: DupeEntry[];
  cancelFlag: { v: boolean };
  /** A running scan waits here until resumed; the cache keeps what was done either way. */
  paused: boolean;
  /** Groups the user said are not duplicates (Keep all): by item key and by fingerprint, so a moved file stays known. */
  ignored: IgnoredGroup[];
  /** Fingerprint cache from .quire.cache.json (also tells which files are known unique). */
  cache: SigCache;
  cacheRoot: string | null;
  /** Items the scan would cover, kept for the estimate. */
  candidates: MediaItem[];
  estimate: Estimate;
  readMBps: number | null;
  set(p: Partial<DupesState>): void;
  loadCache(): Promise<void>;
  refreshCandidates(): Promise<void>;
  /** The groups among files already scanned and unchanged since, from the cache: shown without a new scan. */
  matchCached(): Promise<void>;
  /** The last match's groups and what they were made from (see Matched). */
  matched: Matched | null;
  /** How far the match of the cached scan is (0..1) while it runs; null otherwise. */
  matchingCache: number | null;
  benchmark(): Promise<void>;
  scan(): Promise<void>;
  cancel(): void;
  /** Pictures gone for good: their fingerprints and places in groups said not to be duplicates go (else each scan looks for them). */
  forget(gone: (key: string) => boolean): Promise<void>;
  pause(on: boolean): void;
  /** Keep all of a group: it is no duplicate, and won't be shown again. */
  ignoreGroup(group: DupeGroup): void;
  clearIgnored(): void;
  rematch(): void;
  removeItem(key: string): void;
  /** Plugins' checks for versions they made (a cleaned page, say) that are on, as "pluginId:id". */
  versionsOn: string[];
  setVersionCheck(id: string, on: boolean): void;
}

/**
 * A picture's (or video's) fingerprint and, for a picture, its looks, into `cache` unless it has
 * them for the file as it is: what the duplicate check, and the series Sort suggests, compare.
 */
export async function signItem(item: MediaItem, cache: SigCache): Promise<void> {
  const c: SigCache[string] = cacheValid(cache[item.key], item) ? cache[item.key] : { size: item.size, modified: item.modified };
  if (!c.fp) {
    try {
      c.fp = await api.fileFingerprint(item.primary);
    } catch (e) {
      c.error = String(e);
    }
  }
  if (item.kind !== "video" && !c.image) {
    try {
      c.image = await api.imageHash(item.primary, item.kind === "raw");
    } catch {
      // The webview may decode what Rust cannot (HEIC, AVIF...).
      try {
        const url = item.kind === "raw" ? await rawPreviewUrl(item.primary) : mediaUrl(item);
        const sig: ImageSig = await hashImageUrl(url);
        c.image = { phash: h64ToHex(sig.phash), quads: sig.quads?.map(h64ToHex), dhash: h64ToHex(sig.dhash), width: sig.width, height: sig.height };
      } catch (e2) {
        c.error = String(e2);
      }
    }
  }
  cache[item.key] = c;
}

/**
 * The plugins' version checks that are on, as the matcher takes them: with the versions each plugin
 * made that the app linked to their pictures (one written over its original keeps that one's name).
 */
export function versionHints(): VersionHint[] {
  const on = new Set(useDupes.getState().versionsOn);
  const checks = Object.values(usePlugins.getState().dupeVersions).filter((v) => on.has(`${v.pluginId}:${v.id}`));
  if (!checks.length) return [];
  const links = useVersions.getState().links;
  const linked = new Map<string, string[]>();
  for (const [key, sig] of Object.entries(useDupes.getState().cache)) {
    const by = sig?.fp ? links[sig.fp]?.by : undefined;
    if (by) linked.set(by, [...(linked.get(by) ?? []), key]);
  }
  return checks.map((v) => {
    const keys = [...(v.keys ?? []), ...(linked.get(v.pluginId) ?? [])];
    return { prefix: v.prefix, ...(keys.length ? { keys } : {}), note: v.note };
  });
}

/** The items that are versions linked to their pictures, by what they are called, as hints for their badge. */
export function linkedHints(links: Record<string, VersionLink>, cache: SigCache): VersionHint[] {
  if (!Object.keys(links).length) return [];
  const byNote = new Map<string, string[]>();
  for (const [key, sig] of Object.entries(cache)) {
    const l = sig?.fp ? links[sig.fp] : undefined;
    if (l) byNote.set(l.note, [...(byNote.get(l.note) ?? []), key]);
  }
  return [...byNote].map(([note, keys]) => ({ keys, note }));
}

function matchOpts(sensitivity: Sensitivity): MatchOptions {
  const versions = versionHints();
  const links = versionPairs(useVersions.getState().links);
  return { ...SENSITIVITY[sensitivity], ...(versions.length ? { versions } : {}), ...(links.length ? { links } : {}) };
}

/** Raised when matching changes, so a match kept from before is made again (2: clips no longer chain videos together; 3: a video match must stand out from look-alike footage). */
const MATCHER = 3;

/** What else a match depends on: how matching works, the sensitivity, the version checks that are on (with what they know), and the versions linked to their pictures. */
function matchKey(sensitivity: Sensitivity): string {
  const versions = versionHints();
  const links = versionPairs(useVersions.getState().links);
  if (!versions.length && !links.length) return `${sensitivity}@${MATCHER}`;
  const text = [...versions.map((v) => `${v.prefix ?? ""}|${v.note}|${(v.keys ?? []).join("\n")}`), ...links.map((l) => `${l.made}>${l.from}|${l.note}`)].join(";");
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${sensitivity}@${MATCHER}+v${(h >>> 0).toString(36)}`;
}

const VERSIONS_KEY = "quire.dupes.versions";
function savedVersionChecks(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(VERSIONS_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const CACHE_VERSION = 1;

/**
 * The groups of the last match, by item key, and what they were matched from: shown again at once
 * (and kept in the cache file, so after a restart too) while nothing they were made from changed.
 */
export interface Matched {
  sig: MatchSig;
  groups: { kind: DupeGroup["kind"]; members: { key: string; notes: string[] }[] }[];
}

/** What a match was made from: every entry's file and what is known of it, summed (order doesn't matter, one can be taken out), and the sensitivity. */
export interface MatchSig {
  sensitivity: string;
  n: number;
  a: number;
  b: number;
}

/** One entry's part of a MatchSig. */
function entryHash(e: DupeEntry): [number, number] {
  const s = `${e.item.key}|${e.item.size}|${e.item.modified}|${e.fp ? 1 : 0}${e.image ? 1 : 0}${e.video ? 1 : 0}`;
  let a = 0x811c9dc5;
  let b = 0x9e3779b1;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519) ^ (b >>> 13);
  }
  return [a >>> 0, b >>> 0];
}

export function matchSig(entries: DupeEntry[], sensitivity: string): MatchSig {
  let a = 0;
  let b = 0;
  for (const e of entries) {
    const [x, y] = entryHash(e);
    a = (a + x) >>> 0;
    b = (b + y) >>> 0;
  }
  return { sensitivity, n: entries.length, a, b };
}

const sameSig = (x: MatchSig | null | undefined, y: MatchSig | null | undefined) => !!x && !!y && x.sensitivity === y.sensitivity && x.n === y.n && x.a === y.a && x.b === y.b;

function toMatched(sig: MatchSig, groups: DupeGroup[]): Matched {
  return { sig, groups: groups.map((g) => ({ kind: g.kind, members: g.members.map((m) => ({ key: m.item.key, notes: m.notes })) })) };
}

/** Kept groups as groups again, with the entries they were made from (none if one is missing). */
function fromMatched(m: Matched, entries: DupeEntry[]): DupeGroup[] | null {
  const byKey = new Map(entries.map((e) => [e.item.key, e]));
  const out: DupeGroup[] = [];
  for (const g of m.groups) {
    const members = g.members.map((x) => ({ x, e: byKey.get(x.key) }));
    if (members.some((y) => !y.e)) return null;
    out.push({ id: g.members.map((x) => x.key).join("\n"), kind: g.kind, members: members.map(({ x, e }) => ({ item: e!.item, notes: x.notes, image: e!.image, video: e!.video })) });
  }
  return out;
}

export interface IgnoredGroup {
  keys: string[];
  fps: string[];
}

/** Groups the user said are no duplicates are left out: a group whose every member is known to one such set. */
/**
 * Files trashed from the Duplicates screen: left out of every match from then on, including the
 * live and final matches of a scan that was running when they went (its own list still has them).
 */
const gone = new Set<string>();
const alive = (entries: DupeEntry[]) => (gone.size ? entries.filter((e) => !gone.has(e.item.key)) : entries);

export function withoutIgnored(groups: DupeGroup[], ignored: IgnoredGroup[] | undefined, fpOf: (key: string) => string | undefined): DupeGroup[] {
  // A series is kept whole on purpose: a group that is one is no duplicate.
  const series = seriesIndex(useStore.getState().library?.series);
  const kept = series.size ? groups.filter((g) => !g.members.every((m) => series.get(m.item.key) === series.get(g.members[0].item.key) && series.has(m.item.key))) : groups;
  if (!ignored?.length) return kept;
  const sets = ignored.map((g) => ({ keys: new Set(g.keys), fps: new Set(g.fps) }));
  return kept.filter((g) => !sets.some((ig) => g.members.every((m) => ig.keys.has(m.item.key) || ig.fps.has(fpOf(m.item.key) ?? ""))));
}

/** Waits while the scan is paused (and returns at once when it is cancelled). */
async function whilePaused(get: () => { paused: boolean; cancelFlag: { v: boolean } }) {
  while (get().paused && !get().cancelFlag?.v) await new Promise((r) => setTimeout(r, 150));
}
const DEFAULT_READ_MBPS = 40; // a typical SD card over a USB reader
const DECODE_S_PER_MB = 0.012; // JPEG decode + hash, per megabyte, on a laptop core
const SEEK_S_PER_FRAME = 0.08;
const ASSUMED_VIDEO_MBPS = 1.5; // bytes per second of footage, to guess durations

const emptyEstimate: Estimate = { total: 0, cached: 0, newStills: 0, newVideos: 0, newBytes: 0, seconds: null, readMBps: null };

/** A PDF album as one item to compare: the file itself, pictured by its first page. */
function pdfItem(a: Album): MediaItem {
  return { key: a.key, primary: a.path, files: [a.path], kind: "image", name: a.name, dir: a.key.includes("/") ? a.key.slice(0, a.key.lastIndexOf("/")) : "", size: a.bytes, modified: a.modified, hasRaw: false, hasVideo: false, vaultId: a.cover?.vaultId };
}

/* The scope (where to look, its folders, albums, videos, sensitivity), remembered with each library (see lib/views). */

interface SavedScope {
  scope: Scope;
  folders: string[] | null;
  known: string[] | null;
  includeAlbums: boolean;
  includeVideos: boolean;
  sensitivity: Sensitivity;
}

function rememberScope() {
  if (!useStore.getState().root) return;
  const d = useDupes.getState();
  const saved: SavedScope = { scope: d.scope, folders: d.folders && [...d.folders], known: d.foldersKnown && [...d.foldersKnown], includeAlbums: d.includeAlbums, includeVideos: d.includeVideos, sensitivity: d.sensitivity };
  setView("dupesScope", saved);
}

/** The scope last used in this library (a sort target since removed: everything again); none kept, everything. */
function scopeFor(_root: string): Partial<DupesState> {
  const v = view<SavedScope | null>("dupesScope", null);
  if (!v) return { scope: "all", folders: null, foldersKnown: null, includeAlbums: false, includeVideos: true, sensitivity: "normal" };
  const targets = useStore.getState().library?.targets ?? [];
  const scope = v.scope === "all" || v.scope === "unsorted" || targets.some((t) => t.id === v.scope) ? v.scope : "all";
  return { scope, folders: v.folders ? new Set(v.folders) : null, foldersKnown: v.known ? new Set(v.known) : null, includeAlbums: !!v.includeAlbums, includeVideos: v.includeVideos !== false, sensitivity: v.sensitivity in SENSITIVITY ? v.sensitivity : "normal" };
}

/** A folder and the folders it is in, up to the top ("" is the opened folder itself). */
export function withParents(dir: string): string[] {
  const parts = dir ? dir.split("/") : [];
  return parts.map((_, k) => parts.slice(0, parts.length - k).join("/")).concat("");
}

/**
 * The folders chosen, with the folders that came since they were chosen: each in, or out, as the
 * nearest folder it is in that was there then.
 */
function withNewFolders(items: MediaItem[]): Set<string> | null {
  const { folders, foldersKnown } = useDupes.getState();
  if (!folders || !foldersKnown) return folders;
  const added = new Set<string>();
  for (const i of items) {
    if (folders.has(i.dir) || foldersKnown.has(i.dir) || added.has(i.dir)) continue;
    const up = withParents(i.dir).find((d) => foldersKnown.has(d));
    if (up != null && folders.has(up)) for (const d of withParents(i.dir)) if (!foldersKnown.has(d)) added.add(d);
  }
  if (!added.size) return folders;
  const next = new Set([...folders, ...added]);
  useDupes.setState({ folders: next });
  return next;
}

/** The scope changed while a scan ran: its groups are of what it set out to read, matched again after. */
let scopeChanged = false;

/** Groups with only what the scope takes in now (the scope, its folders, albums or not): a group left with one is none. */
function inScopeNow(groups: DupeGroup[]): DupeGroup[] {
  const { scope, folders, includeAlbums } = useDupes.getState();
  const keep = (m: DupeGroup["members"][number]) => inScope(m.item, scope, folders) && (includeAlbums || !m.item.albumKey);
  if (groups.every((g) => g.members.every(keep))) return groups;
  return groups.map((g) => (g.members.every(keep) ? g : { ...g, members: g.members.filter(keep) })).filter((g) => g.members.length > 1);
}

function inScope(i: MediaItem, scope: Scope, folders: Set<string> | null): boolean {
  if (scope === "unsorted" && i.targetId) return false;
  if (scope !== "all" && scope !== "unsorted") {
    // A target's pictures, with those in a folder of its that has a key of its own.
    const targets = useStore.getState().library?.targets ?? [];
    const t = targets.find((x) => x.id === scope);
    if (!(t ? inTarget(i, t, targets) : i.targetId === scope)) return false;
  }
  if (folders && !folders.has(i.dir)) return false;
  return true;
}

/** What the screen wants matched now, and what is being matched: a match whose inputs changed is dropped, the same one isn't started twice. */
let wanted: MatchSig | null = null;
let underWay: MatchSig | null = null;

function fromCache(i: MediaItem, cache: SigCache): DupeEntry {
  const c = cache[i.key];
  if (!c) return { item: i };
  return {
    item: i,
    fp: c.fp,
    image: c.image ? { phash: hexToH64(c.image.phash), quads: c.image.quads?.map(hexToH64), dhash: hexToH64(c.image.dhash), width: c.image.width, height: c.image.height } : undefined,
    video: c.video
      ? { frames: c.video.frames.map(hexToH64), informative: [...c.video.info].map((ch) => ch === "1"), duration: c.video.duration, width: c.video.width, height: c.video.height }
      : undefined,
  };
}

/** Files that still need work for this configuration. */
function needsWork(i: MediaItem, cache: SigCache, includeVideos: boolean): boolean {
  const c = cache[i.key];
  if (!cacheValid(c, i)) return true;
  if (c.error) return false;
  if (i.kind === "video") return includeVideos && !c.video;
  return !c.image && !c.fp;
}

function estimateFor(items: MediaItem[], cache: SigCache, includeVideos: boolean, readMBps: number | null): Estimate {
  const mbps = readMBps ?? DEFAULT_READ_MBPS;
  let cached = 0;
  let newStills = 0;
  let newVideos = 0;
  let newBytes = 0;
  let seconds = 0;
  for (const i of items) {
    if (!needsWork(i, cache, includeVideos)) {
      cached++;
      continue;
    }
    const mb = i.size / 1_048_576;
    if (i.kind === "video") {
      newVideos++;
      newBytes += Math.min(i.size, 3 * 1_048_576);
      const frames = Math.min(VIDEO_MAX_FRAMES, Math.max(1, Math.floor(mb / ASSUMED_VIDEO_MBPS)));
      seconds += Math.min(mb, 3) / mbps + frames * SEEK_S_PER_FRAME;
    } else {
      newStills++;
      newBytes += i.size;
      seconds += mb / mbps + mb * DECODE_S_PER_MB + 0.02;
    }
  }
  // Still images are hashed on several cores at once.
  const workers = Math.min(8, Math.max(2, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4));
  const stillShare = newStills + newVideos ? newStills / (newStills + newVideos) : 0;
  const adjusted = seconds * (stillShare / Math.max(1, workers / 2) + (1 - stillShare));
  return { total: items.length, cached, newStills, newVideos, newBytes, seconds: newStills + newVideos ? Math.max(1, Math.round(adjusted)) : null, readMBps };
}

export const useDupes = create<DupesState>((set, get) => ({
  scope: "all",
  folders: null,
  foldersKnown: null,
  includeAlbums: false,
  sensitivity: "normal",
  show: "all",
  includeVideos: true,
  running: false,
  progress: { stage: "idle", done: 0, total: 0, eta: null },
  groups: [],
  scanned: 0,
  entries: [],
  cancelFlag: { v: false },
  paused: false,
  ignored: [],
  cache: {},
  cacheRoot: null,
  matchingCache: null,
  matched: null,
  candidates: [],
  estimate: emptyEstimate,
  readMBps: null,
  set(p) {
    set(p);
    if ("scope" in p || "folders" in p || "includeVideos" in p || "includeAlbums" in p || "sensitivity" in p) rememberScope();
    if (!("scope" in p || "folders" in p || "includeVideos" in p || "includeAlbums" in p)) return;
    // What is out of scope now leaves the list at once; what came in is matched again from the cache,
    // now or, while a scan runs (it reads what it set out to), once it is done.
    set({ groups: inScopeNow(get().groups) });
    if (get().running) scopeChanged = true;
    else void get().refreshCandidates();
  },

  async loadCache() {
    const root = useStore.getState().root;
    if (!root || get().cacheRoot === root) return;
    const raw = (await api.loadCache(root).catch(() => null)) as { version?: number; sigs?: SigCache; ignored?: IgnoredGroup[]; matched?: Matched } | null;
    const ok = raw && raw.version === CACHE_VERSION && raw.sigs;
    // Only read here (moved files are looked for in it at every start); matching waits for the screen.
    set({ cache: ok ? raw.sigs! : {}, ignored: raw?.ignored ?? [], matched: ok ? (raw.matched ?? null) : null, cacheRoot: root, ...scopeFor(root) });
  },

  async refreshCandidates() {
    const main = useStore.getState();
    if (!main.root || !main.library) return;
    const { scope, includeAlbums, includeVideos, cache, readMBps } = get();
    const all = (await main.loadAll()).filter((i) => includeAlbums || !i.albumKey);
    const folders = withNewFolders(all);
    // A PDF album is one item: the same file twice, or two whose first pages match, are copies.
    const albums = includeAlbums ? ((main.albums.length ? main.albums : await main.loadAlbums().catch(() => [])) ?? []) : [];
    const pdfs = albums.filter((a) => a.pdf).map(pdfItem);
    const candidates = [...all, ...pdfs].filter((i) => inScope(i, scope, folders));
    set({ candidates, estimate: estimateFor(candidates, cache, includeVideos, readMBps) });
    await useVersions.getState().load();
    await get().matchCached();
  },

  async matchCached() {
    // Groups used to come only from a scan, so after reopening the folder (a card taken out and
    // put back, a restart) the list was empty though every file was fingerprinted. What the cache
    // knows about files unchanged since is enough to show them again; and while nothing changed
    // since the last match, its groups are shown as they were, without matching again.
    const { candidates, cache, includeVideos, sensitivity, running, cacheRoot } = get();
    if (running || !cacheRoot || cacheRoot !== useStore.getState().root) return;
    const entries = alive(
      candidates
        .filter((i) => (includeVideos || i.kind !== "video") && cacheValid(cache[i.key], i))
        .map((i) => fromCache(i, cache))
        .filter((e) => e.fp || e.image || e.video),
    );
    const sig = matchSig(entries, matchKey(sensitivity));
    const done = (groups: DupeGroup[]) =>
      set({
        matchingCache: null,
        entries,
        groups: withoutIgnored(groups, get().ignored, (k) => cache[k]?.fp),
        scanned: entries.length,
        ...(entries.length ? { progress: { stage: "done" as const, done: 0, total: 0, eta: null } } : {}),
      });
    wanted = sig;
    if (entries.length < 2) return void done([]);
    const kept = get().matched;
    const again = kept && sameSig(kept.sig, sig) ? fromMatched(kept, entries) : null;
    if (again) return void done(again);
    // The same match already under way (the screen opened twice, say): its answer will do.
    if (sameSig(underWay, sig)) return;
    underWay = sig;
    set({ matchingCache: 0 });
    const job = startJob({
      title: "Matching what was scanned before",
      source: "Duplicates",
      total: 100,
      percent: true,
      pause: { cannot: "Matching takes a moment; it can only be stopped." },
      stop: () => {
        wanted = null;
        set({ matchingCache: null });
      },
    });
    let groups: DupeGroup[];
    try {
      groups = await matchGroups(entries, matchOpts(sensitivity), (f) => {
        if (!sameSig(wanted, sig)) return;
        job.update({ done: Math.round(f * 100) });
        set({ matchingCache: f });
      });
    } finally {
      job.finish();
      if (sameSig(underWay, sig)) underWay = null;
    }
    // Shown if these are still the files wanted (not stopped, nothing changed, no scan started).
    if (!sameSig(wanted, sig) || get().running) return;
    set({ matched: toMatched(sig, groups) });
    done(groups);
    void api.saveCache(cacheRoot, { version: CACHE_VERSION, sigs: get().cache, ignored: get().ignored, matched: get().matched }).catch(() => {});
  },

  async benchmark() {
    const root = useStore.getState().root;
    if (!root) return;
    try {
      const b = await api.readBenchmark(root);
      set({ readMBps: b.mbPerS });
      const { candidates, cache, includeVideos } = get();
      set({ estimate: estimateFor(candidates, cache, includeVideos, b.mbPerS) });
    } catch (e) {
      useStore.getState().toast(`Benchmark failed: ${e}`, "error");
    }
  },

  async forget(gone) {
    await get().loadCache();
    const root = useStore.getState().root;
    const ds = get();
    if (!root || ds.cacheRoot !== root) return;
    // In place, as a move does: a running scan keeps adding to the same cache.
    const cache = ds.cache;
    let dropped = 0;
    for (const k of Object.keys(cache))
      if (gone(k)) {
        delete cache[k];
        dropped++;
      }
    const ignored = ds.ignored
      .map((g) => {
        const keep = g.keys.map((k, i) => (gone(k) ? -1 : i)).filter((i) => i >= 0);
        return { ...g, keys: keep.map((i) => g.keys[i]), fps: keep.map((i) => g.fps[i]) };
      })
      .filter((g) => g.keys.length > 1);
    if (!dropped && JSON.stringify(ignored) === JSON.stringify(ds.ignored)) return;
    set({ ignored, matched: null });
    await api.saveCache(root, { version: CACHE_VERSION, sigs: cache, ignored, matched: null }).catch(() => {});
  },

  cancel() {
    get().cancelFlag.v = true;
    set({ paused: false });
  },

  pause(on) {
    set({ paused: on });
  },

  ignoreGroup(group) {
    const cache = get().cache;
    const entry: IgnoredGroup = { keys: group.members.map((m) => m.item.key), fps: group.members.map((m) => cache[m.item.key]?.fp).filter((f): f is string => !!f) };
    const ignored = [...get().ignored, entry];
    set({ ignored, groups: get().groups.filter((g) => g.id !== group.id) });
    const root = useStore.getState().root;
    if (root) void api.saveCache(root, { version: CACHE_VERSION, sigs: get().cache, ignored, matched: get().matched }).catch(() => {});
  },

  clearIgnored() {
    set({ ignored: [] });
    get().rematch();
    const root = useStore.getState().root;
    if (root) void api.saveCache(root, { version: CACHE_VERSION, sigs: get().cache, ignored: [], matched: get().matched }).catch(() => {});
  },

  rematch() {
    void get().matchCached();
  },

  versionsOn: savedVersionChecks(),

  setVersionCheck(id, on) {
    const versionsOn = on ? [...new Set([...get().versionsOn, id])] : get().versionsOn.filter((x) => x !== id);
    set({ versionsOn });
    try {
      localStorage.setItem(VERSIONS_KEY, JSON.stringify(versionsOn));
    } catch {
      /* no storage: it is off again next time */
    }
    if (get().entries.length) get().rematch();
  },

  removeItem(key) {
    gone.add(key);
    // The kept match loses the file too, so the next look reuses it instead of matching again.
    const m = get().matched;
    const e = get().entries.find((x) => x.item.key === key);
    if (m && e) {
      const [x, y] = entryHash(e);
      const sig = { ...m.sig, n: m.sig.n - 1, a: (m.sig.a - x) >>> 0, b: (m.sig.b - y) >>> 0 };
      const groups = m.groups.map((g) => ({ ...g, members: g.members.filter((mm) => mm.key !== key) })).filter((g) => g.members.length > 1);
      set({ matched: { sig, groups } });
    }
    set({
      entries: get().entries.filter((e) => e.item.key !== key),
      groups: get()
        .groups.map((g) => ({ ...g, members: g.members.filter((m) => m.item.key !== key) }))
        .filter((g) => g.members.length > 1),
    });
  },

  async scan() {
    const main = useStore.getState();
    const root = main.root;
    if (!root || get().running) return;
    const cancelFlag = { v: false };
    set({ running: true, paused: false, cancelFlag, groups: [], progress: { stage: "loading", done: 0, total: 0, eta: null } });
    gone.clear(); // the scan starts from the library as it is now, the trash left out
    const cancelled = () => cancelFlag.v;
    await useVersions.getState().load();

    try {
      await get().loadCache();
      await get().refreshCandidates();
      const { candidates: items, includeVideos, sensitivity, cache, readMBps } = get();
      let dirty = 0;
      let lastSave = Date.now();
      // Saved only into the library it set out on: another opened since gets nothing of this one.
      const persist = async () => {
        if (!dirty || useStore.getState().root !== root) return;
        dirty = 0;
        lastSave = Date.now();
        await api.saveCache(root, { version: CACHE_VERSION, sigs: cache, ignored: get().ignored, matched: get().matched }).catch(() => {});
      };
      // The whole cache goes over on every save, so it is saved by the clock, not every few files.
      const persistSoon = () => (dirty && Date.now() - lastSave > 20_000 ? persist() : undefined);

      const entries: DupeEntry[] = [];
      // Groups found so far, shown while the scan runs: matched in a worker every few seconds (the
      // match is quadratic, so less often on a big library), one match at a time, and once more at
      // the end over everything. A match's answer is dropped when a newer one has started.
      let lastMatch = 0;
      let newSince = 0;
      let matching = false;
      let gen = 0;
      const liveMatch = (force = false) => {
        newSince++;
        const interval = entries.length > 20000 ? 30000 : entries.length > 8000 ? 10000 : 3000;
        if (matching || (!force && (newSince < 1 || Date.now() - lastMatch < interval))) return;
        matching = true;
        newSince = 0;
        lastMatch = Date.now();
        const my = ++gen;
        void matchGroups(alive(entries), matchOpts(sensitivity))
          .then((gs) => {
            if (my === gen && get().cancelFlag === cancelFlag) set({ groups: inScopeNow(withoutIgnored(gs, get().ignored, (k) => cache[k]?.fp)) });
          })
          .finally(() => {
            matching = false;
          });
      };
      const need = items.filter((i) => needsWork(i, cache, includeVideos));
      const needSet = new Set(need.map((i) => i.key));
      for (const i of items) if (!needSet.has(i.key)) entries.push(fromCache(i, cache));
      // What earlier scans fingerprinted is matched straight away, so its groups show before any new file is read.
      if (entries.length > 1) liveMatch(true);

      const stills = need.filter((i) => i.kind !== "video");
      const videos = need.filter((i) => i.kind === "video");
      const videoEstimate = estimateFor(videos, {}, includeVideos, readMBps).seconds ?? 0;

      // Pass 1: fingerprints for everything new, perceptual hashes for stills.
      let done = 0;
      let doneBytes = 0;
      const totalBytes = stills.reduce((a, i) => a + i.size, 0) + videos.length * 3 * 1_048_576;
      const t0 = Date.now();
      const preEstimate = get().estimate.seconds ?? 0;
      const stillEta = () => {
        const elapsed = (Date.now() - t0) / 1000;
        // Until enough has been read to measure throughput, count down from the pre-scan estimate.
        if (doneBytes < 4 * 1_048_576 || elapsed < 1) return Math.max(0, Math.round(preEstimate - elapsed));
        return Math.round(((totalBytes - doneBytes) / doneBytes) * elapsed + (includeVideos ? videoEstimate : 0));
      };
      set({ progress: { stage: "images", done: 0, total: stills.length + videos.length, eta: get().estimate.seconds } });
      const workers = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));
      let cursor = 0;
      const queue = [...stills, ...videos];
      const slots: ({ key: string; name: string; frame?: number; frames?: number } | null)[] = [];
      const slot = (i: number, v: { key: string; name: string; frame?: number; frames?: number } | null) => {
        slots[i] = v;
        set({ progress: { ...get().progress, workers: slots.filter((x): x is NonNullable<typeof x> => !!x) } });
      };
      const worker = async (slotIndex: number) => {
        while (cursor < queue.length && !cancelled()) {
          await whilePaused(get);
          // Another worker may have taken the last item while this one waited.
          if (cancelled() || cursor >= queue.length) break;
          const item = queue[cursor++];
          slot(slotIndex, { key: item.key, name: item.name });
          set({ progress: { ...get().progress, key: item.key } });
          await signItem(item, cache);
          dirty++;
          if (item.kind !== "video") {
            entries.push(fromCache(item, cache));
            liveMatch();
          }
          done++;
          doneBytes += item.kind === "video" ? Math.min(item.size, 3 * 1_048_576) : item.size;
          set({ progress: { stage: "images", done, total: queue.length, detail: item.name, eta: stillEta() } });
          await persistSoon();
        }
      };
      await Promise.all(Array.from({ length: workers }, (_, i) => worker(i)));
      slots.length = 0;
      await persist();
      // Every picture is in: their groups are complete before the (long) video pass.
      liveMatch(true);

      // Pass 2: frame hashes for videos, one at a time (the decoder is the bottleneck).
      if (includeVideos) {
        const t1 = Date.now();
        let framesDone = 0;
        const framesGuess = videos.map((v) => Math.min(VIDEO_MAX_FRAMES, Math.max(1, Math.floor(v.size / 1_048_576 / ASSUMED_VIDEO_MBPS))));
        const totalFrames = framesGuess.reduce((a, b) => a + b, 0);
        const videoEta = () => {
          const elapsed = (Date.now() - t1) / 1000;
          if (framesDone < 5 || elapsed < 1) return Math.round(videoEstimate);
          return Math.round(Math.max(0, totalFrames - framesDone) * (elapsed / framesDone));
        };
        set({ progress: { stage: "videos", done: 0, total: videos.length, eta: videoEta() } });
        // Two at a time: a decoder each, which is as much as the webview keeps up with.
        let vcursor = 0;
        let vdone = 0;
        const videoWorker = async (slotIndex: number) => {
          while (vcursor < videos.length && !cancelled()) {
            await whilePaused(get);
            if (cancelled() || vcursor >= videos.length) break;
            const k = vcursor++;
            const item = videos[k];
            slot(slotIndex, { key: item.key, name: item.name, frame: 0, frames: framesGuess[k] });
            set({ progress: { ...get().progress, key: item.key } });
            const c = cache[item.key] ?? { size: item.size, modified: item.modified };
            let framesThis = 0;
            try {
              const sig: VideoSig = await hashVideoUrl(mediaUrl(item), cancelled, (i, n) => {
                framesDone += i - framesThis;
                framesThis = i;
                slot(slotIndex, { key: item.key, name: item.name, frame: i, frames: n });
                set({ progress: { stage: "videos", done: vdone, total: videos.length, detail: `${item.name}  ${i}/${n}s`, eta: videoEta() } });
              });
              if (!cancelled()) {
                c.video = { frames: sig.frames.map(h64ToHex), info: sig.informative.map((b) => (b ? "1" : "0")).join(""), duration: sig.duration, width: sig.width, height: sig.height };
                delete c.error;
              }
            } catch (e) {
              c.error = String(e);
            }
            framesDone += Math.max(0, framesGuess[k] - framesThis);
            cache[item.key] = c;
            dirty++;
            vdone++;
            entries.push(fromCache(item, cache));
            liveMatch();
            set({ progress: { stage: "videos", done: vdone, total: videos.length, eta: videoEta() } });
            await persistSoon();
          }
        };
        await Promise.all([videoWorker(0), videoWorker(1)]);
        slots.length = 0;
        await persist();
        // Videos skipped by a cancel still take part with whatever they have.
        const seen = new Set(entries.map((e) => e.item.key));
        for (const v of videos) if (!seen.has(v.key)) entries.push(fromCache(v, cache));
      } else {
        for (const v of videos) entries.push(fromCache(v, cache));
      }

      set({ progress: { stage: "matching", done: 0, total: 100, eta: null } });
      gen++; // a live match still running must not overwrite the final answer
      // Another library opened meanwhile (the scan was stopped as it did): nothing of this one shown
      // or saved there.
      if (useStore.getState().root !== root) return;
      const finalEntries = alive(entries);
      const found = await matchGroups(finalEntries, matchOpts(sensitivity), (f) => set({ progress: { stage: "matching", done: Math.round(f * 100), total: 100, eta: null } }));
      const groups = inScopeNow(withoutIgnored(found, get().ignored, (k) => cache[k]?.fp));
      // Kept, so opening the screen again (or the app) shows these without matching again.
      if (!cancelled()) {
        set({ matched: toMatched(matchSig(finalEntries, matchKey(sensitivity)), found) });
        void api.saveCache(root, { version: CACHE_VERSION, sigs: cache, ignored: get().ignored, matched: get().matched }).catch(() => {});
      }
      set({
        groups,
        entries: finalEntries,
        scanned: items.length,
        progress: { stage: cancelled() ? "idle" : "done", done: 0, total: 0, eta: null },
        estimate: estimateFor(items, cache, includeVideos, readMBps),
      });
      if (cancelled()) main.toast("Duplicate scan cancelled", "warn");
      else main.toast(groups.length ? `${groups.length} duplicate group${groups.length === 1 ? "" : "s"} found` : "No duplicates found", "ok");
    } catch (e) {
      console.warn("duplicate scan:", e);
      main.toast(String(e), "error");
      set({ progress: { stage: "idle", done: 0, total: 0, eta: null } });
    } finally {
      set({ running: false, paused: false });
    }
    // The scope changed meanwhile: matched again over what it takes in now (all of it in the cache).
    if (scopeChanged) {
      scopeChanged = false;
      await get().refreshCandidates();
    }
  },
}));

// Another library (or none): a scan of the last one stops, and nothing of it stays here to show or act
// on (its groups, the pictures it was looking at, its cache and what was ignored there); this one's is
// read when Duplicates is next looked at.
useStore.subscribe((s, p) => {
  if (s.root === p.root) return;
  const d = useDupes.getState();
  if (d.running) d.cancel();
  useDupes.setState({ groups: [], entries: [], candidates: [], estimate: emptyEstimate, scanned: 0, cache: {}, cacheRoot: null, ignored: [], matched: null, matchingCache: null });
});
