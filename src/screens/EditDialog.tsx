import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Modal } from "../components/Modal";
import type { EditOp, EditTools } from "../lib/types";
import { ArrowClockwise, ArrowCounterClockwise, ArrowsClockwise, ArrowsOutSimple, Swap, Warning } from "@phosphor-icons/react";

const IMAGE_TARGETS = [
  ["jpg", "JPEG"],
  ["png", "PNG"],
  ["webp", "WebP"],
  ["tiff", "TIFF"],
];
const VIDEO_TARGETS = [
  ["mp4-h264", "MP4 · H.264 (plays everywhere)"],
  ["mp4-h265", "MP4 · H.265 (half the size)"],
  ["webm-vp9", "WebM · VP9"],
  ["gif", "GIF (640 px, 12 fps)"],
  ["mp3", "MP3 (audio only)"],
];

/** Rotate, upscale or convert the current item or a selection. */
export function EditDialog() {
  const s = useStore();
  const items = s.editItems;
  const [tools, setTools] = useState<EditTools | null>(null);
  const [replace, setReplace] = useState(false);
  const [quality, setQuality] = useState<"small" | "balanced" | "high">("balanced");
  const [format, setFormat] = useState("");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number; frac: number } | null>(null);

  useEffect(() => {
    api.editTools().then(setTools).catch(() => setTools({ ffmpeg: null, ffprobe: null, version: null, encoders: [] }));
  }, []);

  const videos = items.filter((i) => i.kind === "video").length;
  const stills = items.length - videos;
  const needsFfmpeg = videos > 0 || items.some((i) => i.kind !== "video" && !/\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(i.primary) && i.kind !== "raw");
  const ffmpegMissing = needsFfmpeg && tools !== null && !tools.ffmpeg;
  const targets = videos > 0 && stills === 0 ? VIDEO_TARGETS : stills > 0 && videos === 0 ? IMAGE_TARGETS : [];
  useEffect(() => {
    if (!format && targets.length) setFormat(targets[0][0]);
  }, [targets, format]);

  const run = async (op: EditOp) => {
    setBusy(true);
    setProg({ done: 0, total: items.length, frac: 0 });
    try {
      const out = await s.applyEdit(items, op, replace, (done, total, frac) => setProg({ done, total, frac }));
      if (out.length) s.toast(`${out.length} file${out.length === 1 ? "" : "s"} ${replace ? "replaced" : "created"}`, "ok");
      if (out.length === items.length) s.set({ editOpen: false });
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  const pct = prog ? Math.round(((prog.done + prog.frac) / Math.max(1, prog.total)) * 100) : 0;
  const label = items.length === 1 ? items[0].name : `${items.length} items`;

  return (
    <Modal title={`Edit · ${label}`} onClose={() => !busy && s.set({ editOpen: false })} wide>
      <p className="dim small">
        Edits never touch the original in place: the result is saved next to it{replace ? ", and the original goes to the trash" : " with a suffix"}.
        {stills > 0 && " Image metadata (EXIF) is not carried over."}
      </p>
      {ffmpegMissing && (
        <div className="verdict unknown">
          <p className="small">
            <Warning /> Videos and formats like HEIC need ffmpeg, which is not installed. On macOS: <span className="mono">brew install ffmpeg</span>. Rotating,
            upscaling and converting JPEG, PNG, WebP and TIFF works without it.
          </p>
        </div>
      )}
      {tools?.ffmpeg && <p className="faint small mono">{tools.version}</p>}

      <section>
        <h3>
          <ArrowsClockwise /> Rotate
        </h3>
        <div className="row">
          <button className="btn" disabled={busy || ffmpegMissing} onClick={() => void run({ kind: "rotate", degrees: 270 })}>
            <ArrowCounterClockwise /> 90° left
          </button>
          <button className="btn" disabled={busy || ffmpegMissing} onClick={() => void run({ kind: "rotate", degrees: 90 })}>
            <ArrowClockwise /> 90° right
          </button>
          <button className="btn" disabled={busy || ffmpegMissing} onClick={() => void run({ kind: "rotate", degrees: 180 })}>
            180°
          </button>
          {videos > 0 && <span className="dim small">Videos: rotation flag only, no re-encoding.</span>}
        </div>
      </section>

      <hr className="rule" />
      <section>
        <h3>
          <ArrowsOutSimple /> Upscale
        </h3>
        <div className="row">
          <button className="btn" disabled={busy || ffmpegMissing} onClick={() => void run({ kind: "upscale", factor: 2 })}>
            2×
          </button>
          <button className="btn" disabled={busy || ffmpegMissing} onClick={() => void run({ kind: "upscale", factor: 4 })}>
            4×
          </button>
          <span className="dim small">Lanczos resampling: sharper than the viewer's zoom, no invented detail. Videos re-encode to H.264.</span>
        </div>
      </section>

      <hr className="rule" />
      <section>
        <h3>
          <Swap /> Convert
        </h3>
        {targets.length === 0 ? (
          <p className="dim small">Select only photos or only videos to convert.</p>
        ) : (
          <div className="row">
            <select className="input" value={format} onChange={(e) => setFormat(e.target.value)} disabled={busy}>
              {targets.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <div className="chips">
              {(["small", "balanced", "high"] as const).map((q) => (
                <button key={q} className={`btn sm ${quality === q ? "active" : ""}`} onClick={() => setQuality(q)} disabled={busy}>
                  {q}
                </button>
              ))}
            </div>
            <button className="btn primary" disabled={busy || !format || (videos > 0 && !tools?.ffmpeg)} onClick={() => void run({ kind: "convert", format, quality })}>
              Convert
            </button>
          </div>
        )}
      </section>

      <hr className="rule" />
      <label className="check side-row">
        <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} disabled={busy} /> Replace original (moves it to the trash, keeps the rating)
      </label>
      {prog && (
        <div className="progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="mono faint small">
            {Math.min(prog.done + 1, prog.total)}/{prog.total} · {pct}%
          </div>
        </div>
      )}
    </Modal>
  );
}
