import { create } from "zustand";
import { api, fileSrc, rawPreviewUrl } from "./lib/api";
import {
  cacheValid,
  findGroups,
  h64ToHex,
  hashImageUrl,
  hashVideoUrl,
  hexToH64,
  SENSITIVITY,
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

interface Progress {
  stage: "idle" | "fingerprints" | "images" | "videos" | "matching" | "done";
  done: number;
  total: number;
  detail?: string;
}

interface DupesState {
  scope: Scope;
  sensitivity: Sensitivity;
  includeVideos: boolean;
  running: boolean;
  progress: Progress;
  groups: DupeGroup[];
  scanned: number;
  entries: DupeEntry[];
  cancelFlag: { v: boolean };
  set(p: Partial<DupesState>): void;
  scan(): Promise<void>;
  cancel(): void;
  rematch(): void;
  removeItem(key: string): void;
}

const CACHE_VERSION = 1;

export const useDupes = create<DupesState>((set, get) => ({
  scope: "all",
  sensitivity: "normal",
  includeVideos: true,
  running: false,
  progress: { stage: "idle", done: 0, total: 0 },
  groups: [],
  scanned: 0,
  entries: [],
  cancelFlag: { v: false },
  set: (p) => set(p),

  cancel() {
    get().cancelFlag.v = true;
  },

  rematch() {
    const { entries, sensitivity } = get();
    set({ groups: findGroups(entries, SENSITIVITY[sensitivity]) });
  },

  removeItem(key) {
    const entries = get().entries.filter((e) => e.item.key !== key);
    set({
      entries,
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
    set({ running: true, cancelFlag, groups: [], progress: { stage: "fingerprints", done: 0, total: 0 } });
    const cancelled = () => cancelFlag.v;

    try {
      const all = await main.loadAll();
      const { scope, includeVideos, sensitivity } = get();
      const items = all.filter((i) => (scope === "all" ? true : scope === "unsorted" ? !i.targetId : i.targetId === scope));

      const raw = (await api.loadCache(root).catch(() => null)) as { version?: number; sigs?: SigCache } | null;
      const cache: SigCache = raw && raw.version === CACHE_VERSION && raw.sigs ? raw.sigs : {};
      let dirty = 0;
      const persist = async () => {
        if (!dirty) return;
        dirty = 0;
        await api.saveCache(root, { version: CACHE_VERSION, sigs: cache }).catch(() => {});
      };

      const entries: DupeEntry[] = [];
      const need = items.filter((i) => !cacheValid(cache[i.key], i) || (includeVideos && i.kind === "video" && !cache[i.key].video && !cache[i.key].error));
      const fromCache = (i: MediaItem): DupeEntry => {
        const c = cache[i.key];
        return {
          item: i,
          fp: c.fp,
          image: c.image ? { phash: hexToH64(c.image.phash), dhash: hexToH64(c.image.dhash), width: c.image.width, height: c.image.height } : undefined,
          video: c.video
            ? { frames: c.video.frames.map(hexToH64), informative: [...c.video.info].map((ch) => ch === "1"), duration: c.video.duration, width: c.video.width, height: c.video.height }
            : undefined,
        };
      };
      for (const i of items) if (!need.includes(i)) entries.push(fromCache(i));

      // Pass 1: fingerprints + image hashes, a few in flight at a time.
      const stills = need.filter((i) => i.kind !== "video");
      const videos = need.filter((i) => i.kind === "video");
      set({ progress: { stage: "images", done: 0, total: stills.length } });
      let done = 0;
      const workers = Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));
      let cursor = 0;
      const worker = async () => {
        while (cursor < stills.length && !cancelled()) {
          const item = stills[cursor++];
          const c: SigCache[string] = { size: item.size, modified: item.modified };
          try {
            c.fp = await api.fileFingerprint(item.primary);
          } catch (e) {
            c.error = String(e);
          }
          try {
            const h = await api.imageHash(item.primary, item.kind === "raw");
            c.image = h;
          } catch {
            // The webview may decode what Rust cannot (HEIC, AVIF...).
            try {
              const url = item.kind === "raw" ? await rawPreviewUrl(item.primary) : fileSrc(item.primary);
              const sig: ImageSig = await hashImageUrl(url);
              c.image = { phash: h64ToHex(sig.phash), dhash: h64ToHex(sig.dhash), width: sig.width, height: sig.height };
            } catch (e2) {
              c.error = String(e2);
            }
          }
          cache[item.key] = c;
          dirty++;
          entries.push(fromCache(item));
          done++;
          set({ progress: { stage: "images", done, total: stills.length, detail: item.name } });
          if (dirty >= 50) await persist();
        }
      };
      await Promise.all(Array.from({ length: workers }, worker));
      await persist();

      // Pass 2: videos, one at a time (the decoder is the bottleneck).
      if (includeVideos && !cancelled()) {
        set({ progress: { stage: "videos", done: 0, total: videos.length } });
        for (let k = 0; k < videos.length && !cancelled(); k++) {
          const item = videos[k];
          const c: SigCache[string] = cacheValid(cache[item.key], item) ? cache[item.key] : { size: item.size, modified: item.modified };
          if (!c.fp) {
            try {
              c.fp = await api.fileFingerprint(item.primary);
            } catch (e) {
              c.error = String(e);
            }
          }
          try {
            const sig: VideoSig = await hashVideoUrl(fileSrc(item.primary), cancelled, (i, n) =>
              set({ progress: { stage: "videos", done: k, total: videos.length, detail: `${item.name}  ${i}/${n}s` } }),
            );
            if (!cancelled()) c.video = { frames: sig.frames.map(h64ToHex), info: sig.informative.map((b) => (b ? "1" : "0")).join(""), duration: sig.duration, width: sig.width, height: sig.height };
          } catch (e) {
            c.error = String(e);
          }
          cache[item.key] = c;
          dirty++;
          entries.push(fromCache(item));
          set({ progress: { stage: "videos", done: k + 1, total: videos.length } });
          if (dirty >= 5) await persist();
        }
        await persist();
      } else {
        for (const v of videos) entries.push(fromCache(v));
      }

      set({ progress: { stage: "matching", done: 0, total: 0 } });
      const groups = findGroups(entries, SENSITIVITY[sensitivity]);
      set({ groups, entries, scanned: items.length, progress: { stage: cancelled() ? "idle" : "done", done: 0, total: 0 } });
      if (cancelled()) main.toast("Duplicate scan cancelled", "warn");
      else main.toast(groups.length ? `${groups.length} duplicate group${groups.length === 1 ? "" : "s"} found` : "No duplicates found", "ok");
    } catch (e) {
      main.toast(String(e), "error");
      set({ progress: { stage: "idle", done: 0, total: 0 } });
    } finally {
      set({ running: false });
    }
  },
}));
