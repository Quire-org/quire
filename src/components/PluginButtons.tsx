import { useState } from "react";
import { usePlugins } from "../plugins/store";
import { useStore } from "../store";
import { clickButton } from "../plugins/host";
import { Popover } from "./Popover";
import type { ButtonLocation, PluginButton } from "../plugins/types";
import type { MediaItem } from "../lib/types";
import { CaretDown, CircleNotch, PuzzlePiece, SidebarSimple } from "@phosphor-icons/react";

type Ctx = { item?: MediaItem; items?: MediaItem[]; album?: { key: string; name: string; count: number } };

/** An SVG icon from a plugin, drawn as a mask so it takes the theme's text colour. */
export function PluginIcon({ svg }: { svg?: string }) {
  if (!svg) return <PuzzlePiece />;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  return <span className="plugin-icon" style={{ WebkitMaskImage: url, maskImage: url }} />;
}

/**
 * Buttons plugins added at a location (an album's are entries of its right-click menu instead).
 * `compact` (the viewer's bar): every plugin behind one Plugins button, so the bar stays the same
 * however many are installed. Its menu lists each plugin: one with a panel by its name, opening and
 * closing its panel at the right (its own controls live there), the others with their buttons.
 */
export function PluginButtons({ location, context, compact }: { location: ButtonLocation; context: () => Ctx; compact?: boolean }) {
  const all = usePlugins((s) => s.buttons).filter((b) => b.location === location);
  const list = usePlugins((s) => s.list);
  const panels = usePlugins((s) => s.panels);
  const [menu, setMenu] = useState(false);
  const open = usePlugins((s) => s.panelOpen);
  const buttons = location === "viewer.toolbar" ? all.filter((b) => !panels[b.pluginId]) : all;
  const withPanels = location === "viewer.toolbar" ? Object.values(panels) : [];
  if (!buttons.length && !withPanels.length) return null;
  const nameOf = (pluginId: string) => list.find((p) => p.id === pluginId)?.manifest?.name ?? pluginId;
  // `named`: in the menu on its own, with its plugin's name beside it.
  const one = (b: PluginButton, inMenu: boolean, named = false) => (
    <button
      key={`${b.pluginId}:${b.id}`}
      className={`btn sm ${compact && !inMenu ? "ghost" : inMenu ? (b.active ? "active" : "ghost") : ""} ${b.active ? "active" : ""} plugin-btn`}
      disabled={b.busy}
      title={inMenu ? b.tooltip ?? b.label : `${b.tooltip ?? b.label} · ${nameOf(b.pluginId)}`}
      onClick={(e) => {
        e.stopPropagation();
        setMenu(false);
        clickButton(b, context());
      }}
    >
      {b.busy ? <CircleNotch className="spin" /> : <PluginIcon svg={b.icon} />}
      {(!compact || inMenu) && <span className={named ? "grow" : undefined}>{b.label}</span>}
      {named && <span className="small dim">{nameOf(b.pluginId)}</span>}
    </button>
  );
  if (!compact) {
    // A plugin's panel, opened and closed from its button (Esc or its X closes it too).
    const panelButtons = withPanels.map((panel) => {
      const name = panel.title || nameOf(panel.pluginId);
      const on = open === panel.pluginId;
      return (
        <button key={`panel:${panel.pluginId}`} className={`btn sm ${on ? "active" : ""} plugin-btn`} aria-pressed={on} title={on ? `Close ${name}'s panel` : `${name}: its panel at the right`} onClick={(e) => (e.stopPropagation(), usePlugins.getState().setPanelOpen(on ? null : panel.pluginId))}>
          {panel.icon ? <PluginIcon svg={panel.icon} /> : <SidebarSimple />}
          <span>{name}</span>
        </button>
      );
    });
    return <>{panelButtons}{buttons.map((b) => one(b, false))}</>;
  }

  const byPlugin = new Map<string, PluginButton[]>();
  for (const b of buttons) byPlugin.set(b.pluginId, [...(byPlugin.get(b.pluginId) ?? []), b]);
  const ids = [...new Set([...withPanels.map((p) => p.pluginId), ...byPlugin.keys()])].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const openPanel = withPanels.find((p) => p.pluginId === open);
  const busy = buttons.some((b) => b.busy);
  const active = !!openPanel || buttons.some((b) => b.active);
  return (
    <Popover
      open={menu}
      onClose={() => setMenu(false)}
      width={260}
      trigger={
        <button
          className={`btn sm ghost caret plugin-btn ${active ? "active" : ""}`}
          aria-expanded={menu}
          onClick={(e) => {
            e.stopPropagation();
            setMenu(!menu);
          }}
          title={openPanel ? `Plugins: ${openPanel.title || nameOf(openPanel.pluginId)} is open` : "Plugins"}
        >
          {busy ? <CircleNotch className="spin" /> : <PuzzlePiece />} <CaretDown />
        </button>
      }
    >
      <div className="pop-title">Plugins</div>
      <div className="pop-list plugin-menu">
        {ids.map((id) => {
          const panel = withPanels.find((p) => p.pluginId === id);
          if (panel) {
            const name = panel.title || nameOf(id);
            const on = open === id;
            return (
              <button
                key={`panel:${id}`}
                className={`btn sm ${on ? "active" : "ghost"} plugin-btn`}
                aria-pressed={on}
                title={on ? `Close ${name}'s panel` : `${name}: its panel at the right`}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenu(false);
                  usePlugins.getState().setPanelOpen(on ? null : id);
                }}
              >
                {panel.icon ? <PluginIcon svg={panel.icon} /> : <SidebarSimple />}
                <span className="grow">{name}</span>
                {on && <span className="small dim">open</span>}
              </button>
            );
          }
          const own = byPlugin.get(id) ?? [];
          // One button: itself, named; several: under the plugin's name.
          if (own.length === 1) return one(own[0], true, true);
          return (
            <div key={id} className="pop-list">
              <div className="label pop-sub">{nameOf(id)}</div>
              {own.map((b) => one(b, true))}
            </div>
          );
        })}
      </div>
      <div className="pop-actions">
        <button
          className="btn sm ghost"
          onClick={() => {
            setMenu(false);
            useStore.setState({ pluginsOpen: true });
          }}
        >
          Manage plugins…
        </button>
      </div>
    </Popover>
  );
}
