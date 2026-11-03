import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const be = vi.hoisted(() => ({ book: null as unknown, blobs: new Map<string, string>(), deleted: [] as string[] }));
vi.mock("../lib/api", () => ({
  api: {
    scrapbookLoad: vi.fn(async () => be.book),
    scrapbookSave: vi.fn(async (_r: string, d: unknown) => void (be.book = d)),
    scrapbookBlob: vi.fn(async () => new ArrayBuffer(4)),
    scrapbookBlobPut: vi.fn(async (_r: string, name: string, data: string) => void be.blobs.set(name, data)),
    scrapbookBlobDelete: vi.fn(async (_r: string, name: string) => void (be.blobs.delete(name), be.deleted.push(name))),
    saveLibrary: vi.fn(async () => {}),
    loadTags: vi.fn(async () => null),
    saveTags: vi.fn(async () => {}),
    tagsIndexLoad: vi.fn(async () => ({ auto: {}, indexed: {} })),
    loadAlbums: vi.fn(async () => []),
    loadCache: vi.fn(async () => null),
    scanDir: vi.fn(async () => []),
  },
  storedPath: (r: string, p: string) => p.slice(r.length + 1),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
// jsdom draws nothing: a canvas that takes every call, whose pixels are a 4 × 2 sticker (left half
// seen, right half see-through), and renders to a blob.
const noop = () => {};
const ctx = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) =>
    k in t
      ? t[k]
      : k === "measureText"
        ? (s: string) => ({ width: s.length * 10 })
        : k === "getImageData"
          ? (_x: number, _y: number, w: number, h: number) => ({ data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => (i % 4 === 3 ? ((i >> 2) % w < w / 2 ? 255 : 0) : 90)) })
          : noop,
  set: (t, k, v) => ((t[k] = v), true),
});
HTMLCanvasElement.prototype.getContext = (() => ctx) as never;
HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback, type?: string) {
  cb(new Blob(["rendered"], { type: type ?? "image/png" }));
};
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 4;
  naturalHeight = 2;
  width = 4;
  height = 2;
  set src(_: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}
(globalThis as { Image: unknown }).Image = FakeImage;
// jsdom has no ImageData: pixels and a size are all the drawing here needs.
(globalThis as { ImageData?: unknown }).ImageData ??= class {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number,
  ) {}
};
URL.createObjectURL = () => "blob:x";
URL.revokeObjectURL = noop;
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { useStore } = await import("../store");
const { useScrapbook } = await import("../scrapbook/store");
const { loadPiece, StickerStudio } = await import("../components/StickerStudio");
const { StickerBook } = await import("../components/StickerBook");
const { NO_TUNE } = await import("../scrapbook/subjects");

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const bg = { kind: "pattern" as const, pattern: "dots" as const, color: "#000", ink: "#fff" };
const onIt = (id: string, blob: string) => ({ id, type: "sticker" as const, src: { blob }, look: "original", outline: true, aspect: 1, x: 0.5, y: 0.5, w: 0.3, rot: 0 });

function mount(el: ReturnType<typeof createElement>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root, render: () => act(async () => root.render(el)) };
}

