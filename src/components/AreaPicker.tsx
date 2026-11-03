import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { usePlugins } from "../plugins/store";
import { brushChanged, colourAt, panelAction } from "../plugins/host";
import { isLoop, RADIUS, type Pt, type Stroke } from "../plugins/brush";

/**
 * The brush a plugin's open panel puts on the viewer's image (a `brush`
 * control): round strokes painted over the image, kept in fractions of it so
 * they follow fit, fill and the loupe. A stroke that comes back to where it
 * started fills what it circled. After each stroke, undo or clear, the plugin
 * hears what is painted (`stroke` event). Backspace takes the last stroke
 * back, [ and ] change the brush; the panel has the rest.
 */
export function AreaPicker({ itemKey }: { itemKey: string }) {
  const open = usePlugins((s) => s.panelOpen);
  const panel = usePlugins((s) => (open ? s.panels[open] : undefined));
  const brush = panel?.controls.find((c) => c.type === "brush");
  const screenItem = usePlugins((s) => s.brush.itemKey);
  const pick = usePlugins((s) => s.colourPick);
  if (!open || screenItem !== itemKey) return null;
  if (pick && pick.pluginId === open) return <EyedropperLayer pluginId={open} control={pick.id} />;
  if (!brush || brush.type !== "brush") return null;
  return <Brush pluginId={open} control={brush.id} mode={brush.mode} modeIndex={brush.modes.findIndex((m) => m.id === brush.mode)} />;
}

function Brush({ pluginId, control, mode, modeIndex }: { pluginId: string; control: string; mode: string | null; modeIndex: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const strokes = usePlugins((s) => s.brush.strokes);
  const radius = usePlugins((s) => s.brush.radius);
  const setBrush = usePlugins((s) => s.setBrush);
  const [drawing, setDrawing] = useState<Stroke | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [aspect, setAspect] = useState(1);
  const live = useRef({ radius, mode, aspect });
  live.current = { radius, mode, aspect };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) {
        setAspect(r.height / r.width);
        setBrush((b) => ({ ...b, aspect: r.height / r.width }));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [setBrush]);

  useEffect(() => {
    // Ahead of the viewer's own keys, which would turn the page or close it.
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "Backspace" || e.key === "Delete") {
        setBrush((b) => ({ ...b, strokes: b.strokes.slice(0, -1) }));
        void brushChanged(pluginId, control);
      } else if (e.key === "[") setBrush((b) => ({ ...b, radius: Math.max(RADIUS.min, b.radius / 1.25) }));
      else if (e.key === "]") setBrush((b) => ({ ...b, radius: Math.min(RADIUS.max, b.radius * 1.25) }));
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pluginId, control, setBrush]);

  const at = (e: { clientX: number; clientY: number }): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  const onMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    // Painting, not panning or zooming the loupe.
    e.preventDefault();
    e.stopPropagation();
    const { radius, mode, aspect } = live.current;
    const stroke: Stroke = { points: [at(e)], radius, loop: false, mode };
    setDrawing(stroke);
    const move = (ev: MouseEvent) => {
      const p = at(ev);
      setCursor(p);
      const last = stroke.points[stroke.points.length - 1];
      if (Math.hypot(p.x - last.x, (p.y - last.y) * aspect) > radius / 4) {
        stroke.points.push(p);
        setDrawing({ ...stroke, points: [...stroke.points] });
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
      setDrawing(null);
      setBrush((b) => ({ ...b, strokes: [...b.strokes, { ...stroke, loop: isLoop(stroke, aspect) }] }));
      void brushChanged(pluginId, control);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    // The window losing focus mid-stroke (a dialog, another app) ends the stroke rather than leaving it hanging.
    window.addEventListener("blur", up);
  };

  // The strokes are drawn in a space where a unit is the image's width, so the brush stays round.
  const S = 1000;
  const path = (pts: Pt[]) => pts.map((p) => `${(p.x * S).toFixed(1)},${(p.y * S * aspect).toFixed(1)}`).join(" ");
  const draw = (s: Stroke, i: number | string, idx: number) => (
    <g key={i} className={`stroke ${s.loop ? "loop" : ""} mode-${idx}`}>
      {s.loop && <polygon points={path(s.points)} />}
      <polyline points={path(s.points)} strokeWidth={2 * s.radius * S} />
    </g>
  );
  const modeIdx = (m: string | null) => {
    const panel = usePlugins.getState().panels[pluginId];
    const b = panel?.controls.find((c) => c.type === "brush");
    return b && b.type === "brush" ? b.modes.findIndex((x) => x.id === m) : 0;
  };
  // The layer sits inside the loupe's scaled element, so its own (unscaled) width is the right base:
  // the transform then scales the circle with the image, zoomed or not.
  const layerWidth = ref.current?.offsetWidth ?? 0;
  return (
    <div
      ref={ref}
      className="area-picker"
      onMouseDown={onMouseDown}
      onMouseMove={(e) => setCursor(at(e))}
      onMouseLeave={() => setCursor(null)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <svg viewBox={`0 0 ${S} ${S * aspect}`} preserveAspectRatio="none">
        {strokes.map((s, i) => draw(s, i, modeIdx(s.mode)))}
        {drawing && draw(drawing, "drawing", modeIndex)}
      </svg>
      {cursor && layerWidth > 0 && (
        <div className={`brush-cursor mode-${modeIndex}`} style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, width: 2 * radius * layerWidth, height: 2 * radius * layerWidth }} />
      )}
    </div>
  );
}

/** The eyedropper armed by a colour control: one click on the image picks its colour there. */
function EyedropperLayer({ pluginId, control }: { pluginId: string; control: string }) {
  const setColourPick = usePlugins((s) => s.setColourPick);
  const onClick = async (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const hex = await colourAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    setColourPick(null);
    if (hex) panelAction(pluginId, control, hex);
  };
  return <div className="area-picker eyedropper" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => void onClick(e)} onDoubleClick={(e) => e.stopPropagation()} />;
}
