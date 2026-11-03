import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { usePlugins } from "../plugins/store";
import { brushChanged, panelAction } from "../plugins/host";
import { RADIUS } from "../plugins/brush";
import { PluginIcon } from "./PluginButtons";
import { CircleNotch, Eyedropper, X } from "@phosphor-icons/react";
import type { PanelControl } from "../plugins/types";

/**
 * A plugin's panel at the right of the viewer (`ui.panel`): its controls, as
 * the plugin described them, in the order given. Buttons, toggles and choices
 * go back to the plugin as `panel` events; a brush control paints on the image
 * (see AreaPicker) and reports its strokes. The viewer bar's plugin button
 * opens and closes it.
 */
export function PluginPanel() {
  const open = usePlugins((s) => s.panelOpen);
  const panel = usePlugins((s) => (open ? s.panels[open] : undefined));
  const name = usePlugins((s) => (open ? s.list.find((p) => p.id === open)?.manifest?.name : undefined));
  const setPanelOpen = usePlugins((s) => s.setPanelOpen);
  const screen = useStore((s) => s.screen);
  const top = usePillsBottom();
  if (!open || !panel || screen !== "viewer") return null;
  // In a portal: the viewer's bars are transformed, which would pin a fixed panel to them instead of the window.
  return createPortal(
    <div className="plugin-panel panel" style={{ "--panel-top": `${top}px` } as React.CSSProperties} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div className="plugin-panel-head">
        <PluginIcon svg={panel.icon} />
        <strong className="ellipsis grow">{panel.title || name}</strong>
        <button className="btn sm ghost" onClick={() => setPanelOpen(null)} title="Close">
          <X />
        </button>
      </div>
      {panel.controls.map((c, i) => (
        <Control key={c.type === "heading" || c.type === "text" ? i : c.id} pluginId={open} c={c} />
      ))}
    </div>,
    document.body,
  );
}

/** Where the panel may start: under the progress pills at the top right, however many there are. */
export function usePillsBottom(): number {
  const [top, setTop] = useState(118);
  useEffect(() => {
    const measure = () => {
      const pills = document.querySelector<HTMLElement>(".task-pills");
      const h = pills && pills.childElementCount ? pills.getBoundingClientRect().height : 0;
      setTop(h ? 64 + h + 12 : 118);
    };
    measure();
    const ro = new ResizeObserver(measure);
    const pills = document.querySelector(".task-pills");
    if (pills) ro.observe(pills);
    const mo = new MutationObserver(() => {
      measure();
      const p = document.querySelector(".task-pills");
      if (p) ro.observe(p);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return top;
}

function Control({ pluginId, c }: { pluginId: string; c: PanelControl }) {
  switch (c.type) {
    case "heading":
      return <div className="label plugin-panel-heading">{c.label}</div>;
    case "text":
      return <div className="dim small plugin-panel-text">{c.text}</div>;
    case "button":
      return (
        <button className={`btn sm ${c.primary ? "primary" : c.active ? "active" : ""}`} disabled={c.disabled || c.busy} title={c.tooltip} onClick={() => panelAction(pluginId, c.id)}>
          {c.busy ? <CircleNotch className="spin" /> : null} {c.label}
        </button>
      );
    case "toggle":
      return (
        <label className="check side-row">
          <input type="checkbox" checked={c.value} disabled={c.disabled} onChange={(e) => panelAction(pluginId, c.id, e.target.checked)} /> {c.label}
        </label>
      );
    case "choice":
      return (
        <div className="pick-section">
          {c.label && <div className="label">{c.label}</div>}
          <div className="btn-group pick-group">
            {c.options.map((o) => (
              <button key={o.id} className={`btn sm ${c.value === o.id ? "active" : "ghost"}`} disabled={c.disabled} onClick={() => panelAction(pluginId, c.id, o.id)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      );
    case "input":
      return (
        <div className="pick-section">
          {c.label && <div className="label">{c.label}</div>}
          <input className="input" value={c.value} placeholder={c.placeholder} onChange={(e) => panelAction(pluginId, c.id, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      );
    case "brush":
      return <BrushControl pluginId={pluginId} c={c} />;
    case "colour":
      return <ColourControl pluginId={pluginId} c={c} />;
    default:
      return null;
  }
}

function BrushControl({ pluginId, c }: { pluginId: string; c: Extract<PanelControl, { type: "brush" }> }) {
  const strokes = usePlugins((s) => s.brush.strokes);
  const radius = usePlugins((s) => s.brush.radius);
  const setBrush = usePlugins((s) => s.setBrush);
  const change = (fn: (s: typeof strokes) => typeof strokes) => {
    setBrush((b) => ({ ...b, strokes: fn(b.strokes) }));
    void brushChanged(pluginId, c.id);
  };
  return (
    <div className="pick-section plugin-panel-brush">
      {c.modes.length > 0 && (
        <>
          <div className="label">A stroke means</div>
          <div className="btn-group pick-group">
            {c.modes.map((m, i) => (
              <button key={m.id} className={`btn sm ${c.mode === m.id ? "active" : "ghost"} mode-${i}`} onClick={() => panelAction(pluginId, c.id, m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        </>
      )}
      {c.hint && <div className="dim small">{c.hint}</div>}
      <div className="label">
        Brush <kbd className="kbd">[</kbd> <kbd className="kbd">]</kbd>
      </div>
      <input type="range" min={Math.log(RADIUS.min)} max={Math.log(RADIUS.max)} step={0.01} value={Math.log(radius)} onChange={(e) => setBrush((b) => ({ ...b, radius: Math.exp(Number(e.target.value)) }))} title="Brush size" />
      <div className="row">
        <span className="dim small grow">{strokes.length ? `${strokes.length} stroke${strokes.length === 1 ? "" : "s"}` : "Paint on the image"}</span>
        <button className="btn sm ghost" disabled={!strokes.length} onClick={() => change((s) => s.slice(0, -1))} title="Take the last stroke back (Backspace)">
          Undo
        </button>
        <button className="btn sm ghost" disabled={!strokes.length} onClick={() => change(() => [])}>
          Clear
        </button>
      </div>
    </div>
  );
}

function ColourControl({ pluginId, c }: { pluginId: string; c: Extract<PanelControl, { type: "colour" }> }) {
  const pick = usePlugins((s) => s.colourPick);
  const setColourPick = usePlugins((s) => s.setColourPick);
  const picking = pick?.pluginId === pluginId && pick.id === c.id;
  return (
    <div className="pick-section">
      {c.label && <div className="label">{c.label}</div>}
      <div className="row colour-row">
        <span className={`swatch ${c.value ? "" : "none"}`} style={c.value ? { background: c.value } : undefined} title={c.value ?? "none picked"} />
        <span className="mono small dim grow">{c.value ?? "none"}</span>
        <button className={`btn sm ${picking ? "active" : "ghost"}`} onClick={() => setColourPick(picking ? null : { pluginId, id: c.id })} title="Then click the colour on the image">
          <Eyedropper /> {picking ? "Click the image…" : "Pick"}
        </button>
        {c.value && (
          <button className="btn sm ghost" onClick={() => panelAction(pluginId, c.id, null)}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
