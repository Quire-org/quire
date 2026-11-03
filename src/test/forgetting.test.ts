import { afterAll, describe, expect, it, vi } from "vitest";

const be = vi.hoisted(() => ({ forgotten: [] as string[][], views: {} as Record<string, unknown> }));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      loadTags: async () => ({ tags: { "Old/1.jpg": ["sky"], "album:Old": ["trip"], "Keep/2.jpg": ["sea"] }, auto: { "Old/1.jpg": [[1, 0.9]] }, indexed: { "Old/1.jpg": { s: 1, m: 1 }, "Keep/2.jpg": { s: 1, m: 1 } } }),
      tagsIndexLoad: async () => null,
      tagsIndexForget: async (_r: string, keys: string[]) => void be.forgotten.push(keys),
      artistsLoad: async () => ({ artists: { ar: { id: "ar", name: "Kaze" } }, items: { "Old/1.jpg": ["ar"], "album:Old": ["ar"], "Keep/2.jpg": ["ar"] }, notTheirs: ["ar|Old/3.jpg"] }),
      homeLoad: async () => ({ version: 1, blocks: [{ id: "b", type: "random", x: 0, y: 0, w: 6, h: 4, filter: { album: "Old", folders: ["Old", "Keep"] }, pinned: "Old/1.jpg" }], folders: { mode: "all", list: ["Old"] }, opensOn: "home" }),
      loadCache: async () => ({ version: 1, sigs: { "Old/1.jpg": {}, "Keep/2.jpg": {} }, ignored: [{ keys: ["Old/1.jpg", "Keep/2.jpg", "Keep/3.jpg"], fps: ["a", "b", "c"] }] }),
      viewsLoad: async (root: string) => be.views[root] ?? null,
      viewsSave: async (root: string, v: unknown) => void (be.views[root] = v),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  rawPreviewUrl: async () => "",
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useStore, forgetGone } = await import("../store");
const { useTags } = await import("../tagsStore");
const { useArtists } = await import("../artistsStore");
const { useHome } = await import("../home/store");
const { useDupes } = await import("../dupesStore");
const { usePlugins } = await import("../plugins/store");
const { loadViews, setView, view } = await import("../lib/views");
const { flushAll } = await import("../lib/pending");

afterAll(() => vi.dynamicImportSettled());

describe("an album folder deleted for good", () => {
  it("is forgotten everywhere: the library file, tags and the tag index, artists, the Home and the duplicate check", async () => {
    useStore.setState({ root: "/vol", library: { version: 1, targets: [], trashDir: "_deleted", albumRoots: [], ids: {}, ratings: { "Old/1.jpg": 5, "Keep/2.jpg": 3 }, albumRatings: { Old: 4 }, albumLanguages: { Old: "ja" }, albumCovers: { Old: "c1" }, albumTranslations: { Old: "Other" }, albumNotVersions: ["Old|Other"], sources: { "Old/1.jpg": { platform: "x" } } }, viewed: { "Old/1.jpg": 1 } } as never);
    await useHome.getState().load(true, "/vol");
    await useTags.getState().load();
    await useArtists.getState().load();
    await useDupes.getState().loadCache();
    forgetGone({ keys: [], folders: ["Old"] });
    const lib = useStore.getState().library!;
    expect([lib.ratings, lib.albumRatings, lib.albumLanguages, lib.albumCovers, lib.albumTranslations, lib.albumNotVersions, lib.sources]).toEqual([{ "Keep/2.jpg": 3 }, {}, {}, {}, {}, [], {}]);
    expect(useStore.getState().viewed).toEqual({});
    await vi.waitFor(() => expect(Object.keys(useTags.getState().data!.tags)).toEqual(["Keep/2.jpg"]));
    expect(Object.keys(useTags.getState().data!.indexed)).toEqual(["Keep/2.jpg"]);
    expect(be.forgotten).toEqual([["Old/1.jpg"]]);
    await vi.waitFor(() => expect(Object.keys(useArtists.getState().doc!.items)).toEqual(["Keep/2.jpg"]));
    expect(useArtists.getState().doc!.notTheirs).toEqual([]);
    await vi.waitFor(() => expect(useHome.getState().doc!.blocks[0]).toMatchObject({ filter: { folders: ["Keep"] }, pinned: undefined }));
    expect(useHome.getState().doc!.blocks[0].filter!.album).toBeUndefined();
    expect(useHome.getState().doc!.folders.list).toEqual([]);
    await vi.waitFor(() => expect(Object.keys(useDupes.getState().cache)).toEqual(["Keep/2.jpg"]));
    expect(useDupes.getState().ignored).toEqual([{ keys: ["Keep/2.jpg", "Keep/3.jpg"], fps: ["b", "c"] }]);
  });
});

describe("what a screen was left showing", () => {
  it("is kept with its library, not shared between libraries or left in the browser", async () => {
    localStorage.setItem("quire.browseFilters", JSON.stringify({ folders: ["Private/Old"] }));
    await loadViews("/a");
    setView("browseFilters", { query: "sky" });
    await flushAll();
    await loadViews("/b");
    expect(view("browseFilters", null)).toBeNull();
    await loadViews("/a");
    expect(view("browseFilters", null)).toEqual({ query: "sky" });
    // What earlier versions left in the browser is gone (the module removes it as it loads).
    vi.resetModules();
    await import("../lib/views");
    expect(localStorage.getItem("quire.browseFilters")).toBeNull();
  });
});

describe("another library opened", () => {
  it("shows nothing of the last one's artists or plugins' overlays", async () => {
    useStore.setState({ root: "/a" } as never);
    useArtists.setState({ doc: { version: 1, artists: { x: { id: "x", name: "From A" } }, items: {} }, docRoot: "/a" } as never);
    usePlugins.setState({ overlays: { "Pics/1.jpg": { p: [] } } as never, directions: [{ pluginId: "p", dir: "rtl", albumKey: "Manga" }] as never });
    await import("../plugins/host");
    useStore.setState({ root: "/b" } as never);
    expect(useArtists.getState().docRoot).not.toBe("/a");
    expect(usePlugins.getState().overlays).toEqual({});
    expect(usePlugins.getState().directions).toEqual([]);
  });
});