describe("fine-tuning a sticker again", () => {
  it("every cover with it on takes the new one (the one being made too, its undo included), and is drawn again", async () => {
    be.blobs = new Map();
    be.deleted = [];
    const sticker = { id: "s1", blob: "sticker-old.png", w: 10, h: 10, cut: { picture: "sticker-s1-picture.png", mask: "sticker-s1-mask.png", tune: NO_TUNE } };
    const b1 = { id: "b1", kind: "album" as const, background: bg, layers: [onIt("l1", "sticker-old.png")], updated: 0, rendered: "cover-b1-1.jpg" };
    const b2 = { id: "b2", kind: "album" as const, background: bg, layers: [onIt("l2", "sticker-other.png")], updated: 0, rendered: "cover-b2-1.jpg" };
    useStore.setState({ root: "/vol", library: { version: 1, targets: [], trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {}, albumCovers: { "Albums/Trip": "b1" } } } as never);
    useScrapbook.setState({
      lib: { version: 1, books: { b1, b2 }, stickers: [sticker], banners: {} },
      editing: { target: { kind: "album", key: "Albums/Trip", name: "Trip" }, doc: b1, selected: null, past: [{ ...b1, layers: [] }, b1], future: [], mergeKey: null, saving: false, added: [] } as never,
    });
    await act(async () => useScrapbook.getState().replaceSticker({ ...sticker, blob: "sticker-new.png", w: 20, h: 10, cut: { ...sticker.cut, tune: { edge: 2, soft: 1, dabs: [] } } }));
    await settle();
    const st = useScrapbook.getState();
    expect(st.lib!.stickers[0]).toMatchObject({ id: "s1", blob: "sticker-new.png", w: 20, cut: { tune: { edge: 2 } } });
    expect(st.lib!.books.b1.layers[0]).toMatchObject({ src: { blob: "sticker-new.png" }, aspect: 0.5 });
    expect(st.lib!.books.b2.layers[0]).toMatchObject({ src: { blob: "sticker-other.png" } });
    expect(st.editing!.doc.layers[0]).toMatchObject({ src: { blob: "sticker-new.png" } });
    expect((st.editing!.past[1] as typeof b1).layers[0].src).toEqual({ blob: "sticker-new.png" });
    // b1 drawn again; b2 not.
    expect(st.lib!.books.b1.rendered).not.toBe("cover-b1-1.jpg");
    expect(be.blobs.has(st.lib!.books.b1.rendered!)).toBe(true);
    expect(st.lib!.books.b2.rendered).toBe("cover-b2-1.jpg");
    // The old picture and the old render go; the kept picture and mask stay.
    expect(be.deleted).toEqual(expect.arrayContaining(["sticker-old.png", "cover-b1-1.jpg"]));
    expect(be.deleted).not.toContain("sticker-s1-picture.png");
  });

  it("opens an older sticker with room round it, never painted back past its cut", async () => {
    // A 4 × 2 sticker, its left half seen: 16 px of room on each side.
    const { piece, ceiling, tune } = await loadPiece({ id: "old", blob: "sticker-old.png", w: 4, h: 2 });
    expect([piece.w, piece.h]).toEqual([36, 34]);
    expect(piece.alpha[16 * 36 + 16]).toBe(255);
    expect(piece.alpha[16 * 36 + 19]).toBe(0);
    expect(piece.rgb[(16 * 36 + 16) * 4 + 3]).toBe(255);
    expect(ceiling).toBe(piece.alpha);
    expect(tune).toBe(NO_TUNE);
    // One kept with its picture: its mask from the grey file, its tuning as it was, free to paint.
    const kept = await loadPiece({ id: "new", blob: "sticker-new.png", w: 4, h: 2, cut: { picture: "p.png", mask: "m.png", tune: { edge: 3, soft: 0, dabs: [] }, solid: true } });
    expect(kept.ceiling).toBeNull();
    expect(kept.tune.edge).toBe(3);
    expect(kept.piece.alpha[0]).toBe(90);
    // Kept before the edge was narrowed: its half-sure parts made solid, as they would be cut now.
    const veiled = await loadPiece({ id: "mid", blob: "sticker-mid.png", w: 4, h: 2, cut: { picture: "p.png", mask: "m.png", tune: NO_TUNE } });
    expect(veiled.piece.alpha[0]).toBe(0);
  });
});

describe("a sticker's story in the book", () => {
  const items = [
    { key: "Manga/A/001.jpg", name: "001.jpg", dir: "Manga/A", path: "/vol/Manga/A/001.jpg", primary: "/vol/Manga/A/001.jpg", kind: "image", size: 1, mtime: 0, members: [] },
    { key: "Manga/B/001.jpg", name: "001.jpg", dir: "Manga/B", path: "/vol/Manga/B/001.jpg", primary: "/vol/Manga/B/001.jpg", kind: "image", size: 1, mtime: 0, members: [] },
    { key: "Pics/cat.jpg", name: "cat.jpg", dir: "Pics", path: "/vol/Pics/cat.jpg", primary: "/vol/Pics/cat.jpg", kind: "image", size: 1, mtime: 0, members: [] },
  ];
  const open = async (sticker: object) => {
    useStore.setState({ root: "/vol", allItems: items, albums: [], screen: "scrapbook", theme: "cozy" } as never);
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: [sticker as never], banners: {} }, editing: null, studio: null });
    const m = mount(createElement(StickerBook, { onMake: () => {} }));
    await m.render();
    await act(async () => (m.host.querySelector(".book-slot") as HTMLButtonElement).click());
    return m;
  };

  it("asks which picture it was cut from when several have its name, and remembers the answer", async () => {
    const { host, root } = await open({ id: "s1", blob: "sticker-s1.png", w: 4, h: 2, from: "001.jpg" });
    const info = host.querySelector(".sticker-info")!;
    expect(info.textContent).toContain("2 pictures are called “001.jpg”");
    expect(info.textContent).not.toContain("Open the picture");
    await act(async () => (info.querySelectorAll(".sticker-info-named button")[1] as HTMLButtonElement).click());
    expect(useScrapbook.getState().lib!.stickers[0].source).toBe("Manga/B/001.jpg");
    expect(host.querySelector(".sticker-info")!.textContent).toContain("Manga/B/001.jpg");
    root.unmount();
  });

  it("says when it was found by its name only, and is told so", async () => {
    const { host, root } = await open({ id: "s1", blob: "sticker-s1.png", w: 4, h: 2, from: "cat.jpg" });
    expect(host.querySelector(".sticker-info")!.textContent).toContain("Found by its name only");
    await act(async () => (Array.from(host.querySelectorAll(".sticker-info button")).find((b) => b.textContent?.includes("That's it")) as HTMLButtonElement).click());
    expect(useScrapbook.getState().lib!.stickers[0].source).toBe("Pics/cat.jpg");
    expect(host.querySelector(".sticker-info")!.textContent).not.toContain("Found by its name only");
    root.unmount();
  });

  it("opens the sticker's fine-tuning, and the wheel scrolls it instead of turning the page", async () => {
    const sticker = { id: "s1", blob: "sticker-s1.png", w: 4, h: 2, source: "Pics/cat.jpg" };
    const { host, root } = await open(sticker);
    const book = host.querySelector(".sticker-book")!;
    await act(async () => void book.dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true })));
    expect(host.querySelector(".sticker-info")).toBeTruthy();
    expect(host.querySelector(".book-leaf")).toBeNull();
    await act(async () => (Array.from(host.querySelectorAll(".sticker-info button")).find((b) => b.textContent?.includes("Fine-tune")) as HTMLButtonElement).click());
    await settle();
    expect(useScrapbook.getState().studio?.sticker).toMatchObject({ id: "s1" });
    root.unmount();
  });
});

