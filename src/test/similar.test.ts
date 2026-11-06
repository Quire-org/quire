import { describe, expect, it } from "vitest";
import { LOOKS_FLOOR, rankSimilar, type Signal } from "../lib/similar";
import { addable, SERIES_LOOKS } from "../lib/series";

const ALL: Signal[] = ["looks", "tags", "artist", "people"];
const on = (...ids: Signal[]) => new Set(ids.length ? ids : ALL);
const none = { looks: new Map<string, number>(), tags: {}, artistItems: {}, peopleKeys: new Map<string, Set<string>>() };

describe("Show similar", () => {
  it("ranks by how alike they look, a cosine at the floor or below being no likeness, and leaves the seed out", () => {
    const looks = new Map([
      ["b", 0.9],
      ["c", 0.7],
      ["d", LOOKS_FLOOR],
    ]);
    expect(rankSimilar("a", ["a", "b", "c", "d", "e"], { ...none, looks }, on())).toEqual(["b", "c"]);
  });

  it("counts a rare tag shared for more than a common one, and a common one alone not at all", () => {
    // "common" is on nearly every picture, "rare" on the seed and one other.
    const tags: Record<string, string[]> = { a: ["common", "rare"], b: ["common"], c: ["rare"], d: ["common"], e: ["common"], f: ["common"] };
    expect(rankSimilar("a", Object.keys(tags), { ...none, tags }, on())).toEqual(["c"]);
  });

  it("counts the same artist and the same people", () => {
    const artistItems = { a: ["x"], b: ["x"], c: ["y"] };
    const peopleKeys = new Map([
      ["p", new Set(["a", "c"])],
      ["q", new Set(["a", "d"])],
    ]);
    expect(rankSimilar("a", ["a", "b", "c", "d"], { ...none, artistItems }, on())).toEqual(["b"]);
    expect(rankSimilar("a", ["a", "b", "c", "d"], { ...none, peopleKeys }, on()).sort()).toEqual(["c", "d"]);
  });

  it("leaves out what is switched off", () => {
    const d = { ...none, looks: new Map([["b", 0.95]]), artistItems: { a: ["x"], c: ["x"] } };
    expect(rankSimilar("a", ["a", "b", "c"], d, on())).toEqual(["b", "c"]);
    expect(rankSimilar("a", ["a", "b", "c"], d, on("artist"))).toEqual(["c"]);
    expect(rankSimilar("a", ["a", "b", "c"], d, on("looks", "tags", "people"))).toEqual(["b"]);
  });
});

describe("what might be added to a series", () => {
  const base = { looks: new Map<string, number>(), alike: new Set<string>(), artistItems: {}, modified: new Map<string, number>() };

  it("is what looks like one of it (stricter than Show similar), the closest first, a look-alike as Sort finds them first of all", () => {
    const looks = new Map([
      ["c", 0.95],
      ["d", SERIES_LOOKS],
      ["e", 0.8],
    ]);
    expect(addable(["a", "b"], ["a", "b", "c", "d", "e", "f"], { ...base, looks, alike: new Set(["f"]) }, () => false)).toEqual(["f", "c", "e"]);
  });

  it("raises one by its artist or made near it in time, and leaves out what is skipped", () => {
    const looks = new Map([
      ["c", 0.85],
      ["d", 0.85],
      ["e", 0.85],
    ]);
    const modified = new Map([
      ["a", 0],
      ["c", 400 * 86_400_000],
      ["d", 60_000],
      ["e", 400 * 86_400_000],
    ]);
    const got = addable(["a"], ["a", "c", "d", "e"], { ...base, looks, modified, artistItems: { a: ["x"], c: ["x"] } }, (k) => k === "e");
    expect(got).toEqual(["c", "d"]);
  });

  it("with nothing to tell looks by, is its artist's pictures and the ones made within a day", () => {
    const modified = new Map([
      ["a", 0],
      ["c", 3_600_000],
      ["d", 30 * 86_400_000],
      ["e", 30 * 86_400_000],
    ]);
    expect(addable(["a"], ["a", "c", "d", "e"], { ...base, modified, artistItems: { a: ["x"], e: ["x"] } }, () => false).sort()).toEqual(["c", "e"]);
  });
});
