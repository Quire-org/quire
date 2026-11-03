import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowArcLeft, ArrowArcRight, ArrowDown, PaintBrush, ArrowLeft, ArrowLineDown, ArrowLineUp, ArrowUp, ArrowsClockwise, ArrowsLeftRight, Check, Copy, DownloadSimple, Image as ImageIcon, PaintBucket, Plus, Smiley, SortAscending, SortDescending, TextT, Trash } from "@phosphor-icons/react";
import { useStore } from "../store";
import { MiniBrowser } from "../components/MiniBrowser";
import { StickerShelf } from "../components/StickerShelf";
import { Select } from "../components/Select";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { isTypingTarget } from "../lib/hotkeys";
import { assets, exportCover, useScrapbook } from "../scrapbook/store";
import { copyPicture, useSourcePictures } from "../scrapbook/pictures";
import { barAt, barSpan, drawPage, fontsReady, layerAt, layerSize } from "../scrapbook/render";
import { BACKGROUNDS, BAR_STYLES, PAGE, newBar, newId, type Background, type Bar, type CustomSticker, type Layer, type PatternId, type ScrapDoc, type StickerSource, type TextLayer } from "../scrapbook/model";
import { FONTS, LOOKS, ORIGINAL, currentLook, fontById, lookById, withLook } from "../scrapbook/looks";
import type { MediaItem } from "../lib/types";

/**
 * Scrapbook: making a cover for an album (shaped like its pages) or a banner for a tag (2:1). The page in the middle,
 * drawn as it will be saved; click a layer to select it, drag to move, the corner to resize, the knob
 * above to turn, right-click to bring it forward or send it back. Bars split the background, behind
 * every layer; they move and turn the same way. On the right: what is selected, and what can be added
 * (stickers, text, photos, a background and its bars). Done renders it and gives it to the album or
 * tag; the layout is kept to edit again. Export saves it as a picture anywhere.
 */
