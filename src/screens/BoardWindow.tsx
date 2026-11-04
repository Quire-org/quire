import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowsIn, PushPin, PushPinSlash } from "@phosphor-icons/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { api, thumbUrl } from "../lib/api";
import { AssetCache, drawPage, fontsReady } from "../scrapbook/render";
import { migrated, pageOf, type ScrapDoc, type ScrapLibrary } from "../scrapbook/model";

/**
 * A board in a window of its own (opened from the board's editor): to look at while drawing in
 * another app. It stays above other windows until told not to; the wheel zooms where the pointer is,
 * dragging pans, a double click fits it again. A board saved in the main window shows here at once.
 *
 * The board is one canvas, moved and sized by the screen: panning draws nothing, and while a zoom
 * goes on the canvas keeps what it drew, stretched, drawn sharp at the size reached once it stops.
 */
export function BoardWindow({ id, root }: { id: string; root: string }) {
  const [doc, setDoc] = useState<ScrapDoc | null>(null);
  const [error, setError] = useState("");
  const [onTop, setOnTop] = useState(true);
  const [view, setView] = useState({ k: 0, x: 0, y: 0 });
  const [tick, setTick] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });

  // Its pictures: the scrapbook's own files, and the library's it points at (by their small copies).
  const assets = useMemo(() => {
    const urls = new Map<string, string>();
    return new AssetCache(
      async (name) => {
        const had = urls.get(name);
        if (had) return had;
        const url = URL.createObjectURL(new Blob([await api.scrapbookBlob(root, name)], { type: name.endsWith(".png") ? "image/png" : "image/jpeg" }));
        urls.set(name, url);
        return url;
      },
      async (key) => thumbUrl(root, { primary: `${root}/${key}`, modified: 0 }, 1600),
    );
  }, [root]);

  useEffect(() => {
    api
      .scrapbookLoad(root)
      .then((lib) => {
        const d = (lib as ScrapLibrary | null)?.books?.[id];
        if (d) setDoc(migrated(d));
        else setError("This board isn't there any more.");
      })
      .catch((e) => setError(String(e)));
    const off = listen<ScrapDoc>("board-saved", (e) => e.payload.id === id && setDoc(e.payload));
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("resize", onResize);
    };
  }, [id, root]);
  useEffect(() => assets.onLoad(() => setTick((t) => t + 1)), [assets]);
  useEffect(() => {
    if (doc) void fontsReady(doc).then(() => setTick((t) => t + 1));
    if (doc) void getCurrentWindow().setTitle(doc.name || "Board").catch(() => {});
  }, [doc]);

  const page = doc ? pageOf(doc) : { w: 1, h: 1 };
  const fit = Math.min(size.w / page.w, size.h / page.h) * 0.96;
  const k = view.k || fit;
  const x = view.k ? view.x : (size.w - page.w * fit) / 2;
  const y = view.k ? view.y : (size.h - page.h * fit) / 2;

  // The zoom the canvas is drawn at: the view's, a moment after it stops changing.
  const [drawnK, setDrawnK] = useState(0);
  const dk = drawnK || k;
  useEffect(() => {
    if (k === drawnK) return;
    const t = setTimeout(() => setDrawnK(k), drawnK ? 160 : 0);
    return () => clearTimeout(t);
  }, [k, drawnK]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !doc) return;
    // Sharp on this screen, but never a canvas too large to keep (zoomed far in).
    const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(24_000_000 / Math.max(1, page.w * dk * page.h * dk)));
    const w = Math.round(page.w * dk * dpr);
    const h = Math.round(page.h * dk * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr * dk, 0, 0, dpr * dk, 0, 0);
    drawPage(ctx, doc, page.w, page.h, assets);
  }, [doc, dk, tick, assets, page.w, page.h]);

  const onWheel = (e: React.WheelEvent) => {
    const nk = Math.min(8, Math.max(0.05, k * Math.exp(-e.deltaY * 0.0015)));
    // Zoomed about the pointer: the spot under it stays under it.
    setView({ k: nk, x: e.clientX - ((e.clientX - x) * nk) / k, y: e.clientY - ((e.clientY - y) * nk) / k });
  };
  const onDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: x, vy: y };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (d) setView({ k, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
  };
  const toggleTop = () => {
    const next = !onTop;
    setOnTop(next);
    void getCurrentWindow().setAlwaysOnTop(next).catch(() => setOnTop(!next));
  };

  return (
    <div className="board-window" ref={stage} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onDoubleClick={() => setView({ k: 0, x: 0, y: 0 })}>
      <canvas ref={canvas} style={{ width: page.w * k, height: page.h * k, transform: `translate(${x}px, ${y}px)` }} />
      {error && <div className="board-window-note">{error}</div>}
      <div className="board-window-bar" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <button className={`btn sm ${onTop ? "active" : "ghost"}`} onClick={toggleTop} title={onTop ? "Above other windows: click to let them over it" : "Keep it above other windows"}>
          {onTop ? <PushPin /> : <PushPinSlash />} {onTop ? "On top" : "Not on top"}
        </button>
        <button className="btn sm ghost" onClick={() => setView({ k: 0, x: 0, y: 0 })} title="The whole board (double click)">
          <ArrowsIn /> Fit
        </button>
      </div>
    </div>
  );
}
