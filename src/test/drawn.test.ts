import { describe, expect, it, vi } from "vitest";

// Each word's vector stands for its place in the lists (7 for drawings, then 6 for photos); the
// picture's scores against them are what tagsScores answers.
const embedded: string[] = [];
const row = vi.hoisted(() => ({ scores: [] as number[] }));
vi.mock("../lib/api", () => ({
  api: {
    tagsEmbedText: async (_root: string, text: string) => (embedded.push(text), [embedded.length]),
    tagsScores: async (_root: string, keys: string[], vectors: number[][]) => (expect(vectors).toHaveLength(13), keys.map(() => row.scores)),
  },
}));
vi.mock("../tagsStore", () => ({ useTags: { getState: () => ({ models: { embedder: "siglip2" } }) } }));

const { drawnScore, DRAWN_MIN } = await import("../lib/drawn");

describe("a picture's drawn score, as the engine works it out", () => {
  it("is the best drawing word's score less the best photo word's, scaled as SigLIP's logits", async () => {
    // Best drawing word 0.12, best photo word 0.09: drawn.
    row.scores = [0.05, 0.12, 0.1, 0, 0, 0, 0, 0.09, 0.02, 0, 0, 0, 0];
    expect(await drawnScore("/vol", "a.png")).toBeCloseTo(112.90118 * 0.03, 3);
    // A photo: its photo words win.
    row.scores = [0.02, 0.01, 0, 0, 0, 0, 0, 0.11, 0.05, 0, 0, 0, 0];
    const photo = (await drawnScore("/vol", "b.jpg"))!;
    expect(photo).toBeLessThan(DRAWN_MIN);
    // The words are made once for a library and its matcher.
    expect(embedded).toHaveLength(13);
    expect(embedded.slice(0, 2)).toEqual(["an anime illustration", "a manga page"]);
  });

  it("uses the engine's own words, scale and threshold (engine/src/tagging.rs and main.rs)", async () => {
    const { readFileSync } = await import("node:fs");
    const tagging = readFileSync("engine/src/tagging.rs", "utf8");
    const list = (name: string) => [...(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(tagging)?.[1] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    expect([...list("DRAWN"), ...list("PHOTO")]).toEqual(embedded);
    expect(tagging).toMatch(/pub const SIGLIP_SCALE: f32 = 112\.901_18;/);
    expect(readFileSync("engine/src/main.rs", "utf8")).toMatch(new RegExp(`const DRAWN_MIN: f32 = ${DRAWN_MIN}\\.0;`));
  });

  it("is nothing for a picture the tag index hasn't looked at", async () => {
    const api = (await import("../lib/api")).api as unknown as { tagsScores: unknown };
    const was = api.tagsScores;
    api.tagsScores = async () => [null];
    try {
      expect(await drawnScore("/vol", "new.png")).toBeNull();
    } finally {
      api.tagsScores = was;
    }
  });
});
