/**
 * Scrapbook: covers made of a background, stickers, photos and text, for albums (shaped like an
 * album's pages, 1280:1817) and tags (2:1, a banner). A cover is kept twice: its layout (what is where, to edit it
 * again) in the scrapbook file, and once done as a rendered picture, which is what the album and
 * tag cards show. Pictures it uses (photos, custom stickers, renders) are its own files, so a cover
 * stays whole when the picture it came from moves or goes. People and artists have a banner on
 * their page that stickers are put on as it is shown, kept here as where each sticker is.
 *
 * Boards are scrapbook pages of their own, for nothing in the library: an artist's references, say.
 * Each has a name and a size of its own (changed at will: what is on it keeps its place), notes and
 * arrows besides, and pictures copied onto it or, as the library is set to, pointing at the library's
 * picture (which they follow when it moves).
 */

import type { Tune } from "./subjects";

export type TargetKind = "album" | "tag" | "board";
export type Target = { kind: "album"; key: string; name: string } | { kind: "tag"; id: string; name: string } | { kind: "board"; id: string; name: string };

/** The rendered size of each kind of cover, in pixels (a board's is its own; this is where a new one starts). */
const PAGE: Record<TargetKind, { w: number; h: number }> = {
  album: { w: 900, h: 1278 },
  tag: { w: 1200, h: 600 },
  board: { w: 1920, h: 1080 },
};

/** A page's size: a board's own, else its kind's. */
export const pageOf = (doc: Pick<ScrapDoc, "kind" | "size">): { w: number; h: number } => doc.size ?? PAGE[doc.kind];

/** A board's sides, at most and at least (larger ones would take too much memory to draw and export). */
export const BOARD_MAX = 8000;
export const BOARD_MIN = 300;

/** Sizes a board can take at once. */
export const BOARD_SIZES: { name: string; w: number; h: number }[] = [
  { name: "Wide (16:9)", w: 1920, h: 1080 },
  { name: "Square", w: 1600, h: 1600 },
  { name: "A4 across", w: 2480, h: 1754 },
  { name: "A4 upright", w: 1754, h: 2480 },
  { name: "Banner (2:1)", w: 2400, h: 1200 },
  { name: "Very wide (3:1)", w: 3600, h: 1200 },
  { name: "Large wall (4K)", w: 3840, h: 2160 },
];

/**
 * A board at another size: everything on it keeps its place and its size in pixels, as a canvas grows
 * or shrinks round it, and anything left outside comes back to its edge.
 */
export function resized(doc: ScrapDoc, w: number, h: number): ScrapDoc {
  const W = Math.round(Math.min(BOARD_MAX, Math.max(BOARD_MIN, w)));
  const H = Math.round(Math.min(BOARD_MAX, Math.max(BOARD_MIN, h)));
  const { w: W0, h: H0 } = pageOf(doc);
  if (W === W0 && H === H0) return doc;
  const kx = W0 / W;
  const ky = H0 / H;
  const inside = (v: number) => Math.min(1, Math.max(0, v));
  return {
    ...doc,
    size: { w: W, h: H },
    layers: doc.layers.map((l): Layer => {
      const at = { x: inside(l.x * kx), y: inside(l.y * ky) };
      if (l.type === "text") return { ...l, ...at, size: l.size * ky };
      if (l.type === "arrow") return { ...l, ...at, w: l.w * kx, thickness: (l.thickness * Math.min(W0, H0)) / Math.min(W, H) };
      return { ...l, ...at, w: l.w * kx };
    }),
    bars: doc.bars?.map((b) => ({ ...b, x: inside(b.x * kx), width: (b.width * Math.min(W0, H0)) / Math.min(W, H) })),
  };
}

/** `cork`: a pin board, which pins every photo and note to it. */
export type PatternId = "plain" | "dots" | "grid" | "stripes" | "lined" | "checks" | "tone" | "cork";

export type Background =
  | { kind: "pattern"; pattern: PatternId; color: string; ink: string }
  /** One of the cover's own pictures, filling the page; blurred by `blur` (0..1). */
  | { kind: "photo"; blob: string; blur: number; color: string };

