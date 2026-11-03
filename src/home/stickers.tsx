import React, { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { X } from "@phosphor-icons/react";
import { useStore } from "../store";
import { assets, useScrapbook } from "../scrapbook/store";
import { cutOut, drawLayer } from "../scrapbook/render";
import { newId, type StickerLayer, type StickerSource } from "../scrapbook/model";
import { ORIGINAL } from "../scrapbook/looks";
import { STICKERS } from "../scrapbook/stickers";
import { filterPictures, useFilterData } from "../components/PictureFilters";
import { MINE, pick, type HomeSticker } from "./board";
import { useHome } from "./store";

/** Where the board's rows are: its padding, and a row with its gap (Home.tsx lays the grid out so). */
export interface BoardMetrics {
  width: number;
  pad: number;
  row: number;
}

/** How much room round a sticker its picture gets, for the cut edge's glow and a turned corner. */
const ROOM = 1.2;

/** A sticker drawn as Scrapbook draws one (its look, its cut edge), filling its box. */
function StickerArt({ src, aspect, look, outline, flip, w }: { src: StickerSource; aspect: number; look: string; outline: boolean; flip?: boolean; w: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => assets.onLoad(() => setTick((t) => t + 1)), []);
  const W = w * ROOM;
  const H = w * aspect * ROOM;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const layer: StickerLayer = { id: "home", type: "sticker", src, look, outline, aspect, flip, x: 0.5, y: 0.5, w: 1 / ROOM, rot: 0 };
    drawLayer(ctx, layer, W, H, assets);
  }, [src, aspect, look, outline, flip, W, H, tick]);
  return <canvas ref={canvas} className="home-sticker-art" style={{ width: W, height: H }} />;
}

type Art = { src: StickerSource; aspect: number };

/** The stickers each random one picks from: built-in ones of its categories, and cut-outs of pictures its filter lets through. */
function useRandomPools(stickers: HomeSticker[]): Map<string, Art[]> {
  const mine = useScrapbook((x) => x.lib?.stickers);
  const all = useStore((s) => s.allItems);
  const data = useFilterData();
  return useMemo(() => {
    const pools = new Map<string, Art[]>();
    for (const st of stickers) {
      const random = st.random;
      if (!random) continue;
      const cats = random.categories ?? [];
      const builtins = STICKERS.filter((s) => !cats.length || cats.includes(s.category)).map((s) => ({ src: { builtin: s.id } as StickerSource, aspect: 1 }));
      if (cats.length && !cats.includes(MINE)) {
        pools.set(st.id, builtins);
        continue;
      }
      let own = mine ?? [];
      const filter = random.filter;
      if (filter && Object.keys(filter).length) {
        // Cut from one album's pages, or from any picture, pages included (a cut-out's page counts, unlike in Browse).
        const base = filter.album ? all.filter((i) => i.albumKey === filter.album) : all;
        const ok = new Set(filterPictures(base, filter, data).map((i) => i.key));
        own = own.filter((s) => s.source && ok.has(s.source));
      }
      pools.set(st.id, [...builtins, ...own.map((s) => ({ src: { blob: s.blob } as StickerSource, aspect: s.h / Math.max(1, s.w) }))]);
    }
    return pools;
  }, [stickers, mine, all, data]);
}

/** One sticker's picture, as a key: the same sticker (built-in or cut-out) twice has the same one. */
const artKey = (src: StickerSource) => ("builtin" in src ? `b:${src.builtin}` : `c:${src.blob}`);

/** A sticker's own number for this visit to the Home: its picks, and its stand-in's turns. */
export const seedOf = (st: HomeSticker, visit: number) => [...st.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, visit);

/**
 * What each sticker shows on this visit. A picked one, its own; a random one, the first of its pool
 * (shuffled by its seed) that no other sticker on the Home shows: those picked first, then the
 * random ones in their order. One that may repeat, or whose pool has nothing left that isn't shown,
 * takes its first all the same.
 */
export function picksFor(stickers: HomeSticker[], pools: Map<string, Art[]>, visit: number): Map<string, Art | null> {
  const out = new Map<string, Art | null>();
  const shown = new Set(stickers.flatMap((st) => (st.src ? [artKey(st.src)] : [])));
  for (const st of stickers) {
    if (st.src) {
      out.set(st.id, { src: st.src, aspect: st.aspect });
      continue;
    }
    const pool = pools.get(st.id) ?? [];
    const order = pick(pool, pool.length, seedOf(st, visit));
    const art = (st.random?.repeats ? undefined : order.find((a) => !shown.has(artKey(a.src)))) ?? order[0] ?? null;
    if (art) shown.add(artKey(art.src));
    out.set(st.id, art);
  }
  return out;
}

