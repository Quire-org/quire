import { useEffect, useState } from "react";

/** Counts down from an ETA supplied at some moment, re-rendering every second. */
export function useCountdown(eta: number | null): number | null {
  const [at, setAt] = useState(Date.now());
  const [, tick] = useState(0);
  useEffect(() => setAt(Date.now()), [eta]);
  // Ticks only while there is something to count down: an idle timer re-rendered whole screens every second.
  const counting = eta != null;
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [counting]);
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
