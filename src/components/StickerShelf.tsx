import { useEffect, useState, type DragEvent } from "react";
import { Scissors, Trash } from "@phosphor-icons/react";
import { blobUrl, useScrapbook } from "../scrapbook/store";
import type { CustomSticker, StickerSource } from "../scrapbook/model";
import { CATEGORIES, STICKERS } from "../scrapbook/stickers";

/** A sticker being dragged off the shelf, as what it is: put down where it is dropped. */
export const STICKER_DRAG = "application/x-scrap-sticker";
export type DraggedSticker = { src: StickerSource; aspect: number; custom: boolean };

function dragSticker(ev: DragEvent, src: StickerSource, aspect: number, custom: boolean) {
  ev.dataTransfer.setData(STICKER_DRAG, JSON.stringify({ src, aspect, custom } satisfies DraggedSticker));
  ev.dataTransfer.effectAllowed = "copy";
}

function BlobImg({ name, alt }: { name: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void blobUrl(name).then((u) => alive && setUrl(u), () => {});
    return () => {
      alive = false;
    };
  }, [name]);
  return url ? <img src={url} alt={alt} draggable={false} /> : <span className="dim small">…</span>;
}

/**
 * The stickers to put on: the ones cut from pictures (mine) and the built-in ones, by kind. Clicked
 * to add one, or dragged to where it goes.
 */
export function StickerShelf({ onAdd, onMake, stickers }: { onAdd: (src: StickerSource, aspect: number, custom: boolean) => void; onMake: () => void; stickers: CustomSticker[] }) {
  const [cat, setCat] = useState<string>(stickers.length ? "mine" : "love");
  const removeSticker = useScrapbook((x) => x.removeSticker);
  const shown = STICKERS.filter((s) => s.category === cat);
  return (
    <section className="scrap-shelf">
      <div className="chips">
        <button className={`chip ${cat === "mine" ? "active" : ""}`} onClick={() => setCat("mine")}>
          <Scissors /> Mine
        </button>
        {CATEGORIES.map((c) => (
          <button key={c.id} className={`chip ${cat === c.id ? "active" : ""}`} onClick={() => setCat(c.id)}>
            {c.name}
          </button>
        ))}
      </div>
      {cat === "mine" ? (
        <>
          <button className="btn sm primary" onClick={onMake} title="Find the subjects of a picture and cut them out as stickers">
            <Scissors /> Cut stickers from a picture
          </button>
          <div className="scrap-grid">
            {stickers.map((s) => (
              <div key={s.id} className="scrap-tile sticker" draggable onDragStart={(ev) => dragSticker(ev, { blob: s.blob }, s.h / s.w, true)} onClick={() => onAdd({ blob: s.blob }, s.h / s.w, true)} title={s.from ? `From ${s.from}` : "Add it"}>
                <BlobImg name={s.blob} alt={s.from ?? "sticker"} />
                <button className="chip-x scrap-tile-x" title="Take it off the shelf (covers using it keep it)" onClick={(ev) => (ev.stopPropagation(), removeSticker(s.id))}>
                  <Trash />
                </button>
              </div>
            ))}
          </div>
          {!stickers.length && <div className="dim small">None yet. Cut some from your pictures: each subject the model finds becomes a sticker.</div>}
        </>
      ) : (
        <div className="scrap-grid">
          {shown.map((s) => (
            <button key={s.id} className="scrap-tile sticker" draggable onDragStart={(ev) => dragSticker(ev, { builtin: s.id }, 1, false)} onClick={() => onAdd({ builtin: s.id }, 1, false)} title={s.name}>
              <img src={s.full} alt={s.name} draggable={false} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {cat !== "mine" && <div className="faint small">Fluent Emoji by Microsoft (MIT).</div>}
    </section>
  );
}
