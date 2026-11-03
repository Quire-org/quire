import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FaceView, FacesSorted, MediaItem } from "../lib/types";

const be = vi.hoisted(() => ({ faces: [] as FaceView[], scanned: {} as Record<string, [number, number]>, noCharacters: [] as string[], sorted: { matches: [], groups: [] } as FacesSorted, labels: [] as unknown[], saved: null as unknown, tags: null as unknown }));

vi.mock("../lib/api", () => ({
  api: {
    peopleLoad: vi.fn(async () => null),
    peopleSave: vi.fn(async (_r: string, d: unknown) => void (be.saved = d)),
    facesLoad: vi.fn(async () => ({ faces: be.faces, scanned: be.scanned, noCharacters: be.noCharacters })),
    facesSort: vi.fn(async (_r: string, labels: unknown) => (be.labels.push(labels), be.sorted)),
    facesRename: vi.fn(async () => {}),
    facesForget: vi.fn(async () => {}),
    facesScan: vi.fn(async () => {}),
    facesMark: vi.fn(async () => [] as FaceView[]),
    loadTags: vi.fn(async () => be.tags),
    tagsIndexLoad: vi.fn(async () => null),
    engineModels: vi.fn(async () => ({ models: [], used: 0, default: "" })),
    engineStore: vi.fn(async () => null),
    saveTags: vi.fn(async () => {}),
    saveLibrary: vi.fn(async () => {}),
  },
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
vi.mock("../plugins/engine", () => ({ useEngine: Object.assign(() => null, { getState: () => ({ catalog: null, refresh: async () => {} }), setState: () => {}, subscribe: () => () => {} }) }));

const { usePeople, characterGuess } = await import("../peopleStore");
const { useStore } = await import("../store");
const { api } = await import("../lib/api");

const face = (id: number, key: string, kind: "photo" | "drawn" = "photo"): FaceView => ({ id, key, kind, bbox: [0.1, 0.1, 0.3, 0.4], score: 0.9, size: 120 });
const item = (key: string, kind: MediaItem["kind"] = "image", size = 10, modified = 1): MediaItem => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind, name: key.split("/").pop()!, dir: key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "", size, modified, hasRaw: false, hasVideo: false });

beforeEach(async () => {
  be.faces = [face(1, "a.jpg"), face(2, "b.jpg"), face(3, "c.jpg"), face(4, "d.png", "drawn"), face(5, "d.png", "drawn")];
  be.scanned = {};
  be.noCharacters = [];
  be.sorted = { matches: [], groups: [] };
  be.labels.length = 0;
  useStore.setState({ root: "/vol", library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} }, allItems: [] } as never);
  usePeople.setState({ doc: null, docRoot: null, faces: [], byId: new Map(), scanned: {}, sorted: null, undo: null, open: null });
  await usePeople.getState().load();
});

