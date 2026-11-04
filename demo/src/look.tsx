import React, { createContext, useContext } from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";

/** Inter, the same wherever the video is rendered (a Mac, or Linux in CI). */
export const FONT = loadFont("normal", { weights: ["400", "500", "600"], subsets: ["latin"] }).fontFamily;
export const INK = "#e8eaf0";
export const DIM = "rgba(232, 234, 240, 0.62)";
export const ACCENT = "#8fb4ff";

/** How much slower than its script's frames a video plays: every timing in it is stretched by this. */
export const PACE = 1.38;
/** The moment, in the script's frames (the video's frame, slowed by PACE). */
export const useTime = () => useCurrentFrame() / PACE;
/** A number of the script's frames, as the video's. */
export const frames = (n: number) => Math.round(n * PACE);

/** A frame the capture made, by its id. */
export interface Frame {
  id: string;
  file: string;
  width: number;
  height: number;
  key?: string;
  note?: string;
  click?: { x: number; y: number } | null;
  /** Where the screen's grid scrolls, in window pixels. */
  grid?: { x: number; y: number; w: number; h: number } | null;
}
/** The capture's frames (its public/scenes.json), as the renderer was given them. */
export interface Scenes {
  scale: number;
  frames: Frame[];
}
export const ScenesContext = createContext<Scenes>({ scale: 2, frames: [] });
/** A frame of the capture, by its id. */
export function useFrames(): (id: string) => Frame {
  const { frames } = useContext(ScenesContext);
  return (id) => {
    const f = frames.find((x) => x.id === id);
    if (!f) throw new Error(`No frame "${id}": capture first`);
    return f;
  };
}

/** The ground everything stands on: near black, with a soft light from above. */
export function Backdrop({ children }: { children?: React.ReactNode }) {
  return <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 0%, #1c2433 0%, #0d1119 50%, #050609 100%)", fontFamily: FONT, color: INK }}>{children}</AbsoluteFill>;
}

/** The app's window: a title bar with its three lights, the app below it (1440 × 900, as captured). */
export const BAR = 30;
export function AppWindow({ width, children }: { width: number; children: React.ReactNode }) {
  return (
    <div style={{ width, borderRadius: 12, overflow: "hidden", background: "#0e1118", boxShadow: "0 40px 100px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.08)" }}>
      <div style={{ height: BAR, display: "flex", alignItems: "center", gap: 8, padding: "0 13px", background: "#191d26", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
        ))}
      </div>
      <div style={{ position: "relative", width, height: width / 1.6, overflow: "hidden" }}>{children}</div>
    </div>
  );
}

/** A captured frame filling the window's width, from `top` (in its own pixels) down. */
export function Screen({ f, top = 0, opacity = 1 }: { f: Frame; top?: number; opacity?: number }) {
  return <Img src={staticFile(f.file)} style={{ position: "absolute", left: 0, top: -top, width: "100%", height: "auto", opacity }} />;
}

const RISE = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) } as const;

/**
 * A part's headline over the window: its words rising in one after another from `delay`, the line under
 * it after them. It goes in the first half of its last `outFor` frames, before the next one comes.
 */
