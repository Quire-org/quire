import { create } from "zustand";
import { api } from "../lib/api";
import type { LogLine, OverlayBox, PanelControl, PluginButton, PluginDupeVersions, PluginInfo, PluginPanel, PluginTask, SharedPart, UpdateCheck } from "./types";
import type { Stroke } from "./brush";
import { RADIUS } from "./brush";
import { dropFinder, libraryRoot } from "./find";

/** Where the open library keeps the sites the reader allowed a plugin: a key of the app's own in the plugin's library store. */
export const SITES_KEY = "__sites";

interface DirectionEntry {
  pluginId: string;
  albumKey: string | null;
  dir: "ltr" | "rtl";
}

interface PluginsStore {
  list: PluginInfo[];
  loaded: boolean;
  buttons: PluginButton[];
  /** itemKey -> pluginId -> boxes */
  overlays: Record<string, Record<string, OverlayBox[]>>;
  /** Long jobs plugins are running, shown at the top. */
  tasks: PluginTask[];
  /** What plugins share on the Home (`home.share`): by shared panel, then plugin. */
  shared: Record<string, Record<string, SharedPart>>;
  setShared(panel: string, pluginId: string, part: SharedPart | null): void;
  /** Versions of pictures plugins make, for the duplicate check (`dupes.versions`), by plugin. */
  dupeVersions: Record<string, PluginDupeVersions>;
  setDupeVersions(pluginId: string, v: PluginDupeVersions | null): void;
  /** A plugin asking the reader to mark part of the viewer's image (`viewer.pickArea`). */
  /** Each plugin's panel for the viewer, and whose is open. */
  panels: Record<string, PluginPanel>;
  panelOpen: string | null;
  setPanel(pluginId: string, panel: PluginPanel | null): void;
  patchControl(pluginId: string, id: string, patch: Partial<PanelControl>): void;
  setPanelOpen(pluginId: string | null): void;
  /** The open panel's brush: its strokes on the image shown, the brush size, the image's aspect. */
  brush: { itemKey: string | null; strokes: Stroke[]; radius: number; aspect: number };
  setBrush(fn: (b: PluginsStore["brush"]) => PluginsStore["brush"]): void;
  /** An eyedropper waiting for a click on the image, for this control. */
  colourPick: { pluginId: string; id: string } | null;
  setColourPick(pick: PluginsStore["colourPick"]): void;
  /** A plugin's result waiting for the reader to choose: a new file next to the item, or in its place. */
  keeping: { pluginId: string; itemKey: string; name: string; busy: boolean } | null;
  setKeeping(keeping: PluginsStore["keeping"]): void;
  overlaysHidden: boolean;
  directions: DirectionEntry[];
  logs: Record<string, LogLine[]>;
  /** Bumped to recreate a plugin's frame. */
  nonce: Record<string, number>;
  updates: Record<string, UpdateCheck>;
  refresh(): Promise<void>;
  /** Sites the reader allowed each plugin (with `sites`) for the library open: kept with it, in its vault when it has one. */
  sites: Record<string, string[]>;
  /** The open library's sites for each plugin that may have some: read from it, told the backend; a plugin whose sites changed starts again. */
  loadSites(root: string | null): Promise<void>;
  /** A plugin's sites now: told the backend, and kept with the library open. */
  setSites(id: string, sites: string[]): Promise<string[]>;
  byId(id: string): PluginInfo | undefined;
  reload(id: string): void;
  /** Forget everything a plugin registered (on reload, disable, uninstall). */
  clearRuntime(id: string): void;
  log(id: string, level: string, message: string): void;
  setButtons(fn: (b: PluginButton[]) => PluginButton[]): void;
  /** Show, update or (with null) end a plugin's task. */
  setTask(pluginId: string, id: string, patch: Pick<PluginTask, "label" | "done" | "total" | "detail" | "itemKey" | "pausable"> | { stopping: true } | { paused: boolean } | null): void;
  setOverlay(itemKey: string, pluginId: string, boxes: OverlayBox[] | null): void;
  clearOverlays(pluginId: string, itemKey: string | null): void;
  setDirection(pluginId: string, dir: "ltr" | "rtl", albumKey: string | null): void;
  toggleOverlays(): void;
}