describe("naming faces", () => {
  it("makes a person of a group, or adds it to the one by that name, and ⌘Z takes it back", () => {
    const p = usePeople.getState();
    const lena = p.name([1, 2], "Lena")!;
    expect(usePeople.getState().doc!.people[lena]).toMatchObject({ name: "Lena", kind: "person" });
    expect(usePeople.getState().name([3], "lena")).toBe(lena);
    expect(Object.values(usePeople.getState().doc!.faces).filter((a) => a.p === lena)).toHaveLength(3);
    usePeople.getState().revert();
    expect(usePeople.getState().doc!.faces["3"]).toBeUndefined();
    expect(usePeople.getState().doc!.faces["1"]).toEqual({ p: lena });
  });

  it("makes a character of drawn faces, and never adds them to a person of that name", () => {
    const p = usePeople.getState();
    const lena = p.name([1], "Lena")!;
    const drawn = usePeople.getState().name([4, 5], "Lena", "Lantern Road")!;
    expect(drawn).not.toBe(lena);
    expect(usePeople.getState().doc!.people[drawn]).toMatchObject({ kind: "character", from: "Lantern Road" });
  });

  it("takes faces off a person ('not them'), remembers it, and tells the matching", async () => {
    const lena = usePeople.getState().name([1, 2], "Lena")!;
    usePeople.getState().notThem([2], lena);
    const d = usePeople.getState().doc!;
    expect(d.faces["2"]).toBeUndefined();
    expect(d.not["2"]).toEqual([lena]);
    await vi.waitFor(() => expect(be.labels.length).toBeGreaterThan(2));
    expect(be.labels[be.labels.length - 1]).toMatchObject({ assigned: [[1, lena, false]], not: [[2, lena]] });
  });

  it("marks the faces of a group named after checking each as checked", () => {
    const lena = usePeople.getState().name([1, 2], "Lena", null, [], true)!;
    expect(usePeople.getState().doc!.faces["1"]).toEqual({ p: lena, ok: true });
  });

  it("leaves out of a name the faces unticked in the group, and never finds them for that person", () => {
    const lena = usePeople.getState().name([1, 2], "Lena", null, [3])!;
    const d = usePeople.getState().doc!;
    expect(d.faces["3"]).toBeUndefined();
    expect(d.not["3"]).toEqual([lena]);
  });

  it("puts aside faces that aren't wanted", () => {
    usePeople.getState().dismiss([3]);
    expect(usePeople.getState().doc!.no).toEqual([3]);
  });

  it("suggests faces close to a person, theirs only once said yes to", async () => {
    const lena = usePeople.getState().name([1], "Lena")!;
    be.sorted = { matches: [{ face: 2, person: lena, score: 0.5 }], groups: [] };
    await usePeople.getState().sort();
    expect(usePeople.getState().doc!.faces["2"]).toBeUndefined();
    expect(usePeople.getState().sorted!.matches).toEqual([{ face: 2, person: lena, score: 0.5 }]);
    // Said yes to: hers, checked, and it stands for her.
    usePeople.getState().accept([2], lena);
    expect(usePeople.getState().doc!.faces["2"]).toEqual({ p: lena, ok: true });
    await vi.waitFor(() => expect((be.labels[be.labels.length - 1] as { assigned: unknown[] }).assigned).toEqual([[1, lena, false], [2, lena, true]]));
  });

  it("takes off the faces an earlier version let join by themselves", async () => {
    const lena = usePeople.getState().name([1], "Lena")!;
    usePeople.setState({ doc: { ...usePeople.getState().doc!, faces: { ...usePeople.getState().doc!.faces, "2": { p: lena, auto: true, s: 0.5 } } } });
    await usePeople.getState().sort();
    expect(Object.keys(usePeople.getState().doc!.faces)).toEqual(["1"]);
  });

  it("checks a face given someone that looks like none of their others", () => {
    const lena = usePeople.getState().name([1, 2], "Lena")!;
    usePeople.getState().confirm([2]);
    expect(usePeople.getState().doc!.faces["2"]).toEqual({ p: lena, ok: true });
  });

  it("merges a person into the one they're the same as", () => {
    const p = usePeople.getState();
    const a = p.name([1], "Lena")!;
    const b = usePeople.getState().name([2], "Lena M")!;
    usePeople.getState().merge(b, a);
    const d = usePeople.getState().doc!;
    expect(Object.keys(d.people)).toEqual([a]);
    expect(d.faces["2"]).toEqual({ p: a });
  });
});

