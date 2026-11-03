/**
 * The brush a plugin's panel puts on the viewer: strokes in fractions of the
 * image, painted into PNG masks for the plugin.
 */

export type Pt = { x: number; y: number };
export type Stroke = { points: Pt[]; radius: number; loop: boolean; mode: string | null };

/** The brush, as a fraction of the image's width. */
export const RADIUS = { min: 0.004, max: 0.12, start: 0.02 };
/** The masks handed over are this wide (their height follows the image). */
const MASK_WIDTH = 1024;

/** A stroke that comes back to where it began and encloses more than it paints is a circle around something. */
export function isLoop(s: Stroke, aspect: number): boolean {
  const pts = s.points;
  if (pts.length < 12) return false;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(first.x - last.x, (first.y - last.y) * aspect) > Math.max(3 * s.radius, 0.03)) return false;
  let area = 0;
  let length = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y * aspect - b.x * a.y * aspect;
    if (i + 1 < pts.length) length += Math.hypot(b.x - a.x, (b.y - a.y) * aspect);
  }
  return Math.abs(area) / 2 > 1.5 * length * 2 * s.radius;
}

/** The strokes of each mode painted into a PNG, white where painted. */
export async function paintMasks(strokes: Stroke[], aspect: number): Promise<Record<string, Uint8Array>> {
  const byMode = new Map<string, Stroke[]>();
  for (const s of strokes) byMode.set(s.mode ?? "", [...(byMode.get(s.mode ?? "") ?? []), s]);
  const masks: Record<string, Uint8Array> = {};
  for (const [m, own] of byMode) {
    const png = await paint(own, aspect);
    if (png) masks[m] = png;
  }
  return masks;
}

function paint(strokes: Stroke[], aspect: number): Promise<Uint8Array | null> {
  const w = MASK_WIDTH;
  const h = Math.max(8, Math.round(w * aspect));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    ctx.lineWidth = 2 * s.radius * w;
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
    if (s.loop) {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
  }
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== "function") return resolve(null);
    canvas.toBlob(async (blob) => resolve(blob ? new Uint8Array(await blob.arrayBuffer()) : null), "image/png");
  });
}
