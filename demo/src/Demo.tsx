import React from "react";
import { AbsoluteFill, Easing, Sequence, interpolate, spring, useVideoConfig } from "remotion";
import { ACCENT, AppWindow, BAR, Backdrop, DIM, Headline, Keycap, Mark, Pointer, Screen, ScenesContext, frames, useFrames, useTime, type Frame, type PointerMark, type Scenes } from "./look";

/** A demo's video as its script.json describes it: a title, parts of captured frames, an end. */
export interface Script {
  name: string;
  repository: string;
  title: { title: string; line: string };
  parts: PartSpec[];
  end: { title: string; lines: string[]; link?: string };
  /** The screenshots: a name each, and the frame it shows. */
  stills: Record<string, string>;
  /** The looping clip, when it's only part of the video: from where, how long, in seconds. */
  loop?: { from: number; length: number };
}
/** How a step's frame comes in: cross-fading, sliding in like a page, wiping across, or opening up. */
type Enter = "fade" | "slide" | "wipe" | "open";
interface PartSpec {
  /** The headline over the window, short, and the line under it. */
  caption: string;
  line?: string;
  /** In frames, at 30 a second. */
  length: number;
  /** The camera: from `at`, easing to `zoom` about `focus` (fractions of the window, kept until changed). */
  camera?: { at: number; zoom: number; focus?: [number, number] }[];
  /** The first frame's grid scrolled through, with a taller capture of the same screen. */
  scroll?: { tall: string; from: number; to: number; share: number };
  /** The frames in turn, each coming in at `at`; `click` brings the pointer to the frame's click (16 frames after `at`, or that many). */
  steps: { frame: string; at?: number; click?: boolean | number; enter?: Enter }[];
}
export type DemoProps = {
  script: Script;
  scenes: Scenes;
};

/** The window as captured (its title bar over 1440 × 900 of app), and where it stands in the video: under the headline. */
const WIN = 1440;
const WIN_H = BAR + 900;
const PLACE = { scale: 0.89, top: 228, left: (1920 - WIN * 0.89) / 2 };
/** The window stays while the parts go by: it rises in as the title leaves, and goes as the end comes. */
const TITLE = 60;
const ENTER = 14;
/** A part hands over to the next in this many frames. */
const CUT = 8;
const EXIT = 12;
const END = 75;
const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const OUT = { ...CLAMP, easing: Easing.out(Easing.cubic) };

/** Where each part starts in the window's time, and how long the window is shown. */
function timeline(parts: PartSpec[]) {
  const starts: number[] = [];
  let at = 0;
  for (const p of parts) {
    starts.push(at);
    at += p.length - CUT;
  }
  return { starts, length: at + CUT };
}

export const demoFrames = (s: Script) => frames(TITLE - ENTER + timeline(s.parts).length - EXIT + END);

type Shot = { t: number; zoom: number; focus: [number, number] };
/** The camera's keyframes: each part's moves, held until the next part takes over and easing back as it does. */
function shots(parts: PartSpec[], starts: number[], length: number): Shot[] {
  const out: Shot[] = [];
  parts.forEach((p, i) => {
    const moves = p.camera ?? [];
    const end = starts[i + 1] ?? length;
    let focus: [number, number] = moves[0]?.focus ?? [0.5, 0.5];
    for (const m of [{ at: 0, zoom: 1, focus }, ...moves]) {
      focus = m.focus ?? focus;
      out.push({ t: Math.min(end, starts[i] + Math.max(m.at, i === 0 ? 0 : CUT)), zoom: m.zoom, focus });
    }
    out.push({ ...out[out.length - 1], t: end });
  });
  return out;
}

function cameraAt(shots: Shot[], t: number) {
  let a = 0;
  while (a + 1 < shots.length && shots[a + 1].t <= t) a++;
  const [from, to] = [shots[a], shots[a + 1]];
  if (!to || t <= from.t) return from;
  const p = Easing.inOut(Easing.cubic)((t - from.t) / (to.t - from.t));
  const mix = (x: number, y: number) => x + (y - x) * p;
  return { zoom: mix(from.zoom, to.zoom), focus: [mix(from.focus[0], to.focus[0]), mix(from.focus[1], to.focus[1])] };
}