describe("fine-tuning's brush and zoom", () => {
  it("shows the brush where it paints, sizes it with [ and ], takes back whole strokes, and zooms like the viewer", async () => {
    // jsdom lays nothing out: the stage is 600 × 400, the sticker shown 360 wide.
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} }) as DOMRect;
    const was = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains("tune-stage")) return rect(0, 0, 600, 400);
      if (this instanceof HTMLCanvasElement && this.width) return rect(120, 20, 360, (360 * this.height) / this.width);
      return rect(0, 0, 0, 0);
    };
    const sticker = { id: "s1", blob: "sticker-s1.png", w: 4, h: 2 };
    useStore.setState({ root: "/vol" } as never);
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: [sticker], banners: {} }, editing: null, studio: { sticker } });
    const m = mount(createElement(StickerStudio));
    await m.render();
    await act(async () => settle());
    const stage = document.querySelector(".tune-stage") as HTMLElement;
    expect(stage).toBeTruthy();
    const canvas = stage.querySelector("canvas") as HTMLCanvasElement;
    const k = 360 / canvas.width;
    const fire = (el: Element, type: string, x: number, y: number) => act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })));
    const key = (k: string, more: KeyboardEventInit = {}) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, ...more })));
    const button = (text: string) => Array.from(document.querySelectorAll(".sticker-maker button")).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;
    await act(async () => button("Erase").click());
    // The brush's circle under the pointer, as big as it paints.
    await fire(stage, "pointermove", 300, 200);
    const circle = () => stage.querySelector(".brush-cursor.mode-1") as HTMLElement;
    expect(circle().style.left).toBe("300px");
    expect(parseFloat(circle().style.width)).toBeCloseTo(2 * 12 * k);
    await key("]");
    expect(parseFloat(circle().style.width)).toBeCloseTo(2 * 16 * k);
    // Two strokes; ⌫ takes back a whole stroke at a time.
    for (const y of [100, 200]) {
      await fire(canvas, "pointerdown", 200, y);
      await fire(stage, "pointermove", 300, y);
      await fire(stage, "pointerup", 300, y);
    }
    expect(button("Undo stroke").disabled).toBe(false);
    await key("Backspace");
    expect(button("Undo stroke").disabled).toBe(false);
    await key("Backspace");
    expect(button("Undo stroke").disabled).toBe(true);
    // Z in and out; pinch about the pointer.
    await key("z");
    expect(stage.querySelector(".zoom-badge")?.textContent).toBe("250%");
    await key("z");
    expect(stage.querySelector(".zoom-badge")).toBeNull();
    await act(async () => void stage.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 200, bubbles: true, cancelable: true })));
    expect(stage.querySelector(".zoom-badge")?.textContent).toBe("272%");
    // Against black, to spot stray bits; remembered.
    await act(async () => button("Black").click());
    expect(stage.classList.contains("on-black")).toBe(true);
    expect(localStorage.getItem("quire.tuneBackdrop")).toBe("black");
    m.root.unmount();
    Element.prototype.getBoundingClientRect = was;
    useScrapbook.setState({ studio: null });
  });
});