export const usePlugins = create<PluginsStore>((set, get) => ({
  list: [],
  loaded: false,
  buttons: [],
  overlays: {},
  tasks: [],
  dupeVersions: {},
  shared: {},
  panels: {},
  panelOpen: null,
  brush: { itemKey: null, strokes: [], radius: RADIUS.start, aspect: 1 },
  colourPick: null,
  keeping: null,
  overlaysHidden: false,
  directions: [],
  logs: {},
  nonce: {},
  sites: {},
  updates: {},

  async refresh() {
    try {
      const sites = get().sites;
      const list = (await api.pluginList()).map((p) => ({ ...p, sites: sites[p.id] ?? [] }));
      const before = get().list;
      set({ list, loaded: true });
      // Plugins that are gone or disabled lose their buttons and overlays.
      for (const p of before) {
        const now = list.find((x) => x.id === p.id);
        if (!now || !now.state.enabled || now.manifest?.version !== p.manifest?.version) get().clearRuntime(p.id);
      }
    } catch (e) {
      set({ loaded: true });
      console.warn("plugins:", e);
    }
  },

  async loadSites(root) {
    const wanted = get().list.filter((p) => p.manifest?.permissions.includes("sites") && p.state.granted.includes("sites"));
    const next: Record<string, string[]> = {};
    for (const p of wanted) {
      // A locked vault, or no library: no sites.
      const kept = root ? await api.pluginLibraryGet(p.id, root, SITES_KEY).catch(() => null) : null;
      next[p.id] = await api.pluginSitesSet(p.id, Array.isArray(kept) ? kept.filter((x): x is string => typeof x === "string") : []).catch(() => []);
    }
    const before = get().sites;
    set({ sites: next, list: get().list.map((p) => ({ ...p, sites: next[p.id] ?? [] })) });
    for (const [id, list] of Object.entries(next)) if (list.join() !== (before[id] ?? []).join()) get().reload(id);
  },

  async setSites(id, sites) {
    const root = libraryRoot();
    const was = get().sites[id] ?? [];
    const kept = await api.pluginSitesSet(id, sites);
    try {
      await api.pluginLibrarySet(id, root, SITES_KEY, kept);
    } catch (e) {
      // Not kept with the library (its vault locked, say): not allowed either.
      await api.pluginSitesSet(id, was).catch(() => {});
      throw e;
    }
    set({ sites: { ...get().sites, [id]: kept }, list: get().list.map((p) => (p.id === id ? { ...p, sites: kept } : p)) });
    return kept;
  },

  byId(id) {
    return get().list.find((p) => p.id === id);
  },

  reload(id) {
    get().clearRuntime(id);
    set({ nonce: { ...get().nonce, [id]: (get().nonce[id] ?? 0) + 1 } });
  },

  clearRuntime(id) {
    dropFinder(id);
    const overlays: PluginsStore["overlays"] = {};
    for (const [k, byPlugin] of Object.entries(get().overlays)) {
      const { [id]: drop, ...rest } = byPlugin;
      revokeImages(drop);
      if (Object.keys(rest).length) overlays[k] = rest;
    }
    set({
      buttons: get().buttons.filter((b) => b.pluginId !== id),
      tasks: get().tasks.filter((t) => t.pluginId !== id),
      dupeVersions: Object.fromEntries(Object.entries(get().dupeVersions).filter(([k]) => k !== id)),
      shared: withoutPlugin(get().shared, id),
      panels: Object.fromEntries(Object.entries(get().panels).filter(([k]) => k !== id)),
      panelOpen: get().panelOpen === id ? null : get().panelOpen,
      brush: get().panelOpen === id ? { ...get().brush, strokes: [] } : get().brush,
      keeping: get().keeping?.pluginId === id ? null : get().keeping,
      overlays,
      directions: get().directions.filter((d) => d.pluginId !== id),
    });
  },

  log(id, level, message) {
    const lines = [...(get().logs[id] ?? []), { t: Date.now(), level, message: message.slice(0, 2000) }].slice(-50);
    set({ logs: { ...get().logs, [id]: lines } });
    if (level === "error") console.warn(`[plugin:${id}]`, message);
  },

  setButtons(fn) {
    set({ buttons: fn(get().buttons) });
  },

  setShared(panel, pluginId, part) {
    const parts = { ...(get().shared[panel] ?? {}) };
    revokeShared(parts[pluginId]);
    if (part) parts[pluginId] = part;
    else delete parts[pluginId];
    const { [panel]: _was, ...others } = get().shared;
    set({ shared: Object.keys(parts).length ? { ...others, [panel]: parts } : others });
  },

  setDupeVersions(pluginId, v) {
    const all = { ...get().dupeVersions };
    if (v) all[pluginId] = v;
    else delete all[pluginId];
    set({ dupeVersions: all });
  },

  setOverlay(itemKey, pluginId, boxes) {
    const cur = { ...(get().overlays[itemKey] ?? {}) };
    const old = cur[pluginId];
    if (boxes && boxes.length) cur[pluginId] = boxes;
    else delete cur[pluginId];
    set({ overlays: { ...get().overlays, [itemKey]: cur } });
    revokeImages(old);
  },

  clearOverlays(pluginId, itemKey) {
    if (itemKey) return get().setOverlay(itemKey, pluginId, null);
    get().clearRuntime(pluginId);
  },

  setPanel(pluginId, panel) {
    const panels = { ...get().panels };
    if (panel) panels[pluginId] = panel;
    else delete panels[pluginId];
    set({ panels, panelOpen: !panel && get().panelOpen === pluginId ? null : get().panelOpen });
  },

  patchControl(pluginId, id, patch) {
    const panel = get().panels[pluginId];
    if (!panel) return;
    set({ panels: { ...get().panels, [pluginId]: { ...panel, controls: panel.controls.map((c) => ("id" in c && c.id === id ? ({ ...c, ...patch } as PanelControl) : c)) } } });
  },

  setPanelOpen(pluginId) {
    set({ panelOpen: pluginId, brush: { ...get().brush, strokes: [] }, colourPick: null });
  },

  setBrush(fn) {
    set({ brush: fn(get().brush) });
  },

  setColourPick(colourPick) {
    set({ colourPick });
  },

  setKeeping(keeping) {
    set({ keeping });
  },

  setTask(pluginId, id, patch) {
    const others = get().tasks.filter((t) => !(t.pluginId === pluginId && t.id === id));
    if (!patch) return set({ tasks: others });
    const cur = get().tasks.find((t) => t.pluginId === pluginId && t.id === id);
    if (!cur && ("stopping" in patch || "paused" in patch)) return;
    const now = Date.now();
    const next: PluginTask = { pluginId, id, label: "", done: 0, total: 0, detail: "", started: now, stopping: false, ...cur, ...patch, updated: now };
    set({ tasks: cur ? get().tasks.map((t) => (t === cur ? next : t)) : [...others, next] });
  },

  setDirection(pluginId, dir, albumKey) {
    const rest = get().directions.filter((d) => !(d.pluginId === pluginId && d.albumKey === albumKey));
    set({ directions: [...rest, { pluginId, dir, albumKey }] });
  },

  toggleOverlays() {
    set({ overlaysHidden: !get().overlaysHidden });
  },
}));

/** Image boxes hold blob: URLs the host made; they go when their boxes do. */
/** The shared panels without a plugin's parts (their images let go). */
function withoutPlugin(shared: Record<string, Record<string, SharedPart>>, id: string): Record<string, Record<string, SharedPart>> {
  const out: Record<string, Record<string, SharedPart>> = {};
  for (const [panel, parts] of Object.entries(shared)) {
    const { [id]: gone, ...rest } = parts;
    revokeShared(gone);
    if (Object.keys(rest).length) out[panel] = rest;
  }
  return out;
}

function revokeShared(part: SharedPart | undefined) {
  for (const i of part?.items ?? []) if (i.image) URL.revokeObjectURL(i.image);
}

function revokeImages(boxes: OverlayBox[] | undefined) {
  for (const b of boxes ?? []) if (b.image) URL.revokeObjectURL(b.image);
}

/** Reading direction for an item: an album-specific setting beats a global one. */
export function directionFor(albumKey: string | undefined): "ltr" | "rtl" {
  const d = usePlugins.getState().directions;
  const specific = albumKey ? d.filter((x) => x.albumKey === albumKey).pop() : undefined;
  const global = d.filter((x) => x.albumKey === null).pop();
  return (specific ?? global)?.dir ?? "ltr";
}


