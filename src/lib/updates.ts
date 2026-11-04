/**
 * Updates, the app's own and its plugins': checked when asked (Settings › Updates), and when a
 * library opens if that is turned on (off at first, as checking goes online). What is found waits there:
 * the app's new version is downloaded when asked, as a job in Activity, and put in place with a
 * restart once nothing is running; plugins whose update asks for nothing new update together.
 * The setting is kept with the library (see librarySettings).
 */
import { create } from "zustand";
import { api } from "./api";
import { steppedJob, useJobs } from "./jobs";
import { flushAll } from "./pending";
import { usePlugins } from "../plugins/store";
import { useStore } from "../store";
import type { AppBuild, AppUpdate } from "./types";

const KEY = "quire.updates";

function loadAuto(): boolean {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}").auto === true;
  } catch {
    return false;
  }
}

interface UpdatesState {
  /** Check when a library opens. */
  auto: boolean;
  build: AppBuild | null;
  /** A newer version of the app, from the last check. */
  app: AppUpdate | null;
  /** Why the app's check failed, when it did. */
  appError: string | null;
  checking: boolean;
  /** When the last check was, ms since epoch. */
  checked: number | null;
  downloading: boolean;
  setAuto(on: boolean): void;
  loadBuild(): Promise<AppBuild | null>;
  /** Quiet (the check as the app opens): says something only when there is something new. */
  check(quiet?: boolean): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  /** Plugins whose update asks for nothing new, one after another, as a job in Activity. */
  updatePlugins(ids: string[]): Promise<void>;
}

const toast: (text: string, tone?: "ok" | "warn" | "error") => void = (text, tone) => useStore.getState().toast(text, tone);

/** The plugins with a newer version found, by the last check. */
export const pluginUpdates = (updates: ReturnType<typeof usePlugins.getState>["updates"]) => Object.values(updates).flatMap((r) => (r.update ? [r.update] : []));

/** How many updates are waiting: the app's and its plugins'. */
export function useUpdateCount(): number {
  const app = useUpdates((u) => !!u.app);
  const plugins = usePlugins((p) => pluginUpdates(p.updates).length);
  return (app ? 1 : 0) + plugins;
}

export const useUpdates = create<UpdatesState>((set, get) => ({
  auto: loadAuto(),
  build: null,
  app: null,
  appError: null,
  checking: false,
  checked: null,
  downloading: false,

  setAuto(on) {
    set({ auto: on });
    try {
      localStorage.setItem(KEY, JSON.stringify({ auto: on }));
    } catch {
      /* kept for this run only */
    }
    useStore.getState().keepSettings({ updates: { auto: on } });
  },

  async loadBuild() {
    const build = get().build ?? (await api.appBuild().catch(() => null));
    set({ build });
    return build;
  },

  async check(quiet = false) {
    if (get().checking) return;
    set({ checking: true });
    const build = await get().loadBuild();
    const [app, plugins] = await Promise.all([
      build && !build.cannot ? api.appUpdateCheck().then((a) => ({ a, e: null }), (e) => ({ a: null, e: String(e) })) : Promise.resolve({ a: null, e: null }),
      api.pluginCheckUpdates().catch(() => null),
    ]);
    if (plugins) usePlugins.setState({ updates: Object.fromEntries(plugins.map((r) => [r.id, r])) });
    // A version already downloaded stays so, when the same one is found again.
    set({ app: app.a, appError: app.e, checking: false, checked: Date.now() });
    const names = [...(app.a ? [`Quire ${app.a.version}`] : []), ...(plugins ?? []).flatMap((r) => (r.update ? [`${r.update.manifest.name} ${r.update.latest}`] : []))];
    if (names.length) toast(`${quiet ? "Updates ready" : "New"}: ${names.join(", ")}. See Settings › Updates.`, "ok");
    else if (!quiet) toast(app.e ? `Couldn't check for a new Quire: ${app.e}` : "Everything is up to date", app.e ? "warn" : "ok");
  },

  async download() {
    const a = get().app;
    if (!a || get().downloading) return;
    set({ downloading: true });
    try {
      await api.appUpdateDownload(a.version);
      set({ app: { ...a, downloaded: true } });
      toast(`Quire ${a.version} is downloaded: it goes in place when you restart.`, "ok");
    } catch (e) {
      if (String(e) !== "stopped") toast(`The download stopped: ${String(e)}`, "error");
    } finally {
      set({ downloading: false });
    }
  },

  async install() {
    const running = useJobs.getState().jobs.length;
    if (running) return toast(`Waiting for ${running} job${running === 1 ? "" : "s"} in Activity to finish first.`, "warn");
    // What is still waiting to be written goes first: the restart can't wait for it.
    await flushAll();
    try {
      await api.appUpdateInstall();
    } catch (e) {
      toast(`The update didn't go in place: ${String(e)}`, "error");
    }
  },

  async updatePlugins(ids) {
    if (!ids.length) return;
    const names = (id: string) => usePlugins.getState().updates[id]?.update?.manifest.name ?? id;
    const { job, gate } = steppedJob({ title: `Updating ${ids.length} plugin${ids.length === 1 ? "" : "s"}`, source: "Updates", total: ids.length });
    const done: string[] = [];
    const failed: string[] = [];
    try {
      for (const id of ids) {
        if (!(await gate.pass())) break;
        job.update({ detail: names(id) });
        try {
          await api.pluginUpdate(id, false);
          done.push(names(id));
          const rest = { ...usePlugins.getState().updates };
          delete rest[id];
          usePlugins.setState({ updates: rest });
        } catch (e) {
          failed.push(`${names(id)} (${String(e)})`);
        }
        job.update({ done: done.length + failed.length });
      }
    } finally {
      job.finish();
      await usePlugins.getState().refresh();
    }
    if (failed.length) toast(`Not updated: ${failed.join(", ")}`, "error");
    else if (done.length) toast(`Updated ${done.join(", ")}`, "ok");
  },
}));
