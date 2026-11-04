/**
 * Finding the separate subjects in a cutout mask (how much each pixel belongs to a subject, 0..255,
 * from the engine's model) and cutting each out of the picture, as WhatsApp's stickers do. Where
 * the mask is cut (the sensitivity) can move: lower takes in more of what the model was unsure of.
 * A subject is made of parts: pieces the model found, or shapes drawn by hand (exactly, or the
 * model's subject inside them), so any can be merged into one.
 */

/** A piece of a subject: one the model found (its label), or a shape drawn by hand. */
export interface Part {
  label?: number;
  poly?: [number, number][];
  /** A drawn shape shaped by the mask inside it; else the shape is the cut, exactly. */
  useMask?: boolean;
}

export interface Subject {
  parts: Part[];
  /** Its box, in mask pixels: [x0, y0) to [x1, y1). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

/** Where the mask is cut unless told otherwise: halfway. */
export const MIDDLE = 128;

/** Subjects smaller than this share of the picture are specks, not subjects. */
const MIN_SHARE = 0.004;

/** The mask's separate subjects (4-connected parts at or over the cut), biggest first, up to `max`. */
export function findSubjects(mask: Uint8Array, W: number, H: number, max = 12, cut = MIDDLE): { labels: Int32Array; subjects: Subject[] } {
  const labels = new Int32Array(W * H);
  const found: Subject[] = [];
  const stack = new Int32Array(W * H);
  let next = 1;
  for (let start = 0; start < W * H; start++) {
    if (mask[start] < cut || labels[start]) continue;
    const label = next++;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    let area = 0;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    while (top) {
      const i = stack[--top];
      area++;
      const x = i % W;
      const y = (i / W) | 0;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
      const visit = (j: number) => {
        if (mask[j] >= cut && !labels[j]) {
          labels[j] = label;
          stack[top++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < W - 1) visit(i + 1);
      if (y > 0) visit(i - W);
      if (y < H - 1) visit(i + W);
    }
    found.push({ parts: [{ label }], x0, y0, x1, y1, area });
  }
  const min = Math.max(64, MIN_SHARE * W * H);
  return { labels, subjects: found.filter((s) => s.area >= min).sort((a, b) => b.area - a.area).slice(0, max) };
}

export function insidePolygon(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A subject drawn round by hand. `exact`: the shape is the cut. Otherwise it is shaped by the mask
 * inside it when the model saw something there (a fifth or more of it), else the shape itself.
 */
export function lassoSubject(mask: Uint8Array, W: number, H: number, poly: [number, number][], exact = false, cut = MIDDLE): Subject | null {
  if (poly.length < 3) return null;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs)) + 1);
  const y1 = Math.min(H, Math.ceil(Math.max(...ys)) + 1);
  let area = 0;
  let seen = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      if (!insidePolygon(poly, x + 0.5, y + 0.5)) continue;
      area++;
      if (mask[y * W + x] >= cut) seen++;
    }
  if (area < 16) return null;
  return { parts: [{ poly, useMask: !exact && seen >= area * 0.2 }], x0, y0, x1, y1, area };
}

/** Subjects as one: their parts together, their boxes joined. */
export function merge(subjects: Subject[]): Subject {
  return {
    parts: subjects.flatMap((s) => s.parts),
    x0: Math.min(...subjects.map((s) => s.x0)),
    y0: Math.min(...subjects.map((s) => s.y0)),
    x1: Math.max(...subjects.map((s) => s.x1)),
    y1: Math.max(...subjects.map((s) => s.y1)),
    area: subjects.reduce((a, s) => a + s.area, 0),
  };
}

/**
 * The mask with a closer look at one box of it (`part`, the box's own mask, rw × rh at rx, ry) taken in:
 * what the closer look found is added, and nothing already found is taken away. (Looking closer is for
 * what was missed; the model, seeing only part of the subject, often drops what it had right.)
 */
export function withCloserLook(mask: Uint8Array, W: number, part: ArrayLike<number>, rx: number, ry: number, rw: number, rh: number, stride = 1): Uint8Array {
  const out = new Uint8Array(mask);
  for (let y = 0; y < rh; y++)
    for (let x = 0; x < rw; x++) {
      const i = (ry + y) * W + rx + x;
      out[i] = Math.max(out[i], part[(y * rw + x) * stride]);
    }
  return out;
}

/** Whether a point of the picture (mask pixels) is on a subject. */
export function onSubject(s: Subject, labels: Int32Array, W: number, x: number, y: number): boolean {
  const l = labels[Math.floor(y) * W + Math.floor(x)];
  return s.parts.some((p) => (p.label != null ? p.label === l : !!p.poly && insidePolygon(p.poly, x, y)));
}

/**
 * The mask's value as a subject's opacity, the cut moved to `cut`: soft only over a narrow band round
 * it (twenty steps each way), so the edge is smooth and the subject itself fully solid. (A wide band
 * left whatever the model was a little unsure of see-through, the page showing through it like a
 * white veil.)
 */
const opacity = (m: number, cut: number) => Math.max(0, Math.min(255, Math.round(128 + (m - cut) * 6.4)));

/** How much of the picture belongs to a subject at a pixel: its own parts with their soft edges, never another subject's. */
export function alphaAt(mask: Uint8Array, labels: Int32Array, W: number, s: Subject, x: number, y: number, cut = MIDDLE): number {
  const i = y * W + x;
  const m = mask[i];
  const l = labels[i];
  let a = 0;
  for (const p of s.parts) {
    if (p.label != null) {
      if (l === p.label || (l === 0 && m > 0)) a = Math.max(a, opacity(m, cut));
    } else if (p.poly && insidePolygon(p.poly, x + 0.5, y + 0.5)) {
      a = Math.max(a, p.useMask ? (l === 0 || m >= cut ? opacity(m, cut) : 0) : 255);
    }
    if (a === 255) break;
  }
  return a;
}

