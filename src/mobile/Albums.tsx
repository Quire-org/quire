import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ArrowCounterClockwise, MagnifyingGlass, PaintBrush, SlidersHorizontal, Tag as TagIcon } from "@phosphor-icons/react";
import { albumArtistKey, useArtists } from "../artistsStore";
import { ArtistPicker } from "../components/ArtistPicker";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Modal } from "../components/Modal";
import { TagEditor } from "../components/TagPicker";
import { naturalCompare } from "../lib/format";
import { HOME_DEVICE } from "../lib/platform";
import { useScrollMemory } from "../lib/scrollMemory";
import type { Album } from "../lib/types";
import { AlbumCard } from "../screens/Albums";
import { albumPages, eachOnce, useStore } from "../store";
import { albumKeyOf, useTags } from "../tagsStore";
import { revertAll, useVersions } from "../versionsStore";
import { useColumns } from "./columns";
import { MobileTop } from "./TopBar";

type Order = "name" | "newest" | "rating";

/** The grid as the stylesheet has it (.m-album-grid), and how narrow a card goes whatever is chosen. */
const GAP = 8;
const CARD_MIN = 110;
/** Rows kept ready above and below the view. */
const OVERSCAN = 2;
const COLS_KEY = "quire.mobile.albumCols";
const COLS_DEFAULT = HOME_DEVICE === "tablet" ? 4 : 2;
const COLS_CHOICES = HOME_DEVICE === "tablet" ? [2, 3, 4, 5, 6] : [1, 2, 3];

