import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { isTypingTarget } from "../lib/hotkeys";
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, Eraser, Lasso, MagnifyingGlassPlus, PaintBrush, Scissors, Sparkle } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { MiniBrowser } from "./MiniBrowser";
import { useStore } from "../store";
import { api } from "../lib/api";
import { useEngine } from "../plugins/engine";
import { blobUrl, useScrapbook } from "../scrapbook/store";
import { useSourcePictures } from "../scrapbook/pictures";
import { edgeAround } from "../scrapbook/render";
import { checkStickerSpace, stickerContext, stickerImageData, stickerSpace } from "../scrapbook/color";
import { NO_TUNE, findSubjects, insidePolygon, lassoSubject, merge, onSubject, pieceOf, render, tuned, withCloserLook, type Piece, type Subject, type Tune } from "../scrapbook/subjects";
import { newId, type CustomSticker, type Target } from "../scrapbook/model";
import type { MediaItem } from "../lib/types";

/** The mask's longest side: enough for a sticker, light to work with. */
const SIDE = 1024;
/** A sticker's longest side when kept. */
const KEEP = 768;
/** The engine answers well within this, the model's first load included. */
const PATIENCE = 3 * 60_000;

/** What the subjects are cut from: the picture and the model's mask at one size, the parts at the cut chosen. */
interface Cut {
  item: MediaItem;
  W: number;
  H: number;
  pixels: Uint8ClampedArray;
  mask: Uint8Array;
  labels: Int32Array;
  /** Where the mask is cut (the sensitivity). */
  level: number;
}

/**
 * The sticker studio: cutting stickers from a picture, as WhatsApp does. The local cutout model
 * finds the picture's subjects, each lit up over the dimmed picture; pick one or several (or draw
 * round one by hand), fine-tune each (its edge grown or shrunk, softened, painted in or out), and
 * keep them: on the sticker shelf, and on the cover being made if there is one. Opened from a
 * cover in Scrapbook, from Browse (right-click a picture) or from the viewer.
 */
export function StickerStudio() {
  const studio = useScrapbook((x) => x.studio);
  const close = useScrapbook((x) => x.closeStudio);
  const [item, setItem] = useState<MediaItem | null>(studio?.item ?? null);
  const [chosen, setChosen] = useState<{ cut: Cut; subjects: Subject[] } | null>(null);
  if (!studio) return null;
  if (studio.sticker)
    return (
      <Modal title="Fine-tune the sticker" onClose={close} wide>
        <Retune sticker={studio.sticker} onDone={close} />
      </Modal>
    );
  return (
    <Modal title={chosen ? "Fine-tune the stickers" : "Make stickers"} onClose={close} wide>
      {chosen && <NewStickers cut={chosen.cut} subjects={chosen.subjects} onBack={() => setChosen(null)} onDone={close} />}
      {/* Kept while fine-tuning, so going back finds it as it was (no new run of the model). */}
      {item ? (
        <div hidden={!!chosen}>
          <Finder item={item} onBack={() => setItem(null)} onNext={(cut, subjects) => setChosen({ cut, subjects })} />
        </div>
      ) : (
        !chosen && <Picker target={studio.target} onPick={setItem} />
      )}
    </Modal>
  );
}

/* ---------------- 1. a picture ---------------- */

function Picker({ target, onPick }: { target?: Target; onPick: (it: MediaItem) => void }) {
  const own = useSourcePictures(target?.kind === "album" ? { kind: "album", key: target.key } : target?.kind === "tag" ? { kind: "tag", id: target.id } : { kind: "tag", id: "" });
  return (
    <div className="sticker-maker">
      <div className="dim small">Pick the picture to cut stickers from.</div>
      <MiniBrowser own={own} ownLabel={target?.kind === "album" ? "This album" : "Tagged"} row={170} onPick={onPick} />
    </div>
  );
}

/* ---------------- 2. its subjects ---------------- */

async function decode(bytes: ArrayBuffer | Blob): Promise<ImageBitmap> {
  return createImageBitmap(bytes instanceof Blob ? bytes : new Blob([bytes]));
}

/** A picture's pixels at W × H: in the stickers' colour space, or as plain values (a mask). */
function pixelsOf(img: ImageBitmap, W: number, H: number, colour = true): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = stickerContext(c, colour, true);
  ctx.drawImage(img, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H).data;
}

/** Whether the sticker cutter is here to use: no engine, an engine too old to know it, not downloaded, or ready. */
function useCutter(): "none" | "old" | "missing" | "ready" | null {
  const catalog = useEngine((x) => x.catalog);
  useEffect(() => {
    void useEngine.getState().refresh();
  }, []);
  if (!catalog) return null;
  if (!catalog.available) return "none";
  const m = catalog.models.find((x) => x.id === "cutout");
  if (!m) return "old";
  return m.downloaded ? "ready" : "missing";
}

function Download() {
  const dl = useEngine((x) => x.download);
  const size = useEngine((x) => x.catalog?.models.find((m) => m.id === "cutout")?.size ?? 0);
  const mine = dl?.id === "cutout";
  return (
    <div className="sticker-wait">
      <p>Finding the subjects needs the sticker cutter ({Math.round(size / 1e6)} MB, BiRefNet lite). It downloads once; then it works offline, and your pictures never leave this computer.</p>
      {mine ? (
        <div className="progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${dl!.total ? Math.round((100 * dl!.completed) / dl!.total) : 0}%` }} />
          </div>
          <span className="small dim">Downloading… also shown in Activity.</span>
        </div>
      ) : (
        <button className="btn primary" disabled={!!dl} onClick={() => void useEngine.getState().start("cutout")} title={dl ? "Another model is downloading" : undefined}>
          Download the sticker cutter
        </button>
      )}
    </div>
  );
}

