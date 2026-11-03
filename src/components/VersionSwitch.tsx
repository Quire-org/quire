import { useEffect, useState } from "react";
import { originalOf, useStore } from "../store";
import { langName } from "../lib/language";
import { FlagFace } from "./Flag";

/**
 * The viewer's switch between an album and its translated version, at the same page: one flag split
 * corner to corner (as on the album's card), the language being read taking most of it. A click
 * sweeps the seam across with a short glitch, and the language codes beside it follow; it moves at
 * once, and goes back if the other version can't be opened.
 */
export function VersionSwitch({ albumKey }: { albumKey: string }) {
  const links = useStore((s) => s.library?.albumTranslations);
  const langs = useStore((s) => s.library?.albumLanguages);
  const original = originalOf(albumKey);
  const translation = links?.[original];
  const reading = albumKey === original ? "orig" : "trans";
  const [side, setSide] = useState(reading);
  // Each switch plays the glitch again (two names for the same animation, taken in turn).
  const [runs, setRuns] = useState(0);
  useEffect(() => setSide(reading), [reading]);
  if (!translation) return null;
  const mine = langs?.[original];
  const theirs = langs?.[translation];
  const to = side === "orig" ? "translated" : "the original";
  const toLang = side === "orig" ? theirs : mine;
  const flip = async () => {
    setSide(side === "orig" ? "trans" : "orig");
    setRuns((n) => n + 1);
    await useStore.getState().switchTranslation();
    const st = useStore.getState();
    const now = st.queue[st.index]?.albumKey;
    if (now) setSide(now === originalOf(now) ? "orig" : "trans");
  };
  return (
    <button className={`version-switch ${runs ? (runs % 2 ? "run-a" : "run-b") : ""}`} data-state={side} onClick={() => void flip()} title={`Read ${to}${toLang ? ` (${langName(toLang)})` : ""}, at the same page`}>
      <span className="vs-frame">
        <span className="vs-flags">
          <span className="vs-a">
            <FlagFace code={mine} />
          </span>
          <span className="vs-b">
            <FlagFace code={theirs} />
          </span>
          <span className="vs-seam" />
        </span>
      </span>
      <span className="vs-codes">
        <b>{mine?.toUpperCase() ?? "?"}</b>
        <b>{theirs?.toUpperCase() ?? "?"}</b>
      </span>
    </button>
  );
}
