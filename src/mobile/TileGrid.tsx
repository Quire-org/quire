import { useEffect, useRef, useState, type ReactNode } from "react";
import { Thumb } from "../components/Thumb";
import { useScrollMemory } from "../lib/scrollMemory";
import type { MediaItem } from "../lib/types";
import { useStore } from "../store";
import { TILE_COLS_DEFAULT, TILE_COLS_KEY, useColumns } from "./columns";

/** Between tiles, as the stylesheet has it (.m-tile-grid). */
const GAP = 3;
/** Rows kept ready above and below the view. */
const OVERSCAN = 3;

/** The pictures of something (an artist, a tag), square, to open; only the rows in and near the view are made. `head` scrolls above them. */
export function TileGrid({ items, memory, head }: { items: MediaItem[]; memory: string; head?: ReactNode }) {
  const [cols] = useColumns(TILE_COLS_KEY, TILE_COLS_DEFAULT);
  const ratings = useStore((s) => s.library?.ratings);
  const scroller = useRef<HTMLDivElement>(null);
  const above = useRef<HTMLDivElement>(null);
  useScrollMemory(memory, scroller, items.length > 0);
  const [view, setView] = useState({ top: 0, h: 0, w: 0, head: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, h: el.clientHeight, w: el.clientWidth, head: above.current?.offsetHeight ?? 0 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (above.current) ro.observe(above.current);
    return () => ro.disconnect();
  }, []);
  const raf = useRef(0);
  const onScroll = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = scroller.current;
      if (el) setView((v) => ({ ...v, top: el.scrollTop, h: el.clientHeight }));
    });
  };
  const stride = Math.max(1, (view.w - GAP * (cols - 1)) / cols + GAP);
  const rows = Math.ceil(items.length / cols);
  const firstRow = Math.max(0, Math.floor((view.top - view.head) / stride) - OVERSCAN);
  const lastRow = Math.min(rows, Math.ceil((view.top - view.head + view.h) / stride) + OVERSCAN);
  const first = firstRow * cols;
  return (
    <div className="m-tile-scroll" ref={scroller} onScroll={onScroll}>
      <div ref={above}>{head}</div>
      <div className="m-tile-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, paddingTop: firstRow * stride, paddingBottom: Math.max(0, rows - lastRow) * stride }}>
        {items.slice(first, lastRow * cols).map((it, i) => (
          <Thumb key={it.key} item={it} aspect={1} eager rating={ratings?.[it.key]} onClick={() => useStore.getState().openViewer(items, first + i, { kind: "browse" })} />
        ))}
      </div>
    </div>
  );
}
