import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { describe, isIdentity, LOSSY, useEdit } from "../editStore";
import type { EditTools, MediaItem } from "../lib/types";
import { ArrowClockwise, ArrowCounterClockwise, ArrowsHorizontal, ArrowsVertical, Check, Crop, FloppyDisk, Scissors, SpeakerSlash, Warning, X } from "@phosphor-icons/react";
import { Popover } from "./Popover";
import { usePlugins } from "../plugins/store";
import { Select } from "./Select";
import { resultSize } from "../editStore";

const IMAGE_TARGETS: [string, string][] = [["jpg", "JPEG"], ["png", "PNG"], ["webp", "WebP"], ["tiff", "TIFF"]];
const VIDEO_TARGETS: [string, string][] = [["mp4-h264", "MP4 H.264"], ["mp4-h265", "MP4 H.265"], ["webm-vp9", "WebM"], ["gif", "GIF"], ["mp3", "MP3 audio"]];
const ASPECTS: [string, number | null][] = [["Free", null], ["1:1", 1], ["4:3", 4 / 3], ["3:2", 3 / 2], ["16:9", 16 / 9], ["9:16", 9 / 16]];

/** Bottom bar in edit mode: the controls, a summary of pending edits, cancel / save as copy / overwrite. */
export function EditBar({ item, items, videoDuration }: { item: MediaItem; items: MediaItem[]; videoDuration: number }) {
  const s = useStore();
  const e = useEdit();
  const p = e.pipeline;
  const [tools, setTools] = useState<EditTools | null>(null);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number; frac: number } | null>(null);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [fmtOpen, setFmtOpen] = useState(false);
  // Drafts for the popovers; applied to the pipeline only on Apply.
  const [sizeDraft, setSizeDraft] = useState("");
  const [fmtDraft, setFmtDraft] = useState("");
  const [qDraft, setQDraft] = useState<"small" | "balanced" | "high">("balanced");
  const frame = useEdit((st) => st.frame);
  const sizeNow = resultSize(frame, p);
  const sizeIf = resultSize(frame, { ...p, upscale: sizeDraft.startsWith("x") ? (Number(sizeDraft.slice(1)) as 2 | 4) : null, resizeWidth: sizeDraft && !sizeDraft.startsWith("x") ? Number(sizeDraft) : null });
  const openSize = () => {
    setSizeDraft(p.upscale ? `x${p.upscale}` : p.resizeWidth ? String(p.resizeWidth) : "");
    setSizeOpen(true);
  };
  const openFmt = () => {
    setFmtDraft(p.format ?? "");
    setQDraft(p.quality);
    setFmtOpen(true);
  };
  const fmtLabel = (v: string) => [...IMAGE_TARGETS, ...VIDEO_TARGETS].find(([k]) => k === v)?.[1] ?? v.toUpperCase();
  const isVideo = item.kind === "video";
  const targets = isVideo ? VIDEO_TARGETS : IMAGE_TARGETS;
  const needsFfmpeg = isVideo || (item.kind !== "raw" && !/\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(item.primary));
  const ffmpegMissing = needsFfmpeg && tools !== null && !tools.ffmpeg;

  // Editing closes a plugin's panel: one tool at a time.
  useEffect(() => usePlugins.getState().setPanelOpen(null), []);

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
        <button className={chip(e.cropping)} disabled={dis} onClick={() => e.setState({ cropping: !e.cropping })} title="Crop: drag the window's edges, corners or middle on the preview">
          {e.cropping ? <Check /> : <Crop />} {e.cropping ? "Done" : p.crop ? "Adjust" : "Crop"}
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
        <Popover
          open={sizeOpen}
          onClose={() => setSizeOpen(false)}
          trigger={
            <button className={chip(!!(p.upscale || p.resizeWidth))} disabled={dis} onClick={() => (sizeOpen ? setSizeOpen(false) : openSize())} title="Resize or upscale (applied on save)">
              {p.upscale ? `${p.upscale}× → ${sizeNow?.w ?? "?"}×${sizeNow?.h ?? "?"}` : p.resizeWidth ? `→ ${sizeNow?.w ?? "?"}×${sizeNow?.h ?? "?"}` : "Size"}
            </button>
          }
        >
          <div className="pop-title">Output size</div>
          <div className="pop-list">
            {[
              ["", "Keep"],
              ["x2", "Upscale 2×"],
              ["x4", "Upscale 4×"],
              ["3840", "3840 wide (4K)"],
              ["1920", "1920 wide"],
              ["1280", "1280 wide"],
              ["800", "800 wide"],
            ].map(([v, l]) => (
              <button key={v} className={`btn sm ${sizeDraft === v ? "active" : "ghost"}`} onClick={() => setSizeDraft(v)}>
                {l}
              </button>
            ))}
          </div>
          <div className="mono small dim pop-note">
            {frame ? `${sizeNow?.w}×${sizeNow?.h} → ${sizeIf?.w}×${sizeIf?.h}` : "reading size…"}
            {sizeDraft.startsWith("x") && " · Lanczos, no invented detail"}
          </div>
          <div className="row pop-actions">
            <button className="btn sm ghost" onClick={() => setSizeOpen(false)}>
              Cancel
            </button>
            <span className="grow" />
            <button
              className="btn sm primary"
              onClick={() => {
                if (!sizeDraft) e.set({ upscale: null, resizeWidth: null });
                else if (sizeDraft.startsWith("x")) e.set({ upscale: Number(sizeDraft.slice(1)) as 2 | 4, resizeWidth: null });
                else e.set({ resizeWidth: Number(sizeDraft), upscale: null });
                setSizeOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </Popover>
        {(p.upscale || p.resizeWidth) && (
          <button className="btn sm ghost" onClick={() => e.set({ upscale: null, resizeWidth: null })} title="Clear size change">
            <X />
          </button>
        )}

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
            <Select
              compact
              disabled={dis}
              title="Playback speed"
              value={p.speed ? String(p.speed) : ""}
              onChange={(v) => e.set({ speed: v ? Number(v) : null })}
              options={[
                { value: "", label: "1× speed" },
                { value: "0.25", label: "0.25×" },
                { value: "0.5", label: "0.5×" },
                { value: "2", label: "2×" },
                { value: "4", label: "4×" },
              ]}
            />
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
        <Popover
          open={fmtOpen}
          onClose={() => setFmtOpen(false)}
          trigger={
            <button className={chip(!!p.format)} disabled={dis} onClick={() => (fmtOpen ? setFmtOpen(false) : openFmt())} title="Convert on save">
              {p.format ? `→ ${fmtLabel(p.format)}${LOSSY.has(p.format) ? ` · ${p.quality}` : ""}` : "Format"}
            </button>
          }
        >
          <div className="pop-title">Output format</div>
          <div className="pop-list">
            <button className={`btn sm ${fmtDraft === "" ? "active" : "ghost"}`} onClick={() => setFmtDraft("")}>
              Keep ({item.primary.split(".").pop()?.toUpperCase()})
            </button>
            {(p.extractFrame != null ? IMAGE_TARGETS : targets).map(([v, l]) => (
              <button key={v} className={`btn sm ${fmtDraft === v ? "active" : "ghost"}`} onClick={() => setFmtDraft(v)}>
                {l}
              </button>
            ))}
          </div>
          {fmtDraft && LOSSY.has(fmtDraft) && (
            <>
              <div className="label pop-sub">Quality</div>
              <div className="chips">
                {(["small", "balanced", "high"] as const).map((q) => (
                  <button key={q} className={`btn sm ${qDraft === q ? "active" : ""}`} onClick={() => setQDraft(q)}>
                    {q}
                  </button>
                ))}
              </div>
            </>
          )}
          {fmtDraft && !LOSSY.has(fmtDraft) && <div className="mono small dim pop-note">Lossless format, no quality setting.</div>}
          <div className="row pop-actions">
            <button className="btn sm ghost" onClick={() => setFmtOpen(false)}>
              Cancel
            </button>
            <span className="grow" />
            <button
              className="btn sm primary"
              onClick={() => {
                e.set({ format: fmtDraft || null, quality: qDraft });
                setFmtOpen(false);
              }}
            >
              Apply
            </button>
          </div>
        </Popover>
        {p.format && (
          <button className="btn sm ghost" onClick={() => e.set({ format: null })} title="Clear conversion">
            <X />
          </button>
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
        <button className="btn" disabled={busy || isIdentity(p) || ffmpegMissing} onClick={() => void save(false)} title="Keep the original and save the result next to it; Info says which it was made from">
          Save as copy
        </button>
        <button className="btn primary" disabled={busy || isIdentity(p) || ffmpegMissing} onClick={() => void save(true)} title="The result takes the original's place (the rating carries over); the original is kept, and Revert in Info brings it back">
          <FloppyDisk /> Overwrite
        </button>
      </div>
    </div>
  );
}
