import { useMemo } from "react";
import { useDupes } from "../dupesStore";
import { useTags } from "../tagsStore";
import { usePlugins } from "../plugins/store";
import { cancelTask, pauseTask } from "../plugins/host";
import { useStore } from "../store";
import type { PluginTask } from "../plugins/types";
import { useJobs, type Control, type RunningJob } from "./jobs";

/** Something long running, in one shape whatever does it: the duplicate scan, tag indexing, a plugin's job. */
export interface Job {
  id: string;
  title: string;
  /** Who runs it: Duplicates, Tags, or the plugin's name. */
  source: string;
  done: number;
  total: number;
  /** Why it can't count, when it can't (a single step). */
  unknown?: string;
  /** done and total are bytes. */
  bytes?: boolean;
  /** done and total are a percentage. */
  percent?: boolean;
  /** Seconds left when last reported (counted down on screen). */
  eta: number | null;
  /** The step it is on, or what it is doing now. */
  state?: string;
  detail?: string;
  paused?: boolean;
  stopping?: boolean;
  /** What it is working on right now, as thumbnails (note: e.g. "frame 12/40"). */
  items: { key: string; name?: string; note?: string }[];
  /** Every job has both: the control, or why it can't be offered (docs/activity.md). */
  pause: Control<(on: boolean) => void>;
  stop: Control<() => void>;
  open?: { label: string; go: () => void };
}

type DupesState = ReturnType<typeof useDupes.getState>;
type TagsState = ReturnType<typeof useTags.getState>;

/** The jobs from each source; kept pure so it can be tested. */
export function buildJobs(
  dupes: Pick<DupesState, "running" | "paused" | "progress">,
  tags: Pick<TagsState, "indexing" | "indexPaused">,
  tasks: PluginTask[],
  pluginName: (id: string) => string,
  running: RunningJob[] = [],
): Job[] {
  const jobs: Job[] = [];
  if (dupes.running) {
    const p = dupes.progress;
    const workers = p.workers ?? [];
    const matching = p.stage === "matching";
    jobs.push({
      id: "dupes",
      title: "Duplicate scan",
      source: "Duplicates",
      done: p.done,
      total: p.total,
      percent: matching,
      eta: p.eta,
      state: dupes.paused ? "paused" : p.stage === "images" ? "fingerprinting" : p.stage,
      detail: p.detail,
      paused: dupes.paused,
      items: workers.length ? workers.map((w) => ({ key: w.key, name: w.name, note: w.frames != null ? `frame ${w.frame ?? 0}/${w.frames}` : undefined })) : p.key ? [{ key: p.key }] : [],
      // The last step, matching, takes moments and runs in one go.
      pause: matching ? { cannot: "Matching takes a moment; it can only be stopped." } : (on) => useDupes.getState().pause(on),
      stop: () => useDupes.getState().cancel(),
      open: { label: "Open Duplicates", go: () => useStore.getState().openDupes() },
    });
  }
  const ix = tags.indexing;
  if (ix) {
    jobs.push({
      id: "tags",
      title: "Indexing for tags",
      source: "Tags",
      done: ix.done,
      total: ix.total,
      eta: ix.eta,
      state: tags.indexPaused ? "paused" : "reading pictures",
      detail: ix.failed ? `${ix.failed} could not be read${ix.lastError ? `: ${ix.lastError}` : ""}` : ix.current || undefined,
      paused: tags.indexPaused,
      items: ix.key ? [{ key: ix.key, name: ix.current || undefined }] : [],
      pause: (on) => useTags.getState().pauseIndex(on),
      stop: () => useTags.getState().cancelIndex(),
      open: { label: "Open Tags", go: () => useStore.getState().openTags() },
    });
  }
  for (const t of tasks) {
    // From how long the steps so far took.
    const eta = t.done > 0 && t.total > t.done ? Math.round(((t.updated - t.started) / 1000 / t.done) * (t.total - t.done)) : null;
    jobs.push({
      id: `plugin:${t.pluginId}:${t.id}`,
      title: t.label,
      source: pluginName(t.pluginId),
      done: t.done,
      total: t.total,
      eta,
      state: t.stopping ? "stopping after this one" : t.paused ? "paused" : undefined,
      detail: t.detail || undefined,
      paused: t.paused,
      stopping: t.stopping,
      items: t.itemKey ? [{ key: t.itemKey }] : [],
      // A plugin says whether its job can pause (ms.ui.progress … pausable); stopping it always can.
      pause: t.pausable ? (on) => pauseTask(t.pluginId, t.id, on) : { cannot: `${pluginName(t.pluginId)} can't pause this job.` },
      stop: () => cancelTask(t.pluginId, t.id),
    });
  }
  // The app's own long jobs (lib/jobs.ts): vault, backup, downloads, edits…
  for (const r of running) {
    const eta = r.done > 0 && r.total > r.done ? Math.round(((r.updated - r.started - r.pausedFor) / 1000 / r.done) * (r.total - r.done)) : null;
    jobs.push({
      id: r.id,
      title: r.title,
      source: r.source,
      done: r.done,
      total: r.total,
      bytes: r.bytes,
      percent: r.percent,
      unknown: r.unknown,
      eta,
      state: r.stopping ? "stopping" : r.paused ? "paused" : undefined,
      detail: r.detail,
      paused: r.paused,
      stopping: r.stopping,
      items: r.items,
      pause: r.pause,
      stop: r.stop,
      open: r.open,
    });
  }
  return jobs;
}

/** Everything running now. */
export function useActivity(): Job[] {
  const running = useDupes((d) => d.running);
  const paused = useDupes((d) => d.paused);
  const progress = useDupes((d) => d.progress);
  const indexing = useTags((t) => t.indexing);
  const indexPaused = useTags((t) => t.indexPaused);
  const tasks = usePlugins((p) => p.tasks);
  const plugins = usePlugins((p) => p.list);
  const own = useJobs((j) => j.jobs);
  return useMemo(
    () => buildJobs({ running, paused, progress }, { indexing, indexPaused }, tasks, (id) => plugins.find((p) => p.id === id)?.manifest?.name ?? id, own),
    [running, paused, progress, indexing, indexPaused, tasks, plugins, own],
  );
}

/** Done out of total over every job, 0..1, or null when none knows its size yet. */
export function overall(jobs: Job[]): number | null {
  const total = jobs.reduce((a, j) => a + j.total, 0);
  return total ? Math.min(1, jobs.reduce((a, j) => a + Math.min(j.done, j.total), 0) / total) : null;
}
