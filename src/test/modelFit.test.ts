import { describe, expect, it } from "vitest";
import { advise, fitOn, translatorNeed } from "../lib/modelFit";
import type { EngineModel } from "../plugins/types";
import type { Hardware } from "../lib/types";

// The engine's catalogue as it is (engine/src/models.rs): the files' sizes, added up.
const model = (id: string, kind: EngineModel["kind"], name: string, size: number): EngineModel => ({ id, kind, name, note: "", size, downloaded: false });
const catalog = [
  model("base", "base", "Text finder and clean-up", 551 + 161_292_684 + 204_332_996 + 6_502_901),
  model("manga-ocr", "reader", "Japanese", 77_546 + 462_959_024 + 228 + 24_072),
  model("hayai-ocr", "reader", "Korean, Chinese and others", 342 + 622_502_784 + 1_247_253),
  model("qwen3.5-4b", "translator", "Qwen 3.5 4B", 2_912_109_728 + 672_423_616),
  model("gemma4-e4b-it", "translator", "Gemma 4 E4B", 4_215_695_776 + 990_372_672),
  model("gemma4-12b-it", "translator", "Gemma 4 12B", 6_716_356_800 + 175_115_840),
];
const translators = catalog.filter((m) => m.kind === "translator");
const [qwen, e4b, g12] = translators;
const GB = 1024 ** 3;
const mac = (gb: number, chip: string): Hardware => ({ memory: gb * GB, chip, os: "macos", arch: "aarch64", unified: true });

describe("what a language model needs", () => {
  it("adds the model, the shared parts, the larger reader and its working room, in memory as one buys it", () => {
    const need = (m: EngineModel) => {
      const n = translatorNeed(m, catalog);
      return { gb: Number((n.bytes / GB).toFixed(1)), least: n.least, comfortable: n.comfortable, card: n.card };
    };
    expect(need(qwen)).toEqual({ gb: 5.1, least: 8, comfortable: 16, card: 6 });
    expect(need(e4b)).toEqual({ gb: 6.6, least: 16, comfortable: 16, card: 8 });
    expect(need(g12)).toEqual({ gb: 8.1, least: 16, comfortable: 24, card: 10 });
  });

  it("says how each fits a Mac whose graphics share its memory", () => {
    const fit = (m: EngineModel, hw: Hardware) => fitOn(translatorNeed(m, catalog), hw);
    expect([qwen, e4b, g12].map((m) => fit(m, mac(8, "Apple M1")))).toEqual(["tight", "too big", "too big"]);
    expect([qwen, e4b, g12].map((m) => fit(m, mac(16, "Apple M2")))).toEqual(["good", "good", "tight"]);
    expect([qwen, e4b, g12].map((m) => fit(m, mac(32, "Apple M1 Pro")))).toEqual(["good", "good", "good"]);
    // A separate graphics card's memory can't be seen from here.
    expect(fit(qwen, { memory: 32 * GB, chip: "AMD Ryzen 7", os: "windows", arch: "x86_64", unified: false })).toBeNull();
  });
});

describe("the language model that suits this computer", () => {
  const pick = (hw: Hardware) => advise(translators, catalog, hw)!;

  it("is the largest that fits with room to spare", () => {
    expect(pick(mac(32, "Apple M1 Pro"))).toEqual({ id: "gemma4-12b-it", why: "Gemma 4 12B suits this Mac best: it takes about 8.1 GB of its 32 GB while translating, leaving room for everything else." });
    expect(pick(mac(24, "Apple M2 Pro")).id).toBe("gemma4-12b-it");
    expect(pick(mac(16, "Apple M2")).id).toBe("gemma4-e4b-it");
    // 18 GB: Gemma 4 12B only just doesn't leave room enough.
    expect(pick(mac(18, "Apple M3 Pro")).id).toBe("gemma4-e4b-it");
  });

  it("isn't the largest on a first-tier chip, whose graphics would make each page slow", () => {
    expect(pick(mac(24, "Apple M2"))).toEqual({ id: "gemma4-e4b-it", why: "Gemma 4 E4B suits this Mac best: Gemma 4 12B fits too, but this chip's graphics would make each page slow." });
  });

  it("with little memory, the one that fits at all, or the smallest", () => {
    expect(pick(mac(8, "Apple M1"))).toEqual({ id: "qwen3.5-4b", why: "Qwen 3.5 4B is the one that fits in 8 GB: close other apps while translating, or pages will be slow." });
    expect(pick(mac(4, "Apple M1")).why).toBe("None of these fits well in 4 GB; Qwen 3.5 4B may work with everything else closed, slowly.");
  });

  it("with a separate graphics card: the safe one, saying which card the others want", () => {
    expect(pick({ memory: 32 * GB, chip: "AMD Ryzen 7 7800X3D", os: "windows", arch: "x86_64", unified: false })).toEqual({
      id: "qwen3.5-4b",
      why: "Qwen 3.5 4B is the safe choice: the language model runs on a graphics card that has room for it, else on the processor, much slower. Which card this computer has can't be seen from here: Gemma 4 E4B wants 8 GB, Gemma 4 12B wants 10 GB of graphics memory.",
    });
  });
});
