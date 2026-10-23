import { useEffect, useState } from "react";
import { useDupes } from "../dupesStore";
import { useStore } from "../store";

/** Counts down from an ETA supplied at some moment, re-rendering every second. */
export function useCountdown(eta: number | null): number | null {
  const [at, setAt] = useState(Date.now());
  const [, tick] = useState(0);
  useEffect(() => setAt(Date.now()), [eta]);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (eta == null) return null;
  return Math.max(0, Math.round(eta - (Date.now() - at) / 1000));
}

export function fmtEta(s: number | null): string {
  if (s == null) return "…";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Shown on every screen while a duplicate scan runs in the background. */
export function ScanPill() {
  const running = useDupes((d) => d.running);
  const progress = useDupes((d) => d.progress);
  const cancel = useDupes((d) => d.cancel);
  const screen = useStore((s) => s.screen);
  const openDupes = useStore((s) => s.openDupes);
  const left = useCountdown(progress.eta);
  if (!running || screen === "dupes") return null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="scan-pill panel" onClick={openDupes} title="Open the duplicate scan">
      <div className="scan-pill-row">
        <span className="label">Scanning duplicates</span>
        <span className="mono accent2">{progress.stage}</span>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="scan-pill-row mono small">
        <span className="dim">
          {progress.done}/{progress.total}
        </span>
        <span className="dim">~{fmtEta(left)} left</span>
        <button
          className="btn sm ghost"
          onClick={(e) => {
            e.stopPropagation();
            cancel();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
