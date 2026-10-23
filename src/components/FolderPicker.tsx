import { useMemo, useState } from "react";
import type { MediaItem } from "../lib/types";
import { Modal } from "./Modal";
import { CaretDown, CaretRight } from "@phosphor-icons/react";

interface Node {
  path: string;
  count: number;
  depth: number;
  hasChildren: boolean;
}

/**
 * Include / exclude folders from a collapsible tree. `selected` holds every
 * included folder path (item.dir values); null means everything. Toggling a
 * folder toggles it together with all of its descendants. Large trees start
 * with only the first level open; the filter box searches full paths.
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
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string> | null>(null); // null = default (first level)

  const nodes = useMemo<Node[]>(() => {
    const counts = new Map<string, number>();
    for (const i of items) {
      const parts = i.dir ? i.dir.split("/") : [];
      for (let k = 0; k <= parts.length; k++) {
        const key = parts.slice(0, k).join("/");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const paths = [...counts.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const parents = new Set(paths.map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : p ? "" : null)).filter((p): p is string => p !== null));
    return paths.map((path) => ({ path, count: counts.get(path) ?? 0, depth: path ? path.split("/").length : 0, hasChildren: parents.has(path) }));
  }, [items]);
  const all = useMemo(() => new Set(nodes.map((n) => n.path)), [nodes]);

  const isExpanded = (p: string) => (expanded ? expanded.has(p) : p === "" || !p.includes("/"));
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const visible = (n: Node) => {
    let p = n.path;
    while (p) {
      p = parentOf(p);
      if (!isExpanded(p)) return false;
    }
    return true;
  };
  const toggleExpand = (p: string) => {
    const next = new Set(expanded ?? nodes.filter((n) => isExpanded(n.path)).map((n) => n.path));
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setExpanded(next);
  };

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
  const only = (p: string) => {
    const next = new Set(descendants(p));
    onChange(next.size === all.size ? null : next);
  };
  const onCount = selected === null ? all.size : [...selected].filter((p) => all.has(p)).length;
  const label = selected === null ? "All folders" : onCount === 0 ? "No folders" : `${onCount} of ${all.size} folders`;

  const q = filter.trim().toLowerCase();
  const shown = q ? nodes.filter((n) => n.path.toLowerCase().includes(q)) : nodes.filter(visible);

  return (
    <div className="fp">
      <button className={`btn sm fp-btn ${selected !== null ? "active" : ""}`} onClick={() => setOpen(true)}>
        {label} <CaretDown />
      </button>
      {open && (
        <Modal title="Folders" onClose={() => setOpen(false)} wide>
          <div className="fp-head">
            <input className="input grow" placeholder="Filter folders…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
            <span className="row">
              <span className="mono dim small">{label}</span>
              <button className="btn sm ghost" onClick={() => onChange(null)}>
                All
              </button>
              <button className="btn sm ghost" onClick={() => onChange(new Set())}>
                None
              </button>
              <button className="btn sm ghost" onClick={() => setExpanded(new Set(nodes.map((n) => n.path)))} title="Expand every folder">
                Expand
              </button>
              <button className="btn sm ghost" onClick={() => setExpanded(new Set([""]))} title="Collapse to the first level">
                Collapse
              </button>
              <button className="btn sm primary" onClick={() => setOpen(false)}>
                Done
              </button>
            </span>
          </div>
          <div className="fp-list">
            {shown.map((n) => {
              const st = state(n.path);
              const name = n.path ? n.path.split("/").pop() : "(root)";
              return (
                <div key={n.path || "/"} className={`fp-row ${st}`} style={{ paddingLeft: 6 + (q ? 0 : n.depth) * 18 }}>
                  {!q && n.hasChildren ? (
                    <button className="fp-twisty" onClick={() => toggleExpand(n.path)} title={isExpanded(n.path) ? "Collapse" : "Expand"}>
                      {isExpanded(n.path) ? <CaretDown /> : <CaretRight />}
                    </button>
                  ) : (
                    <span className="fp-twisty" />
                  )}
                  <input
                    type="checkbox"
                    checked={st === "on"}
                    ref={(el) => {
                      if (el) el.indeterminate = st === "mixed";
                    }}
                    onChange={() => toggle(n.path)}
                  />
                  <span className="fp-name mono ellipsis" title={n.path || "(root)"} onClick={() => toggle(n.path)}>
                    {q ? n.path || "(root)" : name}
                  </span>
                  <button className="btn sm ghost fp-only" onClick={() => only(n.path)} title="Include only this folder and its subfolders">
                    only
                  </button>
                  <span className="faint mono fp-count">{n.count}</span>
                </div>
              );
            })}
            {shown.length === 0 && <div className="dim small">No folders match.</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
