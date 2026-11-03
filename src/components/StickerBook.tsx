import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, Books, CaretLeft, CaretRight, Check, PaintBrush, Palette, Scissors, SquaresFour, Tag as TagIcon, Trash, User, X } from "@phosphor-icons/react";
import { useScrapbook, blobUrl, knownUrl } from "../scrapbook/store";
import { madeAt, type CustomSticker, type Target } from "../scrapbook/model";
import { useStore } from "../store";
import { albumKeyOf, nameOf, typeOf, useTags } from "../tagsStore";
import { usePeople } from "../peopleStore";
import { useArtists } from "../artistsStore";
import { ask } from "./Confirm";
import { formatDate } from "../lib/format";
import { canThumb, mediaUrl, thumbUrl } from "../lib/api";

/** How stickers sit on a page at each size, smallest first: so many across, so many down. */
export const GRIDS = [
  { cols: 6, rows: 8 },
  { cols: 5, rows: 7 },
  { cols: 4, rows: 5 },
  { cols: 3, rows: 4 },
  { cols: 2, rows: 3 },
];
/** The size a book opens at, until another is chosen: three across, four down. */
const DEFAULT_SIZE = 3;
/** Stickers on a page at the size it opens at. */
export const PER_PAGE = GRIDS[DEFAULT_SIZE].cols * GRIDS[DEFAULT_SIZE].rows;
const SIZE_KEY = "quire.stickerBookSize";

function loadSize(): number {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    return Number.isInteger(v) && v >= 0 && v < GRIDS.length && localStorage.getItem(SIZE_KEY) !== null ? v : DEFAULT_SIZE;
  } catch {
    return DEFAULT_SIZE;
  }
}
/** A page turn, unhurried; quicker when more turns wait. */
const TURN = 650;

/** A sticker on a page, and its number in the book (from 1). */
type Entry = { kind: "mine"; sticker: CustomSticker; n: number };
export interface BookPage {
  /** The section it opens (its washi-tape title), if it opens one. */
  title?: string;
  section: string;
  entries: Entry[];
  /** The title page. */
  cover?: boolean;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The book's pages: a title page, then your stickers by the month they were made (newest first), a new page for each month. */
export function bookPages(mine: CustomSticker[], perPage = PER_PAGE): BookPage[] {
  const pages: BookPage[] = [{ section: "start", entries: [], cover: true }];
  const byMonth = new Map<string, CustomSticker[]>();
  for (const st of [...mine].sort((a, b) => (madeAt(b) ?? 0) - (madeAt(a) ?? 0))) {
    const t = madeAt(st);
    const key = t ? `${new Date(t).getFullYear()}-${String(new Date(t).getMonth() + 1).padStart(2, "0")}` : "earlier";
    byMonth.set(key, [...(byMonth.get(key) ?? []), st]);
  }
  if (!byMonth.size) pages.push({ section: "empty", title: "My stickers", entries: [] });
  let n = 0;
  for (const [key, list] of byMonth) {
    const title = key === "earlier" ? "Earlier" : `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
    for (let i = 0; i < list.length; i += perPage) pages.push({ section: key, title: i ? undefined : title, entries: list.slice(i, i + perPage).map((sticker) => ({ kind: "mine", sticker, n: ++n })) });
  }
  // An even count: every spread has two pages.
  if (pages.length % 2) pages.push({ section: "end", entries: [] });
  return pages;
}

/** The next spread on the way from `at` to `target`, and how long its turn takes: a far jump skips ahead and riffles the last few pages. */
export function nextTurn(at: number, target: number): { skipTo: number; dir: 1 | -1; ms: number } | null {
  if (at === target) return null;
  const dir = target > at ? 1 : -1;
  const left = Math.abs(target - at);
  const skipTo = left > 4 ? target - dir * 3 : at;
  const ms = left > 1 ? Math.max(140, TURN / Math.min(left, 4)) : TURN;
  return { skipTo, dir, ms };
}

/**
 * Each theme's sticker book: what it is (its look is in the CSS, `.book-<id>`), how it turns, and
 * its title page. A paper book turns a leaf (a manga volume right to left); Night City's holopad
 * swipes from screen to screen with a glitch.
 */
export interface BookKind {
  id: string;
  motion: "leaf" | "swipe";
  /** Read right to left: the first page of a spread on the right, the next spread to the left. */
  rtl?: boolean;
  title: string;
  count: (n: number) => string;
  /** Stickers set down by hand, a little askew. */
  askew: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const BOOKS: BookKind[] = [
  { id: "cozy", motion: "leaf", title: "Sticker book", count: (n) => `${plural(n, "sticker", "stickers")} collected`, askew: true },
  { id: "cp2077", motion: "swipe", title: "Sticker databank", count: (n) => `${plural(n, "entry", "entries")} // synced`, askew: false },
  { id: "ghost", motion: "leaf", title: "Field notes", count: (n) => plural(n, "specimen", "specimens"), askew: true },
  { id: "midnight", motion: "leaf", title: "Star atlas", count: (n) => `${plural(n, "star", "stars")} charted`, askew: false },
  { id: "sunset", motion: "leaf", title: "Travel journal", count: (n) => plural(n, "souvenir", "souvenirs"), askew: true },
  { id: "manga", motion: "leaf", rtl: true, title: "Stickers vol. 1", count: (n) => plural(n, "panel", "panels"), askew: false },
  { id: "gallery", motion: "leaf", title: "The collection", count: (n) => plural(n, "work", "works"), askew: false },
];

/** The book of a theme (the scrapbook one for a theme without its own). */
export const bookOf = (theme: string) => BOOKS.find((b) => b.id === theme) ?? BOOKS[0];

/** A sticker's slight tilt, the same each time (from its id). */
function tilt(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h % 13) - 6) * 0.8;
}

