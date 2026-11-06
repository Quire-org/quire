import { useState } from "react";

/** Picking from a list with clicks: each click one more or one less, shift-click the run from the one clicked last. */
export function useRunPick<K>(keys: readonly K[]) {
  const [picked, setPicked] = useState<Set<K>>(new Set());
  const [last, setLast] = useState<number | null>(null);
  const pick = (i: number, e: { shiftKey: boolean }) => {
    const k = keys[i];
    setPicked((had) => {
      const next = new Set(had);
      if (e.shiftKey && last !== null) for (let j = Math.min(last, i); j <= Math.max(last, i); j++) next.add(keys[j]);
      else if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
    setLast(i);
  };
  return { picked, pick, setPicked };
}
