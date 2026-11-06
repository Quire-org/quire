import { useEffect, useRef, useState } from "react";
import { formatTime } from "../lib/format";
import { releaseVideo } from "../lib/video";

/**
 * Thumbnail of the frame under the cursor while hovering a video's progress
 * bar. Uses its own muted <video> so the playing one is never disturbed.
 */
export function ScrubPreview({ src, time, x }: { src: string; time: number | null; x: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pending = useRef(false);
  const wanted = useRef<number | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.src = src;
    v.onloadeddata = () => setReady(true);
    v.onseeked = () => {
      const c = canvasRef.current;
      if (c) {
        const ctx = c.getContext("2d");
        ctx?.drawImage(v, 0, 0, c.width, c.height);
      }
      pending.current = false;
      // Catch up if the cursor moved while seeking.
      if (wanted.current != null && Math.abs(wanted.current - v.currentTime) > 0.4) {
        pending.current = true;
        v.currentTime = wanted.current;
      }
    };
    videoRef.current = v;
    setReady(false);
    return () => {
      releaseVideo(v);
      videoRef.current = null;
    };
  }, [src]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || time == null || !ready) return;
    wanted.current = time;
    if (!pending.current && Math.abs(v.currentTime - time) > 0.4) {
      pending.current = true;
      v.currentTime = time;
    }
  }, [time, ready]);

  if (time == null) return null;
  return (
    <div className="scrub-preview panel" style={{ left: x }}>
      <canvas ref={canvasRef} width={192} height={108} />
      <div className="mono small">{formatTime(time)}</div>
    </div>
  );
}
