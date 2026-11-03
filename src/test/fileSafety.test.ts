import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";

const be = vi.hoisted(() => ({ saved: [] as unknown[], scanAll: null as null | (() => Promise<MediaItem[]>), pages: {} as Record<string, string[]>, moved: [] as [string, string][] }));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      saveLibrary: async (_r: string, lib: unknown) => void be.saved.push(lib),
      scanAll: async () => (be.scanAll ? be.scanAll() : []),
      scanDir: async (_r: string, path: string) => (be.pages[path] ?? []).map((n) => pic(`${path.replace("/vol/", "")}/${n}`)),
      moveItem: async (_r: string, it: MediaItem, dest: string) => {
        const name = it.key.split("/").pop()!;
        const key = dest ? `${dest}/${name}` : name;
        be.moved.push([it.key, key]);
        return { moved: [[it.primary, `/vol/${key}`]], item: { ...it, key, primary: `/vol/${key}`, files: [`/vol/${key}`], dir: dest } };
      },
      snapshotLoad: async () => null,
      snapshotSave: async () => {},
      loadTags: async () => null,
      tagsIndexLoad: async () => null,
      loadCache: async () => null,
      artistsLoad: async () => null,
      fileFingerprint: async (p: string) => `fp-${p}`,
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const pic = (key: string): MediaItem => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: key.split("/").pop()!, dir: key.slice(0, key.lastIndexOf("/")), size: 10, modified: 0, hasRaw: false, hasVideo: false });
const library = (patch = {}) => ({ version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, ids: {}, ...patch }) as never;

const { useStore, applyMove, albumPages } = await import("../store");
// Loaded before any move: the store follows one into the tags by importing this lazily, and two
// such imports at once can get it half made in the test runner (never in the app).
await import("../tagsStore");
const { pageNumber } = await import("../lib/format");

afterAll(() => vi.dynamicImportSettled());

beforeEach(() => {
  be.saved = [];
  be.moved = [];
  be.scanAll = null;
  useStore.setState({ root: "/vol", library: library(), allItems: [], unsorted: [], queue: [], index: 0, viewed: {}, undoStack: [], albums: [], albumsLoaded: true, allLoaded: true, allStale: false, screen: "viewer" } as never);
});

describe("a page deleted in one version of an album", () => {
  it("still lands on the same page when switching: by its number, not its place", async () => {
    be.pages = { "/vol/Manga/en": ["001.jpg", "002.jpg", "004.jpg"], "/vol/Manga/jp": ["001.jpg", "002.jpg", "003.jpg", "004.jpg"] };
    const en = { key: "Manga/en", path: "/vol/Manga/en", name: "en", albumRoot: "Manga", count: 3, bytes: 0, images: 3, videos: 0, modified: 0, cover: null, pdf: false };
    const jp = { ...en, key: "Manga/jp", path: "/vol/Manga/jp", name: "jp", count: 4 };
    const pages = await albumPages("/vol", en);
    useStore.setState({ albums: [en, jp], library: library({ albumTranslations: { "Manga/en": "Manga/jp" } }), queue: pages, index: 2 } as never);
    await useStore.getState().switchTranslation();
    const s = useStore.getState();
    expect(s.queue.map((q) => q.name)).toEqual(["001.jpg", "002.jpg", "003.jpg", "004.jpg"]);
    expect(s.queue[s.index].name).toBe("004.jpg");
    expect(pageNumber("Chapter 3 - 07.png")).toBe(7);
    expect(pageNumber("cover.jpg")).toBeNull();
  });
});

describe("restoring from the trash", () => {
  it("brings the rating, identity and series place back with the file", () => {
    const t = pic("_deleted/a.jpg");
    useStore.setState({ library: library({ ratings: { "_deleted/a.jpg": 7 }, ids: { "_deleted/a.jpg": { s: 10, m: 0, n: "a.jpg" } }, series: [["_deleted/a.jpg", "Pics/b.jpg"]] }), allItems: [pic("Pics/b.jpg")] } as never);
    const back = { ...t, key: "a.jpg", primary: "/vol/a.jpg", files: ["/vol/a.jpg"], dir: "" };
    applyMove([["/vol/_deleted/a.jpg", "/vol/a.jpg"]], t, back, "Restored a.jpg");
    const lib = useStore.getState().library!;
    expect(lib.ratings).toEqual({ "a.jpg": 7 });
    expect(Object.keys(lib.ids!)).toEqual(["a.jpg"]);
    // Trashing kept its place in the series by its trash key; restored, it is the live key again.
    expect(lib.series).toEqual([["a.jpg", "Pics/b.jpg"]]);
  });

  it("emptying the trash forgets the purged files' identities and view times too", async () => {
    useStore.setState({ library: library({ ratings: { "_deleted/a.jpg": 7, "Pics/b.jpg": 3 }, ids: { "_deleted/a.jpg": { s: 1, m: 0, n: "a" }, "Pics/b.jpg": { s: 1, m: 0, n: "b" } } }), viewed: { "_deleted/a.jpg": 5, "Pics/b.jpg": 6 } } as never);
    await useStore.getState().emptyTrash();
    const s = useStore.getState();
    expect(Object.keys(s.library!.ids!)).toEqual(["Pics/b.jpg"]);
    expect(Object.keys(s.viewed)).toEqual(["Pics/b.jpg"]);
  });
});

