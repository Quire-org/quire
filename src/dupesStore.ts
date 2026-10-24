import { create } from "zustand";
import { api, mediaUrl, rawPreviewUrl } from "./lib/api";
import {
  cacheValid,
  findGroups,
  h64ToHex,
  hashImageUrl,
  hashVideoUrl,
  hexToH64,
  SENSITIVITY,
  VIDEO_MAX_FRAMES,
  type DupeEntry,
  type DupeGroup,
  type ImageSig,
  type SigCache,
  type VideoSig,
} from "./lib/dupes";
import type { MediaItem } from "./lib/types";
import { useStore } from "./store";

export type Scope = "all" | "unsorted" | string;
export type Sensitivity = keyof typeof SENSITIVITY;

export interface Progress {
  stage: "idle" | "loading" | "images" | "videos" | "matching" | "done";
  done: number;
  total: number;
  detail?: string;
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
  includeAlbums: boolean;
  sensitivity: Sensitivity;
  includeVideos: boolean;
  running: boolean;
  progress: Progress;
  groups: DupeGroup[];
  scanned: number;
  entries: DupeEntry[];
  cancelFlag: { v: boolean };
  /** Fingerprint cache from .mediasorter.cache.json (also tells which files are known unique). */
  cache: SigCache;
  cacheRoot: string | null;
  /** Items the scan would cover, kept for the estimate. */
  candidates: MediaItem[];
  estimate: Estimate;
  readMBps: number | null;
  set(p: Partial<DupesState>): void;
  loadCache(): Promise<void>;
  refreshCandidates(): Promise<void>;
  benchmark(): Promise<void>;
  scan(): Promise<void>;
  cancel(): void;
  rematch(): void;
  removeItem(key: string): void;
}

const CACHE_VERSION = 1;
const DEFAULT_READ_MBPS = 40; // a typical SD card over a USB reader
const DECODE_S_PER_MB = 0.012; // JPEG decode + hash, per megabyte, on a laptop core
const SEEK_S_PER_FRAME = 0.08;
const ASSUMED_VIDEO_MBPS = 1.5; // bytes per second of footage, to guess durations

const emptyEstimate: Estimate = { total: 0, cached: 0, newStills: 0, newVideos: 0, newBytes: 0, seconds: null, readMBps: null };

function inScope(i: MediaItem, scope: Scope, folders: Set<string> | null): boolean {
  if (scope === "unsorted" && i.targetId) return false;
  if (scope !== "all" && scope !== "unsorted" && i.targetId !== scope) return false;
  if (folders && !folders.has(i.dir)) return false;
  return true;
}

