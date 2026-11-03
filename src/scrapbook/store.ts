import { create } from "zustand";
import { debounced } from "../lib/pending";
import { api } from "../lib/api";
import { base64 } from "../lib/base64";
import { useStore, type Screen } from "../store";
import { useTags } from "../tagsStore";
import { usePeople } from "../peopleStore";
import { useArtists } from "../artistsStore";
import { AssetCache, drawPage, fontsReady } from "./render";
import { DEFAULT_BACKGROUND, EMPTY_LIBRARY, PAGE, blobsOf, blobsOfBanner, newId, type Banner, type BannerSticker, type CustomSticker, type Layer, type ScrapDoc, type ScrapLibrary, type StickerSource, type Target } from "./model";
import { steppedJob } from "../lib/jobs";
import type { MediaItem } from "../lib/types";

/**
 * Scrapbook's data and its editor. The scrapbooks (each cover's layout) and the custom stickers are
 * one file kept with the library; their pictures are files of their own beside it (encrypted in a
 * vault). Which cover an album or a tag has is kept with the album (the library) or the tag (the
 * tags), so it follows them when they move or are renamed; which banner a person or an artist has,
 * with them.
 */

/** Whose banner: a person's (or a character's) or an artist's. */
export type BannerTarget = { kind: "person" | "artist"; id: string };

interface Editing {
  target: Target;
  doc: ScrapDoc;
  selected: string | null;
  past: ScrapDoc[];
  future: ScrapDoc[];
  /** Changes of the same kind in a row (dragging, typing) undo as one. */
  mergeKey: string | null;
  saving: boolean;
  /** Pictures saved while editing: gone again if the editing is cancelled. */
  added: string[];
}

interface ScrapState {
  lib: ScrapLibrary | null;
  editing: Editing | null;
  /** The screen to go back to. */
  back: Screen;

  load(): Promise<ScrapLibrary>;
  /** A picture of the scrapbooks, saved from bytes (a cut sticker, a photo, a rendered cover). */
  putBlob(name: string, blob: Blob): Promise<void>;

  open(target: Target): Promise<void>;
  change(fn: (doc: ScrapDoc) => ScrapDoc, mergeKey?: string): void;
  select(id: string | null): void;
  undo(): void;
  redo(): void;
  /** Renders the cover, saves it and its layout, and gives it to the album or tag. */
  done(): Promise<boolean>;
  cancel(): void;
  removeCover(target: Target): Promise<void>;
  addSticker(s: CustomSticker): void;
  removeSticker(id: string): void;
  /** The sticker shelf as given (their sources moved, say). */
  setStickers(stickers: CustomSticker[]): void;
  /**
   * A sticker fine-tuned again: the shelf takes it, and every cover with it on (the one being made
   * too) takes its new picture; the covers are drawn again.
   */
  replaceSticker(next: CustomSticker): Promise<void>;
  /** The sticker studio, open: for one picture (from Browse or the viewer), a cover's pictures, or one sticker to fine-tune again. */
  studio: { item?: MediaItem; target?: Target; sticker?: CustomSticker } | null;
  openStudio(opts: { item?: MediaItem; target?: Target; sticker?: CustomSticker }): Promise<void>;
  closeStudio(): void;
  /** Stickers put on the page being edited, about the middle and a little askew. */
  place(stickers: CustomSticker[]): void;
  /** A person's or an artist's banner with these stickers on (none: it goes). */
  saveBanner(target: BannerTarget, stickers: BannerSticker[]): void;
  /** A banner whose artist is gone. */
  dropBanner(id: string): Promise<void>;
}

let loadedFor: string | null = null;
const urls = new Map<string, string>();

/** Object URLs of the scrapbooks' pictures, read once. */
export async function blobUrl(name: string): Promise<string> {
  const had = urls.get(name);
  if (had) return had;
  const root = useStore.getState().root;
  if (!root) throw new Error("no folder is open");
  const bytes = await api.scrapbookBlob(root, name);
  const url = URL.createObjectURL(new Blob([bytes], { type: name.endsWith(".png") ? "image/png" : "image/jpeg" }));
  urls.set(name, url);
  return url;
}

