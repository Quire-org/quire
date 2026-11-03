import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../lib/types";

const be = vi.hoisted(() => ({ home: null as unknown, saved: [] as unknown[] }));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      homeLoad: async () => be.home,
      homeSave: async (_r: string, d: unknown) => void be.saved.push(d),
      vaultStatus: async () => null,
      loadLibrary: async () => ({ version: 1, targets: [{ id: "t1", name: "Family", path: "Family", hotkey: "1" }], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, ids: {} }),
      loadHistory: async () => null,
      scanUnsorted: async () => [pic("in/a.jpg"), pic("in/b.jpg")],
      scanAll: async () => [],
      saveLibrary: async () => {},
      facesLoad: async () => ({ faces: [], scanned: {} }),
      scanAlbums: async () => [],
      pluginList: async () => [],
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  fileSrc: (p: string) => p,
  mediaUrl: (i: { primary: string }) => `media:${i.primary}`,
  thumbUrl: (_r: string, i: { primary: string }) => `thumb:${i.primary}`,
  faceUrl: () => "face:",
  canThumb: () => true,
  rawPreviewUrl: async () => "",
  setCurrentRoot: () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, setFullscreen: async () => {}, isFullscreen: async () => false, listen: async () => () => {} }) }));
for (const name of ["ResizeObserver", "IntersectionObserver"])
  (globalThis as Record<string, unknown>)[name] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
HTMLCanvasElement.prototype.getContext = (() => null) as never;

function pic(key: string, modified = 0): MediaItem {
  return { key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: key.split("/").pop()!, dir: key.slice(0, key.lastIndexOf("/")), size: 1, modified, hasRaw: false, hasVideo: false };
}

const board = await import("../home/board");
const { useHome } = await import("../home/store");
const { useStore } = await import("../store");
const { Home, rowHeight } = await import("../screens/Home");
const { default: App } = await import("../App");

afterAll(() => vi.dynamicImportSettled());

const block = (id: string, x: number, y: number, w: number, h: number, type: import("../home/board").BlockType = "random") => ({ id, type, x, y, w, h });

