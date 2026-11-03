import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import { useFloating } from "./floating";
import { useOpenSound } from "../lib/sounds";

export interface SelectOption {
  value: string;
  label: string;
  /** A heading shown above the first option of each group. */
  group?: string;
  /** Indented by this many steps (a subtag under its tag). */
  indent?: number;
  /** Shown before its label (a site's icon, say). */
  icon?: ReactNode;
}

/**
 * Themed dropdown: a button that opens a list; keyboard friendly, closes on outside click or Escape.
 * `searchable` puts a filter field at the top of a long list.
 */
export function Select({ value, options, onChange, title, compact, disabled, searchable }: { value: string; options: SelectOption[]; onChange: (v: string) => void; title?: string; compact?: boolean; disabled?: boolean; searchable?: boolean }) {
  const [open, setOpen] = useState(false);
  useOpenSound(open);
  const [hi, setHi] = useState(0);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useFloating(btn, pop, open, { matchWidth: true });
  const current = options.find((o) => o.value === value) ?? options[0];
  const shown = q.trim() ? options.filter((o) => `${o.group ?? ""} ${o.label}`.toLowerCase().includes(q.trim().toLowerCase())) : options;

  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  // On opening, and as the filter narrows: the current choice highlighted, else the first.
  useEffect(() => {
    if (open) setHi(Math.max(0, shown.findIndex((o) => o.value === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, q]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHi((h) => Math.min(shown.length - 1, h + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHi((h) => Math.max(0, h - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (shown[hi]) onChange(shown[hi].value);
        setOpen(false);
      } else {
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, shown, value, hi, onChange]);

  return (
    <div className={`sel ${compact ? "compact" : ""} ${open ? "open" : ""}`} ref={ref}>
      <button ref={btn} type="button" className="btn sm sel-btn" title={title} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {current?.icon}
        <span className="ellipsis">{current?.label ?? value}</span>
        <CaretDown />
      </button>
      {open &&
        createPortal(
        <div ref={pop} className="sel-pop panel" role="listbox">
          {searchable && <input className="input sel-search" autoFocus placeholder="Find…" value={q} onChange={(e) => setQ(e.target.value)} />}
          {shown.map((o, i) => (
            <Fragment key={o.value}>
              {o.group && o.group !== shown[i - 1]?.group && <div className="sel-group">{o.group}</div>}
              <div
                role="option"
                aria-selected={o.value === value}
                className={`sel-opt ${o.value === value ? "on" : ""} ${i === hi ? "hi" : ""}`}
                style={o.indent ? { paddingLeft: 12 + o.indent * 14 } : undefined}
                onMouseEnter={() => setHi(i)}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.icon}
                <span className="ellipsis">{o.label}</span>
                {o.value === value && <Check />}
              </div>
            </Fragment>
          ))}
          {!shown.length && <div className="sel-opt dim">Nothing matches</div>}
        </div>,
          document.body,
        )}
    </div>
  );
}