/** The outlines a random sticker's stand-in falls back on, until one of its picks has loaded (or when it has none): a blob, a star, a heart, a square. */
const RANDOM_SHAPES = [
  "M50 6c18 0 38 10 42 30 4 20-6 42-24 52-18 10-44 6-56-12C0 58 4 30 20 16 30 8 40 6 50 6z",
  "M50 5l12 30 32 2-25 21 8 32-27-18-27 18 8-32L6 37l32-2z",
  "M50 90C20 68 6 52 6 34 6 18 18 8 30 8c9 0 16 5 20 12 4-7 11-12 20-12 12 0 24 10 24 26 0 18-14 34-44 56z",
  "M22 10h56a12 12 0 0 1 12 12v56a12 12 0 0 1-12 12H22a12 12 0 0 1-12-12V22a12 12 0 0 1 12-12z",
];

/** How long each outline of a random sticker's stand-in stays. */
const FLIP_MS = 1200;

/**
 * What a random sticker looks like while arranging: the cut-out shape of one of the stickers it may pick,
 * black inside with a white edge and a question mark, the next every moment, each kept within the box the
 * sticker was placed in. Until a pick has loaded (or with nothing to pick from) the generic outlines take
 * turns instead. Outside Arrange a random sticker is its pick for the visit.
 */
function RandomMark({ w, pool, seed }: { w: number; pool: Art[]; seed: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [n, setN] = useState(0);
  const [tick, setTick] = useState(0);
  useEffect(() => assets.onLoad(() => setTick((t) => t + 1)), []);
  const picks = useMemo(() => pick(pool, 8, seed), [pool, seed]);
  useEffect(() => {
    if (picks.length < 2) return;
    const id = window.setInterval(() => setN((x) => x + 1), FLIP_MS);
    return () => window.clearInterval(id);
  }, [picks.length]);
  const cur = picks.length ? picks[n % picks.length] : null;
  const img = cur ? assets.sticker({ id: "home", type: "sticker", src: cur.src, look: ORIGINAL, outline: false, aspect: cur.aspect, x: 0.5, y: 0.5, w: 1, rot: 0 }) : null;
  const W = w * ROOM;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !img || !W) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.height = Math.round(W * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, W);
    const iw = "naturalWidth" in img ? img.naturalWidth || img.width : img.width;
    const shown = cutOut(img, "#000", "#ffffff", (iw * 0.035) | 0);
    // Contained in the box the sticker was placed in (w by w), whatever shape the pick has.
    const scale = Math.min(w / shown.width, w / shown.height);
    ctx.shadowColor = "rgba(0,0,0,0.28)";
    ctx.shadowBlur = w * 0.05;
    ctx.shadowOffsetY = w * 0.02;
    ctx.drawImage(shown, (W - shown.width * scale) / 2, (W - shown.height * scale) / 2, shown.width * scale, shown.height * scale);
  }, [img, w, W, n, tick]);
  return (
    <div className="home-random" style={{ width: w, height: w }} aria-label="A random sticker">
      {img ? (
        <canvas key={n} ref={canvas} className="home-random-cut" style={{ width: W, height: W }} />
      ) : (
        <svg className="home-random-shapes" viewBox="0 0 100 100">
          {RANDOM_SHAPES.map((d, i) => (
            <path key={i} className="home-random-shape" d={d} style={{ "--i": i } as React.CSSProperties} />
          ))}
        </svg>
      )}
      <span className="home-random-mark" style={{ fontSize: w * 0.46 }}>
        ?
      </span>
    </div>
  );
}


type Drag = { mode: "move" | "scale" | "turn"; id: string; x0: number; y0: number; start: HomeSticker; cx: number; cy: number };

/**
 * The Home's stickers, over the board (over its blocks too). Outside Arrange they are only seen;
 * arranging, one is dragged about, sized by a corner, turned by its knob, taken off by its ×, and a
 * click opens its panel.
 */