export function Headline({ text, line, length, delay, outFor }: { text: string; line?: string; length: number; delay: number; outFor: number }) {
  const t = useTime();
  const words = text.split(" ");
  const shown = (from: number) => interpolate(t, [delay + from, delay + from + 10], [0, 1], RISE);
  const out = interpolate(t, [length - outFor, length - outFor / 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const under = shown(6 + 2 * words.length);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 50, textAlign: "center", textShadow: "0 2px 20px rgba(5,6,9,0.7)", opacity: out, transform: `translateY(${(out - 1) * 12}px)` }}>
      <div style={{ fontSize: 68, fontWeight: 600, letterSpacing: -1.5, lineHeight: 1.1 }}>
        {words.map((w, i) => {
          const p = shown(2 * i);
          return (
            <React.Fragment key={i}>
              {i > 0 && " "}
              <span style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 28}px)`, filter: p < 1 ? `blur(${(1 - p) * 8}px)` : undefined }}>{w}</span>
            </React.Fragment>
          );
        })}
      </div>
      {line && <div style={{ marginTop: 12, fontSize: 32, color: DIM, opacity: under, transform: `translateY(${(1 - under) * 14}px)` }}>{line}</div>}
    </div>
  );
}

/** A key pressed: a keycap that pops in beside the window (in the `width` to its right), what it did under it. */
export function Keycap({ label, note, width }: { label: string; note?: string; width: number }) {
  const t = useTime();
  const { fps } = useVideoConfig();
  const s = spring({ frame: t, fps, config: { damping: 14, stiffness: 200 } });
  const press = interpolate(t, [3, 6, 10], [1, 0.88, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", right: 0, width, top: 520, display: "flex", flexDirection: "column", alignItems: "center", gap: 18, opacity: Math.min(1, s), transform: `scale(${0.7 + 0.3 * s})` }}>
      <span
        style={{
          minWidth: 96,
          height: 96,
          padding: "0 20px",
          borderRadius: 18,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 48,
          fontWeight: 600,
          background: "linear-gradient(#2c3342, #1c212c)",
          border: "1px solid rgba(255,255,255,0.2)",
          boxShadow: "0 7px 0 #0b0e14, 0 14px 40px rgba(0,0,0,0.6)",
          transform: `translateY(${(1 - press) * 40}px) scale(${press})`,
        }}
      >
        {label}
      </span>
      {note && <span style={{ fontSize: 30, fontWeight: 500, color: INK, padding: "8px 16px", borderRadius: 10, background: "rgba(5,6,9,0.78)" }}>{note}</span>}
    </div>
  );
}

/** Where the pointer clicks at a moment of a part (arriving then, the click a moment after). */
export type PointerMark = { t: number; x: number; y: number };

/** The pointer through a part (window pixels): in from the lower right to the first click, then on from click to click; gone at `until`. */
export function Pointer({ marks, until }: { marks: PointerMark[]; until: number }) {
  const t = useTime();
  if (!marks.length || t >= until) return null;
  const all = [{ t: marks[0].t - 16, x: marks[0].x + 260, y: marks[0].y + 240 }, ...marks];
  if (t < all[0].t) return null;
  let a = 0;
  while (a + 1 < all.length && all[a + 1].t <= t) a++;
  const [from, to] = [all[a], all[a + 1] as PointerMark | undefined];
  const p = to ? Easing.inOut(Easing.cubic)(Math.min(1, (t - from.t) / (to.t - from.t))) : 0;
  const x = to ? from.x + (to.x - from.x) * p : from.x;
  const y = to ? from.y + (to.y - from.y) * p : from.y;
  const click = marks.filter((m) => t >= m.t + 4).pop();
  const ring = click ? interpolate(t, [click.t + 4, click.t + 18], [0, 1], { extrapolateRight: "clamp" }) : 1;
  const tap = click ? interpolate(t, [click.t + 2, click.t + 5, click.t + 9], [1, 0.85, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
  const fade = interpolate(t, [until - 4, until], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ opacity: fade }}>
      {click && ring < 1 && <div style={{ position: "absolute", left: click.x - 30, top: click.y - 30, width: 60, height: 60, borderRadius: 30, border: `3px solid ${ACCENT}`, opacity: 1 - ring, transform: `scale(${0.4 + ring})` }} />}
      <svg width={34} height={34} viewBox="0 0 24 24" style={{ position: "absolute", left: x - 6, top: y - 3, transform: `scale(${tap})`, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.6))" }}>
        <path d="M5 2l14 11.5-6.2.6 3.7 7.4-2.9 1.4-3.6-7.5L5 20z" fill="#fff" stroke="#000" strokeWidth={1.2} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** The mark and the name, as on the title and the end. */
export function Mark({ size }: { size: number }) {
  return <Img src={staticFile("mark.svg")} style={{ width: size, height: size }} />;
}