describe("the face scan", () => {
  it("looks at pictures and videos new or changed since, not the trash or folders left out", async () => {
    useStore.setState({ allItems: [item("a.jpg"), item("b.jpg", "image", 20), item("c.mp4", "video"), item("_deleted/x.jpg"), item("Work/shoot/y.jpg"), item("raw.cr2", "raw")] } as never);
    usePeople.setState({ scanned: { "a.jpg": [10, 1], "b.jpg": [10, 1] } });
    usePeople.getState().setExclude(["Work"]);
    expect(usePeople.getState().pending().map((i) => i.key)).toEqual(["b.jpg", "c.mp4", "raw.cr2"]);
  });

  it("looks again, once, at the photos an earlier version took for drawings", async () => {
    const { useTags } = await import("../tagsStore");
    // The anime tagger passed over two photos (an empty list), and saw a drawing.
    useTags.setState({ data: { version: 1, types: [], tags: {}, auto: { "a.jpg": [], "_deleted/x.jpg": [], "page.png": [[0, 0.9]] }, indexed: {}, autoMap: {}, albums: {} }, loaded: true } as never);
    useStore.setState({ allItems: [item("a.jpg"), item("_deleted/x.jpg"), item("page.png")] } as never);
    be.scanned = { "a.jpg": [10, 1], "_deleted/x.jpg": [10, 1], "page.png": [10, 1] };
    await usePeople.getState().load(true);
    expect(usePeople.getState().pending()).toEqual([]);
    expect(usePeople.getState().toRecheck(useTags.getState().data).map((i) => i.key)).toEqual(["a.jpg"]);
    // Stopped partway: tried again next time.
    vi.mocked(api.facesScan).mockRejectedValueOnce("stopped");
    await usePeople.getState().scan();
    expect(usePeople.getState().doc!.photosRechecked).toBeUndefined();
    // Looked at through: as the photo it is, and not again.
    vi.mocked(api.facesScan).mockClear();
    await usePeople.getState().scan();
    expect(vi.mocked(api.facesScan).mock.lastCall?.[1]).toMatchObject([{ key: "a.jpg", kind: "photo" }]);
    expect(usePeople.getState().doc!.photosRechecked).toBe(true);
    expect(usePeople.getState().toRecheck(useTags.getState().data)).toEqual([]);
    vi.mocked(api.facesScan).mockClear();
    await usePeople.getState().scan();
    expect(api.facesScan).not.toHaveBeenCalled();
  });

  it("works with the face finder alone: a drawn picture waits for the character finder, then is looked at again", async () => {
    const { useTags } = await import("../tagsStore");
    // The anime tagger says it is drawn; the character finder isn't downloaded (it is optional).
    useTags.setState({ data: { version: 1, types: [], tags: {}, auto: { "page.png": [[0, 0.9]] }, indexed: { "page.png": 1 }, autoMap: {}, albums: {} }, loaded: true } as never);
    useStore.setState({ allItems: [item("page.png")] } as never);
    usePeople.setState({ characters: false });
    vi.mocked(api.facesScan).mockClear();
    await usePeople.getState().scan();
    // Looked at as a picture of unknown kind: the face finder alone (asking for drawn would fail).
    expect(vi.mocked(api.facesScan).mock.lastCall?.[1]).toMatchObject([{ key: "page.png", kind: null }]);
    // The backend noted it: done for now.
    be.scanned = { "page.png": [10, 1] };
    be.noCharacters = ["page.png"];
    await usePeople.getState().load(true);
    expect(usePeople.getState().pending()).toEqual([]);
    // The character finder downloaded: it is looked at again, as the drawing it is.
    usePeople.setState({ characters: true });
    expect(usePeople.getState().pending().map((i) => i.key)).toEqual(["page.png"]);
    await usePeople.getState().scan();
    expect(vi.mocked(api.facesScan).mock.lastCall?.[1]).toMatchObject([{ key: "page.png", kind: "drawn" }]);
    usePeople.setState({ characters: false });
  });
});

describe("a guess at who a drawn face is", () => {
  const names = [
    { name: "1girl", category: 0 },
    { name: "hatsune_miku", category: 4 },
    { name: "vocaloid", category: 3 },
    { name: "rem_(re:zero)", category: 4 },
  ];
  it("is the character the tagger saw in most of the pictures, with their series", () => {
    const auto: Record<string, [number, number][]> = { a: [[0, 0.9], [1, 0.8], [2, 0.7]], b: [[1, 0.9], [2, 0.6]], c: [[3, 0.9]] };
    expect(characterGuess(["a", "b", "c"], auto, names)).toEqual({ name: "Hatsune Miku", from: "Vocaloid" });
  });
  it("isn't made from a character seen in too few of them, or not surely", () => {
    const auto: Record<string, [number, number][]> = { a: [[1, 0.9]], b: [[0, 0.9]], c: [[1, 0.3]] };
    expect(characterGuess(["a", "b", "c"], auto, names)).toBeNull();
  });
});