export function HomeStickers({ board, m, canArrange }: { board: RefObject<HTMLDivElement | null>; m: BoardMetrics; canArrange: boolean }) {
  const kept = useHome((h) => h.doc?.stickers);
  const picked = useHome((h) => h.picked);
  // A random sticker may pick the reader's own cut-outs: the scrapbook's, read here (Arrange's shelf used to be the only reader).
  const root = useStore((s) => s.root);
  const anyRandom = !!kept?.some((s) => s.random);
  useEffect(() => {
    if (anyRandom) void useScrapbook.getState().load();
  }, [anyRandom, root]);
  const [live, setLive] = useState<HomeSticker[] | null>(null);
  const latest = useRef<HomeSticker[] | null>(null);
  const drag = useRef<Drag | null>(null);
  // A new pick for the random ones each time the Home opens.
  const [visit] = useState(() => Math.floor(Math.random() * 1e9));
  const stickers = live ?? kept ?? [];
  // Every sticker's picture for this visit, chosen together so a random one doesn't show what another does.
  const pools = useRandomPools(kept ?? []);
  const picks = useMemo(() => picksFor(kept ?? [], pools, visit), [kept, pools, visit]);
  if (!m.width) return null;
  const centre = (s: HomeSticker) => ({ cx: s.x * m.width, cy: m.pad + s.y * m.row });
  const point = (ev: { clientX: number; clientY: number }) => {
    const r = board.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const place = (s: HomeSticker, cx: number, cy: number): HomeSticker => ({ ...s, x: Math.max(0, Math.min(1, cx / m.width)), y: Math.max(0, (cy - m.pad) / m.row) });
  const show = (next: HomeSticker[]) => ((latest.current = next), setLive(next));

  const begin = (ev: ReactPointerEvent, mode: Drag["mode"], s: HomeSticker) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = point(ev);
    drag.current = { mode, id: s.id, x0: p.x, y0: p.y, start: s, ...centre(s) };
  };
  const onMove = (ev: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(ev);
    const s = d.start;
    let next: HomeSticker;
    if (d.mode === "move") next = place(s, d.cx + p.x - d.x0, d.cy + p.y - d.y0);
    else if (d.mode === "turn") {
      let rot = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90;
      // Straight, or a right angle, when close.
      for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(rot - snap) < 4) rot = snap;
      next = { ...s, rot: Math.round(rot) };
    } else {
      const k = Math.hypot(p.x - d.cx, p.y - d.cy) / Math.max(1, Math.hypot(d.x0 - d.cx, d.y0 - d.cy));
      next = { ...s, w: Math.min(0.6, Math.max(0.02, s.w * k)) };
    }
    if (d.mode === "move" && !latest.current && Math.hypot(p.x - d.x0, p.y - d.y0) < 3) return;
    show((latest.current ?? stickers).map((x) => (x.id === d.id ? next : x)));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    const moved = latest.current?.find((x) => x.id === d?.id);
    latest.current = null;
    setLive(null);
    if (!d) return;
    // Let go where it was taken: a click, which opens its panel.
    if (!moved) return void useHome.getState().pick(d.id);
    const { x, y, w, rot } = moved;
    useHome.getState().updateSticker(d.id, { x, y, w, rot });
  };

  return (
    <div className={`home-stickers ${canArrange ? "arranging" : ""}`} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {stickers.map((s) => (
        <HomeStickerView key={s.id} s={s} m={m} art={s.src ? { src: s.src, aspect: s.aspect } : (picks.get(s.id) ?? null)} pool={pools.get(s.id) ?? []} seed={seedOf(s, visit)} canArrange={canArrange} picked={picked === s.id} onGrab={(ev) => begin(ev, "move", s)} onHandle={(ev, mode) => begin(ev, mode, s)} />
      ))}
    </div>
  );
}

function HomeStickerView({ s, m, art, pool, seed, canArrange, picked, onGrab, onHandle }: { s: HomeSticker; m: BoardMetrics; art: Art | null; pool: Art[]; seed: number; canArrange: boolean; picked: boolean; onGrab: (ev: ReactPointerEvent) => void; onHandle: (ev: ReactPointerEvent, mode: "scale" | "turn") => void }) {
  // Arranging, a random one stands in for its picks (whatever its pool holds); seen, it is one of them.
  const standIn = canArrange && !!s.random;
  if (!art && !standIn) return null;
  // The box the sticker was placed in: its own shape, or for a random one a square its pick is kept within.
  const box = s.w * m.width;
  let w = box;
  let h = box;
  if (!standIn && art && !s.random) h = box * art.aspect;
  else if (!standIn && art) {
    if (art.aspect > 1) w = box / art.aspect;
    else h = box * art.aspect;
  }
  return (
    <div
      className={`home-sticker ${picked ? "picked" : ""}`}
      style={{ left: s.x * m.width - w / 2, top: m.pad + s.y * m.row - h / 2, width: w, height: h, transform: `rotate(${s.rot}deg)` }}
      onPointerDown={canArrange ? onGrab : undefined}
      title={canArrange ? (s.random ? "A random sticker: click to set it up" : "A sticker: click to set it up") : undefined}
    >
      {standIn || !art ? <RandomMark w={box} pool={pool} seed={seed} /> : <StickerArt src={art.src} aspect={art.aspect} look={s.look} outline={s.outline} flip={s.flip} w={w} />}
      {canArrange && (
        <>
          <button className="home-del" onPointerDown={(e) => e.stopPropagation()} onClick={() => useHome.getState().removeSticker(s.id)} title="Take it off (⌘Z brings it back)">
            <X />
          </button>
          {picked && (
            <div className="scrap-sel home-sticker-sel">
              <span className="scrap-handle turn" title="Turn" onPointerDown={(ev) => onHandle(ev, "turn")} />
              {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                <span key={corner} className={`scrap-handle ${corner}`} title="Resize" onPointerDown={(ev) => onHandle(ev, "scale")} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A new sticker for the Home: one from the shelf, or a random one, a little askew, where it goes. */
export function newSticker(at: { x: number; y: number }, from?: { src: StickerSource; aspect: number; custom: boolean }): HomeSticker {
  return {
    id: newId(),
    ...(from ? { src: from.src } : { random: {} }),
    aspect: from?.aspect ?? 1,
    look: ORIGINAL,
    outline: from?.custom ?? false,
    x: at.x,
    y: at.y,
    w: 0.1,
    rot: Math.round((Math.random() - 0.5) * 20),
  };
}
