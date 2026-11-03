import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Album, MediaItem } from "../lib/types";
import type { PluginInfo } from "../plugins/types";

const calls = vi.hoisted(() => ({ scan: [] as string[], read: [] as string[] }));

const page = (name: string): MediaItem =>
  ({ key: `Albums/Book/${name}.png`, primary: `/vol/Albums/Book/${name}.png`, files: [`/vol/Albums/Book/${name}.png`], kind: "image", name, dir: "Albums/Book", size: 1, modified: 0, hasRaw: false, hasVideo: false }) as MediaItem;

vi.mock("../lib/api", () => ({
  api: {
    scanDir: vi.fn(async (_root: string, dir: string) => {
      calls.scan.push(dir);
      return [page("10"), page("2"), page("1")];
    }),
    readMediaImage: vi.fn(async (_root: string, path: string) => {
      calls.read.push(path);
      return new ArrayBuffer(4);
    }),
  },
  fileSrc: (p: string) => "file://" + p,
  mediaUrl: (i: { primary: string }) => "file://" + i.primary,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { dispatch, cancelTask, pauseTask, registerFrame } = await import("../plugins/host");
const { useStore } = await import("../store");
const { usePlugins } = await import("../plugins/store");

function plugin(permissions: string[]): PluginInfo {
  return {
    id: "demo",
    dir: "/x",
    manifest: { id: "demo", name: "Demo", version: "1.0.0", description: "", author: "", entry: "index.js", permissions, settings: [] },
    state: { enabled: true, allowVault: false, granted: permissions, source: "", installedAt: 0 },
  };
}

const album = { key: "Albums/Book", path: "/vol/Albums/Book", name: "Book", albumRoot: "Albums", count: 3 } as Album;

beforeEach(() => {
  calls.scan.length = 0;
  calls.read.length = 0;
  useStore.setState({ root: "/vol", queue: [], index: 0, screen: "albums", allItems: [], unsorted: [], albums: [album], vault: null } as never);
  usePlugins.setState({ tasks: [], buttons: [], overlays: {} } as never);
});

describe("album pages", () => {
  // Listed pages stay reachable for the session, so this runs first.
  it("lists an album's pages in reading order, only with media:read, and the other calls can reach them", async () => {
    const p = plugin(["media:read"]);
    await expect(dispatch(p, "media.readImage", { itemKey: "Albums/Book/2.png" })).rejects.toThrow(/unknown item/);
    await expect(dispatch(plugin([]), "media.album", { albumKey: album.key })).rejects.toThrow(/media:read/);
    const pages = (await dispatch(p, "media.album", { albumKey: album.key })) as { key: string; albumKey: string }[];
    expect(calls.scan).toEqual([album.path]);
    expect(pages.map((x) => x.key)).toEqual(["Albums/Book/1.png", "Albums/Book/2.png", "Albums/Book/10.png"]);
    expect(pages[0].albumKey).toBe(album.key);
    await dispatch(p, "media.readImage", { itemKey: "Albums/Book/2.png" });
    expect(calls.read).toEqual(["/vol/Albums/Book/2.png"]);
  });

  it("refuses albums it doesn't know", async () => {
    await expect(dispatch(plugin(["media:read"]), "media.album", { albumKey: "Albums/Nope" })).rejects.toThrow(/unknown album/);
  });
});

describe("tasks", () => {
  it("shows, updates and ends a task", async () => {
    const p = plugin([]);
    await dispatch(p, "ui.progress", { id: "job", task: { label: "Reading the book", done: 0, total: 3 } });
    const [shown] = usePlugins.getState().tasks;
    expect(shown).toMatchObject({ pluginId: "demo", id: "job", label: "Reading the book", done: 0, total: 3, stopping: false });
    await dispatch(p, "ui.progress", { id: "job", task: { label: "Reading the book", done: 2, total: 3, detail: "EN 2.png" } });
    expect(usePlugins.getState().tasks).toHaveLength(1);
    expect(usePlugins.getState().tasks[0]).toMatchObject({ done: 2, detail: "EN 2.png", started: shown.started });
    await dispatch(p, "ui.progress", { id: "job", task: null });
    expect(usePlugins.getState().tasks).toEqual([]);
  });

  it("names the item it is on, and shows up in Activity with the others", async () => {
    const p = plugin([]);
    await dispatch(p, "ui.progress", { id: "job", task: { label: "Cleaning pages", done: 1, total: 4, item: "A/2.jpg" } });
    expect(usePlugins.getState().tasks[0].itemKey).toBe("A/2.jpg");
    const { buildJobs } = await import("../lib/activity");
    const jobs = buildJobs(
      { running: true, paused: false, progress: { stage: "images", done: 3, total: 10, eta: 20, workers: [{ key: "x.jpg", name: "x.jpg" }] } },
      { indexing: { done: 5, total: 50, current: "y.jpg", key: "y.jpg", eta: 60 }, indexPaused: true },
      usePlugins.getState().tasks,
      () => "Page Cleaner",
    );
    expect(jobs.map((j) => j.id)).toEqual(["dupes", "tags", "plugin:demo:job"]);
    expect(jobs[0].items).toEqual([{ key: "x.jpg", name: "x.jpg", note: undefined }]);
    expect(jobs[1]).toMatchObject({ paused: true, state: "paused", items: [{ key: "y.jpg", name: "y.jpg" }] });
    expect(jobs[2]).toMatchObject({ title: "Cleaning pages", source: "Page Cleaner", items: [{ key: "A/2.jpg" }] });
    await dispatch(p, "ui.progress", { id: "job", task: null });
  });

  it("keeps a plugin to three tasks", async () => {
    const p = plugin([]);
    for (const id of ["a", "b", "c"]) await dispatch(p, "ui.progress", { id, task: { label: id, done: 0, total: 1 } });
    await expect(dispatch(p, "ui.progress", { id: "d", task: { label: "d", done: 0, total: 1 } })).rejects.toThrow(/at most 3/);
    await dispatch(p, "ui.progress", { id: "a", task: { label: "a", done: 1, total: 1 } });
  });

  it("asks the plugin to stop on Cancel, and the task goes with the plugin", async () => {
    const posted: unknown[] = [];
    registerFrame("demo", { contentWindow: { postMessage: (m: unknown) => posted.push(m) } } as unknown as HTMLIFrameElement);
    await dispatch(plugin([]), "ui.progress", { id: "job", task: { label: "Reading the book", done: 1, total: 3 } });
    cancelTask("demo", "job");
    expect(usePlugins.getState().tasks[0].stopping).toBe(true);
    expect(posted).toEqual([{ type: "event", name: "cancel", payload: { id: "job" } }]);
    usePlugins.getState().clearRuntime("demo");
    expect(usePlugins.getState().tasks).toEqual([]);
    registerFrame("demo", null);
  });

  it("pauses a job the plugin says can pause, and says why for one that can't", async () => {
    const posted: unknown[] = [];
    registerFrame("demo", { contentWindow: { postMessage: (m: unknown) => posted.push(m) } } as unknown as HTMLIFrameElement);
    await dispatch(plugin([]), "ui.progress", { id: "job", task: { label: "Reading the book", done: 1, total: 3, pausable: true } });
    await dispatch(plugin([]), "ui.progress", { id: "page", task: { label: "This page", done: 0, total: 2 } });
    const { buildJobs } = await import("../lib/activity");
    const { can } = await import("../lib/jobs");
    const idle = { running: false, paused: false, progress: { stage: "idle", done: 0, total: 0, eta: null } } as never;
    const [job, page] = buildJobs(idle, { indexing: null, indexPaused: false }, usePlugins.getState().tasks, () => "Page Reader");
    if (!can(job.pause)) throw new Error("the album job can pause");
    expect(page.pause).toEqual({ cannot: "Page Reader can't pause this job." });
    expect(can(page.stop)).toBe(true);
    job.pause(true);
    expect(usePlugins.getState().tasks[0].paused).toBe(true);
    pauseTask("demo", "job", false);
    expect(posted).toEqual([
      { type: "event", name: "pause", payload: { id: "job", paused: true } },
      { type: "event", name: "pause", payload: { id: "job", paused: false } },
    ]);
    usePlugins.getState().clearRuntime("demo");
    registerFrame("demo", null);
  });
});
