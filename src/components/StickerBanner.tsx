import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ArrowLineDown, ArrowLineUp, ArrowsLeftRight, Check, Copy, PaintBrush, Smiley, Trash } from "@phosphor-icons/react";
import { useStore } from "../store";
import { assets, useScrapbook, type BannerTarget } from "../scrapbook/store";
import { drawLayer } from "../scrapbook/render";
import { newId, type BannerSticker, type CustomSticker, type StickerLayer, type StickerSource } from "../scrapbook/model";
import { ORIGINAL, currentLook } from "../scrapbook/looks";
import { isTypingTarget } from "../lib/hotkeys";
import { bookOf } from "./StickerBook";
import { StickerShelf, STICKER_DRAG, type DraggedSticker } from "./StickerShelf";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const NONE: BannerSticker[] = [];
const NO_SHELF: CustomSticker[] = [];

/** A sticker's middle on a W × H banner, in pixels. */
const centre = (s: BannerSticker, W: number, H: number) => ({ cx: s.right ? W - s.x : s.x, cy: H / 2 + s.y });

/** A sticker with its middle at (cx, cy), measured from the side of the banner it is nearer. */
function at(s: BannerSticker, cx: number, cy: number, W: number, H: number): BannerSticker {
  const x = Math.max(0, Math.min(W, cx));
  const right = x > W / 2;
  const { right: _was, ...rest } = s;
  void _was;
  return { ...rest, x: Math.round(right ? W - x : x), y: Math.round(Math.max(-H / 2, Math.min(H / 2, cy - H / 2))), ...(right ? { right } : {}) };
}

/** A banner sticker as Scrapbook draws it: a layer of a W × H page. */
function asLayer(s: BannerSticker, W: number, H: number): StickerLayer {
  const { cx, cy } = centre(s, W, H);
  return { id: s.id, type: "sticker", src: s.src, look: s.look, outline: s.outline, aspect: s.aspect, flip: s.flip, x: cx / W, y: cy / H, w: s.w / W, rot: s.rot };
}

/** The topmost sticker under a point of the banner, if any. */
function stickerAt(list: BannerSticker[], W: number, H: number, px: number, py: number): BannerSticker | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const { cx, cy } = centre(s, W, H);
    const a = (-s.rot * Math.PI) / 180;
    const dx = px - cx;
    const dy = py - cy;
    if (Math.abs(dx * Math.cos(a) - dy * Math.sin(a)) <= s.w / 2 && Math.abs(dx * Math.sin(a) + dy * Math.cos(a)) <= (s.w * s.aspect) / 2) return s;
  }
  return null;
}

type Drag = { mode: "move" | "scale" | "turn"; id: string; x0: number; y0: number; start: BannerSticker; cx: number; cy: number };

/**
 * A person's or an artist's banner: a page of the theme's own sticker book with their picture taped
 * on, their name and a line about them, and stickers put anywhere on it. Stickers opens the shelf
 * under it: one clicked goes in the room beside the name, one dragged goes where it is dropped; then
 * each is dragged about, resized by a corner, turned by its knob and right-clicked for more.
 */