export function CoverEditor() {
  const e = useScrapbook((x) => x.editing);
  const sb = useScrapbook(useShallow((x) => ({ change: x.change, select: x.select, undo: x.undo, redo: x.redo, done: x.done, cancel: x.cancel, lib: x.lib })));
  const [tab, setTab] = useState<"stickers" | "text" | "photos" | "background">("stickers");
  // The whole cover seen in one theme's look, without changing it until kept.
  const [preview, setPreview] = useState("");

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (isTypingTarget(ev.target)) return;
      const st = useScrapbook.getState();
      const sel = st.editing?.selected;
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        if (ev.shiftKey) st.redo();
        else st.undo();
      } else if (mod && ev.key.toLowerCase() === "d" && sel) {
        ev.preventDefault();
        duplicate(sel);
      } else if ((ev.key === "Delete" || ev.key === "Backspace") && sel) {
        ev.preventDefault();
        remove(sel);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        if (sel) st.select(null);
      } else if (sel && ev.key.startsWith("Arrow")) {
        ev.preventDefault();
        const step = ev.shiftKey ? 0.02 : 0.004;
        const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
        const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
        st.change((d) => ({ ...d, layers: d.layers.map((l) => (l.id === sel ? { ...l, x: l.x + dx, y: l.y + dy } : l)), bars: d.bars?.map((b) => (b.id === sel ? { ...b, x: b.x + dx } : b)) }), `nudge:${sel}`);
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!e) return null;
  const doc = e.doc;
  const shown = preview ? withLook(doc, preview) : doc;
  const selected = doc.layers.find((l) => l.id === e.selected) ?? null;
  const selectedBar = doc.bars?.find((b) => b.id === e.selected) ?? null;
  const add = (layer: Layer) => {
    sb.change((d) => ({ ...d, layers: [...d.layers, layer] }));
    sb.select(layer.id);
  };
  const narrow = doc.kind === "tag";
  // Where a new layer goes: about the middle, a little askew, as if put down by hand.
  const spot = () => ({ x: 0.5 + (Math.random() - 0.5) * 0.2, y: 0.5 + (Math.random() - 0.5) * 0.2, rot: Math.round((Math.random() - 0.5) * 16) });
  const addSticker = (src: StickerSource, aspect: number, custom: boolean) => add({ id: newId(), type: "sticker", src, look: ORIGINAL, outline: custom, aspect, ...spot(), w: narrow ? 0.14 : 0.32 });

  return (
    <div className="screen scrap-screen">
      <div className="scrap-top row">
        <button className="btn sm ghost" onClick={sb.cancel} title="Leave without saving">
          <ArrowLeft /> Cancel
        </button>
        <span className="label">
          Scrapbook · {e.target.kind === "album" ? "cover of" : "banner of"} <b>{e.target.name}</b>
        </span>
        <span className="grow" />
        <span className="small dim">See it in</span>
        <Select compact value={preview} options={[{ value: "", label: "Its own looks" }, ...LOOKS.map((l) => ({ value: l.id, label: l.name }))]} onChange={setPreview} title="Every text and sticker in one theme's look, to see how it would be; nothing changes until you keep it" />
        {preview && (
          <button
            className="btn sm"
            onClick={() => {
              sb.change((d) => withLook(d, preview));
              setPreview("");
            }}
            title="Keep the cover in this look (Undo takes it back)"
          >
            Keep this look
          </button>
        )}
        <button className="btn sm ghost" onClick={sb.undo} disabled={!e.past.length} title="Undo (⌘Z)">
          <ArrowArcLeft />
        </button>
        <button className="btn sm ghost" onClick={sb.redo} disabled={!e.future.length} title="Redo (⇧⌘Z)">
          <ArrowArcRight />
        </button>
        <ExportButton doc={shown} />
        <button className="btn sm primary" onClick={() => void sb.done()} disabled={e.saving}>
          <Check /> {e.saving ? "Saving…" : "Done"}
        </button>
      </div>
      <div className="scrap-layout">
        <Page doc={shown} selected={e.selected} />
        <aside className="scrap-side panel">
          {selected && <LayerControls layer={selected} />}
          {selectedBar && <BarControls bar={selectedBar} />}
          <div className="btn-group scrap-tabs">
            {(
              [
                ["stickers", <Smiley key="s" />, "Stickers"],
                ["text", <TextT key="t" />, "Text"],
                ["photos", <ImageIcon key="p" />, "Photos"],
                ["background", <PaintBucket key="b" />, "Background"],
              ] as const
            ).map(([id, icon, label]) => (
              <button key={id} className={`btn sm ${tab === id ? "active" : "ghost"}`} onClick={() => setTab(id)}>
                {icon} {label}
              </button>
            ))}
          </div>
          {tab === "stickers" && <StickerShelf onAdd={addSticker} onMake={() => void useScrapbook.getState().openStudio({ target: e.target })} stickers={sb.lib?.stickers ?? []} />}
          {tab === "text" && <TextShelf onAdd={(look) => add({ id: newId(), type: "text", text: e.target.name, font: lookById(look).font, size: narrow ? 0.16 : 0.07, look, align: "center", ...spot(), w: 0, rot: 0 })} />}
          {tab === "photos" && (
            <PhotoShelf
              target={e.target}
              onAdd={(blob, aspect) => add({ id: newId(), type: "photo", blob, aspect, frame: "polaroid", ...spot(), w: narrow ? 0.22 : 0.5 })}
              onBackground={(blob) => sb.change((d) => ({ ...d, background: { kind: "photo", blob, blur: 0, color: "#000000" } }))}
            />
          )}
          {tab === "background" && (
            <BackgroundShelf
              bg={doc.background}
              bars={doc.bars ?? []}
              selected={e.selected}
              onChange={(background, merge) => sb.change((d) => ({ ...d, background }), merge)}
              onAddBar={() => {
                const bar = newBar(doc);
                sb.change((d) => ({ ...d, bars: [...(d.bars ?? []), bar] }));
                sb.select(bar.id);
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

/** Saves the cover as you see it as a PNG or JPEG, wherever you pick. */
function ExportButton({ doc }: { doc: ScrapDoc }) {
  const target = useScrapbook((x) => x.editing?.target);
  const [busy, setBusy] = useState(false);
  if (!target) return null;
  return (
    <button
      className="btn sm"
      disabled={busy}
      title="Save it as a picture (PNG or JPEG), as you see it, at twice its size"
      onClick={() => {
        setBusy(true);
        void exportCover(doc, target).finally(() => setBusy(false));
      }}
    >
      <DownloadSimple /> {busy ? "Exporting…" : "Export"}
    </button>
  );
}

function duplicate(id: string) {
  const st = useScrapbook.getState();
  const l = st.editing?.doc.layers.find((x) => x.id === id);
  if (l) {
    const copy = { ...l, id: newId(), x: l.x + 0.03, y: l.y + 0.03 };
    st.change((d) => ({ ...d, layers: [...d.layers, copy] }));
    st.select(copy.id);
    return;
  }
  const b = st.editing?.doc.bars?.find((x) => x.id === id);
  if (!b) return;
  const bar = { ...b, id: newId(), x: Math.min(1, b.x + 0.06) };
  st.change((d) => ({ ...d, bars: [...(d.bars ?? []), bar] }));
  st.select(bar.id);
}

/** A layer or a bar taken off the cover. */
function remove(id: string) {
  const st = useScrapbook.getState();
  st.change((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== id), bars: d.bars?.filter((b) => b.id !== id) }));
  st.select(null);
}

/** The sticker on the shelf a layer shows (one cut from a picture, still on the shelf), to fine-tune it. */
function shelfSticker(layer: Layer | undefined): CustomSticker | undefined {
  if (layer?.type !== "sticker" || !("blob" in layer.src)) return undefined;
  const blob = layer.src.blob;
  return useScrapbook.getState().lib?.stickers.find((s) => s.blob === blob);
}

/** A layer moved in the stack: one up or down, or to the front or the back. */
function restack(id: string, to: "up" | "down" | "top" | "bottom") {
  useScrapbook.getState().change((d) => {
    const i = d.layers.findIndex((l) => l.id === id);
    if (i < 0) return d;
    const rest = d.layers.filter((l) => l.id !== id);
    const at = to === "top" ? rest.length : to === "bottom" ? 0 : Math.max(0, Math.min(rest.length, i + (to === "up" ? 1 : -1)));
    return { ...d, layers: [...rest.slice(0, at), d.layers[i], ...rest.slice(at)] };
  });
}

/* ---------------- the page ---------------- */

type Drag =
  | { mode: "move" | "scale" | "turn"; id: string; key: string; x0: number; y0: number; start: Layer; cx: number; cy: number }
  | { mode: "bar" | "bar-turn"; id: string; key: string; x0: number; y0: number; start: Bar; cx: number; cy: number };

function Page({ doc, selected }: { doc: ScrapDoc; selected: string | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 600, h: 600 });
  const [tick, setTick] = useState(0);
  const drag = useRef<Drag | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const { change, select } = useScrapbook.getState();

  // The page as large as fits, in its shape.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth - 48, h: el.clientHeight - 48 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w: pw, h: ph } = PAGE[doc.kind];
  const scale = Math.max(0.1, Math.min(box.w / pw, box.h / ph));
  const W = Math.round(pw * scale);
  const H = Math.round(ph * scale);

  // Redrawn when anything changes, a picture arrives, or a font has loaded.
  useEffect(() => assets.onLoad(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    void fontsReady(doc).then(() => setTick((t) => t + 1));
  }, [doc]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPage(ctx, doc, W, H, assets);
  }, [doc, W, H, tick]);

  const ctx = () => canvas.current?.getContext("2d") ?? null;
  const point = (ev: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const begin = (ev: ReactPointerEvent, mode: "move" | "scale" | "turn", layer: Layer) => {
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = point(ev);
    drag.current = { mode, id: layer.id, key: `${mode}:${layer.id}:${Date.now()}`, x0: p.x, y0: p.y, start: layer, cx: layer.x * W, cy: layer.y * H };
  };
  const beginBar = (ev: ReactPointerEvent, mode: "bar" | "bar-turn", bar: Bar) => {
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = point(ev);
    drag.current = { mode, id: bar.id, key: `${mode}:${bar.id}:${Date.now()}`, x0: p.x, y0: p.y, start: bar, cx: bar.x * W, cy: H / 2 };
  };
  // What is under the pointer: a layer, else a bar (they lie behind every layer).
  const hitAt = (ev: { clientX: number; clientY: number }) => {
    const c = ctx();
    if (!c) return null;
    const p = point(ev);
    const layer = layerAt(c, doc, W, H, p.x, p.y);
    if (layer) return { layer, bar: null };
    const bar = barAt(doc, W, H, p.x, p.y);
    return bar ? { layer: null, bar } : null;
  };
  const onDown = (ev: ReactPointerEvent) => {
    if (ev.button === 2) return;
    const hit = hitAt(ev);
    select(hit?.layer?.id ?? hit?.bar?.id ?? null);
    if (hit?.layer) begin(ev, "move", hit.layer);
    else if (hit?.bar) beginBar(ev, "bar", hit.bar);
  };
  const onMove = (ev: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(ev);
    if (d.mode === "bar" || d.mode === "bar-turn") {
      const b = d.start;
      let next: Partial<Bar>;
      if (d.mode === "bar") next = { x: Math.max(-0.1, Math.min(1.1, b.x + (p.x - d.x0) / W)) };
      else {
        // Its knob points along it; a line has no ends, so below the middle counts the same as above.
        let angle = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        if (Math.abs(angle) < 3) angle = 0;
        next = { angle: Math.round(Math.max(-70, Math.min(70, angle))) };
      }
      change((doc) => ({ ...doc, bars: doc.bars?.map((x) => (x.id === d.id ? { ...x, ...next } : x)) }), d.key);
      return;
    }
    const s = d.start as Layer;
    change((doc) => {
      const layers = doc.layers.map((l) => {
        if (l.id !== d.id) return l;
        if (d.mode === "move") return { ...l, x: s.x + (p.x - d.x0) / W, y: s.y + (p.y - d.y0) / H };
        if (d.mode === "turn") {
          let rot = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90;
          // Straight, or a right angle, when close.
          for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(rot - snap) < 4) rot = snap;
          return { ...l, rot: Math.round(rot) };
        }
        const k = Math.hypot(p.x - d.cx, p.y - d.cy) / Math.max(1, Math.hypot(d.x0 - d.cx, d.y0 - d.cy));
        return l.type === "text" ? { ...l, size: Math.min(0.6, Math.max(0.015, (s as TextLayer).size * k)) } : { ...l, w: Math.min(2, Math.max(0.03, s.w * k)) };
      });
      return { ...doc, layers };
    }, d.key);
  };
  const onUp = () => {
    drag.current = null;
  };

  const sel = doc.layers.find((l) => l.id === selected);
  const selBar = doc.bars?.find((b) => b.id === selected);
  const c = ctx();
  const size = sel && c ? layerSize(c, sel, W, H) : null;
  const menuItems = (id: string): MenuItem[] => {
    const i = doc.layers.findIndex((l) => l.id === id);
    const last = doc.layers.length - 1;
    const layering: MenuItem[] =
      i < 0
        ? []
        : [
            { label: <><ArrowUp /> Bring forward</>, onClick: () => restack(id, "up"), disabled: i === last },
            { label: <><ArrowLineUp /> Bring to front</>, onClick: () => restack(id, "top"), disabled: i === last },
            { label: <><ArrowDown /> Send backward</>, onClick: () => restack(id, "down"), disabled: i === 0 },
            { label: <><ArrowLineDown /> Send to back</>, onClick: () => restack(id, "bottom"), disabled: i === 0 },
            { separator: true },
          ];
    const sticker = shelfSticker(doc.layers[i]);
    return [
      ...layering,
      ...(sticker ? [{ label: <><PaintBrush /> Fine-tune the sticker</>, onClick: () => void useScrapbook.getState().openStudio({ sticker }) }] : []),
      { label: <><Copy /> Duplicate</>, onClick: () => duplicate(id) },
      { label: <><Trash /> Delete</>, onClick: () => remove(id), danger: true },
    ];
  };
  return (
    <main className="scrap-stage" ref={wrap}>
      <div
        className="scrap-page"
        style={{ width: W, height: H }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(ev) => {
          ev.preventDefault();
          const hit = hitAt(ev);
          const id = hit?.layer?.id ?? hit?.bar?.id;
          if (!id) return setMenu(null);
          select(id);
          setMenu({ x: ev.clientX, y: ev.clientY, id });
        }}
      >
        <canvas ref={canvas} style={{ width: W, height: H }} />
        {selBar && (
          <div
            className="scrap-sel bar"
            style={{ left: selBar.x * W, top: H / 2, width: barSpan(selBar, Math.min(W, H)) + 10, height: H / Math.cos((selBar.angle * Math.PI) / 180), transform: `translate(-50%, -50%) rotate(${selBar.angle}deg)` }}
          >
            <span className="scrap-handle turn" title="Tilt" onPointerDown={(ev) => beginBar(ev, "bar-turn", selBar)} />
          </div>
        )}
        {sel && size && (
          <div className="scrap-sel" style={{ left: sel.x * W, top: sel.y * H, width: size.w, height: size.h, transform: `translate(-50%, -50%) rotate(${sel.rot}deg)` }}>
            <span className="scrap-handle turn" title="Turn" onPointerDown={(ev) => begin(ev, "turn", sel)} />
            {(["nw", "ne", "sw", "se"] as const).map((corner) => (
              <span key={corner} className={`scrap-handle ${corner}`} title="Resize" onPointerDown={(ev) => begin(ev, "scale", sel)} />
            ))}
          </div>
        )}
      </div>
      <ContextMenu at={menu} items={menu ? menuItems(menu.id) : []} onClose={() => setMenu(null)} />
    </main>
  );
}

/* ---------------- what is selected ---------------- */

function BarControls({ bar }: { bar: Bar }) {
  const { change } = useScrapbook.getState();
  const set = (patch: Partial<Bar>, merge?: string) => change((d) => ({ ...d, bars: d.bars?.map((b) => (b.id === bar.id ? { ...b, ...patch } : b)) }), merge);
  return (
    <section className="scrap-selected">
      <div className="row">
        <span className="label grow">Bar</span>
        <button className="btn sm ghost" title="Duplicate (⌘D)" onClick={() => duplicate(bar.id)}>
          <Copy />
        </button>
        <button className="btn sm ghost danger" title="Delete (⌫)" onClick={() => remove(bar.id)}>
          <Trash />
        </button>
      </div>
      <div className="chips">
        {BAR_STYLES.map((s) => (
          <button key={s.id} className={`chip ${bar.style === s.id ? "active" : ""}`} onClick={() => set({ style: s.id })}>
            {s.name}
          </button>
        ))}
      </div>
      <div className="scrap-field">
        <span className="small dim">Bar</span>
        <input type="color" value={bar.color} onChange={(ev) => set({ color: ev.target.value }, `bar-color:${bar.id}`)} title="The bar's colour" />
        <span className="small dim">Right of it</span>
        <input type="color" value={bar.fill} onChange={(ev) => set({ fill: ev.target.value }, `bar-fill:${bar.id}`)} title="The background on its right, up to the next bar" />
      </div>
      <div className="scrap-field">
        <span className="small dim">Thickness</span>
        <input type="range" min={0.005} max={0.15} step={0.0025} value={bar.width} onChange={(ev) => set({ width: Number(ev.target.value) }, `bar-width:${bar.id}`)} />
      </div>
      <div className="scrap-field">
        <span className="small dim">Tilt</span>
        <input type="range" min={-70} max={70} step={1} value={bar.angle} onChange={(ev) => set({ angle: Number(ev.target.value) }, `bar-angle:${bar.id}`)} />
        <button className="btn sm ghost" title="Upright" onClick={() => set({ angle: 0 })}>
          <ArrowsClockwise />
        </button>
      </div>
      <hr className="rule" />
    </section>
  );
}

function LayerControls({ layer }: { layer: Layer }) {
  const { change } = useScrapbook.getState();
  const set = (patch: Partial<Layer>, merge?: string) => change((d) => ({ ...d, layers: d.layers.map((l) => (l.id === layer.id ? ({ ...l, ...patch } as Layer) : l)) }), merge);
  const lookOptions = [...(layer.type === "sticker" ? [{ value: ORIGINAL, label: "Original colours" }] : layer.type === "photo" ? [{ value: "", label: "Classic frame" }] : []), ...LOOKS.map((l) => ({ value: l.id, label: l.name }))];
  return (
    <section className="scrap-selected">
      <div className="row">
        <span className="label grow">{layer.type === "text" ? "Text" : layer.type === "photo" ? "Photo" : "Sticker"}</span>
        <button className="btn sm ghost" title="Bring forward (right-click for more)" onClick={() => restack(layer.id, "up")}>
          <SortAscending />
        </button>
        <button className="btn sm ghost" title="Send backward (right-click for more)" onClick={() => restack(layer.id, "down")}>
          <SortDescending />
        </button>
        <button className="btn sm ghost" title="Duplicate (⌘D)" onClick={() => duplicate(layer.id)}>
          <Copy />
        </button>
        <button
          className="btn sm ghost danger"
          title="Delete (⌫)"
          onClick={() => remove(layer.id)}
        >
          <Trash />
        </button>
      </div>
      {layer.type === "text" && (
        <>
          <textarea className="input" rows={2} value={layer.text} onChange={(ev) => set({ text: ev.target.value }, `text:${layer.id}`)} placeholder="Write something" />
          <div className="scrap-field">
            <span className="small dim">Font</span>
            <Select compact value={layer.font} options={FONTS.map((f) => ({ value: f.id, label: f.name }))} onChange={(font) => set({ font, box: undefined })} title="A font chosen here sets its size anew; a look keeps the text's room" />
          </div>
          <div className="scrap-field">
            <span className="small dim">Size</span>
            <input type="range" min={0.02} max={0.3} step={0.005} value={layer.size} onChange={(ev) => set({ size: Number(ev.target.value) }, `size:${layer.id}`)} />
          </div>
          <div className="scrap-field">
            <span className="small dim">Colour</span>
            <input type="color" value={layer.color ?? lookById(layer.look).fill} onChange={(ev) => set({ color: ev.target.value }, `color:${layer.id}`)} />
            {layer.color && (
              <button className="btn sm ghost" onClick={() => set({ color: undefined })} title="The look's own colour">
                Reset
              </button>
            )}
            <span className="grow" />
            <span className="btn-group">
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} className={`btn sm ${layer.align === a ? "active" : "ghost"}`} onClick={() => set({ align: a })}>
                  {a === "left" ? "L" : a === "center" ? "C" : "R"}
                </button>
              ))}
            </span>
          </div>
        </>
      )}
      {layer.type !== "text" && (
        <div className="scrap-field">
          <span className="small dim">Size</span>
          <input type="range" min={0.03} max={1.4} step={0.01} value={layer.w} onChange={(ev) => set({ w: Number(ev.target.value) }, `w:${layer.id}`)} />
        </div>
      )}
      <div className="scrap-field">
        <span className="small dim">Turn</span>
        <input type="range" min={-180} max={180} step={1} value={layer.rot} onChange={(ev) => set({ rot: Number(ev.target.value) }, `rot:${layer.id}`)} />
        <button className="btn sm ghost" title="Straight" onClick={() => set({ rot: 0 })}>
          <ArrowsClockwise />
        </button>
      </div>
      <div className="scrap-field">
        <span className="small dim">Look</span>
        <Select
          compact
          value={layer.look ?? ""}
          options={lookOptions}
          onChange={(look) =>
            set(
              layer.type === "text"
                ? // The text keeps its room: its size fitted to the font and look it was made in.
                  { look, font: layer.look === look ? layer.font : lookById(look).font, color: undefined, box: layer.box ?? { font: layer.font, look: layer.look } }
                : layer.type === "photo"
                  ? { look: look || undefined }
                  : { look },
            )
          }
          title={layer.type === "photo" ? "The frame in a theme's style" : "A theme's style; built-in stickers turn into its line art, text keeps its room"}
        />
      </div>
      {layer.type === "sticker" && (
        <div className="row">
          <label className="check small">
            <input type="checkbox" checked={layer.outline} onChange={(ev) => set({ outline: ev.target.checked })} /> Cut edge
          </label>
          {shelfSticker(layer) && (
            <button className="btn sm ghost" onClick={() => void useScrapbook.getState().openStudio({ sticker: shelfSticker(layer)! })} title="Fine-tune the sticker: every cover with it on takes the new one">
              <PaintBrush /> Fine-tune
            </button>
          )}
          <button className={`btn sm ${layer.flip ? "active" : "ghost"}`} onClick={() => set({ flip: !layer.flip })} title="Mirror">
            <ArrowsLeftRight />
          </button>
        </div>
      )}
      {layer.type === "photo" && (
        <div className="scrap-field">
          <span className="small dim">Frame</span>
          <span className="btn-group">
            {(["none", "polaroid", "tape"] as const).map((f) => (
              <button key={f} className={`btn sm ${layer.frame === f ? "active" : "ghost"}`} onClick={() => set({ frame: f })}>
                {f === "none" ? "None" : f === "polaroid" ? "Polaroid" : "Tape"}
              </button>
            ))}
          </span>
        </div>
      )}
      <hr className="rule" />
    </section>
  );
}

