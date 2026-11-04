import { afterAll, describe, expect, it, vi } from "vitest";

const saved: unknown[] = [];
vi.mock("../lib/api", () => ({
  api: new Proxy({ saveLibrary: async (_r: string, lib: unknown) => void saved.push(lib) } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useStore } = await import("../store");
const { useOnline } = await import("../lib/online");
const { useSounds } = await import("../lib/sounds");
const { useUpdates } = await import("../lib/updates");
const { adoptSettings } = await import("../lib/librarySettings");
const { flushAll } = await import("../lib/pending");

afterAll(() => vi.dynamicImportSettled());

const library = (settings?: object) => ({ version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, ids: {}, ...(settings ? { settings } : {}) }) as never;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("settings kept with the library", () => {
  it("a library without them is given this computer's, once", async () => {
    useStore.getState().setTheme("gallery");
    useStore.getState().setPageTurns(false);
    useOnline.getState().set({ ask: true, each: false, keep: false });
    useStore.setState({ root: "/vol", library: library() } as never);
    saved.length = 0;
    adoptSettings();
    await flushAll();
    const kept = useStore.getState().library!.settings!;
    expect(kept).toMatchObject({ theme: "gallery", pageTurns: false, online: { ask: true, each: false, keep: false }, fit: "fit", updates: { auto: false } });
    expect(kept.connected).toBeUndefined();
    expect(saved).toHaveLength(1);
    // Opened again: nothing to give, nothing written.
    adoptSettings();
    await flushAll();
    expect(saved).toHaveLength(1);
  });

  it("a library with them sets the app to them, without writing them back", async () => {
    const settings = {
      theme: "manga",
      mode: "light",
      sounds: { menus: true, sorting: false, volume: 0.5 },
      slideshow: { interval: 9, hideUi: false },
      pageTurns: true,
      seriesTogether: false,
      boardPictures: "link",
      boardFix: { kind: "tape", where: "all" },
      fit: "fill",
      online: { ask: true, each: true, keep: true },
      connected: { all: false, platforms: ["site-a"] },
      updates: { auto: false },
    };
    useStore.setState({ root: "/other", library: library(settings) } as never);
    saved.length = 0;
    adoptSettings();
    await flushAll();
    await settle();
    const s = useStore.getState();
    expect([s.theme, s.themeMode, s.pageTurns, s.seriesTogether, s.boardPictures, s.boardFix, s.fitMode, s.slideshow.interval, s.slideshow.hideUi]).toEqual(["manga", "light", true, false, "link", { kind: "tape", where: "all" }, "fill", 9, false]);
    expect(useSounds.getState()).toMatchObject({ menus: true, volume: 0.5 });
    expect(useOnline.getState().settings).toEqual({ ask: true, each: true, keep: true });
    expect(useOnline.getState().connected).toEqual({ all: false, platforms: ["site-a"] });
    expect(s.library!.settings).toEqual(settings);
    expect(saved).toHaveLength(0);
  });

  it("a setting changed goes into the open library", async () => {
    saved.length = 0;
    useStore.getState().setSeriesTogether(true);
    useSounds.getState().set({ volume: 0.2 });
    useOnline.getState().connect("site-b");
    useOnline.getState().set({ ask: false });
    await settle();
    await flushAll();
    const kept = useStore.getState().library!.settings!;
    expect(kept.seriesTogether).toBe(true);
    expect(kept.sounds?.volume).toBe(0.2);
    expect(kept.online?.ask).toBe(false);
    expect(kept.connected?.platforms).toEqual(["site-a", "site-b"]);
    expect(saved.length).toBeGreaterThan(0);
  });

  it("looks for updates when the first library that asks for it opens", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => {});
    useUpdates.setState({ check });
    useStore.setState({ library: library({ updates: { auto: true } }) } as never);
    adoptSettings();
    vi.advanceTimersByTime(6000);
    adoptSettings();
    vi.advanceTimersByTime(6000);
    vi.useRealTimers();
    expect(check).toHaveBeenCalledTimes(1);
  });
});
