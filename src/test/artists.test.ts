import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemSource } from "../lib/types";

const saved = vi.hoisted(() => ({ docs: [] as unknown[], deleted: [] as string[], hashes: {} as Record<string, unknown> }));

vi.mock("../lib/api", () => ({
  api: {
    artistsLoad: vi.fn(async () => null),
    artistsSave: vi.fn(async (_root: string, doc: unknown) => void saved.docs.push(doc)),
    scrapbookBlobDelete: vi.fn(async (_root: string, name: string) => void saved.deleted.push(name)),
    saveLibrary: vi.fn(async () => {}),
    findImageHash: vi.fn(async (_plugin: string, url: string) => saved.hashes[url] ?? null),
    findStateLoad: vi.fn(async () => null),
    findStateSave: vi.fn(async () => {}),
  },
  fileSrc: (p: string) => "file://" + p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { suggestionsFor, countsOf, linkedArtist, sameArtists, useArtists, PACE } = await import("../artistsStore");
PACE.list = 0;
PACE.fetch = 0;
const { useStore } = await import("../store");
// Taken in by the store later (a source's platform tags): loaded now, so that never comes after the test is done.
await import("../tagsStore");

const src = (authorId: string, name: string): ItemSource => ({ platform: "example", id: "w" + authorId, url: "", title: "", author: { id: authorId, name, account: name.toLowerCase() }, tags: [], date: null, adult: false, added: 0 });

beforeEach(async () => {
  saved.docs.length = 0;
  saved.deleted.length = 0;
  useStore.setState({ root: "/vol" } as never);
  useArtists.setState({ doc: null, docRoot: null, open: null, busy: {} });
  await useArtists.getState().load();
});


describe("artists suggested by what came in from Find", () => {
  it("groups pictures by their account, leaving out ones with an artist, gone, or turned down", () => {
    const sources = { "a/1.png": src("7", "Kaze"), "a/2.png": src("7", "Kaze"), "b/3.png": src("8", "Mori"), "gone.png": src("8", "Mori"), "c/4.png": src("9", "Nori") };
    const doc = { version: 1 as const, artists: {}, items: { "b/3.png": ["x"] }, dismissed: ["example:9"] };
    const s = suggestionsFor(doc, sources, new Set(["a/1.png", "a/2.png", "b/3.png", "c/4.png"]));
    expect(s.map((g) => [g.key, g.name, g.items])).toEqual([["example:7", "Kaze", ["a/1.png", "a/2.png"]]]);
    expect(s[0].artist).toBeNull();
  });

  it("points a suggestion at the artist linked to that account already", () => {
    const a = useArtists.getState();
    const id = a.create("Kaze Studio", { platform: "example", id: "7", account: "kaze", url: null })!;
    const doc = useArtists.getState().doc!;
    expect(linkedArtist(doc, "example", "7")?.id).toBe(id);
    expect(suggestionsFor(doc, { "a/1.png": src("7", "Kaze") }, null)[0].artist?.name).toBe("Kaze Studio");
  });

  it("gives the pictures to the artist when accepted, and makes one when there is none", async () => {
    const a = useArtists.getState();
    const [s] = suggestionsFor(useArtists.getState().doc!, { "a/1.png": src("7", "Kaze"), "a/2.png": src("7", "Kaze") }, null);
    // No platform plugin here: making the artist works, filling them in from the platform waits.
    const id = await a.accept(s);
    const doc = useArtists.getState().doc!;
    expect(doc.artists[id!]).toMatchObject({ name: "Kaze", renamed: false, links: [{ platform: "example", id: "7", account: "kaze" }] });
    expect(countsOf(doc)[id!]).toBe(2);
    expect(suggestionsFor(doc, { "a/1.png": src("7", "Kaze") }, null)).toEqual([]);
  });

  it("suggests a maker known on another platform than the work's as theirs there, linked by their page", async () => {
    const pinned = (n: string): ItemSource => ({ ...src("", ""), platform: "pinboard-site", id: "p" + n, author: { id: "inkpot", name: "Inkpot", account: "Inkpot", platform: "sketchsite", url: "https://sketch.example.net/Inkpot" } });
    const [s] = suggestionsFor(useArtists.getState().doc!, { "r/1.png": pinned("1"), "r/2.png": pinned("2") }, null);
    expect(s).toMatchObject({ key: "sketchsite:inkpot", platform: "sketchsite", authorId: "inkpot", url: "https://sketch.example.net/Inkpot", items: ["r/1.png", "r/2.png"] });
    // No plugin offers that platform: the artist is made and linked, with nothing to fill in from.
    const id = await useArtists.getState().accept(s);
    expect(useArtists.getState().doc!.artists[id!].links).toEqual([{ platform: "sketchsite", id: "inkpot", account: "Inkpot", url: "https://sketch.example.net/Inkpot" }]);
  });

  it("can link an account to one of the library's artists instead: their pictures theirs, filled in only with what they lack", async () => {
    const { useFinders, finder } = await import("../plugins/find");
    useFinders.setState({ finders: { "other-find": { pluginId: "other-find", name: "Other", platform: "other", imageHeaders: {}, sections: [] } } } as never);
    const prof = vi.spyOn(finder, "artist").mockResolvedValue({ id: "kd", name: "kaze_draws", account: "kaze_draws", avatar: null, followed: false, works: 3, url: "https://other.example.net/kd", recent: [], bio: "Draws the sea.", region: "Somewhere", links: [{ label: "Site", url: "https://kaze.example.com/" }, { label: "Old", url: "https://www.old.example.org/kaze" }] });
    const a = useArtists.getState();
    const kaze = a.create("Kaze", { platform: "example", id: "7", account: "kaze", url: null })!;
    useArtists.setState({ doc: { ...useArtists.getState().doc!, artists: { ...useArtists.getState().doc!.artists, [kaze]: { ...useArtists.getState().doc!.artists[kaze], region: "Here", pages: [{ label: "Old", url: "https://old.example.org/kaze/" }] } } } });
    const s = { ...suggestionsFor(useArtists.getState().doc!, { "b/1.png": { ...src("kd", "kaze_draws"), platform: "other" } }, null)[0] };
    expect(await a.accept(s, kaze)).toBe(kaze);
    const doc = useArtists.getState().doc!;
    expect(Object.keys(doc.artists)).toEqual([kaze]);
    expect(doc.items["b/1.png"]).toEqual([kaze]);
    expect(doc.artists[kaze]).toMatchObject({ name: "Kaze", bio: "Draws the sea.", region: "Here" });
    expect(doc.artists[kaze].links.map((l) => [l.platform, l.id])).toEqual([["example", "7"], ["other", "kd"]]);
    // Their pages: theirs, and the other platform's they hadn't (the same address, written another way, once).
    expect(doc.artists[kaze].pages.map((p) => p.url)).toEqual(["https://old.example.org/kaze/", "https://kaze.example.com/"]);
    // An account another artist has already isn't theirs too.
    const other = a.create("Someone else")!;
    await expect(useArtists.getState().linkTo(other, { platform: "other", id: "kd", account: "kaze_draws", url: null })).rejects.toThrow(/Kaze's already/);
    prof.mockRestore();
  });
});

describe("an artist's pictures", () => {
  it("follow their files when they move, and go when the trash is emptied", () => {
    const a = useArtists.getState();
    const id = a.create("Kaze")!;
    a.assign(["Inbox/1.png", "Inbox/2.png", "_deleted/3.png"], id);
    a.follow((k) => (k.startsWith("Inbox/") ? "Private/2026/" + k.slice(6) : null));
    a.forget((k) => k.startsWith("_deleted/"));
    expect(Object.keys(useArtists.getState().doc!.items).sort()).toEqual(["Private/2026/1.png", "Private/2026/2.png"]);
  });

  it("merge into the artist they're the same as, links and all, and a removed artist's icon goes", () => {
    const a = useArtists.getState();
    const one = a.create("Kaze", { platform: "example", id: "7", account: "kaze", url: null })!;
    const two = a.create("Kaze Studio")!;
    a.assign(["1.png"], one);
    a.assign(["1.png", "2.png"], two);
    useArtists.setState({ doc: { ...useArtists.getState().doc!, artists: { ...useArtists.getState().doc!.artists, [one]: { ...useArtists.getState().doc!.artists[one], avatar: `artist-${one}.jpg` } } } });
    a.merge(one, two);
    const doc = useArtists.getState().doc!;
    expect(Object.keys(doc.artists)).toEqual([two]);
    expect(doc.artists[two].links).toEqual([{ platform: "example", id: "7", account: "kaze", url: null }]);
    expect(doc.items).toEqual({ "1.png": [two], "2.png": [two] });
    expect(saved.deleted).toEqual([`artist-${one}.jpg`]);
  });

  it("met on two platforms, are suggested as one by a page in common, joined with their pages, or said not to be", () => {
    const a = useArtists.getState();
    const here = a.create("Kaze", { platform: "example", id: "7", account: "kaze", url: "https://www.example.org/users/7" })!;
    const there = a.create("kaze_draws", { platform: "other", id: "kaze_draws", account: "kaze_draws", url: "https://other.example.net/artists/kaze_draws" })!;
    const stranger = a.create("Someone", { platform: "other", id: "someone", account: "someone", url: "https://other.example.net/artists/someone" })!;
    const withPages = (id: string, pages: { label: string; url: string }[]) =>
      useArtists.setState({ doc: { ...useArtists.getState().doc!, artists: { ...useArtists.getState().doc!.artists, [id]: { ...useArtists.getState().doc!.artists[id], pages } } } });
    // Their page on the second platform lists the first one's account (written another way); a front page proves nothing.
    withPages(there, [{ label: "Example", url: "http://example.org/Users/7/" }, { label: "Website", url: "https://kaze.example.com/" }]);
    withPages(stranger, [{ label: "Website", url: "https://www.example.org/" }]);
    expect(sameArtists(useArtists.getState().doc, there).map((x) => [x.artist.id, x.via])).toEqual([[here, "example.org/users/7"]]);
    expect(sameArtists(useArtists.getState().doc, here).map((x) => x.artist.id)).toEqual([there]);
    expect(sameArtists(useArtists.getState().doc, stranger)).toEqual([]);
    a.notSame(here, there);
    expect(sameArtists(useArtists.getState().doc, there)).toEqual([]);
    a.merge(there, here);
    const joined = useArtists.getState().doc!.artists[here];
    expect(joined.links.map((l) => l.platform)).toEqual(["example", "other"]);
    expect(joined.pages.map((p) => p.url)).toEqual(["http://example.org/Users/7/", "https://kaze.example.com/"]);
  });

  it("are given and taken back for a whole selection", () => {
    const a = useArtists.getState();
    const id = a.create("Mori")!;
    a.assign(["1.png", "2.png"], id);
    a.unassign(["1.png"], id);
    expect(useArtists.getState().doc!.items).toEqual({ "2.png": [id] });
    expect(a.create("   ")).toBeNull();
  });
});

describe("one artist a picture", () => {
  it("gives a picture to an artist in place of the one it had", () => {
    const a = useArtists.getState();
    const kaze = a.create("Kaze")!;
    const mori = useArtists.getState().create("Mori")!;
    useArtists.getState().assign(["a.png", "b.png"], kaze);
    useArtists.getState().assign(["a.png"], mori);
    expect(useArtists.getState().doc!.items).toEqual({ "a.png": [mori], "b.png": [kaze] });
  });
});

describe("an artist's works looked for in the library", () => {
  const off = (hex: string, n: number) => (BigInt("0x" + hex) ^ ((1n << BigInt(n)) - 1n)).toString(16).padStart(16, "0");
  const h = (phash: string, dhash = "0f0f0f0f0f0f0f0f") => ({ phash, quads: [phash, phash, phash, phash], dhash, width: 1200, height: 1700 });
  const [A, B, C] = ["9c3a5f0e71b2d846", "1e6b0c95f2a7d348", "c5d1e8f0a3b6297e"];
  const it_ = (key: string, albumKey?: string) => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: key, dir: "", size: 1, modified: 1, hasRaw: false, hasVideo: false, ...(albumKey ? { albumKey } : {}) });
  const work = (id: string) => ({ id, title: `Work ${id}`, author: { id: "7", name: "Kaze", account: "kaze" }, url: `https://example.org/works/${id}`, thumb: `t${id}`, width: 1200, height: 1700, pages: 1, kind: "image", tags: [], date: null, adult: false, ai: false, likes: 0, views: 0 });

  it("finds the ones in the library (an album's page: the album), remembers what it looked at, and yes or no", async () => {
    const { useFinders, finder } = await import("../plugins/find");
    const { useDupes } = await import("../dupesStore");
    useFinders.setState({ finders: { "example-find": { pluginId: "example-find", name: "Example", platform: "example", artistOptions: [{ value: "drawings", label: "Drawings" }, { value: "comics", label: "Comics" }], imageHeaders: {}, sections: [] } } } as never);
    const pages: Record<string, { items: unknown[]; next: string | null }> = { "drawings:": { items: [work("1"), work("2")], next: "p2" }, "drawings:p2": { items: [work("3")], next: null }, "comics:": { items: [], next: null } };
    const list = vi.spyOn(finder, "list").mockImplementation((async (_p: string, q: { option?: string; cursor?: string }) => pages[`${q.option}:${q.cursor ?? ""}`]) as never);
    useStore.setState({ allItems: [it_("a.png"), it_("Albums/x/1.png", "Albums/x"), it_("c.png")], loadAll: async () => {}, library: { version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, sources: {} } } as never);
    useDupes.setState({ cacheRoot: "/vol", cache: { "a.png": { size: 1, modified: 1, image: h(A) }, "Albums/x/1.png": { size: 1, modified: 1, image: h(B) }, "c.png": { size: 1, modified: 1, image: h(C) } } } as never);
    // Work 1 is a.png; work 2 the album's page with a part painted again; work 3 nothing here.
    saved.hashes = { t1: h(off(A, 1)), t2: h(off(B, 8), off("0f0f0f0f0f0f0f0f", 7)), t3: h(off(C, 30), "f0f0f0f0f0f0f0f0") };
    const a = useArtists.getState();
    const id = a.create("Kaze", { platform: "example", id: "7", account: "kaze", url: null })!;
    await useArtists.getState().lookForWorks([id]);
    const d = useArtists.getState().doc!;
    expect(d.found!.map((f) => [f.key, f.item, f.work, f.score >= 0.8])).toEqual([
      ["a.png", "a.png", "1", true],
      ["album:Albums/x", "Albums/x/1.png", "2", false],
    ]);
    expect(d.looked![id].works.sort()).toEqual(["1", "2", "3"]);
    // Looked again: no work fetched again (their fingerprints are kept).
    const { api } = await import("../lib/api");
    const fetched = vi.mocked(api.findImageHash).mock.calls.length;
    await useArtists.getState().lookForWorks([id]);
    expect(vi.mocked(api.findImageHash).mock.calls.length).toBe(fetched);
    // Yes to the sure one: theirs, and noted as from that work; no to the other: never again.
    useArtists.getState().acceptFound(d.found!.filter((f) => f.score >= 0.8));
    expect(useArtists.getState().doc!.items["a.png"]).toEqual([id]);
    expect(useStore.getState().library!.sources!["a.png"]).toMatchObject({ platform: "example", id: "1" });
    useArtists.getState().rejectFound(useArtists.getState().doc!.found!);
    await useArtists.getState().lookForWorks([id]);
    expect(useArtists.getState().doc!.found).toEqual([]);
    // A picture added since: found from the work's kept fingerprint, with nothing fetched.
    useStore.setState({ allItems: [...useStore.getState().allItems, it_("New/d.png")] } as never);
    useDupes.setState({ cache: { ...useDupes.getState().cache, "New/d.png": { size: 1, modified: 1, image: h(off(C, 29), "f0f0f0f0f0f0f0f0") } } } as never);
    await useArtists.getState().lookForWorks([id]);
    expect(useArtists.getState().doc!.found!.map((f) => [f.key, f.work])).toEqual([["New/d.png", "3"]]);
    expect(vi.mocked(api.findImageHash).mock.calls.length).toBe(fetched);
    list.mockRestore();
  });

  it("suggests an album several of their works look like (one work in three languages) once, the likeliest standing for them", async () => {
    const { useFinders, finder } = await import("../plugins/find");
    const { useDupes } = await import("../dupesStore");
    useFinders.setState({ finders: { "example-find": { pluginId: "example-find", name: "Example", platform: "example", artistOptions: [], imageHeaders: {}, sections: [] } } } as never);
    const list = vi.spyOn(finder, "list").mockResolvedValue({ items: [work("ja"), work("en"), work("zh")], next: null } as never);
    useStore.setState({ allItems: [it_("Albums/y/1.png", "Albums/y")], loadAll: async () => {}, library: { version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, sources: {} } } as never);
    useDupes.setState({ cacheRoot: "/vol", cache: { "Albums/y/1.png": { size: 1, modified: 1, image: h(A) } } } as never);
    // The original's cover exactly; the translations' with their titles lettered over (a little off).
    saved.hashes = { tja: h(A), ten: h(off(A, 3)), tzh: h(off(A, 4)) };
    const toast = vi.spyOn(useStore.getState(), "toast");
    const id = useArtists.getState().create("Tori", { platform: "example", id: "8", account: "tori", url: null })!;
    await useArtists.getState().lookForWorks([id]);
    const found = useArtists.getState().doc!.found!.filter((f) => f.artist === id);
    expect(found.map((f) => [f.key, f.work, f.matches])).toEqual([["album:Albums/y", "ja", 3]]);
    expect(toast.mock.calls[toast.mock.calls.length - 1]?.[0]).toMatch(/3 of their works looked for: 1 picture or album of yours to check/);
    // Yes to it: the album theirs, nothing left to say yes to.
    useArtists.getState().acceptFound(found);
    expect(useArtists.getState().doc!.items["album:Albums/y"]).toEqual([id]);
    expect(useArtists.getState().doc!.found!.filter((f) => f.artist === id)).toEqual([]);
    // Looked again, it says so rather than finding it again.
    await useArtists.getState().lookForWorks([id]);
    expect(toast.mock.calls[toast.mock.calls.length - 1]?.[0]).toMatch(/1 already theirs/);
    list.mockRestore();
  });
});

