import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { TextLayer } from "../scrapbook/model";

// The backend, as far as Scrapbook goes: its file, its pictures, and the library and tags it gives covers to.
const be = vi.hoisted(() => ({ rendered: [] as [number, number, string][], book: null as unknown, blobs: new Map<string, string>(), deleted: [] as string[], library: null as unknown, tags: null as unknown }));
vi.mock("../lib/api", () => ({
  api: {
    scrapbookLoad: vi.fn(async () => be.book),
    scrapbookSave: vi.fn(async (_r: string, d: unknown) => void (be.book = d)),
    scrapbookBlob: vi.fn(async () => new ArrayBuffer(4)),
    scrapbookBlobPut: vi.fn(async (_r: string, name: string, data: string) => void be.blobs.set(name, data)),
    scrapbookBlobDelete: vi.fn(async (_r: string, name: string) => void (be.blobs.delete(name), be.deleted.push(name))),
    saveLibrary: vi.fn(async (_r: string, lib: unknown) => void (be.library = lib)),
    saveHistory: vi.fn(async () => {}),
    loadTags: vi.fn(async () => be.tags),
    saveTags: vi.fn(async (_r: string, d: unknown) => void (be.tags = d)),
    tagsIndexLoad: vi.fn(async () => ({ auto: {}, indexed: {} })),
    tagsIndexRename: vi.fn(async () => {}),
    loadCache: vi.fn(async () => null),
    saveCache: vi.fn(async () => {}),
    scanDir: vi.fn(async () => []),
    scrapbookExport: vi.fn(async () => "/Users/me/Desktop/sea banner.png"),
  },
  storedPath: (root: string, p: string) => p.slice(root.length + 1),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

// jsdom draws nothing: a canvas whose context takes every call, measures text by its length, and "renders" to a JPEG blob.
const noop = () => {};
const ctx = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) => (k in t ? t[k] : k === "measureText" ? (s: string) => ({ width: s.length * 10 }) : k === "getImageData" ? () => ({ data: new Uint8ClampedArray(4) }) : k === "createRadialGradient" || k === "createLinearGradient" ? () => ({ addColorStop: noop }) : noop),
  set: (t, k, v) => ((t[k] = v), true),
});
HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
  be.rendered.push([this.width, this.height, type ?? "image/png"]);
  cb(new Blob(["rendered"], { type: type ?? "image/png" }));
};
// Pictures "load" a moment after their source is set (jsdom never loads them).
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 256;
  naturalHeight = 256;
  width = 256;
  height = 256;
  set src(_: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}
(globalThis as { Image: unknown }).Image = FakeImage;
URL.createObjectURL = () => "blob:x";
URL.revokeObjectURL = noop;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { useStore, followMoves } = await import("../store");
const { useTags } = await import("../tagsStore");
const { useScrapbook } = await import("../scrapbook/store");
const { divided, findSubjects, lassoSubject, merge, onSubject, pieceOf, tuned, render, withCloserLook, NO_TUNE } = await import("../scrapbook/subjects");
const { useEngine } = await import("../plugins/engine");
const { StickerStudio } = await import("../components/StickerStudio");
const { layerSize, barAt, drawPage, AssetCache } = await import("../scrapbook/render");
const { newBar, partColour } = await import("../scrapbook/model");
const { api } = await import("../lib/api");
const { withLook } = await import("../scrapbook/looks");
const { CoverEditor: Scrapbook } = await import("../screens/CoverEditor");
const { STICKERS } = await import("../scrapbook/stickers");

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const library = () => ({ version: 1, targets: [], trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {} });

function reset() {
  be.book = null;
  be.blobs = new Map();
  be.deleted = [];
  be.tags = { version: 1, types: ["motives"], tags: { "Pics/a.jpg": ["motives/sea"] }, autoMap: {}, albums: {} };
  useStore.setState({ root: "/vol", screen: "albums", library: library(), allItems: [], albums: [], viewed: {} } as never);
  useTags.setState({ data: null, loaded: false });
  useScrapbook.setState({ lib: null, editing: null });
}

