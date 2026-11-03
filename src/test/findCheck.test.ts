import { describe, expect, it } from "vitest";
import { findInLibrary, likeness, LIKE_MATCH, sigOf, SURE_MATCH } from "../lib/findCheck";
import type { ImageHashResult, ItemSource, MediaItem } from "../lib/types";

const item = (key: string, kind: MediaItem["kind"] = "image"): MediaItem => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind, name: key.split("/").pop()!.replace(/\.[^.]+$/, ""), dir: key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "", size: 100, modified: 1, hasRaw: false, hasVideo: false });
const hash = (phash: string, quads = [phash, phash, phash, phash]): ImageHashResult => ({ phash, quads, dhash: "0000000000000000", width: 10, height: 10 }) as ImageHashResult;
const cached = (h: ImageHashResult) => ({ size: 100, modified: 1, image: h });
const source: ItemSource = { platform: "example", id: "12345678", url: "", title: "", author: { id: "7", name: "A" }, tags: [], date: null, adult: false, added: 0 };

describe("do I have this?", () => {
  const items = [item("Private/a.png"), item("Downloads/12345678_1.png"), item("Archive/IMG_12345678.jpg"), item("Archive/123456789_1.png"), item("Albums/x/b.png"), item("Clips/c.mp4", "video"), item("Loose/d.png")];

  it("finds it by what Find kept, by the picture, and by its id in a name, in that order", () => {
    const work = hash("ffff0000ffff0000");
    const r = findInLibrary({ platform: "example", id: "12345678" }, [work], items, { "Albums/x/b.png": source }, {
      "Private/a.png": cached(hash("ffff0000ffff0001")), // two bits off: the same picture
      "Loose/d.png": cached(hash("0000ffff0000ffff")), // another picture
    });
    expect(r.matches.map((m) => [m.item.key, m.why])).toEqual([
      ["Albums/x/b.png", "imported"],
      ["Private/a.png", "picture"],
      ["Downloads/12345678_1.png", "name"],
      ["Archive/IMG_12345678.jpg", "name"],
    ]);
    expect(r.pictures).toBe(6);
    expect(r.fingerprinted).toBe(2);
  });

  it("matches a picture changed in one corner by its quarters", () => {
    const q = "ffff0000ffff0000";
    const work = hash("0f0f0f0f0f0f0f0f", [q, q, q, "0000000000000000"]);
    const lib = hash("f0f0f0f0f0f0f0f0", [q, q, q, "ffffffffffffffff"]);
    expect(findInLibrary({ platform: "example", id: "1" }, [work], [items[0]], {}, { "Private/a.png": cached(lib) }).matches).toHaveLength(1);
  });

  it("ignores fingerprints of a file that changed since, and short ids in names", () => {
    const r = findInLibrary({ platform: "example", id: "1234" }, [hash("ffff0000ffff0000")], [item("x/1234.png")], {}, { "x/1234.png": { size: 999, modified: 1, image: hash("ffff0000ffff0000") } });
    expect(r.matches).toEqual([]);
    expect(r.fingerprinted).toBe(0);
  });
});

describe("how alike two pictures are", () => {
  // Bits flipped from the start of a hash, to make one n bits away.
  const off = (hex: string, n: number) => (BigInt("0x" + hex) ^ ((1n << BigInt(n)) - 1n)).toString(16).padStart(16, "0");
  const base = "9c3a5f0e71b2d846";
  const sig = (phash: string, dhash = "0f0f0f0f0f0f0f0f", quads = [base, base, base, base], width = 1200, height = 1700) => sigOf({ phash, quads, dhash, width, height });

  it("is sure of the same picture resized and saved again", () => {
    expect(likeness(sig(base), sig(off(base, 2), off("0f0f0f0f0f0f0f0f", 1)))).toBeGreaterThanOrEqual(SURE_MATCH);
  });

  it("finds a picture with a big part painted again, less sure", () => {
    // As measured at worst: the whole 8 bits off, dHash 7.
    const s = likeness(sig(base), sig(off(base, 8), off("0f0f0f0f0f0f0f0f", 7)));
    expect(s).toBeGreaterThanOrEqual(LIKE_MATCH);
    expect(s).toBeLessThan(SURE_MATCH);
  });

  it("finds it by its quarters when the part changed a lot", () => {
    const changed = (n: number) => sig(off(base, 18), "f0f0f0f0f0f0f0f0", [base, base, ...[off(base, 30), off(base, 30)].slice(0, 2 - (n - 2)), ...Array(n - 2).fill(base)].slice(0, 4));
    expect(likeness(sig(base), changed(2))).toBe(LIKE_MATCH);
    expect(likeness(sig(base), sig(off(base, 40), "f0f0f0f0f0f0f0f0", [base, base, base, off(base, 30)]))).toBeGreaterThan(LIKE_MATCH);
  });

  it("isn't another picture, or one of another shape", () => {
    expect(likeness(sig(base), sig(off(base, 16), off("0f0f0f0f0f0f0f0f", 16), [off(base, 24), off(base, 26), off(base, 30), off(base, 32)]))).toBe(0);
    expect(likeness(sig(base), sig(base, undefined, undefined, 1700, 1200))).toBe(0);
  });
});