describe("people from tags", () => {
  const tagsWith = (tags: Record<string, string[]>, more: object = {}) => ({ version: 1, types: ["people", "motives"], tags, auto: {}, indexed: {}, autoMap: {}, albums: {}, ...more });
  const reset = async () => {
    const { useTags } = await import("../tagsStore");
    useTags.setState({ data: null, loaded: false } as never);
    return useTags;
  };

  it("undone, takes only the people it made, and from people there before only the faces it gave them", async () => {
    // Lena named by hand before (face 1); her tag adds face 2. Kai is new.
    const lena = usePeople.getState().name([1], "lena")!;
    be.tags = tagsWith({ "b.jpg": ["people/lena"], "c.jpg": ["people/kai"] });
    const useTags = await reset();
    await usePeople.getState().convert("people");
    const kai = Object.values(usePeople.getState().doc!.people).find((x) => x.name === "kai")!;
    expect(usePeople.getState().doc!.faces["2"]).toEqual({ p: lena });
    expect(usePeople.getState().doc!.converted!.made).toEqual([kai.id]);
    expect(await usePeople.getState().revertConversion()).toBe(2);
    const d = usePeople.getState().doc!;
    expect(Object.keys(d.people)).toEqual([lena]);
    expect(d.faces).toEqual({ "1": { p: lena } });
    expect(useTags.getState().data!.tags).toEqual({ "b.jpg": ["people/lena"], "c.jpg": ["people/kai"] });
  });

  it("puts the tags' settings back with them, keeping what changed meanwhile", async () => {
    be.tags = tagsWith(
      { "a.jpg": ["people/lena", "people/lena_young"], "c.jpg": ["people/kai"] },
      { parents: { "people/lena_young": "people/lena" }, autoMap: { "1girl": "people/lena" }, denied: { "people/kai": ["d.png"] }, covers: { "people/lena": "sb1" }, apart: [["people/kai", "motives/sea"]] },
    );
    const useTags = await reset();
    await usePeople.getState().convert("people");
    const gone = useTags.getState().data!;
    expect(gone.parents).toEqual({});
    expect(gone.autoMap).toEqual({});
    // Meanwhile another tag gets a banner of its own.
    useTags.setState({ data: { ...gone, covers: { "motives/sea": "sb2" } } });
    await usePeople.getState().revertConversion();
    const back = useTags.getState().data!;
    expect(back.parents).toEqual({ "people/lena_young": "people/lena" });
    expect(back.autoMap).toEqual({ "1girl": "people/lena" });
    expect(back.denied).toEqual({ "people/kai": ["d.png"] });
    expect(back.covers).toEqual({ "motives/sea": "sb2", "people/lena": "sb1" });
    expect(back.apart).toEqual([["people/kai", "motives/sea"]]);
  });

  it("puts the tags back on pictures where they are now, if they moved meanwhile", async () => {
    be.tags = tagsWith({ "c.jpg": ["people/kai"] });
    const useTags = await reset();
    await usePeople.getState().convert("people");
    usePeople.getState().follow([["c.jpg", "Sorted/c.jpg"]]);
    await usePeople.getState().revertConversion();
    expect(useTags.getState().data!.tags).toEqual({ "Sorted/c.jpg": ["people/kai"] });
  });

  it("undoes a conversion recorded before, keeping a person of a tag's name named earlier and their own checked faces", async () => {
    const lena = usePeople.getState().name([1], "lena", null, [], true)!;
    const old = Date.now() - 3_600_000;
    usePeople.setState({ doc: { ...usePeople.getState().doc!, people: { ...usePeople.getState().doc!.people, [lena]: { ...usePeople.getState().doc!.people[lena], added: old } } } });
    // As the earlier version left it: Lena among the made, and face 2 (in her tagged picture) given her.
    const at = Date.now();
    usePeople.setState({
      doc: {
        ...usePeople.getState().doc!,
        people: { ...usePeople.getState().doc!.people, pekai: { id: "pekai", name: "kai", kind: "person", from: null, portrait: null, added: at - 5 } },
        faces: { "1": { p: lena, ok: true }, "2": { p: lena }, "3": { p: "pekai" } },
        converted: { folder: "people", made: [lena, "pekai"], tags: { "a.jpg": ["people/lena"], "b.jpg": ["people/lena"], "c.jpg": ["people/kai"] }, at },
      },
    });
    be.tags = tagsWith({});
    const useTags = await reset();
    await usePeople.getState().revertConversion();
    const d = usePeople.getState().doc!;
    expect(Object.keys(d.people)).toEqual([lena]);
    expect(d.faces).toEqual({ "1": { p: lena, ok: true } });
    expect(Object.keys(useTags.getState().data!.tags).sort()).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("makes a person per tag, gives them a picture's only face, and the tags go; undone, they come back", async () => {
    be.tags = { version: 1, types: ["people", "motives"], tags: { "a.jpg": ["people/lena", "motives/sea"], "b.jpg": ["people/lena"], "d.png": ["people/kai"] }, auto: {}, indexed: {}, autoMap: {}, albums: {} };
    const { useTags } = await import("../tagsStore");
    useTags.setState({ data: null, loaded: false } as never);
    const n = await usePeople.getState().convert("people");
    expect(n).toBe(2);
    const d = usePeople.getState().doc!;
    const lena = Object.values(d.people).find((x) => x.name === "lena")!;
    expect(lena.kind).toBe("person");
    expect(d.faces["1"]).toEqual({ p: lena.id });
    expect(d.faces["2"]).toEqual({ p: lena.id });
    // Two drawn faces in one picture: neither is given (faces like Kai's are suggested on his page).
    expect(d.faces["4"]).toBeUndefined();
    expect(useTags.getState().data!.tags["a.jpg"]).toEqual(["motives/sea"]);
    await usePeople.getState().revertConversion();
    expect(useTags.getState().data!.tags["a.jpg"]).toEqual(expect.arrayContaining(["motives/sea", "people/lena"]));
    expect(Object.keys(usePeople.getState().doc!.people)).toEqual([]);
  });
});

describe("someone in a picture whose face isn't known", () => {
  it("is said to be in it once, goes with it when it moves, and leaves it when a face of theirs is named there", () => {
    const p = usePeople.getState();
    const lena = p.addPresent("a.jpg", "Lena", "person")!;
    expect(usePeople.getState().addPresent("a.jpg", "lena", "person")).toBe(lena);
    usePeople.getState().addPresent("b.jpg", "Lena", "person");
    expect(usePeople.getState().doc!.present).toEqual({ "a.jpg": [lena], "b.jpg": [lena] });
    // Her face in a.jpg named: she is in it with a face now.
    expect(usePeople.getState().name([1], "Lena", null, [], true)).toBe(lena);
    expect(usePeople.getState().doc!.present).toEqual({ "b.jpg": [lena] });
    usePeople.getState().follow([["b.jpg", "Trip/b.jpg"]]);
    expect(usePeople.getState().doc!.present).toEqual({ "Trip/b.jpg": [lena] });
    usePeople.getState().forget("Trip/");
    expect(usePeople.getState().doc!.present).toEqual({});
  });

  it("is taken out of it, and goes with them into the one they are the same as", () => {
    const kai = usePeople.getState().addPresent("a.jpg", "Kai", "person")!;
    const mo = usePeople.getState().addPresent("b.jpg", "Mo", "person")!;
    usePeople.getState().addPresent("b.jpg", "Kai", "person");
    usePeople.getState().merge(mo, kai);
    expect(usePeople.getState().doc!.present).toEqual({ "a.jpg": [kai], "b.jpg": [kai] });
    usePeople.getState().removePresent("a.jpg", kai);
    expect(usePeople.getState().doc!.present).toEqual({ "b.jpg": [kai] });
  });

  it("can have several faces in one picture: each named on its own", () => {
    const rin = usePeople.getState().name([4], "Rin", null, [], true)!;
    expect(usePeople.getState().name([5], "Rin", null, [], true)).toBe(rin);
    expect(usePeople.getState().doc!.faces).toEqual({ "4": { p: rin, ok: true }, "5": { p: rin, ok: true } });
  });

  it("from a tag: kept in a picture with no face of theirs found, several, or only someone else's; undone, only those go", async () => {
    const mo = usePeople.getState().name([3], "Mo")!;
    const kept = usePeople.getState().addPresent("a.jpg", "Mo", "person");
    expect(kept).toBe(mo);
    // Lena: a.jpg's one face is hers; c.jpg's is Mo's. Kai (drawn, as most of his faces are): none in b.jpg, two in d.png.
    be.tags = { version: 1, types: ["people"], tags: { "a.jpg": ["people/lena"], "c.jpg": ["people/lena"], "b.jpg": ["people/kai"], "d.png": ["people/kai"] }, auto: {}, indexed: {}, autoMap: {}, albums: {} };
    const { useTags } = await import("../tagsStore");
    useTags.setState({ data: null, loaded: false } as never);
    await usePeople.getState().convert("people");
    const d = usePeople.getState().doc!;
    const id = (name: string) => Object.values(d.people).find((x) => x.name === name)!.id;
    expect(d.faces["1"]).toEqual({ p: id("lena") });
    expect(d.present).toEqual({ "a.jpg": [mo], "c.jpg": [id("lena")], "b.jpg": [id("kai")], "d.png": [id("kai")] });
    await usePeople.getState().revertConversion();
    expect(usePeople.getState().doc!.present).toEqual({ "a.jpg": [mo] });
  });
});

describe("a face marked by hand", () => {
  it("is looked for as a drawing or a photo, as the picture's faces are or else the tagger saw it", async () => {
    const found = [face(9, "d.png", "drawn")];
    vi.mocked(api.facesMark).mockResolvedValueOnce(found);
    expect(await usePeople.getState().mark(item("d.png"), [0.1, 0.1, 0.4, 0.5])).toEqual(found);
    expect(api.facesMark).toHaveBeenLastCalledWith("/vol", item("d.png"), "drawn", [0.1, 0.1, 0.4, 0.5]);
    const { useTags } = await import("../tagsStore");
    // The anime tagger's words on a drawing, an empty list on a photo it passed over; a picture indexed
    // without it (it is optional) isn't known to be either.
    useTags.setState({ data: { version: 1, types: [], tags: {}, auto: { "n.png": [[0, 0.9]], "p.jpg": [] }, indexed: { "n.png": 1, "p.jpg": 1, "q.jpg": 1 }, autoMap: {}, albums: {} }, loaded: true } as never);
    await usePeople.getState().mark(item("n.png"), [0, 0, 1, 1]);
    expect(vi.mocked(api.facesMark).mock.lastCall?.[2]).toBe("drawn");
    await usePeople.getState().mark(item("p.jpg"), [0, 0, 1, 1]);
    expect(vi.mocked(api.facesMark).mock.lastCall?.[2]).toBe("photo");
    await usePeople.getState().mark(item("q.jpg"), [0, 0, 1, 1]);
    expect(vi.mocked(api.facesMark).mock.lastCall?.[2]).toBeNull();
    await usePeople.getState().mark(item("r.jpg"), [0, 0, 1, 1]);
    expect(vi.mocked(api.facesMark).mock.lastCall?.[2]).toBeNull();
  });

  it("is in a picture looked at on its own when it comes up, unless it was as it is", async () => {
    usePeople.setState({ scanned: { "a.jpg": [10, 1] } });
    vi.mocked(api.facesScan).mockClear();
    await usePeople.getState().scanOne(item("a.jpg"));
    expect(api.facesScan).not.toHaveBeenCalled();
    await usePeople.getState().scanOne(item("a.jpg", "image", 20));
    expect(vi.mocked(api.facesScan).mock.lastCall?.[1]).toEqual([{ key: "a.jpg", path: "/vol/a.jpg", size: 20, modified: 1, kind: "photo", raw: false, video: false }]);
    // A video too, said to be one: its frames are looked at.
    await usePeople.getState().scanOne(item("v.mp4", "video"));
    expect(api.facesScan).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.facesScan).mock.lastCall?.[1][0]).toMatchObject({ key: "v.mp4", video: true });
  });
});

