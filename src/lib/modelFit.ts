import type { EngineModel } from "../plugins/types";
import type { Hardware } from "./types";

/**
 * How much a language model needs, and which suits this computer. Worked out from the sizes the
 * engine reports, not from a list here, so a model changed there is weighed right here too.
 *
 * Translating holds the language model (its weights and the part that looks at the page), the shared
 * text finder and clean-up, a text reader, and its working room: the context (sized to the page's
 * text, so small) and the page's picture. The engine puts the whole model on the graphics.
 */

const GB = 1024 ** 3;
/** The context, the page's picture and the work in between, on top of the files. */
const WORKING = 0.8 * GB;
/** Of memory shared with the graphics (Apple silicon), what macOS lets the graphics use, about. */
const GRAPHICS_SHARE = 0.7;
/** Comfortable: the model takes at most this part, the rest left to macOS and other apps. */
const COMFORT = 0.45;
/** Memory as computers come with it, to say a need the way one buys it. */
const SIZES = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128];
/** Graphics cards' memory, likewise. */
const CARDS = [4, 6, 8, 10, 12, 16, 20, 24, 32, 48];

export interface Need {
  /** Bytes in use while translating a page. */
  bytes: number;
  /** Memory (GB) it runs in at all, on a computer whose graphics share it, with other apps closed. */
  least: number;
  /** Memory (GB) it runs in with room to spare. */
  comfortable: number;
  /** Graphics memory (GB) for it on a computer with a separate graphics card. */
  card: number;
}

export type Fit = "good" | "tight" | "too big";

/** A language model's need, from its files and the other parts translating takes. */
export function translatorNeed(m: EngineModel, catalog: EngineModel[]): Need {
  const base = catalog.find((x) => x.kind === "base")?.size ?? 0;
  const reader = Math.max(0, ...catalog.filter((x) => x.kind === "reader").map((x) => x.size ?? 0));
  const own = (m.size ?? 0) + WORKING;
  const bytes = own + base + reader;
  const gb = bytes / GB;
  const sized = (share: number) => SIZES.find((s) => s * share >= gb) ?? SIZES[SIZES.length - 1];
  return { bytes, least: sized(GRAPHICS_SHARE), comfortable: sized(COMFORT), card: CARDS.find((c) => c >= (own / GB) * 1.2) ?? CARDS[CARDS.length - 1] };
}

/** How a model fits this computer; null where the graphics' own memory can't be known here. */
export function fitOn(need: Need, hw: Hardware): Fit | null {
  if (!hw.unified) return null;
  const memory = hw.memory / GB;
  return need.bytes / GB <= memory * COMFORT ? "good" : need.bytes / GB <= memory * GRAPHICS_SHARE ? "tight" : "too big";
}

/** A chip of a line's first tier (M1, M2…): its graphics are a fraction of a Pro's or a Max's. */
const firstTier = (chip: string) => /^Apple M\d+$/.test(chip.trim());

export interface Advice {
  id: string;
  why: string;
}

/**
 * The language model that suits this computer best. Shared memory: the largest that fits with room
 * to spare (on a first-tier chip not the largest: it would make each page slow), else the smallest
 * that fits at all. A separate graphics card can't be seen from here: the smallest, saying which
 * card the others want.
 */
export function advise(models: EngineModel[], catalog: EngineModel[], hw: Hardware): Advice | null {
  const list = models.filter((m) => m.size != null).sort((a, b) => a.size! - b.size!);
  if (!list.length) return null;
  const memory = Math.round(hw.memory / GB);
  const gb = (m: EngineModel) => (translatorNeed(m, catalog).bytes / GB).toFixed(1);
  if (!hw.unified) {
    const bigger = list.slice(1).map((m) => `${m.name} wants ${translatorNeed(m, catalog).card} GB`);
    return { id: list[0].id, why: `${list[0].name} is the safe choice: the language model runs on a graphics card that has room for it, else on the processor, much slower. Which card this computer has can't be seen from here${bigger.length ? `: ${bigger.join(", ")} of graphics memory` : ""}.` };
  }
  const good = list.filter((m) => fitOn(translatorNeed(m, catalog), hw) === "good");
  if (good.length) {
    const largest = good[good.length - 1];
    if (firstTier(hw.chip) && good.length > 1 && largest === list[list.length - 1]) {
      const pick = good[good.length - 2];
      return { id: pick.id, why: `${pick.name} suits this Mac best: ${largest.name} fits too, but this chip's graphics would make each page slow.` };
    }
    return { id: largest.id, why: `${largest.name} suits this Mac best: it takes about ${gb(largest)} GB of its ${memory} GB while translating, leaving room for everything else.` };
  }
  const tight = list.find((m) => fitOn(translatorNeed(m, catalog), hw) === "tight");
  if (tight) return { id: tight.id, why: `${tight.name} is the one that fits in ${memory} GB: close other apps while translating, or pages will be slow.` };
  return { id: list[0].id, why: `None of these fits well in ${memory} GB; ${list[0].name} may work with everything else closed, slowly.` };
}
