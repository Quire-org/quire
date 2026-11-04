import React from "react";
import { AbsoluteFill, Easing, Sequence, Series, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { ACCENT, AppWindow, Backdrop, Caption, Cursor, DIM, Keycap, Mark, Screen, frame, useFade, type Frame } from "./look";

/** The window, as wide as the app was captured (so a click's place in it is its place here). */
const WIN = 1440;
const TOP = 28;
/** Parts cross-fade over this many frames. */
const OVERLAP = 12;

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

/** One step of a part: its frame, shown from `at` (cross-fading in), with the key pressed to get there. */
interface Step {
  f: Frame;
  at: number;
}
function Steps({ steps, length }: { steps: Step[]; length: number }) {
  const t = useCurrentFrame();
  return (
    <>
      {steps.map((s, i) => (
        <Screen key={s.f.id} f={s.f} opacity={i === 0 ? 1 : interpolate(t, [s.at, s.at + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} />
      ))}
      {steps.map((s, i) =>
        s.f.key ? (
          <Sequence key={`k${s.f.id}`} from={s.at} durationInFrames={(steps[i + 1]?.at ?? length) - s.at} layout="none">
            <Keycap label={s.f.key} note={s.f.note} />
          </Sequence>
        ) : null,
      )}
    </>
  );
}

/** A part: fading in and out over the backdrop, its caption under the window. */
function Part({ length, caption, children }: { length: number; caption: string; children: React.ReactNode }) {
  const o = useFade(length, OVERLAP, OVERLAP);
  return (
    <AbsoluteFill style={{ opacity: o }}>
      {children}
      <Caption text={caption} length={length} />
    </AbsoluteFill>
  );
}

function Title({ length }: { length: number }) {
  const t = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: t, fps, config: { damping: 18 } });
  const line = spring({ frame: t - 14, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: useFade(length, 1, OVERLAP) }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28, opacity: s, transform: `scale(${0.92 + 0.08 * s})` }}>
        <Mark size={210} />
        <div style={{ fontSize: 96, fontWeight: 600, letterSpacing: 4 }}>Quire</div>
        <div style={{ fontSize: 36, color: DIM, opacity: line, transform: `translateY(${(1 - line) * 12}px)` }}>A private picture library for your drives</div>
      </div>
    </AbsoluteFill>
  );
}

function End({ length }: { length: number }) {
  const t = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: t, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: useFade(length, OVERLAP, 1) }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, opacity: s }}>
        <Mark size={150} />
        <div style={{ fontSize: 76, fontWeight: 600, letterSpacing: 3 }}>Quire</div>
        <div style={{ fontSize: 32, color: DIM }}>Free and open source, for macOS, Windows and Linux</div>
        <div style={{ fontSize: 32, color: ACCENT, marginTop: 8 }}>github.com/Quire-org/quire</div>
      </div>
    </AbsoluteFill>
  );
}

function Home({ length }: { length: number }) {
  return (
    <Part length={length} caption="A home for your pictures, arranged your way">
      <Stage length={length} zoom={[1, 1.05]} origin="30% 30%">
        <Screen f={frame("home")} />
      </Stage>
    </Part>
  );
}

function Sort({ length }: { length: number }) {
  const steps = [
    { f: frame("sort-1"), at: 0 },
    { f: frame("sort-2"), at: 50 },
    { f: frame("sort-3"), at: 108 },
  ];
  return (
    <Part length={length} caption="Sort with single keys: rate 1 to 10, file into folders">
      <Stage length={length} zoom={[1, 1.03]}>
        <Steps steps={steps} length={length} />
      </Stage>
    </Part>
  );
}

function Browse({ length }: { length: number }) {
  const t = useCurrentFrame();
  const still = frame("browse");
  const tall = frame("browse-tall");
  const filtered = frame("browse-tags");
  // The grid scrolled through (only the grid: the bars and the sidebar stay), then narrowed to one series by its tag.
  const grid = still.grid ?? { x: 0, y: 0, w: WIN, h: 900 };
  const room = tall.height - 900;
  const top = interpolate(t, [12, 100], [0, room * 0.55], { easing: Easing.inOut(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const then = interpolate(t, [108, 118], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <Part length={length} caption="Browse everything, narrowed by tags, people, ratings or folders">
      <Stage length={length}>
        <Screen f={still} />
        <div style={{ position: "absolute", left: grid.x, top: grid.y, width: grid.w, height: grid.h, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: -grid.x, top: -grid.y, width: WIN }}>
            <Screen f={tall} top={top} />
          </div>
        </div>
        <Screen f={filtered} opacity={then} />
      </Stage>
    </Part>
  );
}

function Albums({ length }: { length: number }) {
  const albums = frame("albums");
  const steps = [
    { f: albums, at: 0 },
    { f: frame("reader-1"), at: 52 },
    { f: frame("reader-2"), at: 98 },
    { f: frame("reader-3"), at: 140 },
  ];
  const click = albums.click ?? { x: 900, y: 360 };
  return (
    <Part length={length} caption="Albums and comics, read page by page">
      <Stage length={length}>
        <Steps steps={steps} length={length} />
        <Sequence durationInFrames={52} layout="none">
          <Cursor from={{ x: click.x + 320, y: click.y + 300 }} to={click} arriveAt={30} clickAt={36} />
        </Sequence>
      </Stage>
    </Part>
  );
}

function Tags({ length }: { length: number }) {
  return (
    <Part length={length} caption="Tags found on your own computer, nothing sent anywhere">
      <Stage length={length} zoom={[1, 1.08]} origin="18% 22%">
        <Screen f={frame("tags")} />
      </Stage>
    </Part>
  );
}

function Looks({ length }: { length: number }) {
  const ids = ["look-cp2077-dark", "look-cozy-light", "look-manga-light", "look-gallery-dark"];
  const each = Math.floor(length / ids.length);
  return (
    <Part length={length} caption="Seven themes, each in light and dark">
      <Stage length={length}>
        <Steps steps={ids.map((id, i) => ({ f: frame(id), at: i * each }))} length={length} />
      </Stage>
    </Part>
  );
}

const PARTS: { length: number; Part: React.FC<{ length: number }> }[] = [
  { length: 90, Part: Title },
  { length: 120, Part: Home },
  { length: 170, Part: Sort },
  { length: 160, Part: Browse },
  { length: 185, Part: Albums },
  { length: 105, Part: Tags },
  { length: 150, Part: Looks },
  { length: 110, Part: End },
];
export const DEMO_FRAMES = PARTS.reduce((a, p) => a + p.length, 0) - OVERLAP * (PARTS.length - 1);

export function Demo() {
  return (
    <Backdrop>
      <Series>
        {PARTS.map(({ length, Part: P }, i) => (
          <Series.Sequence key={i} durationInFrames={length} offset={i ? -OVERLAP : 0}>
            <P length={length} />
          </Series.Sequence>
        ))}
      </Series>
    </Backdrop>
  );
}
