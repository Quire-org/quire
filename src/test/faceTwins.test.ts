import { describe, expect, it, vi } from "vitest";
import type { FaceView, MediaItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { faceTwins, carriedToTwins, mirrored } = await import("../lib/faceTwins");
const { useStore } = await import("../store");
const { usePeople } = await import("../peopleStore");

const page = (album: string, name: string): MediaItem => ({ key: `${album}/${name}`, primary: `/vol/${album}/${name}`, files: [], name, kind: "image", dir: album, size: 1, modified: 0, hasRaw: false, hasVideo: false, albumKey: album });
const face = (id: number, key: string, bbox: FaceView["bbox"], kind: FaceView["kind"] = "drawn"): FaceView => ({ id, key, kind, bbox, score: 0.9, size: 100 });

describe("a face on a translated page", () => {
  const items = [page("Manga/jp", "001.jpg"), page("Manga/jp", "002.jpg"), page("Manga/en", "credits.jpg"), page("Manga/en", "p001.jpg"), page("Manga/en", "p002.jpg")];
  const links = { "Manga/jp": "Manga/en" };

  it("is one with the face in its place on the same page of the other version", () => {
    const faces = [
      face(1, "Manga/jp/001.jpg", [0.1, 0.1, 0.3, 0.3]),
      face(2, "Manga/jp/001.jpg", [0.6, 0.1, 0.8, 0.3]),
      face(3, "Manga/en/p001.jpg", [0.12, 0.1, 0.32, 0.3]),
      // Where face 2 is, but on the page before (the credits): no twin.
      face(4, "Manga/en/credits.jpg", [0.6, 0.1, 0.8, 0.3]),
      // Page 2: a face elsewhere on the page, and one of the other kind in the place.
      face(5, "Manga/jp/002.jpg", [0.1, 0.5, 0.3, 0.7]),
      face(6, "Manga/en/p002.jpg", [0.6, 0.5, 0.8, 0.7]),
      face(7, "Manga/en/p002.jpg", [0.1, 0.5, 0.3, 0.7], "photo"),
    ];
    const twins = faceTwins(faces, items, links);
    expect(Object.fromEntries(twins)).toEqual({ 1: [3], 3: [1] });
  });

  it("goes with its page by place when the pages aren't numbered and both versions have as many", () => {
    const two = [page("A", "cover.jpg"), page("A", "end.jpg"), page("B", "front.jpg"), page("B", "last.jpg")];
    const faces = [face(1, "A/end.jpg", [0.1, 0.1, 0.3, 0.3]), face(2, "B/last.jpg", [0.1, 0.1, 0.3, 0.3])];
    expect(faceTwins(faces, two, { A: "B" }).get(1)).toEqual([2]);
  });

  it("is said to be whoever its twin was said to be, unless something is said of it already", () => {
    const twins = new Map([
      [1, [2]],
      [2, [1]],
      [3, [4]],
      [4, [3]],
      [5, [6]],
      [6, [5]],
    ]);
    const doc = { faces: { 1: { p: "aoi", ok: true }, 3: { p: "aoi" }, 4: { p: "ren" } }, no: [5], not: { 1: ["ren"] } };
    const carried = carriedToTwins(doc, twins)!;
    expect(carried.faces).toEqual({ 1: { p: "aoi", ok: true }, 2: { p: "aoi", ok: true }, 3: { p: "aoi" }, 4: { p: "ren" } });
    expect(carried.no.sort()).toEqual([5, 6]);
    expect(carried.not).toEqual({ 1: ["ren"], 2: ["ren"] });
    // Said once, nothing more to carry.
    expect(carriedToTwins(carried, twins)).toBeNull();
  });

  it("changes with its twin however a change is made (a face taken back, put aside), unless the change said otherwise of the twin", () => {
    const twins = new Map([
      [1, [2]],
      [2, [1]],
      [3, [4]],
      [4, [3]],
    ]);
    const before = { faces: { 1: { p: "aoi" }, 2: { p: "aoi" }, 3: { p: "ren", ok: true }, 4: { p: "ren", ok: true } }, no: [] as number[], not: {} };
    // Face 1 taken back and put aside, face 3 given to Aoi: their twins with them.
    const after = { faces: { 2: { p: "aoi" }, 3: { p: "aoi", ok: true }, 4: { p: "ren", ok: true } }, no: [1], not: {} };
    const out = mirrored(before, after, twins);
    expect(out.faces).toEqual({ 3: { p: "aoi", ok: true }, 4: { p: "aoi", ok: true } });
    expect(out.no.sort()).toEqual([1, 2]);
    // Both of a pair changed in one change, each its own way: as said.
    const both = { ...before, faces: { ...before.faces, 3: { p: "aoi", ok: true }, 4: { p: "kai", ok: true } } };
    expect(mirrored(before, both, twins).faces).toEqual(both.faces);
    // Nothing of a face with a twin changed: as it was.
    expect(mirrored(before, { ...before, not: {} }, twins)).toEqual(before);
  });

  it("is said yes or no to with its twin, from People", async () => {
    const faces = [face(1, "Manga/jp/001.jpg", [0.1, 0.1, 0.3, 0.3]), face(3, "Manga/en/p001.jpg", [0.1, 0.1, 0.3, 0.3])];
    useStore.setState({ root: "/vol", allItems: items, library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, albumTranslations: links } } as never);
    usePeople.setState({
      doc: { version: 1, people: { aoi: { id: "aoi", name: "Aoi", kind: "character", from: null, portrait: null, added: 0 } }, faces: {}, no: [], not: {}, exclude: [], converted: null },
      docRoot: "/vol",
      faces,
      byId: new Map(faces.map((f) => [f.id, f])),
    } as never);
    usePeople.getState().accept([1], "aoi");
    expect(usePeople.getState().doc!.faces).toEqual({ 1: { p: "aoi", ok: true }, 3: { p: "aoi", ok: true } });
    expect(usePeople.getState().undo?.what).toBe("1 face added to Aoi");
    usePeople.getState().notThem([3], "aoi");
    expect(usePeople.getState().doc!.faces).toEqual({});
    expect(usePeople.getState().doc!.not).toEqual({ 1: ["aoi"], 3: ["aoi"] });
  });
});
