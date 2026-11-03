import { useEffect, useState } from "react";
import { create } from "zustand";
import { api } from "./lib/api";
import { steppedJob } from "./lib/jobs";
import { useStore } from "./store";
import { usePlugins } from "./plugins/store";
import type { MediaItem, VersionInfo, VersionLink } from "./lib/types";

/**
 * Versions: each picture made from another (an edit's result, a plugin's) and what it was made
 * from, both known by content fingerprint, so the link follows either through any move. The backend
 * keeps them with the library (see versions.rs), and the originals it replaced, for Revert. Read here
 * for the duplicate check and Import, which know pictures by fingerprint too.
 */
interface VersionsStore {
  /** A version's fingerprint → what it was made from. */
  links: Record<string, VersionLink>;
  linksFor: string | null;
  /** Read again after anything that makes, reverts or forgets versions. */
  load(force?: boolean): Promise<void>;
}

export const useVersions = create<VersionsStore>((set, get) => ({
  links: {},
  linksFor: null,
  async load(force = false) {
    const root = useStore.getState().root;
    if (!root || (!force && get().linksFor === root)) return;
    const doc = await api.versionsLoad(root).catch(() => null);
    if (useStore.getState().root !== root) return;
    set({ links: doc?.links ?? {}, linksFor: root });
  },
}));

/** Each version with the picture it was made from, by fingerprint, as the duplicate check pairs them. */
export function versionPairs(links: Record<string, VersionLink>): { made: string; from: string; note: string }[] {
  return Object.entries(links).map(([made, l]) => ({ made, from: l.from, note: l.note }));
}

/** What is known of an item as a version or an original; null when it is neither (or no picture here is). */
export function useVersionInfo(item: MediaItem | null | undefined): VersionInfo | null {
  const root = useStore((s) => s.root);
  const links = useVersions((s) => s.links);
  const [info, setInfo] = useState<VersionInfo | null>(null);
  useEffect(() => {
    void useVersions.getState().load();
  }, [root]);
  const path = item?.primary;
  const modified = item?.modified;
  useEffect(() => {
    setInfo(null);
    if (!root || !path || !Object.keys(links).length) return;
    let live = true;
    api
      .versionInfo(root, path)
      .then((i) => live && setInfo(i.fp ? i : null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [root, path, modified, links]);
  return info;
}

/**
 * While O is on (the plugins' overlays off: what is underneath shows), the picture an item was made
 * from, kept or beside it, as a URL to show in its place.
 */
export function useOriginalShown(item: MediaItem): string | null {
  const on = usePlugins((s) => s.overlaysHidden);
  const info = useVersionInfo(on ? item : null);
  const root = useStore((s) => s.root);
  const path = info?.kept ?? info?.original ?? null;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!root || !path) return;
    let live = true;
    let made: string | null = null;
    api
      .readMediaImage(root, path)
      .then((buf) => {
        if (!live) return;
        made = URL.createObjectURL(new Blob([buf]));
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [root, path]);
  return url;
}

/**
 * Pictures back to the originals kept for them (a Browse selection, an album's pages), as a job in
 * Activity: each version to the trash, ⌘Z undoing the last ones one by one. Those with no original
 * kept stay as they are. How many went back.
 */
export async function revertAll(items: MediaItem[], what = `${items.length} pictures`): Promise<number> {
  const st = useStore.getState();
  const root = st.root;
  if (!root || !items.length) return 0;
  const { job, gate } = steppedJob({ title: `Reverting ${what}`, source: "Versions", total: items.length });
  let n = 0;
  let failed = 0;
  try {
    for (let k = 0; k < items.length; k++) {
      if (!(await gate.pass())) break;
      const it = items[k];
      job.update({ done: k, detail: `${k + 1} of ${items.length}: ${it.name}`, items: [{ key: it.key, name: it.name }] });
      const info = await api.versionInfo(root, it.primary).catch(() => null);
      if (!info?.kept) continue;
      if (await useStore.getState().revertItem(it, true)) n++;
      else failed++;
    }
  } finally {
    job.finish();
  }
  await useVersions.getState().load(true);
  const back = n ? `Back to the originals of ${n} picture${n === 1 ? "" : "s"}; the versions are in the trash` : "None of them has an original kept to go back to";
  st.toast(failed ? `${back}. ${failed} couldn't be reverted.` : back, failed ? "warn" : n ? "ok" : "info");
  return n;
}
