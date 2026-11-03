import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FunnelSimple, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useArtists } from "../artistsStore";
import { usePeople } from "../peopleStore";
import { ArtistIcon } from "./ArtistIcon";
import { FaceCrop, portraitOf } from "../screens/People";
import type { FaceView } from "../lib/types";

/**
 * A screen's filters, the same everywhere: a Filters button (how many are on) with what they are set
 * to as chips that take one off, and a panel over the grid with a section for each. A screen gives
 * its filters as `Filter`s, built from the controls below.
 */
export interface Filter {
  id: string;
  label: string;
  /** What it is set to, one chip each (none: it filters nothing). */
  chips: FilterChip[];
  /** Its controls, in the panel. */
  body: ReactNode;
}

export interface FilterChip {
  key: string;
  label: ReactNode;
  title?: string;
  remove: () => void;
}

const chipsOf = (filters: Filter[]) => filters.flatMap((f) => f.chips.map((c) => ({ ...c, key: `${f.id}:${c.key}` })));

/** The Filters button, and what is on under it (each chip takes its filter off; Clear all, all of them). */
export function FiltersButton({ filters, open, onToggle, onClear }: { filters: Filter[]; open: boolean; onToggle: () => void; onClear: () => void }) {
  const on = chipsOf(filters);
  return (
    <div className="filters-on">
      <button className={`btn ${open ? "active" : ""}`} onClick={onToggle} title="All the filters, in a panel over the grid">
        <FunnelSimple /> Filters{on.length ? ` · ${on.length}` : ""}
      </button>
      {on.length > 0 && (
        <div className="chips">
          {on.map((c) => (
            <span key={c.key} className="chip" title={c.title}>
              <span className="ellipsis">{c.label}</span>
              <button className="chip-x" onClick={c.remove} title="Take it off">
                <X />
              </button>
            </span>
          ))}
          <button className="chip link" onClick={onClear}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

/** Every filter in a panel over the grid, which changes behind it as they do. Esc or × closes it. */
export function FiltersPanel({ filters, onClose, onClear }: { filters: Filter[]; onClose: () => void; onClear: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const on = chipsOf(filters).length;
  return (
    <aside className="filters-panel panel" aria-label="Filters">
      <div className="filters-head">
        <h2>Filters</h2>
        {on > 0 && (
          <button className="btn sm ghost" onClick={onClear}>
            Clear all
          </button>
        )}
        <span className="grow" />
        <button className="btn sm ghost" onClick={onClose} title="Close (Esc)">
          <X /> <kbd className="kbd">Esc</kbd>
        </button>
      </div>
      <div className="filters-body">
        {filters.map((f) => (
          <section key={f.id} className={`filter ${f.chips.length ? "on" : ""}`}>
            <div className="label">{f.label}</div>
            {f.body}
          </section>
        ))}
      </div>
    </aside>
  );
}

/* ---------- the controls sections are made of ---------- */

/** One of a few, as chips (with how many each has, when given). */
export function ChoiceFilter<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; count?: number; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={o.value} className={`btn sm ${value === o.value ? "active" : ""}`} onClick={() => onChange(o.value)} title={o.title}>
          {o.label}
          {o.count != null && <span className="faint mono">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A rating at least this good, or only what isn't rated. */
export function RatingFilter({ min, unrated, onChange }: { min: number; unrated: boolean; onChange: (patch: { minRating?: number; unratedOnly?: boolean }) => void }) {
  return (
    <>
      <div className="side-row">
        <input type="range" min={0} max={10} value={min} onChange={(e) => onChange({ minRating: Number(e.target.value) })} disabled={unrated} />
        <span className="mono">{unrated ? "—" : min === 0 ? "any" : `≥ ${min}`}</span>
      </div>
      <label className="side-row check">
        <input type="checkbox" checked={unrated} onChange={(e) => onChange({ unratedOnly: e.target.checked })} /> Unrated only
      </label>
    </>
  );
}

/** The chips a rating filter shows: one, when it is on. */
export function ratingChips(min: number, unrated: boolean, clear: () => void): FilterChip[] {
  if (unrated) return [{ key: "unrated", label: "Unrated", remove: clear }];
  return min > 0 ? [{ key: "min", label: `Rated ≥ ${min}`, remove: clear }] : [];
}

export interface PickOption {
  id: string;
  label: string;
  /** Beside the name: an icon or a face. */
  icon?: ReactNode;
  hint?: string;
}

/** Any of several (artists, people): the ones picked first, the rest found by typing. */
export function PickFilter({ picked, options, onChange, placeholder, empty }: { picked: string[]; options: PickOption[]; onChange: (ids: string[]) => void; placeholder: string; empty: string }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const chosen = new Set(picked);
  const rest = options.filter((o) => !chosen.has(o.id) && (!needle || `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(needle)));
  const toggle = (id: string) => onChange(chosen.has(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  if (!options.length) return <div className="dim small">{empty}</div>;
  return (
    <div className="pick-filter">
      {options
        .filter((o) => chosen.has(o.id))
        .map((o) => (
          <button key={o.id} className="pick-row on" onClick={() => toggle(o.id)} title="Take it off">
            {o.icon}
            <span className="ellipsis grow">{o.label}</span>
            <X />
          </button>
        ))}
      {options.length > 6 && (
        <div className="row search-field">
          <MagnifyingGlass className="dim" />
          <input className="input grow" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && q && (e.stopPropagation(), setQ(""))} />
        </div>
      )}
      <div className="pick-list">
        {rest.slice(0, 40).map((o) => (
          <button key={o.id} className="pick-row" onClick={() => toggle(o.id)}>
            {o.icon}
            <span className="ellipsis grow">{o.label}</span>
            {o.hint && <span className="faint small">{o.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- artists and people, for any screen ---------- */

/** The library's artists, to pick from (most pictures first). */
export function useArtistOptions(): PickOption[] {
  const doc = useArtists((a) => a.doc);
  useEffect(() => void useArtists.getState().load(), []);
  return useMemo(() => {
    const count = new Map<string, number>();
    for (const ids of Object.values(doc?.items ?? {})) for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
    return Object.values(doc?.artists ?? {})
      .sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0) || a.name.localeCompare(b.name))
      .map((a) => ({ id: a.id, label: a.name, icon: <ArtistIcon artist={a} size={22} />, hint: String(count.get(a.id) ?? 0) }));
  }, [doc]);
}

/** The library's people and characters, to pick from (most faces first). */
export function usePeopleOptions(): PickOption[] {
  const doc = usePeople((p) => p.doc);
  const faces = usePeople((p) => p.faces);
  useEffect(() => void usePeople.getState().load(), []);
  return useMemo(() => {
    const byId = new Map(faces.map((f) => [f.id, f]));
    const mine = new Map<string, FaceView[]>();
    for (const [id, a] of Object.entries(doc?.faces ?? {})) {
      const f = byId.get(Number(id));
      if (f && !a.auto) mine.set(a.p, [...(mine.get(a.p) ?? []), f]);
    }
    return Object.values(doc?.people ?? {})
      .sort((a, b) => (mine.get(b.id)?.length ?? 0) - (mine.get(a.id)?.length ?? 0) || a.name.localeCompare(b.name))
      .map((p) => {
        const face = portraitOf(p, mine.get(p.id) ?? []);
        return { id: p.id, label: p.name, icon: face ? <FaceCrop face={face} size={22} className="round" /> : undefined, hint: p.kind === "character" ? "character" : undefined };
      });
  }, [doc, faces]);
}

/** Each person's pictures (by key): the faces given to them. */
export function usePeopleKeys(): Map<string, Set<string>> {
  const doc = usePeople((p) => p.doc);
  const faces = usePeople((p) => p.faces);
  return useMemo(() => {
    const keyOf = new Map(faces.map((f) => [f.id, f.key]));
    const out = new Map<string, Set<string>>();
    for (const [id, a] of Object.entries(doc?.faces ?? {})) {
      const k = keyOf.get(Number(id));
      if (!k || a.auto) continue;
      const set = out.get(a.p) ?? new Set<string>();
      set.add(k);
      out.set(a.p, set);
    }
    // In a picture with no face to show it, they are in it all the same.
    for (const [k, ids] of Object.entries(doc?.present ?? {})) for (const id of ids) out.set(id, (out.get(id) ?? new Set<string>()).add(k));
    return out;
  }, [doc, faces]);
}

/** The chips of a pick filter: one per thing picked. */
export function pickChips(picked: string[], options: PickOption[], set: (ids: string[]) => void): FilterChip[] {
  const name = new Map(options.map((o) => [o.id, o.label]));
  return picked.map((id) => ({ key: id, label: name.get(id) ?? "…", remove: () => set(picked.filter((x) => x !== id)) }));
}