/** A taller capture of the first frame's screen, scrolled inside its grid (the bars and the sidebar stay). */
function Scroll({ base, tall, from, to, share }: { base: Frame; tall: Frame; from: number; to: number; share: number }) {
  const t = useTime();
  const grid = base.grid ?? { x: 0, y: 0, w: WIN, h: 900 };
  const top = interpolate(t, [from, to], [0, (tall.height - 900) * share], { ...CLAMP, easing: Easing.inOut(Easing.cubic) });
  return (
    <div style={{ position: "absolute", left: grid.x, top: grid.y, width: grid.w, height: grid.h, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: -grid.x, top: -grid.y, width: WIN }}>
        <Screen f={tall} top={top} />
      </div>
    </div>
  );
}

/** A step's frame `p` of the way in, and `pushed` of the way aside for a page sliding in after it. */
function entering(enter: Enter, p: number, pushed: number): React.CSSProperties {
  const aside = pushed ? ` translateX(${-pushed * 30}%)` : "";
  const dim = pushed ? `brightness(${1 - 0.5 * pushed})` : undefined;
  switch (enter) {
    case "slide":
      return { transform: `translateX(${(1 - p) * 100}%)${aside}`, filter: dim, boxShadow: p < 1 ? "-40px 0 80px rgba(0,0,0,0.6)" : undefined };
    case "wipe":
      return { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)`, transform: aside || undefined, filter: dim };
    case "open":
      return { opacity: p, transform: `scale(${0.93 + 0.07 * p})${aside}`, filter: dim };
    default:
      return { opacity: p, transform: aside || undefined, filter: dim };
  }
}

function steps(spec: PartSpec, frameOf: (id: string) => Frame) {
  const list = spec.steps.map((s) => ({ f: frameOf(s.frame), at: s.at ?? 0, click: s.click, enter: s.enter ?? "fade" }));
  return list.map((s, i) => ({ ...s, until: (list[i + 1]?.at ?? spec.length) - s.at }));
}

/** Where a part's pointer goes: to each click in turn; it goes once the step after the last has come. */
function pointerOf(list: ReturnType<typeof steps>, length: number) {
  const marks: PointerMark[] = list.flatMap((s) => (s.click && s.f.click ? [{ t: s.at + (s.click === true ? 16 : s.click), ...s.f.click }] : []));
  const last = marks[marks.length - 1];
  return { marks, until: last ? (list.find((s) => s.at > last.t)?.at ?? length) : 0 };
}

/** A part's frames in the window, each coming in at its step, and the pointer over them. */
function PartScreens({ spec, first }: { spec: PartSpec; first: boolean }) {
  const t = useTime();
  const frameOf = useFrames();
  const list = steps(spec, frameOf);
  const progress = (i: number) => (i === 0 ? 1 : interpolate(t, [list[i].at, list[i].at + (list[i].enter === "fade" ? 6 : 10)], [0, 1], OUT));
  return (
    <AbsoluteFill style={{ opacity: first ? 1 : interpolate(t, [0, CUT], [0, 1], CLAMP) }}>
      {list.map((s, i) => {
        if (t < s.at) return null;
        const p = progress(i);
        const pushed = list[i + 1]?.enter === "slide" ? progress(i + 1) : 0;
        return (
          <React.Fragment key={s.f.id}>
            <AbsoluteFill style={entering(s.enter, p, pushed)}>
              <Screen f={s.f} />
              {i === 0 && spec.scroll && <Scroll base={s.f} tall={frameOf(spec.scroll.tall)} from={spec.scroll.from} to={spec.scroll.to} share={spec.scroll.share} />}
            </AbsoluteFill>
            {s.enter === "wipe" && p < 1 && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${p * 100}%`, width: 3, marginLeft: -1, background: "#fff", opacity: Math.sin(Math.PI * p) * 0.8, boxShadow: "0 0 24px 6px rgba(255,255,255,0.35)" }} />}
          </React.Fragment>
        );
      })}
      <Pointer {...pointerOf(list, spec.length)} />
    </AbsoluteFill>
  );
}

/** The keys a part presses, beside the window. */
function Keys({ spec }: { spec: PartSpec }) {
  return (
    <>
      {steps(spec, useFrames()).map((s) =>
        s.f.key ? (
          <Sequence key={s.f.id} from={frames(s.at)} durationInFrames={frames(s.until)} layout="none">
            <Keycap label={s.f.key} note={s.f.note} width={PLACE.left} />
          </Sequence>
        ) : null,
      )}
    </>
  );
}

