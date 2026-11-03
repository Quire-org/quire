import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, Check, CircleNotch, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { api, canThumb, mediaUrl, thumbUrl } from "../lib/api";
import { useArtists, type LocalArtist } from "../artistsStore";
import { useStore } from "../store";
import type { MediaItem } from "../lib/types";

/** The crop: the stage, and the circle cut from it (the icon), in CSS pixels. */
const STAGE = 340;
const CIRCLE = 280;
const EDGE = (STAGE - CIRCLE) / 2;
/** The icon kept, square (shown round), in pixels. */
const OUT = 512;

interface Crop {
  /** The picture's top left on the stage, and its scale (stage pixels a picture pixel). */
  x: number;
  y: number;
  k: number;
}

/**
 * An artist's icon cut from their art: one of their pictures (or an album's cover) picked, then a
 * circle placed on it, dragged and zoomed (wheel, slider, or + and −), with how it will look beside.
 */
export function ArtistIconChooser({ artist, pictures, onClose }: { artist: LocalArtist; pictures: MediaItem[]; onClose: () => void }) {
  const [picked, setPicked] = useState<MediaItem | null>(null);
  const root = useStore((s) => s.root);
  const art = pictures.filter((it) => it.kind === "image" || it.kind === "raw");
  return (
    <Modal title={`An icon for ${artist.name}`} onClose={onClose} wide>
      {picked ? (
        <CircleCrop artist={artist} item={picked} onBack={() => setPicked(null)} onDone={onClose} />
      ) : (
        <div className="icon-pick">
          <p className="small dim">Pick one of their pictures, then place the circle on it.</p>
          {art.length ? (
            <div className="icon-pick-grid">
              {art.slice(0, 300).map((it) => (
                <button key={it.key} className="icon-pick-tile" onClick={() => setPicked(it)} title={it.name}>
                  <img src={root && canThumb(it) ? thumbUrl(root, it, 120) : mediaUrl(it)} alt="" loading="lazy" draggable={false} />
                </button>
              ))}
            </div>
          ) : (
            <div className="dim small">None of their pictures are in the library yet: give them some, then cut an icon from one.</div>
          )}
          {artist.avatarChosen && (
            <div className="row">
              <button className="btn sm ghost" onClick={() => (void useArtists.getState().setIcon(artist.id, null), onClose())}>
                {artist.links.length ? `Their ${artist.links[0].platform} icon again` : "No icon"}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function CircleCrop({ artist, item, onBack, onDone }: { artist: LocalArtist; item: MediaItem; onBack: () => void; onDone: () => void }) {
  const [pic, setPic] = useState<{ url: string; bmp: ImageBitmap } | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [saving, setSaving] = useState(false);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  // The whole picture, read once: shown, and drawn from when the icon is kept.
  useEffect(() => {
    const root = useStore.getState().root;
    if (!root) return;
    let alive = true;
    let url = "";
    void api
      .readMediaImage(root, item.primary)
      .then(async (bytes) => {
        const blob = new Blob([bytes]);
        const bmp = await createImageBitmap(blob);
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setPic({ url, bmp });
        // Filling the circle, its middle across and its upper part down (where a face mostly is).
        const k = CIRCLE / Math.min(bmp.width, bmp.height);
        setCrop(fit({ x: STAGE / 2 - (bmp.width * k) / 2, y: EDGE - Math.max(0, bmp.height * k - CIRCLE) * 0.25, k }, bmp));
      })
      .catch((e) => useStore.getState().toast(`That picture couldn't be read: ${String(e)}`, "error"));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.primary]);

  const zoomRef = useRef((by: number, at?: { x: number; y: number }) => void [by, at]);
  const least = pic ? CIRCLE / Math.min(pic.bmp.width, pic.bmp.height) : 1;
  // Zoomed about a point of the stage, which stays where it is.
  const zoom = (k: number, at = { x: STAGE / 2, y: STAGE / 2 }) => {
    if (!pic || !crop) return;
    const to = Math.min(least * 8, Math.max(least, k));
    setCrop(fit({ k: to, x: at.x - ((at.x - crop.x) * to) / crop.k, y: at.y - ((at.y - crop.y) * to) / crop.k }, pic.bmp));
  };

  useEffect(() => {
    // Not passive, so the page doesn't scroll while the wheel zooms.
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomRef.current(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [pic]);
  zoomRef.current = (by, at) => void (crop && zoom(crop.k * by, at));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "+" || e.key === "=") zoomRef.current(1.15);
      else if (e.key === "-") zoomRef.current(1 / 1.15);
      else if (e.key === "Enter") void keep();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const down = (e: ReactPointerEvent) => {
    if (!crop) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, x: crop.x, y: crop.y };
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || !crop || !pic) return;
    setCrop(fit({ ...crop, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }, pic.bmp));
  };

  const keep = async () => {
    if (!pic || !crop || saving) return;
    setSaving(true);
    try {
      const c = document.createElement("canvas");
      c.width = c.height = OUT;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(pic.bmp, (EDGE - crop.x) / crop.k, (EDGE - crop.y) / crop.k, CIRCLE / crop.k, CIRCLE / crop.k, 0, 0, OUT, OUT);
      const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("the icon couldn't be made"))), "image/jpeg", 0.9));
      await useArtists.getState().setIcon(artist.id, blob);
      onDone();
    } catch (e) {
      useStore.getState().toast(String(e), "error");
      setSaving(false);
    }
  };

  const shown = (size: number) =>
    pic && crop ? { left: ((crop.x - EDGE) * size) / CIRCLE, top: ((crop.y - EDGE) * size) / CIRCLE, width: (pic.bmp.width * crop.k * size) / CIRCLE, height: (pic.bmp.height * crop.k * size) / CIRCLE } : undefined;

  return (
    <div className="icon-crop">
      <div className="icon-crop-stage" ref={stage} style={{ width: STAGE, height: STAGE }} onPointerDown={down} onPointerMove={move} onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)}>
        {pic && crop ? <img src={pic.url} alt="" draggable={false} style={{ left: crop.x, top: crop.y, width: pic.bmp.width * crop.k, height: pic.bmp.height * crop.k }} /> : <CircleNotch className="spin" />}
        <div className="icon-crop-circle" style={{ left: EDGE, top: EDGE, width: CIRCLE, height: CIRCLE }} />
      </div>
      <div className="icon-crop-side">
        <div className="icon-crop-previews">
          {[96, 40, 22].map((size) => (
            <span key={size} className="icon-crop-preview" style={{ width: size, height: size }}>
              {pic && <img src={pic.url} alt="" draggable={false} style={shown(size)} />}
            </span>
          ))}
        </div>
        <label className="icon-crop-zoom">
          <MagnifyingGlassMinus />
          <input type="range" min={0} max={1} step={0.001} value={crop ? Math.log(crop.k / least) / Math.log(8) : 0} onChange={(e) => zoom(least * Math.pow(8, Number(e.target.value)))} disabled={!crop} aria-label="Zoom" />
          <MagnifyingGlassPlus />
        </label>
        <p className="small dim">Drag to move the picture under the circle; the wheel, the slider or + and − zoom.</p>
        <span className="grow" />
        <div className="row">
          <button className="btn sm ghost" onClick={onBack}>
            <ArrowLeft /> Another picture
          </button>
          <span className="grow" />
          <button className="btn sm primary" disabled={!crop || saving} onClick={() => void keep()}>
            {saving ? <CircleNotch className="spin" /> : <Check />} Use as icon <kbd className="kbd">⏎</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Kept covering the circle: the picture never shows an edge inside it. */
function fit(c: Crop, bmp: ImageBitmap): Crop {
  const w = bmp.width * c.k;
  const h = bmp.height * c.k;
  return { k: c.k, x: Math.min(EDGE, Math.max(EDGE + CIRCLE - w, c.x)), y: Math.min(EDGE, Math.max(EDGE + CIRCLE - h, c.y)) };
}
