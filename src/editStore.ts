import { create } from "zustand";

/** Mirrors the Rust `Pipeline`. Crop is [x, y, w, h] as fractions of the rotated/flipped frame. */
export interface Pipeline {
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  crop: [number, number, number, number] | null;
  resizeWidth: number | null;
  upscale: 2 | 4 | null;
  trim: [number, number] | null;
  speed: number | null;
  mute: boolean;
  extractFrame: number | null;
  format: string | null;
  quality: "small" | "balanced" | "high";
}

export const EMPTY: Pipeline = { rotate: 0, flipH: false, flipV: false, crop: null, resizeWidth: null, upscale: null, trim: null, speed: null, mute: false, extractFrame: null, format: null, quality: "balanced" };

export const LOSSY = new Set(["jpg", "webp", "mp4-h264", "mp4-h265", "webm-vp9", "mp3"]);

export function isIdentity(p: Pipeline): boolean {
  return p.rotate === 0 && !p.flipH && !p.flipV && !p.crop && !p.resizeWidth && !p.upscale && !p.trim && !p.speed && !p.mute && p.extractFrame == null && !p.format;
}

export function describe(p: Pipeline): string[] {
  const out: string[] = [];
  if (p.rotate) out.push(`rotate ${p.rotate}°`);
  if (p.flipH) out.push("flip horizontal");
  if (p.flipV) out.push("flip vertical");
  if (p.crop) out.push(`crop ${Math.round(p.crop[2] * 100)}×${Math.round(p.crop[3] * 100)}%`);
  if (p.upscale) out.push(`upscale ${p.upscale}×`);
  else if (p.resizeWidth) out.push(`resize to ${p.resizeWidth}px wide`);
  if (p.trim) out.push(`trim ${p.trim[0].toFixed(1)}s–${p.trim[1].toFixed(1)}s`);
  if (p.speed) out.push(`speed ${p.speed}×`);
  if (p.mute) out.push("mute");
  if (p.extractFrame != null) out.push(`frame at ${p.extractFrame.toFixed(1)}s`);
  if (p.format) out.push(`convert to ${p.format.toUpperCase()}${LOSSY.has(p.format) ? ` (${p.quality})` : ""}`);
  return out;
}

interface EditState {
  pipeline: Pipeline;
  /** Crop tool armed: dragging on the preview draws the rectangle. */
  cropping: boolean;
  cropAspect: number | null;
  set(patch: Partial<Pipeline>): void;
  setState(patch: Partial<Pick<EditState, "cropping" | "cropAspect">>): void;
  reset(): void;
}

export const useEdit = create<EditState>((set) => ({
  pipeline: EMPTY,
  cropping: false,
  cropAspect: null,
  set: (patch) => set((s) => ({ pipeline: { ...s.pipeline, ...patch } })),
  setState: (patch) => set(patch),
  reset: () => set({ pipeline: EMPTY, cropping: false, cropAspect: null }),
}));