/** A picture's URL if it has been read already (to show it at once, with no empty frame first). */
export const knownUrl = (name: string): string | null => urls.get(name) ?? null;

/** The pictures the editor and the cards draw, shared. */
export const assets = new AssetCache(blobUrl);

/** A picture's bytes as base64, for the backend. */
/** A cover drawn at its full size times `scale`, once its fonts and pictures are in. */
async function renderCover(doc: ScrapDoc, scale = 1): Promise<HTMLCanvasElement> {
  const { w, h } = PAGE[doc.kind];
  await Promise.all([fontsReady(doc), assets.ready(doc)]);
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  drawPage(canvas.getContext("2d")!, doc, canvas.width, canvas.height, assets);
  return canvas;
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not render the cover"))), type, quality));

/** A cover as it looks, saved as a picture where the user picks (PNG or JPEG), at twice its size so it stays sharp. */
export async function exportCover(doc: ScrapDoc, target: Target): Promise<void> {
  try {
    const canvas = await renderCover(doc, 2);
    const [png, jpeg] = await Promise.all([encode(canvas, "image/png").then(base64), encode(canvas, "image/jpeg", 0.92).then(base64)]);
    const name = `${target.name.replace(/[/\\:]/g, "-")} ${target.kind === "album" ? "cover" : "banner"}.png`;
    const path = await api.scrapbookExport(name, png, jpeg);
    if (path) useStore.getState().toast(`Saved ${path.split("/").pop()}`, "ok");
  } catch (err) {
    useStore.getState().toast(`Could not export the cover: ${String(err)}`, "error");
  }
}

const scrapSave = debounced("scrapbook", 300, async (root) => {
  // The scrapbooks of the library they were loaded for: never written into one opened since.
  const lib = useScrapbook.getState().lib;
  if (lib && loadedFor === root) await api.scrapbookSave(root, lib).catch((e) => useStore.getState().toast(`Could not save the scrapbooks: ${String(e)}`, "error"));
});
function persist(_lib: ScrapLibrary) {
  if (loadedFor) scrapSave.schedule(loadedFor);
}
// Another library: its own scrapbooks, read when asked for.
useStore.subscribe((s, prev) => {
  if (s.root !== prev.root && loadedFor !== s.root) {
    scrapSave.cancel();
    loadedFor = null;
    useScrapbook.setState({ lib: null });
  }
});

/** Every picture some scrapbook or the sticker shelf still uses. */
/** A sticker's files: its picture, and what it was cut from if kept. */
const stickerFiles = (s: CustomSticker) => [s.blob, ...(s.cut ? [s.cut.picture, s.cut.mask] : [])];

function inUse(lib: ScrapLibrary): Set<string> {
  return new Set([...Object.values(lib.books).flatMap(blobsOf), ...lib.stickers.flatMap(stickerFiles), ...Object.values(lib.banners).flatMap(blobsOfBanner)]);
}

async function forget(names: string[], lib: ScrapLibrary) {
  const root = useStore.getState().root;
  const used = inUse(lib);
  for (const n of names) {
    if (!root || used.has(n)) continue;
    await api.scrapbookBlobDelete(root, n).catch(() => {});
    const u = urls.get(n);
    if (u) URL.revokeObjectURL(u);
    urls.delete(n);
  }
}

/** What a cover is of, by its scrapbook's id: its album's or tag's name. */
function coverName(book: string): string | undefined {
  const album = Object.entries(useStore.getState().library?.albumCovers ?? {}).find(([, b]) => b === book)?.[0];
  if (album) return album.split("/").pop();
  const tag = Object.entries(useTags.getState().data?.covers ?? {}).find(([, b]) => b === book)?.[0];
  return tag?.split("/").pop();
}

/** The scrapbook an album or a tag has, by id. */
export function coverOf(target: Target): string | undefined {
  if (target.kind === "album") return useStore.getState().library?.albumCovers?.[target.key];
  return useTags.getState().data?.covers?.[target.id];
}

/** The banner a person or an artist has, by id. */
export function bannerOf(target: BannerTarget): string | undefined {
  if (target.kind === "person") return usePeople.getState().doc?.people[target.id]?.banner;
  return useArtists.getState().doc?.artists[target.id]?.banner;
}

function setBanner(target: BannerTarget, banner: string | null) {
  if (target.kind === "person") usePeople.getState().setBanner(target.id, banner);
  else useArtists.getState().setBanner(target.id, banner);
}

function setCover(target: Target, book: string | null) {
  if (target.kind === "album") {
    const lib = useStore.getState().library;
    if (!lib) return;
    const albumCovers = { ...(lib.albumCovers ?? {}) };
    if (book) albumCovers[target.key] = book;
    else delete albumCovers[target.key];
    useStore.setState({ library: { ...lib, albumCovers } });
    void useStore.getState().saveLibrary();
    return;
  }
  const d = useTags.getState().data;
  if (!d) return;
  const covers = { ...(d.covers ?? {}) };
  if (book) covers[target.id] = book;
  else delete covers[target.id];
  useTags.setState({ data: { ...d, covers } });
  useTags.getState().save();
}

export const useScrapbook = create<ScrapState>((set, get) => ({
  lib: null,
  editing: null,
  studio: null,
  back: "albums",

  async load() {
    const root = useStore.getState().root;
    if (!root) return EMPTY_LIBRARY;
    if (loadedFor === root && get().lib) return get().lib!;
    const raw = (await api.scrapbookLoad(root).catch(() => null)) as Partial<ScrapLibrary> | null;
    const lib: ScrapLibrary = { ...EMPTY_LIBRARY, ...(raw ?? {}), books: raw?.books ?? {}, stickers: raw?.stickers ?? [], banners: raw?.banners ?? {} };
    loadedFor = root;
    set({ lib });
    return lib;
  },

  async putBlob(name, blob) {
    const root = useStore.getState().root;
    if (!root) throw new Error("no folder is open");
    await api.scrapbookBlobPut(root, name, await base64(blob));
    urls.set(name, URL.createObjectURL(blob));
    const e = get().editing;
    if (e) set({ editing: { ...e, added: [...e.added, name] } });
  },

  async open(target) {
    const lib = await get().load();
    const id = coverOf(target);
    const kept = id ? lib.books[id] : undefined;
    const doc: ScrapDoc = kept ? structuredClone(kept) : { id: newId(), kind: target.kind, background: DEFAULT_BACKGROUND, layers: [], updated: Date.now() };
    const from = useStore.getState().screen;
    set({ editing: { target, doc, selected: null, past: [], future: [], mergeKey: null, saving: false, added: [] }, back: from === "cover" ? get().back : from });
    useStore.setState({ screen: "cover" });
  },

  change(fn, mergeKey) {
    const e = get().editing;
    if (!e) return;
    const doc = fn(e.doc);
    if (doc === e.doc) return;
    // A drag or a run of typing is one step back, not one per move.
    const merge = !!mergeKey && mergeKey === e.mergeKey;
    set({ editing: { ...e, doc, past: merge ? e.past : [...e.past.slice(-80), e.doc], future: [], mergeKey: mergeKey ?? null } });
  },

  select(id) {
    const e = get().editing;
    if (e) set({ editing: { ...e, selected: id, mergeKey: null } });
  },

  undo() {
    const e = get().editing;
    if (!e?.past.length) return;
    const doc = e.past[e.past.length - 1];
    set({ editing: { ...e, doc, past: e.past.slice(0, -1), future: [e.doc, ...e.future], mergeKey: null, selected: [...doc.layers, ...(doc.bars ?? [])].some((l) => l.id === e.selected) ? e.selected : null } });
  },

  redo() {
    const e = get().editing;
    if (!e?.future.length) return;
    const [doc, ...future] = e.future;
    set({ editing: { ...e, doc, past: [...e.past, e.doc], future, mergeKey: null } });
  },

  async done() {
    const e = get().editing;
    const lib = get().lib;
    if (!e || !lib || e.saving) return false;
    set({ editing: { ...e, saving: true } });
    try {
      const picture = await encode(await renderCover(e.doc), "image/jpeg", 0.9);
      // A new name each time: whatever showed the old one shows the new one, not a cached copy.
      const rendered = `cover-${e.doc.id}-${Date.now().toString(36)}.jpg`;
      await get().putBlob(rendered, picture);
      const before = lib.books[e.doc.id];
      const doc: ScrapDoc = { ...e.doc, rendered, updated: Date.now() };
      const next: ScrapLibrary = { ...lib, books: { ...lib.books, [doc.id]: doc } };
      set({ lib: next });
      persist(next);
      setCover(e.target, doc.id);
      // What the cover no longer uses (its old render, photos taken out) goes.
      await forget([...(before ? blobsOf(before) : []), ...get().editing!.added], next);
      set({ editing: null });
      useStore.setState({ screen: get().back });
      useStore.getState().toast(`Scrapbook cover saved for ${e.target.name}`, "ok");
      return true;
    } catch (err) {
      useStore.getState().toast(`Could not save the cover: ${String(err)}`, "error");
      const cur = get().editing;
      if (cur) set({ editing: { ...cur, saving: false } });
      return false;
    }
  },

  cancel() {
    const e = get().editing;
    if (e && get().lib) void forget(e.added, get().lib!);
    set({ editing: null });
    useStore.setState({ screen: get().back });
  },

  async removeCover(target) {
    const lib = await get().load();
    const id = coverOf(target);
    setCover(target, null);
    if (!id || !lib.books[id]) return;
    const gone = lib.books[id];
    const books = { ...lib.books };
    delete books[id];
    const next = { ...lib, books };
    set({ lib: next });
    persist(next);
    await forget(blobsOf(gone), next);
  },

  addSticker(s) {
    const lib = get().lib ?? EMPTY_LIBRARY;
    const next = { ...lib, stickers: [s, ...lib.stickers] };
    set({ lib: next });
    persist(next);
    // Kept now: no longer something to clean up if the editing is cancelled.
    const e = get().editing;
    if (e) set({ editing: { ...e, added: e.added.filter((n) => n !== s.blob) } });
  },

  async openStudio(opts) {
    await get().load();
    set({ studio: opts });
  },

  closeStudio() {
    set({ studio: null });
  },

  place(stickers) {
    const e = get().editing;
    if (!e || !stickers.length) return;
    const narrow = e.doc.kind === "tag";
    const layers: Layer[] = stickers.map((s, i) => ({
      id: newId(),
      type: "sticker",
      src: { blob: s.blob },
      look: "original",
      outline: true,
      aspect: s.h / s.w,
      x: 0.5 + (i - (stickers.length - 1) / 2) * (narrow ? 0.12 : 0.18),
      y: 0.5 + (Math.random() - 0.5) * 0.1,
      w: narrow ? 0.14 : 0.32,
      rot: Math.round((Math.random() - 0.5) * 16),
    }));
    get().change((d) => ({ ...d, layers: [...d.layers, ...layers] }));
    get().select(layers[layers.length - 1].id);
  },

  saveBanner(target, stickers) {
    const lib = get().lib;
    if (!lib) return;
    const had = bannerOf(target);
    const before = had ? lib.banners[had] : undefined;
    const banners = { ...lib.banners };
    const id = stickers.length ? (before?.id ?? newId()) : null;
    if (id) banners[id] = { id, stickers, updated: Date.now() };
    else if (had) delete banners[had];
    const next = { ...lib, banners };
    set({ lib: next });
    persist(next);
    if (id !== (had ?? null)) setBanner(target, id);
    // A sticker taken off it that was only there (one gone from the shelf) goes.
    if (before) void forget(blobsOfBanner(before), next);
  },

  async dropBanner(id) {
    const lib = await get().load();
    const gone = lib.banners[id];
    if (!gone) return;
    const banners = { ...lib.banners };
    delete banners[id];
    const next = { ...lib, banners };
    set({ lib: next });
    persist(next);
    await forget(blobsOfBanner(gone), next);
  },

  setStickers(stickers) {
    const lib = get().lib;
    if (!lib) return;
    const next = { ...lib, stickers };
    set({ lib: next });
    persist(next);
  },

  removeSticker(id) {
    const lib = get().lib;
    if (!lib) return;
    const gone = lib.stickers.find((s) => s.id === id);
    const next = { ...lib, stickers: lib.stickers.filter((s) => s.id !== id) };
    set({ lib: next });
    persist(next);
    // Covers that use it keep their copy of it (their layer names the same file): only an unused one goes.
    if (gone) void forget(stickerFiles(gone), next);
  },

  async replaceSticker(next) {
    const lib = get().lib;
    const old = lib?.stickers.find((s) => s.id === next.id);
    if (!lib || !old) return;
    const its = (src: StickerSource) => "blob" in src && src.blob === old.blob;
    const uses = (l: Layer) => l.type === "sticker" && its(l.src);
    const swap = (d: ScrapDoc): ScrapDoc => (d.layers.some(uses) ? { ...d, layers: d.layers.map((l) => (uses(l) ? { ...l, src: { blob: next.blob }, aspect: next.h / next.w } : l)) } : d);
    // Banners are drawn as they are shown: they only take the new picture.
    const swapBanner = (b: Banner): Banner => (b.stickers.some((s) => its(s.src)) ? { ...b, stickers: b.stickers.map((s) => (its(s.src) ? { ...s, src: { blob: next.blob }, aspect: next.h / next.w } : s)) } : b);
    const changed = Object.values(lib.books).filter((b) => b.layers.some(uses)).map((b) => b.id);
    const updated: ScrapLibrary = {
      ...lib,
      books: Object.fromEntries(Object.entries(lib.books).map(([k, b]) => [k, swap(b)])),
      stickers: lib.stickers.map((s) => (s.id === next.id ? next : s)),
      banners: Object.fromEntries(Object.entries(lib.banners).map(([k, b]) => [k, swapBanner(b)])),
    };
    set({ lib: updated });
    persist(updated);
    const e = get().editing;
    if (e) set({ editing: { ...e, doc: swap(e.doc), past: e.past.map(swap), future: e.future.map(swap) } });
    // The covers it is on, drawn again with it.
    const gone: string[] = [];
    if (changed.length) {
      const { job, gate } = steppedJob({ title: "Covers with the fine-tuned sticker", source: "Scrapbook", total: changed.length });
      for (let i = 0; i < changed.length; i++) {
        if (!(await gate.pass())) break;
        const book = get().lib?.books[changed[i]];
        if (book) {
          try {
            const picture = await encode(await renderCover(book), "image/jpeg", 0.9);
            const rendered = `cover-${book.id}-${Date.now().toString(36)}${i}.jpg`;
            await get().putBlob(rendered, picture);
            const cur = get().lib!;
            const after = { ...cur, books: { ...cur.books, [book.id]: { ...cur.books[book.id], rendered } } };
            set({ lib: after });
            persist(after);
            if (book.rendered) gone.push(book.rendered);
          } catch {
            // Its picture stays as it was drawn, until it is next saved.
          }
        }
        job.update({ done: i + 1, detail: book ? coverName(book.id) : undefined });
      }
      job.finish();
    }
    await forget([...gone, ...stickerFiles(old)], get().lib!);
  },
}));

/** The rendered cover of an album or tag, as a URL, once loaded; null without one. */
export async function coverUrl(book: string | undefined): Promise<string | null> {
  if (!book) return null;
  const lib = await useScrapbook.getState().load();
  const rendered = lib.books[book]?.rendered;
  return rendered ? blobUrl(rendered) : null;
}
