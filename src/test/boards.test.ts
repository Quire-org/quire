import { describe, expect, it, vi } from "vitest";
import { blobsOf, migrated, pageOf, resized, type ScrapDoc } from "../scrapbook/model";

// The backend, as far as Scrapbook goes: its file and its pictures.
const be = vi.hoisted(() => ({ book: null as unknown, deleted: [] as string[] }));
vi.mock("../lib/api", () => ({
  api: {
    scrapbookLoad: vi.fn(async () => be.book),
    scrapbookSave: vi.fn(async (_r: string, d: unknown) => void (be.book = d)),
    scrapbookBlob: vi.fn(async () => new ArrayBuffer(4)),
    scrapbookBlobPut: vi.fn(async () => {}),
    scrapbookBlobDelete: vi.fn(async (_r: string, name: string) => void be.deleted.push(name)),
    saveLibrary: vi.fn(async () => {}),
  },
  storedPath: (root: string, p: string) => p.slice(root.length + 1),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const board = (over: Partial<ScrapDoc> = {}): ScrapDoc => ({ id: "b1", kind: "board", name: "Poses", size: { w: 2000, h: 1000 }, background: { kind: "pattern", pattern: "cork", color: "#c49a6c", ink: "#8b6340" }, layers: [], updated: 0, ...over });

describe("a board", () => {
  it("is its own size, and a new size keeps what is on it where it is, in pixels", () => {
    const doc = board({
      layers: [
        { id: "p", type: "photo", blob: "a.jpg", aspect: 1, frame: "none", x: 0.25, y: 0.5, w: 0.2, rot: 0 },
        { id: "t", type: "text", text: "Hands", font: "caveat", size: 0.05, look: "cozy", align: "center", x: 0.9, y: 0.9, w: 0, rot: 0 },
        { id: "a", type: "arrow", color: "#e5484d", thickness: 0.006, heads: "end", x: 0.5, y: 0.5, w: 0.1, rot: 30 },
      ],
    });
    expect(pageOf(doc)).toEqual({ w: 2000, h: 1000 });
    const big = resized(doc, 4000, 2000);
    expect(big.size).toEqual({ w: 4000, h: 2000 });
    const [p, t, a] = big.layers;
    // The photo at the same pixels (500, 500), 400 wide; the text as tall; the arrow as long and thick.
    expect([p.x * 4000, p.y * 2000, p.w * 4000]).toEqual([500, 500, 400]);
    expect(t.type === "text" && t.size * 2000).toBeCloseTo(50);
    expect(a.type === "arrow" && [a.w * 4000, a.thickness * 2000]).toEqual([200, 6]);
  });

  it("brings back to its edge what a smaller size would leave outside, and keeps within its limits", () => {
    const doc = board({ layers: [{ id: "n", type: "note", text: "warm light", paper: "#fff1a8", x: 0.9, y: 0.9, w: 0.1, rot: 0 }] });
    const small = resized(doc, 1000, 500);
    expect([small.layers[0].x, small.layers[0].y]).toEqual([1, 1]);
    expect(resized(doc, 99999, 10).size).toEqual({ w: 8000, h: 300 });
  });

  it("keeps what held its pictures up before pins and tape were their own: a taped frame, and a pin board's pins", () => {
    const cover: ScrapDoc = { ...board(), kind: "album", size: undefined, background: { kind: "pattern", pattern: "dots", color: "#000", ink: "#fff" }, layers: [{ id: "p", type: "photo", blob: "a.jpg", aspect: 1, frame: "tape", x: 0.5, y: 0.5, w: 0.2, rot: 0 }] };
    expect(migrated(cover).layers[0]).toMatchObject({ frame: "none", fix: { kind: "tape", where: "top" } });
    const pinned = migrated(board({ layers: [{ id: "n", type: "note", text: "", paper: "#fff", x: 0.5, y: 0.5, w: 0.1, rot: 0 }, { id: "q", type: "photo", blob: "b.jpg", aspect: 1, frame: "none", fix: null, x: 0.5, y: 0.5, w: 0.2, rot: 0 }] }));
    // Pinned where nothing was said; one taken off since stays off.
    expect(pinned.layers.map((l) => ("fix" in l ? l.fix : undefined))).toEqual([{ kind: "pin", where: "one" }, null]);
    const kept = board();
    expect(migrated(kept)).toBe(kept);
  });

  it("keeps no file for a library picture it points at", () => {
    const doc = board({ layers: [{ id: "p", type: "photo", blob: "", item: "Photos/a.jpg", aspect: 1, frame: "none", x: 0.5, y: 0.5, w: 0.2, rot: 0 }], rendered: "cover-b1.jpg" });
    expect(blobsOf(doc)).toEqual(["cover-b1.jpg"]);
  });

  it("follows the library's pictures it points at when they move, and goes with the pictures copied onto it", async () => {
    const { useStore } = await import("../store");
    const { useScrapbook } = await import("../scrapbook/store");
    useStore.setState({ root: "/vol" } as never);
    be.book = { version: 1, books: { b1: board({ layers: [{ id: "p", type: "photo", blob: "", item: "Inbox/a.jpg", aspect: 1, frame: "none", x: 0.5, y: 0.5, w: 0.2, rot: 0 }, { id: "q", type: "photo", blob: "board-q.jpg", aspect: 1, frame: "none", x: 0.5, y: 0.5, w: 0.2, rot: 0 }] }) }, stickers: [], banners: {} };
    await useScrapbook.getState().load();
    useScrapbook.getState().follow((k) => (k === "Inbox/a.jpg" ? "Photos/a.jpg" : null));
    const p = useScrapbook.getState().lib!.books.b1.layers[0];
    expect(p.type === "photo" && p.item).toBe("Photos/a.jpg");
    await useScrapbook.getState().removeBoard("b1");
    expect(useScrapbook.getState().lib!.books.b1).toBeUndefined();
    expect(be.deleted).toEqual(["board-q.jpg"]);
  });
});
