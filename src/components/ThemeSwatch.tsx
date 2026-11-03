import { Check, Desktop, Moon, Sun } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { Mode } from "../themes";
import type { ResolvedMode, Theme } from "../themes";

/**
 * One theme to pick, shown in its own look: the swatch carries the theme's own `data-theme` and the
 * mode being chosen, so its colours, font, corners, cuts and texture come from that theme's
 * stylesheet in that mode, not from what is on. A tiny app inside it (a bar, a few tiles, one accent)
 * says what the theme does to the real thing.
 */

/** Light, dark or the system's: the three to pick from, in this order. */
export const MODES: { id: Mode; label: string; icon: ReactNode; about: string }[] = [
  { id: "light", label: "Light", icon: <Sun />, about: "Light, whatever the system is in." },
  { id: "dark", label: "Dark", icon: <Moon />, about: "Dark, whatever the system is in." },
  { id: "system", label: "System", icon: <Desktop />, about: "Light or dark as the system is, following it as it changes." },
];

/** The three modes as buttons, the one chosen marked. */
export function ModePicker({ mode, onPick, small }: { mode: Mode; onPick: (m: Mode) => void; small?: boolean }) {
  return (
    <div className="mode-row" role="radiogroup" aria-label="Light or dark">
      {MODES.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={`btn ${small ? "sm" : ""} ${mode === m.id ? "active" : ""}`} title={m.about} onClick={() => onPick(m.id)}>
          {m.icon}
          <span className="mode-label">{m.label}</span>
        </button>
      ))}
    </div>
  );
}
export function ThemeSwatch({ theme, mode, active, onPick }: { theme: Theme; mode: ResolvedMode; active: boolean; onPick: (id: string) => void }) {
  return (
    <button type="button" className={`theme-swatch ${active ? "on" : ""}`} data-theme={theme.id} data-mode={mode} aria-pressed={active} title={theme.description} onClick={() => onPick(theme.id)}>
      <span className="ts-bar" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="ts-tiles" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="ts-name">
        {theme.name}
        {active && <Check weight={theme.iconWeight} />}
      </span>
    </button>
  );
}
