import { useEffect, useRef, useState, type RefObject } from "react";
import { fileSrc, rawPreviewUrl } from "../lib/api";
import { formatTime } from "../lib/format";
import type { MediaItem } from "../lib/types";

/**
 * Full-bleed display of one item: image, RAW (via embedded preview) or video
 * with a small custom control bar.
 */
export function MediaStage({ item, videoRef, fit = "fit" }: { item: MediaItem; videoRef: RefObject<HTMLVideoElement | null>; fit?: "fit" | "fill" }) {
  const cls = `stage-media ${fit === "fill" ? "fill" : ""}`;
  if (item.kind === "video") return <VideoStage item={item} videoRef={videoRef} cls={cls} />;
  if (item.kind === "raw") return <RawStage item={item} cls={cls} />;
  return <ImageStage item={item} cls={cls} />;
}

function ImageStage({ item, cls }: { item: MediaItem; cls: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.primary]);
  if (failed) return <Unavailable item={item} reason="The webview cannot decode this image format." />;
  return (
    <img
      key={item.primary}
      className={cls}
      src={fileSrc(item.primary)}
      alt={item.name}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function RawStage({ item, cls }: { item: MediaItem; cls: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setError(null);
    rawPreviewUrl(item.primary)
      .then((u) => alive && setUrl(u))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [item.primary]);
  if (error) return <Unavailable item={item} reason={error} />;
  if (!url) return <div className="stage-loading mono">DECODING RAW PREVIEW…</div>;
  return <img className={cls} src={url} alt={item.name} draggable={false} />;
}

function VideoStage({ item, videoRef, cls }: { item: MediaItem; videoRef: RefObject<HTMLVideoElement | null>; cls: string }) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [failed, setFailed] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFailed(false);
    setTime(0);
    setDuration(0);
  }, [item.primary]);

  if (failed) return <Unavailable item={item} reason="The webview cannot play this video codec." />;

  const seek = (clientX: number) => {
    const v = videoRef.current;
    const bar = barRef.current;
    if (!v || !bar || !duration) return;
    const r = bar.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };

  return (
    <div className="video-wrap">
      <video
        key={item.primary}
        ref={videoRef}
        className={cls}
        src={fileSrc(item.primary)}
        autoPlay
        loop
        muted={muted}
        playsInline
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
        onError={() => setFailed(true)}
        onClick={() => {
          const v = videoRef.current;
          if (v) v.paused ? v.play() : v.pause();
        }}
      />
      <div className="video-controls panel">
        <button
          className="btn sm icon"
          title="Play / pause (Space)"
          onClick={() => {
            const v = videoRef.current;
            if (v) v.paused ? v.play() : v.pause();
          }}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <span className="mono vtime">{formatTime(time)}</span>
        <div
          ref={barRef}
          className="vbar"
          onMouseDown={(e) => {
            seek(e.clientX);
            const move = (ev: MouseEvent) => seek(ev.clientX);
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        >
          <div className="vbar-fill" style={{ width: duration ? `${(time / duration) * 100}%` : "0%" }} />
        </div>
        <span className="mono vtime">{formatTime(duration)}</span>
        <button
          className="btn sm icon"
          title="Mute (M)"
          onClick={() => {
            const v = videoRef.current;
            if (v) v.muted = !v.muted;
          }}
        >
          {muted ? "MUTED" : "SOUND"}
        </button>
      </div>
    </div>
  );
}

function Unavailable({ item, reason }: { item: MediaItem; reason: string }) {
  return (
    <div className="stage-unavailable panel">
      <div className="label">Cannot display</div>
      <h2>{item.name}</h2>
      <div className="dim mono">{reason}</div>
      <div className="faint mono">{item.primary}</div>
    </div>
  );
}
