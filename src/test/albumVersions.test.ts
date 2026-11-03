import { describe, expect, it, vi } from "vitest";
import type { Library, MediaItem, TagData } from "../lib/types";

// What the stores load from the backend, and what they save to it.
const be = vi.hoisted(() => ({ tags: null as unknown, artists: null as unknown, saved: {} as Record<string, unknown> }));
vi.mock("../lib/api", () => ({
  api: {
    saveLibrary: vi.fn(async (_r: string, lib: unknown) => void (be.saved.library = lib)),
    loadTags: vi.fn(async () => be.tags),
    saveTags: vi.fn(async (_r: string, d: unknown) => void (be.saved.tags = d)),
    tagsIndexLoad: vi.fn(async () => null),
    artistsLoad: vi.fn(async () => be.artists),
    artistsSave: vi.fn(async (_r: string, doc: unknown) => void (be.saved.artists = doc)),
    engineModels: vi.fn(async () => []),
  },
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { useStore, eachOnce, originalOf } = await import("../store");
const { useTags, albumKeyOf, tagKeysFor } = await import("../tagsStore");
const { useArtists, albumArtistKey, countsOf } = await import("../artistsStore");

const page = (key: string, albumKey: string) => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], name: key, kind: "image", dir: albumKey, size: 1, modified: 0, hasRaw: false, hasVideo: false, albumKey }) as unknown as MediaItem;
const album = (key: string) => ({ key, name: key, path: key, albumRoot: "Albums", count: 1, images: 1, videos: 0, bytes: 1, modified: 0, cover: null });
const library = (patch: Partial<Library>) => ({ version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: ["Albums"], albumRatings: {}, autoDecodeAlbumNames: false, backupDest: null, lastBackup: null, ids: {}, ...patch }) as Library;

describe("an album and its translated version are one album", () => {
  it("joins the translated version's tags, artist and rating onto the original when the library is read", async () => {
    be.tags = { version: 1, types: ["motives"], tags: { "album:Albums/A": ["motives/sea"], "album:Albums/A-en": ["motives/sky"] }, denied: { "motives/cat": ["album:Albums/A-en"] } } satisfies Partial<TagData>;
    be.artists = { version: 1, artists: { ar1: { id: "ar1", name: "Kaze" } }, items: { "album:Albums/A-en": ["ar1"] }, dismissed: [] };
    useStore.setState({ root: "/vol", library: library({}), albums: [album("Albums/A"), album("Albums/A-en"), album("Albums/B")], allItems: [page("Albums/A/1.jpg", "Albums/A"), page("Albums/A-en/1.jpg", "Albums/A-en")] } as never);
    await useTags.getState().load();
    await useArtists.getState().load();
    useStore.setState({ library: library({ albumTranslations: { "Albums/A": "Albums/A-en" }, albumRatings: { "Albums/A-en": 4 } }) });

    const d = useTags.getState().data!;
    expect(d.tags["album:Albums/A"]?.sort()).toEqual(["motives/sea", "motives/sky"]);
    expect(d.tags["album:Albums/A-en"]).toBeUndefined();
    expect(d.denied?.["motives/cat"]).toEqual(["album:Albums/A"]);
    expect(useArtists.getState().doc!.items).toEqual({ "album:Albums/A": ["ar1"] });
    expect(countsOf(useArtists.getState().doc, true)).toEqual({ ar1: 1 });
  });

  it("lists the pair once, and reads the translated version as its original", () => {
    expect(eachOnce(useStore.getState().albums).map((a) => a.key)).toEqual(["Albums/A", "Albums/B"]);
    expect(originalOf("Albums/A-en")).toBe("Albums/A");
    expect(albumKeyOf("Albums/A-en")).toBe("album:Albums/A");
    expect(albumArtistKey("Albums/A-en")).toBe("album:Albums/A");
    expect(tagKeysFor(["Albums/A-en/1.jpg", "album:Albums/A-en", "Albums/A/1.jpg"])).toEqual(["album:Albums/A"]);
  });

  it("puts what is given to either version on the one album", () => {
    useTags.getState().setTag(["Albums/A-en/1.jpg"], "motives/night", true);
    expect(useTags.getState().data!.tags["album:Albums/A"]).toContain("motives/night");
    expect(useTags.getState().data!.tags["album:Albums/A-en"]).toBeUndefined();
    useStore.getState().setAlbumRatingByKey("Albums/A-en", 5);
    expect(useStore.getState().library!.albumRatings).toEqual({ "Albums/A": 5 });
  });

  it("joins the rating when the link is made, the original's own winning", () => {
    useStore.setState({ library: library({ albumRatings: { "Albums/B": 2, "Albums/C": 5 } }) });
    useStore.getState().setTranslation("Albums/B", "Albums/C");
    expect(useStore.getState().library!.albumRatings).toEqual({ "Albums/B": 2 });
    expect(useStore.getState().library!.albumTranslations).toEqual({ "Albums/B": "Albums/C" });
  });

  it("gives the translated version a copy of everything back when they are unlinked", async () => {
    useStore.setState({ library: library({ albumTranslations: { "Albums/A": "Albums/A-en" }, albumRatings: { "Albums/A": 5 } }) });
    useStore.getState().setTranslation("Albums/A", null);
    await vi.waitFor(() => expect(useTags.getState().data!.tags["album:Albums/A-en"]).toBeDefined());
    await vi.waitFor(() => expect(useArtists.getState().doc!.items["album:Albums/A-en"]).toEqual(["ar1"]));
    const d = useTags.getState().data!;
    expect(d.tags["album:Albums/A-en"]?.sort()).toEqual(["motives/night", "motives/sea", "motives/sky"]);
    expect(d.tags["album:Albums/A"]?.sort()).toEqual(["motives/night", "motives/sea", "motives/sky"]);
    expect(d.denied?.["motives/cat"]?.sort()).toEqual(["album:Albums/A", "album:Albums/A-en"]);
    expect(useStore.getState().library!.albumRatings).toEqual({ "Albums/A": 5, "Albums/A-en": 5 });
    expect(eachOnce(useStore.getState().albums)).toHaveLength(3);
  });
});