/** The albums as covers to tap into: read, rated and tagged here; covers and everything else on the computer. */
export function MobileAlbums() {
  const albums = useStore((s) => s.albums);
  const loaded = useStore((s) => s.albumsLoaded);
  const loadAlbums = useStore((s) => s.loadAlbums);
  const library = useStore((s) => s.library);
  const root = useStore((s) => s.root);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [order, setOrder] = useState<Order>("name");
  const [cols, setCols] = useColumns(COLS_KEY, COLS_DEFAULT);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const [tagsFor, setTagsFor] = useState<Album | null>(null);
  const [artistFor, setArtistFor] = useState<Album | null>(null);

  useEffect(() => {
    if (!loaded) void loadAlbums();
  }, [loaded, loadAlbums, root]);
  useEffect(() => {
    void useTags.getState().load();
    void useArtists.getState().load();
    void useVersions.getState().load();
  }, [root]);
  const hasVersions = useVersions((v) => Object.keys(v.links).length > 0);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // A translated version is read from its original's card.
    const all = eachOnce(albums);
    const list = needle ? all.filter((a) => a.name.toLowerCase().includes(needle)) : all.slice();
    const ratings = library?.albumRatings ?? {};
    if (order === "name") return list.sort((a, b) => naturalCompare(a.name, b.name));
    if (order === "newest") return list.sort((a, b) => b.modified - a.modified);
    return list.sort((a, b) => (ratings[b.key] ?? 0) - (ratings[a.key] ?? 0) || naturalCompare(a.name, b.name));
  }, [albums, q, order, library?.albumRatings]);

  // Only the rows in and near the view are made: a library can hold thousands of albums.
  const grid = useRef<HTMLDivElement>(null);
  useScrollMemory("m-albums", grid, loaded);
  const [view, setView] = useState({ top: 0, h: 0, w: 0 });
  const [rowH, setRowH] = useState(270);
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => {
      const css = getComputedStyle(el);
      setView({ top: el.scrollTop, h: el.clientHeight, w: el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scrollRaf = useRef(0);
  const onScroll = () => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const el = grid.current;
      if (el) setView((v) => ({ ...v, top: el.scrollTop, h: el.clientHeight }));
    });
  };
  // As many across as chosen, unless the window (beside another app, say) has no room for them.
  const across = view.w ? Math.max(1, Math.min(cols, Math.floor((view.w + GAP) / (CARD_MIN + GAP)))) : cols;
  const stride = rowH + GAP;
  const rows = Math.ceil(shown.length / across);
  const firstRow = Math.max(0, Math.floor(view.top / stride) - OVERSCAN);
  const lastRow = Math.min(rows, Math.ceil((view.top + view.h) / stride) + OVERSCAN);
  const onScreen = shown.slice(firstRow * across, lastRow * across);
  const anyCards = onScreen.length > 0;
  useLayoutEffect(() => {
    const h = grid.current?.querySelector<HTMLElement>(".album-card")?.offsetHeight;
    if (h) setRowH(h);
  }, [across, view.w, anyCards]);

  const onMenu = (e: MouseEvent, a: Album) => {
    e.preventDefault();
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: <><TagIcon /> Tags</>, onClick: () => setTagsFor(a) },
        { label: <><PaintBrush /> Artist</>, onClick: () => setArtistFor(a) },
        ...(hasVersions && !a.pdf ? [{ label: <><ArrowCounterClockwise /> Revert edited pages</>, onClick: () => void revertAlbum(a) }] : []),
      ],
    });
  };
  /** The album's pages that were overwritten, back to the originals kept for them (in Activity). */
  const revertAlbum = async (a: Album) => {
    if (!root) return;
    const pages = await albumPages(root, a).catch(() => []);
    if ((await revertAll(pages, `${a.name}'s pages`)) > 0) void loadAlbums(true);
  };

  return (
    <div className="m-albums">
      <MobileTop current="albums">
        <button className={`m-icon ${searching ? "on" : ""}`} aria-label="Search" onClick={() => (searching && setQ(""), setSearching(!searching))}>
          <MagnifyingGlass />
        </button>
        <button className="m-icon" aria-label="Layout" onClick={() => setLayoutOpen(true)}>
          <SlidersHorizontal />
        </button>
      </MobileTop>
      {searching && (
        <div className="m-search">
          <input className="input" autoFocus type="search" autoCorrect="off" autoCapitalize="off" spellCheck={false} placeholder="Search albums" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="m-filters-row chips">
        {(["name", "newest", "rating"] as Order[]).map((o) => (
          <button key={o} className={`btn sm ${order === o ? "active" : ""}`} onClick={() => setOrder(o)}>
            {o}
          </button>
        ))}
        <span className="grow" />
        <span className="mono faint small">{shown.length}</span>
      </div>
      <div className="m-album-grid" ref={grid} onScroll={onScroll} style={{ gridTemplateColumns: `repeat(${across}, minmax(0, 1fr))` }}>
        {firstRow > 0 && <div className="album-grid-spacer" style={{ height: firstRow * stride - GAP }} />}
        {onScreen.map((a) => (
          <AlbumCard key={a.key} album={a} onMenu={onMenu} />
        ))}
        {lastRow < rows && <div className="album-grid-spacer" style={{ height: (rows - lastRow) * stride - GAP }} />}
        {!loaded && (
          <div className="m-empty">
            <p className="dim">Reading albums…</p>
          </div>
        )}
        {loaded && !shown.length && (
          <div className="m-empty">
            <p className="dim">{q ? "No album is called that." : "No albums yet: album folders are set on your computer."}</p>
          </div>
        )}
      </div>
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
      {layoutOpen && (
        <Modal title="Layout" onClose={() => setLayoutOpen(false)}>
          <div className="label">Across</div>
          <div className="chips">
            {COLS_CHOICES.map((n) => (
              <button key={n} className={`btn sm ${cols === n ? "active" : ""}`} onClick={() => setCols(n)}>
                {n}
              </button>
            ))}
          </div>
        </Modal>
      )}
      {tagsFor && (
        <Modal title={`Tags of ${tagsFor.name}`} onClose={() => setTagsFor(null)}>
          <TagEditor keys={[albumKeyOf(tagsFor.key)]} />
        </Modal>
      )}
      {artistFor && (
        <Modal title={`Artist of ${artistFor.name}`} onClose={() => setArtistFor(null)}>
          <ArtistPicker keys={[albumArtistKey(artistFor.key)]} />
        </Modal>
      )}
    </div>
  );
}
