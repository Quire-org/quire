import { afterAll, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      loadTags: async () => ({ tags: { "Pics/a.jpg": ["sky"] } }),
      tagsIndexLoad: async () => null,
      saveTags: async () => {},
      saveLibrary: async () => {},
      peopleLoad: async () => null,
      facesLoad: async () => ({ faces: [], scanned: {} }),
      artistsLoad: async () => null,
      scrapbookLoad: async () => null,
      loadCache: async () => null,
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

const { useStore, applyMove, followMoves } = await import("../store");
const { useTags } = await import("../tagsStore");

afterAll(() => vi.dynamicImportSettled());

const pic = (key: string): MediaItem => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: key.split("/").pop()!, dir: key.slice(0, key.lastIndexOf("/")), size: 10, modified: 0, hasRaw: false, hasVideo: false });

describe("a picture sent to the trash", () => {
  it("takes its tags along, and brings them back wherever it is restored to", async () => {
    useStore.setState({ root: "/vol", library: { version: 1, targets: [], ratings: { "Pics/a.jpg": 4 }, trashDir: "_deleted", albumRoots: [], albumRatings: {}, ids: {} }, allItems: [pic("Pics/a.jpg")], unsorted: [], queue: [], index: 0, viewed: {}, undoStack: [] } as never);
    await useTags.getState().load();
    expect(useTags.getState().data?.tags["Pics/a.jpg"]).toEqual(["sky"]);
    applyMove([["/vol/Pics/a.jpg", "/vol/_deleted/a.jpg"]], pic("Pics/a.jpg"), pic("_deleted/a.jpg"), "Trashed a.jpg", true);
    await vi.waitFor(() => expect(useTags.getState().data?.tags["_deleted/a.jpg"]).toEqual(["sky"]));
    expect(useTags.getState().data?.tags["Pics/a.jpg"]).toBeUndefined();
    expect(useStore.getState().library!.ratings).toEqual({ "_deleted/a.jpg": 4 });
    // Restored somewhere other than where it was (its folder is gone, say).
    followMoves([["_deleted/a.jpg", "a.jpg"]]);
    await vi.waitFor(() => expect(useTags.getState().data?.tags["a.jpg"]).toEqual(["sky"]));
  });
});
