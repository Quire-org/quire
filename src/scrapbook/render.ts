import { PIN_COLOURS, TAPE_COLOURS, type ArrowLayer, type Background, type Bar, type Fix, type Layer, type NoteLayer, type PhotoLayer, type ScrapDoc, type StickerLayer, type TextLayer } from "./model";
import { CLASSIC_FRAME, ORIGINAL, fontById, fontCss, lookById } from "./looks";
import { builtin } from "./stickers";

/**
 * Draws a cover: the same drawing for the editor's page and for the picture saved when it's done,
 * so what is seen is what is kept. Pictures load once into an AssetCache; until one has, its layer
 * is left out and the cache asks for a redraw when it arrives.
 */

export type Drawable = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

const sizeOf = (d: Drawable) => ("naturalWidth" in d ? { w: d.naturalWidth || d.width, h: d.naturalHeight || d.height } : { w: d.width, h: d.height });

function canvasOf(w: number, h: number, space?: PredefinedColorSpace): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return [c, c.getContext("2d", space ? { colorSpace: space } : undefined)!];
}

/**
 * The pictures covers draw: built-in stickers (their 3D picture, their line art) and the cover's own
 * files (photos, custom stickers), plus what is made from them (line art in a look's ink, a cut edge
 * around a sticker), each once.
 */
export class AssetCache {
  private loaded = new Map<string, Drawable | "loading" | "failed">();
  private made = new Map<string, HTMLCanvasElement>();
  private waiting = new Set<() => void>();
  /** `itemUrl`: a picture of the library by its key (a board's pointed at), or null when it is gone. */
  constructor(
    private blobUrl: (name: string) => Promise<string>,
    private itemUrl: (key: string) => Promise<string | null> = async () => null,
  ) {}

  /** Called when a picture arrives (the editor redraws). */
  onLoad(f: () => void): () => void {
    this.waiting.add(f);
    return () => this.waiting.delete(f);
  }

