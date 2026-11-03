import { useEffect, useState } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useStore } from "../store";
import { canThumb, mediaUrl, thumbUrl } from "../lib/api";
import { useFindImage } from "../findStore";
import { finder, type FindWorkView } from "../plugins/find";
import { useMayGoOnline } from "../lib/online";
import { ConnectGate } from "./ConnectGate";
import type { MediaItem } from "../lib/types";

/**
 * Your picture and a work on a platform, large and side by side, to tell whether they are the same:
 * the work's own picture, large (its small one, `thumb`, meanwhile), a page at a time for a work of
 * several (the one that matched need not be the first).
 */
export function ComparePair({ item, name, pluginId, workId, thumb, caption }: { item: MediaItem | undefined; name: string; pluginId: string; workId: string; thumb?: string | null; caption: React.ReactNode }) {
  const root = useStore((s) => s.root);
  const [pages, setPages] = useState<FindWorkView["pages"] | null>(null);
  const [at, setAt] = useState(0);
  const online = useMayGoOnline(pluginId);
  useEffect(() => {
    let live = true;
    setPages(null);
    setAt(0);
    if (!online) return;
    finder
      .work(pluginId, workId)
      .then((w) => live && setPages(w.pages))
      .catch(() => live && setPages([]));
    return () => {
      live = false;
    };
  }, [pluginId, workId, online]);
  const page = pages?.[at];
  const big = useFindImage(pluginId, page?.preview ?? null);
  const small = useFindImage(pluginId, page?.thumb ?? (at === 0 ? (thumb ?? null) : null));
  const theirs = big.src ?? small.src;
  const mine = item && root ? (canThumb(item) ? thumbUrl(root, item, 1024) : mediaUrl(item)) : null;
  const count = pages?.length ?? 0;
  return (
    <div className="compare-pair">
      <figure>
        {mine ? <img src={mine} alt="" /> : <span className="dim small">Not in the library any more</span>}
        <figcaption className="small ellipsis">
          <b>Yours</b> · <span className="mono">{item?.name ?? name}</span>
        </figcaption>
      </figure>
      <figure>
        <ConnectGate pluginId={pluginId} small>
          {theirs ? <img src={theirs} alt="" /> : <span className="dim small">{pages && !count ? "No picture" : "…"}</span>}
        </ConnectGate>
        <figcaption className="small row compare-pair-caption">
          <span className="ellipsis grow">{caption}</span>
          {count > 1 && (
            <span className="row compare-pair-pages">
              <button className="btn sm ghost" disabled={at === 0} onClick={() => setAt(at - 1)} title="The page before">
                <CaretLeft />
              </button>
              <span className="mono">
                {at + 1}/{count}
              </span>
              <button className="btn sm ghost" disabled={at >= count - 1} onClick={() => setAt(at + 1)} title="The next page">
                <CaretRight />
              </button>
            </span>
          )}
        </figcaption>
      </figure>
    </div>
  );
}

/**
 * One of your pictures large, as the compare shows two: where a face in it is (`mark`, in fractions of
 * the upright picture: left, top, right, bottom) outlined.
 */
export function OnePicture({ item, mark, caption }: { item: MediaItem; mark?: [number, number, number, number]; caption: React.ReactNode }) {
  const root = useStore((s) => s.root);
  const [shape, setShape] = useState<number | null>(null);
  useEffect(() => setShape(null), [item.key]);
  if (!root) return null;
  const src = canThumb(item) ? thumbUrl(root, item, 1024) : mediaUrl(item);
  return (
    <div className="compare-one">
      <figure>
        {/* Sized to the picture once it has come, so the outline sits on the face. */}
        <div className="compare-one-frame" style={shape ? { aspectRatio: String(shape), width: `min(100%, calc(62vh * ${shape}))` } : undefined}>
          <img src={src} alt="" onLoad={(e) => setShape(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight))} />
          {mark && shape && <span className="compare-one-mark" style={{ left: `${mark[0] * 100}%`, top: `${mark[1] * 100}%`, width: `${(mark[2] - mark[0]) * 100}%`, height: `${(mark[3] - mark[1]) * 100}%` }} />}
        </div>
        <figcaption className="small ellipsis">{caption}</figcaption>
      </figure>
    </div>
  );
}