/** A sticker's picture; one read before shows at once (a page put down after a turn doesn't blink). */
function MineImg({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(() => knownUrl(name));
  useEffect(() => {
    if (knownUrl(name)) return setUrl(knownUrl(name));
    let alive = true;
    void blobUrl(name).then((u) => alive && setUrl(u), () => {});
    return () => {
      alive = false;
    };
  }, [name]);
  return url ? <img src={url} alt="" draggable={false} /> : null;
}

function Page({ kind, page, side, number, onMake, onPick, picked }: { kind: BookKind; page: BookPage | undefined; side: "left" | "right"; number: number; onMake: () => void; onPick: (id: string, side: "left" | "right") => void; picked: string | null }) {
  const mineCount = useScrapbook((x) => x.lib?.stickers.length ?? 0);
  if (!page) return <div className={`book-page ${side} blank`} />;
  let body: ReactNode;
  if (page.cover) {
    body = (
      <div className="book-title">
        <div className="book-title-name">{kind.title}</div>
        <div className="book-title-sub">{kind.count(mineCount)}</div>
        <button className="btn primary" onClick={onMake}>
          <Scissors /> Make a sticker
        </button>
        <div className="book-title-hint">
          {kind.rtl ? "Read right to left. " : ""}
          {kind.motion === "swipe" ? "Swipe" : "Turn the page"}: arrows, the wheel, or the {kind.motion === "swipe" ? "tabs" : "ribbons"} on the side. Click a sticker for its story.
        </div>
      </div>
    );
  } else if (page.section === "empty") {
    body = (
      <div className="book-empty">
        No stickers yet.
        <button className="btn sm" onClick={onMake}>
          <Scissors /> Cut one from a picture
        </button>
      </div>
    );
  } else {
    body = (
      <div className="book-slots">
        {page.entries.map(({ sticker, n }) => {
          const t = tilt(sticker.id);
          const made = madeAt(sticker);
          return (
            <button key={sticker.id} className={`book-slot mine ${picked === sticker.id ? "picked" : ""}`} onClick={() => onPick(sticker.id, side)} title={sticker.from ? `Cut from ${sticker.from}` : "Yours"}>
              <div className="book-sticker" style={{ "--tilt": `${kind.askew ? t : 0}deg`, "--flicker": `${(t + 5) * 0.7}s` } as CSSProperties}>
                <MineImg name={sticker.blob} />
              </div>
              {/* A museum label (the gallery's catalogue shows it). */}
              <span className="book-label">
                No. {n}
                {made ? ` · ${new Date(made).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}
              </span>
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className={`book-page ${side}`}>
      {page.title && <div className={`book-washi ${/^\d{4}-\d{2}$/.test(page.section) ? `m${Number(page.section.slice(5)) % 7}` : "mine"}`}>{page.title}</div>}
      {body}
      {!page.cover && <div className="book-number">{number}</div>}
    </div>
  );
}

/**
 * What a sticker is: the picture it came from (and its tags), its size, when it was made, the
 * covers using it. Laid over the page across from the sticker, so the book keeps its size.
 */
function StickerInfo({ sticker, on, onClose }: { sticker: CustomSticker; on: "left" | "right"; onClose: () => void }) {
  const root = useStore((x) => x.root);
  const all = useStore((x) => x.allItems);
  const albums = useStore((x) => x.albums);
  const albumCovers = useStore((x) => x.library?.albumCovers);
  const tagData = useTags((x) => x.data);
  const books = useScrapbook((x) => x.lib?.books);
  const banners = useScrapbook((x) => x.lib?.banners);
  const people = usePeople((x) => x.doc?.people);
  const artists = useArtists((x) => x.doc?.artists);
  // Older stickers only know their picture's name: one picture by it is a guess, several are asked about.
  const named = useMemo(() => (sticker.source || !sticker.from ? [] : all.filter((i) => i.name === sticker.from)), [all, sticker]);
  const source = useMemo(() => (sticker.source ? all.find((i) => i.key === sticker.source) : named.length === 1 ? named[0] : undefined), [all, sticker, named]);
  const guessed = !sticker.source && !!source;
  const setSource = (key: string) => {
    const lib = useScrapbook.getState().lib;
    if (lib) useScrapbook.getState().setStickers(lib.stickers.map((s) => (s.id === sticker.id ? { ...s, source: key } : s)));
  };
  const tags = useMemo(() => {
    if (!source || !tagData) return [];
    const own = tagData.tags[source.key] ?? [];
    const album = source.albumKey ? (tagData.tags[albumKeyOf(source.albumKey)] ?? []) : [];
    return [...new Set([...own, ...album])];
  }, [source, tagData]);
  // The covers that have it on: by their album or tag.
  const usedIn = useMemo(() => {
    const out: Target[] = [];
    const uses = (book: string) => books?.[book]?.layers.some((l) => l.type === "sticker" && "blob" in l.src && l.src.blob === sticker.blob);
    for (const [key, book] of Object.entries(albumCovers ?? {})) if (uses(book)) out.push({ kind: "album", key, name: albums.find((a) => a.key === key)?.name ?? key.split("/").pop() ?? key });
    for (const [id, book] of Object.entries(tagData?.covers ?? {})) if (uses(book)) out.push({ kind: "tag", id, name: nameOf(id) });
    return out;
  }, [books, albumCovers, tagData, albums, sticker.blob]);
  // The banners that have it on: by their person or artist (as far as they are loaded).
  const onBanners = useMemo(() => {
    const uses = (banner: string | undefined) => !!banner && !!banners?.[banner]?.stickers.some((s) => "blob" in s.src && s.src.blob === sticker.blob);
    return [
      ...Object.values(people ?? {}).filter((p) => uses(p.banner)).map((p) => ({ kind: "person" as const, id: p.id, name: p.name })),
      ...Object.values(artists ?? {}).filter((a) => uses(a.banner)).map((a) => ({ kind: "artist" as const, id: a.id, name: a.name })),
    ];
  }, [banners, people, artists, sticker.blob]);
  const made = madeAt(sticker);
  const openSource = () => source && useStore.getState().openViewer([source], 0, { kind: "browse" });
  return (
    <aside className={`sticker-info panel on-${on}`}>
      <div className="row">
        <span className="label grow">Sticker</span>
        <button className="btn sm ghost" onClick={onClose} title="Close">
          <X />
        </button>
      </div>
      <div className="sticker-info-pic">
        <MineImg name={sticker.blob} />
      </div>
      <button className="btn sm" onClick={() => void useScrapbook.getState().openStudio({ sticker })} title="Its edge grown or shrunk, softened, painted in or away">
        <PaintBrush /> Fine-tune
      </button>
      <dl className="sticker-info-facts">
        <dt>Size</dt>
        <dd>
          {sticker.w} × {sticker.h} px
        </dd>
        <dt>Made</dt>
        <dd>{made ? formatDate(made) : "—"}</dd>
        <dt>In covers</dt>
        <dd>{usedIn.length ? usedIn.length : "none yet"}</dd>
        {onBanners.length > 0 && (
          <>
            <dt>On banners</dt>
            <dd>{onBanners.length}</dd>
          </>
        )}
      </dl>
      {usedIn.length > 0 && (
        <div className="chips">
          {usedIn.map((t) => (
            <button key={t.kind === "album" ? t.key : t.id} className="chip" onClick={() => void useScrapbook.getState().open(t)} title="Edit that cover">
              {t.kind === "album" ? <Books /> : <TagIcon />} {t.name}
            </button>
          ))}
        </div>
      )}
      {onBanners.length > 0 && (
        <div className="chips">
          {onBanners.map((b) => (
            <button
              key={`${b.kind}:${b.id}`}
              className="chip"
              title="Open their page"
              onClick={() => {
                if (b.kind === "artist") return useStore.getState().openArtists(b.id);
                usePeople.getState().setOpen(b.id);
                useStore.getState().openPeople();
              }}
            >
              {b.kind === "artist" ? <Palette /> : <User />} {b.name}
            </button>
          ))}
        </div>
      )}
      <div className="label">Cut from</div>
      {source ? (
        <>
          <button className="sticker-info-source" onClick={openSource} title="Open the picture">
            <img src={root && canThumb(source) ? thumbUrl(root, source, 640) : mediaUrl(source)} alt="" draggable={false} />
          </button>
          <div className="mono small ellipsis" title={source.primary}>
            {source.dir ? `${source.dir}/` : ""}
            {source.name}
          </div>
          <div className="chips">
            {tags.map((id) => (
              <span key={id} className="chip" title={id}>
                {nameOf(id)} <span className="dim small">{typeOf(id)}</span>
              </span>
            ))}
            {!tags.length && <span className="dim small">No tags.</span>}
          </div>
          <button className="btn sm primary" onClick={openSource}>
            <ArrowSquareOut /> Open the picture
          </button>
          {guessed && (
            <div className="row sticker-info-guess">
              <span className="dim small grow">Found by its name only.</span>
              <button className="btn sm ghost" onClick={() => setSource(source.key)} title="Yes, it was cut from this one">
                <Check /> That's it
              </button>
            </div>
          )}
        </>
      ) : named.length > 1 ? (
        <>
          <div className="dim small">
            {named.length} pictures are called “{sticker.from}”. Which was it cut from?
          </div>
          <div className="sticker-info-named">
            {named.slice(0, 24).map((it) => (
              <button key={it.key} onClick={() => setSource(it.key)} title={`${it.dir ? `${it.dir}/` : ""}${it.name}`}>
                <img src={root && canThumb(it) ? thumbUrl(root, it, 160) : mediaUrl(it)} alt="" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="dim small">{sticker.from ? `“${sticker.from}”, which isn't in the library any more.` : "Not known."}</div>
      )}
      <span className="grow" />
      <button
        className="btn sm ghost danger"
        onClick={() =>
          void ask({ title: "Peel off the sticker", message: <>Take it out of the book? {usedIn.length ? `The ${usedIn.length} cover${usedIn.length === 1 ? "" : "s"} using it keep it.` : ""}</>, confirm: "Peel off", danger: true }).then((ok) => {
            if (!ok) return;
            useScrapbook.getState().removeSticker(sticker.id);
            onClose();
          })
        }
      >
        <Trash /> Peel off
      </button>
    </aside>
  );
}

/**
 * The sticker book: the stickers you cut, by month, two pages at a time, in the theme's own book
 * (BOOKS), turned with a page-turn or swiped. It turns quickly when asked for many pages at once (the wheel,
 * a held arrow, a ribbon or the slider far along): the turns queue and speed up, and a long jump
 * skips ahead to riffle only the last few.
 */
const NONE: CustomSticker[] = [];

/** `bar`: where the page slider goes (the page's tab bar), if not under the book. */
export function StickerBook({ onMake, bar }: { onMake: () => void; bar?: HTMLElement | null }) {
  const kind = bookOf(useStore((x) => x.theme));
  const rtl = !!kind.rtl;
  const mine = useScrapbook((x) => x.lib?.stickers ?? NONE);
  // How big the stickers are, and so how many to a page (kept, like Browse's tile size).
  const [size, setSize] = useState(loadSize);
  const grid = GRIDS[size];
  const perPage = grid.cols * grid.rows;
  const pages = useMemo(() => bookPages(mine, perPage), [mine, perPage]);
  const spreads = pages.length / 2;
  const [at, setAt] = useState(0);
  const [target, setTarget] = useState(0);
  const [turn, setTurn] = useState<{ dir: 1 | -1; ms: number } | null>(null);
  // The sticker clicked, and the page it is on (its story opens over the other one).
  const [picked, setPicked] = useState<{ id: string; side: "left" | "right" } | null>(null);
  const pickedSticker = picked ? (mine.find((st) => st.id === picked.id) ?? null) : null;
  const pick = (id: string, side: "left" | "right") => setPicked((p) => (p?.id === id ? null : { id, side }));
  const wheel = useRef(0);
  const book = useRef<HTMLDivElement>(null);
  // The turn under way, also for asks that come before the next render (two wheel notches at once).
  const turning = useRef(turn);
  turning.current = turn;
  const go = (to: number) => {
    // Asked again while a page turns: that turn ends now and the next starts, no waiting.
    const t = turning.current;
    if (t) {
      turning.current = null;
      setAt((a) => a + t.dir);
      setTurn(null);
    }
    setPicked(null);
    setTarget(Math.max(0, Math.min(spreads - 1, to)));
  };

  // One turn at a time toward the target: a turn under way ends after its time, then the next starts.
  useEffect(() => {
    if (turn) {
      const t = setTimeout(() => {
        setAt((a) => a + turn.dir);
        setTurn(null);
      }, turn.ms);
      return () => clearTimeout(t);
    }
    const step = nextTurn(at, target);
    if (!step) return;
    if (step.skipTo !== at) return setAt(step.skipTo);
    setTurn({ dir: step.dir, ms: step.ms });
  }, [at, target, turn]);
  // Fewer spreads (a sticker peeled off): stay inside the book.
  useEffect(() => {
    if (at > spreads - 1) (setAt(spreads - 1), setTarget(spreads - 1));
  }, [at, spreads]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]")) return;
      // Right to left, the next page is to the left.
      if (e.key === "PageDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight")) go(target + 1);
      else if (e.key === "PageUp" || e.key === (rtl ? "ArrowRight" : "ArrowLeft")) go(target - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(spreads - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The page on each side of a spread, and its number: right to left, a spread's first page is on the right.
  const side = (sp: number, which: "left" | "right") => {
    const i = sp * 2 + ((which === "left") !== rtl ? 0 : 1);
    return { page: pages[i], number: i };
  };
  const page = (sp: number, which: "left" | "right", key?: string) => {
    const p = side(sp, which);
    return <Page key={key} kind={kind} page={p.page} side={which} number={p.number} onMake={onMake} onPick={pick} picked={picked?.id ?? null} />;
  };
  const next = turn ? at + turn.dir : at;
  // A leaf turning from the right half to the left (forward, or back when read right to left), or the other way.
  const toLeft = turn ? (turn.dir === 1) !== rtl : false;
  const sections = useMemo(() => {
    const seen = new Map<string, { name: string; spread: number }>();
    pages.forEach((p, i) => p.title && !seen.has(p.section) && seen.set(p.section, { name: p.title, spread: Math.floor(i / 2) }));
    return [...seen.entries()];
  }, [pages]);
  // The section of the spread shown (the right page's, unless that is the blank one at the end).
  const current = [pages[at * 2 + 1], pages[at * 2]].find((p) => p && p.section !== "end")?.section;
  // Another size: the book opens where the first sticker shown now is.
  const resize = (next: number) => {
    const first = [pages[at * 2], pages[at * 2 + 1]].flatMap((p) => p?.entries ?? [])[0]?.n;
    const g = GRIDS[next];
    const after = bookPages(mine, g.cols * g.rows);
    const i = first ? after.findIndex((p) => p.entries.some((e) => e.n === first)) : 0;
    const spread = Math.max(0, Math.floor(i / 2));
    turning.current = null;
    setTurn(null);
    setPicked(null);
    setSize(next);
    setAt(spread);
    setTarget(spread);
    try {
      localStorage.setItem(SIZE_KEY, String(next));
    } catch {
      // Kept for this time only.
    }
  };
  const scrub = (
    <div className="book-controls row">
      <label className="book-size row" title="Sticker size: bigger, and fewer to a page">
        <SquaresFour className="dim" />
        <input type="range" min={0} max={GRIDS.length - 1} step={1} value={size} onChange={(e) => resize(Number(e.target.value))} />
        <span className="mono small dim">{perPage} a page</span>
      </label>
      <div className="book-scrub row">
      <input type="range" min={0} max={Math.max(0, spreads - 1)} value={target} onChange={(e) => go(Number(e.target.value))} title="Leaf through" />
      <span className="mono small dim">
        {target + 1} / {spreads}
        </span>
      </div>
    </div>
  );

  return (
    <div className={`sticker-book-wrap book-${kind.id} ${rtl ? "rtl" : ""} ${grid.cols >= 5 ? "dense" : ""}`} style={{ "--cols": grid.cols, "--rows": grid.rows } as CSSProperties}>
      <div
        className="sticker-book"
        ref={book}
        onWheel={(e) => {
          // Not while a sticker's story is open: the wheel scrolls it.
          if (pickedSticker) return;
          // A long swipe turns many pages: one per notch, queued.
          wheel.current += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
          if (Math.abs(wheel.current) >= 60) {
            go(target + Math.sign(wheel.current) * Math.floor(Math.abs(wheel.current) / 60));
            wheel.current = 0;
          }
        }}
      >
        <div className="book-cover">
          <div className={`book-spread ${kind.motion}`}>
            {kind.motion === "swipe" ? (
              // The holopad: the screen swipes to the next, with a glitch on the way.
              turn ? (
                <>
                  <div key={`out${at}`} className={`holo-screen out ${turn.dir === 1 ? "fwd" : "back"}`} style={{ animationDuration: `${turn.ms}ms` }}>
                    {page(at, "left")}
                    {page(at, "right")}
                  </div>
                  <div key={`in${next}`} className={`holo-screen in ${turn.dir === 1 ? "fwd" : "back"}`} style={{ animationDuration: `${turn.ms}ms` }}>
                    {page(next, "left")}
                    {page(next, "right")}
                  </div>
                  <div className={`holo-sweep ${turn.dir === 1 ? "fwd" : "back"}`} style={{ animationDuration: `${turn.ms}ms` }} />
                </>
              ) : (
                <div className="holo-screen">
                  {page(at, "left")}
                  {page(at, "right")}
                </div>
              )
            ) : (
              <>
                {/* Under a turning leaf: the page it uncovers, and the one it is about to cover. */}
                {page(toLeft || !turn ? at : next, "left")}
                {page(toLeft && turn ? next : at, "right")}
                {turn && (
                  <div className={`book-leaf ${toLeft ? "forward" : "back"}`} style={{ animationDuration: `${turn.ms}ms` }}>
                    <div className="book-face front">{toLeft ? page(at, "right") : page(next, "right")}</div>
                    <div className="book-face back">{toLeft ? page(next, "left") : page(at, "left")}</div>
                  </div>
                )}
              </>
            )}
            <div className="book-spine" />
            {/* Right to left, the next page is the left one. */}
            <button className="book-corner left" disabled={rtl ? target >= spreads - 1 : target <= 0} onClick={() => go(target + (rtl ? 1 : -1))} title={rtl ? "Turn the page (←)" : "Back a page (←)"}>
              <CaretLeft />
            </button>
            <button className="book-corner right" disabled={rtl ? target <= 0 : target >= spreads - 1} onClick={() => go(target + (rtl ? -1 : 1))} title={rtl ? "Back a page (→)" : "Turn the page (→)"}>
              <CaretRight />
            </button>
          </div>
        </div>
        <div className="book-ribbons">
          {sections.map(([id, s], i) => (
            <button key={id} className={`book-ribbon ${current === id ? "active" : ""}`} style={{ "--i": i } as CSSProperties} onClick={() => go(s.spread)} title={s.name}>
              {s.name}
            </button>
          ))}
        </div>
        {pickedSticker && picked && <StickerInfo sticker={pickedSticker} on={picked.side === "left" ? "right" : "left"} onClose={() => setPicked(null)} />}
      </div>
      {bar ? createPortal(scrub, bar) : scrub}
    </div>
  );
}