/* ---------------- what can be added ---------------- */

function TextShelf({ onAdd }: { onAdd: (look: string) => void }) {
  const mine = currentLook();
  const looks = [mine, ...LOOKS.filter((l) => l.id !== mine.id)];
  return (
    <section className="scrap-shelf">
      <div className="dim small">Each theme's lettering; any text can take any font, colour and look afterwards.</div>
      <div className="scrap-looks">
        {looks.map((l) => {
          const f = fontById(l.font);
          return (
            <button
              key={l.id}
              className="scrap-look"
              onClick={() => onAdd(l.id)}
              title={`Add text in ${l.name}'s look`}
              style={{
                fontFamily: f.family,
                fontWeight: f.weight,
                fontStyle: f.italic ? "italic" : undefined,
                color: l.fill,
                WebkitTextStroke: l.strokeWidth ? `${Math.max(1, l.strokeWidth * 22)}px ${l.stroke}` : undefined,
                paintOrder: "stroke fill",
                textShadow: l.glitch ? `-1px 0 0 ${l.glitch.left}, 2px 2px 0 ${l.glitch.right}` : l.glow ? `0 0 6px ${l.glow}` : l.shadow ? `2px 2px 0 ${l.shadow.color}` : undefined,
                textTransform: l.upper ? "uppercase" : undefined,
                letterSpacing: l.spacing ? `${l.spacing}em` : undefined,
                background: l.id === "cp2077" || l.id === "midnight" || l.id === "ghost" ? "#14161c" : "#f2efe8",
              }}
            >
              <Plus /> {l.name}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Pictures to put on the cover: the album's pages, what carries the tag, or any in the library. Copied into the scrapbook. */
function PhotoShelf({ target, onAdd, onBackground }: { target: { kind: "album"; key: string } | { kind: "tag"; id: string }; onAdd: (blob: string, aspect: number) => void; onBackground: (blob: string) => void }) {
  const own = useSourcePictures(target);
  const [busy, setBusy] = useState(false);
  const take = async (it: MediaItem, then: (blob: string, aspect: number) => void) => {
    if (busy) return;
    setBusy(true);
    try {
      const { blob, aspect } = await copyPicture(it, 1400);
      then(blob, aspect);
    } catch (err) {
      useStore.getState().toast(`Could not use ${it.name}: ${String(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`scrap-shelf ${busy ? "busy" : ""}`}>
      <div className="dim small">Click a picture to put it on; ▣ makes it the background.</div>
      <MiniBrowser own={own} ownLabel={target.kind === "album" ? "This album" : "Tagged"} row={110} onPick={(it) => void take(it, onAdd)} action={{ label: "▣", title: "Use as the background", onClick: (it) => void take(it, (blob) => onBackground(blob)) }} />
    </section>
  );
}

const PATTERNS: { id: PatternId; name: string }[] = [
  { id: "dots", name: "Dots" },
  { id: "grid", name: "Grid" },
  { id: "stripes", name: "Stripes" },
  { id: "lined", name: "Lined" },
  { id: "checks", name: "Gingham" },
  { id: "tone", name: "Screentone" },
  { id: "plain", name: "Plain" },
];

function BackgroundShelf({ bg, bars, selected, onChange, onAddBar }: { bg: Background; bars: Bar[]; selected: string | null; onChange: (bg: Background, merge?: string) => void; onAddBar: () => void }) {
  return (
    <section className="scrap-shelf">
      <div className="row">
        <span className="label grow">Bars</span>
        <button className="btn sm" onClick={onAddBar} title="A bar from top to bottom, splitting the background in two colours">
          <Plus /> Add a bar
        </button>
      </div>
      {bars.length > 0 && (
        <div className="scrap-bars">
          {[...bars]
            .sort((a, b) => a.x - b.x)
            .map((b) => (
              <button key={b.id} className={`tags-row ${selected === b.id ? "active" : ""}`} onClick={() => useScrapbook.getState().select(b.id)}>
                <span className="bar-swatch" style={{ background: b.color }} />
                <span className="bar-swatch" style={{ background: b.fill }} />
                <span className="grow">{BAR_STYLES.find((s) => s.id === b.style)?.name}</span>
                {b.angle !== 0 && <span className="dim small">{b.angle}°</span>}
              </button>
            ))}
        </div>
      )}
      <div className="dim small">{bars.length ? "Drag a bar on the page to move it, its knob to tilt it." : "A bar splits the background: the part on its right gets a colour of its own."}</div>
      <hr className="rule" />
      <div className="scrap-grid backgrounds">
        {BACKGROUNDS.map((b) => (
          <button key={b.name} className="scrap-tile bg" onClick={() => onChange(b.bg)} title={b.name}>
            <BackgroundSwatch bg={b.bg} />
            <span className="small ellipsis">{b.name}</span>
          </button>
        ))}
      </div>
      {bg.kind === "pattern" ? (
        <>
          <div className="chips">
            {PATTERNS.map((p) => (
              <button key={p.id} className={`chip ${bg.pattern === p.id ? "active" : ""}`} onClick={() => onChange({ ...bg, pattern: p.id })}>
                {p.name}
              </button>
            ))}
          </div>
          <div className="scrap-field">
            <span className="small dim">{bars.length ? "Left part" : "Paper"}</span>
            <input type="color" value={bg.color} onChange={(ev) => onChange({ ...bg, color: ev.target.value }, "bg-color")} />
            <span className="small dim">Pattern</span>
            <input type="color" value={bg.ink} onChange={(ev) => onChange({ ...bg, ink: ev.target.value }, "bg-ink")} />
          </div>
        </>
      ) : (
        <div className="scrap-field">
          <span className="small dim">Blur</span>
          <input type="range" min={0} max={1} step={0.02} value={bg.blur} onChange={(ev) => onChange({ ...bg, blur: Number(ev.target.value) }, "bg-blur")} />
        </div>
      )}
      <div className="dim small">A photo as the background: ▣ on one under Photos.</div>
    </section>
  );
}

function BackgroundSwatch({ bg }: { bg: Background }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    drawPage(c.getContext("2d")!, { id: "swatch", kind: "album", background: bg, layers: [], updated: 0 }, c.width, c.height, assets);
  }, [bg]);
  return <canvas ref={ref} width={120} height={80} />;
}
