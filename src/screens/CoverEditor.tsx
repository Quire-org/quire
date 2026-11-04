import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { AppWindow, ArrowArcLeft, ArrowArcRight, ArrowDown, ArrowLeft, ArrowLineDown, ArrowLineUp, ArrowRight, ArrowUp, ArrowsClockwise, ArrowsHorizontal, ArrowsIn, ArrowsLeftRight, CaretDown, Check, Copy, DownloadSimple, FrameCorners, Image as ImageIcon, MagnifyingGlassMinus, MagnifyingGlassPlus, NotePencil, PaintBrush, PaintBucket, PencilSimple, Plus, SidebarSimple, Smiley, TextT, Trash, UploadSimple } from "@phosphor-icons/react";
import { useStore } from "../store";
import { MiniBrowser, PICTURE_DRAG } from "../components/MiniBrowser";
import { StickerShelf, STICKER_DRAG, type DraggedSticker } from "../components/StickerShelf";
import { Select } from "../components/Select";
import { Popover } from "../components/Popover";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { isTypingTarget } from "../lib/hotkeys";
import { assets, exportCover, pictureAspect, useScrapbook } from "../scrapbook/store";
import { openBoardWindow } from "../scrapbook/boardWindow";
import { copyPicture, useSourcePictures } from "../scrapbook/pictures";
import { NOTE_FONT, barAt, barSpan, drawBackdrop, drawLayers, fontsReady, layerAt, layerSize, noteMetrics, textMetrics } from "../scrapbook/render";
import { ARROW_COLOURS, BACKGROUNDS, BAR_STYLES, BOARD_MAX, BOARD_MIN, BOARD_SIZES, FIX_PLACES, NOTE_PAPERS, PIN_COLOURS, TAPE_COLOURS, newBar, newId, pageOf, resized, type ArrowLayer, type Background, type Bar, type CustomSticker, type Fix, type Layer, type NoteLayer, type PatternId, type ScrapDoc, type StickerSource, type TextLayer } from "../scrapbook/model";
import { FONTS, LOOKS, ORIGINAL, currentLook, fontById, fontCss, lookById, withLook } from "../scrapbook/looks";
import type { MediaItem } from "../lib/types";

/**
 * Scrapbook: making a cover for an album (shaped like its pages), a banner for a tag (2:1), or a board
 * of its own (any size, for references: notes, arrows, pictures dropped or pasted in). What can be put
 * on it is on the left (P, S, T, and N and A on a board), clicked or dragged onto the page; above the
 * page, the settings of what is selected, or of the page itself when nothing is. On the page, drawn as
 * it will be saved: click to select (⇧ adds), drag across the empty page to select several, drag to
 * move, a corner to resize, the knob to turn, double-click a text or a note to type in it; ⌘-scroll
 * zooms. Done renders a cover and gives it to the album or tag; a board keeps itself as it goes.
 * Export saves either as a picture anywhere.
 */

type AddTab = "pictures" | "stickers" | "text" | "notes";

/** Whether what can be added is hidden, kept for next time: for covers and for boards apart (a board takes most by dropping and pasting). */
const hiddenKey = (board: boolean) => `quire.scrapAddHidden.${board ? "board" : "cover"}`;
function readHidden(board: boolean): boolean {
  try {
    return localStorage.getItem(hiddenKey(board)) === "1";
  } catch {
    return false;
  }
}

