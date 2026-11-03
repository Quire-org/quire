import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const be = vi.hoisted(() => ({ book: null as unknown, deleted: [] as string[] }));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      scrapbookLoad: async () => be.book,
      scrapbookSave: async (_r: string, d: unknown) => void (be.book = d),
      scrapbookBlob: async () => new ArrayBuffer(4),
      scrapbookBlobDelete: async (_r: string, name: string) => void be.deleted.push(name),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  mediaUrl: () => "",
  thumbUrl: () => "",
  faceUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));
// jsdom draws nothing and lays nothing out: a canvas that takes every call, and a banner 1000 × 180.
const noop = () => {};
HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => noop, set: () => true })) as never;
for (const [k, v] of [["clientWidth", 1000], ["clientHeight", 180]] as const)
  Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get() { return (this as HTMLElement).classList.contains("banner-page") ? v : 0; } });
class FakeImage {
  onload: (() => void) | null = null;
  set src(_: string) {}
}
(globalThis as { Image: unknown }).Image = FakeImage;
URL.createObjectURL = () => "blob:x";
URL.revokeObjectURL = noop;

const { useStore } = await import("../store");
const { useScrapbook } = await import("../scrapbook/store");
const { usePeople } = await import("../peopleStore");
const { useArtists } = await import("../artistsStore");
const { StickerBanner } = await import("../components/StickerBanner");
const { STICKER_DRAG } = await import("../components/StickerShelf");

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const shelf = { id: "s1", blob: "sticker-s1.png", w: 10, h: 20 };
const person = (id: string, banner?: string) => ({ id, name: id, kind: "person" as const, from: null, portrait: null, added: 0, ...(banner ? { banner } : {}) });
const artist = (id: string, banner?: string) => ({ id, name: id, renamed: true, links: [], avatar: null, avatarAt: 0, bio: "", region: "", pages: [], fetched: null, added: 0, ...(banner ? { banner } : {}) });
const placed = (id: string, blob: string) => ({ id, src: { blob }, aspect: 1, look: "original", outline: true, x: 100, y: 0, w: 90, rot: 0 });
const banners = () => useScrapbook.getState().lib!.banners;

beforeEach(() => {
  be.deleted = [];
  useStore.setState({ root: "/vol", theme: "cozy" } as never);
  usePeople.setState({ doc: { version: 1, people: { pe1: person("pe1") }, faces: {}, no: [], not: {}, exclude: [], converted: null }, docRoot: "/vol" });
  useArtists.setState({ doc: { version: 1, artists: { ar1: artist("ar1") }, items: {}, dismissed: [] }, docRoot: "/vol" });
  be.book = { version: 1, books: {}, stickers: [shelf], banners: {} };
  useScrapbook.setState({ lib: be.book as never });
});

function mountBanner() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Host() {
    const banner = usePeople((x) => x.doc?.people.pe1?.banner);
    return createElement(StickerBanner, { target: { kind: "person", id: "pe1" }, banner, tape: "People", photo: null, name: "Kaze", line: "3 photos" });
  }
  return { host, render: () => act(async () => root.render(createElement(Host))), unmount: () => act(async () => root.unmount()) };
}
const fire = (el: Element, type: string, at: { clientX: number; clientY: number }) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...at }));