/* ---------------- fine-tuning a sticker ---------------- */

/** A subject's piece of the picture to fine-tune: its box with room around it, and how much of each pixel it has. */
export interface Piece {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** RGBA of the picture in the box. */
  rgb: Uint8ClampedArray;
  /** The subject's own alpha in the box, before any tuning. */
  alpha: Uint8ClampedArray;
}

/** A brush stroke's dab, in the piece's pixels: keep (paint in) or erase. */
export interface Dab {
  x: number;
  y: number;
  r: number;
  keep: boolean;
  /** The stroke it belongs to (taken back together). */
  stroke?: number;
}

export interface Tune {
  /** Pixels to grow (+) or shrink (−) the edge by. */
  edge: number;
  /** Pixels of softness at the edge. */
  soft: number;
  dabs: Dab[];
}

export const NO_TUNE: Tune = { edge: 0, soft: 0, dabs: [] };

/** A subject's piece, with room around it (a tenth of its size, at least 16 px) for growing and painting. */
export function pieceOf(pixels: Uint8ClampedArray, mask: Uint8Array, labels: Int32Array, W: number, H: number, s: Subject, cut = MIDDLE): Piece {
  const pad = Math.round(Math.max(s.x1 - s.x0, s.y1 - s.y0) * 0.1) + 16;
  const x0 = Math.max(0, s.x0 - pad);
  const y0 = Math.max(0, s.y0 - pad);
  const w = Math.min(W, s.x1 + pad) - x0;
  const h = Math.min(H, s.y1 + pad) - y0;
  const rgb = new Uint8ClampedArray(w * h * 4);
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4;
      const di = y * w + x;
      rgb[di * 4] = pixels[si];
      rgb[di * 4 + 1] = pixels[si + 1];
      rgb[di * 4 + 2] = pixels[si + 2];
      rgb[di * 4 + 3] = 255;
      alpha[di] = Math.min(pixels[si + 3], alphaAt(mask, labels, W, s, x0 + x, y0 + y, cut));
    }
  return { x0, y0, w, h, rgb, alpha };
}

/** Distance (in pixels, roughly) from each pixel to the nearest one set in `on`: two passes, whatever the distance. */
function distanceTo(on: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  const far = w + h;
  for (let i = 0; i < w * h; i++) d[i] = on[i] ? 0 : far;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  return d;
}

/** A box blur `r` pixels wide, along rows then columns. */
function blur(a: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** The piece's alpha as tuned: the edge grown or shrunk, softened, then what was painted kept or erased. */
export function tuned(p: Piece, t: Tune): Uint8ClampedArray {
  return withDabs(tunedEdge(p, t.edge, t.soft), p.w, p.h, t.dabs);
}

/**
 * The piece's alpha with its edge grown or shrunk and softened, before any painting: the slow part of
 * tuning, kept by the fine-tune while a stroke is painted over it (the piece's own alpha when neither).
 */
export function tunedEdge(p: Piece, edge: number, soft: number): Uint8ClampedArray {
  const { w, h } = p;
  let a = p.alpha;
  if (edge !== 0) {
    const inside = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) inside[i] = a[i] >= 128 ? 1 : 0;
    const out = new Uint8ClampedArray(w * h);
    if (edge > 0) {
      const d = distanceTo(inside, w, h);
      for (let i = 0; i < w * h; i++) out[i] = d[i] <= edge ? 255 : a[i];
    } else {
      const outside = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) outside[i] = inside[i] ? 0 : 1;
      const d = distanceTo(outside, w, h);
      for (let i = 0; i < w * h; i++) out[i] = d[i] > -edge ? a[i] : 0;
    }
    a = out;
  }
  if (soft > 0) a = blur(blur(a, w, h, Math.round(soft)), w, h, Math.round(soft));
  return a;
}

/** What was painted, kept or erased, over an alpha: a copy (the alpha itself is left as it is). */
export function withDabs(alpha: Uint8ClampedArray, w: number, h: number, dabs: Dab[]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(alpha);
  for (const dab of dabs) {
    const r2 = dab.r * dab.r;
    for (let y = Math.max(0, Math.floor(dab.y - dab.r)); y <= Math.min(h - 1, Math.ceil(dab.y + dab.r)); y++)
      for (let x = Math.max(0, Math.floor(dab.x - dab.r)); x <= Math.min(w - 1, Math.ceil(dab.x + dab.r)); x++)
        if ((x - dab.x) ** 2 + (y - dab.y) ** 2 <= r2) a[y * w + x] = dab.keep ? 255 : 0;
  }
  return a;
}

/** The tuned sticker: RGBA cropped to what it shows (with a little room), or null when nothing is left. */
export function render(p: Piece, alpha: Uint8ClampedArray): { data: Uint8ClampedArray; w: number; h: number } | null {
  let x0 = p.w;
  let y0 = p.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++)
      if (alpha[y * p.w + x] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const m = 2;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(p.w - 1, x1 + m);
  y1 = Math.min(p.h - 1, y1 + m);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (y0 + y) * p.w + (x0 + x);
      const di = (y * w + x) * 4;
      data[di] = p.rgb[si * 4];
      data[di + 1] = p.rgb[si * 4 + 1];
      data[di + 2] = p.rgb[si * 4 + 2];
      data[di + 3] = alpha[si];
    }
  return { data, w, h };
}
