import { useState, type ReactNode } from "react";
import { Info } from "@phosphor-icons/react";

/**
 * One option as a single bar: heading with an (i) that expands an explanation,
 * an optional toggle or other control, and the action button on the right.
 */
export function OptionRow({ title, info, toggle, control, action }: { title: string; info?: ReactNode; toggle?: { on: boolean; label: string; onChange: (v: boolean) => void }; control?: ReactNode; action?: { label: string; onClick: () => void; disabled?: boolean } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`optrow ${open ? "open" : ""}`}>
      <div className="optrow-bar">
        <span className="optrow-title">{title}</span>
        {info && (
          <button type="button" className={`btn sm ghost icon optrow-info ${open ? "active" : ""}`} onClick={() => setOpen((o) => !o)} title={open ? "Hide details" : "What is this?"}>
            <Info />
          </button>
        )}
        <span className="grow" />
        {toggle && (
          <label className="check side-row optrow-toggle">
            <input type="checkbox" checked={toggle.on} onChange={(e) => toggle.onChange(e.target.checked)} /> {toggle.label}
          </label>
        )}
        {control}
        {action && (
          <button type="button" className="btn sm primary" onClick={action.onClick} disabled={action.disabled}>
            {action.label}
          </button>
        )}
      </div>
      {open && info && <div className="optrow-info-text dim small">{info}</div>}
    </div>
  );
}