describe("what the trash remembers", () => {
  it("notes where a trashed picture came from, and drops the note when it is back", () => {
    const a = pic("Pics/a.jpg");
    const t = { ...a, key: "_deleted/a.jpg", primary: "/vol/_deleted/a.jpg", files: ["/vol/_deleted/a.jpg"], dir: "_deleted" };
    applyMove([["/vol/Pics/a.jpg", "/vol/_deleted/a.jpg"]], a, t, "Trashed a.jpg", true);
    expect(useStore.getState().library!.trashFrom).toEqual({ "_deleted/a.jpg": "Pics/a.jpg" });
    applyMove([["/vol/_deleted/a.jpg", "/vol/Pics/a.jpg"]], t, a, "Restored a.jpg");
    expect(useStore.getState().library!.trashFrom).toEqual({});
  });

  it("emptying the trash forgets purged albums' rating, language, translation link and origins", async () => {
    useStore.setState({ library: library({ albumRatings: { "_deleted/Book": 5, "Manga/Other": 3 }, albumLanguages: { "_deleted/Book": "ja" }, albumTranslations: { "Manga/Other": "_deleted/Book" }, trashFrom: { "_deleted/Book": "Manga/Book" } }) } as never);
    await useStore.getState().emptyTrash();
    const lib = useStore.getState().library!;
    expect(lib.albumRatings).toEqual({ "Manga/Other": 3 });
    expect(lib.albumLanguages).toEqual({});
    expect(lib.albumTranslations).toEqual({});
    expect(lib.trashFrom).toEqual({});
  });
});

describe("a file deleted outside the app a month ago", () => {
  it("is let go of everywhere it was kept", async () => {
    const { forgetKeys } = await import("../store");
    useStore.setState({ library: library({ ratings: { "Pics/old.jpg": 4, "Pics/b.jpg": 2 }, ids: { "Pics/old.jpg": { s: 1, m: 0, n: "old" } }, sources: { "Pics/old.jpg": { platform: "x", id: "1" } }, series: [["Pics/old.jpg", "Pics/b.jpg"]], seriesNot: ["Pics/b.jpg|Pics/old.jpg"] }), viewed: { "Pics/old.jpg": 1, "Pics/b.jpg": 2 } } as never);
    forgetKeys(["Pics/old.jpg"]);
    const s = useStore.getState();
    expect(s.library!.ratings).toEqual({ "Pics/b.jpg": 2 });
    expect(s.library!.ids).toEqual({});
    expect(s.library!.sources).toEqual({});
    expect(s.library!.series).toEqual([]);
    expect(s.library!.seriesNot).toEqual([]);
    expect(s.viewed).toEqual({ "Pics/b.jpg": 2 });
  });
});

describe("a PDF album moved", () => {
  it("takes its pages' keys along", async () => {
    const { mover } = await import("../lib/moves");
    const move = mover([["Manga/book.pdf", "Read/book.pdf"]]);
    expect(move("Manga/book.pdf#3")).toBe("Read/book.pdf#3");
    expect(move("Manga/other.pdf#3")).toBeNull();
  });
});

describe("another library opened while the first is still scanning", () => {
  it("doesn't get the first library's files", async () => {
    let finish!: (items: MediaItem[]) => void;
    be.scanAll = () => new Promise((r) => (finish = r));
    useStore.setState({ allLoaded: false } as never);
    const scan = useStore.getState().loadAll(true);
    // The library changed under the scan.
    useStore.setState({ root: "/other", allItems: [pic("Other/x.jpg")] } as never);
    finish([pic("First/a.jpg"), pic("First/b.jpg")]);
    await scan;
    expect(useStore.getState().allItems.map((i) => i.key)).toEqual(["Other/x.jpg"]);
  });
});
