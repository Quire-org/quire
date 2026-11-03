import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const be = vi.hoisted(() => ({ book: null as unknown, tags: null as unknown }));
vi.mock("../lib/api", () => ({
  api: {
    scrapbookLoad: vi.fn(async () => be.book),
    scrapbookSave: vi.fn(async () => {}),
    scrapbookBlob: vi.fn(async () => new ArrayBuffer(4)),
    loadTags: vi.fn(async () => be.tags),
    saveTags: vi.fn(async () => {}),
    tagsIndexLoad: vi.fn(async () => ({ auto: {}, indexed: {} })),
    loadAlbums: vi.fn(async () => []),
    scanAll: vi.fn(async () => []),
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
URL.createObjectURL = () => "blob:x";
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { useStore } = await import("../store");
const { useTags } = await import("../tagsStore");
const { useScrapbook } = await import("../scrapbook/store");
const { bookPages, nextTurn, PER_PAGE, StickerBook } = await import("../components/StickerBook");
const { Scrapbook } = await import("../screens/Scrapbook");

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

// Stickers made in three months: 14 in March, 3 in February, 30 in January.
const at = (month: number, day: number) => new Date(2026, month, day).getTime();
const made = (n: number, month: number, pre: string) => Array.from({ length: n }, (_, i) => ({ id: `${pre}${i}`, blob: `sticker-${pre}${i}.png`, w: 10, h: 10, made: at(month, 1 + (i % 27)) }));
const many = [...made(30, 0, "jan"), ...made(3, 1, "feb"), ...made(14, 2, "mar")];

function mountBook(theme = "cozy") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.removeItem("quire.stickerBookSize");
  useStore.setState({ theme });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}

describe("the sticker book", () => {
  it("has a title page, then your stickers by month, newest first, each month on pages of its own", () => {
    const pages = bookPages(many);
    expect(pages[0].cover).toBe(true);
    expect(pages[1]).toMatchObject({ section: "2026-03", title: "March 2026" });
    expect(pages[1].entries).toHaveLength(PER_PAGE);
    expect(pages[2]).toMatchObject({ section: "2026-03", title: undefined });
    expect(pages[2].entries).toHaveLength(2);
    expect(pages[3]).toMatchObject({ section: "2026-02", title: "February 2026" }); // a month starts on a page of its own
    expect(pages.slice(4).filter((p) => p.title)).toHaveLength(1);
    expect(pages.length % 2).toBe(0);
    // Only your own stickers: no built-in ones.
    expect(pages.flatMap((p) => p.entries)).toHaveLength(many.length);
    expect(pages.flatMap((p) => p.entries).every((e) => e.kind === "mine")).toBe(true);
    // Without stickers of your own, a page says how to make one.
    expect(bookPages([])[1]).toMatchObject({ section: "empty", entries: [] });
  });

  it("turns faster the more pages are asked for, and a far jump riffles only the last few", () => {
    expect(nextTurn(3, 3)).toBeNull();
    expect(nextTurn(0, 1)).toEqual({ skipTo: 0, dir: 1, ms: 650 });
    expect(nextTurn(0, 3)!.ms).toBeLessThan(650);
    expect(nextTurn(0, 10)).toMatchObject({ skipTo: 7, dir: 1 });
    expect(nextTurn(10, 0)).toMatchObject({ skipTo: 3, dir: -1 });
  });

  it("turns a page with a leaf, and jumps by a ribbon", async () => {
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: many, banners: {} } });
    const { root } = mountBook();
    await act(async () => root.render(createElement(StickerBook, { onMake: () => {} })));
    expect(document.body.textContent).toContain("Sticker book");
    const scrub = () => document.body.querySelector(".book-scrub")!.textContent;
    expect(scrub()).toMatch(/^1 \//);
    await act(async () => (document.body.querySelector(".book-corner.right") as HTMLButtonElement).click());
    expect(document.body.querySelector(".book-leaf.forward")).toBeTruthy();
    await wait(700);
    expect(document.body.querySelector(".book-leaf")).toBeNull();
    expect(scrub()).toMatch(/^2 \//);
    // The last month's ribbon: there, page by page.
    const ribbons = document.body.querySelectorAll(".book-ribbon");
    expect(Array.from(ribbons).map((r) => r.textContent)).toEqual(["March 2026", "February 2026", "January 2026"]);
    await act(async () => (ribbons[ribbons.length - 1] as HTMLButtonElement).click());
    for (let i = 0; i < 12 && document.body.querySelector(".book-leaf"); i++) await wait(200);
    await wait(250);
    expect(document.body.querySelector(".book-leaf")).toBeNull();
    expect(document.body.querySelector(".book-ribbon.active")?.textContent).toBe("January 2026");
    // A sticker's story closes when the page turns.
    await act(async () => (document.body.querySelector(".book-spread > .book-page.left .book-slot") as HTMLButtonElement).click());
    expect(document.body.querySelector(".sticker-info.on-right")).toBeTruthy();
    await act(async () => (document.body.querySelector(".book-corner.left") as HTMLButtonElement).click());
    expect(document.body.querySelector(".sticker-info")).toBeNull();
    root.unmount();
  });

  it("shows stickers already seen at once, with no empty frame first (a page put down after a turn)", async () => {
    useStore.setState({ root: "/vol" } as never);
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: many, banners: {} } });
    const first = mountBook();
    await act(async () => first.root.render(createElement(StickerBook, { onMake: () => {} })));
    await wait(10);
    expect(document.body.querySelectorAll(".book-slot img")).toHaveLength(12);
    first.root.unmount();
    const again = mountBook();
    act(() => again.root.render(createElement(StickerBook, { onMake: () => {} })));
    expect(document.body.querySelectorAll(".book-slot img")).toHaveLength(12);
    again.root.unmount();
  });

  it("clicked again while a page turns, ends that turn at once and turns the next", async () => {
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: many, banners: {} } });
    const { root } = mountBook();
    await act(async () => root.render(createElement(StickerBook, { onMake: () => {} })));
    const next = () => act(async () => (document.body.querySelector(".book-corner.right") as HTMLButtonElement).click());
    const number = () => document.body.querySelector(".book-spread > .book-page.left .book-number")?.textContent;
    await next();
    await wait(100);
    await next();
    // The first turn is over: its page lies open under the second leaf.
    expect(document.body.querySelector(".book-scrub")!.textContent).toMatch(/^3 \//);
    expect(document.body.querySelector(".book-leaf.forward")).toBeTruthy();
    expect(number()).toBe("2");
    // One turn's time later, both are done (no waiting for the first to finish).
    await wait(700);
    expect(document.body.querySelector(".book-leaf")).toBeNull();
    expect(number()).toBe("4");
    root.unmount();
  });

  it("tells about a clicked sticker: its picture and tags, size, when it was made, the covers it is on", async () => {
    const pic = { key: "Pics/beach.jpg", name: "beach.jpg", dir: "Pics", path: "/vol/Pics/beach.jpg", primary: "/vol/Pics/beach.jpg", kind: "image", size: 1, mtime: 0, members: [] };
    const sticker = { id: "s1", blob: "sticker-s1.png", w: 320, h: 480, from: "beach.jpg", source: "Pics/beach.jpg", made: at(2, 14) };
    useStore.setState({
      root: "/vol",
      screen: "scrapbook",
      allItems: [pic],
      albums: [{ key: "Albums/Trip", name: "Trip", path: "/vol/Albums/Trip", count: 3, cover: null }],
      library: { version: 1, targets: [], trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {}, albumCovers: { "Albums/Trip": "b1" } },
    } as never);
    useTags.setState({ data: { version: 1, types: ["motives"], tags: { "Pics/beach.jpg": ["motives/sea"] }, autoMap: {}, albums: {} }, loaded: true } as never);
    const book = { id: "b1", kind: "album", background: { kind: "pattern", pattern: "dots", color: "#000", ink: "#fff" }, layers: [{ id: "l1", type: "sticker", src: { blob: "sticker-s1.png" }, x: 0, y: 0, w: 1, h: 1, rot: 0 }], updated: 0 };
    useScrapbook.setState({ lib: { version: 1, books: { b1: book }, stickers: [sticker], banners: {} } as never });
    const { root } = mountBook();
    await act(async () => root.render(createElement(StickerBook, { onMake: () => {} })));
    await act(async () => (document.body.querySelector(".book-corner.right") as HTMLButtonElement).click());
    await wait(700);
    await act(async () => (document.body.querySelector(".book-slot") as HTMLButtonElement).click());
    const info = document.body.querySelector(".sticker-info")!;
    expect(info).toBeTruthy();
    // Its sticker is on the right page, so it lies over the left one: the book keeps its size.
    expect(info.classList.contains("on-left")).toBe(true);
    expect(document.body.querySelector(".sticker-book .sticker-info")).toBe(info);
    expect(info.textContent).toContain("320 × 480 px");
    expect(info.textContent).toContain("2026");
    expect(info.querySelector(".sticker-info-facts")!.textContent).toMatch(/In covers\s*1/);
    expect(info.textContent).toContain("Trip");
    expect(info.textContent).toContain("sea");
    expect(info.textContent).toContain("Pics/beach.jpg");
    // Into the picture it was cut from.
    await act(async () => (Array.from(info.querySelectorAll("button")).find((b) => b.textContent?.includes("Open the picture")) as HTMLButtonElement).click());
    expect(useStore.getState().screen).toBe("viewer");
    expect(useStore.getState().queue.map((i) => i.key)).toEqual(["Pics/beach.jpg"]);
    root.unmount();
  });
});