describe("cutting subjects out for stickers", () => {
  // A 40 × 20 mask: a big subject on the left (with a soft edge), a small one on the right, a speck.
  const W = 40;
  const H = 20;
  const mask = new Uint8Array(W * H);
  const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * W + x] = v;
  };
  fill(2, 2, 16, 18, 255);
  fill(16, 2, 17, 18, 120); // its soft edge
  fill(26, 6, 34, 14, 230);
  fill(38, 0, 39, 1, 255); // a speck

  it("finds each subject, biggest first, and not the specks", () => {
    const { subjects } = findSubjects(mask, W, H);
    expect(subjects.map((s) => [s.x0, s.y0, s.x1, s.y1, s.area])).toEqual([
      [2, 2, 16, 18, 224],
      [26, 6, 34, 14, 64],
    ]);
  });

  it("parts two subjects that touch along a line drawn between them, carried on to their edge, with no slit in either", () => {
    // Two squares joined by a neck, 60 × 30: the model saw one subject.
    const w = 60;
    const h = 30;
    const m = new Uint8Array(w * h);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 55; x++) if (x < 25 || x >= 35 || (y >= 10 && y < 20)) m[y * w + x] = 255;
    expect(findSubjects(m, w, h).subjects).toHaveLength(1);
    // A short line down the neck, not reaching its edges: carried on to them, it parts the two.
    const line: [number, number][] = [
      [30, 13],
      [30, 15],
      [30.4, 17],
    ];
    const cut = divided(m, w, h, [line]);
    const { labels, subjects } = findSubjects(cut, w, h);
    expect(subjects.map((s) => [s.x0 < 30, s.x1 > 30])).toEqual([
      [true, false],
      [false, true],
    ]);
    // A line in the empty part of the picture parts nothing.
    expect(findSubjects(divided(m, w, h, [[[2, 2], [2, 28]]]), w, h).subjects).toHaveLength(1);
    // Each sticker keeps the mask as it was: solid right up to the line, nothing cut out of it.
    const pixels = new Uint8ClampedArray(w * h * 4).fill(255);
    const left = pieceOf(pixels, m, labels, w, h, subjects.find((s) => s.x0 < 30)!);
    const at = (x: number, y: number) => left.alpha[(y - left.y0) * left.w + (x - left.x0)];
    expect(at(10, 15)).toBe(255);
    expect(at(28, 15)).toBe(255);
    expect(at(40, 15)).toBe(0);
  });

  it("keeps a subject the model was only fairly sure of fully solid, not see-through (no white veil)", () => {
    const m = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) m[y * W + x] = x < 10 ? 175 : 210;
    const { labels, subjects } = findSubjects(m, W, H);
    const pixels = new Uint8ClampedArray(W * H * 4).fill(255);
    const piece = pieceOf(pixels, m, labels, W, H, subjects[0]);
    const at = (x: number, y: number) => piece.alpha[(y - piece.y0) * piece.w + (x - piece.x0)];
    expect(at(6, 8)).toBe(255);
    expect(at(12, 8)).toBe(255);
    // Drawn tighter (the cut at 185): still solid where the mask is clearly past it.
    const tight = pieceOf(pixels, m, labels, W, H, subjects[0], 185);
    expect(tight.alpha[(8 - tight.y0) * tight.w + (12 - tight.x0)]).toBe(255);
  });

  it("cuts one out with its soft edge, the other left out, the rest see-through", () => {
    const { labels, subjects } = findSubjects(mask, W, H);
    const pixels = new Uint8ClampedArray(W * H * 4).fill(200);
    const big = pieceOf(pixels, mask, labels, W, H, subjects[0]);
    // Its box with room around it, cut short at the picture's edge: here it starts at the picture's corner.
    const alpha = (x: number, y: number) => big.alpha[(y - big.y0) * big.w + (x - big.x0)];
    expect([big.x0, big.y0]).toEqual([0, 0]);
    expect(alpha(7, 7)).toBe(200); // inside: the picture's own alpha (200) under the mask's 255
    expect(alpha(16, 7)).toBe(77); // the soft edge (the mask's 120, eased round the cut at 128)
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(18, 7)).toBe(0); // past the edge
    expect(alpha(28, 10)).toBe(0); // the other subject, in the box but not cut out
    const sticker = render(big, big.alpha)!;
    expect(sticker.w).toBe(15 + 4); // 2..16 (its soft edge included), and 2 px of room each side
  });

  it("a shape drawn by hand: the subject inside it, or the whole shape where nothing was found", () => {
    const round: [number, number][] = [[24, 4], [36, 4], [36, 16], [24, 16]];
    expect(lassoSubject(mask, W, H, round)?.parts[0].useMask).toBe(true);
    const empty: [number, number][] = [[18, 4], [24, 4], [24, 18], [18, 18]];
    expect(lassoSubject(mask, W, H, empty)?.parts[0].useMask).toBe(false);
    // Outlined exactly: the shape is the cut, whatever the model saw in it.
    expect(lassoSubject(mask, W, H, round, true)?.parts[0].useMask).toBe(false);
    expect(lassoSubject(mask, W, H, [[1, 1], [2, 2]])).toBeNull();
  });

  it("takes in more as the sensitivity rises, and merges subjects into one", () => {
    // A faint third subject (the model was unsure: 100) shows only at a lower cut.
    const faint = new Uint8Array(mask);
    for (let y = 2; y < 18; y++) for (let x = 20; x < 24; x++) faint[y * W + x] = 100;
    expect(findSubjects(faint, W, H).subjects).toHaveLength(2);
    expect(findSubjects(faint, W, H, 12, 80).subjects).toHaveLength(3);
    const { labels, subjects } = findSubjects(mask, W, H);
    const both = merge(subjects);
    expect(both.parts).toHaveLength(2);
    expect([both.x0, both.y0, both.x1, both.y1]).toEqual([2, 2, 34, 18]);
    expect(onSubject(both, labels, W, 5, 5) && onSubject(both, labels, W, 30, 10)).toBe(true);
    expect(onSubject(both, labels, W, 20, 1)).toBe(false);
    // Cut out together: both in one picture.
    const pixels = new Uint8ClampedArray(W * H * 4).fill(255);
    const piece = pieceOf(pixels, mask, labels, W, H, both);
    expect(render(piece, piece.alpha)!.w).toBeGreaterThan(30);
  });

  it("looking closer adds what it finds there, and never takes away what was already found", () => {
    // The person (2..16) is missing an arm (16..22, over their soft edge). A closer look at 10..24 (an RGBA mask, as decoded)
    // finds the arm, but, seeing only part of the person, drops the bit of them in the box.
    const rx = 10;
    const ry = 0;
    const rw = 14;
    const rh = H;
    const part = new Uint8ClampedArray(rw * rh * 4);
    for (let y = 8; y < 12; y++) for (let x = 16; x < 22; x++) part[(y * rw + x - rx) * 4] = 240;
    const looked = withCloserLook(mask, W, part, rx, ry, rw, rh, 4);
    // Everything found before is still there, inside the box and out.
    for (let i = 0; i < W * H; i++) expect(looked[i]).toBeGreaterThanOrEqual(mask[i]);
    expect(looked[8 * W + 12]).toBe(255);
    // The arm is added, and joins the person: one subject now, arm and all.
    expect(looked[9 * W + 19]).toBe(240);
    const { subjects } = findSubjects(looked, W, H);
    expect([subjects[0].x0, subjects[0].x1]).toEqual([2, 22]);
    // The mask it was given is left as it was (undo takes it back).
    expect(mask[9 * W + 19]).toBe(0);
  });
});

