import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, ArrowsOutLineVertical, CornersOut, Plus, Shuffle, Smiley, Trash, X } from "@phosphor-icons/react";
import { HomeStickers, newSticker } from "../home/stickers";
import { StickerShelf, STICKER_DRAG, type DraggedSticker } from "../components/StickerShelf";
import { useScrapbook } from "../scrapbook/store";
import { CATEGORIES } from "../scrapbook/stickers";
import { ORIGINAL, currentLook } from "../scrapbook/looks";
import { newId } from "../scrapbook/model";
import { TopNav, SCREENS } from "../components/TopNav";
import { Popover } from "../components/Popover";
import { Select } from "../components/Select";
import { useStore } from "../store";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { useTags } from "../tagsStore";
import { usePeople } from "../peopleStore";
import { useArtists } from "../artistsStore";
import { COLS, GROUPS, KINDS, NARROW_COLS, PRESETS, canMosaic, move, narrow, readingOrder, resize, type Block, type BlockFilter, type BlockType, type FolderFilter, type HomeDoc, type HomeSticker, MINE } from "../home/board";
import { useHome } from "../home/store";
import { actionOf, BlockBody, defaultSearches, defaultShortcuts, shuffles, useBlockTitle, usePool, useSalt, useSharedPanels, useShortcutOptions } from "../home/blocks";
import { useFind } from "../findStore";
import { useFinders } from "../plugins/find";
import { PlatformIcon } from "../components/PlatformIcon";
import { NO_FILTER, usePictureFilterSections, type PictureFilter } from "../components/PictureFilters";

/** A board row's height and the gap between cells, in pixels; the board's own padding. */
const ROW = 64;
const GAP = 10;
const PAD = 12;
/** Fit: the rows stretch to fill the window, but never shrink below this (the board scrolls instead). */
const MIN_ROW = 48;

/**
 * A row's height for a board of `rows` rows in a window `height` tall: ROW, or with Fit on, whatever fills
 * the window, no smaller than MIN_ROW.
 */
export const rowHeight = (fit: boolean, rows: number, height: number): number => {
  if (!fit || !rows || !height) return ROW;
  return Math.max(MIN_ROW, Math.floor((height - PAD * 2 - GAP * (rows - 1)) / rows));
};
/** A board narrower than this has half the columns (and isn't arranged). */
const NARROW_BELOW = 600;

/**
 * The library's Home: a board of blocks the reader builds (see home/board.ts). The brand in the top
 * bar and ⇧H come back to it; Arrange moves, sizes, adds and sets up its blocks.
 */
export function Home() {
  const root = useStore((s) => s.root);
  const doc = useHome((h) => h.doc);
  const arranging = useHome((h) => h.arranging);
  const picked = useHome((h) => h.doc?.blocks.find((b) => b.id === h.picked));
  const pickedSticker = useHome((h) => h.doc?.stickers?.find((s) => s.id === h.picked));
  useEffect(() => void useHome.getState().load(), [root]);
  // Leaving the Home ends Arrange.
  useEffect(() => () => useHome.getState().setArranging(false), []);
  return (
    <div className="screen home-screen">
      <TopNav current="home" bar={arranging && doc ? <ArrangeControls doc={doc} /> : undefined}>
        {doc && !arranging && doc.blocks.length > 0 && (
          <button className="btn sm home-arrange-btn" onClick={() => useHome.getState().setArranging(true)} title="Arrange: move, size, add and set up the blocks">
            <CornersOut /> <span className="home-arrange-label">Arrange</span>
          </button>
        )}
      </TopNav>
      <div className="home-main">
        <div className="home-scroll">{!doc ? null : !doc.blocks.length && !arranging ? <Presets /> : <Board doc={doc} arranging={arranging} />}</div>
        {arranging && picked && <BlockPanel block={picked} />}
        {arranging && pickedSticker && <StickerPanel sticker={pickedSticker} />}
      </div>
    </div>
  );
}

/* ---------- the board ---------- */