function fromCache(i: MediaItem, cache: SigCache): DupeEntry {
  const c = cache[i.key];
  if (!c) return { item: i };
  return {
    item: i,
    fp: c.fp,
    image: c.image ? { phash: hexToH64(c.image.phash), dhash: hexToH64(c.image.dhash), width: c.image.width, height: c.image.height } : undefined,
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
  includeAlbums: false,
  sensitivity: "normal",
  includeVideos: true,
  running: false,
  progress: { stage: "idle", done: 0, total: 0, eta: null },
  groups: [],
  scanned: 0,
  entries: [],
  cancelFlag: { v: false },
  cache: {},
  cacheRoot: null,
  candidates: [],
  estimate: emptyEstimate,
  readMBps: null,
  set(p) {
    set(p);
    if ("scope" in p || "folders" in p || "includeVideos" in p || "includeAlbums" in p) void get().refreshCandidates();
  },

  async loadCache() {
    const root = useStore.getState().root;
    if (!root || get().cacheRoot === root) return;
    const raw = (await api.loadCache(root).catch(() => null)) as { version?: number; sigs?: SigCache } | null;
    set({ cache: raw && raw.version === CACHE_VERSION && raw.sigs ? raw.sigs : {}, cacheRoot: root });
    void get().refreshCandidates();
  },

  async refreshCandidates() {
    const main = useStore.getState();
    if (!main.root || !main.library) return;
    const { scope, folders, includeAlbums, includeVideos, cache, readMBps } = get();
    const all = (await main.loadAll()).filter((i) => includeAlbums || !i.albumKey);
    const candidates = all.filter((i) => inScope(i, scope, folders));
    set({ candidates, estimate: estimateFor(candidates, cache, includeVideos, readMBps) });
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

  cancel() {
    get().cancelFlag.v = true;
  },

  rematch() {
    const { entries, sensitivity } = get();
    set({ groups: findGroups(entries, SENSITIVITY[sensitivity]) });
  },

  removeItem(key) {
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
    set({ running: true, cancelFlag, groups: [], progress: { stage: "loading", done: 0, total: 0, eta: null } });
    const cancelled = () => cancelFlag.v;

    try {
      await get().loadCache();
      await get().refreshCandidates();
      const { candidates: items, includeVideos, sensitivity, cache, readMBps } = get();
      let dirty = 0;
      const persist = async () => {
        if (!dirty) return;
        dirty = 0;
        await api.saveCache(root, { version: CACHE_VERSION, sigs: cache }).catch(() => {});
      };

      const entries: DupeEntry[] = [];
      const need = items.filter((i) => needsWork(i, cache, includeVideos));
      const needSet = new Set(need.map((i) => i.key));
      for (const i of items) if (!needSet.has(i.key)) entries.push(fromCache(i, cache));

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
      const worker = async () => {
        while (cursor < queue.length && !cancelled()) {
          const item = queue[cursor++];
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
                c.image = { phash: h64ToHex(sig.phash), dhash: h64ToHex(sig.dhash), width: sig.width, height: sig.height };
              } catch (e2) {
                c.error = String(e2);
              }
            }
          }
          cache[item.key] = c;
          dirty++;
          if (item.kind !== "video") entries.push(fromCache(item, cache));
          done++;
          doneBytes += item.kind === "video" ? Math.min(item.size, 3 * 1_048_576) : item.size;
          set({ progress: { stage: "images", done, total: queue.length, detail: item.name, eta: stillEta() } });
          if (dirty >= 50) await persist();
        }
      };
      await Promise.all(Array.from({ length: workers }, worker));
      await persist();

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
        for (let k = 0; k < videos.length && !cancelled(); k++) {
          const item = videos[k];
          const c = cache[item.key] ?? { size: item.size, modified: item.modified };
          let framesThis = 0;
          try {
            const sig: VideoSig = await hashVideoUrl(mediaUrl(item), cancelled, (i, n) => {
              framesDone += i - framesThis;
              framesThis = i;
              set({ progress: { stage: "videos", done: k, total: videos.length, detail: `${item.name}  ${i}/${n}s`, eta: videoEta() } });
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
          entries.push(fromCache(item, cache));
          set({ progress: { stage: "videos", done: k + 1, total: videos.length, eta: videoEta() } });
          if (dirty >= 5) await persist();
        }
        await persist();
        // Videos skipped by a cancel still take part with whatever they have.
        const seen = new Set(entries.map((e) => e.item.key));
        for (const v of videos) if (!seen.has(v.key)) entries.push(fromCache(v, cache));
      } else {
        for (const v of videos) entries.push(fromCache(v, cache));
      }

      set({ progress: { stage: "matching", done: 0, total: 0, eta: null } });
      const groups = findGroups(entries, SENSITIVITY[sensitivity]);
      set({
        groups,
        entries,
        scanned: items.length,
        progress: { stage: cancelled() ? "idle" : "done", done: 0, total: 0, eta: null },
        estimate: estimateFor(items, cache, includeVideos, readMBps),
      });
      if (cancelled()) main.toast("Duplicate scan cancelled", "warn");
      else main.toast(groups.length ? `${groups.length} duplicate group${groups.length === 1 ? "" : "s"} found` : "No duplicates found", "ok");
    } catch (e) {
      main.toast(String(e), "error");
      set({ progress: { stage: "idle", done: 0, total: 0, eta: null } });
    } finally {
      set({ running: false });
    }
  },
}));