/** Colours that tell the subjects apart, whatever the picture. */
const HUES = ["#ff3b6b", "#2ee6a6", "#3aa0ff", "#ffc53d", "#c06bff", "#ff8a3d", "#36e0ff", "#a3e635", "#ff5ad8", "#7c8cff", "#f5f5f5", "#ffd6a5"];

/** The sensitivity slider (0..100) as where the mask is cut: higher takes in more of what the model was unsure of. */
const levelOf = (sensitivity: number) => Math.round(230 - sensitivity * 2);

type Point = [number, number];
type Mode = "pick" | "outline" | "closer";

function Finder({ item, onBack, onNext }: { item: MediaItem; onBack: () => void; onNext: (cut: Cut, subjects: Subject[]) => void }) {
  const cutter = useCutter();
  const [base, setBase] = useState<{ W: number; H: number; pixels: Uint8ClampedArray; mask: Uint8Array } | null>(null);
  // Looking closer adds to the mask; what it was before, to take it back.
  const [history, setHistory] = useState<Uint8Array[]>([]);
  const [error, setError] = useState("");
  const [sensitivity, setSensitivity] = useState(51);
  // What is chosen and merged, kept as points on the picture: they hold when the sensitivity moves.
  const [chosen, setChosen] = useState<Point[]>([]);
  const [merges, setMerges] = useState<Point[][]>([]);
  const [drawn, setDrawn] = useState<Subject[]>([]);
  const [mode, setMode] = useState<Mode>("pick");
  const [path, setPath] = useState<Point[] | null>(null);
  const [looking, setLooking] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const level = levelOf(sensitivity);

  useEffect(() => {
    if (cutter !== "ready") return;
    let alive = true;
    (async () => {
      const root = useStore.getState().root;
      if (!root) return;
      try {
        const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the local engine did not answer in 3 minutes")), PATIENCE));
        const [res, bytes] = await Promise.race([Promise.all([api.scrapbookCutout(root, item.primary, SIDE), api.readMediaImage(root, item.primary)]), late]);
        const [picture, maskImg] = await Promise.all([decode(bytes), decode(pngOf(res.mask_base64)), checkStickerSpace()]);
        const W = res.width;
        const H = res.height;
        const pixels = pixelsOf(picture, W, H);
        const grey = pixelsOf(maskImg, W, H, false);
        const mask = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) mask[i] = grey[i * 4];
        if (!alive) return;
        setBase({ W, H, pixels, mask });
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [item, cutter]);

  // The parts at this cut; merged ones together; the ones drawn by hand; and which are chosen.
  const found = useMemo(() => (base ? findSubjects(base.mask, base.W, base.H, 12, level) : null), [base, level]);
  const subjects = useMemo(() => {
    if (!base || !found) return [];
    const loose = [...found.subjects, ...drawn];
    const on = (s: Subject, [x, y]: Point) => onSubject(s, found.labels, base.W, x, y);
    const joined: Subject[] = [];
    for (const group of merges) {
      const members = loose.filter((s) => group.some((p) => on(s, p)));
      if (members.length < 2) continue;
      for (const m of members) loose.splice(loose.indexOf(m), 1);
      joined.push(merge(members));
    }
    return [...joined, ...loose];
  }, [base, found, drawn, merges]);
  const isChosen = useMemo(() => subjects.map((s) => !!base && !!found && chosen.some(([x, y]) => onSubject(s, found.labels, base.W, x, y))), [subjects, chosen, base, found]);
  const picked = subjects.filter((_, i) => isChosen[i]);
  // The biggest subject chosen to start with.
  useEffect(() => {
    if (!found || chosen.length || !found.subjects.length || !base) return;
    const s = found.subjects[0];
    const x = Math.floor((s.x0 + s.x1) / 2);
    for (let y = s.y0; y < s.y1; y++) if (onSubject(s, found.labels, base.W, x, y)) return setChosen([[x, y]]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found]);

  // The picture dimmed; each subject lit, outlined thick in its own colour and numbered; the chosen tinted.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !base || !found) return;
    const { W, H, pixels } = base;
    c.width = W;
    c.height = H;
    const ctx = stickerContext(c);
    const owner = new Int16Array(W * H).fill(-1);
    const byLabel = new Map<number, number>();
    subjects.forEach((s, i) => s.parts.forEach((p) => p.label != null && byLabel.set(p.label, i)));
    for (let i = 0; i < W * H; i++) {
      const l = found.labels[i];
      if (l) owner[i] = byLabel.get(l) ?? -1;
    }
    subjects.forEach((s, i) =>
      s.parts.forEach((p) => {
        if (!p.poly) return;
        for (let y = s.y0; y < s.y1; y++) for (let x = s.x0; x < s.x1; x++) if (insidePolygon(p.poly, x + 0.5, y + 0.5)) owner[y * W + x] = i;
      }),
    );
    const out = new Uint8ClampedArray(W * H * 4);
    const rgb = HUES.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
    const t = Math.max(2, Math.round(W / 300));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = owner[i];
        let r = pixels[i * 4];
        let g = pixels[i * 4 + 1];
        let b = pixels[i * 4 + 2];
        if (o < 0) {
          r *= 0.35;
          g *= 0.35;
          b *= 0.35;
        } else {
          // Its outline: a pixel near one that isn't this subject's.
          let edge = false;
          for (let d = 1; d <= t && !edge; d++) edge = (x < d || owner[i - d] !== o) || (x >= W - d || owner[i + d] !== o) || (y < d || owner[i - d * W] !== o) || (y >= H - d || owner[i + d * W] !== o);
          const [hr, hg, hb] = rgb[o % rgb.length];
          if (edge) [r, g, b] = [hr, hg, hb];
          else if (isChosen[o]) [r, g, b] = [r * 0.75 + hr * 0.25, g * 0.75 + hg * 0.25, b * 0.75 + hb * 0.25];
        }
        out[i * 4] = r;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = b;
        out[i * 4 + 3] = 255;
      }
    ctx.putImageData(stickerImageData(out, W, H), 0, 0);
    // Numbers, a check on the chosen.
    const rad = Math.max(10, W / 40);
    ctx.font = `bold ${Math.round(rad * 1.1)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    subjects.forEach((s, i) => {
      const cx = Math.min(W - rad, Math.max(rad, s.x0 + rad));
      const cy = Math.min(H - rad, Math.max(rad, s.y0 + rad));
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fillStyle = HUES[i % HUES.length];
      ctx.fill();
      ctx.lineWidth = rad * 0.18;
      ctx.strokeStyle = isChosen[i] ? "#ffffff" : "rgba(0,0,0,0.6)";
      ctx.stroke();
      ctx.fillStyle = "#111";
      ctx.fillText(isChosen[i] ? "✓" : String(i + 1), cx, cy + 1);
    });
    if (path && path.length > 1) {
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash(mode === "closer" ? [10, 6] : []);
      ctx.lineWidth = Math.max(2, W / 350);
      ctx.beginPath();
      if (mode === "closer") {
        const [[x0, y0], [x1, y1]] = [path[0], path[path.length - 1]];
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      } else {
        path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }, [base, found, subjects, isChosen, path, mode]);

  const at = (e: ReactPointerEvent): Point => {
    const r = canvas.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * base!.W, ((e.clientY - r.top) / r.height) * base!.H];
  };
  const onDown = (e: ReactPointerEvent) => {
    if (!base || !found || looking) return;
    const p = at(e);
    if (mode !== "pick") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setPath([p]);
      return;
    }
    // A click on a subject picks it, or puts it back.
    const i = subjects.findIndex((s) => onSubject(s, found.labels, base.W, p[0], p[1]));
    if (i < 0) return;
    if (isChosen[i]) setChosen(chosen.filter(([x, y]) => !onSubject(subjects[i], found.labels, base.W, x, y)));
    else setChosen([...chosen, p]);
  };
  const onMove = (e: ReactPointerEvent) => {
    if (path) setPath([...path, at(e)]);
  };
  const onUp = () => {
    if (!path || !base || !found) return;
    const drawnPath = path;
    setPath(null);
    if (mode === "outline") {
      const s = lassoSubject(base.mask, base.W, base.H, drawnPath, true, level);
      if (!s) return;
      setDrawn([...drawn, s]);
      // Chosen at once: by a point inside what was drawn.
      const cy = Math.floor((s.y0 + s.y1) / 2);
      for (let x = s.x0; x < s.x1; x++) if (insidePolygon(s.parts[0].poly!, x + 0.5, cy + 0.5)) return setChosen([...chosen, [x + 0.5, cy + 0.5]]);
      return;
    }
    if (mode === "closer") void lookCloser(drawnPath[0], drawnPath[drawnPath.length - 1]);
  };

  // The model run again on just this part of the picture: what it finds there is added to what was found.
  const lookCloser = async ([ax, ay]: Point, [bx, by]: Point) => {
    if (!base) return;
    const x0 = Math.max(0, Math.min(ax, bx));
    const y0 = Math.max(0, Math.min(ay, by));
    const x1 = Math.min(base.W, Math.max(ax, bx));
    const y1 = Math.min(base.H, Math.max(ay, by));
    if (x1 - x0 < 8 || y1 - y0 < 8) return;
    const root = useStore.getState().root;
    if (!root) return;
    setLooking(true);
    try {
      const res = await api.scrapbookCutout(root, item.primary, SIDE, [x0 / base.W, y0 / base.H, x1 / base.W, y1 / base.H]);
      const part = await decode(pngOf(res.mask_base64));
      const rx = Math.floor(x0);
      const ry = Math.floor(y0);
      const rw = Math.ceil(x1) - rx;
      const rh = Math.ceil(y1) - ry;
      const mask = withCloserLook(base.mask, base.W, pixelsOf(part, rw, rh), rx, ry, rw, rh, 4);
      setHistory([...history, base.mask]);
      setBase({ ...base, mask });
      setMode("pick");
    } catch (e) {
      useStore.getState().toast(`Could not look closer: ${String(e)}`, "error");
    } finally {
      setLooking(false);
    }
  };

  const mergeChosen = () => {
    if (picked.length < 2 || !base || !found) return;
    // One point for each chosen subject: together they name the merge.
    const points = picked.map((s) => chosen.find(([x, y]) => onSubject(s, found.labels, base.W, x, y))!).filter(Boolean);
    setMerges([...merges.filter((g) => !g.some((p) => points.some((q) => q === p))), points]);
  };
  const unmergeChosen = () => {
    if (!base || !found) return;
    setMerges(merges.filter((g) => !picked.some((s) => s.parts.length > 1 && g.some(([x, y]) => onSubject(s, found.labels, base.W, x, y)))));
  };

  return (
    <div className="sticker-maker">
      <div className="row">
        <button className="btn sm ghost" onClick={onBack}>
          <ArrowLeft /> Another picture
        </button>
        <span className="mono small dim ellipsis grow">{item.name}</span>
      </div>
      {cutter === "missing" && <Download />}
      {cutter === "old" && <div className="sticker-wait">This copy's local engine is older than the app and doesn't have the sticker cutter. Rebuild it with <span className="mono">npm run engine</span>, then start the app again.</div>}
      {cutter === "none" && <div className="sticker-wait">This copy of Quire has no local engine. Build it with <span className="mono">npm run engine</span>.</div>}
      {cutter === "ready" && !base && !error && (
        <div className="sticker-wait dim">
          <Sparkle /> Finding the subjects… (the first picture also loads the model)
        </div>
      )}
      {error && <div className="sticker-wait index-failed">Could not find the subjects: {error}</div>}
      {base && found && (
        <div className="finder-layout">
          <div className={`sticker-stage ${looking ? "busy" : ""}`}>
            <canvas ref={canvas} className={mode !== "pick" ? "lasso" : ""} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setPath(null)} />
            {looking && (
              <div className="sticker-looking">
                <Sparkle /> Looking closer…
              </div>
            )}
          </div>
          <div className="tune-controls">
            <div className="scrap-field">
              <span className="small dim">Sensitivity</span>
              <input type="range" min={0} max={100} value={sensitivity} onChange={(e) => setSensitivity(Number(e.target.value))} title="Higher takes in more of what the model wasn't sure about" />
              <span className="mono small">{sensitivity}</span>
            </div>
            <div className="label">Draw</div>
            <div className="btn-group finder-modes">
              <button className={`btn sm ${mode === "pick" ? "active" : "ghost"}`} onClick={() => setMode("pick")} title="Click subjects to pick them or put them back">
                Pick
              </button>
              <button className={`btn sm ${mode === "outline" ? "active" : "ghost"}`} onClick={() => setMode("outline")} title="Draw round something: exactly that shape is cut out">
                <Lasso /> Outline
              </button>
              <button className={`btn sm ${mode === "closer" ? "active" : "ghost"}`} onClick={() => setMode("closer")} title="Drag a box: the model looks again at just that part, and adds what it finds">
                <MagnifyingGlassPlus /> Look closer
              </button>
            </div>
            <div className="dim small">
              {mode === "pick" ? "Click a subject to pick it or put it back." : mode === "outline" ? "Draw round what to cut out; let go to close the shape." : "Drag a box round something the model missed: what it finds there is added, and nothing already found is lost."}
            </div>
            {history.length > 0 && (
              <button className="btn sm ghost" onClick={() => (setBase({ ...base, mask: history[history.length - 1] }), setHistory(history.slice(0, -1)))}>
                <ArrowCounterClockwise /> Undo looking closer
              </button>
            )}
            <div className="row">
              <button className="btn sm ghost" disabled={picked.length < 2} onClick={mergeChosen} title="The chosen subjects as one sticker">
                Merge
              </button>
              <button className="btn sm ghost" disabled={!picked.some((s) => s.parts.length > 1)} onClick={unmergeChosen}>
                Unmerge
              </button>
              {subjects.length > 1 && (
                <button className="btn sm ghost" onClick={() => setChosen(subjects.map((s) => { const x = Math.floor((s.x0 + s.x1) / 2); for (let y = s.y0; y < s.y1; y++) if (onSubject(s, found.labels, base.W, x, y)) return [x, y] as Point; return [s.x0, s.y0] as Point; }))}>
                  All
                </button>
              )}
            </div>
            <div className="dim small">{subjects.length ? `${subjects.length} subject${subjects.length === 1 ? "" : "s"}, ${picked.length} chosen.` : "No subject at this sensitivity: raise it, look closer, or outline by hand."}</div>
            <span className="grow" />
            <button className="btn primary" disabled={!picked.length} onClick={() => onNext({ item, W: base.W, H: base.H, pixels: base.pixels, mask: base.mask, labels: found.labels, level }, picked)}>
              Fine-tune {picked.length > 1 ? picked.length : ""} <ArrowRight />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function pngOf(b64: string): Blob {
  return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/png" });
}

/* ---------------- 3. fine-tuning ---------------- */

/** A sticker's picture from a piece and its alpha: cropped to what is left of it, at most KEEP on its longest side. */
async function stickerPng(piece: Piece, alpha: Uint8ClampedArray): Promise<{ png: Blob; w: number; h: number } | null> {
  const out = render(piece, alpha);
  if (!out) return null;
  const k = Math.min(1, KEEP / Math.max(out.w, out.h));
  const src = document.createElement("canvas");
  src.width = out.w;
  src.height = out.h;
  stickerContext(src).putImageData(stickerImageData(out.data, out.w, out.h), 0, 0);
  const fin = document.createElement("canvas");
  fin.width = Math.max(1, Math.round(out.w * k));
  fin.height = Math.max(1, Math.round(out.h * k));
  const fctx = stickerContext(fin);
  fctx.imageSmoothingQuality = "high";
  fctx.drawImage(src, 0, 0, fin.width, fin.height);
  const png = await new Promise<Blob>((resolve, reject) => fin.toBlob((b) => (b ? resolve(b) : reject(new Error("could not make the sticker"))), "image/png"));
  return { png, w: fin.width, h: fin.height };
}

const pngOfPixels = (data: Uint8ClampedArray, w: number, h: number, colour: boolean) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  stickerContext(c, colour).putImageData(colour ? stickerImageData(data, w, h) : new ImageData(data, w, h), 0, 0);
  return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("could not keep the sticker's picture"))), "image/png"));
};

/** What is kept beside a sticker to fine-tune it again: the picture round it (opaque), and its cut's mask as grey. */
async function pieceFiles(piece: Piece): Promise<{ picture: Blob; mask: Blob }> {
  const n = piece.w * piece.h;
  const pic = new Uint8ClampedArray(piece.rgb);
  const mask = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) {
    pic[p * 4 + 3] = 255;
    mask[p * 4] = mask[p * 4 + 1] = mask[p * 4 + 2] = piece.alpha[p];
    mask[p * 4 + 3] = 255;
  }
  return { picture: await pngOfPixels(pic, piece.w, piece.h, true), mask: await pngOfPixels(mask, piece.w, piece.h, false) };
}

async function pixelsOfBlob(name: string, colour = true): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  await checkStickerSpace();
  const url = await blobUrl(name);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`could not read ${name}`));
    im.src = url;
  });
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = stickerContext(c, colour, true);
  ctx.drawImage(img, 0, 0);
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

/**
 * A sticker as it was cut, to tune again: its picture and mask, and the tuning it had. An older
 * sticker (made before they kept their picture) is its own picture with room round it, and can't be
 * painted back past its cut (`ceiling`).
 */
export async function loadPiece(s: CustomSticker): Promise<{ piece: Piece; ceiling: Uint8ClampedArray | null; tune: Tune }> {
  if (s.cut) {
    const [pic, mask] = await Promise.all([pixelsOfBlob(s.cut.picture), pixelsOfBlob(s.cut.mask, false)]);
    const alpha = new Uint8ClampedArray(pic.w * pic.h);
    for (let p = 0; p < alpha.length; p++) alpha[p] = mask.data[p * 4];
    if (!s.cut.solid) unveil(alpha);
    return { piece: { x0: 0, y0: 0, w: pic.w, h: pic.h, rgb: pic.data, alpha }, ceiling: s.cut.limited ? alpha : null, tune: s.cut.tune };
  }
  const st = await pixelsOfBlob(s.blob);
  const pad = Math.round(Math.max(st.w, st.h) * 0.1) + 16;
  const w = st.w + pad * 2;
  const h = st.h + pad * 2;
  const rgb = new Uint8ClampedArray(w * h * 4);
  const alpha = new Uint8ClampedArray(w * h);
  for (let y = 0; y < st.h; y++)
    for (let x = 0; x < st.w; x++) {
      const si = (y * st.w + x) * 4;
      const di = (y + pad) * w + x + pad;
      rgb.set(st.data.subarray(si, si + 3), di * 4);
      rgb[di * 4 + 3] = 255;
      alpha[di] = st.data[si + 3];
    }
  return { piece: { x0: 0, y0: 0, w, h, rgb, alpha: unveil(alpha) }, ceiling: alpha, tune: NO_TUNE };
}

/**
 * A sticker's alpha from before the edge was narrowed: what the model was a little unsure of had been
 * left see-through, a white veil over the sticker. Made as solid as it would be cut now (the old
 * band was four times as wide); the colours under it were kept, so they come back as they were.
 */
function unveil(a: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < a.length; i++) if (a[i] > 0 && a[i] < 255) a[i] = Math.max(0, Math.min(255, Math.round(128 + (a[i] - 128) * 4)));
  return a;
}

/** The tuned alpha, no higher than the ceiling where there is one. */
function capped(alpha: Uint8ClampedArray, ceiling: Uint8ClampedArray | null | undefined): Uint8ClampedArray {
  if (!ceiling) return alpha;
  const out = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = Math.min(alpha[i], ceiling[i]);
  return out;
}

/** New stickers from the subjects chosen: each kept with the picture round it and its mask, to tune again later. */
function NewStickers({ cut, subjects, onBack, onDone }: { cut: Cut; subjects: Subject[]; onBack: () => void; onDone: () => void }) {
  const pieces = useMemo(() => subjects.map((s) => pieceOf(cut.pixels, cut.mask, cut.labels, cut.W, cut.H, s, cut.level)), [cut, subjects]);
  const save = async (tunes: Tune[]) => {
    const made: CustomSticker[] = [];
    const sb = useScrapbook.getState();
    for (let i = 0; i < pieces.length; i++) {
      const out = await stickerPng(pieces[i], tuned(pieces[i], tunes[i]));
      if (!out) continue;
      const id = newId();
      const files = await pieceFiles(pieces[i]);
      const [blob, picture, mask] = [`sticker-${id}.png`, `sticker-${id}-picture.png`, `sticker-${id}-mask.png`];
      await sb.putBlob(blob, out.png);
      await sb.putBlob(picture, files.picture);
      await sb.putBlob(mask, files.mask);
      const sticker: CustomSticker = { id, blob, w: out.w, h: out.h, from: cut.item.name, source: cut.item.key, made: Date.now(), cut: { picture, mask, tune: tunes[i], solid: true } };
      sb.addSticker(sticker);
      made.push(sticker);
    }
    const editing = !!useScrapbook.getState().editing;
    if (editing) useScrapbook.getState().place(made);
    useStore.getState().toast(editing ? `${made.length} sticker${made.length === 1 ? "" : "s"} made and put on the cover` : `${made.length} sticker${made.length === 1 ? "" : "s"} made: on your shelf in Scrapbook (Stickers → Mine)`, "ok");
    onDone();
  };
  return <Tuner pieces={pieces} onBack={onBack} onSave={save} saveLabel={`Save ${pieces.length > 1 ? `${pieces.length} stickers` : "the sticker"}`} />;
}

/** A sticker made before, fine-tuned again: every cover with it on takes the new one. */
function Retune({ sticker, onDone }: { sticker: CustomSticker; onDone: () => void }) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadPiece>> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    loadPiece(sticker).then(
      (r) => alive && setLoaded(r),
      (e) => alive && setError(String(e)),
    );
    return () => {
      alive = false;
    };
  }, [sticker]);
  if (error) return <div className="dim">Could not open the sticker: {error}</div>;
  if (!loaded) return <div className="dim small">Opening the sticker…</div>;
  const save = async ([tune]: Tune[]) => {
    const out = await stickerPng(loaded.piece, capped(tuned(loaded.piece, tune), loaded.ceiling));
    if (!out) throw new Error("nothing is left of it");
    const sb = useScrapbook.getState();
    const blob = `sticker-${newId()}.png`;
    await sb.putBlob(blob, out.png);
    let cut = sticker.cut;
    if (!cut || !cut.solid) {
      // An older sticker: what it was is kept from now on (its mask made solid), to tune again.
      const files = await pieceFiles(loaded.piece);
      cut = { picture: cut?.picture ?? `sticker-${sticker.id}-picture.png`, mask: `sticker-${sticker.id}-mask-${newId()}.png`, tune, limited: cut ? cut.limited : true, solid: true };
      if (!sticker.cut) await sb.putBlob(cut.picture, files.picture);
      await sb.putBlob(cut.mask, files.mask);
    }
    void sb.replaceSticker({ ...sticker, blob, w: out.w, h: out.h, cut: { ...cut, tune } });
    useStore.getState().toast("Sticker fine-tuned: every cover with it on takes the new one", "ok");
    onDone();
  };
  return (
    <Tuner
      pieces={[loaded.piece]}
      initial={[loaded.tune]}
      ceilings={[loaded.ceiling]}
      onSave={save}
      saveLabel="Save the sticker"
      note={loaded.ceiling ? "Made before stickers kept their picture: it can be trimmed, softened and erased, but nothing outside it painted back." : undefined}
    />
  );
}

type Backdrop = "checks" | "black" | "white";
const BACKDROP_KEY = "quire.tuneBackdrop";
function loadBackdrop(): Backdrop {
  try {
    const b = localStorage.getItem(BACKDROP_KEY);
    return b === "black" || b === "white" ? b : "checks";
  } catch {
    return "checks";
  }
}

function Tuner({ pieces, initial, ceilings, onBack, onSave, saveLabel, note }: { pieces: Piece[]; initial?: Tune[]; ceilings?: (Uint8ClampedArray | null)[]; onBack?: () => void; onSave: (tunes: Tune[]) => Promise<void>; saveLabel: string; note?: string }) {
  const [tunes, setTunes] = useState<Tune[]>(() => initial ?? pieces.map(() => NO_TUNE));
  const [at, setAt] = useState(0);
  const [brush, setBrush] = useState<"keep" | "erase" | null>(null);
  const [size, setSize] = useState(12);
  const [edge, setEdge] = useState(true);
  const [saving, setSaving] = useState(false);
  const piece = pieces[at];
  const tune = tunes[at];
  const setTune = (t: Tune) => setTunes((all) => all.map((x, i) => (i === at ? t : x)));
  const ceiling = ceilings?.[at];
  const alpha = useMemo(() => capped(tuned(piece, tune), ceiling), [piece, tune, ceiling]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // The stroke being painted: its number and where its last dab went (a fast stroke is filled in between).
  const stroke = useRef<{ id: number; last: { x: number; y: number } } | null>(null);
  // Zoomed in (1: it fits) and moved (CSS pixels from the middle), as in the viewer's loupe.
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  // The brush's circle where the pointer is (stage pixels), `k` CSS pixels to a sticker pixel; shown in the middle a moment while its size changes.
  const [cursor, setCursor] = useState<{ x: number; y: number; k: number } | null>(null);
  const [sizing, setSizing] = useState<{ k: number } | null>(null);
  const moving = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  // What it is seen against: see-through checks, or black or white to spot stray bits (kept for next time).
  const [backdrop, setBackdrop] = useState<Backdrop>(loadBackdrop);
  const pickBackdrop = (b: Backdrop) => {
    setBackdrop(b);
    try {
      localStorage.setItem(BACKDROP_KEY, b);
    } catch {
      // Kept for this time only.
    }
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const data = new Uint8ClampedArray(piece.rgb);
    for (let p = 0; p < piece.w * piece.h; p++) data[p * 4 + 3] = alpha[p];
    const raw = document.createElement("canvas");
    raw.width = piece.w;
    raw.height = piece.h;
    stickerContext(raw).putImageData(stickerImageData(data, piece.w, piece.h), 0, 0);
    // With the cut edge it gets on a cover, or as it is.
    const shown = edge ? edgeAround(raw, "#ffffff", Math.max(3, piece.w * 0.03), stickerSpace()) : raw;
    c.width = shown.width;
    c.height = shown.height;
    const ctx = stickerContext(c);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(shown, 0, 0);
  }, [piece, alpha, edge]);

  /** CSS pixels to a sticker pixel, as the sticker is shown now. */
  const scaleNow = () => {
    const c = canvas.current;
    return c && c.width ? c.getBoundingClientRect().width / c.width : 1;
  };
  const clampView = (v: { zoom: number; x: number; y: number }) => {
    const r = stage.current?.getBoundingClientRect();
    if (!r) return v;
    const mx = (r.width * (v.zoom - 1)) / 2;
    const my = (r.height * (v.zoom - 1)) / 2;
    return { zoom: v.zoom, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) };
  };
  /** Zoomed by `factor` about a point (client pixels): what is under it stays under it. From fit up to 8×. */
  const zoomAt = (cx: number, cy: number, factor: number) =>
    setView((v) => {
      const r = stage.current?.getBoundingClientRect();
      if (!r) return v;
      const zoom = Math.min(8, Math.max(1, v.zoom * factor));
      if (zoom <= 1.001) return { zoom: 1, x: 0, y: 0 };
      const qx = cx - (r.left + r.width / 2);
      const qy = cy - (r.top + r.height / 2);
      const ux = (qx - v.x) / v.zoom;
      const uy = (qy - v.y) / v.zoom;
      return clampView({ zoom, x: qx - zoom * ux, y: qy - zoom * uy });
    });

  // Pinch (or ⌘/ctrl with the wheel) zooms where the pointer is; a plain scroll moves the zoomed sticker.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      else setView((v) => (v.zoom > 1 ? clampView({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }) : v));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // [ and ] the brush's size, Z in and out, ⌫ or ⌘Z the last stroke back, Space held to move instead of paint.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (e.key === "[" || e.key === "]") resize(e.key === "]" ? Math.min(120, Math.round(size * 1.25) + 1) : Math.max(1, Math.round(size / 1.25)));
      else if (key === "z" && (e.metaKey || e.ctrlKey)) undoStroke();
      else if (key === "z") {
        const r = stage.current?.getBoundingClientRect();
        if (view.zoom > 1) setView({ zoom: 1, x: 0, y: 0 });
        else if (r) zoomAt(cursor ? r.left + cursor.x : r.left + r.width / 2, cursor ? r.top + cursor.y : r.top + r.height / 2, 2.5);
      } else if (e.key === "Backspace") undoStroke();
      else if (e.key === " ") {
        if (!e.repeat) setSpaceHeld(true);
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onUp = (e: KeyboardEvent) => e.key === " " && setSpaceHeld(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
    };
  });

  // A new size: its circle shown in the middle a moment, so you see how big it is.
  const sizingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resize = (next: number) => {
    setSize(next);
    setSizing({ k: scaleNow() });
    if (sizingTimer.current) clearTimeout(sizingTimer.current);
    sizingTimer.current = setTimeout(() => setSizing(null), 700);
  };
  useEffect(() => () => void (sizingTimer.current && clearTimeout(sizingTimer.current)), []);

  const undoStroke = () =>
    setTunes((all) =>
      all.map((t, i) => {
        if (i !== at || !t.dabs.length) return t;
        const last = t.dabs[t.dabs.length - 1].stroke;
        const keep = last == null ? t.dabs.slice(0, -1) : t.dabs.filter((d) => d.stroke !== last);
        return { ...t, dabs: keep };
      }),
    );

  /** The brush where the pointer is, in the piece's pixels. */
  const spot = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    const off = (c.width - piece.w) / 2;
    return { x: ((e.clientX - r.left) / r.width) * c.width - off, y: ((e.clientY - r.top) / r.height) * c.height - off };
  };
  const dab = (e: ReactPointerEvent) => {
    const s = stroke.current;
    if (!brush || !s) return;
    const p = spot(e);
    // From the last dab to here, a dab every half radius: no gaps however fast the stroke.
    const d = Math.hypot(p.x - s.last.x, p.y - s.last.y);
    const n = Math.max(1, Math.ceil(d / Math.max(1, size / 2)));
    const dabs = Array.from({ length: n }, (_, i) => ({ x: s.last.x + ((p.x - s.last.x) * (i + 1)) / n, y: s.last.y + ((p.y - s.last.y) * (i + 1)) / n, r: size, keep: brush === "keep", stroke: s.id }));
    s.last = p;
    setTunes((all) => all.map((t, i) => (i === at ? { ...t, dabs: [...t.dabs, ...dabs] } : t)));
  };
  const track = (e: { clientX: number; clientY: number }) => {
    const r = stage.current?.getBoundingClientRect();
    if (r) setCursor({ x: e.clientX - r.left, y: e.clientY - r.top, k: scaleNow() });
  };
  const moveMode = !brush || spaceHeld;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(tunes);
    } catch (e) {
      useStore.getState().toast(`Could not save the sticker: ${String(e)}`, "error");
      setSaving(false);
    }
  };

  return (
    <div className="sticker-maker">
      <div className="row">
        {onBack && (
          <button className="btn sm ghost" onClick={onBack}>
            <ArrowLeft /> Choose again
          </button>
        )}
        {note && <span className="small dim">{note}</span>}
        <span className="grow" />
        {pieces.length > 1 && <span className="small dim">Sticker {at + 1} of {pieces.length}</span>}
      </div>
      <div className="tune-layout">
        <div
          ref={stage}
          className={`tune-stage on-${backdrop} ${moveMode ? (view.zoom > 1 ? "movable" : "") : "painting"}`}
          onPointerDown={(e) => {
            // Moving the zoomed sticker: with no brush, or with Space held.
            if (!moveMode || view.zoom <= 1) return;
            (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
            moving.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          }}
          onPointerMove={(e) => {
            track(e);
            const m = moving.current;
            if (m) setView((v) => clampView({ ...v, x: m.vx + e.clientX - m.x, y: m.vy + e.clientY - m.y }));
            else if (stroke.current) dab(e);
          }}
          onPointerUp={() => {
            moving.current = null;
            stroke.current = null;
          }}
          onPointerCancel={() => {
            moving.current = null;
            stroke.current = null;
          }}
          onPointerLeave={() => setCursor(null)}
        >
          <div className="tune-zoom" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            <canvas
              ref={canvas}
              onPointerDown={(e) => {
                if (moveMode) return;
                e.stopPropagation();
                (e.currentTarget.parentElement?.parentElement as Element | null)?.setPointerCapture?.(e.pointerId);
                const p = spot(e);
                stroke.current = { id: Date.now(), last: p };
                setTunes((all) => all.map((t, i) => (i === at ? { ...t, dabs: [...t.dabs, { ...p, r: size, keep: brush === "keep", stroke: stroke.current!.id }] } : t)));
              }}
            />
          </div>
          {brush && !spaceHeld && (cursor || sizing) && (
            <div
              className={`brush-cursor ${brush === "erase" ? "mode-1" : ""}`}
              style={
                cursor && !sizing
                  ? { left: cursor.x, top: cursor.y, width: 2 * size * cursor.k, height: 2 * size * cursor.k }
                  : { left: "50%", top: "50%", width: 2 * size * (sizing?.k ?? 1), height: 2 * size * (sizing?.k ?? 1) }
              }
            />
          )}
          {view.zoom > 1.001 && <div className="zoom-badge mono">{Math.round(view.zoom * 100)}%</div>}
        </div>
        <div className="tune-controls">
          <div className="scrap-field">
            <span className="small dim">Edge</span>
            <input type="range" min={-12} max={12} step={1} value={tune.edge} onChange={(e) => setTune({ ...tune, edge: Number(e.target.value) })} title="Shrink (left) or grow (right) the cut" />
            <span className="mono small">{tune.edge > 0 ? `+${tune.edge}` : tune.edge}</span>
          </div>
          <div className="scrap-field">
            <span className="small dim">Soft</span>
            <input type="range" min={0} max={8} step={1} value={tune.soft} onChange={(e) => setTune({ ...tune, soft: Number(e.target.value) })} title="Soften the cut's edge" />
            <span className="mono small">{tune.soft}</span>
          </div>
          <div className="label">Brush</div>
          <div className="row">
            <span className="btn-group">
              <button className={`btn sm ${brush === "keep" ? "active" : "ghost"}`} onClick={() => setBrush(brush === "keep" ? null : "keep")} title="Paint back in what was cut away">
                <PaintBrush /> Keep
              </button>
              <button className={`btn sm ${brush === "erase" ? "active" : "ghost"}`} onClick={() => setBrush(brush === "erase" ? null : "erase")} title="Paint away what doesn't belong">
                <Eraser /> Erase
              </button>
            </span>
          </div>
          <div className="scrap-field">
            <span className="small dim">Size</span>
            <input type="range" min={1} max={120} step={1} value={size} onChange={(e) => resize(Number(e.target.value))} title="The brush's size ([ and ])" />
            <span className="mono small">{size}</span>
          </div>
          <div className="row">
            <button className="btn sm ghost" disabled={!tune.dabs.length} onClick={undoStroke} title="Take the last stroke back (⌫)">
              Undo stroke
            </button>
            <button className="btn sm ghost" disabled={tune === NO_TUNE} onClick={() => setTune(NO_TUNE)}>
              Reset
            </button>
          </div>
          <div className="dim small tune-keys">Pinch or ⌘-scroll to zoom, scroll to move, Z in and out. [ ] the brush; hold Space to move while painting.</div>
          <div className="scrap-field">
            <span className="small dim">Behind it</span>
            <span className="btn-group">
              {(["checks", "black", "white"] as const).map((b) => (
                <button key={b} className={`btn sm ${backdrop === b ? "active" : "ghost"}`} onClick={() => pickBackdrop(b)} title={b === "checks" ? "See-through shows as checks" : `On ${b}, to spot stray bits`}>
                  {b === "checks" ? "Checks" : b === "black" ? "Black" : "White"}
                </button>
              ))}
            </span>
          </div>
          <label className="check small">
            <input type="checkbox" checked={edge} onChange={(e) => setEdge(e.target.checked)} /> Show with its cut edge
          </label>
          {pieces.length > 1 && (
            <div className="tune-strip">
              {pieces.map((_, i) => (
                <button key={i} className={`btn sm ${i === at ? "active" : "ghost"}`} onClick={() => setAt(i)}>
                  {i + 1}
                </button>
              ))}
            </div>
          )}
          <span className="grow" />
          <button className="btn primary" disabled={saving} onClick={() => void save()}>
            <Scissors /> {saving ? "Saving…" : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
