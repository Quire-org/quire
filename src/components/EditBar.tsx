import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { describe, isIdentity, LOSSY, useEdit } from "../editStore";
import type { EditTools, MediaItem } from "../lib/types";
import { ArrowClockwise, ArrowCounterClockwise, ArrowsHorizontal, ArrowsVertical, Crop, FloppyDisk, Scissors, SpeakerSlash, Warning, X } from "@phosphor-icons/react";

const IMAGE_TARGETS: [string, string][] = [["jpg", "JPEG"], ["png", "PNG"], ["webp", "WebP"], ["tiff", "TIFF"]];
const VIDEO_TARGETS: [string, string][] = [["mp4-h264", "MP4 H.264"], ["mp4-h265", "MP4 H.265"], ["webm-vp9", "WebM"], ["gif", "GIF"], ["mp3", "MP3 audio"]];
const ASPECTS: [string, number | null][] = [["Free", null], ["1:1", 1], ["4:3", 4 / 3], ["3:2", 3 / 2], ["16:9", 16 / 9], ["9:16", 9 / 16]];

/** Bottom bar in edit mode: the controls, a summary of pending edits, save as copy / overwrite / cancel. */
export function EditBar({ item, items, videoDuration }: { item: MediaItem; items: MediaItem[]; videoDuration: number }) {
  const s = useStore();
  const e = useEdit();
  const p = e.pipeline;
  const [tools, setTools] = useState<EditTools | null>(null);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number; frac: number } | null>(null);
  const isVideo = item.kind === "video";
  const targets = isVideo ? VIDEO_TARGETS : IMAGE_TARGETS;
  const needsFfmpeg = isVideo || (item.kind !== "raw" && !/\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(item.primary));
  const ffmpegMissing = needsFfmpeg && tools !== null && !tools.ffmpeg;

  useEffect(() => {
    api.editTools().then(setTools).catch(() => setTools({ ffmpeg: null, ffprobe: null, version: null, encoders: [] }));
  }, []);

  const save = async (replace: boolean) => {
    if (isIdentity(p)) return;
    setBusy(true);
    setProg({ done: 0, total: items.length, frac: 0 });
    try {
      const out = await s.applyEdit(items, p, replace, (done, total, frac) => setProg({ done, total, frac }));
      if (out.length) s.toast(`${out.length} file${out.length === 1 ? "" : "s"} ${replace ? "overwritten" : "saved as copies"}`, "ok");
      if (out.length === items.length) s.leaveEdit();
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  const pct = prog ? Math.round(((prog.done + prog.frac) / Math.max(1, prog.total)) * 100) : 0;
  const changes = describe(p);
  const chip = (on: boolean) => `btn sm ${on ? "active" : ""}`;
  const dis = busy || ffmpegMissing;

  return (
    <div className="hud hud-bottom edit-bar">
      <div className="hud-row edit-row">
        <span className="label">Rotate</span>
        <button className="btn sm" disabled={dis} onClick={() => e.set({ rotate: (((p.rotate + 270) % 360) as 0 | 90 | 180 | 270) })} title="90° left">
          <ArrowCounterClockwise />
        </button>
        <button className="btn sm" disabled={dis} onClick={() => e.set({ rotate: (((p.rotate + 90) % 360) as 0 | 90 | 180 | 270) })} title="90° right">
          <ArrowClockwise />
        </button>
        <button className={chip(p.flipH)} disabled={dis} onClick={() => e.set({ flipH: !p.flipH })} title="Flip horizontal">
          <ArrowsHorizontal />
        </button>
        <button className={chip(p.flipV)} disabled={dis} onClick={() => e.set({ flipV: !p.flipV })} title="Flip vertical">
          <ArrowsVertical />
        </button>

        <span className="label">Crop</span>
        <button className={chip(e.cropping)} disabled={dis} onClick={() => e.setState({ cropping: !e.cropping })} title="Drag a rectangle on the preview">
          <Crop /> {e.cropping ? "Drawing…" : p.crop ? "Edit" : "Crop"}
        </button>
        {e.cropping && (
          <span className="chips">
            {ASPECTS.map(([l, a]) => (
              <button key={l} className={chip(e.cropAspect === a)} onClick={() => e.setState({ cropAspect: a })}>
                {l}
              </button>
            ))}
          </span>
        )}
        {p.crop && (
          <button className="btn sm ghost" onClick={() => e.set({ crop: null })} title="Remove crop">
            <X />
          </button>
        )}

        <span className="label">Size</span>
        <select
          className="input slide-interval"
          value={p.upscale ? `x${p.upscale}` : p.resizeWidth ? String(p.resizeWidth) : ""}
          disabled={dis}
          onChange={(ev) => {
            const v = ev.target.value;
            if (!v) e.set({ upscale: null, resizeWidth: null });
            else if (v.startsWith("x")) e.set({ upscale: Number(v.slice(1)) as 2 | 4, resizeWidth: null });
            else e.set({ resizeWidth: Number(v), upscale: null });
          }}
        >
          <option value="">Keep</option>
          <option value="x2">Upscale 2×</option>
          <option value="x4">Upscale 4×</option>
          <option value="3840">3840 wide (4K)</option>
          <option value="1920">1920 wide</option>
          <option value="1280">1280 wide</option>
          <option value="800">800 wide</option>
        </select>

        {isVideo && (
          <>
            <span className="label">Video</span>
            <button className={chip(!!p.trim)} disabled={dis} onClick={() => e.set({ trim: p.trim ? null : [0, Math.max(0.1, videoDuration)] })} title="Trim: set in and out points with the sliders">
              <Scissors /> Trim
            </button>
            {p.trim && (
              <span className="trim-ctl mono small">
                <input type="range" min={0} max={videoDuration} step={0.1} value={p.trim[0]} onChange={(ev) => e.set({ trim: [Math.min(Number(ev.target.value), p.trim![1] - 0.1), p.trim![1]] })} />
                {p.trim[0].toFixed(1)}s
                <input type="range" min={0} max={videoDuration} step={0.1} value={p.trim[1]} onChange={(ev) => e.set({ trim: [p.trim![0], Math.max(Number(ev.target.value), p.trim![0] + 0.1)] })} />
                {p.trim[1].toFixed(1)}s
              </span>
            )}
            <select className="input slide-interval" value={p.speed ?? ""} disabled={dis} onChange={(ev) => e.set({ speed: ev.target.value ? Number(ev.target.value) : null })} title="Playback speed">
              <option value="">1×</option>
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
            <button className={chip(p.mute)} disabled={dis} onClick={() => e.set({ mute: !p.mute })} title="Remove the audio track">
              <SpeakerSlash />
            </button>
            <button className={chip(p.extractFrame != null)} disabled={dis} onClick={() => e.set({ extractFrame: p.extractFrame != null ? null : Math.min(videoDuration, p.trim?.[0] ?? 0) })} title="Save the current frame as a photo instead of a video">
              Frame
            </button>
            {p.extractFrame != null && (
              <span className="trim-ctl mono small">
                <input type="range" min={0} max={videoDuration} step={0.1} value={p.extractFrame} onChange={(ev) => e.set({ extractFrame: Number(ev.target.value) })} />
                {p.extractFrame.toFixed(1)}s
              </span>
            )}
          </>
        )}

        <span className="label">Format</span>
        <select className="input slide-interval" value={p.format ?? ""} disabled={dis} onChange={(ev) => e.set({ format: ev.target.value || null })}>
          <option value="">Keep</option>
          {(p.extractFrame != null ? IMAGE_TARGETS : targets).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        {p.format && LOSSY.has(p.format) && (
          <span className="chips">
            {(["small", "balanced", "high"] as const).map((q) => (
              <button key={q} className={chip(p.quality === q)} onClick={() => e.set({ quality: q })} disabled={dis}>
                {q}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className="hud-row edit-row">
        {ffmpegMissing ? (
          <span className="small" style={{ color: "var(--warn)" }}>
            <Warning /> This file needs ffmpeg (brew install ffmpeg).
          </span>
        ) : (
          <span className="dim small ellipsis grow">
            {changes.length ? changes.join(" · ") : "No edits yet."}
            {items.length > 1 ? ` · applies to ${items.length} items` : ""}
            {item.kind !== "video" && " · EXIF is not carried over"}
          </span>
        )}
        {prog && (
          <span className="progress edit-progress">
            <span className="progress-bar">
              <span className="progress-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="mono faint small">{pct}%</span>
          </span>
        )}
        <button className="btn ghost" disabled={busy} onClick={s.leaveEdit}>
          <X /> Cancel <kbd className="kbd">Esc</kbd>
        </button>
        <button className="btn" disabled={busy || isIdentity(p) || ffmpegMissing} onClick={() => void save(true)} title="Replace the original (it goes to the trash, the rating carries over)">
          Overwrite
        </button>
        <button className="btn primary" disabled={busy || isIdentity(p) || ffmpegMissing} onClick={() => void save(false)} title="Keep the original and save the result next to it">
          <FloppyDisk /> Save as copy
        </button>
      </div>
    </div>
  );
}
