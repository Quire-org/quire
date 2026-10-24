import { useEffect, useRef, useState } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

export interface SelectOption {
  value: string;
  label: string;
}

/** Themed dropdown: a button that opens a list; keyboard friendly, closes on outside click or Escape. */
export function Select({ value, options, onChange, title, compact, disabled }: { value: string; options: SelectOption[]; onChange: (v: string) => void; title?: string; compact?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    setHi(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHi((h) => Math.min(options.length - 1, h + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setHi((h) => Math.max(0, h - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onChange(options[hi].value);
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
  }, [open, options, value, hi, onChange]);

  return (
    <div className={`sel ${compact ? "compact" : ""} ${open ? "open" : ""}`} ref={ref}>
      <button type="button" className="btn sm sel-btn" title={title} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        <span className="ellipsis">{current?.label ?? value}</span>
        <CaretDown />
      </button>
      {open && (
        <div className="sel-pop panel" role="listbox">
          {options.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`sel-opt ${o.value === value ? "on" : ""} ${i === hi ? "hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              <span className="ellipsis">{o.label}</span>
              {o.value === value && <Check />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
