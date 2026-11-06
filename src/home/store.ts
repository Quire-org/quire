import { create } from "zustand";
import { debounced } from "../lib/pending";
import { api } from "../lib/api";
import { useStore } from "../store";
import { add, emptyDoc, followMoves, forgetGone, move, presetBlocks, resize, settle, upgrade, type Block, type BlockType, type FolderFilter, type HomeDoc, type HomeSticker, type PresetId } from "./board";

/**
 * The Home of the library open: its board (kept with the library, in its vault when it has one),
 * Arrange, and ⌘Z while arranging. `doc` is null until read; `fresh` when the library has none yet
 * (the presets are offered).
 */
interface HomeState {
  doc: HomeDoc | null;
  docRoot: string | null;
  fresh: boolean;
  arranging: boolean;
  /** The block picked while arranging: its settings show in the drawer, arrows move it. */
  picked: string | null;
  /** The board as it was before each change made while arranging, latest last. */
  history: HomeDoc[];
  /** Each block's Shuffles this session (by its id): its pick stays as shuffled until the app closes, Home left and come back to or not. */
  salts: Record<string, number>;
  /** Read for the library open, or for `root` as it opens. */
  load(force?: boolean, root?: string): Promise<HomeDoc | null>;
  start(preset: PresetId): void;
  setArranging(on: boolean): void;
  pick(id: string | null): void;
  undo(): void;
  addBlock(type: BlockType, where?: { x: number; y: number }): string | null;
  moveBlock(id: string, x: number, y: number, cols?: number): void;
  resizeBlock(id: string, w: number, h: number, cols?: number): void;
  updateBlock(id: string, patch: Partial<Block>): void;
  removeBlock(id: string): void;
  addSticker(s: HomeSticker): void;
  updateSticker(id: string, patch: Partial<HomeSticker>): void;
  removeSticker(id: string): void;
  /** A sticker to the front (over the others) or the back. */
  restack(id: string, front: boolean): void;
  setFolders(folders: FolderFilter): void;
  setOpensOn(on: HomeDoc["opensOn"]): void;
  /** Fit the board to the window (see HomeDoc.fit). */
  setFit(on: boolean): void;
  /** The screen left, remembered for "Where you were". */
  leftFor(screen: string): void;
  /** A block's next pick (its Shuffle). */
  shuffle(id: string): void;
  follow(pairs: [string, string][]): void;
  /** Folders, albums and pictures gone for good, out of its filters and pins. */
  forget(gone: (key: string) => boolean): void;
}

const homeSave = debounced("home", 400, async (root) => {
  const { doc, docRoot } = useHome.getState();
  if (doc && docRoot === root) await api.homeSave(root, doc).catch((e) => useStore.getState().toast(`The Home couldn't be saved: ${String(e)}`, "error"));
});

