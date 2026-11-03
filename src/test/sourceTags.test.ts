import { describe, expect, it, vi } from "vitest";
import type { ItemSource, MediaItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: { loadTags: vi.fn(async () => ({ version: 1, types: ["motives"], tags: { x: ["motives/sea"] }, autoMap: {}, albums: {} })), tagsIndexLoad: vi.fn(async () => null), engineModels: vi.fn(async () => []), saveTags: vi.fn(async () => {}), saveLibrary: vi.fn(async () => {}) },
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { useStore } = await import("../store");
const { useTags } = await import("../tagsStore");

const src = (tags: string[]): ItemSource => ({ platform: "example", id: "1", url: "", title: "", author: { id: "7", name: "Kaze" }, tags: tags.map((name) => ({ name, translated: null })), date: null, adult: false, added: 0 });
const page = (key: string, albumKey?: string) => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], name: key, kind: "image", dir: "", size: 1, modified: 0, hasRaw: false, hasVideo: false, albumKey }) as unknown as MediaItem;

describe("a platform's tags linked to yours", () => {
  it("bring yours in with what comes in carrying them, a work of pages onto its album", async () => {
    useStore.setState({ root: "/vol", allItems: [page("In/a.jpg"), page("Albums/W/1.jpg", "Albums/W")] } as never);
    await useTags.getState().load();
    const t = useTags.getState();
    t.linkSource("example", "風景", "motives/sea");
    t.linkSource("example", "夜", "motives/night");
    await t.applySources([
      ["In/a.jpg", src(["風景", "other"])],
      ["Albums/W/1.jpg", src(["夜"])],
    ]);
    const tags = useTags.getState().data!.tags;
    expect(tags["In/a.jpg"]).toEqual(["motives/sea"]);
    expect(tags["album:Albums/W"]).toEqual(["motives/night"]);
  });

  it("of a platform whose tags are the tagger's words, follow the word's link, unless linked themselves", async () => {
    const { useFinders } = await import("../plugins/find");
    useFinders.setState({ finders: { words: { platform: "words", taggerWords: true } as never, other: { platform: "other", taggerWords: false } as never } });
    const t = useTags.getState();
    t.mapAuto("long_hair", "motives/hair");
    t.mapAuto("cat", "motives/cat");
    t.linkSource("words", "cat", "motives/sea");
    const from = (platform: string, tags: string[]) => ({ ...src(tags), platform });
    useStore.setState({ allItems: [page("In/w.jpg"), page("In/o.jpg")] } as never);
    await t.applySources([
      ["In/w.jpg", from("words", ["long_hair", "cat"])],
      ["In/o.jpg", from("other", ["long_hair"])],
    ]);
    const tags = useTags.getState().data!.tags;
    expect(tags["In/w.jpg"]?.sort()).toEqual(["motives/hair", "motives/sea"]);
    expect(tags["In/o.jpg"]).toBeUndefined();
    t.linkSource("words", "cat", null);
    useFinders.setState({ finders: {} });
  });

  it("give an album that came in from a platform its language, unless it has one", () => {
    useStore.setState({ library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: ["Albums/"], albumRatings: {}, albumLanguages: { "Albums/Had": "ja" } }, allItems: [] } as never);
    const said = (language: string) => ({ ...src([]), language });
    useStore.getState().addSources([
      ["Albums/W/001.jpg", said("en")],
      ["Albums/W/002.jpg", said("en")],
      ["Albums/Had/001.jpg", said("en")],
      ["In/single.jpg", said("en")],
    ]);
    expect(useStore.getState().library!.albumLanguages).toEqual({ "Albums/Had": "ja", "Albums/W": "en" });
  });

  it("follow a tag renamed, and go when it is deleted", () => {
    const t = useTags.getState();
    t.renameTag("motives/sea", "motives/ocean");
    expect(useTags.getState().data!.sourceMap).toEqual({ "example:風景": "motives/ocean", "example:夜": "motives/night" });
    t.removeTag("motives/night");
    expect(useTags.getState().data!.sourceMap).toEqual({ "example:風景": "motives/ocean" });
    t.linkSource("example", "風景", null);
    expect(useTags.getState().data!.sourceMap).toEqual({});
  });
});