describe("fine-tuning a sticker", () => {
  // A 30 × 30 picture with a 10 × 10 subject in the middle.
  const W = 30;
  const H = 30;
  const mask = new Uint8Array(W * H);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) mask[y * W + x] = 255;
  const pixels = new Uint8ClampedArray(W * H * 4).fill(255);
  const { labels, subjects } = findSubjects(mask, W, H);
  const piece = pieceOf(pixels, mask, labels, W, H, subjects[0]);
  const count = (a: Uint8ClampedArray) => a.reduce((n, v) => n + (v >= 128 ? 1 : 0), 0);

  it("keeps the subject as found, and grows or shrinks its edge by as many pixels as asked", () => {
    expect(count(tuned(piece, NO_TUNE))).toBe(100);
    expect(count(tuned(piece, { ...NO_TUNE, edge: 2 }))).toBeGreaterThanOrEqual(14 * 14 - 4 * 4); // 2 px all round, corners rounded
    expect(count(tuned(piece, { ...NO_TUNE, edge: -2 }))).toBe(6 * 6);
  });

  it("softens the edge, and paints in or away where the brush went", () => {
    const soft = tuned(piece, { ...NO_TUNE, soft: 2 });
    const edgeAt = (piece.w * (piece.h >> 1)) + (10 - piece.x0);
    expect(soft[edgeAt]).toBeGreaterThan(0);
    expect(soft[edgeAt]).toBeLessThan(255);
    const painted = tuned(piece, { ...NO_TUNE, dabs: [{ x: 0, y: 0, r: 3, keep: true }, { x: 15 - piece.x0, y: 15 - piece.y0, r: 2, keep: false }] });
    expect(painted[0]).toBe(255);
    expect(painted[(15 - piece.y0) * piece.w + (15 - piece.x0)]).toBe(0);
  });

  it("is cropped to what is left of it, and is nothing when everything was erased", () => {
    const out = render(piece, tuned(piece, NO_TUNE))!;
    expect([out.w, out.h]).toEqual([14, 14]); // 10 px and 2 px of room each side
    expect(render(piece, tuned(piece, { ...NO_TUNE, dabs: [{ x: 15, y: 15, r: 40, keep: false }] }))).toBeNull();
  });
});

