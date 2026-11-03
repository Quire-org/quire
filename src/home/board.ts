import type { PictureFilter } from "../components/PictureFilters";
import type { StickerSource } from "../scrapbook/model";

/**
 * The Home's board: blocks on a grid of twelve columns, each a window onto the library with its
 * action a key away, placed and sized by the reader. Kept with the library (see store.ts). Pure:
 * the kinds of block, the presets to start from, and where blocks go when one moves, grows or comes.
 */

export type BlockType =
  | "sort"
  | "import"
  | "who"
  | "faces"
  | "dupes"
  | "series"
  | "findnew"
  | "artists"
  | "basket"
  | "shared"
  | "reading"
  | "viewed"
  | "newest"
  | "last"
  | "jumpin"
  | "onthisday"
  | "random"
  | "favourites"
  | "source"
  | "unseen"
  | "slideshow"
  | "picture"
  | "scrapbook"
  | "activity"
  | "drive"
  | "backup"
  | "shortcuts"
  | "theme";

/**
 * Which pictures a block shows: Browse's filters (tags, people, artists, rating, folders, type,
 * where, words), or one album's pages (`album`, its key; otherwise album pages are left out, as in
 * Browse).
 */
export type BlockFilter = Partial<PictureFilter> & { album?: string };

/** How a block chose its pictures before it had filters: one tag, person, artist, album or folder. */
type OldSource = { kind: "everything" | "tag" | "person" | "artist" | "album" | "folder"; id?: string };

export interface Block {
  id: string;
  type: BlockType;
  /** In grid cells: column and row of its top left, and how many of each it spans. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its own name for it, in place of the kind's. */
  title?: string;
  filter?: BlockFilter;
  /** One picture: the one pinned (its key); else one a day from the source. */
  pinned?: string;
  /** Shortcuts: the screens on it. */
  screens?: string[];
  /** Jump in: the saved searches on it (their ids). */
  searches?: string[];
  /** From extensions: the shared panel it shows. */
  panel?: string;
  /** Its name not shown: the block is all content. */
  bare?: boolean;
  /** Its pictures in a mosaic (each its own shape), where the block is big enough; else a grid. */
  layout?: "mosaic";
}

/** Which folders the Home's pictures may come from: all, all but these, or only these. */
export interface FolderFilter {
  mode: "all" | "hide" | "only";
  list: string[];
}

/**
 * A sticker on the Home, anywhere over the board: one picked (`src`), or a random one (`random`),
 * a new one each time the Home opens, from built-in categories and/or the reader's own cut-outs
 * (those cut from pictures its filter lets through). A random one is never the same as another
 * sticker on the Home (picked or random) while there are others to pick, unless `repeats`.
 */
export interface HomeSticker {
  id: string;
  src?: StickerSource;
  random?: { categories?: string[]; filter?: BlockFilter; repeats?: boolean };
  /** Height over width (a random one's is its pick's). */
  aspect: number;
  /** "original", or a theme's look. */
  look: string;
  outline: boolean;
  flip?: boolean;
  /** Its middle: across the board (a fraction of its width) and down it (in rows of the grid). */
  x: number;
  y: number;
  /** Its width, a fraction of the board's. */
  w: number;
  rot: number;
}

/** "Mine": a random sticker's category for the reader's own cut-outs. */
export const MINE = "mine";

export interface HomeDoc {
  version: 1;
  blocks: Block[];
  stickers?: HomeSticker[];
  folders: FolderFilter;
  /** What the library opens on. */
  opensOn: "home" | "sort" | "last";
  /** Fit: the rows stretch so the board fills the window, once every block fits at the smallest row. */
  fit?: boolean;
  /** The screen last left for good, for "Where you were" and opening there. */
  last?: { screen: string; at: number };
}

export const COLS = 12;
/** A window too narrow for twelve: half as many, the blocks following in reading order. */
export const NARROW_COLS = 6;

export type BlockGroup = "work" | "pickup" | "rediscover" | "status" | "utility";
export const GROUPS: { id: BlockGroup; name: string }[] = [
  { id: "work", name: "Work waiting" },
  { id: "pickup", name: "Pick up" },
  { id: "rediscover", name: "Rediscover" },
  { id: "status", name: "Status" },
  { id: "utility", name: "Shortcuts" },
];