export function StickerBanner({ target, banner, tape, photo, name, line }: { target: BannerTarget; banner: string | undefined; tape: string; photo: ReactNode; name: ReactNode; line: ReactNode }) {
  const theme = useStore((x) => x.theme);
  const root = useStore((x) => x.root);
  const kept = useScrapbook((x) => (banner ? x.lib?.banners[banner]?.stickers : undefined)) ?? NONE;
  const shelf = useScrapbook((x) => x.lib?.stickers) ?? NO_SHELF;
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  // While a sticker is dragged: the banner as it is now, saved when let go.
  const [live, setLiveNow] = useState<BannerSticker[] | null>(null);
  const latest = useRef<BannerSticker[] | null>(null);
  const setLive = (next: BannerSticker[] | null) => ((latest.current = next), setLiveNow(next));
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [tick, setTick] = useState(0);
  const page = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const stickers = live ?? kept;
  const { w: W, h: H } = box;

  useEffect(() => void useScrapbook.getState().load(), [root]);
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Drawn again when a sticker changes, the banner's size does, or a picture arrives.
  useEffect(() => assets.onLoad(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const s of stickers) drawLayer(ctx, asLayer(s, W, H), W, H, assets);
  }, [stickers, W, H, tick]);

  const save = (next: BannerSticker[]) => {
    setLive(null);
    useScrapbook.getState().saveBanner(target, next);
  };
  const change = (id: string, fn: (s: BannerSticker) => BannerSticker) => save(stickers.map((s) => (s.id === id ? fn(s) : s)));
  const remove = (id: string) => {
    save(stickers.filter((s) => s.id !== id));
    setPicked(null);
  };
  const restack = (id: string, top: boolean) => {
    const s = stickers.find((x) => x.id === id);
    const rest = stickers.filter((x) => x.id !== id);
    if (s) save(top ? [...rest, s] : [s, ...rest]);
  };
  const stop = () => {
    setEditing(false);
    setPicked(null);
    setMenu(null);
  };

  /** A sticker put on: where it was dropped, else somewhere in the room right of the name, a little askew. */
  const add = (src: StickerSource, aspect: number, custom: boolean, where?: { cx: number; cy: number }) => {
    if (!W || !H) return;
    const w = Math.round((H * 0.55) / Math.max(1, aspect));
    const from = words.current ? words.current.offsetLeft + words.current.offsetWidth + 24 + w / 2 : W / 2;
    const lo = Math.min(from, W - w / 2 - 12);
    const hi = Math.max(lo, W - w / 2 - 12);
    const spot = where ?? { cx: lo + Math.random() * (hi - lo), cy: H / 2 + (Math.random() - 0.5) * H * 0.35 };
    const s = at({ id: newId(), src, aspect, look: ORIGINAL, outline: custom, x: 0, y: 0, w, rot: Math.round((Math.random() - 0.5) * 20) }, spot.cx, spot.cy, W, H);
    save([...stickers, s]);
    setPicked(s.id);
  };

  const point = (ev: { clientX: number; clientY: number }) => {
    const r = page.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const begin = (ev: ReactPointerEvent, mode: Drag["mode"], s: BannerSticker) => {
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = point(ev);
    drag.current = { mode, id: s.id, x0: p.x, y0: p.y, start: s, ...centre(s, W, H) };
  };
  const onDown = (ev: ReactPointerEvent) => {
    if (ev.button === 2) return;
    const p = point(ev);
    const hit = stickerAt(stickers, W, H, p.x, p.y);
    setPicked(hit?.id ?? null);
    if (hit) begin(ev, "move", hit);
  };
  const onMove = (ev: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(ev);
    const s = d.start;
    let next: BannerSticker;
    if (d.mode === "move") next = at(s, d.cx + p.x - d.x0, d.cy + p.y - d.y0, W, H);
    else if (d.mode === "turn") {
      let rot = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90;
      // Straight, or a right angle, when close.
      for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(rot - snap) < 4) rot = snap;
      next = { ...s, rot: Math.round(rot) };
    } else {
      const k = Math.hypot(p.x - d.cx, p.y - d.cy) / Math.max(1, Math.hypot(d.x0 - d.cx, d.y0 - d.cy));
      next = { ...s, w: Math.round(Math.min(H * 2.5, Math.max(16, s.w * k))) };
    }
    setLive((latest.current ?? stickers).map((x) => (x.id === d.id ? next : x)));
  };
  const onUp = () => {
    if (drag.current && latest.current) save(latest.current);
    drag.current = null;
  };
  const onDragOver = (ev: DragEvent) => {
    if (!ev.dataTransfer.types.includes(STICKER_DRAG)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (ev: DragEvent) => {
    const raw = ev.dataTransfer.getData(STICKER_DRAG);
    if (!raw) return;
    ev.preventDefault();
    const d = JSON.parse(raw) as DraggedSticker;
    const p = point(ev);
    add(d.src, d.aspect, d.custom, { cx: p.x, cy: p.y });
  };

  // While stickering: Esc is done, ⌫ takes the picked one off, the arrows nudge it.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector(".context-menu") || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = stickers.find((x) => x.id === picked);
      const step = e.shiftKey ? 20 : 4;
      const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === "Escape") stop();
      else if (s && (e.key === "Delete" || e.key === "Backspace")) remove(s.id);
      else if (s && nudge[e.key]) {
        const { cx, cy } = centre(s, W, H);
        change(s.id, (x) => at(x, cx + nudge[e.key][0], cy + nudge[e.key][1], W, H));
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const sel = editing ? stickers.find((s) => s.id === picked) : undefined;
  const menuItems = (id: string): MenuItem[] => {
    const s = stickers.find((x) => x.id === id);
    if (!s) return [];
    const i = stickers.indexOf(s);
    const look = currentLook();
    return [
      { label: <><ArrowLineUp /> Bring to front</>, onClick: () => restack(id, true), disabled: i === stickers.length - 1 },
      { label: <><ArrowLineDown /> Send to back</>, onClick: () => restack(id, false), disabled: i === 0 },
      { separator: true },
      { label: <><ArrowsLeftRight /> Flip</>, onClick: () => change(id, (x) => ({ ...x, flip: !x.flip })) },
      s.look === ORIGINAL
        ? { label: <><PaintBrush /> In the {look.name} look</>, onClick: () => change(id, (x) => ({ ...x, look: look.id })) }
        : { label: <><PaintBrush /> In its own colours</>, onClick: () => change(id, (x) => ({ ...x, look: ORIGINAL })) },
      {
        label: <><Copy /> Duplicate</>,
        onClick: () => {
          const { cx, cy } = centre(s, W, H);
          const copy = at({ ...s, id: newId() }, cx + 16, cy + 10, W, H);
          save([...stickers, copy]);
          setPicked(copy.id);
        },
      },
      { label: <><Trash /> Take it off</>, onClick: () => remove(id), danger: true },
    ];
  };

  return (
    <div className={`sticker-book-wrap book-${bookOf(theme).id} banner-host ${editing ? "editing" : ""}`}>
      <div className="banner-frame">
        <div className="book-page banner-page" ref={page}>
          {photo && <span className="banner-cut">{photo}</span>}
          {/* Decoration: a strip of tape across the frame's corner, meant to lie over it (said so for readers and the overflow check). */}
          <span className="book-washi banner-tape" aria-hidden="true">
            {tape}
          </span>
          <div className="banner-words" ref={words}>
            <span className="banner-hand">{name}</span>
            <span className="banner-line mono">{line}</span>
          </div>
          <canvas ref={canvas} className="banner-stickers" style={{ width: W, height: H }} />
          {!editing && (
            <button className="btn sm banner-stick" onClick={() => setEditing(true)} title="Put stickers on the banner">
              <Smiley /> Stickers
            </button>
          )}
        </div>
        {editing && (
          <div
            className="banner-edit"
            aria-label="The banner's stickers"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onContextMenu={(ev) => {
              ev.preventDefault();
              const p = point(ev);
              const hit = stickerAt(stickers, W, H, p.x, p.y);
              setPicked(hit?.id ?? null);
              setMenu(hit ? { x: ev.clientX, y: ev.clientY, id: hit.id } : null);
            }}
          >
            {sel && (
              <div className="scrap-sel" style={{ left: centre(sel, W, H).cx, top: centre(sel, W, H).cy, width: sel.w, height: sel.w * sel.aspect, transform: `translate(-50%, -50%) rotate(${sel.rot}deg)` }}>
                <span className="scrap-handle turn" title="Turn" onPointerDown={(ev) => begin(ev, "turn", sel)} />
                {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                  <span key={corner} className={`scrap-handle ${corner}`} title="Resize" onPointerDown={(ev) => begin(ev, "scale", sel)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {editing && (
        <div className="banner-tray panel">
          <div className="row banner-tray-head">
            <span className="small dim grow">Click a sticker to put it on, or drag it where it goes. Drag one about, a corner resizes it, the knob turns it; right-click for more, ⌫ takes it off.</span>
            <button className="btn sm primary" onClick={stop}>
              <Check /> Done <kbd className="kbd">Esc</kbd>
            </button>
          </div>
          <StickerShelf onAdd={(src, aspect, custom) => add(src, aspect, custom)} onMake={() => void useScrapbook.getState().openStudio({})} stickers={shelf} />
        </div>
      )}
      <ContextMenu at={menu} items={menu ? menuItems(menu.id) : []} onClose={() => setMenu(null)} />
    </div>
  );
}
