import { useEffect, useRef, useState, type RefObject } from "react";
import { mediaUrl, rawPreviewUrl } from "../lib/api";
import { formatTime } from "../lib/format";
import type { MediaItem } from "../lib/types";
import { FitImage, useFitSize, type FitMode, type Natural } from "./FitImage";
import { ScrubPreview } from "./ScrubPreview";
import { DeviceMobile, Gauge, Pause, Play, SpeakerHigh, SpeakerSlash } from "@phosphor-icons/react";
import { useCast } from "./Cast";
import { useOriginalShown } from "../versionsStore";
import { VideoFaceLayer } from "./FacesInPicture";
import { useStopWhenGone } from "../lib/video";

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/**
 * Sound let on stays on: within an hour of a video last playing with its sound (unmuted, or played so),
 * the next one starts with sound too, so a run of videos needn't each be unmuted. Muting one ends it.
 * Kept in this window's storage, so a restart within the hour keeps it.
 */
const SOUND_KEY = "quire.soundOnAt";
const SOUND_FOR = 60 * 60_000;
export function soundLetOn(now = Date.now()): boolean {
  try {
    return now - Number(localStorage.getItem(SOUND_KEY) ?? 0) < SOUND_FOR;
  } catch {
    return false;
  }
}
function keepSound(on: boolean) {
  try {
    if (on) localStorage.setItem(SOUND_KEY, String(Date.now()));
    else localStorage.removeItem(SOUND_KEY);
  } catch {
    /* for this video only */
  }
}

/**
 * Full-bleed display of one item: image, RAW (via embedded preview) or video
 * with a small custom control bar. Media gets explicit pixel sizes from its
 * aspect ratio (see FitImage) so portrait files render where they should.
 */
export function MediaStage({ item, videoRef, fit = "fit", loop = true, onEnded }: { item: MediaItem; videoRef: RefObject<HTMLVideoElement | null>; fit?: FitMode; loop?: boolean; onEnded?: () => void }) {
  if (item.kind === "video") return <VideoStage item={item} videoRef={videoRef} fit={fit} loop={loop} onEnded={onEnded} />;
  if (item.kind === "raw") return <RawStage item={item} fit={fit} />;
  return <ImageStage item={item} fit={fit} />;
}

function ImageStage({ item, fit }: { item: MediaItem; fit: FitMode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [item.primary]);
  // O shows what is underneath: for a version, the picture it was made from.
  const original = useOriginalShown(item);
  if (original)
    return (
      <>
        <FitImage src={original} mode={fit} alt={`${item.name}: what it was made from`} zoomable />
        <span className="stage-original mono" role="status">
          ORIGINAL <kbd className="kbd">O</kbd>
        </span>
      </>
    );
  if (failed) return <Unavailable item={item} reason="The webview cannot decode this image format." />;
  return <FitImage src={mediaUrl(item)} mode={fit} alt={item.name} onError={() => setFailed(true)} zoomable overlayKey={item.key} />;
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
  return <FitImage src={url} mode={fit} alt={item.name} zoomable overlayKey={item.key} />;
}