describe("a character's facts", () => {
  it("keep where they are from and their tagger name (picked, none, or worked out again), each undoable", () => {
    const rin = usePeople.getState().name([4], "Rin")!;
    usePeople.getState().setFrom(rin, "  Vocaloid ");
    expect(usePeople.getState().doc!.people[rin].from).toBe("Vocaloid");
    usePeople.getState().setTag(rin, "kagamine_rin");
    expect(usePeople.getState().doc!.people[rin].tag).toBe("kagamine_rin");
    usePeople.getState().setTag(rin, null);
    expect(usePeople.getState().doc!.people[rin].tag).toBeNull();
    usePeople.getState().revert();
    expect(usePeople.getState().doc!.people[rin].tag).toBe("kagamine_rin");
    usePeople.getState().setTag(rin, undefined);
    expect("tag" in usePeople.getState().doc!.people[rin]).toBe(false);
    usePeople.getState().setFrom(rin, "");
    expect(usePeople.getState().doc!.people[rin].from).toBeNull();
  });

  it("change kind only while they have no face: a face is a photo's or a drawing's", () => {
    const kai = usePeople.getState().addPresent("a.jpg", "Kai", "person")!;
    usePeople.getState().setKind(kai, "character");
    expect(usePeople.getState().doc!.people[kai].kind).toBe("character");
    const lena = usePeople.getState().name([1], "Lena")!;
    usePeople.getState().setKind(lena, "character");
    expect(usePeople.getState().doc!.people[lena].kind).toBe("person");
  });

  it("from a tag with no face found, are a character when its pictures are drawn ones", async () => {
    be.faces = [];
    await usePeople.getState().load(true);
    be.tags = { version: 1, types: ["people"], tags: { "x.png": ["people/rin"], "y.png": ["people/rin"], "z.jpg": ["people/lena"] }, auto: { "x.png": [], "y.png": [] }, indexed: {}, autoMap: {}, albums: {} };
    const { useTags } = await import("../tagsStore");
    useTags.setState({ data: null, loaded: false } as never);
    await usePeople.getState().convert("people");
    const kinds = Object.fromEntries(Object.values(usePeople.getState().doc!.people).map((x) => [x.name, x.kind]));
    expect(kinds).toEqual({ rin: "character", lena: "person" });
  });
});

