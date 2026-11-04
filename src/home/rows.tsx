import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Plugs } from "@phosphor-icons/react";
import { useOnline } from "../lib/online";
import { FitButtons, type FitItem } from "./fit";

/** One platform's (or one extension's) share of a block: its logo and name, and its pictures. */
export interface RowGroup {
  id: string;
  name: string;
  icon: ReactNode;
  /** How many it has in all (more than are shown, often). */
  count: number;
  /** Its name clicked: where its things are. */
  open: () => void;
  /** Its pictures, each a tile that fills the cell it is given. */
  tiles: { key: string; node: ReactNode }[];
  /** Not connected (asking before going online): its pictures wait, and this connects it. */
  connect?: () => void;
}

const GAP = 4;
/** A row under a logo needs at least this much height for its tiles, and its name line this much. */
const MIN_TILE = 84;
const HEAD = 24;

/**
 * Several platforms' pictures in one block: with room, a row each under its logo and name; without,
 * one grid of the first few of each, each tile with its platform's logo on it. Never more than
 * `maxRows` rows: more platforms than that share the one grid.
 */
export function PlatformRows({ groups, maxRows = Infinity }: { groups: RowGroup[]; maxRows?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const each = useOnline((s) => s.settings.each);
  const open = groups.filter((g) => !g.connect);
  const waiting = groups.filter((g) => g.connect);
  // Waiting for Connect: one strip of buttons (one for all when Connect is for all), not a cell each.
  const connects: FitItem[] = !waiting.length ? [] : each ? waiting.map((g) => ({ id: g.id, label: `Connect ${g.name}`, icon: g.icon, go: g.connect! })) : [{ id: "all", label: "Connect", icon: <Plugs />, go: waiting[0].connect! }];
  const rowsFit = open.length > 0 && open.length <= maxRows && box.h >= open.length * (HEAD + MIN_TILE + 8);
  return (
    <div className="home-rows">
      {connects.length > 0 && (
        <div className={`home-rows-connect ${open.length ? "" : "alone"}`}>
          {!open.length && <span className="dim small">Not connected: Quire asks before going online.</span>}
          <FitButtons items={connects} />
        </div>
      )}
      <div ref={ref} className={`home-rows-body ${open.length ? "" : "empty"}`}>
        {open.length > 0 && (rowsFit ? <Rows groups={open} box={box} /> : <Mixed groups={open} box={box} maxRows={maxRows} />)}
      </div>
    </div>
  );
}

/** A row each, under its logo and name. */
function Rows({ groups, box }: { groups: RowGroup[]; box: { w: number; h: number } }) {
  const tile = Math.min(220, (box.h - groups.length * (HEAD + 8)) / groups.length);
  const across = Math.max(1, Math.floor((box.w + GAP) / (tile + GAP)));
  return (
    <>
      {groups.map((g) => (
        <div key={g.id} className="home-row-group">
          <button className="home-row-head" onClick={g.open} title={`${g.name}: ${g.count}`}>
            {g.icon}
            <span className="ellipsis">{g.name}</span>
            <span className="mono dim small">{g.count}</span>
          </button>
          <div className="home-pics" style={{ gridTemplateColumns: `repeat(${across}, minmax(0, 1fr))`, height: tile }}>
            {g.tiles.slice(0, across).map((t) => (
              <div key={t.key} className="home-tile">
                {t.node}
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** One grid: the first of each in turn, so every platform shows, each tile with its logo. */
function Mixed({ groups, box, maxRows }: { groups: RowGroup[]; box: { w: number; h: number }; maxRows: number }) {
  const side = 120;
  const rows = Math.max(1, Math.min(maxRows, Math.round(box.h / side)));
  const s = (box.h - (rows - 1) * GAP) / rows;
  const cols = Math.max(1, Math.round((box.w + GAP) / (s + GAP)));
  const mixed: { key: string; node: ReactNode; icon: ReactNode; name: string }[] = [];
  for (let i = 0; mixed.length < cols * rows && groups.some((g) => g.tiles[i]); i++) for (const g of groups) if (g.tiles[i] && mixed.length < cols * rows) mixed.push({ ...g.tiles[i], icon: g.icon, name: g.name });
  const used = Math.max(1, Math.min(rows, Math.ceil(mixed.length / cols)));
  return (
    <div className="home-pics" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${used}, minmax(0, 1fr))` }}>
      {mixed.map((t) => (
        <div key={t.key} className="home-tile" title={t.name}>
          {t.node}
          <span className="home-tile-logo">{t.icon}</span>
        </div>
      ))}
    </div>
  );
}
