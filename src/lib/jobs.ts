import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

/**
 * Long jobs the app runs, for Activity (the progress ring at the top). The rule (docs/activity.md):
 * anything that can take more than a moment shows here, says how far it is, and can be paused and
 * stopped. The types make every job decide all three. A control may only be left out by saying why
 * it can't be offered (`{ cannot: "…" }`), which Activity shows on the disabled button.
 *
 * Jobs run step by step here:            Jobs run by one backend command:
 *   const { job, gate } = steppedJob({…});   const { job, id } = backendJob({…});
 *   for (const x of list) {                  invoke("…", { …, job: id })   // the command calls go_on()
 *     if (!(await gate.pass())) break;       job.update(…) from its progress; job.finish() at the end
 *     job.update({ done, detail, items });
 *   }
 *   job.finish();
 */

/** A control a job offers, or why it can't. */
export type Control<F> = F | { cannot: string };
export const can = <F,>(c: Control<F>): c is F => typeof c === "function";

export interface JobInit {
  title: string;
  /** Where it runs from: Vault, Backup, Albums… */
  source: string;
  /** What `done` counts up to (files, bytes, percent…). Only a single step that can't count says why. */
  total: number | { unknown: string };
  /** done and total are bytes (shown as sizes). */
  bytes?: boolean;
  /** done and total are a percentage (shown as one). */
  percent?: boolean;
  /** Pause (true) and resume (false). */
  pause: Control<(paused: boolean) => void>;
  /** Stop; what is done stays done. */
  stop: Control<() => void>;
  open?: { label: string; go: () => void };
}

export interface RunningJob {
  id: string;
  title: string;
  source: string;
  done: number;
  total: number;
  /** Why it can't count, when it can't. */
  unknown?: string;
  bytes?: boolean;
  percent?: boolean;
  detail?: string;
  /** What it is on now, by item key, for thumbnails. */
  items: { key: string; name?: string; note?: string }[];
  /** For the time left (paused time left out). */
  started: number;
  updated: number;
  pausedFor: number;
  paused: boolean;
  stopping: boolean;
  pause: Control<(paused: boolean) => void>;
  stop: Control<() => void>;
  open?: { label: string; go: () => void };
}

export interface JobHandle {
  readonly id: string;
  update(patch: Partial<Pick<RunningJob, "done" | "total" | "detail" | "items">>): void;
  finish(): void;
}

export const useJobs = create<{ jobs: RunningJob[] }>(() => ({ jobs: [] }));

let next = 0;

export function startJob(init: JobInit): JobHandle {
  const id = `job-${++next}`;
  const now = Date.now();
  const patch = (p: Partial<RunningJob>) => useJobs.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }));
  const get = () => useJobs.getState().jobs.find((j) => j.id === id);
  let pausedAt = 0;
  // Pressing Pause or Stop shows at once, whatever the job does with it.
  const pause = can(init.pause)
    ? (on: boolean) => {
        const j = get();
        if (!j || j.paused === on || j.stopping) return;
        if (on) pausedAt = Date.now();
        patch({ paused: on, ...(on ? {} : { pausedFor: j.pausedFor + (Date.now() - pausedAt) }) });
        (init.pause as (p: boolean) => void)(on);
      }
    : init.pause;
  const stop = can(init.stop)
    ? () => {
        const j = get();
        if (!j || j.stopping) return;
        patch({ stopping: true, paused: false });
        (init.stop as () => void)();
      }
    : init.stop;
  const unknown = typeof init.total === "object" ? init.total.unknown : undefined;
  const job: RunningJob = {
    id,
    title: init.title,
    source: init.source,
    done: 0,
    total: typeof init.total === "number" ? init.total : 0,
    unknown,
    bytes: init.bytes,
    percent: init.percent,
    items: [],
    started: now,
    updated: now,
    pausedFor: 0,
    paused: false,
    stopping: false,
    pause,
    stop,
    open: init.open,
  };
  useJobs.setState((s) => ({ jobs: [...s.jobs, job] }));
  // Progress can come many times a second: drawn at most every 150 ms (and always at the end).
  let pending: Partial<RunningJob> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (pending) patch({ ...pending, updated: Date.now() });
    pending = null;
  };
  return {
    id,
    update(p) {
      pending = { ...(pending ?? {}), ...p };
      if (p.total != null && p.done != null && p.done >= p.total) return flush();
      timer ??= setTimeout(flush, 150);
    },
    finish() {
      if (timer) clearTimeout(timer);
      useJobs.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
    },
  };
}

/** Holds a job between its steps while paused, and ends it at the next step once stopped. */
export class Gate {
  private paused = false;
  stopped = false;
  private waiting: (() => void)[] = [];
  pause(on: boolean) {
    this.paused = on;
    if (!on) this.wake();
  }
  stop() {
    this.stopped = true;
    this.wake();
  }
  private wake() {
    const w = this.waiting;
    this.waiting = [];
    w.forEach((f) => f());
  }
  /** Before a step: waits while paused; false once stopped. */
  async pass(): Promise<boolean> {
    while (this.paused && !this.stopped) await new Promise<void>((r) => this.waiting.push(r));
    return !this.stopped;
  }
}

/** A job done step by step in the app: Pause holds it before the next step, Stop ends it there. */
export function steppedJob(init: Omit<JobInit, "pause" | "stop"> & { onPause?: (paused: boolean) => void; onStop?: () => void }): { job: JobHandle; gate: Gate } {
  const gate = new Gate();
  const job = startJob({
    ...init,
    pause: (on) => {
      gate.pause(on);
      init.onPause?.(on);
    },
    stop: () => {
      gate.stop();
      init.onStop?.();
    },
  });
  return { job, gate };
}

/**
 * A job one backend command runs: give it `job: id`, and Activity's Pause and Stop reach it there
 * (the command waits or stops at its next step, see jobctl.rs). Stop can be swapped for the
 * command's own (a download's, which also cleans up).
 */
export function backendJob(init: Omit<JobInit, "pause" | "stop"> & { stop?: JobInit["stop"] }): { job: JobHandle; id: string } {
  const id = `backend-${Date.now()}-${++next}`;
  const job = startJob({
    ...init,
    pause: (on) => void invoke("job_pause", { id, on }).catch(() => {}),
    stop: init.stop ?? (() => void invoke("job_stop", { id }).catch(() => {})),
  });
  return { job, id };
}
