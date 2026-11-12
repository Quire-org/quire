import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { dialogOpen } from "../lib/hotkeys";
import { useFaceMode } from "../peopleStore";
import { selectCurrent, useStore } from "../store";

/** How often a running slideshow looks whether its time is up and the picture is free. */
const LOOK_MS = 200;

/** Zoomed in, on its faces, or with anything open over it: a picture doesn't change under the reader. */
function inUse() {
  const s = useStore.getState();
  return s.zoom.level > 0 || !!s.infoItem || useFaceMode.getState().on || dialogOpen();
}

/**
 * The viewer's slideshow on a phone or tablet: a picture for its seconds, a video to its end, and a
 * picture that was in use given its full time again. The screen stays on, with no finger to keep it so.
 */
export function useSlideshow() {
  const playing = useStore((s) => s.slideshow.playing);
  const seconds = useStore((s) => s.slideshow.interval);
  const alone = useStore((s) => s.queue.length < 2);
  const index = useStore((s) => s.index);
  const current = useStore(selectCurrent);
  const key = current?.key;
  const video = current?.kind === "video";
  // The video that has played to its end, until the viewer is on another.
  const [ended, setEnded] = useState<string>();
  useEffect(() => setEnded(undefined), [key]);

  useEffect(() => {
    if (!playing || !key || (video && ended !== key)) return;
    const wait = video ? 0 : seconds * 1000;
    let due = Date.now() + wait;
    const look = setInterval(() => {
      if (inUse()) due = Date.now() + wait;
      else if (Date.now() >= due) {
        clearInterval(look);
        useStore.getState().next();
      }
    }, LOOK_MS);
    return () => clearInterval(look);
  }, [playing, seconds, key, index, video, ended]);

  useEffect(() => {
    if (!playing) return;
    void api.iosKeepAwake(true).catch(() => {});
    return () => void api.iosKeepAwake(false).catch(() => {});
  }, [playing]);

  return { loop: !playing || alone, onEnded: () => setEnded(key) };
}
