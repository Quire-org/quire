import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { mediaUrl } from "../lib/api";
import { directionFor } from "../plugins/store";
import { bookOf } from "./StickerBook";
import { useFitSize, type FitMode, type Natural } from "./FitImage";
import type { MediaItem } from "../lib/types";

/** A page turn, as the sticker book's; quicker when the next is asked for before it ends. */
const TURN = 650;
const QUICK = 260;

/**
 * An album's pages turned in the viewer the way the theme's sticker book turns its own: the page
 * just left, laid over the new one, turns away as a leaf hinged at its edge (or, in Night City,
 * swipes off with a glitch). Forward goes the album's reading way. Only between two pictures of the
 * same album in the same queue, and not when motion is turned down.
 */
export function PageTurn({ item, index, fit }: { item: MediaItem | undefined; index: number; fit: FitMode }) {
  const on = useStore((s) => s.pageTurns);
  const theme = useStore((s) => s.theme);
  const queue = useStore((s) => s.queue);
  const last = useRef<{ item: MediaItem; index: number; queue: MediaItem[] } | null>(null);
  const lastAt = useRef(0);
  const [turn, setTurn] = useState<{ id: number; from: MediaItem; forward: boolean; ms: number } | null>(null);

  useEffect(() => {
    const was = last.current;
    last.current = item ? { item, index, queue } : null;
    if (!on || !item || !was || was.queue !== queue || was.item.key === item.key) return;
    if (!item.albumKey || item.albumKey !== was.item.albumKey || item.kind !== "image" || was.item.kind !== "image") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const now = performance.now();
    const ms = now - lastAt.current < TURN ? QUICK : TURN;
    lastAt.current = now;
    setTurn({ id: now, from: was.item, forward: index > was.index, ms });
  }, [item?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!turn || !item) return null;
  const rtl = directionFor(item.albumKey) === "rtl";
  // The page leaves to the left going forward (to the right, read right to left), the other way going back.
  const away = turn.forward !== rtl ? "to-left" : "to-right";
  return <Leaf key={turn.id} src={mediaUrl(turn.from)} motion={bookOf(theme).motion} away={away} ms={turn.ms} fit={fit} onDone={() => setTurn(null)} />;
}

/** The page just left (its picture at `src`), over the new one, turning away; gone (`onDone`) once turned. */
export function Leaf({ src, motion, away, ms, fit, onDone }: { src: string; motion: "leaf" | "swipe"; away: "to-left" | "to-right"; ms: number; fit: FitMode; onDone: () => void }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  const size = useFitSize(box, natural, fit);
  // It turns once its size is known, so it is gone when that turn ends (or soon, if it never can).
  const going = size != null;
  useEffect(() => {
    const t = setTimeout(onDone, going ? ms + 40 : ms + 1000);
    return () => clearTimeout(t);
  }, [going]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={setBox} className="fitbox page-turn" aria-hidden>
      <div className={`page-leaf ${motion} ${away} ${size ? "go" : ""}`} style={{ ...(size ?? {}), animationDuration: `${ms}ms` }}>
        <img className={`stage-media ${size ? "sized" : ""}`} src={src} alt="" draggable={false} style={size ?? undefined} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        {motion === "leaf" && <span className="page-leaf-back" />}
      </div>
    </div>
  );
}