/** Where a layer sits: its centre in fractions of the page, its width a fraction of the page's, turned `rot` degrees. */
export interface Placement {
  x: number;
  y: number;
  w: number;
  rot: number;
}

/** A built-in sticker (by id) or one of the custom ones (its picture's file). */
export type StickerSource = { builtin: string } | { blob: string };

export interface StickerLayer extends Placement {
  id: string;
  type: "sticker";
  src: StickerSource;
  /** "original" (the sticker's own colours), or a theme's look (built-in ones drawn as that theme's line art). */
  look: string;
  /** The sticker's white (or the look's) cut edge, as WhatsApp's stickers have. */
  outline: boolean;
  /** Height over width. */
  aspect: number;
  flip?: boolean;
}

/** What holds a photo or a note up: pins or strips of tape, at one place (a pin in the middle of its top, tape over one top corner), the two top corners, or all four. */
export interface Fix {
  kind: "pin" | "tape";
  where: "one" | "top" | "all";
  /** Their colour; "random", a colour each (as before one could be chosen: pins random, tape the frame's). */
  color?: string;
}

/** Colours for pins' heads, and for washi tape (laid on see-through). */
export const PIN_COLOURS = ["#e5484d", "#3e63dd", "#f5a524", "#30a46c", "#f2f2f2", "#8e4ec6"];
export const TAPE_COLOURS = ["#f4d35e", "#f7a8c4", "#9ad8c0", "#a9c8f5", "#f2efe8", "#c9a7e8"];
export const FIX_PLACES: { id: Fix["where"]; name: string }[] = [
  { id: "one", name: "One" },
  { id: "top", name: "Top corners" },
  { id: "all", name: "All corners" },
];

export interface PhotoLayer extends Placement {
  id: string;
  type: "photo";
  /** Its own copy's file; "" for a picture of the library pointed at (`item`). */
  blob: string;
  /** The library's picture it shows, by key, when pointed at rather than copied (a board's, as set). */
  item?: string;
  aspect: number;
  /** Bare, or on a polaroid's paper ("tape" only in older covers: it is `fix` now, see `migrated`). */
  frame: "none" | "polaroid" | "tape";
  /** Pinned or taped up; null or none, neither. */
  fix?: Fix | null;
  /** A theme's look for its frame (paper, edge, shadow or glow, tape); the classic white without. */
  look?: string;
}

export interface TextLayer extends Placement {
  id: string;
  type: "text";
  text: string;
  /** A font id (fonts.ts). */
  font: string;
  /** Font size as a fraction of the page's height. */
  size: number;
  /** The look (a theme's: colours, outline, glow). */
  look: string;
  /** Its own fill instead of the look's, if set. */
  color?: string;
  align: "left" | "center" | "right";
  /**
   * The font and look it was made in, when it is shown in another: it then takes exactly the room it
   * took there (its size fitted), so a cover keeps its layout in any theme's look.
   */
  box?: { font: string; look: string };
}

/** A note on a board: its text written on a square of paper, wrapped to its width. */
export interface NoteLayer extends Placement {
  id: string;
  type: "note";
  text: string;
  /** The paper's colour. */
  paper: string;
  /** Pinned or taped up; null or none, neither. */
  fix?: Fix | null;
}

/**
 * An arrow on a board: `w` long (a fraction of the page's width) through its centre, turned `rot`,
 * pointing right before it is turned; `thickness` a fraction of the page's shorter side.
 */
export interface ArrowLayer extends Placement {
  id: string;
  type: "arrow";
  color: string;
  thickness: number;
  /** A head at its end, or at both ends. */
  heads: "end" | "both";
}

export type Layer = StickerLayer | PhotoLayer | TextLayer | NoteLayer | ArrowLayer;

/** Papers for notes. */
export const NOTE_PAPERS = ["#fff1a8", "#f7c6d6", "#bfe8d4", "#cfe3ff", "#fbd3b8", "#ffffff"];
/** Colours for arrows. */
export const ARROW_COLOURS = ["#e5484d", "#16151a", "#ffffff", "#3e63dd", "#f5a524", "#30a46c"];

/** How a bar is drawn: a plain band, a lightning bolt, a strip of torn paper, a stitched ribbon, pinking-shear teeth. */
export type BarStyle = "straight" | "lightning" | "torn" | "stitched" | "zigzag";