export const useHome = create<HomeState>((set, get) => {
  /** A change to the board, kept with the library soon; while arranging, one ⌘Z takes back. */
  const change = (fn: (d: HomeDoc) => HomeDoc, undoable = true) => {
    const d = get().doc;
    if (!d || get().docRoot !== useStore.getState().root) return;
    set({ doc: fn(d), fresh: false, history: undoable && get().arranging ? [...get().history.slice(-49), d] : get().history });
    homeSave.schedule(get().docRoot!);
  };
  const blocks = (fn: (b: Block[]) => Block[]) => change((d) => ({ ...d, blocks: fn(d.blocks) }));

  return {
    doc: null,
    docRoot: null,
    fresh: false,
    arranging: false,
    picked: null,
    history: [],
    salts: {},

    async load(force, opening) {
      const root = opening ?? useStore.getState().root;
      if (!root) return null;
      if (!force && get().docRoot === root && get().doc) return get().doc;
      const raw = await Promise.resolve()
        .then(() => api.homeLoad(root))
        .catch(() => null);
      if (!opening && useStore.getState().root !== root) return null;
      const had = raw && typeof raw === "object" && Array.isArray((raw as HomeDoc).blocks);
      const doc: HomeDoc = had ? upgrade({ ...emptyDoc(), ...(raw as Partial<HomeDoc>), version: 1 }) : emptyDoc();
      set({ doc, docRoot: root, fresh: !had, arranging: false, history: [] });
      return doc;
    },

    start(preset) {
      change((d) => ({ ...d, blocks: presetBlocks(preset) }));
    },

    setArranging(on) {
      set({ arranging: on, picked: null, history: on ? get().history : [] });
    },

    pick(id) {
      set({ picked: id });
    },

    undo() {
      const h = get().history;
      if (!h.length) return;
      const prev = h[h.length - 1];
      change(() => prev, false);
      set({ history: h.slice(0, -1) });
    },

    addBlock(type, where) {
      let id: string | null = null;
      blocks((b) => {
        const r = add(b, type, where);
        id = r.id;
        return r.blocks;
      });
      return id;
    },

    moveBlock(id, x, y, cols) {
      const b = get().doc?.blocks.find((o) => o.id === id);
      if (b && (b.x !== x || b.y !== y)) blocks((all) => move(all, id, x, y, cols));
    },

    resizeBlock(id, w, h, cols) {
      const b = get().doc?.blocks.find((o) => o.id === id);
      if (b && (b.w !== w || b.h !== h)) blocks((all) => resize(all, id, w, h, cols));
    },

    updateBlock(id, patch) {
      blocks((all) => all.map((b) => (b.id === id ? { ...b, ...patch } : b)));
    },

    removeBlock(id) {
      // The rest close up behind it.
      blocks((all) => settle(all.filter((b) => b.id !== id)));
      if (get().picked === id) set({ picked: null });
    },

    addSticker(st) {
      change((d) => ({ ...d, stickers: [...(d.stickers ?? []), st] }));
      set({ picked: st.id });
    },

    updateSticker(id, patch) {
      change((d) => ({ ...d, stickers: (d.stickers ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
    },

    removeSticker(id) {
      change((d) => ({ ...d, stickers: (d.stickers ?? []).filter((s) => s.id !== id) }));
      if (get().picked === id) set({ picked: null });
    },

    restack(id, front) {
      change((d) => {
        const list = d.stickers ?? [];
        const s = list.find((x) => x.id === id);
        const rest = list.filter((x) => x.id !== id);
        return s ? { ...d, stickers: front ? [...rest, s] : [s, ...rest] } : d;
      });
    },

    setFolders(folders) {
      change((d) => ({ ...d, folders }));
    },

    setOpensOn(opensOn) {
      change((d) => ({ ...d, opensOn }));
    },

    setFit(fit) {
      change((d) => ({ ...d, fit: fit || undefined }), false);
    },

    leftFor(screen) {
      if (get().doc?.last?.screen === screen) return;
      change((d) => ({ ...d, last: { screen, at: Date.now() } }), false);
    },

    shuffle(id) {
      const salts = get().salts;
      set({ salts: { ...salts, [id]: (salts[id] ?? 0) + 1 } });
    },

    follow(pairs) {
      const d = get().doc;
      if (!d) return;
      const next = followMoves(d, pairs);
      if (JSON.stringify(next) !== JSON.stringify(d)) change(() => next, false);
    },

    forget(gone) {
      const d = get().doc;
      if (!d) return;
      const next = forgetGone(d, gone);
      if (JSON.stringify(next) !== JSON.stringify(d)) change(() => next, false);
    },
  };
});

/** The screens "Where you were" goes back to. */
export const REMEMBERED = new Set(["browse", "albums", "dupes", "files", "tags", "people", "artists", "find", "scrapbook"]);

useStore.subscribe((s, prev) => {
  // Another library: its own Home (unless it was read as the library opened).
  if (s.root !== prev.root) {
    if (useHome.getState().docRoot !== s.root) useHome.setState({ doc: null, docRoot: null, fresh: false, arranging: false, history: [] });
  }
  // The list screen gone to, remembered for "Where you were".
  else if (s.screen !== prev.screen && REMEMBERED.has(s.screen)) useHome.getState().leftFor(s.screen);
});
