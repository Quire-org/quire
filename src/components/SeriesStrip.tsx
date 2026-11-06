import { useEffect, useState } from "react";
import { Check, Stack, X } from "@phosphor-icons/react";
import { useStore } from "../store";
import { lookForSeries, useSuggestedSeries } from "../seriesStore";
import { Mini } from "./Thumb";

/**
 * Sort's suggestion: the picture on show and the ones waiting that look like it, as a series to keep
 * (each ticked, untick the ones that aren't: they aren't suggested with it again), or not (none of
 * them is suggested with it again). The pictures waiting are looked at once, in Activity, so there is
 * something to suggest.
 */
export function SeriesStrip() {
  const root = useStore((s) => s.root);
  const sorting = useStore((s) => s.source.kind === "unsorted" && !s.editMode && !s.hudHidden && !s.slideshow.playing);
  const queue = useStore((s) => s.queue);
  const unsorted = useStore((s) => s.unsorted);
  const current = useStore((s) => s.queue[s.index]);
  const others = useSuggestedSeries(sorting ? current : undefined, queue);
  const [left, setLeft] = useState<Set<string>>(new Set());
  useEffect(() => setLeft(new Set()), [current?.key]);
  // What waits in Sort is looked at once (new pictures as they come).
  useEffect(() => {
    if (sorting) void lookForSeries(unsorted);
  }, [sorting, unsorted]);
  if (!sorting || !current || !root || !others.length) return null;
  const byKey = new Map(queue.map((q) => [q.key, q]));
  const picked = others.filter((k) => !left.has(k));
  const keep = () => {
    const kept = [current.key, ...picked];
    const st = useStore.getState();
    st.makeSeries(kept);
    for (const k of others) if (left.has(k)) st.notSeries(k, kept);
  };
  const toggle = (k: string) =>
    setLeft((l) => {
      const next = new Set(l);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  return (
    <div className="series-strip panel" role="region" aria-label="A series to keep?">
      <span className="series-strip-say">
        <Stack /> Looks like a series
      </span>
      <span className="series-strip-pics">
        <span className="series-mini current" title={`${current.name}: on show, in it`}>
          <Mini item={current} size={64} />
        </span>
        {others.map((k) => {
          const it = byKey.get(k);
          if (!it) return null;
          const on = !left.has(k);
          return (
            <button key={k} className={`series-mini ${on ? "on" : "off"}`} onClick={() => toggle(k)} aria-pressed={on} title={`${it.name}: ${on ? "in it (click to leave it out)" : "left out (click to take it in)"}`}>
              <Mini item={it} size={64} />
              <span className="series-mini-tick">{on && <Check weight="bold" />}</span>
            </button>
          );
        })}
      </span>
      <button className="btn sm primary" disabled={!picked.length} onClick={keep} title="Keep the ticked ones together as a series: kept together, one key files all of it. The unticked aren't suggested with it again">
        <Stack /> Keep {picked.length + 1} as a series
      </button>
      <button className="btn sm ghost" onClick={() => useStore.getState().notSeries(current.key, others)} title="Not a series: these aren't suggested with this picture again">
        <X /> Not a series
      </button>
    </div>
  );
}
