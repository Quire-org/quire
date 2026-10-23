import { useEffect, useMemo, useRef, useState } from "react";
import type { MediaItem } from "../lib/types";

/**
 * Include / exclude folders from a tree. `selected` holds every included
 * folder path (item.dir values); null means everything. Toggling a folder
 * toggles it together with all of its descendants.
 */
export function FolderPicker({
  items,
  selected,
  onChange,
}: {
  items: MediaItem[];
  selected: Set<string> | null;
  onChange: (sel: Set<string> | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const nodes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of items) {
      const parts = i.dir ? i.dir.split("/") : [];
      for (let k = 0; k <= parts.length; k++) {
        const key = parts.slice(0, k).join("/");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    // Folders that only contain other folders still need a node so they can be toggled.
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, count]) => ({ path, count, depth: path ? path.split("/").length : 0 }));
  }, [items]);
  const all = useMemo(() => new Set(nodes.map((n) => n.path)), [nodes]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), setOpen(false));
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const isOn = (p: string) => selected === null || selected.has(p);
  const descendants = (p: string) => nodes.filter((n) => n.path === p || (p === "" ? true : n.path.startsWith(p + "/"))).map((n) => n.path);
  const state = (p: string): "on" | "off" | "mixed" => {
    const d = descendants(p);
    const on = d.filter(isOn).length;
    return on === d.length ? "on" : on === 0 ? "off" : "mixed";
  };
  const toggle = (p: string) => {
    const next = new Set(selected ?? all);
    const d = descendants(p);
    if (state(p) === "on") d.forEach((x) => next.delete(x));
    else d.forEach((x) => next.add(x));
    onChange(next.size === all.size ? null : next);
  };
  const onCount = selected === null ? all.size : [...selected].filter((p) => all.has(p)).length;
  const label = selected === null ? "All folders" : onCount === 0 ? "No folders" : `${onCount} of ${all.size} folders`;

  return (
    <div className="fp" ref={ref}>
      <button className={`btn sm fp-btn ${selected !== null ? "active" : ""}`} onClick={() => setOpen((o) => !o)}>
        {label} <span className="faint">▾</span>
      </button>
      {open && (
        <div className="fp-pop panel">
          <div className="fp-head">
            <span className="label">Include folders</span>
            <span className="row">
              <button className="btn sm ghost" onClick={() => onChange(null)}>
                All
              </button>
              <button className="btn sm ghost" onClick={() => onChange(new Set())}>
                None
              </button>
            </span>
          </div>
          <div className="fp-list">
            {nodes.map((n) => {
              const st = state(n.path);
              return (
                <label key={n.path || "/"} className={`fp-row ${st}`} style={{ paddingLeft: 8 + n.depth * 16 }}>
                  <input
                    type="checkbox"
                    checked={st === "on"}
                    ref={(el) => {
                      if (el) el.indeterminate = st === "mixed";
                    }}
                    onChange={() => toggle(n.path)}
                  />
                  <span className="fp-name mono ellipsis">{n.path ? n.path.split("/").pop() : "(root)"}</span>
                  <span className="faint mono">{n.count}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