/** The app's window through every part, the camera moving over it, each part's headline above. */
function Show({ parts }: { parts: PartSpec[] }) {
  const t = useTime();
  const { fps } = useVideoConfig();
  const { starts, length } = timeline(parts);
  const cam = cameraAt(shots(parts, starts, length), t);
  const rise = spring({ frame: t, fps, durationInFrames: 24, config: { damping: 200 } });
  const leave = interpolate(t, [length - EXIT, length], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  const x = PLACE.left + PLACE.scale * cam.focus[0] * WIN * (1 - cam.zoom);
  const y = PLACE.top + PLACE.scale * cam.focus[1] * WIN_H * (1 - cam.zoom);
  // The window fades out above the window's own top, so a close-up never runs into the headline.
  const under = "linear-gradient(to bottom, transparent 110px, #000 226px)";
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ perspective: 2400, maskImage: under, WebkitMaskImage: under }}>
        <AbsoluteFill
          style={{
            opacity: Math.min(1, rise * 1.6) * (1 - leave),
            transform: `translateY(${(1 - rise) * 320}px) rotateX(${(1 - rise) * 24}deg) scale(${1 - 0.05 * leave})`,
            transformOrigin: "50% 60%",
          }}
        >
          <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${x}px, ${y}px) scale(${PLACE.scale * cam.zoom})` }}>
            <AppWindow width={WIN}>
              {parts.map((p, i) => (
                <Sequence key={i} from={frames(starts[i])} durationInFrames={frames(p.length)}>
                  <PartScreens spec={p} first={i === 0} />
                </Sequence>
              ))}
            </AppWindow>
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
      {parts.map((p, i) => (
        <Sequence key={i} from={frames(starts[i])} durationInFrames={frames(p.length)} layout="none">
          <Headline text={p.caption} line={p.line} length={p.length} delay={i === 0 ? 2 : CUT - 2} outFor={i === parts.length - 1 ? EXIT : CUT} />
          <Keys spec={p} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

function Title({ title, line }: Script["title"]) {
  const t = useTime();
  const { fps } = useVideoConfig();
  const s = spring({ frame: t, fps, durationInFrames: 18, config: { damping: 200 } });
  const track = interpolate(t, [0, 26], [22, 2], OUT);
  const rise = interpolate(t, [8, 20], [0, 1], OUT);
  const leave = interpolate(t, [TITLE - ENTER, TITLE], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - leave, transform: `translateY(${-leave * 60}px) scale(${1 + 0.06 * leave})` }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 26 }}>
        <div style={{ opacity: s, transform: `scale(${0.85 + 0.15 * s})` }}>
          <Mark size={200} />
        </div>
        <div style={{ fontSize: 104, fontWeight: 600, letterSpacing: track, marginRight: -track, opacity: s }}>{title}</div>
        <div style={{ fontSize: 38, color: DIM, opacity: rise, transform: `translateY(${(1 - rise) * 16}px)` }}>{line}</div>
      </div>
    </AbsoluteFill>
  );
}

function End({ title, lines, link }: Script["end"]) {
  const t = useTime();
  const come = interpolate(t, [0, 16], [0, 1], OUT);
  const track = interpolate(t, [0, 24], [16, 2], OUT);
  const later = (from: number) => {
    const p = interpolate(t, [from, from + 12], [0, 1], OUT);
    return { opacity: p, transform: `translateY(${(1 - p) * 14}px)` };
  };
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22, opacity: come, transform: `scale(${1.06 - 0.06 * come})` }}>
        <Mark size={150} />
        <div style={{ fontSize: 84, fontWeight: 600, letterSpacing: track, marginRight: -track }}>{title}</div>
        {lines.map((l, i) => (
          <div key={l} style={{ fontSize: 34, color: DIM, ...later(8 + 4 * i) }}>
            {l}
          </div>
        ))}
        {link && <div style={{ fontSize: 34, color: ACCENT, marginTop: 6, ...later(12 + 4 * lines.length) }}>{link}</div>}
      </div>
    </AbsoluteFill>
  );
}

export function Demo({ script, scenes }: DemoProps) {
  const show = timeline(script.parts).length;
  return (
    <ScenesContext.Provider value={scenes}>
      <Backdrop>
        <Sequence durationInFrames={frames(TITLE)}>
          <Title {...script.title} />
        </Sequence>
        <Sequence from={frames(TITLE - ENTER)} durationInFrames={frames(show)}>
          <Show parts={script.parts} />
        </Sequence>
        <Sequence from={frames(TITLE - ENTER + show - EXIT)} durationInFrames={frames(END)}>
          <End {...script.end} />
        </Sequence>
      </Backdrop>
    </ScenesContext.Provider>
  );
}
