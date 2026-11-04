import React from "react";
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Inter";
import scenes from "../public/scenes.json";

/** Inter, the same wherever the video is rendered (a Mac, or Linux in CI). */
export const FONT = loadFont("normal", { weights: ["400", "500", "600"], subsets: ["latin"] }).fontFamily;
export const INK = "#e8eaf0";
export const DIM = "rgba(232, 234, 240, 0.62)";
export const ACCENT = "#8fb4ff";

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
export const frame = (id: string): Frame => {
  const f = (scenes.frames as Frame[]).find((x) => x.id === id);
  if (!f) throw new Error(`No frame "${id}": run npm run capture`);
  return f;
};

/** The ground everything stands on: a deep blue-black with a soft light from the top left. */
export function Backdrop({ children }: { children?: React.ReactNode }) {
  return <AbsoluteFill style={{ background: "radial-gradient(ellipse at 28% 18%, #1f2a3d 0%, #121722 45%, #0a0c11 100%)", fontFamily: FONT, color: INK }}>{children}</AbsoluteFill>;
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

/** Fades in over `inFor` frames and out over the last `outFor` of `length`. */
export function useFade(length: number, inFor = 12, outFor = 12) {
  const t = useCurrentFrame();
  return interpolate(t, [0, inFor, length - outFor, length], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

/** What a part shows, under the window. */
export function Caption({ text, length }: { text: string; length: number }) {
  const t = useCurrentFrame();
  const o = useFade(length, 14, 12);
  const y = interpolate(t, [0, 14], [10, 0], { extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 46, textAlign: "center", fontSize: 34, fontWeight: 500, letterSpacing: 0.2, opacity: o, transform: `translateY(${y}px)` }}>
      {text}
    </div>
  );
}

/** A key pressed: a keycap that pops in, with what it did beside it. */
export function Keycap({ label, note }: { label: string; note?: string }) {
  const t = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: t, fps, config: { damping: 14, stiffness: 180 } });
  const press = interpolate(t, [4, 8, 12], [1, 0.9, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", right: 40, bottom: 120, display: "flex", alignItems: "center", gap: 18, opacity: s, transform: `scale(${0.8 + 0.2 * s})`, transformOrigin: "right bottom" }}>
      {note && <span style={{ fontSize: 28, fontWeight: 500, padding: "10px 18px", borderRadius: 10, background: "rgba(10,12,17,0.82)", border: "1px solid rgba(255,255,255,0.12)" }}>{note}</span>}
      <span
        style={{
          minWidth: 72,
          height: 72,
          padding: "0 14px",
          borderRadius: 14,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 36,
          fontWeight: 600,
          background: "linear-gradient(#2a3140, #1c212c)",
          border: "1px solid rgba(255,255,255,0.18)",
          boxShadow: "0 6px 0 #0b0e14, 0 10px 30px rgba(0,0,0,0.5)",
          transform: `scale(${press})`,
        }}
      >
        {label}
      </span>
    </div>
  );
}

/** The pointer, moving from `from` to `to` (window pixels) and clicking there at `clickAt`. */
export function Cursor({ from, to, arriveAt, clickAt }: { from: { x: number; y: number }; to: { x: number; y: number }; arriveAt: number; clickAt: number }) {
  const t = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: t, fps, durationInFrames: arriveAt, config: { damping: 200 } });
  const x = from.x + (to.x - from.x) * p;
  const y = from.y + (to.y - from.y) * p;
  const ring = interpolate(t, [clickAt, clickAt + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const press = interpolate(t, [clickAt - 2, clickAt + 2, clickAt + 6], [1, 0.85, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <>
      {t >= clickAt && <div style={{ position: "absolute", left: to.x - 30, top: to.y - 30, width: 60, height: 60, borderRadius: 30, border: `3px solid ${ACCENT}`, opacity: 1 - ring, transform: `scale(${0.4 + ring})` }} />}
      <svg width={34} height={34} viewBox="0 0 24 24" style={{ position: "absolute", left: x - 6, top: y - 3, transform: `scale(${press})`, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.6))" }}>
        <path d="M5 2l14 11.5-6.2.6 3.7 7.4-2.9 1.4-3.6-7.5L5 20z" fill="#fff" stroke="#000" strokeWidth={1.2} strokeLinejoin="round" />
      </svg>
    </>
  );
}

/** The mark and the name, as on the title and the end. */
export function Mark({ size }: { size: number }) {
  return <Img src={staticFile("mark.svg")} style={{ width: size, height: size }} />;
}
