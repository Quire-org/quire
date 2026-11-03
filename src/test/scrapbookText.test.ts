import { describe, expect, it } from "vitest";
import { drawPage, AssetCache } from "../scrapbook/render";
import type { ScrapDoc, TextLayer } from "../scrapbook/model";

// A canvas that writes down what is drawn on it. Fonts measure their capitals at a share of their
// size of their own (Rajdhani's short, Nunito's tall), as real ones do.
type Call = { op: string; args: unknown[]; font: string; fill: unknown; blur: number; canvas: number };
const log: Call[] = [];
let canvases = 0;
const CAPS: Record<string, number> = { Rajdhani: 0.6, Nunito: 0.72, "Chakra Petch": 0.68 };
function recorder(id: number): CanvasRenderingContext2D {
  const state: Record<string | symbol, unknown> = { font: "10px sans-serif", fillStyle: "#000", shadowBlur: 0 };
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "measureText")
        return (s: string) => {
          const f = String(t.font);
          const px = Number(/(\d+)px/.exec(f)?.[1] ?? 10);
          const family = Object.keys(CAPS).find((name) => f.includes(name));
          return { width: s.length * px * 0.55, actualBoundingBoxAscent: px * (family ? CAPS[family] : 0.7) };
        };
      if (k === "getTransform") return () => ({ a: 1, b: 0 });
      return (...args: unknown[]) => void log.push({ op: String(k), args, font: String(t.font), fill: t.fillStyle, blur: Number(t.shadowBlur), canvas: id });
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}
HTMLCanvasElement.prototype.getContext = function () {
  return recorder(++canvases);
} as never;

const text = (look: string, font: string, more: Partial<TextLayer> = {}): TextLayer => ({ id: `t-${look}`, type: "text", text: "Sea", font, size: 0.1, look, align: "center", x: 0.5, y: 0.5, w: 0, rot: 0, ...more });
const page = (layers: TextLayer[]): ScrapDoc => ({ id: "p", kind: "tag", background: { kind: "pattern", pattern: "plain", color: "#fff", ink: "#fff" }, layers, updated: 0 });
const draw = (layers: TextLayer[]) => {
  log.length = 0;
  const main = recorder(0);
  drawPage(main, page(layers), 1200, 600, new AssetCache(async () => ""));
  return log.slice();
};
const pxOf = (font: string) => Number(/(\d+)px/.exec(font)![1]);
const capOf = (font: string) => pxOf(font) * CAPS[Object.keys(CAPS).find((n) => font.includes(n))!];

describe("lettering on a cover", () => {
  it("has capitals equally tall in every font, centred on the line where the text is", () => {
    // Cozy (Nunito) and Ghost (Rajdhani), at the same size: 10% of the page's height, 42 px capitals.
    const cozy = draw([text("cozy", "nunito")]).filter((c) => c.op === "fillText" && c.canvas === 0);
    const ghost = draw([text("ghost", "rajdhani")]).filter((c) => c.op === "fillText" && c.canvas === 0);
    expect(capOf(cozy[0].font)).toBeCloseTo(42, -0.5);
    expect(capOf(ghost[0].font)).toBeCloseTo(42, -0.5);
    // The baseline half the capitals below the middle: the capitals sit on the middle, not above it.
    for (const c of [...cozy, ...ghost]) expect(c.args[2]).toBeCloseTo(capOf(c.font) / 2, 0);
  });

  it("keeps its capitals' height when seen in another look, narrowed only if it would be wider", () => {
    const made = text("ghost", "nunito", { box: { font: "rajdhani", look: "ghost" } });
    const fill = draw([made]).find((c) => c.op === "fillText" && c.canvas === 0)!;
    expect(capOf(fill.font)).toBeCloseTo(42, -0.5);
    // Much wider than its room: smaller.
    const wide = text("ghost", "nunito", { text: "Sea and sand and sun", box: { font: "bangers", look: "manga" } });
    const narrowed = draw([wide]).find((c) => c.op === "fillText" && c.canvas === 0)!;
    expect(capOf(narrowed.font)).toBeLessThanOrEqual(42.5);
  });

  it("in Night City's look: split in cyan and red, outlined, scanlined, a slice knocked sideways, hardly any glow", () => {
    const calls = draw([text("cp2077", "chakra-italic", { id: "nc" })]);
    const apart = calls.filter((c) => c.canvas !== 0);
    const fills = apart.filter((c) => c.op === "fillText").map((c) => c.fill);
    expect(fills).toEqual(expect.arrayContaining(["#37ebf3", "#ff003c", "#fcee0a"]));
    // The copies to either side of the letters.
    const xs = (colour: string) => apart.find((c) => c.op === "fillText" && c.fill === colour)!.args[1] as number;
    expect(xs("#37ebf3")).toBeLessThan(xs("#fcee0a"));
    expect(xs("#ff003c")).toBeGreaterThan(xs("#fcee0a"));
    expect(apart.some((c) => c.op === "strokeText")).toBe(true);
    expect(apart.filter((c) => c.op === "fillRect").length).toBeGreaterThan(5);
    expect(apart.find((c) => c.op === "fillText")!.font).toMatch(/^italic 700 \d+px "Chakra Petch"/);
    // Laid down in strips, one at least shifted.
    const strips = calls.filter((c) => c.op === "drawImage" && c.canvas === 0);
    expect(strips.length).toBeGreaterThanOrEqual(3);
    expect(new Set(strips.map((c) => Math.round(c.args[5] as number))).size).toBeGreaterThan(1);
    const px = pxOf(apart.find((c) => c.op === "fillText")!.font);
    for (const s of strips) expect(s.blur).toBeLessThanOrEqual(px * 0.15);
    // The same glitch every time it is drawn.
    const again = draw([text("cp2077", "chakra-italic", { id: "nc" })]).filter((c) => c.op === "drawImage" && c.canvas === 0);
    expect(again.map((c) => c.args)).toEqual(strips.map((c) => c.args));
  });
});
