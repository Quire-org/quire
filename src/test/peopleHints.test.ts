import { describe, expect, it, vi } from "vitest";
import type { FaceView, TagData } from "../lib/types";

vi.mock("../lib/api", () => ({ api: {}, fileSrc: (p: string) => p, mediaUrl: () => "", thumbUrl: () => "", canThumb: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { taggerHints, characterTagOf, nameMatches, seriesOfTag } = await import("../peopleStore");
const { useTags } = await import("../tagsStore");

const face = (id: number, key: string): FaceView => ({ id, key, kind: "drawn", bbox: [0, 0, 1, 1], score: 0.9, size: 100 });
// The tagger's names: 0 and 1 characters, 2 a general tag.
const names = [
  { name: "pepper_(peppercarrot)", category: 4 },
  { name: "shichimi_(peppercarrot)", category: 4 },
  { name: "witch_hat", category: 0 },
];

describe("the tagger's word on drawn faces, beside likeness", () => {
  it("vouches for the characters it names in a face's picture, and when sure rules out the ones it doesn't see", async () => {
    useTags.setState({
      names,
      data: { auto: { "a.png": [[0, 0.9]], "b.png": [[0, 0.6], [2, 0.9]], "c.png": [[1, 0.95]], "d.png": [[2, 0.9]] } } as unknown as TagData,
    });
    const doc = {
      version: 1,
      people: {
        pep: { id: "pep", name: "Pepper", kind: "character", from: null, portrait: null, added: 0 },
        shi: { id: "shi", name: "Shichimi (Peppercarrot)", kind: "character", from: null, portrait: null, added: 0 },
      },
      faces: { 1: { p: "pep", ok: true } },
      no: [],
      not: {},
      exclude: [],
    } as never;
    const hints = await taggerHints(doc, [face(1, "a.png"), face(2, "b.png"), face(3, "c.png"), face(4, "d.png")]);
    // Pepper is known by what the tagger saw on her face; Shichimi by her name written its way.
    expect(hints.named).toEqual([
      [2, ["pep"]],
      [3, ["shi"]],
    ]);
    // Sure it's Shichimi in c.png: not Pepper. Unsure in b.png and d.png: nothing ruled out.
    expect(hints.ruledOut).toEqual([[3, ["pep"]]]);

    // A picture its platform tagged with a character: as sure as can be, though the tagger saw no one.
    const { useStore } = await import("../store");
    useStore.setState({ library: { sources: { "d.png": { platform: "example", id: "9", url: "", title: "", author: { id: "", name: "" }, tags: [{ name: "shichimi_(peppercarrot)", translated: null, kind: "character" }, { name: "pepper_(peppercarrot)", translated: null }], date: null, adult: false, added: 0 } } } } as never);
    const sourced = await taggerHints(doc, [face(1, "a.png"), face(2, "b.png"), face(3, "c.png"), face(4, "d.png")]);
    expect(sourced.named).toContainEqual([4, ["shi"]]);
    // Only a character tag counts: an untyped one with a character's name doesn't.
    expect(sourced.named.filter(([f]) => f === 4)).toEqual([[4, ["shi"]]]);
    expect(sourced.ruledOut).toContainEqual([4, ["pep"]]);
  });
});

describe("a character's tagger name", () => {
  const char = (more = {}) => ({ id: "c", name: "Pepper", kind: "character" as const, from: null, portrait: null, added: 0, ...more });
  const auto = { "a.png": [[1, 0.9]], "b.png": [[1, 0.8]], "c.png": [[0, 0.9]] } as Record<string, [number, number][]>;

  it("is the one seen in at least half their pictures, else their name as the tagger writes it, else none", () => {
    expect(characterTagOf(char(), ["a.png", "b.png", "c.png"], auto, names)).toEqual({ i: 1, how: "seen", seen: 2, of: 3 });
    expect(characterTagOf(char({ name: "Pepper (Peppercarrot)" }), ["c.png", "x.png", "y.png"], auto, names)).toMatchObject({ i: 0, how: "name" });
    expect(characterTagOf(char({ name: "Carrot" }), [], auto, names)).toBeNull();
    expect(characterTagOf({ ...char(), kind: "person" }, ["a.png"], auto, names)).toBeNull();
  });

  it("picked, is theirs whatever their pictures say; said none, there is none; and the matching goes by it", async () => {
    expect(characterTagOf(char({ tag: "pepper_(peppercarrot)" }), ["a.png", "b.png"], auto, names)).toEqual({ i: 0, how: "picked", seen: 0, of: 2 });
    expect(characterTagOf(char({ tag: null }), ["a.png", "b.png"], auto, names)).toBeNull();
    useTags.setState({ names, data: { auto } as unknown as TagData });
    const doc = { version: 1, people: { c: char({ tag: "pepper_(peppercarrot)" }) }, faces: { 1: { p: "c", ok: true } }, no: [], not: {}, exclude: [] } as never;
    const hints = await taggerHints(doc, [face(1, "a.png"), face(3, "c.png")]);
    expect(hints.named).toEqual([[3, ["c"]]]);
    const none = await taggerHints({ ...(doc as object), people: { c: char({ tag: null }) } } as never, [face(1, "a.png"), face(3, "c.png")]);
    expect(none.named).toEqual([]);
  });
});

describe("names suggested while typing one", () => {
  it("fit by any word of the name, closest first, with more faces first between as close, faces or none", () => {
    const p = (id: string, name: string) => ({ id, name, kind: "character" as const, from: null, portrait: null, added: 0 });
    const people = [p("1", "Hatsune Miku"), p("2", "Mikuru Asahina"), p("3", "Miku"), p("4", "Kamiku"), p("5", "Rin")];
    const faces: Record<string, number> = { "1": 40, "2": 3 };
    expect(nameMatches(people, "miku", (id) => faces[id] ?? 0).map((x) => x.id)).toEqual(["3", "2", "1", "4"]);
    // A character added with no faces yet comes up as well as any.
    expect(nameMatches(people, "r", () => 0).map((x) => x.id)).toEqual(["5", "2"]);
  });
});

describe("the series in a character tag", () => {
  it("is what its brackets say, when it has them", () => {
    expect(seriesOfTag("pepper_(peppercarrot)")).toBe("Peppercarrot");
    expect(seriesOfTag("rem_(re:zero)")).toBe("Re:Zero");
    expect(seriesOfTag("hatsune_miku")).toBeNull();
  });
});
