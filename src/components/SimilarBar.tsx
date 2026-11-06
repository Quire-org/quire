import { X } from "@phosphor-icons/react";
import { SIGNALS } from "../lib/similar";
import { Mini } from "./Thumb";
import { useTags } from "../tagsStore";
import { endSimilar, toggleSignal, useSimilar } from "../similarStore";
import type { MediaItem } from "../lib/types";

/** Over Browse while Show similar is on: the picture its likes are of, what counts (each switched on or off), and the way back. */
export function SimilarBar({ seed, alike, looking }: { seed: MediaItem | undefined; alike: number; looking: boolean }) {
  const off = useSimilar((s) => s.off);
  const indexed = useTags((t) => !!seed && !!t.data?.indexed[seed.key]);
  return (
    <div className="browse-head similar-bar">
      {seed && <Mini item={seed} size={64} className="similar-seed" />}
      <span className="similar-say">
        Similar to <span className="mono">{seed?.name ?? "a picture gone from here"}</span>
      </span>
      <span className="chips">
        {SIGNALS.map((sg) => {
          const unknown = sg.id === "looks" && !indexed;
          return (
            <button key={sg.id} className={`btn sm ${off.includes(sg.id) ? "" : "active"}`} aria-pressed={!off.includes(sg.id)} onClick={() => toggleSignal(sg.id)} title={unknown ? `${sg.title}. This one hasn't been, so its looks can't count yet` : sg.title}>
              {sg.label}
            </button>
          );
        })}
      </span>
      <span className="mono dim grow">{looking ? "LOOKING…" : `${alike} alike`}</span>
      <button className="btn sm ghost icon" onClick={endSimilar} title="Back to Browse as it was">
        <X />
      </button>
    </div>
  );
}