describe("the sticker book's size", () => {
  it("shows bigger or smaller stickers, fewer or more to a page, stays where it was, and keeps the size", async () => {
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: many, banners: {} } });
    const { host, root } = mountBook();
    await act(async () => root.render(createElement(StickerBook, { onMake: () => {} })));
    expect(document.body.querySelector(".book-size")!.textContent).toContain("12 a page");
    // The last spread: January's last page, from sticker 42.
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "End" })));
    for (let i = 0; i < 12 && document.body.querySelector(".book-leaf"); i++) await wait(200);
    await wait(250);
    const firstShown = () => document.body.querySelector(".book-spread > .book-page .book-label")?.textContent;
    expect(firstShown()).toMatch(/^No\. 42/);
    // Biggest: two across, three down; still at sticker 42.
    const input = document.body.querySelector(".book-size input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "4");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.querySelector(".book-size")!.textContent).toContain("6 a page");
    expect((document.body.querySelector(".sticker-book-wrap") as HTMLElement).style.getPropertyValue("--cols")).toBe("2");
    const shown = Array.from(document.body.querySelectorAll(".book-spread > .book-page .book-label")).map((l) => l.textContent);
    expect(shown.some((l) => /^No\. 42 /.test(l ?? ""))).toBe(true);
    expect(document.body.querySelector(".book-scrub")!.textContent).toMatch(/^5 \//);
    expect(localStorage.getItem("quire.stickerBookSize")).toBe("4");
    root.unmount();
    // Opened again: at that size.
    const again = createRoot(host);
    await act(async () => again.render(createElement(StickerBook, { onMake: () => {} })));
    expect(document.body.querySelector(".book-size")!.textContent).toContain("6 a page");
    again.unmount();
  });
});

