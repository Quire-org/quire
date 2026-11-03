import type { Background, Layer, ScrapDoc } from "./model";

/**
 * The looks of text and stickers: one per theme, so a cover can be made in any theme's style (and,
 * one day, follow the theme in use). A look sets the lettering (font, fill, outline, glow) and how
 * a built-in sticker is drawn in it: its line art in the look's ink, with the look's edge and glow.
 * "original" keeps a sticker's own colours.
 */

export interface Font {
  id: string;
  name: string;
  family: string;
  weight: number;
  italic?: boolean;
}

/** Every font a text can use: each theme's, and a few for scrapbooking. */
export const FONTS: Font[] = [
  { id: "rajdhani", name: "Rajdhani", family: '"Rajdhani", sans-serif', weight: 700 },
  { id: "orbitron", name: "Orbitron", family: '"Orbitron", sans-serif', weight: 700 },
  { id: "chakra", name: "Chakra Petch", family: '"Chakra Petch", sans-serif', weight: 700 },
  { id: "chakra-italic", name: "Chakra Petch Italic", family: '"Chakra Petch", sans-serif', weight: 700, italic: true },
  { id: "nunito", name: "Nunito", family: '"Nunito", sans-serif', weight: 800 },
  { id: "quicksand", name: "Quicksand", family: '"Quicksand", sans-serif', weight: 700 },
  { id: "manrope", name: "Manrope", family: '"Manrope", sans-serif', weight: 600 },
  { id: "mono", name: "Share Tech Mono", family: '"Share Tech Mono", monospace', weight: 400 },
  { id: "bangers", name: "Bangers", family: '"Bangers", cursive', weight: 400 },
  { id: "caveat", name: "Caveat", family: '"Caveat", cursive', weight: 700 },
  { id: "pacifico", name: "Pacifico", family: '"Pacifico", cursive', weight: 400 },
  { id: "marker", name: "Permanent Marker", family: '"Permanent Marker", cursive', weight: 400 },
];

export const fontById = (id: string) => FONTS.find((f) => f.id === id) ?? FONTS[0];

/** How a photo's frame looks in a theme: its paper, edge, and a soft shadow, a hard ink one, or a glow. */
export interface FrameStyle {
  paper: string;
  edge?: string;
  /** The edge's width, a share of the photo's width. */
  edgeWidth?: number;
  shadow: "soft" | "hard" | "glow";
  /** The hard shadow's or the glow's colour. */
  tint?: string;
  tape: string;
}

/** The classic frame: white paper, a soft shadow, yellow tape. */
export const CLASSIC_FRAME: FrameStyle = { paper: "#fdfcf8", shadow: "soft", tape: "rgba(255, 236, 160, 0.75)" };

export interface Look {
  id: string;
  name: string;
  /** The font a new text in this look starts with. */
  font: string;
  fill: string;
  /** The letters' outline, as a share of the font size (0: none). */
  stroke: string;
  strokeWidth: number;
  /** A glow behind the letters (neon), or a hard drop shadow (ink), or neither. */
  glow?: string;
  shadow?: { color: string; x: number; y: number };
  /** Glitched lettering (Night City's): a copy in each colour split to either side, scanlines, a slice knocked sideways. */
  glitch?: { left: string; right: string };
  upper?: boolean;
  /** Letter spacing in em. */
  spacing?: number;
  /** A built-in sticker's line art in this look: its ink, its cut edge, and a glow. */
  ink: string;
  edge: string;
  stickerGlow?: string;
  /** The page behind everything in this look (a photo background stays a photo). */
  background: Background;
  frame: FrameStyle;
}

