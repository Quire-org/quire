import { useEffect, useMemo, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { Mini, Thumb } from "./Thumb";
import { useStore } from "../store";
import { seriesCount, type Series } from "../lib/series";
import { useRunPick } from "../lib/useRunPick";
import { suggestForSeries, useSeriesAdd } from "../seriesStore";
import type { MediaItem } from "../lib/types";

/**
 * A series and what might belong in it (Add, from the viewer's SERIES badge or a series' tile in
 * Browse): its pictures, then the library's pictures most like them, unpicked; the ones picked (click,
 * shift-click for a run) are added.
 */
export function SeriesAddDialog() {
  const of = useSeriesAdd((s) => s.of);
  const series = useStore((s) => (of ? s.library?.series?.find((x) => x.includes(of)) : undefined));
  const trashDir = useStore((s) => s.library?.trashDir);
  const close = () => useSeriesAdd.setState({ of: null });
  if (!series) return null;
  return (
    <Modal title={`A series of ${seriesCount(series, trashDir)}`} onClose={close} wide>
      <SeriesAddBody series={series} onDone={close} />
    </Modal>
  );
}

function SeriesAddBody({ series, onDone }: { series: Series; onDone: () => void }) {
  const items = useStore((s) => s.allItems);
  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);
  const [found, setFound] = useState<string[] | null>(null);
  const asked = series.join("\n");
  useEffect(() => {
    let alive = true;
    setFound(null);
    suggestForSeries(asked.split("\n"))
      .then((keys) => alive && setFound(keys))
      .catch(() => alive && setFound([]));
    return () => {
      alive = false;
    };
  }, [asked]);
  const shown = (found ?? []).map((k) => byKey.get(k)).filter((i): i is MediaItem => !!i);
  const { picked, pick } = useRunPick(shown.map((i) => i.key));
  const add = () => {
    const st = useStore.getState();
    st.makeSeries([...series, ...picked]);
    st.toast(`${picked.size} added to the series`, "ok");
    onDone();
  };
  return (
    <div className="series-add">
      <div className="series-add-row">
        {series.map((k) => {
          const it = byKey.get(k);
          return it ? <Mini key={k} item={it} size={176} className="series-add-in" /> : null;
        })}
      </div>
      <div className="label">Might belong in it · click to pick (shift for a run)</div>
      {found == null ? (
        <p className="dim mono">LOOKING…</p>
      ) : shown.length ? (
        <div className="series-add-grid">
          {shown.map((it, i) => (
            <Thumb key={it.key} item={it} aspect={1} selected={picked.has(it.key)} onClick={(e) => pick(i, e)} />
          ))}
        </div>
      ) : (
        <p className="dim">Nothing else looks like it. Pictures are compared by their looks once the tagger has gone through them (Tags), or once Sort or Duplicates looked at them.</p>
      )}
      <div className="series-add-foot">
        <button className="btn primary" disabled={!picked.size} onClick={add}>
          <Plus /> Add {picked.size || ""} to the series
        </button>
      </div>
    </div>
  );
}