export interface Kind {
  name: string;
  about: string;
  group: BlockGroup;
  /** Its size when it comes, and the least it can be. */
  w: number;
  h: number;
  minW: number;
  minH: number;
  /** Its pictures can be narrowed with filters. */
  sourced?: boolean;
}

export const KINDS: Record<BlockType, Kind> = {
  sort: { name: "Waiting to sort", about: "What has come in and waits to be filed, newest first; Sort starts on it.", group: "work", w: 6, h: 5, minW: 3, minH: 3 },
  import: { name: "Import", about: "Bring pictures in from a card, a phone or a folder.", group: "work", w: 3, h: 2, minW: 2, minH: 2 },
  who: { name: "Who is this?", about: "Faces found that nobody has named yet, in groups.", group: "work", w: 3, h: 3, minW: 2, minH: 2 },
  faces: { name: "Faces to check", about: "Faces that look like someone named, and faces given someone that look like none of theirs.", group: "work", w: 3, h: 3, minW: 2, minH: 2 },
  dupes: { name: "Duplicates", about: "The groups the last duplicate check found.", group: "work", w: 4, h: 3, minW: 3, minH: 2 },
  series: { name: "Series to keep?", about: "Pictures waiting to sort that look like others: kept together, they are a series.", group: "work", w: 4, h: 3, minW: 3, minH: 2 },
  findnew: { name: "New on Find", about: "What your saved searches found since you last looked.", group: "work", w: 6, h: 3, minW: 3, minH: 2 },
  artists: { name: "Artists suggested", about: "Who made pictures that came from a platform, waiting for a yes.", group: "work", w: 3, h: 3, minW: 2, minH: 2 },
  basket: { name: "In the basket", about: "Works you put in Find's basket, a row per platform under its logo.", group: "work", w: 6, h: 3, minW: 2, minH: 2 },
  shared: { name: "From extensions", about: "What extensions share on the Home: a panel they fill together, each in a row under its icon.", group: "work", w: 6, h: 3, minW: 2, minH: 2 },
  reading: { name: "Continue reading", about: "The albums you were reading, at the page you got to.", group: "pickup", w: 3, h: 4, minW: 2, minH: 3 },
  viewed: { name: "Recently viewed", about: "What you looked at last.", group: "pickup", w: 6, h: 3, minW: 2, minH: 2 },
  newest: { name: "Newest", about: "The pictures most lately added or changed.", group: "pickup", w: 6, h: 3, minW: 2, minH: 2, sourced: true },
  last: { name: "Where you were", about: "The screen you were on when you left.", group: "pickup", w: 3, h: 2, minW: 2, minH: 2 },
  jumpin: { name: "Jump in", about: "Saved searches you pick, from any platform: one click runs it in Find.", group: "pickup", w: 4, h: 2, minW: 2, minH: 2 },
  onthisday: { name: "On this day", about: "Pictures from this day in other years.", group: "rediscover", w: 6, h: 4, minW: 3, minH: 2, sourced: true },
  random: { name: "A random handful", about: "A few pictures picked at random; shuffle for more.", group: "rediscover", w: 6, h: 4, minW: 2, minH: 2, sourced: true },
  favourites: { name: "Favourites", about: "Pictures you rated highly (8 up, unless its rating filter says).", group: "rediscover", w: 6, h: 4, minW: 2, minH: 2, sourced: true },
  source: { name: "Pictures you choose", about: "Any pictures, narrowed by Browse's filters (tags, people, artists, rating, folders and more) or one album.", group: "rediscover", w: 4, h: 4, minW: 2, minH: 2, sourced: true },
  unseen: { name: "Not seen in a while", about: "Pictures you haven't opened in a year or more.", group: "rediscover", w: 6, h: 3, minW: 2, minH: 2, sourced: true },
  slideshow: { name: "Slideshow", about: "One picture at a time, changing slowly; Play opens them full screen.", group: "rediscover", w: 4, h: 5, minW: 2, minH: 3, sourced: true },
  picture: { name: "One picture", about: "A picture you pin, or a new one each day.", group: "rediscover", w: 3, h: 4, minW: 2, minH: 2, sourced: true },
  scrapbook: { name: "Scrapbook", about: "The album covers you made in the Scrapbook.", group: "rediscover", w: 6, h: 4, minW: 2, minH: 3 },
  activity: { name: "Activity", about: "What is running, with pause and stop.", group: "status", w: 4, h: 3, minW: 3, minH: 2 },
  drive: { name: "The drive", about: "Space left on the library's drive, and its health.", group: "status", w: 3, h: 2, minW: 2, minH: 2 },
  backup: { name: "Backup", about: "When the library was last backed up.", group: "status", w: 3, h: 2, minW: 2, minH: 2 },
  shortcuts: { name: "Shortcuts", about: "Buttons to the screens you use most.", group: "utility", w: 3, h: 3, minW: 2, minH: 2 },
  theme: { name: "Theme", about: "The app's look, each theme shown in its own: pick one here. Its key goes to the next.", group: "utility", w: 4, h: 3, minW: 2, minH: 2 },
};