describe("a cover in another theme's look", () => {
  // A measurer where fonts differ: Bangers is wide, Caveat narrow.
  const measurer = () => {
    const c = { font: "", letterSpacing: "0px", save() {}, restore() {}, measureText(t: string) { return { width: t.length * (c.font.includes("Bangers") ? 16 : c.font.includes("Caveat") ? 9 : 12) }; } };
    return c as unknown as CanvasRenderingContext2D;
  };
  const doc = { id: "d", kind: "tag" as const, updated: 0, background: { kind: "pattern" as const, pattern: "dots" as const, color: "#5b8def", ink: "#fff" }, layers: [
    { id: "t", type: "text" as const, text: "Summer", font: "caveat", size: 0.1, look: "cozy", align: "center" as const, x: 0.5, y: 0.5, w: 0, rot: 0 },
    { id: "p", type: "photo" as const, blob: "photo-1.jpg", aspect: 1, frame: "polaroid" as const, x: 0.3, y: 0.5, w: 0.2, rot: 0 },
  ] };

  it("keeps every text's room, whatever its font and look there", () => {
    const ctx = measurer();
    const before = layerSize(ctx, doc.layers[0], 1200, 600);
    const manga = withLook(doc, "manga");
    expect(manga.layers[0]).toMatchObject({ font: "bangers", look: "manga", box: { font: "caveat", look: "cozy" } });
    expect(layerSize(ctx, manga.layers[0], 1200, 600)).toEqual(before);
    // From one look to the next, the room is still the one it was made with.
    expect(layerSize(ctx, withLook(manga, "cp2077").layers[0], 1200, 600)).toEqual(before);
    // Without its box it would have grown (Bangers, upper case, a thicker outline).
    const text = manga.layers[0] as TextLayer;
    expect(layerSize(ctx, { ...text, box: undefined }, 1200, 600).w).toBeGreaterThan(before.w);
  });

  it("takes the theme's background and frames, but keeps a photo background", () => {
    const manga = withLook(doc, "manga");
    expect(manga.background).toMatchObject({ kind: "pattern", pattern: "tone" });
    expect(manga.layers[1]).toMatchObject({ look: "manga", frame: "polaroid" });
    const photo = { ...doc, background: { kind: "photo" as const, blob: "photo-2.jpg", blur: 0.3, color: "#000" } };
    expect(withLook(photo, "cp2077").background).toEqual(photo.background);
  });
});