  private load(key: string, url: () => Promise<string>): Drawable | null {
    const had = this.loaded.get(key);
    if (had === "loading" || had === "failed") return null;
    if (had) return had;
    this.loaded.set(key, "loading");
    void url()
      .then(
        (u) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            // Asked for as the app's own (the thumb protocol answers so), or a page drawn with it couldn't be saved or exported.
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`could not load ${key}`));
            img.src = u;
          }),
      )
      .then((img) => {
        this.loaded.set(key, img);
        this.waiting.forEach((f) => f());
      })
      .catch(() => this.loaded.set(key, "failed"));
    return null;
  }

  blob(name: string): Drawable | null {
    return this.load(`blob:${name}`, () => this.blobUrl(name));
  }

  /** A library picture a board points at, by its key. */
  item(key: string): Drawable | null {
    return this.load(`item:${key}`, async () => {
      const url = await this.itemUrl(key);
      if (!url) throw new Error(`${key} is gone`);
      return url;
    });
  }

  /** A photo layer's picture: its copy, or the library's picture it points at. */
  photo(layer: PhotoLayer): Drawable | null {
    return layer.item ? this.item(layer.item) : this.blob(layer.blob);
  }

  /** Whether a photo layer's picture couldn't be had (a library picture gone since). */
  missing(layer: PhotoLayer): boolean {
    return this.loaded.get(layer.item ? `item:${layer.item}` : `blob:${layer.blob}`) === "failed";
  }

  /** A built-in sticker as itself (original), or its line art in a look's ink. */
  sticker(layer: StickerLayer): Drawable | null {
    if ("blob" in layer.src) return this.blob(layer.src.blob);
    const s = builtin(layer.src.builtin);
    if (!s) return null;
    if (layer.look === ORIGINAL) return this.load(`full:${s.id}`, async () => s.full);
    const art = this.load(`line:${s.id}`, async () => s.line);
    if (!art) return null;
    const ink = lookById(layer.look).ink;
    const key = `ink:${s.id}:${ink}`;
    let c = this.made.get(key);
    if (!c) {
      // The line art drawn large (it is vector) and every drawn pixel filled with the ink.
      const [canvas, ctx] = canvasOf(512, 512 * (sizeOf(art).h / Math.max(1, sizeOf(art).w)));
      ctx.drawImage(art, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = ink;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.made.set(key, (c = canvas));
    }
    return c;
  }

  /** A picture with a cut edge around what it shows (its opaque part), as a sticker has. */
  edged(key: string, img: Drawable, colour: string, px: number): HTMLCanvasElement {
    const id = `edge:${key}:${colour}:${Math.round(px)}`;
    let c = this.made.get(id);
    if (!c) this.made.set(id, (c = edgeAround(img, colour, px)));
    return c;
  }

  /** Every picture a cover needs, loaded (for the final render). */
  async ready(doc: ScrapDoc): Promise<void> {
    for (let tries = 0; tries < 100; tries++) {
      let missing = false;
      if (doc.background.kind === "photo" && !this.blob(doc.background.blob) && this.loaded.get(`blob:${doc.background.blob}`) !== "failed") missing = true;
      for (const l of doc.layers) {
        if (l.type === "photo" && !this.photo(l) && !this.missing(l)) missing = true;
        if (l.type === "sticker" && !this.sticker(l)) {
          const key = "blob" in l.src ? `blob:${l.src.blob}` : l.look === ORIGINAL ? `full:${l.src.builtin}` : `line:${l.src.builtin}`;
          if (this.loaded.get(key) !== "failed") missing = true;
        }
      }
      if (!missing) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** How see-through a pixel can be and still be taken for dust, not part of what is cut out (of 255). */
const DUST = 64;

/** A picture with a cut edge `px` wide (in its own pixels) around what it shows, as a sticker has. */
export function edgeAround(img: Drawable, colour: string, px: number, space?: PredefinedColorSpace): HTMLCanvasElement {
  const { w, h } = sizeOf(img);
  const pad = Math.ceil(px) + 1;
  const [canvas, ctx] = canvasOf(w + pad * 2, h + pad * 2, space);
  const [sil, sctx] = canvasOf(w, h, space);
  sctx.drawImage(img, 0, 0, w, h);
  // Only what is clearly there gets an edge: faint dust left round a subject (the last of the cutter's
  // soft edge, the rim of what was erased) would each come out as a ring of dots, one per stamp below.
  // What is kept keeps its soft rim, rescaled, so the edge stays smooth.
  const data = sctx.getImageData(0, 0, sil.width, sil.height);
  const a = data.data;
  for (let i = 3; i < a.length; i += 4) a[i] = a[i] <= DUST ? 0 : Math.round(((a[i] - DUST) * 255) / (255 - DUST));
  sctx.putImageData(data, 0, 0);
  sctx.globalCompositeOperation = "source-in";
  sctx.fillStyle = colour;
  sctx.fillRect(0, 0, w, h);
  // The silhouette stamped around a circle: the edge, as wide as px.
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    ctx.drawImage(sil, pad + Math.cos(a) * px, pad + Math.sin(a) * px);
  }
  ctx.drawImage(sil, pad, pad);
  ctx.drawImage(img, pad, pad, w, h);
  return canvas;
}

/** A picture's shape alone, filled with `fill`, with a cut edge `px` wide in `edge` around it: a sticker's stand-in. */
export function cutOut(img: Drawable, fill: string, edge: string, px: number): HTMLCanvasElement {
  const { w, h } = sizeOf(img);
  const [sil, ctx] = canvasOf(w, h);
  ctx.drawImage(img, 0, 0, w, h);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return edgeAround(sil, edge, px);
}

/* ---------------- backgrounds ---------------- */

function drawBackground(ctx: CanvasRenderingContext2D, bg: Background, bars: Bar[], W: number, H: number, assets: AssetCache) {
  ctx.save();
  ctx.fillStyle = bg.color;
  ctx.fillRect(0, 0, W, H);
  if (bg.kind === "photo") {
    const img = assets.blob(bg.blob);
    if (img) {
      const { w, h } = sizeOf(img);
      const scale = Math.max(W / w, H / h);
      const dw = w * scale;
      const dh = h * scale;
      if (bg.blur > 0.01) {
        // Blurred by drawing it small and scaling it back up: the same in every browser.
        const f = Math.max(0.02, 1 - bg.blur * 0.97);
        const [small, sctx] = canvasOf(W * f, H * f);
        sctx.imageSmoothingQuality = "high";
        sctx.drawImage(img, ((W - dw) / 2) * f, ((H - dh) / 2) * f, dw * f, dh * f);
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(small, 0, 0, W, H);
      } else ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
    fillParts(ctx, bars, W, H);
    ctx.restore();
    return;
  }
  fillParts(ctx, bars, W, H);
  const u = Math.min(W, H);
  ctx.fillStyle = bg.ink;
  ctx.strokeStyle = bg.ink;
  switch (bg.pattern) {
    case "dots": {
      const s = u * 0.075;
      const r = u * 0.012;
      for (let row = 0, y = s / 2; y < H + s; y += s * 0.866, row++)
        for (let x = row % 2 ? s / 2 : 0; x < W + s; x += s) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      break;
    }
    case "tone": {
      // Screentone: fine dots, faint.
      const s = u * 0.022;
      const r = s * 0.28;
      ctx.globalAlpha = 0.22;
      for (let row = 0, y = 0; y < H + s; y += s * 0.866, row++)
        for (let x = row % 2 ? s / 2 : 0; x < W + s; x += s) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      break;
    }
    case "grid": {
      const s = u * 0.07;
      ctx.lineWidth = Math.max(1, u * 0.004);
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let x = s / 2; x < W; x += s) (ctx.moveTo(x, 0), ctx.lineTo(x, H));
      for (let y = s / 2; y < H; y += s) (ctx.moveTo(0, y), ctx.lineTo(W, y));
      ctx.stroke();
      break;
    }
    case "lined": {
      const s = u * 0.06;
      ctx.lineWidth = Math.max(1, u * 0.004);
      ctx.beginPath();
      for (let y = s * 1.5; y < H; y += s) (ctx.moveTo(0, y), ctx.lineTo(W, y));
      ctx.stroke();
      break;
    }
    case "stripes": {
      const s = u * 0.08;
      ctx.lineWidth = s / 2;
      ctx.beginPath();
      for (let x = -H; x < W + H; x += s) (ctx.moveTo(x, 0), ctx.lineTo(x + H, H));
      ctx.stroke();
      break;
    }
    case "checks": {
      // Gingham: see-through bands both ways, darker where they cross.
      const s = u * 0.09;
      ctx.globalAlpha = 0.55;
      for (let x = 0; x < W; x += s * 2) ctx.fillRect(x, 0, s, H);
      for (let y = 0; y < H; y += s * 2) ctx.fillRect(0, y, W, s);
      break;
    }
    case "cork":
      drawCork(ctx, bg, W, H);
      break;
    case "plain":
      break;
  }
  ctx.restore();
}

/** Cork: its grain, dark and light flecks, inside a wooden frame. The same every time. */
function drawCork(ctx: CanvasRenderingContext2D, bg: Background & { kind: "pattern" }, W: number, H: number) {
  const u = Math.min(W, H);
  const r = seeded("cork");
  const flecks = Math.round((W * H) / (u * u * 0.0006));
  for (let i = 0; i < flecks; i++) {
    ctx.globalAlpha = 0.12 + r() * 0.3;
    ctx.fillStyle = r() < 0.6 ? bg.ink : "#e9cfa7";
    const s = u * (0.002 + r() * 0.006);
    ctx.beginPath();
    ctx.ellipse(r() * W, r() * H, s, s * (0.5 + r() * 0.5), r() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // The frame: wood, with a shadow cast on the cork inside it.
  const f = u * 0.022;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = f * 0.9;
  ctx.lineWidth = f * 2;
  ctx.strokeStyle = "#6e4a2c";
  ctx.strokeRect(0, 0, W, H);
  ctx.restore();
  ctx.lineWidth = f * 2;
  ctx.strokeStyle = "#7a5030";
  ctx.strokeRect(0, 0, W, H);
  ctx.lineWidth = Math.max(1, f * 0.12);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(f, f, W - f * 2, H - f * 2);
}

/* ---------------- bars ---------------- */

/** The same numbers every time for a bar (its jags and tears), from its id. */
function seeded(id: string): () => number {
  let a = 0;
  for (let i = 0; i < id.length; i++) a = (Math.imul(a, 31) + id.charCodeAt(i)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = [number, number];

/** Into a bar's own frame: its middle line upright through the origin, the page's pixels. */
function intoBar(ctx: CanvasRenderingContext2D, bar: Bar, W: number, H: number) {
  ctx.translate(bar.x * W, H / 2);
  ctx.rotate((bar.angle * Math.PI) / 180);
}

/** A bar's middle, top to bottom (from -L to L, past the page's corners): straight, or a lightning bolt's jags. */
function spine(bar: Bar, u: number, L: number): Pt[] {
  if (bar.style !== "lightning") return [[0, -L], [0, L]];
  const rnd = seeded(bar.id);
  const amp = Math.max(bar.width * u * 1.1, u * 0.035);
  const out: Pt[] = [];
  let side = rnd() < 0.5 ? -1 : 1;
  for (let y = -L; ; side = -side) {
    out.push([side * amp * (0.55 + rnd() * 0.45), y]);
    if (y >= L) break;
    y = Math.min(L, y + u * (0.07 + rnd() * 0.08));
  }
  return out;
}

/** A bar's outline: its left edge top to bottom, then its right edge back up. */
function barShape(bar: Bar, u: number, L: number): Pt[] {
  const t = (bar.width * u) / 2;
  const rnd = seeded(`${bar.id}:edge`);
  const left: Pt[] = [];
  const right: Pt[] = [];
  if (bar.style === "lightning") {
    for (const [x, y] of spine(bar, u, L)) (left.push([x - t, y]), right.push([x + t, y]));
  } else if (bar.style === "torn") {
    // Ripped: each edge wanders a little, in small steps.
    const j = Math.max(1.5, t * 0.6);
    for (let y = -L; y <= L; y += Math.max(2, u * 0.008)) (left.push([-t - rnd() * j, y]), right.push([t + rnd() * j, y]));
  } else if (bar.style === "zigzag") {
    // Pinking shears: teeth on both edges, in step.
    const p = Math.max(3, u * 0.012, t * 0.7);
    for (let k = 0, y = -L; y <= L + p; k++, y += p) {
      const out = k % 2 ? p * 0.8 : 0;
      left.push([-t - out, y]);
      right.push([t + out, y]);
    }
  } else {
    left.push([-t, -L], [-t, L]);
    right.push([t, -L], [t, L]);
  }
  return [...left, ...right.reverse()];
}

function tracePath(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

/** The parts of the background the bars split off: right of each bar (left to right), its fill. */
function fillParts(ctx: CanvasRenderingContext2D, bars: Bar[], W: number, H: number) {
  const u = Math.min(W, H);
  const L = Math.hypot(W, H);
  for (const bar of [...bars].sort((a, b) => a.x - b.x)) {
    ctx.save();
    intoBar(ctx, bar, W, H);
    ctx.fillStyle = bar.fill;
    tracePath(ctx, [...spine(bar, u, L), [L * 2, L], [L * 2, -L]]);
    ctx.fill();
    ctx.restore();
  }
}

/** Dark stitches on a light bar, light ones on a dark bar. */
function stitchColour(hex: string): string {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "rgba(60, 40, 40, 0.45)" : "rgba(255, 255, 255, 0.7)";
}

function drawBars(ctx: CanvasRenderingContext2D, bars: Bar[], W: number, H: number) {
  const u = Math.min(W, H);
  const L = Math.hypot(W, H);
  for (const bar of [...bars].sort((a, b) => a.x - b.x)) {
    ctx.save();
    intoBar(ctx, bar, W, H);
    // Paper-like bars lie on the page: a soft shadow under them.
    if (bar.style === "torn" || bar.style === "stitched" || bar.style === "zigzag") {
      ctx.shadowColor = "rgba(0, 0, 0, 0.22)";
      ctx.shadowBlur = u * 0.012;
      ctx.shadowOffsetY = u * 0.004;
    }
    ctx.fillStyle = bar.color;
    tracePath(ctx, barShape(bar, u, L));
    ctx.fill();
    if (bar.style === "stitched") {
      ctx.shadowColor = "transparent";
      const t = bar.width * u;
      ctx.strokeStyle = stitchColour(bar.color);
      ctx.lineWidth = Math.max(1, t * 0.08);
      ctx.setLineDash([u * 0.018, u * 0.01]);
      ctx.beginPath();
      // Two seams on a wide ribbon, one down the middle of a thin one.
      for (const x of t >= u * 0.03 ? [-t * 0.3, t * 0.3] : [0]) (ctx.moveTo(x, -L), ctx.lineTo(x, L));
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** How wide a bar's footprint is (its jags and tears included), in pixels. */
export function barSpan(bar: Bar, u: number): number {
  const t = bar.width * u;
  if (bar.style === "lightning") return t + 2 * Math.max(t * 1.1, u * 0.035);
  if (bar.style === "zigzag") return t + 1.6 * Math.max(3, u * 0.012, t * 0.35);
  if (bar.style === "torn") return t * 1.6;
  return t;
}

/** The bar under a point of the page (in pixels), if any; `slack` pixels of grace for thin ones. */
export function barAt(doc: ScrapDoc, W: number, H: number, px: number, py: number, slack = 6): Bar | null {
  const u = Math.min(W, H);
  const bars = [...(doc.bars ?? [])].sort((a, b) => b.x - a.x);
  for (const bar of bars) {
    const a = (-bar.angle * Math.PI) / 180;
    const dx = px - bar.x * W;
    const dy = py - H / 2;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    // Against its middle where the point is (a lightning bar's jags included).
    const pts = spine(bar, u, Math.hypot(W, H));
    let mx = 0;
    for (let i = 1; i < pts.length; i++)
      if (ly <= pts[i][1]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        mx = x0 + ((x1 - x0) * (ly - y0)) / Math.max(1e-6, y1 - y0);
        break;
      }
    if (Math.abs(lx - mx) <= (bar.width * u) / 2 + slack) return bar;
  }
  return null;
}

/* ---------------- layers ---------------- */

const LINE = 1.15;

function textLines(text: string, look: string): string[] {
  const t = lookById(look).upper ? text.toUpperCase() : text;
  return (t || " ").split("\n");
}

function setSpacing(ctx: CanvasRenderingContext2D, em: number, px: number) {
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${(em * px).toFixed(2)}px`;
}

/** Capitals' height as a share of the font size: what every font is sized by, so the same size is equally tall in any. */
const CAP = 0.7;

/** How tall a font's capitals are, as a share of its size (as measured once it has loaded). */
function capOf(ctx: CanvasRenderingContext2D, font: string, px: number): number {
  ctx.save();
  ctx.font = fontCss(font, px);
  const a = ctx.measureText("H").actualBoundingBoxAscent;
  ctx.restore();
  return typeof a === "number" && a > 0 ? a / Math.max(1, px) : CAP;
}

/** The font size that gives a text's size in capitals' height (a layer's `size` is that height over CAP). */
function pxOf(ctx: CanvasRenderingContext2D, font: string, px: number): number {
  return (px * CAP) / capOf(ctx, font, px);
}

/** The room a text takes at `px` in a font and look: its widest line and its lines, with its outline. */
function naturalBox(ctx: CanvasRenderingContext2D, text: string, font: string, look: string, px: number): { w: number; h: number } {
  const l = lookById(look);
  ctx.save();
  ctx.font = fontCss(font, px);
  setSpacing(ctx, l.spacing ?? 0, px);
  const lines = textLines(text, look);
  const w = Math.max(...lines.map((line) => ctx.measureText(line).width));
  ctx.restore();
  const pad = px * (l.strokeWidth + 0.1);
  return { w: w + pad * 2, h: lines.length * px * LINE + pad * 2 };
}

/**
 * A text's font size and room. Its capitals are as tall in every font. Shown in another font or look
 * than it was made in (`box`), it takes the room it took there, narrowed if it would be wider (so a
 * cover keeps its layout whatever look it is in).
 */
function textFit(ctx: CanvasRenderingContext2D, layer: TextLayer, H: number): { px: number; w: number; h: number } {
  const px = pxOf(ctx, layer.font, layer.size * H);
  const own = naturalBox(ctx, layer.text, layer.font, layer.look, px);
  if (!layer.box || (layer.box.font === layer.font && layer.box.look === layer.look)) return { px, ...own };
  const was = naturalBox(ctx, layer.text, layer.box.font, layer.box.look, pxOf(ctx, layer.box.font, layer.size * H));
  const k = Math.min(1, was.w / Math.max(1, own.w));
  return { px: px * k, w: was.w, h: was.h };
}

/** A layer's size on a W × H page, in pixels (before turning): what the editor's handles go round. */
export function layerSize(ctx: CanvasRenderingContext2D, layer: Layer, W: number, H: number): { w: number; h: number } {
  if (layer.type === "text") {
    const { w, h } = textFit(ctx, layer, H);
    return { w, h };
  }
  const w = layer.w * W;
  if (layer.type === "note") return noteLayout(ctx, layer, W).box;
  // An arrow is held by a band as long as it, about as wide as its head (and never too thin to grab).
  if (layer.type === "arrow") return { w, h: Math.max(18, arrowHead(layer, W, H) * 1.4) };
  if (layer.type === "photo" && layer.frame === "polaroid") return { w: w * 1.1, h: w * layer.aspect + w * 0.28 };
  return { w, h: w * layer.aspect };
}

/** Where a text's letters are drawn on the page `H` tall: their size and the room they take (for typing into it in place). */
export const textMetrics = (ctx: CanvasRenderingContext2D, layer: TextLayer, H: number) => textFit(ctx, layer, H);

/** A note's letters, its paper's margin and its size on the page `W` wide (for typing into it in place). */
export const noteMetrics = (ctx: CanvasRenderingContext2D, layer: NoteLayer, W: number) => noteLayout(ctx, layer, W);

/** The font notes are written in. */
export const NOTE_FONT = "caveat";

/** A note's lines, its letters' size and its paper's size: as wide as it is set, as tall as its text needs (squarish at least). */
function noteLayout(ctx: CanvasRenderingContext2D, layer: NoteLayer, W: number): { lines: string[]; px: number; pad: number; box: { w: number; h: number } } {
  const w = layer.w * W;
  const pad = w * 0.09;
  const px = w * 0.095;
  ctx.save();
  ctx.font = fontCss(NOTE_FONT, px);
  const lines: string[] = [];
  for (const para of layer.text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > w - pad * 2) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  ctx.restore();
  return { lines, px, pad, box: { w, h: Math.max(w * 0.8, pad * 2 + lines.length * px * 1.2) } };
}

function drawNote(ctx: CanvasRenderingContext2D, layer: NoteLayer, W: number) {
  const { lines, px, pad, box } = noteLayout(ctx, layer, W);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = box.w * 0.05;
  ctx.shadowOffsetY = box.w * 0.02;
  ctx.fillStyle = layer.paper;
  ctx.fillRect(-box.w / 2, -box.h / 2, box.w, box.h);
  ctx.restore();
  // A slightly darker fold along its top, as a sticky note's glue strip.
  ctx.fillStyle = "rgba(0,0,0,0.05)";
  ctx.fillRect(-box.w / 2, -box.h / 2, box.w, box.h * 0.12);
  ctx.fillStyle = "#2b2622";
  ctx.font = fontCss(NOTE_FONT, px);
  ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, -box.w / 2 + pad, -box.h / 2 + pad + i * px * 1.2));
}

/** An arrow's head: how long and wide, in pixels. */
const arrowHead = (layer: ArrowLayer, W: number, H: number) => Math.max(8, layer.thickness * Math.min(W, H) * 4.5);

function drawArrow(ctx: CanvasRenderingContext2D, layer: ArrowLayer, W: number, H: number) {
  const L = layer.w * W;
  const t = Math.max(1.5, layer.thickness * Math.min(W, H));
  const head = Math.min(arrowHead(layer, W, H), L * 0.45);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.3)";
  ctx.shadowBlur = t * 1.5;
  ctx.shadowOffsetY = t * 0.4;
  ctx.strokeStyle = layer.color;
  ctx.fillStyle = layer.color;
  ctx.lineWidth = t;
  ctx.lineCap = "round";
  const from = layer.heads === "both" ? -L / 2 + head * 0.8 : -L / 2;
  ctx.beginPath();
  ctx.moveTo(from, 0);
  ctx.lineTo(L / 2 - head * 0.8, 0);
  ctx.stroke();
  const point = (x: number, dir: 1 | -1) => {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x - dir * head, -head * 0.55);
    ctx.lineTo(x - dir * head * 0.78, 0);
    ctx.lineTo(x - dir * head, head * 0.55);
    ctx.closePath();
    ctx.fill();
  };
  point(L / 2, 1);
  if (layer.heads === "both") point(-L / 2, -1);
  ctx.restore();
}

/** A colour of its own for each pin or strip (by its id), from `palette`, when none is chosen ("random"). */
const colourOf = (chosen: string | undefined, id: string, palette: string[], otherwise?: string) => (chosen && chosen !== "random" ? chosen : !chosen && otherwise ? otherwise : palette[Math.floor(seeded(id)() * palette.length)]);

/** A push pin's head, seen from above at an angle. */
function drawPin(ctx: CanvasRenderingContext2D, colour: string, size: number) {
  ctx.save();
  // Its shadow on the paper, off to the lower right, and the needle's.
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(size * 0.35, size * 0.45, size * 0.55, size * 0.4, 0.5, 0, Math.PI * 2);
  ctx.fill();
  const head = ctx.createRadialGradient(-size * 0.2, -size * 0.25, size * 0.08, 0, 0, size * 0.6);
  head.addColorStop(0, "#ffffff");
  head.addColorStop(0.25, colour);
  head.addColorStop(1, shade(colour, -0.35));
  ctx.fillStyle = head;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.55, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A colour lighter (amount > 0) or darker (< 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(Math.min(255, Math.max(0, amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/**
 * What holds a photo or a note up, over it, in its own space (the middle of a `w` × `h` box, turned
 * `rot`): pins near its edge (one in the middle of its top, or at its corners), or strips of tape across
 * its corners. A pin's head is seen from above, so it isn't turned with the picture.
 */
function drawFix(ctx: CanvasRenderingContext2D, fix: Fix, id: string, w: number, h: number, rot: number, u: number, tape: string) {
  const top = -h / 2;
  const corners = fix.where === "all" ? [[-1, -1], [1, -1], [-1, 1], [1, 1]] : fix.where === "top" ? [[-1, -1], [1, -1]] : null;
  if (fix.kind === "pin") {
    const m = Math.min(w, h) * 0.07;
    const at = corners ? corners.map(([sx, sy]) => [sx * (w / 2 - m), sy * (h / 2 - m)]) : [[0, top + m]];
    at.forEach(([x, y], i) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((-rot * Math.PI) / 180);
      drawPin(ctx, colourOf(fix.color, `${id}:${i}`, PIN_COLOURS), Math.max(7, u * 0.014));
      ctx.restore();
    });
    return;
  }
  // Washi tape, a little see-through: across each corner, its ends past both edges; one strip lies
  // across the middle of the top, half over the picture.
  const long = Math.min(w, h) * 0.34;
  const wide = Math.min(w, h) * 0.085;
  const strips = corners ? corners.map(([sx, sy]) => ({ x: (sx * w) / 2 - sx * wide * 0.15, y: (sy * h) / 2 - sy * wide * 0.15, a: -sx * sy * 42 })) : [{ x: 0, y: top, a: (seeded(id)() - 0.5) * 6 }];
  ctx.save();
  ctx.globalAlpha = 0.86;
  strips.forEach((s, i) => {
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate((s.a * Math.PI) / 180);
    ctx.fillStyle = colourOf(fix.color, `${id}:t${i}`, TAPE_COLOURS, tape);
    ctx.fillRect(-long / 2, -wide / 2, long, wide);
    ctx.restore();
  });
  ctx.restore();
}

type Paint = (c: CanvasRenderingContext2D, each: (line: string, x: number, y: number) => void) => void;

function drawText(ctx: CanvasRenderingContext2D, layer: TextLayer, H: number) {
  const look = lookById(layer.look);
  const { px, w, h } = textFit(ctx, layer, H);
  const lines = textLines(layer.text, layer.look);
  const cap = capOf(ctx, layer.font, px) * px;
  const fill = layer.color ?? look.fill;
  // Each line where it goes in `c` (the text's middle at the origin): its capitals centred on the line.
  const letters: Paint = (c, each) => {
    c.font = fontCss(layer.font, px);
    setSpacing(c, look.spacing ?? 0, px);
    c.textAlign = layer.align;
    c.textBaseline = "alphabetic";
    const maxW = Math.max(...lines.map((l) => c.measureText(l).width));
    const x = layer.align === "left" ? -maxW / 2 : layer.align === "right" ? maxW / 2 : 0;
    const top = -((lines.length - 1) * px * LINE) / 2;
    lines.forEach((l, i) => each(l, x, top + i * px * LINE + cap / 2));
  };
  if (look.glitch) return drawGlitch(ctx, layer, look.glitch, px, w, h, fill, letters);
  ctx.lineJoin = "round";
  const pass = (color: string, stroke: string | null, dx: number, dy: number) =>
    letters(ctx, (l, x, y) => {
      if (stroke && look.strokeWidth > 0) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = look.strokeWidth * px * 2;
        ctx.strokeText(l, x + dx, y + dy);
      }
      ctx.fillStyle = color;
      ctx.fillText(l, x + dx, y + dy);
    });
  // A hard ink shadow (manga) under the letters, outline and all.
  if (look.shadow) pass(look.shadow.color, look.shadow.color, look.shadow.x * px, look.shadow.y * px);
  if (look.glow) {
    ctx.save();
    ctx.shadowColor = look.glow;
    ctx.shadowBlur = px * 0.22;
    pass(fill, look.stroke, 0, 0);
    ctx.restore();
  }
  pass(fill, look.stroke, 0, 0);
}

/**
 * Night City's lettering: a copy in each glitch colour split to either side, the letters over them
 * with a thin hard outline, scanlines across, and a slice or two knocked sideways. Drawn apart at the
 * page's resolution, then laid down in strips.
 */
function drawGlitch(ctx: CanvasRenderingContext2D, layer: TextLayer, glitch: { left: string; right: string }, px: number, w: number, h: number, fill: string, letters: Paint) {
  const look = lookById(layer.look);
  const m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null;
  const s = m && Number.isFinite(m.a) ? Math.min(4, Math.max(1, Math.hypot(m.a, m.b))) : 1;
  const margin = px * 0.3;
  const ow = w + margin * 2;
  const oh = h + margin * 2;
  const [off, o] = canvasOf(Math.ceil(ow * s), Math.ceil(oh * s));
  o.scale(s, s);
  o.translate(ow / 2, oh / 2);
  const split = px * 0.04;
  const depth = px * 0.07;
  o.lineJoin = "miter";
  o.lineWidth = look.strokeWidth * px * 2;
  // A hard block shadow down and to the right, in the second colour.
  o.fillStyle = o.strokeStyle = glitch.right;
  letters(o, (l, x, y) => {
    o.strokeText(l, x + depth, y + depth);
    o.fillText(l, x + depth, y + depth);
  });
  // The first colour split off to the left.
  o.globalAlpha = 0.9;
  o.fillStyle = glitch.left;
  letters(o, (l, x, y) => o.fillText(l, x - split, y));
  o.globalAlpha = 1;
  o.strokeStyle = look.stroke;
  o.fillStyle = fill;
  letters(o, (l, x, y) => {
    if (look.strokeWidth > 0) o.strokeText(l, x, y);
    o.fillText(l, x, y);
  });
  // A slice or two knocked sideways (the first tinted in the first colour), the same each time for this text.
  const rnd = seeded(`${layer.id}:${layer.text}`);
  const bands: [number, number, number][] = [];
  for (let i = 0; i < 2; i++) {
    const y0 = 0.25 + rnd() * 0.45;
    bands.push([y0, Math.min(1, y0 + 0.04 + rnd() * 0.06), (i ? -1 : 1) * px * (0.08 + rnd() * 0.08)]);
  }
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.globalCompositeOperation = "source-atop";
  o.fillStyle = glitch.left;
  o.globalAlpha = 0.65;
  o.fillRect(0, bands[0][0] * off.height, off.width, (bands[0][1] - bands[0][0]) * off.height);
  o.globalAlpha = 1;
  // Scanlines: faint darker rows across the letters only.
  o.fillStyle = "rgba(0, 0, 0, 0.13)";
  const step = Math.max(2, px * 0.06 * s);
  for (let y = 0; y < off.height; y += step) o.fillRect(0, y, off.width, step * 0.35);
  const cuts = [...new Set([0, 1, ...bands.flatMap(([a, b]) => [a, b])])].sort((a, b) => a - b);
  ctx.save();
  if (look.glow) {
    ctx.shadowColor = look.glow;
    ctx.shadowBlur = px * 0.12;
  }
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    if ((b - a) * off.height < 0.5) continue;
    const band = bands.find(([y0, y1]) => (a + b) / 2 >= y0 && (a + b) / 2 < y1);
    ctx.drawImage(off, 0, a * off.height, off.width, (b - a) * off.height, -ow / 2 + (band ? band[2] : 0), -oh / 2 + a * oh, ow, (b - a) * oh);
  }
  ctx.restore();
}

export function drawLayer(ctx: CanvasRenderingContext2D, layer: Layer, W: number, H: number, assets: AssetCache) {
  ctx.save();
  ctx.translate(layer.x * W, layer.y * H);
  ctx.rotate((layer.rot * Math.PI) / 180);
  if (layer.type === "text") {
    drawText(ctx, layer, H);
    ctx.restore();
    return;
  }
  if (layer.type === "note" || layer.type === "arrow") {
    if (layer.type === "note") {
      drawNote(ctx, layer, W);
      if (layer.fix) {
        const { w: nw, h: nh } = layerSize(ctx, layer, W, H);
        drawFix(ctx, layer.fix, layer.id, nw, nh, layer.rot, Math.min(W, H), CLASSIC_FRAME.tape);
      }
    } else drawArrow(ctx, layer, W, H);
    ctx.restore();
    return;
  }
  const w = layer.w * W;
  const h = w * layer.aspect;
  if (layer.type === "photo") {
    const img = assets.photo(layer);
    // A library picture gone since it was pointed at: a gap with a dashed edge where it was.
    if (!img && assets.missing(layer)) {
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      ctx.setLineDash([w * 0.04, w * 0.03]);
      ctx.lineWidth = Math.max(1, w * 0.01);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      ctx.restore();
      return;
    }
    const f = layer.look ? lookById(layer.look).frame : CLASSIC_FRAME;
    // The frame's (or the bare photo's) shadow: soft, a hard ink one, or a glow.
    const shade = (strength: number) => {
      if (f.shadow === "glow") {
        ctx.shadowColor = f.tint ?? "#ffffff";
        ctx.shadowBlur = w * 0.07;
      } else if (f.shadow === "hard") {
        ctx.shadowColor = f.tint ?? "#000000";
        ctx.shadowOffsetX = w * 0.025;
        ctx.shadowOffsetY = w * 0.025;
      } else {
        ctx.shadowColor = `rgba(0,0,0,${0.3 * strength})`;
        ctx.shadowBlur = w * 0.04 * strength;
        ctx.shadowOffsetY = w * 0.015 * strength;
      }
    };
    const edge = (x: number, y: number, ew: number, eh: number) => {
      if (!f.edge || !f.edgeWidth) return;
      ctx.strokeStyle = f.edge;
      ctx.lineWidth = Math.max(1, f.edgeWidth * w);
      ctx.strokeRect(x, y, ew, eh);
    };
    if (layer.frame === "polaroid") {
      const { w: fw, h: fh } = layerSize(ctx, layer, W, H);
      ctx.save();
      shade(1);
      ctx.fillStyle = f.paper;
      ctx.fillRect(-fw / 2, -fh / 2, fw, fh);
      ctx.restore();
      if (img) ctx.drawImage(img, -w / 2, -fh / 2 + w * 0.05, w, h);
      edge(-fw / 2, -fh / 2, fw, fh);
    } else {
      ctx.save();
      shade(0.75);
      if (img) ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
      edge(-w / 2, -h / 2, w, h);
    }
    // Pinned or taped up, as it says ("tape" as a frame: a cover from before, taped at its top corners).
    const fix = layer.fix ?? (layer.frame === "tape" ? ({ kind: "tape", where: "top" } as const) : null);
    if (fix) {
      const box = layer.frame === "polaroid" ? layerSize(ctx, layer, W, H) : { w, h };
      drawFix(ctx, fix, layer.id, box.w, box.h, layer.rot, Math.min(W, H), f.tape);
    }
    ctx.restore();
    return;
  }
  const img = assets.sticker(layer);
  if (img) {
    if (layer.flip) ctx.scale(-1, 1);
    const look = layer.look === ORIGINAL ? null : lookById(layer.look);
    const { w: iw } = sizeOf(img);
    // The cut edge is about 3% of the sticker's width, drawn at the picture's own resolution.
    const edgePx = (iw * 0.035) | 0;
    const key = "blob" in layer.src ? `blob:${layer.src.blob}` : `${layer.src.builtin}:${layer.look}`;
    const shown = layer.outline ? assets.edged(key, img, look?.edge ?? "#ffffff", edgePx) : img;
    const scale = w / iw;
    const { w: sw, h: sh } = sizeOf(shown);
    ctx.save();
    if (look?.stickerGlow) {
      ctx.shadowColor = look.stickerGlow;
      ctx.shadowBlur = w * 0.08;
    } else if (layer.outline) {
      ctx.shadowColor = "rgba(0,0,0,0.28)";
      ctx.shadowBlur = w * 0.05;
      ctx.shadowOffsetY = w * 0.02;
    }
    ctx.drawImage(shown, (-sw * scale) / 2, (-sh * scale) / 2, sw * scale, sh * scale);
    ctx.restore();
    void h;
  }
  ctx.restore();
}

export function drawPage(ctx: CanvasRenderingContext2D, doc: ScrapDoc, W: number, H: number, assets: AssetCache) {
  drawBackdrop(ctx, doc, W, H, assets);
  drawLayers(ctx, doc, W, H, assets, false);
}

/** The page's background and bars alone: what stays put while things on it are moved (the editor keeps it on a canvas of its own). */
export function drawBackdrop(ctx: CanvasRenderingContext2D, doc: Pick<ScrapDoc, "background" | "bars">, W: number, H: number, assets: AssetCache) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  drawBackground(ctx, doc.background, doc.bars ?? [], W, H, assets);
  drawBars(ctx, doc.bars ?? [], W, H);
  ctx.restore();
}

/** What is on the page, over its backdrop (`clear`: on a canvas of their own, cleared first). */
export function drawLayers(ctx: CanvasRenderingContext2D, doc: Pick<ScrapDoc, "layers">, W: number, H: number, assets: AssetCache, clear = true) {
  ctx.save();
  if (clear) ctx.clearRect(0, 0, W, H);
  for (const layer of doc.layers) drawLayer(ctx, layer, W, H, assets);
  ctx.restore();
}

/** The topmost layer under a point of the page (in pixels), if any. */
export function layerAt(ctx: CanvasRenderingContext2D, doc: ScrapDoc, W: number, H: number, px: number, py: number): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    const { w, h } = layerSize(ctx, l, W, H);
    const a = (-l.rot * Math.PI) / 180;
    const dx = px - l.x * W;
    const dy = py - l.y * H;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return l;
  }
  return null;
}

/** Every font a cover's text uses, loaded (canvas text draws in a fallback until then). */
export async function fontsReady(doc: ScrapDoc): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  const wanted = new Set(doc.layers.flatMap((l) => (l.type === "text" ? [fontCss(l.font, 48)] : l.type === "note" ? [fontCss(NOTE_FONT, 48)] : [])));
  await Promise.all([...wanted].map((f) => document.fonts.load(f).catch(() => [])));
}

export { fontById };