describe("the Home's board", () => {
  it("makes room for a block moved onto others, and closes up behind one taken off", () => {
    const blocks = [block("a", 0, 0, 6, 4), block("b", 6, 0, 6, 4), block("c", 0, 4, 12, 3)];
    const moved = board.move(blocks, "c", 0, 0);
    expect(moved.find((b) => b.id === "c")).toMatchObject({ x: 0, y: 0 });
    expect(moved.find((b) => b.id === "a")).toMatchObject({ y: 3 });
    expect(moved.find((b) => b.id === "b")).toMatchObject({ y: 3 });
    expect(board.settle(blocks.filter((b) => b.id !== "a"))).toEqual([block("b", 6, 0, 6, 4), block("c", 0, 4, 12, 3)]);
  });

  it("keeps blocks on the board and no smaller than their kind allows", () => {
    const [b] = board.move([block("a", 0, 0, 6, 4)], "a", 20, -3);
    expect(b).toMatchObject({ x: 6, y: 0 });
    const [s] = board.resize([block("a", 0, 0, 6, 4, "sort")], "a", 1, 1);
    expect(s).toMatchObject({ w: board.KINDS.sort.minW, h: board.KINDS.sort.minH });
    const [wide] = board.resize([block("a", 4, 0, 6, 4)], "a", 40, 4);
    expect(wide).toMatchObject({ x: 0, w: 12 });
  });

  it("puts a new block in the first gap it fits, at the foot when none, or where it is dropped", () => {
    const blocks = [block("a", 0, 0, 6, 4), block("b", 9, 0, 3, 4)];
    const into = board.add(blocks, "import");
    expect(into.blocks.find((b) => b.id === into.id)).toMatchObject({ x: 6, y: 0, w: 3, h: 2 });
    const full = [block("a", 0, 0, 12, 4)];
    const foot = board.add(full, "random");
    expect(foot.blocks.find((b) => b.id === foot.id)).toMatchObject({ x: 0, y: 4 });
    const dropped = board.add(blocks, "who", { x: 0, y: 0 });
    expect(dropped.blocks.find((b) => b.id === dropped.id)).toMatchObject({ x: 0, y: 0 });
    expect(dropped.blocks.find((b) => b.id === "a")!.y).toBeGreaterThanOrEqual(3);
  });

  it("comes in presets whose blocks never overlap, Everything having every kind once", () => {
    for (const p of board.PRESETS) {
      const blocks = board.presetBlocks(p.id);
      for (const a of blocks) for (const b of blocks) if (a !== b) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${p.id}: ${a.type} and ${b.type}`).toBe(false);
      for (const b of blocks) expect(b.x + b.w, `${p.id}: ${b.type}`).toBeLessThanOrEqual(board.COLS);
    }
    expect(new Set(board.presetBlocks("everything").map((b) => b.type))).toEqual(new Set(Object.keys(board.KINDS)));
  });

  it("follows its blocks in reading order, and halves them in a narrow window", () => {
    const blocks = [block("b", 6, 0, 6, 4), block("a", 0, 0, 6, 4), block("c", 0, 4, 12, 2)];
    expect(board.readingOrder(blocks).map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(board.narrow(blocks).map((b) => [b.id, b.x, b.w])).toEqual([
      ["b", 3, 3],
      ["a", 0, 3],
      ["c", 0, 6],
    ]);
  });

  it("shows pictures from all folders, all but some, or only some", () => {
    expect(board.shownOnHome("Private/a.jpg", { mode: "all", list: ["Private"] })).toBe(true);
    expect(board.shownOnHome("Private/x/a.jpg", { mode: "hide", list: ["Private"] })).toBe(false);
    expect(board.shownOnHome("Privately/a.jpg", { mode: "hide", list: ["Private"] })).toBe(true);
    expect(board.shownOnHome("Trips/a.jpg", { mode: "only", list: ["Trips"] })).toBe(true);
    expect(board.shownOnHome("Home/a.jpg", { mode: "only", list: ["Trips"] })).toBe(false);
  });

  it("keeps its folders, filters and pinned pictures with them when they move", () => {
    const doc = { ...board.emptyDoc(), folders: { mode: "hide" as const, list: ["Private"] }, blocks: [{ ...block("a", 0, 0, 3, 3, "picture"), pinned: "Private/a.jpg", filter: { folders: ["Private/x"], album: "Private/book" } }] };
    const moved = board.followMoves(doc, [["Private", "Hidden"]]);
    expect(moved.folders.list).toEqual(["Hidden"]);
    expect(moved.blocks[0]).toMatchObject({ pinned: "Hidden/a.jpg", filter: { folders: ["Hidden/x"], album: "Hidden/book" } });
  });

  it("turns a block's one source (from before filters) into its filter, and forgets hide-when-empty", () => {
    const old = { ...board.emptyDoc(), blocks: [{ ...block("a", 0, 0, 4, 4, "source"), source: { kind: "person", id: "pe1" } }, { ...block("b", 4, 0, 4, 4, "favourites"), minRating: 9, hideEmpty: true }, { ...block("c", 8, 0, 4, 4, "source"), source: { kind: "album", id: "Manga/v1" } }] } as never;
    const blocks = board.upgrade(old).blocks;
    expect(blocks.map((b) => b.filter)).toEqual([{ people: ["pe1"] }, { minRating: 9 }, { album: "Manga/v1" }]);
    expect(blocks.some((b) => "hideEmpty" in b)).toBe(false);
  });

  it("lays pictures out as a mosaic: rows filling the box edge to edge, each picture its own shape, trimmed a little at most", () => {
    const list = Array.from({ length: 30 }, (_, i) => ({ key: `p${i}`, a: [1.5, 0.75, 1, 1.33, 0.66][i % 5] }));
    const tiles = board.justify(list, 600, 400)!;
    expect(tiles.length).toBeGreaterThan(3);
    const rows = [...new Set(tiles.map((t) => Math.round(t.y)))];
    for (const y of rows) {
      const row = tiles.filter((t) => Math.round(t.y) === y);
      const right = Math.max(...row.map((t) => t.x + t.w));
      expect(right).toBeCloseTo(600, 0);
      // Each keeps its shape, up to the trim.
      for (const t of row) expect(Math.abs(t.w / t.h / list.find((p) => p.key === t.key)!.a - 1)).toBeLessThanOrEqual(0.15 + 1e-9);
    }
    const bottom = Math.max(...tiles.map((t) => t.y + t.h));
    expect(bottom).toBeCloseTo(400, 0);
    // Too small a box, or nothing to show: a grid does better.
    expect(board.justify(list, 50, 400)).toBeNull();
    expect(board.justify([], 600, 400)).toBeNull();
    expect(board.canMosaic({ ...block("a", 0, 0, 4, 3), type: "random" })).toBe(true);
    expect(board.canMosaic({ ...block("a", 0, 0, 3, 3), type: "random" })).toBe(false);
    expect(board.canMosaic({ ...block("a", 0, 0, 6, 6), type: "activity" })).toBe(false);
  });

  it("keeps its stickers' random filters with the folders and albums they name when they move", () => {
    const doc = { ...board.emptyDoc(), stickers: [{ id: "s", random: { categories: [board.MINE], filter: { folders: ["Trips/a"], album: "Trips/book" } }, aspect: 1, look: "original", outline: false, x: 0.5, y: 1, w: 0.1, rot: 0 }] };
    expect(board.followMoves(doc, [["Trips", "Away"]]).stickers![0].random!.filter).toEqual({ folders: ["Away/a"], album: "Away/book" });
  });

  it("finds this day in other years, newest year first, and picks the same handful for the same seed", () => {
    const now = new Date(2026, 10, 1, 12);
    const items = [pic("a", new Date(2024, 10, 1).getTime()), pic("b", new Date(2022, 10, 1, 9).getTime()), pic("c", new Date(2024, 10, 2).getTime()), pic("d", new Date(2026, 10, 1).getTime())];
    expect(board.onThisDay(items, now).map((y) => [y.year, y.items.map((i) => i.key)])).toEqual([
      [2024, ["a"]],
      [2022, ["b"]],
    ]);
    expect(board.onThisDay(items, now, 3).map((y) => [y.year, y.items.map((i) => i.key)])).toEqual([
      [2024, ["a", "c"]],
      [2022, ["b"]],
    ]);
    expect(board.nearestDay(items, now)).toBe(0);
    expect(board.nearestDay([pic("e", new Date(2023, 6, 1).getTime())], now)).toBe(123);
    expect(board.nearestDay([pic("f", new Date(2026, 6, 1).getTime())], now)).toBeNull();
    const many = Array.from({ length: 50 }, (_, i) => i);
    expect(board.pick(many, 5, 42)).toEqual(board.pick(many, 5, 42));
    expect(board.pick(many, 5, 42)).not.toEqual(board.pick(many, 5, 43));
    expect(new Set(board.pick(many, 50, 1)).size).toBe(50);
  });
});

describe("opening a library", () => {
  beforeEach(() => {
    be.home = null;
    be.saved = [];
    useStore.setState({ root: null, screen: "welcome" } as never);
    useHome.setState({ doc: null, docRoot: null, fresh: false, arranging: false, history: [] });
  });

  it("lands on its Home, which offers the presets the first time, and no Settings popping up", async () => {
    await useStore.getState().openRoot("/vol");
    expect(useStore.getState().screen).toBe("home");
    expect(useStore.getState().settingsOpen).toBe(false);
    expect(useHome.getState()).toMatchObject({ docRoot: "/vol", fresh: true });
  });

  it("lands in Sort, or on the screen it was left on, when its Home says so", async () => {
    be.home = { version: 1, blocks: [], folders: { mode: "all", list: [] }, opensOn: "sort" };
    await useStore.getState().openRoot("/vol");
    expect(useStore.getState().screen).toBe("viewer");
    useStore.setState({ root: null });
    be.home = { version: 1, blocks: [], folders: { mode: "all", list: [] }, opensOn: "last", last: { screen: "albums", at: 1 } };
    await useStore.getState().openRoot("/vol");
    expect(useStore.getState().screen).toBe("albums");
  });

  it("remembers the list screen gone to, for Where you were", async () => {
    be.home = { version: 1, blocks: [], folders: { mode: "all", list: [] }, opensOn: "home" };
    await useStore.getState().openRoot("/vol");
    useStore.getState().openPeople();
    expect(useHome.getState().doc?.last?.screen).toBe("people");
  });
});

describe("the Home on screen", () => {
  beforeEach(async () => {
    be.home = null;
    useStore.setState({ root: null, screen: "welcome" } as never);
    useHome.setState({ doc: null, docRoot: null, fresh: false, arranging: false, history: [] });
    await useStore.getState().openRoot("/vol");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  const mount = async (el = createElement(Home)) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(el));
    return { host, unmount: () => root.unmount() };
  };
  const button = (host: HTMLElement, text: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
  const press = async (key: string, more: KeyboardEventInit = {}) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...more })));

  it("starts from a preset; Arrange adds a block from its menu and opens its panel, ⌘Z takes it back, Esc closes the panel then ends Arrange", async () => {
    const { host, unmount } = await mount();
    expect(host.querySelectorAll(".home-preset")).toHaveLength(board.PRESETS.length);
    await act(async () => button(host, "Sorting desk").click());
    const n = board.PRESETS.find((p) => p.id === "sorting")!.blocks.length;
    expect(host.querySelectorAll(".home-block")).toHaveLength(n);
    expect(host.querySelector(".kind-sort .home-block-title")?.textContent).toBe("Waiting to sort");
    await act(async () => (host.querySelector(".home-arrange-btn") as HTMLButtonElement).click());
    // No side panel while arranging: the board keeps its place, the controls are in the top bar.
    expect(host.querySelector(".home-panel")).toBeNull();
    expect(host.querySelector(".topnav .home-arrange")).not.toBeNull();
    await act(async () => button(host, "Add").click());
    const kind = (name: string) => Array.from(document.querySelectorAll(".home-menu .home-kind")).find((b) => b.textContent?.includes(name))!;
    await act(async () => (kind("Shortcuts").querySelector(".home-kind-main") as HTMLButtonElement).click());
    expect(host.querySelectorAll(".home-block")).toHaveLength(n + 1);
    expect(host.querySelector(".home-panel .home-picked-title")?.textContent).toBe("Shortcuts");
    // A kind on the board already: clicked, that block is picked (its panel up), not a copy added.
    await act(async () => button(host, "Add").click());
    expect(kind("Who is this?").textContent).toContain("On the board");
    await act(async () => (kind("Who is this?").querySelector(".home-kind-main") as HTMLButtonElement).click());
    expect(host.querySelectorAll(".home-block")).toHaveLength(n + 1);
    expect(host.querySelector(".home-panel .home-picked-title")?.textContent).toBe("Who is this?");
    await press("z", { metaKey: true });
    expect(host.querySelectorAll(".home-block")).toHaveLength(n);
    await press("Escape");
    expect(host.querySelector(".home-panel")).toBeNull();
    expect(useHome.getState().arranging).toBe(true);
    await press("Escape");
    expect(useHome.getState().arranging).toBe(false);
    unmount();
  });

  it("shows a picture block what Browse's filters let through, set in its panel", async () => {
    const tagged = { ...pic("Trips/sea.jpg", 5), targetId: "t1" };
    useStore.setState({ allItems: [tagged, pic("Trips/hill.jpg", 4), { ...pic("Manga/v1/001.jpg", 3), albumKey: "Manga/v1" }] } as never);
    useStore.setState({ library: { ...useStore.getState().library!, ratings: { "Trips/sea.jpg": 9 } } });
    const id = useHome.getState().addBlock("source")!;
    const { host, unmount } = await mount();
    const pics = () => Array.from(host.querySelectorAll(`[data-block="${id}"] .home-pic`)).map((b) => b.getAttribute("title"));
    // No filter yet: it asks for one.
    expect(host.querySelector(`[data-block="${id}"]`)?.textContent).toContain("Pick its pictures");
    await act(async () => useHome.getState().updateBlock(id, { filter: { minRating: 9 } }));
    expect(pics()).toEqual(["sea.jpg"]);
    await act(async () => useHome.getState().updateBlock(id, { filter: { location: "t1" } }));
    expect(pics()).toEqual(["sea.jpg"]);
    // One album: its pages, which pictures otherwise leave out.
    await act(async () => useHome.getState().updateBlock(id, { filter: { album: "Manga/v1" } }));
    expect(pics()).toEqual(["001.jpg"]);
    await act(async () => useHome.getState().setArranging(true));
    await act(async () => useHome.getState().pick(id));
    expect(Array.from(host.querySelectorAll(".home-panel .home-field .label")).map((l) => l.textContent)).toEqual(expect.arrayContaining(["Album", "Where", "Folders", "Tags", "Rating", "Artists", "People"]));
    unmount();
  });

  it("with nowhere to sort to, has setting up the target folders as its one act-here, on ⏎ too", async () => {
    useStore.setState({ library: { ...useStore.getState().library!, targets: [] } });
    useHome.getState().start("sorting");
    const { host, unmount } = await mount();
    expect(button(host, "Set up target folders").className).toContain("primary");
    await press("Enter");
    expect(useStore.getState().settingsOpen).toBe(true);
    unmount();
  });

  it("acts on a block by its number: 1 sorts what waits", async () => {
    useHome.getState().start("sorting");
    const { unmount } = await mount();
    await press("1");
    expect(useStore.getState().screen).toBe("viewer");
    expect(useStore.getState().queue.map((q) => q.key)).toEqual(["in/a.jpg", "in/b.jpg"]);
    unmount();
  });

  it("is reached from any screen by the name in the top bar, or ⇧H", async () => {
    useStore.getState().openBrowse();
    const { host, unmount } = await mount(createElement(App));
    expect(useStore.getState().screen).toBe("browse");
    await act(async () => (host.querySelector(".brand-home") as HTMLButtonElement).click());
    expect(useStore.getState().screen).toBe("home");
    useStore.getState().openAlbums();
    await press("H", { shiftKey: true });
    expect(useStore.getState().screen).toBe("home");
    unmount();
  });

  it("Fit stretches the rows to fill the window once every block fits at the smallest row, and is kept with the board", async () => {
    // A board 10 rows deep in a window 900 tall: the rows share the height. 40 rows deep: the smallest row, and the board scrolls.
    expect(rowHeight(false, 10, 900)).toBe(64);
    expect(rowHeight(true, 10, 900)).toBe(Math.floor((900 - 24 - 9 * 10) / 10));
    expect(rowHeight(true, 40, 900)).toBe(48);
    expect(rowHeight(true, 0, 900)).toBe(64);
    const { host, unmount } = await mount();
    await act(async () => button(host, "Sorting desk").click());
    expect(host.querySelector(".home-board.fit")).toBeNull();
    // The toggle is among Arrange's controls; the board fits while arranging too.
    expect(host.querySelector(".home-fit-btn")).toBeNull();
    await act(async () => (host.querySelector(".home-arrange-btn") as HTMLButtonElement).click());
    await act(async () => (host.querySelector(".home-fit-btn") as HTMLButtonElement).click());
    expect(useHome.getState().doc?.fit).toBe(true);
    expect(host.querySelector(".home-board.fit")).not.toBeNull();
    expect(host.querySelector(".home-fit-btn")?.getAttribute("aria-pressed")).toBe("true");
    await press("Escape");
    expect(host.querySelector(".home-board.fit")).not.toBeNull();
    await act(async () => (host.querySelector(".home-arrange-btn") as HTMLButtonElement).click());
    await act(async () => (host.querySelector(".home-fit-btn") as HTMLButtonElement).click());
    expect(useHome.getState().doc?.fit).toBeUndefined();
    unmount();
  });

  it("while arranging, a random sticker stands in as an outline with a question mark; Arrange no longer swaps presets or sets what opens", async () => {
    // The board has a width (jsdom lays nothing out), or its stickers aren't drawn.
    const widthOf = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1200 });
    const { host, unmount } = await mount();
    await act(async () => button(host, "Gallery").click());
    await act(async () => (host.querySelector(".home-arrange-btn") as HTMLButtonElement).click());
    expect(button(host, "Start from")).toBeUndefined();
    expect(host.querySelector(".home-arrange")?.textContent).not.toContain("Opens on");
    await act(async () => button(host, "Stickers").click());
    await act(async () => (Array.from(document.querySelectorAll(".home-menu button")).find((b) => b.textContent?.includes("A random sticker")) as HTMLButtonElement).click());
    expect(useHome.getState().doc?.stickers).toHaveLength(1);
    expect(host.querySelector(".home-sticker .home-random")).not.toBeNull();
    expect(host.querySelector(".home-sticker .home-random-mark")?.textContent).toBe("?");
    // One of its picks' shapes once loaded; the generic outlines take turns until then.
    expect(host.querySelector(".home-sticker .home-random-cut, .home-sticker .home-random-shape")).not.toBeNull();
    await press("Escape");
    await press("Escape");
    expect(useHome.getState().arranging).toBe(false);
    expect(host.querySelector(".home-random")).toBeNull();
    unmount();
    if (widthOf) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthOf);
  });

  it("what the library opens on is set in Settings, under Look and reading, and kept with the Home", async () => {
    const { Settings } = await import("../screens/Settings");
    const { host, unmount } = await mount(createElement(Settings));
    await act(async () => button(host, "Look and reading").click());
    const row = Array.from(host.querySelectorAll(".optrow")).find((r) => r.textContent?.includes("The library opens on"))!;
    expect(row).toBeTruthy();
    await act(async () => useHome.getState().setOpensOn("sort"));
    expect(useHome.getState().doc?.opensOn).toBe("sort");
    expect(row.querySelector("select, .select, button")).not.toBeNull();
    unmount();
  });
});

describe("Home blocks for Find", () => {
  beforeEach(async () => {
    be.home = null;
    useStore.setState({ root: null, screen: "welcome" } as never);
    useHome.setState({ doc: null, docRoot: null, fresh: false, arranging: false, history: [] });
    await useStore.getState().openRoot("/vol");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  const saved = (id: string, pluginId: string, openedAt: number, fresh = 0) => ({ id, pluginId, platform: pluginId, site: null, name: `search ${id}`, view: { section: "search", query: id, option: "", author: null, tag: null }, mark: null, openedAt, fresh, more: false, checkedAt: null });

  it("Jump in starts with the two latest saved searches of each platform, and runs one on its own platform", async () => {
    const { defaultSearches, runSaved } = await import("../home/blocks");
    const list = [saved("a", "p1", 1), saved("b", "p1", 3), saved("c", "p1", 2), saved("d", "p2", 1)];
    expect(defaultSearches(list)).toEqual(["b", "c", "d"]);
    const { useFind } = await import("../findStore");
    const choose = vi.spyOn(useFind.getState(), "choose").mockImplementation(() => {});
    const openSaved = vi.spyOn(useFind.getState(), "openSaved").mockImplementation(async () => {});
    runSaved(list[3]);
    expect(choose).toHaveBeenCalledWith("p2");
    expect(openSaved).toHaveBeenCalledWith("d");
    expect(choose.mock.invocationCallOrder[0]).toBeLessThan(openSaved.mock.invocationCallOrder[0]);
    expect(useStore.getState().screen).toBe("find");
    choose.mockRestore();
    openSaved.mockRestore();
  });

  it("shows a block without its name when said so, and takes one off by its × while arranging", async () => {
    useHome.getState().start("collector");
    const id = useHome.getState().doc!.blocks.find((b) => b.type === "basket")!.id;
    useHome.getState().updateBlock(id, { bare: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Home)));
    expect(host.querySelector(`[data-block="${id}"] .home-block-head`)).toBeNull();
    expect(host.querySelector(".home-del")).toBeNull();
    await act(async () => useHome.getState().setArranging(true));
    await act(async () => (host.querySelector(`[data-block="${id}"] .home-del`) as HTMLButtonElement).click());
    expect(host.querySelector(`[data-block="${id}"]`)).toBeNull();
    await act(async () => useHome.getState().undo());
    expect(host.querySelector(`[data-block="${id}"]`)).not.toBeNull();
    root.unmount();
  });
});

describe("the Theme block", () => {
  it("shows every look in its own colours, and picking one sets it; its key goes to the next", async () => {
    const { themes } = await import("../themes");
    const { actionOf } = await import("../home/blocks");
    useHome.getState().start("gallery");
    const id = useHome.getState().addBlock("theme")!;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Home)));
    const swatches = host.querySelectorAll(`[data-block="${id}"] .theme-swatch`);
    expect(swatches.length).toBe(themes.length);
    // Each swatch is drawn under its own theme's tokens, whatever theme is on.
    expect(Array.from(swatches, (el) => el.getAttribute("data-theme"))).toEqual(themes.map((t) => t.id));
    await act(async () => (host.querySelector(`[data-block="${id}"] .theme-swatch[data-theme="ghost"]`) as HTMLButtonElement).click());
    expect(useStore.getState().theme).toBe("ghost");
    expect(host.querySelector(`[data-block="${id}"] .theme-swatch.on`)?.getAttribute("data-theme")).toBe("ghost");
    await act(async () => actionOf(useHome.getState().doc!.blocks.find((b) => b.id === id)!)!());
    expect(useStore.getState().theme).toBe("cozy");
    // Light or dark is picked under the swatches, and the swatches are drawn in it.
    await act(async () => (host.querySelector(`[data-block="${id}"] .mode-row button[title^="Light"]`) as HTMLButtonElement).click());
    expect(useStore.getState().themeMode).toBe("light");
    expect(document.documentElement.dataset.mode).toBe("light");
    expect(host.querySelector(`[data-block="${id}"] .theme-swatch`)?.getAttribute("data-mode")).toBe("light");
    await act(async () => useStore.getState().setThemeMode("system"));
    await act(async () => useStore.getState().setTheme(themes[0].id));
    root.unmount();
  });
});

describe("stickers on the Home", () => {
  beforeEach(async () => {
    be.home = null;
    useStore.setState({ root: null, screen: "welcome" } as never);
    useHome.setState({ doc: null, docRoot: null, fresh: false, arranging: false, history: [] });
    await useStore.getState().openRoot("/vol");
  });

  it("go on anywhere, are set up in a panel, go to the front or back, and come off; ⌘Z brings one back", async () => {
    const { newSticker } = await import("../home/stickers");
    useHome.getState().start("gallery");
    useHome.getState().setArranging(true);
    const a = newSticker({ x: 0.2, y: 1 }, { src: { builtin: "red-heart" }, aspect: 1, custom: false });
    useHome.getState().addSticker(a);
    expect(useHome.getState().picked).toBe(a.id);
    const b = newSticker({ x: 0.7, y: 3 });
    useHome.getState().addSticker(b);
    expect(useHome.getState().doc!.stickers!.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(b.random).toEqual({});
    useHome.getState().restack(a.id, true);
    expect(useHome.getState().doc!.stickers!.map((s) => s.id)).toEqual([b.id, a.id]);
    useHome.getState().updateSticker(b.id, { random: { categories: ["animals"] }, rot: 12 });
    expect(useHome.getState().doc!.stickers!.find((s) => s.id === b.id)).toMatchObject({ random: { categories: ["animals"] }, rot: 12 });
    useHome.getState().removeSticker(a.id);
    expect(useHome.getState().doc!.stickers!.map((s) => s.id)).toEqual([b.id]);
    useHome.getState().undo();
    expect(useHome.getState().doc!.stickers!).toHaveLength(2);
  });
});