describe("the sticker book in each theme", () => {
  it("is the theme's own book, with its own title", async () => {
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: many, banners: {} } });
    for (const [theme, title] of [["cozy", "Sticker book"], ["cp2077", "Sticker databank"], ["manga", "Stickers vol. 1"], ["gallery", "The collection"]]) {
      const { root } = mountBook(theme);
      await act(async () => root.render(createElement(StickerBook, { onMake: () => {} })));
      expect(document.body.querySelector(`.sticker-book-wrap.book-${theme}`)).toBeTruthy();
      expect(document.body.querySelector(".book-title-name")?.textContent).toBe(title);
      root.unmount();
    }
  });

  it("on Night City's holopad, swipes from screen to screen instead of turning a leaf", async () => {
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: many, banners: {} } });
    const { root } = mountBook("cp2077");
    await act(async () => root.render(createElement(StickerBook, { onMake: () => {} })));
    await act(async () => (document.body.querySelector(".book-corner.right") as HTMLButtonElement).click());
    expect(document.body.querySelector(".book-leaf")).toBeNull();
    expect(document.body.querySelector(".holo-screen.out.fwd")).toBeTruthy();
    expect(document.body.querySelector(".holo-screen.in.fwd .book-washi")?.textContent).toBe("February 2026");
    expect(document.body.querySelector(".holo-sweep.fwd")).toBeTruthy();
    await wait(700);
    expect(document.body.querySelectorAll(".holo-screen")).toHaveLength(1);
    expect(document.body.querySelector(".holo-screen.out, .holo-screen.in")).toBeNull();
    expect(document.body.querySelector(".book-scrub")!.textContent).toMatch(/^2 \//);
    root.unmount();
  });

  it("as a manga volume, reads right to left: the first page on the right, the next spread to the left", async () => {
    useScrapbook.setState({ lib: { version: 1, books: {}, stickers: many, banners: {} } });
    const { root } = mountBook("manga");
    await act(async () => root.render(createElement(StickerBook, { onMake: () => {} })));
    const side = (s: string) => document.body.querySelector(`.book-spread > .book-page.${s}`)!;
    expect(side("right").querySelector(".book-title")).toBeTruthy();
    expect(side("left").querySelector(".book-washi")?.textContent).toBe("March 2026");
    expect(document.body.querySelector<HTMLButtonElement>(".book-corner.right")!.disabled).toBe(true);
    // The left corner turns on: the leaf goes from the left half over to the right.
    await act(async () => (document.body.querySelector(".book-corner.left") as HTMLButtonElement).click());
    expect(document.body.querySelector(".book-leaf.back")).toBeTruthy();
    await wait(700);
    expect(document.body.querySelector(".book-scrub")!.textContent).toMatch(/^2 \//);
    expect(side("right").querySelector(".book-number")?.textContent).toBe("2");
    expect(side("left").querySelector(".book-number")?.textContent).toBe("3");
    // ← is on, → is back.
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })));
    await wait(700);
    expect(document.body.querySelector(".book-scrub")!.textContent).toMatch(/^1 \//);
    root.unmount();
  });
});