describe("a scrapbook cover", () => {
  it("is edited with undo, rendered when done, and given to the album; its pictures go when it is removed", async () => {
    reset();
    const target = { kind: "album" as const, key: "Albums/Trip", name: "Trip" };
    await act(async () => useScrapbook.getState().open(target));
    expect(useStore.getState().screen).toBe("cover");
    const e = () => useScrapbook.getState().editing!;
    expect(e().doc.background).toMatchObject({ kind: "pattern", pattern: "dots" }); // blue with white dots
    const { change, undo, redo } = useScrapbook.getState();
    change((d) => ({ ...d, layers: [{ id: "s1", type: "sticker", src: { builtin: "red-heart" }, look: "original", outline: false, aspect: 1, x: 0.5, y: 0.5, w: 0.3, rot: 0 }] }));
    // A drag is one step back, however many moves.
    for (const x of [0.52, 0.55, 0.6]) change((d) => ({ ...d, layers: d.layers.map((l) => ({ ...l, x })) }), "move:s1:1");
    expect(e().past).toHaveLength(2);
    undo();
    expect(e().doc.layers[0].x).toBe(0.5);
    redo();
    expect(e().doc.layers[0].x).toBe(0.6);
    await act(async () => void (await useScrapbook.getState().done()));
    await new Promise((r) => setTimeout(r, 350)); // the file is saved a moment after the last change
    const lib = be.book as { books: Record<string, { rendered: string; layers: unknown[] }> };
    const [id] = Object.keys(lib.books);
    expect(lib.books[id].layers).toHaveLength(1);
    expect(lib.books[id].rendered).toMatch(/^cover-.*\.jpg$/);
    expect(be.blobs.has(lib.books[id].rendered)).toBe(true);
    expect(useStore.getState().library!.albumCovers).toEqual({ "Albums/Trip": id });
    expect(useStore.getState().screen).toBe("albums");
    // Opened again, it is the same layout to edit.
    await act(async () => useScrapbook.getState().open(target));
    expect(e().doc.id).toBe(id);
    expect(e().doc.layers).toHaveLength(1);
    useScrapbook.getState().cancel();
    // Saved again: the old render goes.
    const first = lib.books[id].rendered;
    await act(async () => useScrapbook.getState().open(target));
    await new Promise((r) => setTimeout(r, 5));
    await act(async () => void (await useScrapbook.getState().done()));
    expect(be.deleted).toContain(first);
    // Removed: the album has none, and its pictures go.
    await act(async () => useScrapbook.getState().removeCover(target));
    await settle();
    expect(useStore.getState().library!.albumCovers).toEqual({});
    expect(be.blobs.size).toBe(0);
  });

  it("follows its album when it moves, and its tag when renamed", async () => {
    reset();
    useStore.setState({ library: { ...library(), albumCovers: { "Albums/Trip": "b1" } } } as never);
    followMoves([["Albums/Trip", "Albums/Iceland"]]);
    await settle();
    expect(useStore.getState().library!.albumCovers).toEqual({ "Albums/Iceland": "b1" });
    await useTags.getState().load();
    useTags.setState({ data: { ...useTags.getState().data!, covers: { "motives/sea": "b2" } } });
    useTags.getState().renameTag("motives/sea", "motives/ocean");
    expect(useTags.getState().data!.covers).toEqual({ "motives/ocean": "b2" });
    useTags.getState().removeTag("motives/ocean");
    expect(useTags.getState().data!.covers).toEqual({});
  });

  it("the editor: a sticker and text put on, the text's look and font changed, a layer deleted with ⌫", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    await act(async () => useScrapbook.getState().open({ kind: "tag", id: "motives/sea", name: "sea" }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    expect(document.body.textContent).toContain("banner of");
    // Built-in stickers are there, each with its 3D picture.
    expect(STICKERS.length).toBeGreaterThan(100);
    const tile = document.body.querySelector(".scrap-tile.sticker") as HTMLButtonElement;
    await act(async () => tile.click());
    const doc = () => useScrapbook.getState().editing!.doc;
    expect(doc().layers[0]).toMatchObject({ type: "sticker", look: "original", outline: false });
    // Text, in a theme's look.
    await act(async () => (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Text") as HTMLButtonElement).click());
    await act(async () => (Array.from(document.body.querySelectorAll(".scrap-look")).find((b) => b.textContent?.includes("Manga")) as HTMLButtonElement).click());
    expect(doc().layers[1]).toMatchObject({ type: "text", text: "sea", look: "manga", font: "bangers" });
    // A new text is typed into where it is on the page.
    const area = document.body.querySelector(".scrap-page .scrap-typing") as HTMLTextAreaElement;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(area, "Summer at sea");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((doc().layers[1] as { text: string }).text).toBe("Summer at sea");
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" })));
    expect(doc().layers).toHaveLength(1);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true })));
    expect(doc().layers).toHaveLength(2);
    root.unmount();
  });

  it("seen in another theme's look without changing it, then kept in it", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    await act(async () => useScrapbook.getState().open({ kind: "album", key: "Albums/Trip", name: "Trip" }));
    useScrapbook.getState().change((d) => ({ ...d, layers: [{ id: "t1", type: "text", text: "Trip", font: "caveat", size: 0.07, look: "cozy", align: "center", x: 0.5, y: 0.5, w: 0, rot: 0, color: "#ff0000" }, { id: "s1", type: "sticker", src: { builtin: "red-heart" }, look: "original", outline: false, aspect: 1, x: 0.5, y: 0.6, w: 0.3, rot: 0 }] }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    const top = document.body.querySelector(".scrap-top")!;
    await act(async () => (top.querySelector(".sel-btn") as HTMLButtonElement).click());
    await act(async () => (Array.from(document.querySelectorAll(".sel-opt")).find((o) => o.textContent?.includes("Manga")) as HTMLElement).click());
    const doc = () => useScrapbook.getState().editing!.doc;
    expect(doc().layers.map((l) => ("look" in l ? l.look : null))).toEqual(["cozy", "original"]); // only seen so
    const keep = Array.from(top.querySelectorAll("button")).find((b) => b.textContent?.includes("Keep this look")) as HTMLButtonElement;
    await act(async () => keep.click());
    expect(doc().layers.map((l) => ("look" in l ? l.look : null))).toEqual(["manga", "manga"]);
    expect(doc().layers[0]).toMatchObject({ font: "bangers", color: undefined });
    root.unmount();
    useScrapbook.getState().cancel();
  });

  it("the sticker studio offers the cutter's download when it isn't there, and says when the engine is too old", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    const start = vi.fn(async () => {});
    const model = { id: "cutout", kind: "cutout", name: "Sticker cutter", note: "", size: 224_005_088, downloaded: false };
    useEngine.setState({ catalog: { available: true, models: [model], used: 0, chosen: "", downloading: false } as never, refresh: async () => {}, start } as never);
    const item = { key: "Pics/a.jpg", name: "a", primary: "/vol/Pics/a.jpg", files: ["/vol/Pics/a.jpg"], kind: "image", dir: "Pics", size: 1, modified: 0, hasRaw: false, hasVideo: false } as never;
    await act(async () => useScrapbook.getState().openStudio({ item }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(StickerStudio)));
    const button = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("Download the sticker cutter")) as HTMLButtonElement;
    expect(document.body.textContent).toContain("224 MB");
    await act(async () => button.click());
    expect(start).toHaveBeenCalledWith("cutout");
    await act(async () => useEngine.setState({ catalog: { available: true, models: [], used: 0, chosen: "", downloading: false } as never }));
    expect(document.body.textContent).toContain("older than the app");
    root.unmount();
    useScrapbook.getState().closeStudio();
  });
});

