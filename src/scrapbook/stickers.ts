import list from "../assets/stickers/stickers.json";

/**
 * The built-in stickers: a selection of Microsoft's Fluent Emoji (MIT, src/assets/stickers/LICENSE),
 * each as its 3D picture (the original look) and its single-colour line art (drawn in a theme's look).
 */
export interface BuiltinSticker {
  id: string;
  name: string;
  category: string;
  full: string;
  line: string;
}

const full = import.meta.glob("../assets/stickers/3d/*.png", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const line = import.meta.glob("../assets/stickers/line/*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

export const STICKERS: BuiltinSticker[] = (list as { id: string; name: string; category: string }[])
  .map((s) => ({ ...s, full: full[`../assets/stickers/3d/${s.id}.png`], line: line[`../assets/stickers/line/${s.id}.svg`] }))
  .filter((s) => s.full && s.line);

export const CATEGORIES: { id: string; name: string }[] = [
  { id: "love", name: "Love" },
  { id: "sky", name: "Sky" },
  { id: "nature", name: "Nature" },
  { id: "animals", name: "Animals" },
  { id: "food", name: "Food" },
  { id: "party", name: "Party" },
  { id: "faces", name: "Faces" },
  { id: "symbols", name: "Symbols" },
];

const byId = new Map(STICKERS.map((s) => [s.id, s]));
export const builtin = (id: string) => byId.get(id);