export const LOOKS: Look[] = [
  {
    id: "cp2077", name: "Night City", font: "chakra-italic", fill: "#fcee0a", stroke: "#07080c", strokeWidth: 0.035, glow: "#37ebf340", glitch: { left: "#37ebf3", right: "#ff003c" }, upper: true, spacing: 0.05, ink: "#fcee0a", edge: "#07080c", stickerGlow: "#37ebf3",
    background: { kind: "pattern", pattern: "grid", color: "#08090e", ink: "#1f6f78" },
    frame: { paper: "#0a0a06", edge: "#fcee0a", edgeWidth: 0.012, shadow: "glow", tint: "#37ebf3", tape: "rgba(55, 235, 243, 0.65)" },
  },
  {
    id: "midnight", name: "Midnight", font: "orbitron", fill: "#e6ecf7", stroke: "#070b14", strokeWidth: 0.06, glow: "#7cc4ff", upper: true, spacing: 0.06, ink: "#7cc4ff", edge: "#070b14", stickerGlow: "#7cc4ff",
    background: { kind: "pattern", pattern: "dots", color: "#0b1426", ink: "#2a4a78" },
    frame: { paper: "#0c1528", edge: "#7cc4ff", edgeWidth: 0.008, shadow: "glow", tint: "#7cc4ff", tape: "rgba(124, 196, 255, 0.55)" },
  },
  {
    id: "manga", name: "Manga", font: "bangers", fill: "#16151a", stroke: "#fffdf8", strokeWidth: 0.16, shadow: { color: "#16151a", x: 0.06, y: 0.06 }, upper: true, spacing: 0.03, ink: "#16151a", edge: "#fffdf8",
    background: { kind: "pattern", pattern: "tone", color: "#f4f1ea", ink: "#16151a" },
    frame: { paper: "#fffdf8", edge: "#16151a", edgeWidth: 0.018, shadow: "hard", tint: "#16151a", tape: "rgba(232, 87, 124, 0.7)" },
  },
  {
    id: "cozy", name: "Cozy", font: "nunito", fill: "#4a4037", stroke: "#fff8f0", strokeWidth: 0.12, ink: "#d89a93", edge: "#fff8f0",
    background: { kind: "pattern", pattern: "dots", color: "#f3ece3", ink: "#e6cfc9" },
    frame: { paper: "#fff8f0", shadow: "soft", tape: "rgba(216, 154, 147, 0.7)" },
  },
  {
    id: "sunset", name: "Sunset", font: "quicksand", fill: "#a9607e", stroke: "#fff4ec", strokeWidth: 0.12, shadow: { color: "rgba(240,153,107,0.6)", x: 0, y: 0.05 }, ink: "#f0996b", edge: "#fff4ec",
    background: { kind: "pattern", pattern: "stripes", color: "#fbd9c4", ink: "#fce6d6" },
    frame: { paper: "#fff4ec", shadow: "soft", tape: "rgba(240, 153, 107, 0.7)" },
  },
  {
    id: "gallery", name: "Gallery", font: "manrope", fill: "#1a1a1a", stroke: "#ffffff", strokeWidth: 0, ink: "#1a1a1a", edge: "#ffffff",
    background: { kind: "pattern", pattern: "plain", color: "#ffffff", ink: "#ffffff" },
    frame: { paper: "#ffffff", edge: "#1a1a1a", edgeWidth: 0.004, shadow: "soft", tape: "rgba(0, 0, 0, 0.12)" },
  },
  {
    id: "ghost", name: "Ghost", font: "rajdhani", fill: "#f0f0f0", stroke: "#0e0e0e", strokeWidth: 0.08, ink: "#f0f0f0", edge: "#0e0e0e",
    background: { kind: "pattern", pattern: "grid", color: "#111111", ink: "#262626" },
    frame: { paper: "#1c1c1c", edge: "#3a3a3a", edgeWidth: 0.006, shadow: "soft", tape: "rgba(255, 255, 255, 0.18)" },
  },
];

export const ORIGINAL = "original";

/**
 * A cover as it would be in one theme's look: every text in its lettering (font and colours, the
 * same room), every sticker in its style (built-in ones as its line art), every photo in its frame,
 * and its background.
 */
export function withLook(doc: ScrapDoc, look: string): ScrapDoc {
  const l = lookById(look);
  return {
    ...doc,
    // A photo background stays: it is the cover's own picture.
    background: doc.background.kind === "photo" ? doc.background : l.background,
    layers: doc.layers.map((layer): Layer => {
      // Text keeps the room it took in the font and look it was made in (its size fitted to it).
      if (layer.type === "text") return { ...layer, look, font: l.font, color: undefined, box: layer.box ?? { font: layer.font, look: layer.look } };
      return { ...layer, look };
    }),
  };
}

export const lookById = (id: string) => LOOKS.find((l) => l.id === id) ?? LOOKS[0];

/** The look of the theme in use, for new text and stickers. */
export function currentLook(): Look {
  const theme = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  return LOOKS.find((l) => l.id === theme) ?? LOOKS[0];
}

/** The CSS font of a text at `px` pixels. */
export const fontCss = (fontId: string, px: number) => {
  const f = fontById(fontId);
  return `${f.italic ? "italic " : ""}${f.weight} ${Math.max(1, Math.round(px))}px ${f.family}`;
};