function VideoStage({ item, videoRef, fit, loop, onEnded }: { item: MediaItem; videoRef: RefObject<HTMLVideoElement | null>; fit: FitMode; loop: boolean; onEnded?: () => void }) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(true);
  // Muted or not, for the video it was said of; a new video starts as the sound was last let on or not.
  const [sound, setSound] = useState(() => ({ of: item.primary, muted: !soundLetOn() }));
  const muted = sound.of === item.primary ? sound.muted : !soundLetOn();
  // A video refused autoplay with its sound is muted to play: not the reader muting it (see onVolumeChange).
  const mutedToPlay = useRef(false);
  // The video it has tried to start already (once each: a seek fires canplay again).
  const startedFor = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<Natural | null>(null);
  const [speed, setSpeed] = useState(1);
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null);
  const [controlsOn, setControlsOn] = useState(true);
  const overControls = useRef(false);
  const videoAt = useStopWhenGone(videoRef);
  // Shown on a phone or tablet (Show on another device): it plays there, not here as well.
  const elsewhere = useCast((x) => (x.info ? (x.devices.find((d) => d.state === "allowed")?.name ?? null) : null));
  useEffect(() => {
    if (elsewhere) videoRef.current?.pause();
  }, [elsewhere, item.primary, videoRef]);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Controls show on any mouse movement and fade after a moment of stillness.
  const poke = () => {
    setControlsOn(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (!overControls.current) setControlsOn(false);
    }, 2500);
  };
  useEffect(() => {
    poke();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.primary]);
  const barRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const size = useFitSize(box, natural, fit);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
  }, [speed, item.primary]);

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
    <div className="fitbox video-wrap" ref={setBox} onMouseMove={poke}>
      <video
        key={item.primary}
        ref={videoAt}
        className={`stage-media ${size ? "sized" : ""}`}
        style={size ?? undefined}
        src={mediaUrl(item)}
        autoPlay={!elsewhere}
        preload={elsewhere ? "metadata" : "auto"}
        loop={loop}
        onEnded={onEnded}
        muted={muted}
        playsInline
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration);
          setNatural({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight });
          e.currentTarget.playbackRate = speed;
        }}
        onRateChange={(e) => setSpeed(e.currentTarget.playbackRate)}
        onCanPlay={(e) => {
          const v = e.currentTarget;
          if (elsewhere || startedFor.current === item.primary) return;
          startedFor.current = item.primary;
          mutedToPlay.current = false;
          // With its sound, a video may be refused autoplay (the webview's rule): it plays muted then, as before.
          if (v.paused && !v.muted)
            void v.play().catch(() => {
              mutedToPlay.current = true;
              v.muted = true;
              void v.play().catch(() => {});
            });
        }}
        onPlay={(e) => {
          setPlaying(true);
          if (!e.currentTarget.muted) keepSound(true);
        }}
        onPause={() => setPlaying(false)}
        onVolumeChange={(e) => {
          const m = e.currentTarget.muted;
          setSound({ of: item.primary, muted: m });
          // Still muted only to be let play (however often that is told): not the reader's doing.
          if (m && mutedToPlay.current) return;
          mutedToPlay.current = false;
          keepSound(!m);
        }}
        onError={() => setFailed(true)}
        onClick={() => {
          const v = videoRef.current;
          if (v) v.paused ? v.play() : v.pause();
        }}
      />
      {/* Its faces (⇧P), on the frame it is paused on: as large as the video is shown, centred as it is. */}
      {size && (
        <div className="video-faces" style={size}>
          <VideoFaceLayer item={item} time={time} paused={!playing} />
        </div>
      )}
      {elsewhere && (
        <div className="video-elsewhere panel">
          <DeviceMobile /> Playing on {elsewhere === "A browser" ? "another device" : `the ${elsewhere}`}
        </div>
      )}
      <div
        className={`video-controls panel ${controlsOn ? "visible" : ""}`}
        onMouseEnter={() => {
          overControls.current = true;
          poke();
        }}
        onMouseLeave={() => {
          overControls.current = false;
          poke();
        }}
      >
        <button
          className="btn sm icon"
          title="Play / pause (Space)"
          onClick={() => {
            const v = videoRef.current;
            if (v) v.paused ? v.play() : v.pause();
          }}
        >
          {playing ? <Pause /> : <Play />}
        </button>
        <span className="mono vtime">{formatTime(time)}</span>
        <div
          ref={barRef}
          className="vbar"
          onMouseMove={(e) => {
            const bar = barRef.current;
            if (!bar || !duration) return;
            const r = bar.getBoundingClientRect();
            const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            setHover({ t: f * duration, x: e.clientX - r.left });
          }}
          onMouseLeave={() => setHover(null)}
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
          {hover && <ScrubPreview src={mediaUrl(item)} time={hover.t} x={hover.x} />}
        </div>
        <span className="mono vtime">{formatTime(duration)}</span>
        <button
          className={`btn sm icon ${speed !== 1 ? "active" : ""}`}
          title="Playback speed ([ and ] to change, \\ to reset)"
          onClick={() => {
            const i = SPEEDS.indexOf(speed);
            const next = SPEEDS[(i + 1) % SPEEDS.length];
            const v = videoRef.current;
            if (v) v.playbackRate = next;
            setSpeed(next);
          }}
        >
          <Gauge /> {speed}×
        </button>
        <button
          className="btn sm icon"
          title="Mute (M)"
          onClick={() => {
            const v = videoRef.current;
            if (v) v.muted = !v.muted;
          }}
        >
          {muted ? <SpeakerSlash /> : <SpeakerHigh />}
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
