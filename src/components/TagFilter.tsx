import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Minus, Plus, X } from "@phosphor-icons/react";
import { useTags } from "../tagsStore";

/** Tags an item must carry (any or all of them) and tags it must not (any or all of them). */
export interface TagQuery {
  tags: string[];
  tagsMode: "and" | "or";
  tagsOut: string[];
  tagsOutMode: "and" | "or";
}

/** A bundle id (`bundle:name`) stands for any of its tags. */
function expand(id: string, bundles: Record<string, string[]>): string[] {
  return id.startsWith("bundle:") ? (bundles[id.slice(7)] ?? []) : [id];
}

export function matchesTagQuery(mine: string[], q: TagQuery, bundles: Record<string, string[]> = {}): boolean {
  const has = (id: string) => expand(id, bundles).some((t) => mine.includes(t));
  if (q.tags.length) {
    const hits = q.tags.map(has);
    if (q.tagsMode === "and" ? !hits.every(Boolean) : !hits.some(Boolean)) return false;
  }
  if (q.tagsOut.length) {
    const hits = q.tagsOut.map(has);
    if (q.tagsOutMode === "and" ? hits.every(Boolean) : hits.some(Boolean)) return false;
  }
  return true;
}

/**
 * A dropdown to pick tags for a list: each tag can be required (+) or kept out (−), with
 * any/all for both sides. Bundles are listed first.
 */
export function TagFilter({ value, onChange }: { value: TagQuery; onChange: (patch: Partial<TagQuery>) => void }) {
  const d = useTags((s) => s.data);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void useTags.getState().load();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || btn.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const all = useMemo(() => {
    if (!d) return [] as string[];
    const bundles = Object.keys(d.bundles ?? {}).map((n) => `bundle:${n}`);
    const tags = [...new Set(Object.values(d.tags).flat())].sort();
    return [...bundles, ...tags];
  }, [d]);
  const label = (id: string) => (id.startsWith("bundle:") ? `⧉ ${id.slice(7)}` : id.slice(id.indexOf("/") + 1));
  const typeOf = (id: string) => (id.startsWith("bundle:") ? "bundle" : id.slice(0, id.indexOf("/")));
  const shown = q.trim() ? all.filter((id) => id.toLowerCase().includes(q.trim().toLowerCase())) : all;
  const n = value.tags.length + value.tagsOut.length;
  const toggle = (list: "tags" | "tagsOut", id: string) => {
    const other = list === "tags" ? "tagsOut" : "tags";
    const on = value[list].includes(id);
    onChange({ [list]: on ? value[list].filter((x) => x !== id) : [...value[list], id], [other]: value[other].filter((x) => x !== id) } as Partial<TagQuery>);
  };
  const rect = btn.current?.getBoundingClientRect();
  return (
    <>
      <button ref={btn} className={`btn sm tag-filter-btn ${n ? "active" : ""}`} onClick={() => setOpen(!open)} title="Filter by tags">
        Tags{n ? ` · ${n}` : ""} <CaretDown />
      </button>
      {n > 0 && (
        <div className="chips tag-filter-picked">
          {value.tags.map((id) => (
            <span key={`in${id}`} className="chip" title={`needs ${id}`}>
              + {label(id)}
              <button className="chip-x" onClick={() => toggle("tags", id)}>
                <X />
              </button>
            </span>
          ))}
          {value.tagsOut.map((id) => (
            <span key={`out${id}`} className="chip danger" title={`without ${id}`}>
              − {label(id)}
              <button className="chip-x" onClick={() => toggle("tagsOut", id)}>
                <X />
              </button>
            </span>
          ))}
        </div>
      )}
      {open &&
        rect &&
        createPortal(
          <div ref={pop} className="tag-filter-pop panel" style={{ left: Math.min(rect.left, window.innerWidth - 320), top: rect.bottom + 4 }}>
            <input className="input" autoFocus placeholder="Find a tag…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="side-row small">
              <span className="dim grow">Needs</span>
              <span className="btn-group">
                <button className={`btn sm ${value.tagsMode === "or" ? "active" : "ghost"}`} onClick={() => onChange({ tagsMode: "or" })}>
                  any
                </button>
                <button className={`btn sm ${value.tagsMode === "and" ? "active" : "ghost"}`} onClick={() => onChange({ tagsMode: "and" })}>
                  all
                </button>
              </span>
              <span className="dim grow" style={{ textAlign: "right" }}>
                Without
              </span>
              <span className="btn-group">
                <button className={`btn sm ${value.tagsOutMode === "or" ? "active" : "ghost"}`} onClick={() => onChange({ tagsOutMode: "or" })} title="Out when it has any of them">
                  any
                </button>
                <button className={`btn sm ${value.tagsOutMode === "and" ? "active" : "ghost"}`} onClick={() => onChange({ tagsOutMode: "and" })} title="Out only when it has all of them">
                  all
                </button>
              </span>
            </div>
            <div className="tag-filter-list">
              {shown.map((id) => {
                const inn = value.tags.includes(id);
                const out = value.tagsOut.includes(id);
                return (
                  <div key={id} className={`tag-filter-row ${inn ? "in" : out ? "out" : ""}`}>
                    <span className="ellipsis grow" title={id}>
                      {label(id)} <span className="dim small">{typeOf(id)}</span>
                    </span>
                    <button className={`btn sm ${inn ? "active" : "ghost"}`} title="Needs this tag" onClick={() => toggle("tags", id)}>
                      <Plus />
                    </button>
                    <button className={`btn sm ${out ? "active danger" : "ghost"}`} title="Without this tag" onClick={() => toggle("tagsOut", id)}>
                      <Minus />
                    </button>
                  </div>
                );
              })}
              {!shown.length && <div className="dim small">No tags{q ? " match" : " yet"}.</div>}
            </div>
            {n > 0 && (
              <button className="btn sm ghost" onClick={() => onChange({ tags: [], tagsOut: [] })}>
                Clear
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