/** The screens a Shortcuts block can hold, and the ones it starts with. */
export const SHORTCUT_SCREENS = ["browse", "albums", "dupes", "files", "tags", "people", "artists", "scrapbook", "find"] as const;
export const DEFAULT_SHORTCUTS = ["browse", "albums", "people", "find"];

export type PresetId = "sorting" | "reading" | "collector" | "gallery" | "everything";
type Spot = Omit<Block, "id">;
const at = (type: BlockType, x: number, y: number, w: number, h: number, more: Partial<Spot> = {}): Spot => ({ type, x, y, w, h, ...more });

export const PRESETS: { id: PresetId; name: string; about: string; blocks: Spot[] }[] = [
  {
    id: "everything",
    name: "Everything",
    about: "Every kind of block once, to keep what you like.",
    blocks: [
      at("sort", 0, 0, 6, 5),
      at("who", 6, 0, 3, 3),
      at("reading", 9, 0, 3, 3),
      at("onthisday", 6, 3, 6, 5),
      at("activity", 0, 5, 3, 3),
      at("favourites", 3, 5, 3, 3),
      at("findnew", 0, 8, 6, 3),
      at("dupes", 6, 8, 3, 3),
      at("faces", 9, 8, 3, 3),
      at("random", 0, 11, 6, 4),
      at("slideshow", 6, 11, 3, 4),
      at("picture", 9, 11, 3, 4),
      at("viewed", 0, 15, 6, 3),
      at("newest", 6, 15, 6, 3),
      at("unseen", 0, 18, 6, 3),
      at("scrapbook", 6, 18, 6, 3),
      at("source", 0, 21, 4, 3),
      at("series", 4, 21, 4, 3),
      at("artists", 8, 21, 4, 3),
      at("import", 0, 24, 3, 2),
      at("last", 3, 24, 3, 2),
      at("drive", 6, 24, 3, 2),
      at("backup", 9, 24, 3, 2),
      at("shortcuts", 0, 26, 3, 3),
      at("basket", 3, 26, 9, 3),
      at("jumpin", 0, 29, 6, 2),
      at("shared", 6, 29, 6, 3),
      at("theme", 0, 31, 6, 3),
    ],
  },
  {
    id: "sorting",
    name: "Sorting desk",
    about: "What came in and what needs a decision: sort, name, weed out.",
    blocks: [
      at("sort", 0, 0, 7, 5),
      at("who", 7, 0, 5, 3),
      at("import", 7, 3, 2, 2),
      at("activity", 9, 3, 3, 2),
      at("series", 0, 5, 4, 3),
      at("dupes", 4, 5, 4, 3),
      at("faces", 8, 5, 4, 3),
      at("newest", 0, 8, 8, 3),
      at("drive", 8, 8, 4, 2),
      at("backup", 8, 10, 4, 2),
    ],
  },
  {
    id: "reading",
    name: "Reading room",
    about: "Albums and manga: where you were, the covers, what you read lately.",
    blocks: [
      at("reading", 0, 0, 4, 6),
      at("scrapbook", 4, 0, 8, 6),
      at("viewed", 0, 6, 8, 3),
      at("last", 8, 6, 4, 3),
      at("random", 0, 9, 12, 3),
    ],
  },
  {
    id: "collector",
    name: "Collector",
    about: "Finding more on platforms and bringing it in.",
    blocks: [
      at("findnew", 0, 0, 8, 4),
      at("artists", 8, 0, 4, 4),
      at("basket", 0, 4, 12, 3),
      at("sort", 0, 7, 6, 4),
      at("dupes", 6, 7, 3, 4),
      at("activity", 9, 7, 3, 4),
      at("newest", 0, 11, 12, 3),
    ],
  },
  {
    id: "gallery",
    name: "Gallery",
    about: "Just the pictures: a slideshow, this day in other years, favourites.",
    blocks: [
      at("slideshow", 0, 0, 7, 6),
      at("onthisday", 7, 0, 5, 6),
      at("favourites", 0, 6, 6, 4),
      at("unseen", 6, 6, 6, 4),
      at("picture", 0, 10, 4, 4),
      at("random", 4, 10, 8, 4),
    ],
  },
];

const newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const emptyDoc = (): HomeDoc => ({ version: 1, blocks: [], folders: { mode: "all", list: [] }, opensOn: "home" });

/** A preset's blocks, each with an id of its own. */
export const presetBlocks = (id: PresetId): Block[] => (PRESETS.find((p) => p.id === id) ?? PRESETS[0]).blocks.map((b) => ({ ...b, id: newId() }));

const overlaps = (a: Block, b: Block) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The board settled: each block as high as it goes without overlapping one placed before it, in
 * reading order; the one being moved or sized (`held`) stays where it was put, and the rest make
 * room. The blocks come back in the order given.
 */
export function settle(blocks: Block[], held?: string): Block[] {
  const order = [...blocks].sort((a, b) => (a.id === held ? -1 : b.id === held ? 1 : a.y - b.y || a.x - b.x));
  const placed = new Map<string, Block>();
  for (const b of order) {
    const c = { ...b, y: b.id === held ? b.y : 0 };
    while ([...placed.values()].some((p) => overlaps(p, c))) c.y++;
    placed.set(b.id, c);
  }
  return blocks.map((b) => placed.get(b.id)!);
}

const clampTo = (b: Block, cols: number): Block => {
  const k = KINDS[b.type];
  const w = Math.max(Math.min(k.minW, cols), Math.min(cols, Math.round(b.w)));
  const h = Math.max(k.minH, Math.round(b.h));
  return { ...b, w, h, x: Math.max(0, Math.min(cols - w, Math.round(b.x))), y: Math.max(0, Math.round(b.y)) };
};

/** A block put at a cell (its top left there), the others making room. */
export function move(blocks: Block[], id: string, x: number, y: number, cols = COLS): Block[] {
  return settle(
    blocks.map((b) => (b.id === id ? clampTo({ ...b, x, y }, cols) : b)),
    id,
  );
}

/** A block made this many cells wide and high (never less than its kind allows), the others making room. */
export function resize(blocks: Block[], id: string, w: number, h: number, cols = COLS): Block[] {
  return settle(
    blocks.map((b) => (b.id === id ? clampTo({ ...b, w, h }, cols) : b)),
    id,
  );
}

/** A new block of a kind: at a cell when dropped there, else in the first gap it fits, else at the foot. */
export function add(blocks: Block[], type: BlockType, where?: { x: number; y: number }, cols = COLS): { blocks: Block[]; id: string } {
  const k = KINDS[type];
  const b: Block = { id: newId(), type, x: 0, y: 0, w: Math.min(k.w, cols), h: k.h };
  if (where) return { blocks: move([...blocks, { ...b, ...where }], b.id, where.x, where.y, cols), id: b.id };
  const bottom = Math.max(0, ...blocks.map((o) => o.y + o.h));
  for (let y = 0; y <= bottom; y++)
    for (let x = 0; x + b.w <= cols; x++) {
      const c = { ...b, x, y };
      if (!blocks.some((o) => overlaps(o, c))) return { blocks: [...blocks, c], id: b.id };
    }
  return { blocks: [...blocks, { ...b, y: bottom }], id: b.id };
}

/** The board in a narrower grid: each block half as wide (as little as its kind allows), in reading order. */
export function narrow(blocks: Block[], cols = NARROW_COLS): Block[] {
  const half = blocks.map((b) => clampTo({ ...b, x: Math.floor((b.x * cols) / COLS), w: Math.ceil((b.w * cols) / COLS) }, cols));
  return settle(half);
}

