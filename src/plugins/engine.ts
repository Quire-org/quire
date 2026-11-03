import { create } from "zustand";
import { api } from "../lib/api";
import { useStore } from "../store";
import type { DownloadProgress, EngineCatalog, StoreInfo } from "./types";

/**
 * The local engine's models, as Local models shows them. A download goes
 * on with that window closed, so its progress lives here.
 */
interface EngineStore {
  catalog: EngineCatalog | null;
  /** Where the models are kept. */
  store: StoreInfo | null;
  /** The model downloading, and how far it has got. */
  download: ({ id: string } & DownloadProgress) | null;
  /** Models a page asked for that aren't downloaded, shown as needed. */
  needed: string[];
  refresh(): Promise<void>;
  /** Open Local models, marking what is needed. */
  open(needed?: string[]): void;
  start(id: string): Promise<void>;
  cancel(): Promise<void>;
  remove(id: string): Promise<void>;
  choose(id: string): Promise<void>;
  /** Keep the models in this folder (null: the app's data folder). */
  setStore(path: string | null): Promise<void>;
}

export const useEngine = create<EngineStore>((set, get) => ({
  catalog: null,
  store: null,
  download: null,
  needed: [],

  async refresh() {
    try {
      const [catalog, store] = await Promise.all([api.engineModels(), api.engineStoreGet().catch(() => null)]);
      set({ catalog, store });
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
  },

  async setStore(path) {
    try {
      await api.engineStoreSet(path);
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
    await get().refresh();
  },

  open(needed = []) {
    set({ needed });
    useStore.getState().set({ modelsOpen: true, pluginsOpen: false, settingsOpen: false });
    void get().refresh();
  },

  async start(id) {
    if (get().download) return;
    const toast = useStore.getState().toast;
    const model = get().catalog?.models.find((m) => m.id === id);
    set({ download: { id, completed: 0, total: model?.size ?? 0, name: "" } });
    try {
      await api.engineDownload(id, (p) => set({ download: { id, ...p } }));
      // The first language model downloaded is the one used.
      const before = get().catalog;
      await get().refresh();
      const chosen = before?.models.find((m) => m.id === before.chosen);
      if (model?.kind === "translator" && chosen && !chosen.downloaded) await get().choose(id);
      set({ needed: get().needed.filter((n) => !get().catalog?.models.some((m) => m.id === n && m.downloaded)) });
      toast(`${model?.name ?? id} downloaded`, "ok");
    } catch (e) {
      if (String(e) !== "cancelled") toast(`Could not download ${model?.name ?? id}: ${String(e)}`, "error");
      await get().refresh();
    } finally {
      set({ download: null });
    }
  },

  async cancel() {
    await api.engineCancelDownload().catch((e) => useStore.getState().toast(String(e), "error"));
  },

  async remove(id) {
    try {
      await api.engineRemove(id);
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
    await get().refresh();
  },

  async choose(id) {
    const c = get().catalog;
    if (c) set({ catalog: { ...c, chosen: id } });
    try {
      await api.engineChoose(id);
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    }
    await get().refresh();
  },
}));