export function CoverEditor() {
  const e = useScrapbook((x) => x.editing);
  const sb = useScrapbook(useShallow((x) => ({ change: x.change, undo: x.undo, redo: x.redo, done: x.done, cancel: x.cancel })));
  const onBoard = useScrapbook((x) => x.editing?.doc.kind === "board");
  const [tab, setTab] = useState<AddTab>(() => (onBoard ? "pictures" : "stickers"));
  const [hidden, setHidden] = useState(() => readHidden(onBoard));
  const hide = useCallback(
    (on: boolean) => {
      setHidden(on);
      try {
        localStorage.setItem(hiddenKey(onBoard), on ? "1" : "0");
      } catch {
        /* kept for this time only */
      }
    },
    [onBoard],
  );
  // The whole cover seen in one theme's look, without changing it until kept.
  const [preview, setPreview] = useState("");
  const showTab = useRef<(t: AddTab) => void>(() => {});
  showTab.current = (t) => {
    setTab(t);
    hide(false);
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (isTypingTarget(ev.target)) return;
      const st = useScrapbook.getState();
      const ed = st.editing;
      if (!ed) return;
      const ids = chosen(ed);
      const mod = ev.metaKey || ev.ctrlKey;
      const key = ev.key.toLowerCase();
      if (mod && key === "z") {
        ev.preventDefault();
        if (ev.shiftKey) st.redo();
        else st.undo();
      } else if (mod && key === "d" && ids.length) {
        ev.preventDefault();
        duplicate(ids);
      } else if ((ev.key === "Delete" || ev.key === "Backspace") && ids.length) {
        ev.preventDefault();
        remove(ids);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        if (ids.length) st.select(null);
      } else if (ids.length && ev.key.startsWith("Arrow")) {
        ev.preventDefault();
        const step = ev.shiftKey ? 0.02 : 0.004;
        const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
        const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
        const these = new Set(ids);
        st.change((d) => ({ ...d, layers: d.layers.map((l) => (these.has(l.id) ? { ...l, x: l.x + dx, y: l.y + dy } : l)), bars: d.bars?.map((b) => (these.has(b.id) ? { ...b, x: b.x + dx } : b)) }), `nudge:${ids.join()}`);
      } else if (!mod && !ev.altKey) {
        // What can be added, by its key: the pictures and stickers to pick from, a text, a note or an arrow at once.
        const board = ed.doc.kind === "board";
        if (key === "p") showTab.current("pictures");
        else if (key === "s") showTab.current("stickers");
        else if (key === "t") addText(currentLook().id);
        else if (board && key === "n") addNote(NOTE_PAPERS[0]);
        else if (board && key === "a") addArrow(ARROW_COLOURS[0], "end");
        else return;
        ev.preventDefault();
      }
    };
    // A board takes a picture pasted (⌘V) as one more on it.
    const onPaste = (ev: ClipboardEvent) => {
      if (isTypingTarget(ev.target) || useScrapbook.getState().editing?.doc.kind !== "board") return;
      const files = Array.from(ev.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      ev.preventDefault();
      void addFiles(files);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, []);

  if (!e) return null;
  const doc = e.doc;
  const shown = preview ? withLook(doc, preview) : doc;
  const board = doc.kind === "board";

  return (
    <div className="screen scrap-screen">
      <div className="scrap-top row">
        <button className={`btn sm ${hidden ? "ghost" : "active"}`} onClick={() => hide(!hidden)} title={hidden ? "Show what can be added: pictures, stickers, text (P, S, T)" : "Hide what can be added: the page gets the room"} aria-pressed={!hidden}>
          <SidebarSimple />
        </button>
        {board ? (
          <button className="btn sm ghost" onClick={() => void sb.done()} disabled={e.saving} title="Back to the boards: it is kept as you go">
            <ArrowLeft /> {e.saving ? "Closing…" : "Close"}
          </button>
        ) : (
          <button className="btn sm ghost" onClick={sb.cancel} title="Leave without saving">
            <ArrowLeft /> Cancel
          </button>
        )}
        <span className="label">
          Scrapbook · {e.target.kind === "board" ? "board" : e.target.kind === "album" ? "cover of" : "banner of"} <b>{board ? (doc.name ?? e.target.name) : e.target.name}</b>
        </span>
        <span className="grow" />
        <span className="small dim">See it in</span>
        <Select compact value={preview} options={[{ value: "", label: "Its own looks" }, ...LOOKS.map((l) => ({ value: l.id, label: l.name }))]} onChange={setPreview} title="Every text and sticker in one theme's look, to see how it would be; nothing changes until you keep it" />
        {preview && (
          <button
            className="btn sm"
            onClick={() => {
              sb.change((d) => withLook(d, preview));
              setPreview("");
            }}
            title="Keep the cover in this look (Undo takes it back)"
          >
            Keep this look
          </button>
        )}
        <button className="btn sm ghost" onClick={sb.undo} disabled={!e.past.length} title="Undo (⌘Z)">
          <ArrowArcLeft />
        </button>
        <button className="btn sm ghost" onClick={sb.redo} disabled={!e.future.length} title="Redo (⇧⌘Z)">
          <ArrowArcRight />
        </button>
        <ExportButton doc={shown} />
        {board ? (
          <span className="small dim" title="Every change is kept with the library as you make it">
            Kept as you go
          </span>
        ) : (
          <button className="btn sm primary" onClick={() => void sb.done()} disabled={e.saving}>
            <Check /> {e.saving ? "Saving…" : "Done"}
          </button>
        )}
      </div>
      <div className={`scrap-layout ${hidden ? "hidden" : ""}`}>
        {!hidden && <AddPanel board={board} name={doc.name ?? "Board"} target={e.target} tab={tab} onTab={setTab} />}
        <div className="scrap-work">
          <SettingsBar doc={doc} />
          <Page doc={shown} selected={e.selected} many={e.many} typing={e.typing} />
        </div>
      </div>
    </div>
  );
}

/** Saves the cover as you see it as a PNG or JPEG, wherever you pick. */
function ExportButton({ doc }: { doc: ScrapDoc }) {
  const target = useScrapbook((x) => x.editing?.target);
  const [busy, setBusy] = useState(false);
  if (!target) return null;
  return (
    <button
      className="btn sm"
      disabled={busy}
      title="Save it as a picture (PNG or JPEG), as you see it, at twice its size"
      onClick={() => {
        setBusy(true);
        void exportCover(doc, target).finally(() => setBusy(false));
      }}
    >
      <DownloadSimple /> {busy ? "Exporting…" : "Export"}
    </button>
  );
}

/* ---------------- putting things on the page ---------------- */

/** What is selected: all of a selection of several, else the one. */
const chosen = (e: { selected: string | null; many: string[] }) => (e.many.length > 1 ? e.many : e.selected ? [e.selected] : []);

/** Where a new thing goes: about the middle, a little askew, as if put down by hand (or where it was dropped). */
const spot = (at?: { x: number; y: number }, turn = 16) => ({ x: at?.x ?? 0.5 + (Math.random() - 0.5) * 0.2, y: at?.y ?? 0.5 + (Math.random() - 0.5) * 0.2, rot: Math.round((Math.random() - 0.5) * turn) });

/** A size for a new thing, as a share of the page: a board is larger, so what goes on it starts smaller. */
function sized(cover: number, banner: number, onBoard: number): number {
  const kind = useScrapbook.getState().editing?.doc.kind;
  return kind === "board" ? onBoard : kind === "tag" ? banner : cover;
}

/** A layer put on the page and selected; `typing`, ready to be typed into. */
function put(layer: Layer, typing = false) {
  const st = useScrapbook.getState();
  if (!st.editing) return;
  st.change((d) => ({ ...d, layers: [...d.layers, layer] }));
  if (typing) st.type(layer.id);
  else st.select(layer.id);
}

function addSticker(src: StickerSource, aspect: number, custom: boolean, at?: { x: number; y: number }) {
  put({ id: newId(), type: "sticker", src, look: ORIGINAL, outline: custom, aspect, ...spot(at), w: sized(0.32, 0.14, 0.1) });
}

function addText(look: string) {
  const e = useScrapbook.getState().editing;
  if (!e) return;
  const text = e.doc.kind === "board" ? "Text" : e.target.name;
  put({ id: newId(), type: "text", text, font: lookById(look).font, size: sized(0.07, 0.16, 0.05), look, align: "center", ...spot(undefined, 0), w: 0 }, true);
}

function addNote(paper: string, at?: { x: number; y: number }) {
  put({ id: newId(), type: "note", text: "", paper, fix: useStore.getState().boardFix, ...spot(at, 6), w: 0.14 }, true);
}

function addArrow(color: string, heads: ArrowLayer["heads"]) {
  put({ id: newId(), type: "arrow", color, thickness: 0.006, heads, ...spot(undefined, 0), w: 0.16 });
}

/** A picture put on the page being made: its copy (`blob`) or, on a board, the library's picture it points at (`item`). */
function placePhoto(picture: { blob: string; item?: string }, aspect: number, at?: { x: number; y: number }) {
  const kind = useScrapbook.getState().editing?.doc.kind;
  if (!kind) return;
  const board = kind === "board";
  put({
    id: newId(),
    type: "photo",
    blob: picture.blob,
    ...(picture.item ? { item: picture.item } : {}),
    aspect,
    // On a board, as references are put up: bare, held up as the library is set to, nearly straight.
    frame: board ? "none" : "polaroid",
    fix: board ? useStore.getState().boardFix : null,
    ...spot(at, board ? 6 : 16),
    w: board ? 0.2 : kind === "tag" ? 0.22 : 0.5,
  });
}

/** A picture of the library put on the page: copied, or on a board pointed at as the library is set to. */
async function placePicture(it: MediaItem, at?: { x: number; y: number }) {
  try {
    const board = useScrapbook.getState().editing?.doc.kind === "board";
    if (board && useStore.getState().boardPictures === "link") return placePhoto({ blob: "", item: it.key }, await pictureAspect(it), at);
    const { blob, aspect } = await copyPicture(it, board ? FILE_MAX : 1400);
    placePhoto({ blob }, aspect, at);
  } catch (err) {
    useStore.getState().toast(`Could not use ${it.name}: ${String(err)}`, "error");
  }
}

/** Largest side of a picture from a file put on a board: enough for a reference seen full screen. */
const FILE_MAX = 2400;

/** Pictures from files (dropped, pasted or picked) put on a board, each a copy of its own no larger than FILE_MAX; one after another from `at`. */
async function addFiles(files: File[], at?: { x: number; y: number }) {
  for (const [i, f] of files.entries()) {
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, FILE_MAX / Math.max(bmp.width, bmp.height));
      // Kept as it is where it can be; else drawn smaller, a PNG when it may be see-through.
      const png = f.type !== "image/jpeg";
      let blob: Blob = f;
      if (k < 1 || !["image/png", "image/jpeg"].includes(f.type)) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(bmp.width * k));
        c.height = Math.max(1, Math.round(bmp.height * k));
        c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
        blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("could not read it"))), png ? "image/png" : "image/jpeg", 0.9));
      }
      const aspect = bmp.height / bmp.width;
      bmp.close();
      const name = `board-${newId()}.${png ? "png" : "jpg"}`;
      await useScrapbook.getState().putBlob(name, blob);
      placePhoto({ blob: name }, aspect, at ? { x: Math.min(1, at.x + i * 0.02), y: Math.min(1, at.y + i * 0.02) } : undefined);
    } catch (err) {
      useStore.getState().toast(`Could not use ${f.name || "the picture"}: ${String(err)}`, "error");
    }
  }
}

/** Copies of these layers (or a bar), a little down and right, selected instead. */
function duplicate(ids: string[]) {
  const st = useScrapbook.getState();
  const doc = st.editing?.doc;
  if (!doc) return;
  const these = new Set(ids);
  const layers = doc.layers.filter((l) => these.has(l.id)).map((l) => ({ ...l, id: newId(), x: l.x + 0.03, y: l.y + 0.03 }));
  const bars = (doc.bars ?? []).filter((b) => these.has(b.id)).map((b) => ({ ...b, id: newId(), x: Math.min(1, b.x + 0.06) }));
  st.change((d) => ({ ...d, layers: [...d.layers, ...layers], bars: [...(d.bars ?? []), ...bars] }));
  const made = [...layers, ...bars].map((x) => x.id);
  if (made.length > 1) st.selectMany(made);
  else st.select(made[0] ?? null);
}

/** These layers or bars taken off the page. */
function remove(ids: string[]) {
  const st = useScrapbook.getState();
  const these = new Set(ids);
  st.change((d) => ({ ...d, layers: d.layers.filter((l) => !these.has(l.id)), bars: d.bars?.filter((b) => !these.has(b.id)) }));
  st.select(null);
}

/** These layers moved in the stack together, keeping their own order: one step up or down, or to the front or the back. */
function restack(ids: string[], to: "up" | "down" | "top" | "bottom") {
  const these = new Set(ids);
  useScrapbook.getState().change((d) => {
    const picked = d.layers.filter((l) => these.has(l.id));
    if (!picked.length) return d;
    const rest = d.layers.filter((l) => !these.has(l.id));
    if (to === "top") return { ...d, layers: [...rest, ...picked] };
    if (to === "bottom") return { ...d, layers: [...picked, ...rest] };
    const layers = d.layers.slice();
    if (to === "up") {
      for (let i = layers.length - 2; i >= 0; i--) if (these.has(layers[i].id) && !these.has(layers[i + 1].id)) [layers[i], layers[i + 1]] = [layers[i + 1], layers[i]];
    } else {
      for (let i = 1; i < layers.length; i++) if (these.has(layers[i].id) && !these.has(layers[i - 1].id)) [layers[i], layers[i - 1]] = [layers[i - 1], layers[i]];
    }
    return { ...d, layers };
  });
}