/**
 * A bar from the top of the page to the bottom, part of the background: it splits it, the part on its
 * right painted `fill` (the background's pattern runs on across). Where it crosses the page's middle
 * (`x`, a fraction of the width), turned `angle` degrees from upright, `width` thick (a fraction of the
 * page's shorter side), in `color`.
 */
export interface Bar {
  id: string;
  x: number;
  angle: number;
  width: number;
  color: string;
  fill: string;
  style: BarStyle;
}

export const BAR_STYLES: { id: BarStyle; name: string }[] = [
  { id: "straight", name: "Straight" },
  { id: "lightning", name: "Lightning" },
  { id: "torn", name: "Torn paper" },
  { id: "stitched", name: "Stitched" },
  { id: "zigzag", name: "Zigzag" },
];

/** Colours for a new part of the background, the first one unlike the part it splits. */
const PART_COLOURS = ["#f7c6d6", "#fff1a8", "#bfe8d4", "#e4dcf7", "#fbd3b8", "#5b8def", "#14213d"];

/** The colour of the part of the background at `x` (across the middle): the fill of the nearest bar on its left, or the background's own. */
export function partColour(doc: ScrapDoc, x: number): string {
  const left = (doc.bars ?? []).filter((b) => b.x <= x).sort((a, b) => b.x - a.x)[0];
  return left ? left.fill : doc.background.color;
}

/** A new bar: white and straight, in the middle of the widest part, its right side a new colour. */
export function newBar(doc: ScrapDoc): Bar {
  const xs = [0, ...(doc.bars ?? []).map((b) => b.x).sort((a, b) => a - b), 1];
  let x = 0.5;
  let widest = -1;
  for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > widest) ((widest = xs[i] - xs[i - 1]), (x = (xs[i] + xs[i - 1]) / 2));
  const here = partColour(doc, x).toLowerCase();
  return { id: newId(), x, angle: 0, width: 0.035, color: "#ffffff", fill: PART_COLOURS.find((c) => c !== here) ?? "#ffffff", style: "straight" };
}

export interface ScrapDoc {
  id: string;
  kind: TargetKind;
  /** A board's name and size (a cover's are its album's or tag's, and its kind's). */
  name?: string;
  size?: { w: number; h: number };
  background: Background;
  /** Bars splitting the background, behind every layer. */
  bars?: Bar[];
  layers: Layer[];
  updated: number;
  /** The rendered picture's file, once done. */
  rendered?: string;
}

/** A sticker cut from a picture. */
export interface CustomSticker {
  id: string;
  blob: string;
  w: number;
  h: number;
  /** The picture it came from, by name. */
  from?: string;
  /** The picture it came from, by key (follows it when it moves). */
  source?: string;
  /** When it was made (ms); older stickers have it in their id. */
  made?: number;
  /**
   * What it was cut from, kept to fine-tune it again: the picture round it and the cut's own mask
   * (files), and the tuning on top. `limited`: only the sticker itself was left to keep (it was made
   * before stickers kept their picture), so nothing outside its cut can be painted back. `solid`: its
   * mask is soft only right at its edge (older ones left what the model was unsure of see-through).
   */
  cut?: { picture: string; mask: string; tune: Tune; limited?: boolean; solid?: boolean };
}

/** When a sticker was made: kept, or read from its id (which starts with the time, in base 36). */
export function madeAt(s: CustomSticker): number | null {
  if (s.made) return s.made;
  const t = parseInt(s.id.slice(0, 8), 36);
  return t > 1.5e12 && t < 4e12 ? t : null;
}

/**
 * A sticker on a person's or an artist's banner. The banner is as wide as the page it is on, with
 * their picture and name at its left: a sticker is placed in pixels, from its left edge (or its
 * right, `right`) and from its middle line, so it stays by what it was put beside however wide the
 * banner is.
 */
export interface BannerSticker {
  id: string;
  src: StickerSource;
  /** Height over width. */
  aspect: number;
  /** "original", or a theme's look. */
  look: string;
  outline: boolean;
  flip?: boolean;
  /** Its middle: how far in from the edge, and below the middle line (above it when negative). */
  x: number;
  y: number;
  right?: boolean;
  w: number;
  rot: number;
}

