import { useEffect, useRef, useState, type RefObject } from "react";
import { fileSrc, rawPreviewUrl } from "../lib/api";
import { formatTime } from "../lib/format";
import type { MediaItem } from "../lib/types";
import { FitImage, useFitSize, type FitMode, type Natural } from "./FitImage";

/**
 * Full-bleed display of one item: image, RAW (via embedded preview) or video
 * with a small custom control bar. Media gets explicit pixel sizes from its
 * aspect ratio (see FitImage) so portrait files render where they should.
 */
export function MediaStage({ item, videoRef, fit = "fit" }: { item: MediaItem; videoRef: RefObject<HTMLVideoElement | null>; fit?: FitMode }) {
  if (item.kind === "video") return <VideoStage item={item} videoRef={videoRef} fit={fit} />;
  if (item.kind === "raw") return <RawStage item={item} fit={fit} />;
  return <ImageStage item={item} fit={fit} />;
}

function ImageStage({ item, fit }: { item: MediaItem; fit: FitMode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.primary]);
  if (failed) return <Unavailable item={item} reason="The webview cannot decode this image format." />;
  return <FitImage src={fileSrc(item.primary)} mode={fit} alt={item.name} onError={() => setFailed(true)} />;
}

function RawStage({ item, fit }: { item: MediaItem; fit: FitMode }) {
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
  if (!url)
    return (
      <div className="fitbox">
        <div className="stage-loading mono">DECODING RAW PREVIEW…</div>
      </div>
    );
  return <FitImage src={url} mode={fit} alt={item.name} />;
}

function VideoStage({ item, videoRef, fit }: { item: MediaItem; videoRef: RefObject<HTMLVideoElement | null>; fit: FitMode }) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [muted, setMuted] = useState(true);
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<Natural | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const size = useFitSize(box, natural, fit);

  useEffect(() => {
    setFailed(false);
    setTime(0);
    setDuration(0);
    setNatural(null);
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
    <div className="fitbox video-wrap" ref={setBox}>
      <video
        key={item.primary}
        ref={videoRef}
        className={`stage-media ${size ? "sized" : ""}`}
        style={size ?? undefined}
        src={fileSrc(item.primary)}
        autoPlay
        loop
        muted={muted}
        playsInline
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration);
          setNatural({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
        }}
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
    <div className="fitbox">
      <div className="stage-unavailable panel">
        <div className="label">Cannot display</div>
        <h2>{item.name}</h2>
        <div className="dim mono">{reason}</div>
        <div className="faint mono">{item.primary}</div>
      </div>
    </div>
  );
}
