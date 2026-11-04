import React from "react";
import { AbsoluteFill, Easing, Sequence, Series, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { ACCENT, AppWindow, Backdrop, Caption, Cursor, DIM, Keycap, Mark, Screen, ScenesContext, useFade, useFrames, type Frame, type Scenes } from "./look";

/** A demo's video as its script.json describes it: a title, parts of captured frames, an end. */
export interface Script {
  name: string;
  repository: string;
  title: { title: string; line: string };
  parts: PartSpec[];
  end: { title: string; lines: string[]; link?: string };
  /** The screenshots: a name each, and the frame it shows. */
  stills: Record<string, string>;
  /** The looping clip: from where in the video, how long, in seconds. */
  loop: { from: number; length: number };
}
interface PartSpec {
  caption: string;
  /** In frames, at 30 a second. */
  length: number;
  /** The camera easing from one zoom to the other about `origin`, over the part. */
  zoom?: [number, number];
  origin?: string;
  /** The first frame's grid scrolled through, with a taller capture of the same screen. */
  scroll?: { tall: string; from: number; to: number; share: number };
  /** The frames in turn: each cross-fades in at `at`; `click` brings the pointer to its click. */
  steps: { frame: string; at?: number; click?: boolean }[];
}
export type DemoProps = {
  script: Script;
  scenes: Scenes;
};

/** The window, as wide as the app was captured (so a click's place in it is its place here). */
const WIN = 1440;
const TOP = 28;
/** Parts cross-fade over this many frames. */
const OVERLAP = 12;
const TITLE = 90;
const END = 110;

export const demoFrames = (s: Script) => TITLE + s.parts.reduce((a, p) => a + p.length, 0) + END - OVERLAP * (s.parts.length + 1);

/** The window on the backdrop, the camera easing from one zoom to another about a point. */
function Stage({ length, zoom = [1, 1], origin = "50% 50%", children }: { length: number; zoom?: [number, number]; origin?: string; children: React.ReactNode }) {
  const t = useCurrentFrame();
  const s = interpolate(t, [0, length], zoom, { easing: Easing.inOut(Easing.cubic), extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: (1920 - WIN) / 2, top: TOP, transform: `scale(${s})`, transformOrigin: origin }}>
      <AppWindow width={WIN}>{children}</AppWindow>
    </div>
  );
}

/** A taller capture of the first frame's screen, scrolled inside its grid (the bars and the sidebar stay). */
function Scroll({ base, tall, from, to, share }: { base: Frame; tall: Frame; from: number; to: number; share: number }) {
  const t = useCurrentFrame();
  const grid = base.grid ?? { x: 0, y: 0, w: WIN, h: 900 };
  const top = interpolate(t, [from, to], [0, (tall.height - 900) * share], { easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "absolute", left: grid.x, top: grid.y, width: grid.w, height: grid.h, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: -grid.x, top: -grid.y, width: WIN }}>
        <Screen f={tall} top={top} />
      </div>
    </div>
  );
}

function PartView({ spec }: { spec: PartSpec }) {
  const t = useCurrentFrame();
  const frameOf = useFrames();
  const length = spec.length;
  const steps = spec.steps.map((s) => ({ f: frameOf(s.frame), at: s.at ?? 0, click: s.click }));
  const until = (i: number) => (steps[i + 1]?.at ?? length) - steps[i].at;
  return (
    <AbsoluteFill style={{ opacity: useFade(length, OVERLAP, OVERLAP) }}>
      <Stage length={length} zoom={spec.zoom} origin={spec.origin}>
        {steps.map((s, i) => (
          <React.Fragment key={s.f.id}>
            <Screen f={s.f} opacity={i === 0 ? 1 : interpolate(t, [s.at, s.at + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
            {i === 0 && spec.scroll && <Scroll base={s.f} tall={frameOf(spec.scroll.tall)} from={spec.scroll.from} to={spec.scroll.to} share={spec.scroll.share} />}
          </React.Fragment>
        ))}
        {steps.map((s, i) =>
          s.f.key ? (
            <Sequence key={`k${s.f.id}`} from={s.at} durationInFrames={until(i)} layout="none">
              <Keycap label={s.f.key} note={s.f.note} />
            </Sequence>
          ) : null,
        )}
        {steps.map((s, i) =>
          s.click && s.f.click ? (
            <Sequence key={`c${s.f.id}`} from={s.at} durationInFrames={until(i)} layout="none">
              <Cursor from={{ x: s.f.click.x + 320, y: s.f.click.y + 300 }} to={s.f.click} arriveAt={30} clickAt={36} />
            </Sequence>
          ) : null,
        )}
      </Stage>
      <Caption text={spec.caption} length={length} />
    </AbsoluteFill>
  );
}

function Title({ title, line }: Script["title"]) {
  const t = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: t, fps, config: { damping: 18 } });
  const rise = spring({ frame: t - 14, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: useFade(TITLE, 1, OVERLAP) }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28, opacity: s, transform: `scale(${0.92 + 0.08 * s})` }}>
        <Mark size={210} />
        <div style={{ fontSize: 96, fontWeight: 600, letterSpacing: 4 }}>{title}</div>
        <div style={{ fontSize: 36, color: DIM, opacity: rise, transform: `translateY(${(1 - rise) * 12}px)` }}>{line}</div>
      </div>
    </AbsoluteFill>
  );
}

function End({ title, lines, link }: Script["end"]) {
  const t = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: t, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: useFade(END, OVERLAP, 1) }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, opacity: s }}>
        <Mark size={150} />
        <div style={{ fontSize: 76, fontWeight: 600, letterSpacing: 3 }}>{title}</div>
        {lines.map((l) => (
          <div key={l} style={{ fontSize: 32, color: DIM }}>
            {l}
          </div>
        ))}
        {link && <div style={{ fontSize: 32, color: ACCENT, marginTop: 8 }}>{link}</div>}
      </div>
    </AbsoluteFill>
  );
}

export function Demo({ script, scenes }: DemoProps) {
  return (
    <ScenesContext.Provider value={scenes}>
      <Backdrop>
        <Series>
          <Series.Sequence durationInFrames={TITLE}>
            <Title {...script.title} />
          </Series.Sequence>
          {script.parts.map((p, i) => (
            <Series.Sequence key={i} durationInFrames={p.length} offset={-OVERLAP}>
              <PartView spec={p} />
            </Series.Sequence>
          ))}
          <Series.Sequence durationInFrames={END} offset={-OVERLAP}>
            <End {...script.end} />
          </Series.Sequence>
        </Series>
      </Backdrop>
    </ScenesContext.Provider>
  );
}