describe("looking again after a yes or a no", () => {
  it("is one sort at a time: clicks meanwhile bring one more, with all of them in it", async () => {
    const lena = usePeople.getState().name([1], "Lena")!;
    await vi.waitFor(() => expect(usePeople.getState().sorted).not.toBeNull());
    let release = () => {};
    vi.mocked(api.facesSort).mockImplementationOnce(async (_r, labels) => (be.labels.push(labels), await new Promise<void>((r) => (release = r)), be.sorted));
    const before = vi.mocked(api.facesSort).mock.calls.length;
    usePeople.getState().accept([2], lena);
    await vi.waitFor(() => expect(vi.mocked(api.facesSort).mock.calls.length).toBe(before + 1));
    usePeople.getState().notThem([3], lena);
    usePeople.getState().accept([4], lena);
    release();
    await vi.waitFor(() => expect(vi.mocked(api.facesSort).mock.calls.length).toBe(before + 2));
    await usePeople.getState().sort();
    expect(vi.mocked(api.facesSort).mock.calls.length).toBe(before + 3);
    expect(vi.mocked(api.facesSort).mock.calls[before + 1][1]).toMatchObject({ not: [[3, lena]] });
    expect((vi.mocked(api.facesSort).mock.calls[before + 1][1] as { assigned: unknown[] }).assigned).toHaveLength(3);
  });
});