function Board({ doc, arranging }: { doc: HomeDoc; arranging: boolean }) {
  const board = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [preview, setPreview] = useState<Block[] | null>(null);
  const selected = useHome((h) => h.picked);
  const setSelected = useHome((h) => h.pick);
  const [drop, setDrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    // The window's height is the scrolling parent's, not the board's own (which grows with its rows).
    const scroll = el.parentElement ?? el;
    const measure = () => {
      setWidth(el.clientWidth);
      setHeight(scroll.clientHeight);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(scroll);
    measure();
    return () => ro.disconnect();
  }, []);
  const cols = width && width < NARROW_BELOW ? NARROW_COLS : COLS;
  const canArrange = arranging && cols === COLS;
  const blocks = preview ?? doc.blocks;
  const laid = useMemo(() => (cols === COLS ? blocks : narrow(blocks)), [cols, blocks]);
  // Fit: the rows share the window's height. Measured from the blocks as kept, not a drag's preview, so the
  // grid holds still under the cursor and settles when the block is let go.
  const kept = useMemo(() => (cols === COLS ? doc.blocks : narrow(doc.blocks)), [cols, doc.blocks]);
  const rows = useMemo(() => kept.reduce((m, b) => Math.max(m, b.y + b.h), 0), [kept]);
  const row = rowHeight(!!doc.fit, rows, height);
  const order = useMemo(() => readingOrder(laid), [laid]);
  const keyOf = useMemo(() => {
    const m = new Map<string, number>();
    order.filter((b) => actionOf(b)).forEach((b, i) => i < 9 && m.set(b.id, i + 1));
    return m;
  }, [order]);

  /** The grid cell (fractional) under a point of the window. */
  const cellAt = useCallback(
    (cx: number, cy: number) => {
      const r = board.current!.getBoundingClientRect();
      const colW = (r.width - PAD * 2 - GAP * (cols - 1)) / cols;
      return { x: (cx - r.left - PAD) / (colW + GAP), y: (cy - r.top - PAD) / (row + GAP) };
    },
    [cols, row],
  );

  /** A block dragged by its body (move) or its corner (resize), settled live and kept on letting go. */
  const drag = (e: React.PointerEvent, b: Block, mode: "move" | "size") => {
    if (!canArrange || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Its panel opens on a click, not as a drag starts (and a drag closes one, so it doesn't jump about).
    const start = cellAt(e.clientX, e.clientY);
    const grab = { x: start.x - b.x, y: start.y - b.y };
    let last: { x: number; y: number } | null = null;
    const onMove = (ev: PointerEvent) => {
      const c = cellAt(ev.clientX, ev.clientY);
      const next = mode === "move" ? { x: Math.round(c.x - grab.x), y: Math.round(c.y - grab.y) } : { x: Math.ceil(c.x - b.x), y: Math.ceil(c.y - b.y) };
      if (last && last.x === next.x && last.y === next.y) return;
      if (!last && useHome.getState().picked) setSelected(null);
      last = next;
      setPreview(mode === "move" ? move(doc.blocks, b.id, next.x, next.y) : resize(doc.blocks, b.id, next.x, next.y));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("blur", onUp);
      setPreview(null);
      if (!last) return void (mode === "move" && setSelected(b.id));
      if (mode === "move") useHome.getState().moveBlock(b.id, last.x, last.y);
      else useHome.getState().resizeBlock(b.id, last.x, last.y);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("blur", onUp);
  };

  useHomeKeys({ order, keyOf, selected, setSelected, canArrange });

  return (
    <div
      ref={board}
      className={`home-board ${arranging ? "arranging" : ""} ${doc.fit ? "fit" : ""}`}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: `${row}px`, gap: GAP, padding: PAD, "--cols": cols, "--row": `${row}px` } as React.CSSProperties}
      onPointerDown={() => canArrange && setSelected(null)}
      onDragOver={(e) => {
        // A sticker from the shelf: dropped where it is let go.
        if (canArrange && e.dataTransfer.types.includes(STICKER_DRAG)) return void e.preventDefault();
        if (!canArrange || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        const c = cellAt(e.clientX, e.clientY);
        const type = dragging;
        if (!type) return;
        const k = KINDS[type];
        const spot = { x: Math.max(0, Math.min(COLS - k.w, Math.round(c.x - k.w / 2))), y: Math.max(0, Math.round(c.y - 0.5)), w: k.w, h: k.h };
        setDrop((d) => (d && d.x === spot.x && d.y === spot.y ? d : spot));
      }}
      onDragLeave={(e) => {
        if (!board.current?.contains(e.relatedTarget as Node)) setDrop(null);
      }}
      onDrop={(e) => {
        const sticker = e.dataTransfer.getData(STICKER_DRAG);
        if (sticker && canArrange) {
          e.preventDefault();
          const d = JSON.parse(sticker) as DraggedSticker;
          const r = board.current!.getBoundingClientRect();
          useHome.getState().addSticker(newSticker({ x: (e.clientX - r.left) / r.width, y: Math.max(0, (e.clientY - r.top - PAD) / (row + GAP)) }, d));
          return;
        }
        const type = e.dataTransfer.getData(DRAG_TYPE) as BlockType;
        e.preventDefault();
        setDrop(null);
        if (type && KINDS[type] && drop) setSelected(useHome.getState().addBlock(type, { x: drop.x, y: drop.y }));
      }}
    >
      {laid.map((b) => (
        <BlockFrame key={b.id} block={b} number={keyOf.get(b.id)} arranging={arranging} canArrange={canArrange} selected={selected === b.id} onGrab={(e) => drag(e, b, "move")} onSize={(e) => drag(e, b, "size")} />
      ))}
      {drop && <div className="home-drop" style={{ gridColumn: `${drop.x + 1} / span ${drop.w}`, gridRow: `${drop.y + 1} / span ${drop.h}` }} />}
      <HomeStickers board={board} m={{ width, pad: PAD, row: row + GAP }} canArrange={canArrange} />
      {arranging && cols !== COLS && <div className="home-narrow dim small">Widen the window to arrange: in one this narrow the blocks follow each other.</div>}
      {arranging && !doc.blocks.length && (
        <div className="home-drop home-start" style={{ gridColumn: `1 / span ${cols}`, gridRow: "1 / span 3" }}>
          <span className="dim">Add blocks with Add in the top bar: click one, or drag it here.</span>
        </div>
      )}
    </div>
  );
}

/** A block's size class, for its title's weight on the board: the big ones lead, the narrow ones keep to one short line. */
const sizeOf = (b: Block) => (b.w <= 2 ? "xs" : b.w * b.h >= 24 ? "l" : b.w * b.h >= 10 ? "m" : "s");

function BlockFrame({ block, number, arranging, canArrange, selected, onGrab, onSize }: { block: Block; number?: number; arranging: boolean; canArrange: boolean; selected: boolean; onGrab: (e: React.PointerEvent) => void; onSize: (e: React.PointerEvent) => void }) {
  const title = useBlockTitle(block);
  const [salt, reshuffle] = useSalt(block);
  const act = actionOf(block);
  const tools = !arranging && shuffles[block.type] && (
    <button className="btn sm ghost" onClick={reshuffle} title="Others">
      <Shuffle />
    </button>
  );
  return (
    <section
      data-block={block.id}
      className={`home-block panel kind-${block.type} size-${sizeOf(block)} ${block.bare ? "bare" : ""} ${selected ? "selected" : ""}`}
      style={{ gridColumn: `${block.x + 1} / span ${block.w}`, gridRow: `${block.y + 1} / span ${block.h}` }}
      aria-label={title}
      title={block.bare && arranging ? title : undefined}
      onPointerDown={canArrange ? onGrab : undefined}
    >
      {block.bare ? (
        // No name: its tools over its corner, on hover.
        tools && <div className="home-block-tools">{tools}</div>
      ) : (
        <header className="home-block-head">
          {act && !arranging ? (
            <button className="home-block-title" onClick={act} title={number ? `${title} (${number})` : title}>
              {title}
            </button>
          ) : (
            <span className="home-block-title" title={title}>
              {title}
            </span>
          )}
          <span className="grow" />
          {tools}
          {!arranging && number && <kbd className="kbd">{number}</kbd>}
        </header>
      )}
      <div className="home-block-body" inert={arranging || undefined}>
        <BlockBody block={block} salt={salt} />
      </div>
      {canArrange && (
        <button className="home-del" onPointerDown={(e) => e.stopPropagation()} onClick={() => useHome.getState().removeBlock(block.id)} title="Take it off (⌘Z brings it back)">
          <X />
        </button>
      )}
      {canArrange && <span className="home-size" onPointerDown={onSize} title="Drag to size it" />}
    </section>
  );
}

/* ---------- keys ---------- */

/** On the Home: its blocks' numbers, ⏎ to sort, the screens' own keys; arranging: arrows move the
 * block picked (⇧ sizes it), ⌫ takes it off, ⌘Z takes a change back, Esc is done. */
function useHomeKeys({ order, keyOf, selected, setSelected, canArrange }: { order: Block[]; keyOf: Map<string, number>; selected: string | null; setSelected: (id: string | null) => void; canArrange: boolean }) {
  const live = useRef({ order, keyOf, selected, canArrange });
  live.current = { order, keyOf, selected, canArrange };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (isTypingTarget(e.target) || dialogOpen() || st.settingsOpen || st.helpOpen || st.importOpen || st.driveOpen || st.backupOpen) return;
      const h = useHome.getState();
      const { order, keyOf, selected, canArrange } = live.current;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (h.arranging) {
        // Esc closes the block's panel first, then ends Arrange.
        if (key === "Escape") (selected ? setSelected(null) : h.setArranging(false));
        else if ((e.metaKey || e.ctrlKey) && key === "z") h.undo();
        else if (selected && canArrange && (key === "Backspace" || key === "Delete")) {
          if (h.doc?.stickers?.some((x) => x.id === selected)) h.removeSticker(selected);
          else h.removeBlock(selected);
          setSelected(null);
        } else if (selected && canArrange && key.startsWith("Arrow") && h.doc?.stickers?.some((x) => x.id === selected)) {
          const st = h.doc.stickers.find((x) => x.id === selected)!;
          const step = e.shiftKey ? 5 : 1;
          h.updateSticker(st.id, { x: Math.max(0, Math.min(1, st.x + (key === "ArrowLeft" ? -0.005 : key === "ArrowRight" ? 0.005 : 0) * step)), y: Math.max(0, st.y + (key === "ArrowUp" ? -0.05 : key === "ArrowDown" ? 0.05 : 0) * step) });
        }
        else if (selected && canArrange && key.startsWith("Arrow")) {
          const b = h.doc?.blocks.find((x) => x.id === selected);
          if (!b) return;
          const dx = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
          const dy = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0;
          if (e.shiftKey) h.resizeBlock(b.id, b.w + dx, b.h + dy);
          else h.moveBlock(b.id, b.x + dx, b.y + dy);
        } else return;
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[1-9]$/.test(key)) {
        const b = order.find((x) => keyOf.get(x.id) === Number(key));
        const act = b && actionOf(b);
        if (!act) return;
        act();
      } else if (key === "Enter") {
        // The Home's one act-here: sorting, or with nowhere to sort to, the target folders.
        if (!st.library?.targets.length) st.set({ settingsOpen: true });
        else if (st.unsorted.length) st.openSortQueue();
        else return;
      } else if (key === "Escape") st.openSortQueue();
      else if (key === "g") st.set({ settingsOpen: true });
      else if (key === "?") st.set({ helpOpen: true });
      else {
        const screen = Object.values(SCREENS).find((s) => s?.key && s.key.toLowerCase() === key && key.length === 1);
        if (!screen) return;
        screen.go();
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelected]);
}

/* ---------- Arrange ---------- */

const DRAG_TYPE = "application/x-home-block";
/** The kind being dragged from the block menu (its data can't be read until the drop). */
let dragging: BlockType | null = null;

/** Arranging: its controls take the top bar's tabs' place, so the board stays as it is shown. */
function ArrangeControls({ doc }: { doc: HomeDoc }) {
  const h = useHome();
  const [menu, setMenu] = useState<"add" | "stickers" | "folders" | null>(null);
  return (
    <div className="home-arrange">
      <b className="home-arrange-mark" title="Drag a block to move it, its corner to size it; click one to set it up, then arrows move it, ⇧ arrows size it, ⌫ takes it off">
        Arranging
      </b>
      <Popover
        open={menu === "add"}
        onClose={() => setMenu(null)}
        width={440}
        trigger={
          <button className={`btn sm ${menu === "add" ? "active" : ""}`} onClick={() => setMenu(menu === "add" ? null : "add")} title="Add a block: click one, or drag it onto the board">
            <Plus /> Add
          </button>
        }
      >
        <BlockMenu onDone={() => setMenu(null)} />
      </Popover>
      <Popover
        open={menu === "stickers"}
        onClose={() => setMenu(null)}
        width={420}
        trigger={
          <button className={`btn sm ${menu === "stickers" ? "active" : ""}`} onClick={() => setMenu(menu === "stickers" ? null : "stickers")} title="Stickers anywhere on the Home: click one, or drag it where it goes">
            <Smiley /> Stickers
          </button>
        }
      >
        <StickersMenu onDone={() => setMenu(null)} />
      </Popover>
      <button
        className={`btn sm home-fit-btn ${doc.fit ? "active" : ""}`}
        aria-pressed={!!doc.fit}
        onClick={() => h.setFit(!doc.fit)}
        title={doc.fit ? "Fit is on: the blocks stretch to fill the window, and scroll only when it is too short for them all" : "Fit: stretch the blocks to fill the window"}
      >
        <ArrowsOutLineVertical /> Fit
      </button>
      <Popover
        open={menu === "folders"}
        onClose={() => setMenu(null)}
        width={340}
        trigger={
          <button className={`btn sm ${menu === "folders" ? "active" : ""}`} onClick={() => setMenu(menu === "folders" ? null : "folders")} title="Which folders the Home's pictures come from">
            Folders: {doc.folders.mode === "all" || !doc.folders.list.length ? "all" : doc.folders.mode === "hide" ? `all but ${doc.folders.list.length}` : `only ${doc.folders.list.length}`}
          </button>
        }
      >
        <FoldersPanel folders={doc.folders} />
      </Popover>
      <button className="btn sm ghost" disabled={!h.history.length} onClick={h.undo} title="Take the last change back (⌘Z)">
        <ArrowCounterClockwise />
      </button>
      <button className="btn sm primary" onClick={() => h.setArranging(false)} title="Done (Esc)">
        Done
      </button>
    </div>
  );
}

/** Every kind of block, by group: clicked, it goes in the first gap it fits and opens to be set up; dragged, it goes where it is dropped. */
function BlockMenu({ onDone }: { onDone: () => void }) {
  const blocks = useHome((h) => h.doc?.blocks ?? []);
  const onBoard = (t: BlockType) => blocks.find((b) => b.type === t);
  const [q, setQ] = useState("");
  const want = q.trim().toLowerCase();
  const kinds = (Object.keys(KINDS) as BlockType[]).filter((t) => !want || `${KINDS[t].name} ${KINDS[t].about}`.toLowerCase().includes(want));
  return (
    <div className="home-menu">
      <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Look for a block…" />
      <div className="home-menu-list">
        {GROUPS.map((g) => {
          const here = kinds.filter((t) => KINDS[t].group === g.id);
          return here.length ? (
            <div key={g.id} className="home-menu-group">
              <div className="label">{g.name}</div>
              {here.map((t) => {
                const there = onBoard(t);
                const add = () => {
                  onDone();
                  useHome.getState().pick(useHome.getState().addBlock(t));
                };
                return (
                  <div key={t} className={`home-kind ${there ? "on" : ""}`}>
                    <button
                      className="home-kind-main"
                      draggable
                      onDragStart={(e) => {
                        dragging = t;
                        e.dataTransfer.setData(DRAG_TYPE, t);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDragEnd={() => ((dragging = null), onDone())}
                      onClick={() => (there ? (onDone(), pickOnBoard(there.id)) : add())}
                      title={there ? "On the board: click to find it and set it up, or + for another" : `${KINDS[t].about} Click to add, or drag onto the board.`}
                    >
                      <span className="home-kind-name">{KINDS[t].name}</span>
                      {there && <span className="mono small home-kind-on">On the board</span>}
                      <span className="dim small">{KINDS[t].about}</span>
                    </button>
                    <button className="btn sm ghost home-kind-add" onClick={add} title={there ? "Add another" : "Add it"}>
                      <Plus />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : null;
        })}
        {!kinds.length && <span className="dim small">No block by that name.</span>}
      </div>
    </div>
  );
}

/** A block on the board picked from the menu: shown, its settings up. */
function pickOnBoard(id: string) {
  useHome.getState().pick(id);
  document.querySelector(`[data-block="${id}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}

/** Which folders the Home's pictures may come from. */
function FoldersPanel({ folders }: { folders: FolderFilter }) {
  const dirs = useFolders();
  const set = (f: FolderFilter) => useHome.getState().setFolders(f);
  return (
    <div className="home-settings">
      <div className="pop-title">Folders on the Home</div>
      <div className="btn-group">
        {(["all", "hide", "only"] as const).map((m) => (
          <button key={m} className={`btn sm ${folders.mode === m ? "active" : "ghost"}`} onClick={() => set({ ...folders, mode: m })}>
            {m === "all" ? "All" : m === "hide" ? "All but these" : "Only these"}
          </button>
        ))}
      </div>
      {folders.mode !== "all" && (
        <>
          <div className="home-folder-list">
            {folders.list.map((f) => (
              <span key={f} className="chip" title={f}>
                {f}
                <button className="chip-x" onClick={() => set({ ...folders, list: folders.list.filter((x) => x !== f) })} title="Take it off the list">
                  <X />
                </button>
              </span>
            ))}
            {!folders.list.length && <span className="dim small">{folders.mode === "hide" ? "None hidden yet." : "Nothing shows until a folder is added."}</span>}
          </div>
          <Select searchable value="" onChange={(v) => v && !folders.list.includes(v) && set({ ...folders, list: [...folders.list, v] })} options={[{ value: "", label: "Add a folder…" }, ...dirs.filter((d) => !folders.list.includes(d)).map((d) => ({ value: d, label: d }))]} />
        </>
      )}
    </div>
  );
}

/** Every folder in the library, for the pickers. */
function useFolders(): string[] {
  const all = useStore((s) => s.allItems);
  return useMemo(() => {
    const dirs = new Set<string>();
    for (const i of all) {
      const parts = i.dir.split("/").filter(Boolean);
      for (let n = 1; n <= parts.length; n++) dirs.add(parts.slice(0, n).join("/"));
    }
    return [...dirs].sort();
  }, [all]);
}

/**
 * The block picked while arranging, set up in a panel over the board (on the side away from the
 * block, so it stays in view; the board itself doesn't move). Esc or the X closes it.
 */
function BlockPanel({ block }: { block: Block }) {
  const title = useBlockTitle(block);
  const left = block.x + block.w / 2 >= COLS / 2;
  return (
    <aside className={`home-panel panel ${left ? "on-left" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="home-picked-head">
        <h2 className="home-picked-title">{title}</h2>
        <button className="btn sm ghost" onClick={() => useHome.getState().pick(null)} title="Close (Esc)">
          <X />
        </button>
      </div>
      <BlockSettings key={block.id} block={block} title={title} onDone={() => useHome.getState().pick(null)} />
    </aside>
  );
}

/** A block's own settings: its name, which pictures it shows (Browse's filters, or an album), and what its kind needs. */
function BlockSettings({ block, title, onDone }: { block: Block; title: string; onDone: () => void }) {
  const h = useHome.getState();
  const k = KINDS[block.type];
  const set = (patch: Partial<Block>) => h.updateBlock(block.id, patch);
  const shortcuts = useShortcutOptions();
  const chosen = block.screens ?? defaultShortcuts(shortcuts);
  return (
    <div className="home-settings">
      {block.title && <span className="dim small">{k.name}</span>}
      <label className="home-field">
        <span className="label">Name</span>
        <input className="input" defaultValue={block.title ?? ""} placeholder={title} onBlur={(e) => set({ title: e.target.value.trim() || undefined })} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && e.currentTarget.blur())} />
      </label>
      <label className="check">
        <input type="checkbox" checked={!block.bare} onChange={(e) => set({ bare: e.target.checked ? undefined : true })} /> Show its name
      </label>
      {canMosaic(block) && (
        <div className="home-field">
          <span className="label">Pictures as</span>
          <div className="btn-group">
            <button className={`btn sm ${block.layout === "mosaic" ? "ghost" : "active"}`} onClick={() => set({ layout: undefined })} title="Squares in a grid">
              Grid
            </button>
            <button className={`btn sm ${block.layout === "mosaic" ? "active" : "ghost"}`} onClick={() => set({ layout: "mosaic" })} title="Each picture its own shape, in rows that fill the block">
              Mosaic
            </button>
          </div>
        </div>
      )}
      {k.sourced && <BlockFilters block={block} />}
      {block.type === "picture" && block.pinned && (
        <button className="btn sm" onClick={() => set({ pinned: undefined })}>
          Let it change each day
        </button>
      )}
      {block.type === "shortcuts" && (
        <div className="home-field">
          <span className="label">On it</span>
          <div className="home-checks">
            {shortcuts.map((o) => {
              const on = chosen.includes(o.id);
              return (
                <label key={o.id} className="check">
                  <input type="checkbox" checked={on} onChange={() => set({ screens: on ? chosen.filter((x) => x !== o.id) : [...chosen, o.id] })} /> {o.icon} {o.label}
                </label>
              );
            })}
          </div>
        </div>
      )}
      {block.type === "jumpin" && <JumpInSettings block={block} />}
      {block.type === "shared" && <SharedSettings block={block} />}
      <div className="row">
        <button className="btn sm danger" onClick={() => (onDone(), h.removeBlock(block.id))}>
          <Trash /> Take it off
        </button>
      </div>
    </div>
  );
}

/** Jump in: the saved searches on it, by platform. */
function JumpInSettings({ block }: { block: Block }) {
  const saved = useFind((f) => f.saved);
  const finders = useFinders((f) => f.finders);
  useEffect(() => void useFind.getState().loadBaskets(), []);
  const chosen = block.searches ?? defaultSearches(saved);
  const set = (ids: string[]) => useHome.getState().updateBlock(block.id, { searches: ids });
  const platforms = [...new Set(saved.map((s) => s.pluginId))];
  if (!saved.length) return <span className="dim small">No saved searches yet: save one in Find, then pick it here.</span>;
  return (
    <div className="home-field">
      <span className="label">Saved searches on it</span>
      {platforms.map((pid) => (
        <div key={pid} className="home-checks-group">
          <div className="home-list-head small">
            <PlatformIcon pluginId={pid} url={finders[pid]?.icon ?? null} />
            <span className="ellipsis">{finders[pid]?.name ?? pid}</span>
          </div>
          {saved
            .filter((s) => s.pluginId === pid)
            .map((s) => {
              const on = chosen.includes(s.id);
              return (
                <label key={s.id} className="check">
                  <input type="checkbox" checked={on} onChange={() => set(on ? chosen.filter((x) => x !== s.id) : [...chosen, s.id])} /> <span className="ellipsis">{s.name}</span>
                </label>
              );
            })}
        </div>
      ))}
    </div>
  );
}

/** From extensions: which of the shared panels it shows. */
function SharedSettings({ block }: { block: Block }) {
  const panels = useSharedPanels();
  if (!panels.length) return <span className="dim small">No extension shares a panel yet: one that does shows up here to pick.</span>;
  return (
    <div className="home-field">
      <span className="label">Panel</span>
      <Select value={block.panel ?? panels[0].id} onChange={(v) => useHome.getState().updateBlock(block.id, { panel: v })} options={panels.map((p) => ({ value: p.id, label: `${p.title} (${p.id})` }))} />
    </div>
  );
}

/** A picture block's filters. */
function BlockFilters({ block }: { block: Block }) {
  return (
    <FilterEditor
      label="Pictures"
      filter={block.filter}
      defaults={block.type === "favourites" ? { minRating: 8 } : {}}
      onChange={(filter) => useHome.getState().updateBlock(block.id, { filter })}
    />
  );
}

/** Browse's filters, in the same sections, plus one album (its pages, which Browse leaves out). */
function FilterEditor({ label, filter = {}, defaults = {}, onChange }: { label: string; filter?: BlockFilter; defaults?: Partial<PictureFilter>; onChange: (f: BlockFilter | undefined) => void }) {
  const pool = usePool();
  const albums = useStore((s) => s.albums);
  useEffect(() => {
    if (!useStore.getState().albumsLoaded) void useStore.getState().loadAlbums();
    void useTags.getState().load();
    void usePeople.getState().load();
    void useArtists.getState().load();
  }, []);
  const full: PictureFilter = { ...NO_FILTER, ...defaults, ...filter };
  const set = (patch: Partial<BlockFilter>) => onChange({ ...filter, ...patch });
  const base = useMemo(() => pool.filter((i) => !i.albumKey), [pool]);
  const sections = usePictureFilterSections(full, set, base);
  const on = sections.flatMap((s) => s.chips.map((c) => ({ ...c, key: `${s.id}:${c.key}` })));
  return (
    <div className="home-filters">
      <div className="home-filters-head">
        <span className="label">{label}</span>
        <span className="grow" />
        {(on.length > 0 || filter.album) && (
          <button className="btn sm ghost" onClick={() => onChange(undefined)}>
            Clear
          </button>
        )}
      </div>
      {on.length > 0 && (
        <div className="home-folder-list">
          {on.map((c) => (
            <span key={c.key} className="chip" title={c.title}>
              {c.label}
              <button className="chip-x" onClick={c.remove} title="Take it off">
                <X />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="home-field">
        <span className="label">Album</span>
        <Select searchable value={filter.album ?? ""} onChange={(v) => set({ album: v || undefined })} options={[{ value: "", label: "None: pictures, not album pages" }, ...albums.map((a) => ({ value: a.key, label: a.name }))]} />
      </div>
      {sections.map((s) => (
        <div key={s.id} className="home-field">
          <span className="label">{s.label}</span>
          {s.body}
        </div>
      ))}
    </div>
  );
}

/** A sticker on the Home, set up: its look, its edge, flipped, front or back, and a random one's choice. */
function StickerPanel({ sticker }: { sticker: HomeSticker }) {
  const h = useHome.getState();
  const set = (patch: Partial<HomeSticker>) => h.updateSticker(sticker.id, patch);
  const look = currentLook();
  const cats = sticker.random?.categories ?? [];
  const toggleCat = (id: string) => set({ random: { ...sticker.random, categories: cats.includes(id) ? cats.filter((c) => c !== id) : [...cats, id] } });
  const left = sticker.x >= 0.5;
  return (
    <aside className={`home-panel panel ${left ? "on-left" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
      <div className="home-picked-head">
        <h2 className="home-picked-title">{sticker.random ? "Random sticker" : "Sticker"}</h2>
        <button className="btn sm ghost" onClick={() => h.pick(null)} title="Close (Esc)">
          <X />
        </button>
      </div>
      <div className="home-settings">
        <div className="home-field">
          <span className="label">Look</span>
          <div className="btn-group">
            <button className={`btn sm ${sticker.look === ORIGINAL ? "active" : "ghost"}`} onClick={() => set({ look: ORIGINAL })}>
              Its own colours
            </button>
            <button className={`btn sm ${sticker.look !== ORIGINAL ? "active" : "ghost"}`} onClick={() => set({ look: look.id })}>
              The {look.name} look
            </button>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={sticker.outline} onChange={(e) => set({ outline: e.target.checked })} /> A cut edge round it
        </label>
        <label className="check">
          <input type="checkbox" checked={!!sticker.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} /> Flipped
        </label>
        <div className="row">
          <button className="btn sm" onClick={() => h.restack(sticker.id, true)}>
            To the front
          </button>
          <button className="btn sm" onClick={() => h.restack(sticker.id, false)}>
            To the back
          </button>
          <button className="btn sm" onClick={() => h.addSticker({ ...sticker, id: newId(), x: Math.min(1, sticker.x + 0.03), y: sticker.y + 0.4 })}>
            Duplicate
          </button>
        </div>
        {sticker.random && (
          <>
            <div className="home-field">
              <span className="label">Picked from</span>
              <div className="chips">
                {[...CATEGORIES, { id: MINE, name: "Your cut-outs" }].map((c) => (
                  <button key={c.id} className={`chip ${cats.includes(c.id) ? "active" : ""}`} onClick={() => toggleCat(c.id)}>
                    {c.name}
                  </button>
                ))}
              </div>
              <span className="dim small">{cats.length ? "Only these." : "None picked: all of them."}</span>
            </div>
            {(!cats.length || cats.includes(MINE)) && <FilterEditor label="Cut from pictures" filter={sticker.random.filter} onChange={(filter) => set({ random: { ...sticker.random, filter } })} />}
            <label className="check" title="Off, it may show a sticker that is on the Home already">
              <input type="checkbox" checked={!sticker.random.repeats} onChange={(e) => set({ random: { ...sticker.random, repeats: e.target.checked ? undefined : true } })} /> Never the same as another sticker on the Home
            </label>
          </>
        )}
        <div className="row">
          <button className="btn sm danger" onClick={() => h.removeSticker(sticker.id)}>
            <Trash /> Take it off
          </button>
        </div>
      </div>
    </aside>
  );
}

/** The sticker shelf, for the top bar while arranging: one clicked goes in the middle of what is in view, one dragged where it is dropped; or a random one. */
function StickersMenu({ onDone }: { onDone: () => void }) {
  const shelf = useScrapbook((x) => x.lib?.stickers) ?? [];
  const root = useStore((s) => s.root);
  useEffect(() => void useScrapbook.getState().load(), [root]);
  const inView = () => {
    const sc = document.querySelector<HTMLElement>(".home-scroll");
    const row = parseFloat(sc?.querySelector<HTMLElement>(".home-board")?.style.getPropertyValue("--row") ?? "") || ROW;
    return { x: 0.5, y: sc ? Math.max(0, (sc.scrollTop + sc.clientHeight / 2 - PAD) / (row + GAP)) : 2 };
  };
  return (
    <div className="home-menu">
      <button
        className="btn sm"
        onClick={() => {
          onDone();
          useHome.getState().addSticker(newSticker(inView()));
        }}
        title="A new one each time the Home opens, from the stickers you choose"
      >
        <Shuffle /> A random sticker
      </button>
      <StickerShelf
        stickers={shelf}
        onMake={() => (onDone(), void useScrapbook.getState().openStudio({}))}
        onAdd={(src, aspect, custom) => {
          onDone();
          useHome.getState().addSticker(newSticker(inView(), { src, aspect, custom }));
        }}
      />
    </div>
  );
}

/* ---------- a Home to start from ---------- */

/** No board yet: the presets, each drawn as its blocks, or an empty board to fill. */
function Presets() {
  const h = useHome();
  return (
    <div className="home-presets">
      <h1 className="home-presets-title">Make this library's Home</h1>
      <p className="dim">Start from one of these; Arrange changes anything after, and each library keeps its own.</p>
      <div className="home-preset-grid">
        {PRESETS.map((p) => (
          <button key={p.id} className="home-preset panel" onClick={() => h.start(p.id)}>
            <span className="home-preset-map" style={{ gridTemplateRows: `repeat(${Math.max(...p.blocks.map((b) => b.y + b.h))}, 1fr)` }}>
              {p.blocks.map((b, i) => (
                <i key={i} className={`g-${KINDS[b.type].group}`} style={{ gridColumn: `${b.x + 1} / span ${b.w}`, gridRow: `${b.y + 1} / span ${b.h}` }} />
              ))}
            </span>
            <span className="home-preset-name">{p.name}</span>
            <span className="dim small">{p.about}</span>
          </button>
        ))}
      </div>
      <button className="btn ghost" onClick={() => h.setArranging(true)}>
        Start empty and add blocks
      </button>
    </div>
  );
}