describe("bars across a cover's background", () => {
  const page = (bars: unknown[] = []) => ({ id: "p", kind: "tag" as const, background: { kind: "pattern" as const, pattern: "dots" as const, color: "#5b8def", ink: "#ffffff" }, bars: bars as never, layers: [], updated: 0 });
  const bar = (x: number, more: object = {}) => ({ id: `b${x}`, x, angle: 0, width: 0.035, color: "#ffffff", fill: "#f7c6d6", style: "straight", ...more });

  it("a new one goes in the widest part, white, its right side a colour unlike the part it splits", () => {
    const first = newBar(page());
    expect(first).toMatchObject({ x: 0.5, angle: 0, color: "#ffffff", style: "straight" });
    expect(first.fill).not.toBe("#5b8def");
    const second = newBar(page([first]));
    expect(second.x).toBe(0.25);
    expect(second.fill).not.toBe("#5b8def");
    const third = newBar(page([bar(0.3), bar(0.4, { fill: "#fff1a8" })]));
    expect(third.x).toBeCloseTo(0.7);
    expect(partColour(page([bar(0.3), bar(0.4, { fill: "#fff1a8" })]), 0.7)).toBe("#fff1a8");
    expect(third.fill).not.toBe("#fff1a8");
  });

  it("is found under the pointer along its whole length, tilted or jagged", () => {
    // A banner 1200 × 600: a bar 21 px thick through the middle.
    expect(barAt(page([bar(0.5)]), 1200, 600, 600, 300)?.id).toBe("b0.5");
    expect(barAt(page([bar(0.5)]), 1200, 600, 612, 20)?.id).toBe("b0.5");
    expect(barAt(page([bar(0.5)]), 1200, 600, 640, 300)).toBeNull();
    // Tilted 30°: its top leans right, 173 px from the middle.
    const tilted = page([bar(0.5, { angle: 30 })]);
    expect(barAt(tilted, 1200, 600, 773, 0)).not.toBeNull();
    expect(barAt(tilted, 1200, 600, 600, 0)).toBeNull();
    // Lightning: on its jags, not on the straight line through them.
    const bolt = page([bar(0.5, { style: "lightning" })]);
    const along = Array.from({ length: 60 }, (_, i) => i * 10).filter((y) => barAt(bolt, 1200, 600, 600, y));
    expect(along.length).toBeLessThan(60);
    expect(Array.from({ length: 60 }, (_, i) => i * 10).every((y) => [-60, -40, -20, 0, 20, 40, 60].some((dx) => barAt(bolt, 1200, 600, 600 + dx, y)))).toBe(true);
  });

  it("draws in every style", () => {
    const c = document.createElement("canvas").getContext("2d")!;
    for (const style of ["straight", "lightning", "torn", "stitched", "zigzag"]) expect(() => drawPage(c, page([bar(0.3, { style }), bar(0.6, { style, angle: -20 })]), 1200, 600, new AssetCache(async () => ""))).not.toThrow();
  });

  it("the editor: added, styled, dragged and tilted on the page, deleted with ⌫", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    await act(async () => useScrapbook.getState().open({ kind: "tag", id: "motives/sea", name: "sea" }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    const doc = () => useScrapbook.getState().editing!.doc;
    const button = (text: string) => Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
    await act(async () => button("Background").click());
    await act(async () => button("Add a bar").click());
    expect(doc().bars).toHaveLength(1);
    const id = doc().bars![0].id;
    expect(useScrapbook.getState().editing!.selected).toBe(id);
    expect(document.body.querySelector(".scrap-bar")?.textContent).toContain("Bar");
    await act(async () => button("Lightning").click());
    expect(doc().bars![0].style).toBe("lightning");
    // jsdom has no layout: the page is drawn 120 × 60, at the top left.
    const el = document.body.querySelector(".scrap-page")!;
    const fire = (type: string, x: number, y: number, button = 0) => act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button })));
    await act(async () => useScrapbook.getState().select(null));
    await act(async () => useScrapbook.getState().change((d) => ({ ...d, bars: d.bars!.map((b) => ({ ...b, style: "straight" as const })) })));
    await fire("pointerdown", 60, 30);
    expect(useScrapbook.getState().editing!.selected).toBe(id);
    await fire("pointermove", 90, 30);
    await fire("pointerup", 90, 30);
    expect(doc().bars![0].x).toBeCloseTo(0.75);
    // Its knob tilts it, never past 70°.
    const knob = document.body.querySelector(".scrap-sel.bar .scrap-handle.turn")!;
    await act(async () => void knob.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 90, clientY: 0 })));
    await fire("pointermove", 120, 0);
    await fire("pointerup", 120, 0);
    expect(doc().bars![0].angle).toBe(45);
    await fire("pointerdown", 90 + 30, 0);
    await fire("pointerup", 90 + 30, 0);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" })));
    expect(doc().bars).toHaveLength(0);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true })));
    expect(doc().bars).toHaveLength(1);
    root.unmount();
  });
});