/** The sticker on the shelf a layer shows (one cut from a picture, still on the shelf), to fine-tune it. */
function shelfSticker(layer: Layer | undefined): CustomSticker | undefined {
  if (layer?.type !== "sticker" || !("blob" in layer.src)) return undefined;
  const blob = layer.src.blob;
  return useScrapbook.getState().lib?.stickers.find((s) => s.blob === blob);
}

/* ---------------- what can be added ---------------- */

/**
 * What can be put on the page, by kind (each with its key). Drawn again only when what it shows
 * changes, not at every step of a drag on the page.
 */
const AddPanel = memo(function AddPanel({ board, name, target, tab, onTab }: { board: boolean; name: string; target: { kind: "album"; key: string } | { kind: "tag"; id: string } | { kind: "board"; id: string }; tab: AddTab; onTab: (t: AddTab) => void }) {
  const lib = useScrapbook((x) => x.lib);
  const tabs: [AddTab, ReactNode, string, string][] = [
    ["pictures", <ImageIcon key="p" />, "Pictures", "P"],
    ["stickers", <Smiley key="s" />, "Stickers", "S"],
    ["text", <TextT key="t" />, "Text", "T"],
    ...(board ? [["notes", <NotePencil key="n" />, "Notes", "N"] as [AddTab, ReactNode, string, string]] : []),
  ];
  const shown = !board && tab === "notes" ? "stickers" : tab;
  return (
    <aside className="scrap-add panel">
      <div className="scrap-add-tabs" role="tablist">
        {tabs.map(([id, icon, label, key]) => (
          <button key={id} role="tab" aria-selected={shown === id} className={`scrap-add-tab ${shown === id ? "active" : ""}`} onClick={() => onTab(id)} title={`${label} (${key})`}>
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>
      {shown === "pictures" && (target.kind === "board" ? <BoardPictures /> : <CoverPictures target={target} />)}
      {shown === "stickers" && <StickerShelf onAdd={(src, aspect, custom) => addSticker(src, aspect, custom)} onMake={() => void useScrapbook.getState().openStudio({ target: target.kind === "board" ? { kind: "board", id: target.id, name } : target.kind === "album" ? { kind: "album", key: target.key, name: "" } : { kind: "tag", id: target.id, name: "" } })} stickers={lib?.stickers ?? []} />}
      {shown === "text" && <TextShelf onAdd={addText} />}
      {shown === "notes" && <NoteShelf />}
      <div className="dim small scrap-add-foot">Click to put it on the page, or drag it to where it goes.</div>
    </aside>
  );
});

function TextShelf({ onAdd }: { onAdd: (look: string) => void }) {
  const mine = currentLook();
  const looks = [mine, ...LOOKS.filter((l) => l.id !== mine.id)];
  return (
    <section className="scrap-shelf">
      <div className="dim small">Each theme's lettering: a new text is ready to type into. Any text can take any font, colour and look afterwards.</div>
      <div className="scrap-looks">
        {looks.map((l) => {
          const f = fontById(l.font);
          return (
            <button
              key={l.id}
              className="scrap-look"
              onClick={() => onAdd(l.id)}
              title={`Add text in ${l.name}'s look`}
              style={{
                fontFamily: f.family,
                fontWeight: f.weight,
                fontStyle: f.italic ? "italic" : undefined,
                color: l.fill,
                WebkitTextStroke: l.strokeWidth ? `${Math.max(1, l.strokeWidth * 22)}px ${l.stroke}` : undefined,
                paintOrder: "stroke fill",
                textShadow: l.glitch ? `-1px 0 0 ${l.glitch.left}, 2px 2px 0 ${l.glitch.right}` : l.glow ? `0 0 6px ${l.glow}` : l.shadow ? `2px 2px 0 ${l.shadow.color}` : undefined,
                textTransform: l.upper ? "uppercase" : undefined,
                letterSpacing: l.spacing ? `${l.spacing}em` : undefined,
                background: l.id === "cp2077" || l.id === "midnight" || l.id === "ghost" ? "#14161c" : "#f2efe8",
              }}
            >
              <Plus /> {l.name}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Pictures to put on a cover: the album's pages, what carries the tag, or any in the library. Copied into the scrapbook. */
function CoverPictures({ target }: { target: { kind: "album"; key: string } | { kind: "tag"; id: string } }) {
  const own = useSourcePictures(target);
  const [busy, setBusy] = useState(false);
  const take = async (it: MediaItem, background: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (!background) await placePicture(it);
      else {
        const { blob } = await copyPicture(it, 1400);
        useScrapbook.getState().change((d) => ({ ...d, background: { kind: "photo", blob, blur: 0, color: "#000000" } }));
      }
    } catch (err) {
      useStore.getState().toast(`Could not use ${it.name}: ${String(err)}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`scrap-shelf ${busy ? "busy" : ""}`}>
      <MiniBrowser own={own} ownLabel={target.kind === "album" ? "This album" : "Tagged"} row={110} draggable onPick={(it) => void take(it, false)} action={{ label: <PaintBucket />, title: "Use it as the background", onClick: (it) => void take(it, true) }} />
    </section>
  );
}

/** Pictures for a board: from files (picked, dropped or pasted), or the library's, copied or pointed at as the library is set to. */
function BoardPictures() {
  const mode = useStore((x) => x.boardPictures);
  const input = useRef<HTMLInputElement>(null);
  return (
    <section className="scrap-shelf">
      <div className="row">
        <button className="btn sm" onClick={() => input.current?.click()} title="Pictures from files on this computer">
          <UploadSimple /> Add files…
        </button>
        <input
          ref={input}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(ev) => {
            const files = Array.from(ev.target.files ?? []);
            ev.target.value = "";
            if (files.length) void addFiles(files);
          }}
        />
        <span className="grow" />
        <span className="btn-group">
          <button className={`btn sm ${mode === "copy" ? "active" : "ghost"}`} onClick={() => useStore.getState().setBoardPictures("copy")} title="The library's pictures: the board keeps its own copy, which stays whatever becomes of the picture">
            Copy
          </button>
          <button className={`btn sm ${mode === "link" ? "active" : "ghost"}`} onClick={() => useStore.getState().setBoardPictures("link")} title="The library's pictures: no copy; the board follows a picture when it moves, and shows a gap if it goes">
            Point at
          </button>
        </span>
      </div>
      <div className="dim small">Files can also be dropped on the board, or pasted (⌘V).</div>
      <MiniBrowser own={[]} ownLabel="" row={110} draggable onPick={(it) => void placePicture(it)} />
    </section>
  );
}

/** Notes on squares of paper, and arrows to point from one reference to another. */
function NoteShelf() {
  return (
    <section className="scrap-shelf">
      <div className="label">Notes</div>
      <div className="scrap-swatches">
        {NOTE_PAPERS.map((p) => (
          <button key={p} className="scrap-swatch note" style={{ background: p }} onClick={() => addNote(p)} title="A note on this paper, ready to type into (N)" />
        ))}
      </div>
      <hr className="rule" />
      <div className="label">Arrows</div>
      <div className="row">
        <button className="btn sm" onClick={() => addArrow(ARROW_COLOURS[0], "end")} title="An arrow (A)">
          <ArrowRight /> Arrow
        </button>
        <button className="btn sm" onClick={() => addArrow(ARROW_COLOURS[0], "both")}>
          <ArrowsHorizontal /> Both ways
        </button>
      </div>
      <div className="dim small">Drag an arrow to move it, a corner to make it longer, its knob to point it.</div>
    </section>
  );
}

/* ---------------- the settings of what is selected ---------------- */

const NAMES: Record<Layer["type"], string> = { text: "Text", photo: "Photo", sticker: "Sticker", note: "Note", arrow: "Arrow" };

/** One row above the page: the settings of what is selected, of several selected together, or of the page itself. */
function SettingsBar({ doc }: { doc: ScrapDoc }) {
  const e = useScrapbook(useShallow((x) => ({ selected: x.editing?.selected ?? null, many: x.editing?.many ?? [] })));
  const ids = chosen(e);
  const layer = ids.length === 1 ? doc.layers.find((l) => l.id === ids[0]) : undefined;
  const bar = ids.length === 1 ? doc.bars?.find((b) => b.id === ids[0]) : undefined;
  return <div className="scrap-bar panel">{ids.length > 1 ? <ManyBar ids={ids} /> : layer ? <LayerBar key={layer.id} layer={layer} /> : bar ? <BarBar bar={bar} /> : <PageBar doc={doc} />}</div>;
}

const Sep = () => <span className="scrap-bar-sep" aria-hidden />;

/** Duplicating and deleting what is selected, at the end of the row. */
function Ends({ ids }: { ids: string[] }) {
  return (
    <>
      <button className="btn sm ghost" title="Duplicate (⌘D)" onClick={() => duplicate(ids)}>
        <Copy />
      </button>
      <button className="btn sm ghost danger" title="Delete (⌫)" onClick={() => remove(ids)}>
        <Trash />
      </button>
    </>
  );
}

/** Where in the stack: one step forward or back, or to the front or the back. */
function Order({ ids }: { ids: string[] }) {
  return (
    <span className="btn-group">
      <button className="btn sm ghost" title="Bring forward" onClick={() => restack(ids, "up")}>
        <ArrowUp />
      </button>
      <button className="btn sm ghost" title="Bring to front" onClick={() => restack(ids, "top")}>
        <ArrowLineUp />
      </button>
      <button className="btn sm ghost" title="Send backward" onClick={() => restack(ids, "down")}>
        <ArrowDown />
      </button>
      <button className="btn sm ghost" title="Send to back" onClick={() => restack(ids, "bottom")}>
        <ArrowLineDown />
      </button>
    </span>
  );
}

/** A small panel opened from a button in the row. */
function Pop({ label, title, children, width = 280 }: { label: ReactNode; title?: string; children: ReactNode; width?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      width={width}
      trigger={
        <button className={`btn sm ${open ? "active" : "ghost"}`} onClick={() => setOpen(!open)} title={title}>
          {label} <CaretDown />
        </button>
      }
    >
      <div className="scrap-pop">{children}</div>
    </Popover>
  );
}

function ManyBar({ ids }: { ids: string[] }) {
  return (
    <>
      <span className="label scrap-bar-what">{ids.length} selected</span>
      <span className="small dim scrap-bar-hint">Drag one to move them all; ⇧-click takes one in or out.</span>
      <Order ids={ids} />
      <Sep />
      <Ends ids={ids} />
    </>
  );
}

function LayerBar({ layer }: { layer: Layer }) {
  const { change } = useScrapbook.getState();
  const set = (patch: Partial<Layer>, merge?: string) => change((d) => ({ ...d, layers: d.layers.map((l) => (l.id === layer.id ? ({ ...l, ...patch } as Layer) : l)) }), merge);
  const sticker = shelfSticker(layer);
  return (
    <>
      <span className="label scrap-bar-what">{NAMES[layer.type]}</span>
      {(layer.type === "text" || layer.type === "note") && (
        <button className="btn sm ghost" onClick={() => useScrapbook.getState().type(layer.id)} title="Type in it on the page (or double-click it)">
          <PencilSimple /> Write
        </button>
      )}
      {layer.type === "text" && (
        <>
          <Select compact value={layer.font} options={FONTS.map((f) => ({ value: f.id, label: f.name }))} onChange={(font) => set({ font, box: undefined })} title="Its font (a font chosen here sets its size anew; a look keeps the text's room)" />
          <input type="color" value={layer.color ?? lookById(layer.look).fill} onChange={(ev) => set({ color: ev.target.value }, `color:${layer.id}`)} title="Its colour" />
          {layer.color && (
            <button className="btn sm ghost" onClick={() => set({ color: undefined })} title="The look's own colour">
              Reset
            </button>
          )}
          <span className="btn-group">
            {(["left", "center", "right"] as const).map((a) => (
              <button key={a} className={`btn sm ${layer.align === a ? "active" : "ghost"}`} onClick={() => set({ align: a })} title={`Lines ${a === "center" ? "centred" : `to the ${a}`}`}>
                {a === "left" ? "L" : a === "center" ? "C" : "R"}
              </button>
            ))}
          </span>
        </>
      )}
      {layer.type === "photo" && (
        <span className="btn-group" title="Its frame">
          {(["none", "polaroid"] as const).map((f) => (
            <button key={f} className={`btn sm ${(layer.frame === "tape" ? "none" : layer.frame) === f ? "active" : "ghost"}`} onClick={() => set({ frame: f })}>
              {f === "none" ? "No frame" : "Polaroid"}
            </button>
          ))}
        </span>
      )}
      {layer.type === "note" && (
        <Pop label={<span className="scrap-dots"><span style={{ background: layer.paper }} /></span>} title="Its paper" width={220}>
          <div className="scrap-swatches">
            {NOTE_PAPERS.map((p) => (
              <button key={p} className={`scrap-swatch note ${layer.paper === p ? "active" : ""}`} style={{ background: p }} onClick={() => set({ paper: p })} title="This paper" />
            ))}
          </div>
        </Pop>
      )}
      {(layer.type === "photo" || layer.type === "note") && (
        <>
          <Sep />
          <FixControls fix={layer.fix ?? null} onChange={(fix) => set({ fix })} />
        </>
      )}
      {layer.type === "sticker" && (
        <>
          <label className="check small">
            <input type="checkbox" checked={layer.outline} onChange={(ev) => set({ outline: ev.target.checked })} /> Cut edge
          </label>
          <button className={`btn sm ${layer.flip ? "active" : "ghost"}`} onClick={() => set({ flip: !layer.flip })} title="Mirror">
            <ArrowsLeftRight /> Mirror
          </button>
          {sticker && (
            <button className="btn sm ghost" onClick={() => void useScrapbook.getState().openStudio({ sticker })} title="Fine-tune the sticker: every cover with it on takes the new one">
              <PaintBrush /> Fine-tune
            </button>
          )}
        </>
      )}
      {layer.type === "arrow" && (
        <>
          <Pop label={<span className="scrap-dots"><span style={{ background: layer.color }} /></span>} title="Its colour" width={240}>
            <div className="scrap-swatches">
              {ARROW_COLOURS.map((c) => (
                <button key={c} className={`scrap-swatch ${layer.color === c ? "active" : ""}`} style={{ background: c }} onClick={() => set({ color: c })} title="This colour" />
              ))}
              <input type="color" value={layer.color} onChange={(ev) => set({ color: ev.target.value }, `arrow-color:${layer.id}`)} title="Any colour" />
            </div>
          </Pop>
          <label className="scrap-bar-range small dim" title="Its thickness">
            Thick
            <input type="range" min={0.002} max={0.03} step={0.001} value={layer.thickness} onChange={(ev) => set({ thickness: Number(ev.target.value) }, `arrow-thick:${layer.id}`)} />
          </label>
          <span className="btn-group">
            <button className={`btn sm ${layer.heads === "end" ? "active" : "ghost"}`} onClick={() => set({ heads: "end" })} title="A head at its end">
              <ArrowRight />
            </button>
            <button className={`btn sm ${layer.heads === "both" ? "active" : "ghost"}`} onClick={() => set({ heads: "both" })} title="A head at both ends">
              <ArrowsHorizontal />
            </button>
          </span>
        </>
      )}
      <span className="grow" />
      <Pop label="More" title="Its look, its turn and where it is in the stack">
        {(layer.type === "text" || layer.type === "photo" || layer.type === "sticker") && (
          <div className="scrap-field">
            <span className="small dim">Look</span>
            <Select
              compact
              value={layer.look ?? ""}
              options={[...(layer.type === "sticker" ? [{ value: ORIGINAL, label: "Original colours" }] : layer.type === "photo" ? [{ value: "", label: "Classic frame" }] : []), ...LOOKS.map((l) => ({ value: l.id, label: l.name }))]}
              onChange={(look) =>
                set(
                  layer.type === "text"
                    ? // The text keeps its room: its size fitted to the font and look it was made in.
                      { look, font: layer.look === look ? layer.font : lookById(look).font, color: undefined, box: layer.box ?? { font: layer.font, look: layer.look } }
                    : layer.type === "photo"
                      ? { look: look || undefined }
                      : { look },
                )
              }
              title={layer.type === "photo" ? "The frame in a theme's style" : "A theme's style; built-in stickers turn into its line art, text keeps its room"}
            />
          </div>
        )}
        {layer.type === "text" ? (
          <div className="scrap-field">
            <span className="small dim">Size</span>
            <input type="range" min={0.02} max={0.3} step={0.005} value={layer.size} onChange={(ev) => set({ size: Number(ev.target.value) }, `size:${layer.id}`)} />
          </div>
        ) : (
          <div className="scrap-field">
            <span className="small dim">{layer.type === "arrow" ? "Length" : "Size"}</span>
            <input type="range" min={0.03} max={1.4} step={0.01} value={layer.w} onChange={(ev) => set({ w: Number(ev.target.value) }, `w:${layer.id}`)} />
          </div>
        )}
        <div className="scrap-field">
          <span className="small dim">Turn</span>
          <input type="range" min={-180} max={180} step={1} value={layer.rot} onChange={(ev) => set({ rot: Number(ev.target.value) }, `rot:${layer.id}`)} />
          <button className="btn sm ghost" title="Straight" onClick={() => set({ rot: 0 })}>
            <ArrowsClockwise />
          </button>
        </div>
        <div className="scrap-field">
          <span className="small dim">Stack</span>
          <Order ids={[layer.id]} />
        </div>
      </Pop>
      <Sep />
      <Ends ids={[layer.id]} />
    </>
  );
}

/** What holds a photo or a note up: nothing, pins or tape; where (one place, the top corners, all corners); and in what colour. */
function FixControls({ fix, onChange }: { fix: Fix | null; onChange: (fix: Fix | null) => void }) {
  return (
    <>
      <span className="btn-group" title="What holds it up">
        {([null, "pin", "tape"] as const).map((kind) => (
          <button key={kind ?? "none"} className={`btn sm ${(fix?.kind ?? null) === kind ? "active" : "ghost"}`} onClick={() => onChange(kind ? { kind, where: fix?.where ?? (kind === "pin" ? "one" : "top"), ...(fix?.color && fix.kind === kind ? { color: fix.color } : {}) } : null)}>
            {kind === null ? "Loose" : kind === "pin" ? "Pins" : "Tape"}
          </button>
        ))}
      </span>
      {fix && (
        <>
          <Select compact value={fix.where} options={FIX_PLACES.map((p) => ({ value: p.id, label: p.id === "one" ? (fix.kind === "pin" ? "One, at the top" : "One, across the top") : p.name }))} onChange={(where) => onChange({ ...fix, where: where as Fix["where"] })} title="Where" />
          <FixColour fix={fix} onChange={onChange} />
        </>
      )}
    </>
  );
}

/** The colour pins or tape come in: one chosen, or a colour of their own each. */
function FixColour({ fix, onChange }: { fix: Fix; onChange: (fix: Fix) => void }) {
  const palette = fix.kind === "pin" ? PIN_COLOURS : TAPE_COLOURS;
  const random = !fix.color || fix.color === "random";
  const shown = random ? palette : [fix.color!];
  return (
    <Pop label={<span className="scrap-dots">{shown.slice(0, 3).map((c) => <span key={c} style={{ background: c }} />)}</span>} title={`The ${fix.kind === "pin" ? "pins'" : "tape's"} colour`} width={240}>
      <button className={`chip ${random ? "active" : ""}`} onClick={() => onChange({ ...fix, color: "random" })} title="A colour of its own for each">
        Random
      </button>
      <div className="scrap-swatches">
        {palette.map((c) => (
          <button key={c} className={`scrap-swatch ${fix.color === c ? "active" : ""}`} style={{ background: c }} onClick={() => onChange({ ...fix, color: c })} title="This colour" />
        ))}
        <input type="color" value={random ? palette[0] : fix.color!} onChange={(ev) => onChange({ ...fix, color: ev.target.value })} title="Any colour" />
      </div>
    </Pop>
  );
}

function BarBar({ bar }: { bar: Bar }) {
  const { change } = useScrapbook.getState();
  const set = (patch: Partial<Bar>, merge?: string) => change((d) => ({ ...d, bars: d.bars?.map((b) => (b.id === bar.id ? { ...b, ...patch } : b)) }), merge);
  return (
    <>
      <span className="label scrap-bar-what">Bar</span>
      <span className="btn-group">
        {BAR_STYLES.map((s) => (
          <button key={s.id} className={`btn sm ${bar.style === s.id ? "active" : "ghost"}`} onClick={() => set({ style: s.id })}>
            {s.name}
          </button>
        ))}
      </span>
      <Sep />
      <input type="color" value={bar.color} onChange={(ev) => set({ color: ev.target.value }, `bar-color:${bar.id}`)} title="The bar's colour" />
      <input type="color" value={bar.fill} onChange={(ev) => set({ fill: ev.target.value }, `bar-fill:${bar.id}`)} title="The background on its right, up to the next bar" />
      <label className="scrap-bar-range small dim" title="Its thickness">
        Thick
        <input type="range" min={0.005} max={0.15} step={0.0025} value={bar.width} onChange={(ev) => set({ width: Number(ev.target.value) }, `bar-width:${bar.id}`)} />
      </label>
      <label className="scrap-bar-range small dim" title="Its tilt (or drag its knob)">
        Tilt
        <input type="range" min={-70} max={70} step={1} value={bar.angle} onChange={(ev) => set({ angle: Number(ev.target.value) }, `bar-angle:${bar.id}`)} />
      </label>
      <button className="btn sm ghost" title="Upright" onClick={() => set({ angle: 0 })} disabled={bar.angle === 0}>
        <ArrowsClockwise />
      </button>
      <span className="grow" />
      <Ends ids={[bar.id]} />
    </>
  );
}

const PATTERNS: { id: PatternId; name: string }[] = [
  { id: "dots", name: "Dots" },
  { id: "grid", name: "Grid" },
  { id: "stripes", name: "Stripes" },
  { id: "lined", name: "Lined" },
  { id: "checks", name: "Gingham" },
  { id: "tone", name: "Screentone" },
  { id: "cork", name: "Cork" },
  { id: "plain", name: "Plain" },
];

/** The page itself, when nothing is selected: its background and bars, and a board's name, size and window. */
function PageBar({ doc }: { doc: ScrapDoc }) {
  const { change } = useScrapbook.getState();
  const board = doc.kind === "board";
  const bg = doc.background;
  const bars = doc.bars ?? [];
  const setBg = (background: Background, merge?: string) => change((d) => ({ ...d, background }), merge);
  return (
    <>
      <span className="label scrap-bar-what">{board ? "Board" : "Page"}</span>
      {board && <input className="input scrap-bar-name" value={doc.name ?? ""} onChange={(ev) => change((d) => ({ ...d, name: ev.target.value }), "board-name")} placeholder="Board" title="Its name" />}
      <Pop label={<><PaintBucket /> Background</>} title="Its background: ready-made, a pattern and its colours" width={340}>
        <div className="scrap-grid backgrounds">
          {BACKGROUNDS.map((b) => (
            <button key={b.name} className="scrap-tile bg" onClick={() => setBg(b.bg)} title={b.name}>
              <BackgroundSwatch bg={b.bg} />
              <span className="small ellipsis">{b.name}</span>
            </button>
          ))}
        </div>
        {bg.kind === "pattern" ? (
          <>
            <div className="chips">
              {PATTERNS.map((p) => (
                <button key={p.id} className={`chip ${bg.pattern === p.id ? "active" : ""}`} onClick={() => setBg({ ...bg, pattern: p.id })}>
                  {p.name}
                </button>
              ))}
            </div>
            <div className="scrap-field">
              <span className="small dim">{bars.length ? "Left part" : "Paper"}</span>
              <input type="color" value={bg.color} onChange={(ev) => setBg({ ...bg, color: ev.target.value }, "bg-color")} />
              <span className="small dim">Pattern</span>
              <input type="color" value={bg.ink} onChange={(ev) => setBg({ ...bg, ink: ev.target.value }, "bg-ink")} />
            </div>
          </>
        ) : (
          <div className="scrap-field">
            <span className="small dim">Blur</span>
            <input type="range" min={0} max={1} step={0.02} value={bg.blur} onChange={(ev) => setBg({ ...bg, blur: Number(ev.target.value) }, "bg-blur")} />
          </div>
        )}
        {!board && <div className="dim small">A photo as the background: the paint bucket on one under Pictures.</div>}
      </Pop>
      <button
        className="btn sm ghost"
        title="A bar from top to bottom, splitting the background in two colours"
        onClick={() => {
          const bar = newBar(doc);
          change((d) => ({ ...d, bars: [...(d.bars ?? []), bar] }));
          useScrapbook.getState().select(bar.id);
        }}
      >
        <Plus /> Add a bar
      </button>
      {board && (
        <>
          <Sep />
          <BoardSize doc={doc} />
          <button className="btn sm ghost" onClick={() => void openBoardWindow(doc)} title="The board in a window of its own, which can stay above your other apps while you draw, and follows it as you change it here">
            <AppWindow /> Own window
          </button>
        </>
      )}
      <span className="small dim scrap-bar-hint end">{bars.length ? "Click a bar on the page to change it." : "Click something on the page to change it; drag across it to select several."}</span>
    </>
  );
}

/** A board's size (what is on it keeps its place): one of the usual, or its own width and height. */
function BoardSize({ doc }: { doc: ScrapDoc }) {
  const { change } = useScrapbook.getState();
  const { w, h } = pageOf(doc);
  const [custom, setCustom] = useState({ w: String(w), h: String(h) });
  useEffect(() => setCustom({ w: String(w), h: String(h) }), [w, h]);
  const apply = (nw: number, nh: number) => change((d) => resized(d, nw, nh));
  return (
    <Pop label={<><FrameCorners /> {w} × {h}</>} title="Its size" width={300}>
      <div className="scrap-sizes">
        {BOARD_SIZES.map((p) => (
          <button key={p.name} className={`tags-row ${p.w === w && p.h === h ? "active" : ""}`} onClick={() => apply(p.w, p.h)}>
            <span className="grow">{p.name}</span>
            <span className="dim small mono">
              {p.w} × {p.h}
            </span>
          </button>
        ))}
      </div>
      <div className="scrap-field">
        <input className="input" type="number" min={BOARD_MIN} max={BOARD_MAX} value={custom.w} onChange={(ev) => setCustom({ ...custom, w: ev.target.value })} title="Width, in pixels" />
        <span className="dim">×</span>
        <input className="input" type="number" min={BOARD_MIN} max={BOARD_MAX} value={custom.h} onChange={(ev) => setCustom({ ...custom, h: ev.target.value })} title="Height, in pixels" />
        <button className="btn sm" disabled={!Number(custom.w) || !Number(custom.h) || (Number(custom.w) === w && Number(custom.h) === h)} onClick={() => apply(Number(custom.w), Number(custom.h))}>
          Set
        </button>
      </div>
      <div className="dim small">
        {BOARD_MIN} to {BOARD_MAX} pixels a side. A new size keeps everything where it is; what would fall off comes back to the edge.
      </div>
    </Pop>
  );
}

function BackgroundSwatch({ bg }: { bg: Background }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    drawBackdrop(c.getContext("2d")!, { background: bg }, c.width, c.height, assets);
  }, [bg]);
  return <canvas ref={ref} width={120} height={80} />;
}

/* ---------------- the page ---------------- */

type Drag =
  | { mode: "move" | "scale" | "turn"; id: string; key: string; x0: number; y0: number; start: Layer; cx: number; cy: number }
  | { mode: "bar" | "bar-turn"; id: string; key: string; x0: number; y0: number; start: Bar; cx: number; cy: number }
  | { mode: "many"; key: string; x0: number; y0: number; starts: Map<string, { x: number; y: number }> };

/** A selection box being drawn across the empty page, from where it began to where the pointer is (page pixels). */
type Sweep = { x0: number; y0: number; x1: number; y1: number; add: boolean; had: string[] };

/** A canvas W × H on the page, ready to draw on in page pixels; its pixels are set anew only when its size changes (that clears it and costs a new store). */
function canvasAt(c: HTMLCanvasElement | null, W: number, H: number, dpr: number): CanvasRenderingContext2D | null {
  const ctx = c?.getContext("2d");
  if (!c || !ctx) return null;
  const w = Math.round(W * dpr);
  const h = Math.round(H * dpr);
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** The page with what is being typed into left out: a text altogether, a note's words (its typing box shows them instead). */
function withoutTyped(doc: ScrapDoc, typing: string | null): ScrapDoc {
  if (!typing) return doc;
  return { ...doc, layers: doc.layers.flatMap((l): Layer[] => (l.id !== typing ? [l] : l.type === "text" ? [] : l.type === "note" ? [{ ...l, text: "" }] : [l])) };
}

function Page({ doc, selected, many, typing }: { doc: ScrapDoc; selected: string | null; many: string[]; typing: string | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  // Two canvases: the backdrop (background and bars), drawn again only when it changes, and what is on it, drawn at every step of a drag.
  const back = useRef<HTMLCanvasElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 600, h: 600 });
  const [tick, setTick] = useState(0);
  const drag = useRef<Drag | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const { change, select } = useScrapbook.getState();

  // The page as large as fits, in its shape.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth - 48, h: el.clientHeight - 48 });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w: pw, h: ph } = pageOf(doc);
  // As large as fits, times the zoom (1: the whole page in view); a larger page scrolls in the stage.
  const [zoom, setZoom] = useState(1);
  const fit = Math.max(0.1, Math.min(box.w / pw, box.h / ph));
  const scale = fit * zoom;
  const W = Math.round(pw * scale);
  const H = Math.round(ph * scale);
  // Where a zoom was asked for: that spot of the page stays under the pointer (or the middle of the view).
  const anchor = useRef<{ fx: number; fy: number; cx: number; cy: number } | null>(null);
  const zoomTo = (next: number, at?: { clientX: number; clientY: number }) => {
    const c = canvas.current;
    const stage = wrap.current;
    if (!c || !stage) return;
    const r = c.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const cx = at?.clientX ?? s.left + s.width / 2;
    const cy = at?.clientY ?? s.top + s.height / 2;
    anchor.current = { fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height, cx, cy };
    // The canvases keep the size they were drawn at until the zoom stops (see `held`).
    setHeld((h) => h ?? { W, H });
    clearTimeout(settle.current);
    settle.current = window.setTimeout(() => setHeld(null), 160);
    setZoom(Math.min(12, Math.max(1, next)));
  };
  // While a zoom goes on, the canvases keep what they drew, stretched to each new size by the screen
  // (at no cost); drawn sharp at the size reached once it stops. Drawing a page at every step of a
  // ⌘-scroll is what made zooming lag.
  const [held, setHeld] = useState<{ W: number; H: number } | null>(null);
  const settle = useRef(0);
  useEffect(() => () => clearTimeout(settle.current), []);
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useLayoutEffect(() => {
    const a = anchor.current;
    const c = canvas.current;
    const stage = wrap.current;
    if (!a || !c || !stage) return;
    anchor.current = null;
    const r = c.getBoundingClientRect();
    stage.scrollLeft += r.left + a.fx * r.width - a.cx;
    stage.scrollTop += r.top + a.fy * r.height - a.cy;
  }, [W, H]);
  // ⌘-scroll or a pinch zooms (the stage scrolls otherwise); ⌘+, ⌘− and ⌘0 too.
  useEffect(() => {
    const stage = wrap.current;
    if (!stage) return;
    // A trackpad sends several steps a frame: taken together, once a frame.
    const wheel = { k: 1, at: { clientX: 0, clientY: 0 }, frame: 0 };
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      wheel.k *= Math.exp(-ev.deltaY * 0.004);
      wheel.at = { clientX: ev.clientX, clientY: ev.clientY };
      if (wheel.frame) return;
      wheel.frame = requestAnimationFrame(() => {
        const k = wheel.k;
        wheel.k = 1;
        wheel.frame = 0;
        zoomToRef.current(zoomRef.current * k, wheel.at);
      });
    };
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || isTypingTarget(ev.target)) return;
      if (ev.key === "=" || ev.key === "+") zoomToRef.current(zoomRef.current * 1.25);
      else if (ev.key === "-") zoomToRef.current(zoomRef.current / 1.25);
      else if (ev.key === "0") setZoom(1);
      else return;
      ev.preventDefault();
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(wheel.frame);
      stage.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // Redrawn when anything changes, a picture arrives, or a font has loaded.
  useEffect(() => assets.onLoad(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    void fontsReady(doc).then(() => setTick((t) => t + 1));
  }, [doc]);
  // The size the canvases are drawn at: the page's, or while a zoom goes on, the one before it.
  const DW = held?.W ?? W;
  const DH = held?.H ?? H;
  // Sharp on this screen, but never a canvas too large to keep (a big board zoomed far in).
  const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(24_000_000 / Math.max(1, DW * DH)));
  const background = doc.background;
  const bars = doc.bars;
  useEffect(() => {
    const ctx = canvasAt(back.current, DW, DH, dpr);
    if (ctx) drawBackdrop(ctx, { background, bars }, DW, DH, assets);
  }, [background, bars, DW, DH, dpr, tick]);
  useEffect(() => {
    const ctx = canvasAt(canvas.current, DW, DH, dpr);
    if (ctx) drawLayers(ctx, withoutTyped(doc, typing), DW, DH, assets);
  }, [doc, DW, DH, dpr, tick, typing]);

  const ctx = () => canvas.current?.getContext("2d") ?? null;
  const point = (ev: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const capture = (ev: ReactPointerEvent) => {
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  };
  const begin = (ev: ReactPointerEvent, mode: "move" | "scale" | "turn", layer: Layer) => {
    capture(ev);
    const p = point(ev);
    drag.current = { mode, id: layer.id, key: `${mode}:${layer.id}:${Date.now()}`, x0: p.x, y0: p.y, start: layer, cx: layer.x * W, cy: layer.y * H };
  };
  const beginBar = (ev: ReactPointerEvent, mode: "bar" | "bar-turn", bar: Bar) => {
    capture(ev);
    const p = point(ev);
    drag.current = { mode, id: bar.id, key: `${mode}:${bar.id}:${Date.now()}`, x0: p.x, y0: p.y, start: bar, cx: bar.x * W, cy: H / 2 };
  };
  // What is under the pointer: a layer, else a bar (they lie behind every layer).
  const hitAt = (ev: { clientX: number; clientY: number }) => {
    const c = ctx();
    if (!c) return null;
    const p = point(ev);
    const layer = layerAt(c, doc, W, H, p.x, p.y);
    if (layer) return { layer, bar: null };
    const bar = p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H ? barAt(doc, W, H, p.x, p.y) : null;
    return bar ? { layer: null, bar } : null;
  };
  const together = many.length > 1 ? many : [];
  const onDown = (ev: ReactPointerEvent) => {
    if (ev.button === 2) return;
    // The stage's scroll bars, when zoomed in, are for scrolling.
    const stage = wrap.current;
    if (stage?.clientWidth && ev.target === stage) {
      const r = stage.getBoundingClientRect();
      if (ev.clientX - r.left >= stage.clientWidth || ev.clientY - r.top >= stage.clientHeight) return;
    }
    const hit = hitAt(ev);
    const id = hit?.layer?.id ?? hit?.bar?.id;
    // ⇧-click takes a layer into the selection or out of it.
    if (ev.shiftKey && hit?.layer) return select(hit.layer.id, true);
    if (hit?.layer && together.includes(hit.layer.id)) {
      // One of several selected: they all move with it.
      capture(ev);
      const p = point(ev);
      drag.current = { mode: "many", key: `many:${Date.now()}`, x0: p.x, y0: p.y, starts: new Map(doc.layers.filter((l) => together.includes(l.id)).map((l) => [l.id, { x: l.x, y: l.y }])) };
      return;
    }
    if (id) {
      select(id);
      if (hit?.layer) begin(ev, "move", hit.layer);
      else if (hit?.bar) beginBar(ev, "bar", hit.bar);
      return;
    }
    // The empty page, or around it: a selection box from here (⇧ adds to what is selected); a plain click selects the page.
    capture(ev);
    const p = point(ev);
    if (!ev.shiftKey) select(null);
    setSweep({ x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: ev.shiftKey, had: ev.shiftKey ? chosen({ selected, many }) : [] });
  };
  // A pointer can move several times between two frames: only where it got to is drawn, once a frame.
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);
  const onMove = (ev: ReactPointerEvent) => {
    if (sweep) {
      const p = point(ev);
      setSweep({ ...sweep, x1: p.x, y1: p.y });
      return;
    }
    if (!drag.current) return;
    pending.current = point(ev);
    if (!frame.current) frame.current = requestAnimationFrame(() => step.current());
  };
  const step = useRef(() => {});
  step.current = () => {
    frame.current = 0;
    const p = pending.current;
    const d = drag.current;
    pending.current = null;
    if (!p || !d) return;
    if (d.mode === "many") {
      const dx = (p.x - d.x0) / W;
      const dy = (p.y - d.y0) / H;
      change((doc) => ({ ...doc, layers: doc.layers.map((l) => (d.starts.has(l.id) ? { ...l, x: d.starts.get(l.id)!.x + dx, y: d.starts.get(l.id)!.y + dy } : l)) }), d.key);
      return;
    }
    if (d.mode === "bar" || d.mode === "bar-turn") {
      const b = d.start;
      let next: Partial<Bar>;
      if (d.mode === "bar") next = { x: Math.max(-0.1, Math.min(1.1, b.x + (p.x - d.x0) / W)) };
      else {
        // Its knob points along it; a line has no ends, so below the middle counts the same as above.
        let angle = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        if (Math.abs(angle) < 3) angle = 0;
        next = { angle: Math.round(Math.max(-70, Math.min(70, angle))) };
      }
      change((doc) => ({ ...doc, bars: doc.bars?.map((x) => (x.id === d.id ? { ...x, ...next } : x)) }), d.key);
      return;
    }
    const s = d.start as Layer;
    change((doc) => {
      const layers = doc.layers.map((l) => {
        if (l.id !== d.id) return l;
        if (d.mode === "move") return { ...l, x: s.x + (p.x - d.x0) / W, y: s.y + (p.y - d.y0) / H };
        if (d.mode === "turn") {
          let rot = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90;
          // Straight, or a right angle, when close.
          for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(rot - snap) < 4) rot = snap;
          return { ...l, rot: Math.round(rot) };
        }
        const k = Math.hypot(p.x - d.cx, p.y - d.cy) / Math.max(1, Math.hypot(d.x0 - d.cx, d.y0 - d.cy));
        return l.type === "text" ? { ...l, size: Math.min(0.6, Math.max(0.015, (s as TextLayer).size * k)) } : { ...l, w: Math.min(2, Math.max(0.03, s.w * k)) };
      });
      return { ...doc, layers };
    }, d.key);
  };
  const onUp = () => {
    // Where the pointer got to, taken before the drag ends.
    if (frame.current) cancelAnimationFrame(frame.current);
    step.current();
    drag.current = null;
    if (!sweep) return;
    setSweep(null);
    const c = ctx();
    if (!c || (Math.abs(sweep.x1 - sweep.x0) < 4 && Math.abs(sweep.y1 - sweep.y0) < 4)) return;
    // Every layer whose box (turned as it is) the selection box touches.
    const [left, right] = [Math.min(sweep.x0, sweep.x1), Math.max(sweep.x0, sweep.x1)];
    const [top, bottom] = [Math.min(sweep.y0, sweep.y1), Math.max(sweep.y0, sweep.y1)];
    const hits = doc.layers
      .filter((l) => {
        const { w, h } = layerSize(c, l, W, H);
        const a = (l.rot * Math.PI) / 180;
        const hw = (Math.abs(Math.cos(a)) * w + Math.abs(Math.sin(a)) * h) / 2;
        const hh = (Math.abs(Math.sin(a)) * w + Math.abs(Math.cos(a)) * h) / 2;
        return l.x * W + hw >= left && l.x * W - hw <= right && l.y * H + hh >= top && l.y * H - hh <= bottom;
      })
      .map((l) => l.id);
    const ids = [...new Set([...sweep.had, ...hits])];
    if (ids.length > 1) useScrapbook.getState().selectMany(ids);
    else select(ids[0] ?? null);
  };
  const onDouble = (ev: React.MouseEvent) => {
    const hit = hitAt(ev);
    if (hit?.layer && (hit.layer.type === "text" || hit.layer.type === "note")) useScrapbook.getState().type(hit.layer.id);
  };

  // What was dropped on the page, where: files (on a board), a sticker off the shelf, a picture of the library.
  const onDrop = (ev: React.DragEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const at = { x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) };
    const sticker = ev.dataTransfer.getData(STICKER_DRAG);
    if (sticker) {
      ev.preventDefault();
      const s = JSON.parse(sticker) as DraggedSticker;
      return addSticker(s.src, s.aspect, s.custom, at);
    }
    const key = ev.dataTransfer.getData(PICTURE_DRAG);
    if (key) {
      ev.preventDefault();
      const it = useStore.getState().allItems.find((i) => i.key === key);
      return void (it && placePicture(it, at));
    }
    const files = Array.from(ev.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length && doc.kind === "board") {
      ev.preventDefault();
      void addFiles(files, at);
    }
  };
  const takes = (types: readonly string[]) => types.includes(STICKER_DRAG) || types.includes(PICTURE_DRAG) || (doc.kind === "board" && types.includes("Files"));

  const sel = !together.length ? doc.layers.find((l) => l.id === selected) : undefined;
  const selBar = !together.length ? doc.bars?.find((b) => b.id === selected) : undefined;
  const c = ctx();
  const size = sel && c ? layerSize(c, sel, W, H) : null;
  const typed = typing ? doc.layers.find((l) => l.id === typing) : undefined;
  const menuItems = (ids: string[]): MenuItem[] => {
    const one = ids.length === 1 ? doc.layers.findIndex((l) => l.id === ids[0]) : -2;
    const last = doc.layers.length - 1;
    const layering: MenuItem[] = !ids.some((id) => doc.layers.some((l) => l.id === id))
      ? []
      : [
          { label: <><ArrowUp /> Bring forward</>, onClick: () => restack(ids, "up"), disabled: one === last },
          { label: <><ArrowLineUp /> Bring to front</>, onClick: () => restack(ids, "top"), disabled: one === last },
          { label: <><ArrowDown /> Send backward</>, onClick: () => restack(ids, "down"), disabled: one === 0 },
          { label: <><ArrowLineDown /> Send to back</>, onClick: () => restack(ids, "bottom"), disabled: one === 0 },
          { separator: true },
        ];
    const sticker = ids.length === 1 ? shelfSticker(doc.layers[one]) : undefined;
    return [
      ...layering,
      ...(sticker ? [{ label: <><PaintBrush /> Fine-tune the sticker</>, onClick: () => void useScrapbook.getState().openStudio({ sticker }) }] : []),
      { label: <><Copy /> Duplicate</>, onClick: () => duplicate(ids) },
      { label: <><Trash /> Delete</>, onClick: () => remove(ids), danger: true },
    ];
  };
  return (
    <div className="scrap-stage-wrap">
      {/* The whole stage takes the pointer: a selection box can start beside the page, and a click there selects nothing. */}
      <main
        className="scrap-stage"
        ref={wrap}
        onDragOver={(ev) => takes(ev.dataTransfer.types) && ev.preventDefault()}
        onDrop={onDrop}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDoubleClick={onDouble}
        onContextMenu={(ev) => {
          ev.preventDefault();
          const hit = hitAt(ev);
          const id = hit?.layer?.id ?? hit?.bar?.id;
          if (!id) return setMenu(null);
          // On one of several selected: for all of them.
          const ids = together.includes(id) ? together : [id];
          if (ids.length === 1) select(id);
          setMenu({ x: ev.clientX, y: ev.clientY, ids });
        }}
      >
        <div className="scrap-page" style={{ width: W, height: H }}>
          <canvas ref={back} style={{ width: W, height: H }} />
          <canvas ref={canvas} className="scrap-layers" style={{ width: W, height: H }} />
          {selBar && (
            <div
              className="scrap-sel bar"
              style={{ left: selBar.x * W, top: H / 2, width: barSpan(selBar, Math.min(W, H)) + 10, height: H / Math.cos((selBar.angle * Math.PI) / 180), transform: `translate(-50%, -50%) rotate(${selBar.angle}deg)` }}
            >
              <span className="scrap-handle turn" title="Tilt" onPointerDown={(ev) => beginBar(ev, "bar-turn", selBar)} />
            </div>
          )}
          {sel && size && !typed && (
            <div className="scrap-sel" style={{ left: sel.x * W, top: sel.y * H, width: size.w, height: size.h, transform: `translate(-50%, -50%) rotate(${sel.rot}deg)` }}>
              <span className="scrap-handle turn" title="Turn" onPointerDown={(ev) => begin(ev, "turn", sel)} />
              {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                <span key={corner} className={`scrap-handle ${corner}`} title="Resize" onPointerDown={(ev) => begin(ev, "scale", sel)} />
              ))}
            </div>
          )}
          {c &&
            doc.layers
              .filter((l) => together.includes(l.id))
              .map((l) => {
                const s = layerSize(c, l, W, H);
                return <div key={l.id} className="scrap-sel many" style={{ left: l.x * W, top: l.y * H, width: s.w, height: s.h, transform: `translate(-50%, -50%) rotate(${l.rot}deg)` }} />;
              })}
          {sweep && <div className="scrap-sweep" style={{ left: Math.min(sweep.x0, sweep.x1), top: Math.min(sweep.y0, sweep.y1), width: Math.abs(sweep.x1 - sweep.x0), height: Math.abs(sweep.y1 - sweep.y0) }} />}
          {typed && c && (typed.type === "text" || typed.type === "note") && <TypingBox key={typed.id} layer={typed} ctx={c} W={W} H={H} />}
        </div>
      </main>
      <ContextMenu at={menu} items={menu ? menuItems(menu.ids) : []} onClose={() => setMenu(null)} />
      <div className="scrap-zoom panel">
        <button className="btn sm ghost" onClick={() => zoomTo(zoom / 1.25)} disabled={zoom <= 1} title="Zoom out (⌘−)">
          <MagnifyingGlassMinus />
        </button>
        <span className="small mono" title="The page's own pixels, at this zoom">
          {Math.round(scale * 100)}%
        </span>
        <button className="btn sm ghost" onClick={() => zoomTo(zoom * 1.25)} disabled={zoom >= 12} title="Zoom in (⌘+, or ⌘-scroll where the pointer is)">
          <MagnifyingGlassPlus />
        </button>
        <button className="btn sm ghost" onClick={() => setZoom(1)} disabled={zoom === 1} title="The whole page (⌘0)">
          <ArrowsIn />
        </button>
      </div>
    </div>
  );
}

/**
 * Typing into a text or a note where it is on the page: a box over it in its font, size, colour and
 * turn, the page's own drawing of the words left out meanwhile. Esc or a click elsewhere ends it.
 */
function TypingBox({ layer, ctx, W, H }: { layer: TextLayer | NoteLayer; ctx: CanvasRenderingContext2D; W: number; H: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { change } = useScrapbook.getState();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  // A text left with nothing in it goes: there would be nothing to see or click.
  const done = () => {
    const st = useScrapbook.getState();
    const now = st.editing?.doc.layers.find((l) => l.id === layer.id);
    st.type(null);
    if (now?.type === "text" && !now.text.trim()) {
      st.change((d) => ({ ...d, layers: d.layers.filter((l) => l.id !== layer.id) }), `text:${layer.id}`);
      st.select(null);
    }
  };
  const common = {
    ref,
    className: "scrap-typing",
    value: layer.text,
    spellCheck: false,
    onChange: (ev: React.ChangeEvent<HTMLTextAreaElement>) => change((d) => ({ ...d, layers: d.layers.map((l) => (l.id === layer.id ? ({ ...l, text: ev.target.value } as Layer) : l)) }), `text:${layer.id}`),
    onBlur: done,
    onKeyDown: (ev: React.KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        done();
      }
    },
    onPointerDown: (ev: React.PointerEvent) => ev.stopPropagation(),
  };
  if (layer.type === "note") {
    const m = noteMetrics(ctx, layer, W);
    return (
      <textarea
        {...common}
        style={{ left: layer.x * W, top: layer.y * H, width: m.box.w, height: m.box.h, padding: m.pad, font: fontCss(NOTE_FONT, m.px), lineHeight: 1.2, color: "#2b2622", whiteSpace: "pre-wrap", transform: `translate(-50%, -50%) rotate(${layer.rot}deg)` }}
      />
    );
  }
  const look = lookById(layer.look);
  const m = textMetrics(ctx, layer, H);
  return (
    <textarea
      {...common}
      wrap="off"
      style={{
        left: layer.x * W,
        top: layer.y * H,
        width: Math.max(m.w, m.px * 3) + m.px,
        height: Math.max(m.h, m.px * 1.3),
        font: fontCss(layer.font, m.px),
        lineHeight: 1.15,
        color: layer.color ?? look.fill,
        textAlign: layer.align,
        textTransform: look.upper ? "uppercase" : undefined,
        letterSpacing: look.spacing ? `${look.spacing}em` : undefined,
        whiteSpace: "pre",
        transform: `translate(-50%, -50%) rotate(${layer.rot}deg)`,
      }}
    />
  );
}
