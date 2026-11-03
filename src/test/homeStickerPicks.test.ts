import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({ api: new Proxy({}, { get: () => async () => null }), fileSrc: (p: string) => p, mediaUrl: () => "", thumbUrl: () => "", canThumb: () => false, setCurrentRoot: () => {}, storedPath: (_r: string, p: string) => p }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));

const { picksFor, seedOf } = await import("../home/stickers");
const { pick } = await import("../home/board");
type Sticker = Parameters<typeof picksFor>[0][number];

// The Home's stickers: random ones (and picked ones) over the same few built-in stickers.
const art = (id: string) => ({ src: { builtin: id }, aspect: 1 });
const pool = ["cat", "star", "heart", "leaf"].map(art);
const random = (id: string, repeats?: boolean): Sticker => ({ id, random: repeats ? { repeats } : {}, aspect: 1, look: "original", outline: false, x: 0.5, y: 1, w: 0.1, rot: 0 });
const picked = (id: string, src: string): Sticker => ({ id, src: { builtin: src }, aspect: 1, look: "original", outline: false, x: 0.5, y: 1, w: 0.1, rot: 0 });
const shown = (stickers: Sticker[], visit: number, pools = new Map(stickers.filter((s) => s.random).map((s) => [s.id, pool]))) =>
  stickers.map((s) => {
    const a = picksFor(stickers, pools, visit).get(s.id);
    return a && "builtin" in a.src ? a.src.builtin : null;
  });

describe("random stickers on the Home", () => {
  it("never show what another sticker shows, picked or random, on any visit", () => {
    for (let visit = 0; visit < 200; visit++) {
      const list = [picked("p", "star"), random("a"), random("b"), random("c")];
      const got = shown(list, visit);
      expect(new Set(got).size, `visit ${visit}: ${got}`).toBe(4);
      expect(got[0]).toBe("star");
    }
  });

  it("keep the pick they'd have had when it clashes with nothing", () => {
    const a = random("a");
    for (let visit = 0; visit < 50; visit++) expect(shown([a], visit)[0]).toBe(pick(pool, 1, seedOf(a, visit))[0].src.builtin);
  });

  it("may repeat when allowed to, or when every sticker of theirs is shown already", () => {
    // Allowed: across visits, one that may repeat shows what another does at least once.
    let same = 0;
    for (let visit = 0; visit < 200; visit++) {
      const got = shown([random("a"), random("b", true)], visit);
      if (got[0] === got[1]) same++;
    }
    expect(same).toBeGreaterThan(0);
    // Five stickers, four to pick from: the fifth repeats rather than shows nothing.
    const got = shown([random("a"), random("b"), random("c"), random("d"), random("e")], 7);
    expect(got.every(Boolean)).toBe(true);
    expect(new Set(got.slice(0, 4)).size).toBe(4);
  });

  it("show nothing with nothing to pick from", () => {
    expect(shown([random("a")], 1, new Map([["a", []]]))).toEqual([null]);
  });
});