/** The blocks in reading order: top to bottom, left to right (their number keys go so). */
export const readingOrder = (blocks: Block[]): Block[] => [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);

const under = (key: string, folder: string) => {
  const f = folder.replace(/\/+$/, "");
  return !f || key === f || key.startsWith(`${f}/`);
};

/** Whether a picture may show on the Home, as its folders say. */
export function shownOnHome(key: string, folders: FolderFilter): boolean {
  if (folders.mode === "all" || !folders.list.length) return true;
  const inList = folders.list.some((f) => under(key, f));
  return folders.mode === "only" ? inList : !inList;
}

/** The doc with every key and folder it holds following pictures and folders moved (`pairs`: from, to). */
export function followMoves(doc: HomeDoc, pairs: [string, string][]): HomeDoc {
  const moved = (k: string) => {
    const p = pairs.find(([from]) => k === from || k.startsWith(`${from}/`));
    return p ? p[1] + k.slice(p[0].length) : k;
  };
  const keyed = (f: BlockFilter | undefined) => f && { ...f, ...(f.folders ? { folders: f.folders.map(moved) } : {}), ...(f.album ? { album: moved(f.album) } : {}) };
  return {
    ...doc,
    folders: { ...doc.folders, list: doc.folders.list.map(moved) },
    blocks: doc.blocks.map((b) => ({ ...b, filter: keyed(b.filter), pinned: b.pinned && moved(b.pinned) })),
    ...(doc.stickers ? { stickers: doc.stickers.map((s) => (s.random?.filter ? { ...s, random: { ...s.random, filter: keyed(s.random.filter) } } : s)) } : {}),
  };
}

/** A board with what is gone for good taken out: folders in its filters, an album filtered on, a pinned picture. */
export function forgetGone(doc: HomeDoc, gone: (key: string) => boolean): HomeDoc {
  const keep = (f: BlockFilter | undefined) => {
    if (!f) return f;
    const { album, ...rest } = f;
    return { ...rest, ...(f.folders ? { folders: f.folders.filter((x) => !gone(x)) } : {}), ...(album && !gone(album) ? { album } : {}) };
  };
  return {
    ...doc,
    folders: { ...doc.folders, list: doc.folders.list.filter((x) => !gone(x)) },
    blocks: doc.blocks.map((b) => ({ ...b, filter: keep(b.filter), pinned: b.pinned && !gone(b.pinned) ? b.pinned : undefined })),
    ...(doc.stickers ? { stickers: doc.stickers.map((s) => (s.random?.filter ? { ...s, random: { ...s.random, filter: keep(s.random.filter) } } : s)) } : {}),
  };
}

/** A board as kept, made current: a block's one source (before filters) becomes its filter. */
export function upgrade(doc: HomeDoc): HomeDoc {
  const toFilter = (s: OldSource): BlockFilter | undefined => {
    if (!s.id) return undefined;
    switch (s.kind) {
      case "tag":
        return { tags: [s.id] };
      case "person":
        return { people: [s.id] };
      case "artist":
        return { artists: [s.id] };
      case "album":
        return { album: s.id };
      case "folder":
        return { folders: [s.id] };
    }
    return undefined;
  };
  return {
    ...doc,
    blocks: doc.blocks.map((b) => {
      // "Hide when empty" is gone: it left holes in the board.
      const { hideEmpty: _gone, ...kept } = b as Block & { hideEmpty?: boolean };
      const old = kept as Block & { source?: OldSource; minRating?: number };
      if (!old.source && old.minRating == null) return kept;
      const { source, minRating, ...rest } = old;
      const filter = { ...(source ? toFilter(source) : {}), ...(minRating != null ? { minRating } : {}), ...rest.filter };
      return Object.keys(filter).length ? { ...rest, filter } : rest;
    }),
  };
}

/**
 * Pictures from this day in earlier years (by when each was made or last changed), newest year
 * first; `days` either side widens it (this week, this month).
 */
export function onThisDay<T extends { modified: number }>(items: T[], now = new Date(), days = 0): { year: number; items: T[] }[] {
  const byYear = new Map<number, T[]>();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  for (const it of items) {
    const d = new Date(it.modified);
    if (d.getFullYear() >= now.getFullYear()) continue;
    const apart = Math.abs(Math.round((new Date(now.getFullYear(), d.getMonth(), d.getDate()).getTime() - day) / 86_400_000));
    if (Math.min(apart, 365 - apart) > days) continue;
    byYear.set(d.getFullYear(), [...(byYear.get(d.getFullYear()) ?? []), it]);
  }
  return [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, list]) => ({ year, items: list }));
}