describe("the cover editor's right-click and export", () => {
  it("brings a layer forward or to the front, sends it backward or to the back", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    await act(async () => useScrapbook.getState().open({ kind: "tag", id: "motives/sea", name: "sea" }));
    const sticker = (id: string, x: number) => ({ id, type: "sticker" as const, src: { builtin: STICKERS[0].id }, look: "original", outline: false, aspect: 1, x, y: 0.5, w: 0.2, rot: 0 });
    // Three stickers overlapping in the middle; "a" at the back.
    await act(async () => useScrapbook.getState().change((d) => ({ ...d, layers: [sticker("a", 0.5), sticker("b", 0.45), sticker("c", 0.55)] })));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    const order = () => useScrapbook.getState().editing!.doc.layers.map((l) => l.id).join("");
    const el = document.body.querySelector(".scrap-page")!;
    const menu = async (x: number, pick: string) => {
      await act(async () => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: 30 })));
      const item = Array.from(document.querySelectorAll(".context-menu .context-item")).find((b) => b.textContent?.trim() === pick) as HTMLButtonElement;
      expect(item.disabled).toBe(false);
      await act(async () => item.click());
    };
    // The page is drawn 120 px wide: "c" alone covers x 54..78, so 76 is on it.
    await menu(76, "Send to back");
    expect(order()).toBe("cab");
    await menu(76, "Bring forward");
    expect(order()).toBe("acb");
    await menu(76, "Bring to front");
    expect(order()).toBe("abc");
    await menu(76, "Send backward");
    expect(order()).toBe("acb");
    await menu(76, "Send backward");
    expect(order()).toBe("cab");
    // At the back, it can't go further back.
    await act(async () => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 76, clientY: 30 })));
    const items = Array.from(document.querySelectorAll(".context-menu .context-item")) as HTMLButtonElement[];
    expect(items.find((b) => b.textContent?.trim() === "Send to back")!.disabled).toBe(true);
    expect(items.find((b) => b.textContent?.trim() === "Send backward")!.disabled).toBe(true);
    expect(items.find((b) => b.textContent?.trim() === "Bring to front")!.disabled).toBe(false);
    root.unmount();
  });

  it("exports the cover as you see it, at twice its size, as PNG or JPEG where you pick", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    be.rendered = [];
    await act(async () => useScrapbook.getState().open({ kind: "tag", id: "motives/sea", name: "sea" }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    await act(async () => (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("Export")) as HTMLButtonElement).click());
    await act(async () => settle());
    expect(api.scrapbookExport).toHaveBeenCalledWith("sea banner.png", btoa("rendered"), btoa("rendered"));
    expect(be.rendered).toEqual([
      [2400, 1200, "image/png"],
      [2400, 1200, "image/jpeg"],
    ]);
    // Nothing is saved to the scrapbook by it: still editing.
    expect(useScrapbook.getState().editing).not.toBeNull();
    root.unmount();
  });
});

