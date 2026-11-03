import { describe, expect, it } from "vitest";
import { SENSITIVITY, findGroups, versionOf, type DupeEntry, type H64 } from "../lib/dupes";
import type { MediaItem } from "../lib/types";

// Hashes at known distances: each picture has its own high word (16 bits from every other one), and
// a version of it differs in its low word by as many bits as asked.
const bits = (k: number) => (k >= 32 ? 0xffffffff : (2 ** k - 1) >>> 0);
const h = (hi: number, k: number): H64 => [hi >>> 0, bits(k)];
const entry = (key: string, hi: number, d: number, quads: number[]): DupeEntry => {
  const dir = key.slice(0, key.lastIndexOf("/"));
  const name = key.slice(key.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return { item: { key, name, dir, kind: "image", size: 1, modified: 0, primary: `/vol/${key}`, files: [`/vol/${key}`], hasRaw: false, hasVideo: false } as MediaItem, image: { phash: h(hi, d), quads: quads.map((q) => h(hi, q)), dhash: [0, 0], width: 100, height: 100 } };
};
const P1 = 0;
const P2 = 0x0f0f0f0f;
const P3 = 0x33333333;
const STRANGER = 0x55555555;

const entries = [
  // A page and the plugin's cleaned copy beside it: too different to match by look.
  entry("ch1/012.jpg", P1, 0, [0, 0, 0, 0]),
  entry("ch1/Cleaned 012.png", P1, 25, [10, 10, 10, 10]),
  // A cleaned copy moved elsewhere, and another copy of its page: three quarters
  // within 5 (normal takes 4), the whole at 14.
  entry("p2/page.jpg", P2, 0, [0, 0, 0, 0]),
  entry("moved/Cleaned page.png", P2, 14, [5, 5, 5, 20]),
  // A page cleaned in place (known by its key) and another copy: the whole at 11 (normal takes 10).
  entry("p3/005.jpg", P3, 0, [0, 0, 0, 0]),
  entry("p3/005b.png", P3, 11, [9, 9, 9, 9]),
  entry("x/stranger.jpg", STRANGER, 0, [0, 0, 0, 0]),
];
const keys = (groups: ReturnType<typeof findGroups>) => groups.map((g) => g.members.map((m) => m.item.key).sort()).sort((a, b) => a[0].localeCompare(b[0]));
const cleaned = { prefix: "Cleaned ", keys: ["p3/005b.png"], note: "cleaned" };

describe("versions a plugin made, in the duplicate check", () => {
  it("are left apart while the check is off", () => {
    expect(findGroups(entries, SENSITIVITY.normal)).toEqual([]);
  });

  it("are matched with their pictures while it is on: beside it by name, elsewhere more loosely, and never with strangers", () => {
    const groups = findGroups(entries, { ...SENSITIVITY.normal, versions: [cleaned] });
    expect(keys(groups)).toEqual([
      ["ch1/012.jpg", "ch1/Cleaned 012.png"],
      ["moved/Cleaned page.png", "p2/page.jpg"],
      ["p3/005.jpg", "p3/005b.png"],
    ]);
    const notes = (key: string) => groups.flatMap((g) => g.members).find((m) => m.item.key === key)!.notes;
    expect(notes("ch1/Cleaned 012.png")).toContain("cleaned version of 012");
    expect(notes("moved/Cleaned page.png")[0]).toMatch(/as a version, 3 of 4 quarters alike, d=14/);
    expect(notes("p3/005b.png")[0]).toMatch(/as a version, d=11/);
  });

  it("knows a version by its name or its key, for the badge", () => {
    expect(versionOf({ key: "a/Cleaned 3.png", name: "Cleaned 3" }, [cleaned])?.note).toBe("cleaned");
    expect(versionOf({ key: "p3/005b.png", name: "005b" }, [cleaned])?.note).toBe("cleaned");
    expect(versionOf({ key: "a/3.png", name: "3" }, [cleaned])).toBeUndefined();
    expect(versionOf({ key: "a/Cleaned .png", name: "Cleaned " }, [cleaned])).toBeUndefined();
  });
});