/** How many days off this day (either way, any earlier year) the nearest picture is; none when no picture is from an earlier year. */
export function nearestDay<T extends { modified: number }>(items: T[], now = new Date()): number | null {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let best: number | null = null;
  for (const it of items) {
    const d = new Date(it.modified);
    if (d.getFullYear() >= now.getFullYear()) continue;
    const apart = Math.abs(Math.round((new Date(now.getFullYear(), d.getMonth(), d.getDate()).getTime() - day) / 86_400_000));
    const off = Math.min(apart, 365 - apart);
    if (best == null || off < best) best = off;
  }
  return best;
}

/** `n` of `items` picked by a seed: the same seed, the same pick (a block keeps its handful until shuffled). */
export function pick<T>(items: T[], n: number, seed: number): T[] {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const out = items.slice();
  const k = Math.min(n, out.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (out.length - i));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, k);
}

/** Today's number, for a pick that changes once a day. */
export const today = (now = new Date()) => now.getFullYear() * 1000 + Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86_400_000);

/** The kinds that show a grid of pictures, which can be a mosaic instead. */
export const MOSAIC_KINDS: BlockType[] = ["viewed", "newest", "onthisday", "random", "favourites", "source", "unseen"];
/** A mosaic needs room for a few pictures of each shape: a block at least this many cells. */
export const MOSAIC_MIN = { w: 4, h: 3 };
export const canMosaic = (b: Block) => MOSAIC_KINDS.includes(b.type) && b.w >= MOSAIC_MIN.w && b.h >= MOSAIC_MIN.h;

/** A picture placed in a mosaic, in pixels of its box. */
export interface Tile {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pictures (width over height, `a`) in rows that fill a W × H box, each keeping its shape: rows of
 * a picture's height (about 100 to 240 px), as many of them as need the least trimming (each row
 * filled edge to edge, then all of them stretched to the box's height, which trims the pictures a
 * little at their sides or top). None when the best still trims more than `most` (too few
 * pictures, or too small a box): a grid does better then.
 */
export function justify(list: { key: string; a: number }[], W: number, H: number, gap = 4, most = 0.15): Tile[] | null {
  if (!list.length || W < 60 || H < 60) return null;
  let best: { rows: { key: string; a: number }[][]; heights: number[]; trim: number } | null = null;
  const fewest = Math.max(1, Math.round(H / 240));
  const rowsMost = Math.max(fewest, Math.floor(H / 100));
  for (let r = fewest; r <= rowsMost; r++) {
    const target = (H - (r - 1) * gap) / r;
    const rows: { key: string; a: number }[][] = [];
    let i = 0;
    for (let n = 0; n < r && i < list.length; n++) {
      const row: { key: string; a: number }[] = [];
      let width = 0;
      while (i < list.length && (row.length === 0 || width < W)) {
        row.push(list[i]);
        width = row.reduce((s, p) => s + p.a * target, 0) + (row.length - 1) * gap;
        i++;
      }
      rows.push(row);
    }
    if (rows.length < r) continue;
    // Each row as high as fills the width exactly; then all stretched together to the box's height.
    const heights = rows.map((row) => (W - (row.length - 1) * gap) / row.reduce((s, p) => s + p.a, 0));
    const stretch = (H - (r - 1) * gap) / heights.reduce((s, h) => s + h, 0);
    const trim = Math.abs(1 - stretch);
    if (!best || trim < best.trim) best = { rows, heights: heights.map((h) => h * stretch), trim };
  }
  if (!best || best.trim > most) return null;
  const tiles: Tile[] = [];
  let y = 0;
  best.rows.forEach((row, n) => {
    const h = best!.heights[n];
    const sum = row.reduce((s, p) => s + p.a, 0);
    let x = 0;
    for (const p of row) {
      const w = ((W - (row.length - 1) * gap) * p.a) / sum;
      tiles.push({ key: p.key, x, y, w, h });
      x += w + gap;
    }
    y += h + gap;
  });
  return tiles;
}
