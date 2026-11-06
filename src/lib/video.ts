import { useCallback, type RefObject } from "react";

/** A video done with: stopped, and its file let go of. */
export function releaseVideo(v: HTMLVideoElement) {
  v.pause();
  v.removeAttribute("src");
  v.load();
}

/**
 * The ref for a video on screen: once it is gone (the next one shown, or the screen left) it is
 * stopped and let go of. WebKit can keep playing a removed video, its sound on (and its file read)
 * with nothing left on screen to stop it. `ref`, if given, holds the video while it is there.
 */
export function useStopWhenGone(ref?: RefObject<HTMLVideoElement | null>) {
  return useCallback(
    (v: HTMLVideoElement | null) => {
      if (ref) ref.current = v;
      return () => {
        if (ref) ref.current = null;
        // Only once it has left the page: React (in development) lets go of a ref and takes it again
        // on the same element, which must keep its source.
        if (v) queueMicrotask(() => !v.isConnected && releaseVideo(v));
      };
    },
    [ref],
  );
}