describe("the Scrapbook tab", () => {
  it("shows the covers made, and makes a new one for an album", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    be.book = { version: 1, books: { b1: { id: "b1", kind: "album", background: { kind: "pattern", pattern: "dots", color: "#000", ink: "#fff" }, layers: [], updated: 0, rendered: "cover-b1-1.jpg" }, b2: { id: "b2", kind: "tag", background: { kind: "pattern", pattern: "dots", color: "#000", ink: "#fff" }, layers: [], updated: 0, rendered: "cover-b2-1.jpg" } }, stickers: [] };
    be.tags = { version: 1, types: ["motives"], tags: { "Pics/a.jpg": ["motives/sea"] }, autoMap: {}, albums: {}, covers: { "motives/sea": "b2" } };
    useScrapbook.setState({ lib: null, editing: null });
    useStore.setState({
      root: "/vol",
      screen: "scrapbook",
      albums: [{ key: "Albums/Trip", name: "Trip", path: "/vol/Albums/Trip", count: 3, cover: null }, { key: "Albums/Sea", name: "Sea", path: "/vol/Albums/Sea", count: 2, cover: null }],
      library: { version: 1, targets: [], trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {}, albumCovers: { "Albums/Trip": "b1" } },
    } as never);
    useTags.setState({ data: null, loaded: false });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Scrapbook)));
    await wait(10);
    const cards = () => Array.from(document.body.querySelectorAll(".cover-card")).map((c) => c.textContent);
    expect(cards().some((t) => t?.includes("Trip"))).toBe(true);
    expect(cards().some((t) => t?.includes("sea"))).toBe(true);
    // The sticker book's page slider sits in the tab bar, not under the book.
    await act(async () => (Array.from(document.body.querySelectorAll(".page-tab")).find((b) => b.textContent?.includes("Stickers")) as HTMLButtonElement).click());
    expect(document.body.querySelector(".page-tabs .book-scrub")).toBeTruthy();
    expect(document.body.querySelector(".sticker-book-wrap .book-scrub")).toBeNull();
    await act(async () => (Array.from(document.body.querySelectorAll(".page-tab")).find((b) => b.textContent?.includes("Covers")) as HTMLButtonElement).click());
    // New cover: an album that has none.
    await act(async () => (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("New cover")) as HTMLButtonElement).click());
    const sea = Array.from(document.body.querySelectorAll(".new-cover-list button")).find((b) => b.textContent?.includes("Sea")) as HTMLButtonElement;
    await act(async () => sea.click());
    await wait(10);
    expect(useStore.getState().screen).toBe("cover");
    expect(useScrapbook.getState().editing?.target).toMatchObject({ kind: "album", key: "Albums/Sea" });
    root.unmount();
  });
});
