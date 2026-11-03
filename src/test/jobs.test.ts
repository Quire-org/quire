import { describe, expect, it, vi } from "vitest";

const invoked = vi.hoisted(() => [] as [string, unknown][]);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async (cmd: string, args: unknown) => void invoked.push([cmd, args])), convertFileSrc: (p: string) => p, Channel: class {} }));

const { backendJob, can, startJob, steppedJob, useJobs } = await import("../lib/jobs");
const { buildJobs } = await import("../lib/activity");

const idle = { running: false, paused: false, progress: { stage: "idle", done: 0, total: 0, eta: null } } as never;
const noIndex = { indexing: null, indexPaused: false };
const shown = () => buildJobs(idle, noIndex, [], () => "", useJobs.getState().jobs);
const noControls = { pause: { cannot: "test" }, stop: { cannot: "test" } };

describe("jobs in Activity", () => {
  it("every job says how far it is and how it pauses and stops; the types refuse one that doesn't", () => {
    // @ts-expect-error no total, pause or stop
    void (() => startJob({ title: "x", source: "y" }));
    // @ts-expect-error no stop
    void (() => startJob({ title: "x", source: "y", total: 1, pause: () => {} }));
    // @ts-expect-error a control left out must say why
    void (() => startJob({ title: "x", source: "y", total: 1, pause: {}, stop: () => {} }));
    const ok = startJob({ title: "x", source: "y", total: { unknown: "one step" }, pause: { cannot: "one step" }, stop: () => {} });
    const [j] = shown();
    expect(j).toMatchObject({ unknown: "one step", pause: { cannot: "one step" } });
    expect(can(j.pause)).toBe(false);
    expect(can(j.stop)).toBe(true);
    ok.finish();
  });

  it("draws progress a few times a second and the end at once", () => {
    vi.useFakeTimers();
    const job = startJob({ title: "Backing up", source: "Backup", total: 0, bytes: true, ...noControls });
    job.update({ done: 10, total: 100, detail: "photos/a.jpg", items: [{ key: "photos/a.jpg" }] });
    job.update({ done: 20, total: 100 });
    expect(useJobs.getState().jobs[0].done).toBe(0); // batched
    vi.advanceTimersByTime(200);
    expect(useJobs.getState().jobs[0]).toMatchObject({ done: 20, total: 100, detail: "photos/a.jpg" });
    job.update({ done: 100, total: 100 });
    expect(useJobs.getState().jobs[0].done).toBe(100);
    job.finish();
    expect(useJobs.getState().jobs).toEqual([]);
    vi.useRealTimers();
  });

  it("a stepped job holds before its next step while paused, and ends there when stopped", async () => {
    const { job, gate } = steppedJob({ title: "Reading album languages", source: "Albums", total: 5 });
    const done: number[] = [];
    const run = (async () => {
      for (let k = 0; k < 5; k++) {
        if (!(await gate.pass())) break;
        done.push(k);
        job.update({ done: k + 1 });
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    await new Promise((r) => setTimeout(r, 8));
    const [j] = shown();
    if (!can(j.pause)) throw new Error("pausable");
    j.pause(true);
    expect(shown()[0]).toMatchObject({ paused: true, state: "paused" });
    const at = done.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(done.length).toBeLessThanOrEqual(at + 1); // at most the step already under way
    j.pause(false);
    await new Promise((r) => setTimeout(r, 8));
    expect(done.length).toBeGreaterThan(at);
    const s = shown()[0].stop;
    if (!can(s)) throw new Error("stoppable");
    s();
    expect(shown()[0]).toMatchObject({ stopping: true, state: "stopping" });
    await run;
    expect(done.length).toBeLessThan(5);
    job.finish();
  });

  it("a backend job's Pause and Stop go to its command by id", () => {
    invoked.length = 0;
    const { job, id } = backendJob({ title: "Encrypting the library", source: "Vault", total: 0, bytes: true });
    const [j] = shown();
    if (!can(j.pause) || !can(j.stop)) throw new Error("controls");
    j.pause(true);
    j.pause(false);
    j.stop();
    j.stop(); // once is enough
    expect(invoked).toEqual([
      ["job_pause", { id, on: true }],
      ["job_pause", { id, on: false }],
      ["job_stop", { id }],
    ]);
    job.finish();
  });
});
