import { seriesCount, seriesIndex } from "../lib/series";
import type { MediaItem } from "../lib/types";
import { openSeriesAdd } from "../seriesStore";
import { useStore } from "../store";

/** The picture on show is one of a series: which of it (kept together, in a row), and how many. */
export function SeriesBadge({ item }: { item: MediaItem }) {
  const series = useStore((s) => seriesIndex(s.library?.series).get(item.key));
  const queue = useStore((s) => s.queue);
  const together = useStore((s) => s.seriesTogether);
  const trashDir = useStore((s) => s.library?.trashDir);
  if (!series) return null;
  const inQueue = queue.filter((q) => series.includes(q.key));
  const at = inQueue.findIndex((q) => q.key === item.key);
  return (
    <button className="badge accent badge-button" onClick={() => openSeriesAdd(item.key)} title={`${together ? "One of a series kept together: a target key files all of it" : "One of a series (kept apart: Settings, Look and reading)"}. Click: the series, and more to add to it`}>
      SERIES {together && inQueue.length > 1 ? `${at + 1}/${inQueue.length}` : `· ${seriesCount(series, trashDir)}`}
    </button>
  );
}