/** The stickers on a person's or an artist's banner (who keep which is theirs). */
export interface Banner {
  id: string;
  stickers: BannerSticker[];
  updated: number;
}

export interface ScrapLibrary {
  version: 1;
  books: Record<string, ScrapDoc>;
  stickers: CustomSticker[];
  banners: Record<string, Banner>;
}

export const EMPTY_LIBRARY: ScrapLibrary = { version: 1, books: {}, stickers: [], banners: {} };

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Blue with small white dots: where a new cover starts. */
export const DEFAULT_BACKGROUND: Background = { kind: "pattern", pattern: "dots", color: "#5b8def", ink: "#ffffff" };

/** Cork in a wooden frame: every photo and note on it pinned. Where a new board starts. */
export const PIN_BOARD: Background = { kind: "pattern", pattern: "cork", color: "#c49a6c", ink: "#8b6340" };

/** Ready-made backgrounds, by look. */
export const BACKGROUNDS: { name: string; bg: Background }[] = [
  { name: "Blue dots", bg: DEFAULT_BACKGROUND },
  { name: "Pink grid", bg: { kind: "pattern", pattern: "grid", color: "#f7c6d6", ink: "#ffffff" } },
  { name: "Mint stripes", bg: { kind: "pattern", pattern: "stripes", color: "#bfe8d4", ink: "#e9f8f0" } },
  { name: "Lavender lines", bg: { kind: "pattern", pattern: "lined", color: "#e4dcf7", ink: "#b9a8e8" } },
  { name: "Lemon checks", bg: { kind: "pattern", pattern: "checks", color: "#fff1a8", ink: "#ffe36b" } },
  { name: "Kraft paper", bg: { kind: "pattern", pattern: "tone", color: "#c9a77c", ink: "#b8946a" } },
  { name: "Screentone", bg: { kind: "pattern", pattern: "tone", color: "#f4f1ea", ink: "#16151a" } },
  { name: "Neon grid", bg: { kind: "pattern", pattern: "grid", color: "#07080c", ink: "#37ebf3" } },
  { name: "Night dots", bg: { kind: "pattern", pattern: "dots", color: "#14213d", ink: "#fcee0a" } },
  { name: "Peach", bg: { kind: "pattern", pattern: "plain", color: "#fbd3b8", ink: "#ffffff" } },
  { name: "Paper", bg: { kind: "pattern", pattern: "plain", color: "#f4f1ea", ink: "#ffffff" } },
  { name: "Ink", bg: { kind: "pattern", pattern: "plain", color: "#16151a", ink: "#ffffff" } },
  { name: "Pin board", bg: PIN_BOARD },
];

/**
 * A page as kept before pins and tape were what holds a picture up: a photo framed by "tape" is bare
 * and taped at its top corners, and on a pin board every photo and note without a say is pinned at
 * its top (as the board pinned them all before).
 */
export function migrated(doc: ScrapDoc): ScrapDoc {
  const cork = doc.background.kind === "pattern" && doc.background.pattern === "cork";
  let changed = false;
  const layers = doc.layers.map((l): Layer => {
    if (l.type === "photo" && l.frame === "tape") return (changed = true), { ...l, frame: "none", fix: { kind: "tape", where: "top" } };
    if (cork && (l.type === "photo" || l.type === "note") && l.fix === undefined) return (changed = true), { ...l, fix: { kind: "pin", where: "one" } };
    return l;
  });
  return changed ? { ...doc, layers } : doc;
}

/** The blob names a cover uses (its photos, custom stickers, background), to keep them while it does. */
export function blobsOf(doc: ScrapDoc): string[] {
  const out: string[] = [];
  if (doc.background.kind === "photo") out.push(doc.background.blob);
  for (const l of doc.layers) {
    if (l.type === "photo" && l.blob) out.push(l.blob);
    if (l.type === "sticker" && "blob" in l.src) out.push(l.src.blob);
  }
  if (doc.rendered) out.push(doc.rendered);
  return out;
}

/** The custom stickers' pictures a banner uses. */
export const blobsOfBanner = (b: Banner): string[] => b.stickers.flatMap((s) => ("blob" in s.src ? [s.src.blob] : []));