describe("a person's banner", () => {
  it("takes stickers from the shelf, kept by where they are from its nearer side, and lets them go", async () => {
    const b = mountBanner();
    await b.render();
    await act(async () => (b.host.querySelector(".banner-stick") as HTMLButtonElement).click());
    // Clicked on the shelf: put on in the room beside the name, the banner theirs.
    await act(async () => (b.host.querySelector(".scrap-tile.sticker") as HTMLElement).click());
    const id = usePeople.getState().doc!.people.pe1.banner!;
    expect(banners()[id].stickers).toHaveLength(1);
    const s = banners()[id].stickers[0];
    expect(s).toMatchObject({ src: { blob: "sticker-s1.png" }, aspect: 2, outline: true, w: 50 });

    // Dragged near the right edge: from there it is measured, as is the banner's middle line.
    const edit = b.host.querySelector(".banner-edit")!;
    const from = { clientX: s.right ? 1000 - s.x : s.x, clientY: 90 + s.y };
    await act(async () => {
      fire(edit, "pointerdown", from);
      fire(edit, "pointermove", { clientX: from.clientX + (900 - from.clientX), clientY: from.clientY + (60 - from.clientY) });
      fire(edit, "pointerup", { clientX: 900, clientY: 60 });
    });
    expect(banners()[id].stickers[0]).toMatchObject({ x: 100, y: -30, right: true });

    // Dropped from the shelf: where it was let go.
    const drop = Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { clientX: 300, clientY: 120, dataTransfer: { types: [STICKER_DRAG], getData: () => JSON.stringify({ src: { builtin: "heart" }, aspect: 1, custom: false }) } });
    await act(async () => void edit.dispatchEvent(drop));
    expect(banners()[id].stickers[1]).toMatchObject({ src: { builtin: "heart" }, x: 300, y: 30, outline: false });
    expect(banners()[id].stickers[1].right).toBeUndefined();

    // ⌫ takes the picked one off; with none left the banner goes, and Esc is done.
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true })));
    expect(banners()[id].stickers).toHaveLength(1);
    await act(async () => void edit.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 900, clientY: 60 })));
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
    expect(banners()[id]).toBeUndefined();
    expect(usePeople.getState().doc!.people.pe1.banner).toBeUndefined();
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(b.host.querySelector(".banner-edit")).toBeNull();
    await settle();
    // Still on the shelf: its picture stays.
    expect(be.deleted).not.toContain("sticker-s1.png");
    await b.unmount();
  });

  it("lets a sticker's picture go once it is on no shelf, cover or banner", async () => {
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: [], banners: { bn1: { id: "bn1", stickers: [placed("a", "sticker-gone.png")], updated: 0 } } } });
    usePeople.setState({ doc: { ...usePeople.getState().doc!, people: { pe1: person("pe1", "bn1") } } });
    useScrapbook.getState().saveBanner({ kind: "person", id: "pe1" }, []);
    await settle();
    expect(be.deleted).toEqual(["sticker-gone.png"]);
  });

  it("goes with them when they are joined to someone without one", () => {
    usePeople.setState({ doc: { ...usePeople.getState().doc!, people: { pe1: person("pe1", "bn1"), pe2: person("pe2") } } });
    usePeople.getState().merge("pe1", "pe2");
    expect(usePeople.getState().doc!.people.pe2.banner).toBe("bn1");
    usePeople.setState({ doc: { ...usePeople.getState().doc!, people: { pe1: person("pe1", "bn1"), pe3: person("pe3", "bn3") } } });
    usePeople.getState().merge("pe1", "pe3");
    expect(usePeople.getState().doc!.people.pe3.banner).toBe("bn3");
  });
});

describe("a sticker fine-tuned again", () => {
  it("is the new picture on every banner it is on", async () => {
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: [shelf], banners: { bn1: { id: "bn1", stickers: [placed("a", "sticker-s1.png"), placed("b", "sticker-other.png")], updated: 0 } } } });
    await useScrapbook.getState().replaceSticker({ ...shelf, blob: "sticker-s1-new.png", w: 20, h: 10 });
    expect(banners().bn1.stickers.map((s) => s.src)).toEqual([{ blob: "sticker-s1-new.png" }, { blob: "sticker-other.png" }]);
    expect(banners().bn1.stickers[0].aspect).toBe(0.5);
  });
});

describe("an artist's banner", () => {
  it("goes with them when they are removed, unless the artist they were joined to took it", async () => {
    const lib = { version: 1 as const, books: {}, stickers: [], banners: { bn1: { id: "bn1", stickers: [placed("a", "sticker-a.png")], updated: 0 }, bn2: { id: "bn2", stickers: [placed("b", "sticker-b.png")], updated: 0 } } };
    useScrapbook.setState({ lib });
    be.book = lib;
    useArtists.setState({ doc: { version: 1, artists: { ar1: artist("ar1", "bn1"), ar2: artist("ar2"), ar3: artist("ar3", "bn2") }, items: {}, dismissed: [] } });
    useArtists.getState().merge("ar1", "ar2");
    expect(useArtists.getState().doc!.artists.ar2.banner).toBe("bn1");
    useArtists.getState().remove("ar3");
    await vi.waitFor(() => expect(banners().bn2).toBeUndefined());
    expect(banners().bn1).toBeDefined();
    expect(be.deleted).toEqual(["sticker-b.png"]);
  });
});