describe("the editor: several at once, and keys to add", () => {
  const sticker = (id: string, x: number) => ({ id, type: "sticker" as const, src: { builtin: STICKERS[0].id }, look: "original", outline: false, aspect: 1, x, y: 0.5, w: 0.15, rot: 0 });

  it("a box dragged across the page selects what it touches; they move, restack and go together", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    await act(async () => useScrapbook.getState().open({ kind: "tag", id: "motives/sea", name: "sea" }));
    // On a page drawn 120 × 60: "a" over x 15..33, "b" 51..69, "c" 87..105, all at y 21..39.
    await act(async () => useScrapbook.getState().change((d) => ({ ...d, layers: [sticker("a", 0.2), sticker("b", 0.5), sticker("c", 0.8)] })));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    const e = () => useScrapbook.getState().editing!;
    const el = document.body.querySelector(".scrap-page")!;
    const fire = (type: string, x: number, y: number, more: MouseEventInit = {}) => act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, ...more })));
    await fire("pointerdown", 2, 2);
    await fire("pointermove", 70, 58);
    expect(document.body.querySelector(".scrap-sweep")).not.toBeNull();
    await fire("pointerup", 70, 58);
    expect(e().many).toEqual(["a", "b"]);
    expect(document.body.querySelector(".scrap-bar")?.textContent).toContain("2 selected");
    expect(document.body.querySelectorAll(".scrap-sel.many")).toHaveLength(2);
    // Dragging one moves both.
    await fire("pointerdown", 60, 30);
    await fire("pointermove", 66, 30);
    await fire("pointerup", 66, 30);
    expect(e().doc.layers.map((l) => l.x)).toEqual([expect.closeTo(0.25), expect.closeTo(0.55), 0.8]);
    expect(e().many).toEqual(["a", "b"]);
    await act(async () => (document.body.querySelector(".scrap-bar button[title='Bring to front']") as HTMLButtonElement).click());
    expect(e().doc.layers.map((l) => l.id).join("")).toBe("cab");
    // ⇧-click takes one more in, ⌫ takes them all off, ⌘Z brings them back.
    await fire("pointerdown", 96, 30, { shiftKey: true });
    await fire("pointerup", 96, 30, { shiftKey: true });
    expect(e().many).toEqual(["a", "b", "c"]);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" })));
    expect(e().doc.layers).toHaveLength(0);
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true })));
    expect(e().doc.layers).toHaveLength(3);
    root.unmount();
    useScrapbook.getState().cancel();
  });

  it("a selection box can start beside the page, and a click beside it selects nothing", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    await act(async () => useScrapbook.getState().open({ kind: "tag", id: "motives/sea", name: "sea" }));
    await act(async () => useScrapbook.getState().change((d) => ({ ...d, layers: [sticker("a", 0.2), sticker("b", 0.5), sticker("c", 0.8)] })));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    const e = () => useScrapbook.getState().editing!;
    // The page is drawn 120 × 60 at the top left: 130, 70 is on the stage beside it.
    const stage = document.body.querySelector(".scrap-stage")!;
    const fire = (type: string, x: number, y: number) => act(async () => void stage.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })));
    await fire("pointerdown", 130, 70);
    await fire("pointermove", 40, 20);
    await fire("pointerup", 40, 20);
    expect(e().many).toEqual(["b", "c"]);
    await fire("pointerdown", 130, 70);
    await fire("pointerup", 130, 70);
    expect(e().many).toEqual([]);
    expect(e().selected).toBeNull();
    root.unmount();
    useScrapbook.getState().cancel();
  });

  it("on a board, T, N and A put a text, a note and an arrow on; a text emptied goes", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset();
    await act(async () => useScrapbook.getState().newBoard("Refs", { w: 1200, h: 600 }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    const e = () => useScrapbook.getState().editing!;
    const key = (k: string) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k })));
    await key("t");
    expect(e().doc.layers[0]).toMatchObject({ type: "text", text: "Text" });
    expect(e().typing).toBe(e().doc.layers[0].id);
    const area = document.body.querySelector(".scrap-page .scrap-typing") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(area);
    // Emptied and left: it goes.
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(area, "");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void area.blur());
    expect(e().doc.layers).toHaveLength(0);
    expect(e().typing).toBeNull();
    await key("n");
    expect(e().doc.layers[0]).toMatchObject({ type: "note", text: "", fix: { kind: "pin", where: "one" } });
    await act(async () => void (document.body.querySelector(".scrap-typing") as HTMLTextAreaElement).blur());
    expect(e().doc.layers).toHaveLength(1); // a blank note stays
    await key("a");
    expect(e().doc.layers[1]).toMatchObject({ type: "arrow", heads: "end" });
    expect(document.body.querySelector(".scrap-bar")?.textContent).toContain("Arrow");
    root.unmount();
    useScrapbook.getState().cancel();
  });
});

describe("a board's pictures of the library", () => {
  it("are asked for as the app's own, so a board drawn with them can still be saved and exported", async () => {
    const made: { crossOrigin?: string }[] = [];
    const Was = (globalThis as { Image: new () => object }).Image;
    (globalThis as { Image: unknown }).Image = class extends (Was as new () => object) {
      constructor() {
        super();
        made.push(this as { crossOrigin?: string });
      }
    };
    try {
      const cache = new AssetCache(async () => "blob:x", async () => "thumb://localhost/a.jpg?w=1600");
      cache.item("Photos/a.jpg");
      await settle();
      expect(made[0]?.crossOrigin).toBe("anonymous");
    } finally {
      (globalThis as { Image: unknown }).Image = Was;
    }
  });
});
