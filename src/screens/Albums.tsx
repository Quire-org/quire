import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { TopNav, SideToggle } from "../components/TopNav";
import { ArrowCounterClockwise, BookOpen, Check, FolderPlus, Info, MagnifyingGlass, PaintBrush, Play, SlidersHorizontal, Star, Tag as TagIcon, Translate, Trash, X } from "@phosphor-icons/react";
import { useScrapbook } from "../scrapbook/store";
import { useCoverUrl } from "../scrapbook/pictures";
import { ArtistPicker } from "../components/ArtistPicker";
import { albumArtistKey, useArtists } from "../artistsStore";
import { ChoiceFilter, FiltersButton, FiltersPanel, PickFilter, RatingFilter, pickChips, ratingChips, useArtistOptions, usePeopleKeys, usePeopleOptions, type Filter } from "../components/Filters";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Thumb } from "../components/Thumb";
import { TagEditor } from "../components/TagPicker";
import { TagFilter, matchesTagQuery } from "../components/TagFilter";
import { AlbumChooser } from "../components/AlbumChooser";
import { useTags, albumKeyOf } from "../tagsStore";
import type { AlbumGuess } from "../lib/types";
import { LANGS, guessLanguage } from "../lib/language";
import { Flag } from "../components/Flag";
import { Modal } from "../components/Modal";
import { OptionRow } from "../components/OptionRow";
import { PluginIcon } from "../components/PluginButtons";
import { usePlugins } from "../plugins/store";
import { clickButton } from "../plugins/host";
import { albumPages, eachOnce, followMoves, originalOf, useStore, type AlbumFilters } from "../store";
import { revertAll, useVersions } from "../versionsStore";
import { useScrollMemory } from "../lib/scrollMemory";
import { useRef as useScrollRef } from "react";
import { api, mediaUrl, rawPreviewUrl, canThumb, storedPath, thumbUrl } from "../lib/api";
import { notForAlbums, pickLibraryFolder } from "../components/FolderBrowser";
import { videoPoster } from "../lib/poster";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { formatBytes, formatDate, shuffled, naturalCompare } from "../lib/format";
import type { Album, AlbumRename, ItemSource } from "../lib/types";
import { versionPairs } from "../lib/versions";
import { VersionsReview } from "../components/VersionsReview";
import { FitImage } from "../components/FitImage";
import { steppedJob } from "../lib/jobs";
import { ask } from "../components/Confirm";

type KindSel = "all" | "photos" | "videos" | "mixed";
type SortSel = "name" | "date" | "size" | "count" | "rating";

// The grid as the stylesheet lays it out (.album-grid): its padding and the gap between cards, which
// the windowing needs to place the rows where the browser would. A card's height is measured once
// one is on show; until then the size the stylesheet reserves for a card off screen.
const GRID_PAD = 16;
const GRID_GAP = 14;
const CARD_H = 320;
/** Rows rendered above and below the view, so a scroll by a little never shows a gap. */
const OVERSCAN = 2;

/** Album folders: rated, categorised and opened as a whole. */
/**
 * An album's language, in its right-click menu; with a translated version, that one's too (it has no
 * card of its own to set it on): read live, so a pick shows at once.
 */
/** Plugins' buttons for an album, as entries of its right-click menu (a separator before them). */
function pluginItems(a: Album): MenuItem[] {
  const buttons = usePlugins.getState().buttons.filter((b) => b.location === "album.card");
  if (!buttons.length) return [];
  return [
    { separator: true },
    ...buttons.map((b) => ({
      label: (
        <>
          <PluginIcon svg={b.icon} /> {b.label}
          {b.active && <Check />}
        </>
      ),
      disabled: b.busy,
      onClick: () => clickButton(b, { album: { key: a.key, name: a.name, count: a.count } }),
    })),
  ];
}

/** How sure the tagger must be that a PDF's pages are a comic for it to be offered as one first. */
const COMIC_SURE = 0.5;

export function LanguageRows({ album, translation, onPick }: { album: string; translation?: string; onPick: (key: string, code: string | null) => void }) {
  const langs = useStore((x) => x.library?.albumLanguages);
  const albums = useStore((x) => x.albums);
  const other = translation ? albums.find((x) => x.key === translation) : undefined;
  const rows: [string, string][] = translation ? [[album, "Original"], [translation, other ? `Translated: ${other.name}` : "Translated"]] : [[album, "Language"]];
  return (
    <div className="lang-pick">
      {rows.map(([key, label]) => (
        <div key={key} className="lang-row">
          <span className="label ellipsis" title={label}>
            {label}
          </span>
          <div className="chips">
            {LANGS.map((l) => (
              <button key={l.code} className={`chip ${langs?.[key] === l.code ? "active" : ""}`} title={l.name} onClick={() => onPick(key, langs?.[key] === l.code ? null : l.code)}>
                <Flag code={l.code} size={18} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Albums() {
  const s = useStore(useShallow((x) => ({ addAlbumRoot: x.addAlbumRoot, albumFilters: x.albumFilters, albumRenamePlan: x.albumRenamePlan, albums: x.albums, albumsLoaded: x.albumsLoaded, allItems: x.allItems, applyAlbumRenames: x.applyAlbumRenames, backupOpen: x.backupOpen, busy: x.busy, driveOpen: x.driveOpen, library: x.library, loadAlbums: x.loadAlbums, loadAll: x.loadAll, openAlbum: x.openAlbum, openAlbums_Slideshow: x.openAlbums_Slideshow, openBrowse: x.openBrowse, openDupes: x.openDupes, openFiles: x.openFiles, openSortQueue: x.openSortQueue, openTags: x.openTags, pluginsOpen: x.pluginsOpen, removeAlbumRoot: x.removeAlbumRoot, root: x.root, saveLibrary: x.saveLibrary, set: x.set, setAlbumFilters: x.setAlbumFilters, setAutoDecodeAlbumNames: x.setAutoDecodeAlbumNames, setTranslation: x.setTranslation, settingsOpen: x.settingsOpen, sideCollapsed: x.sideCollapsed, toast: x.toast, toggleChrome: x.toggleChrome, trashOpen: x.trashOpen, vaultOpen: x.vaultOpen })));
  const mainRef = useScrollRef<HTMLElement>(null);
  useScrollMemory("albums", mainRef, true);
  const roots = s.library?.albumRoots ?? [];
  const albumRatings = s.library?.albumRatings ?? {};
  const [plan, setPlan] = useState<AlbumRename[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [guesses, setGuesses] = useState<AlbumGuess[] | null>(null);
  // How surely the tagger takes each PDF offered for a comic (0–1; null: it couldn't tell).
  const [comic, setComic] = useState<Record<string, number | null>>({});
  const [guessing, setGuessing] = useState(false);
  const [guessRoot, setGuessRoot] = useState<string>("");
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const [tagsFor, setTagsFor] = useState<Album | null>(null);
  const [artistFor, setArtistFor] = useState<Album | null>(null);
  const [translateFor, setTranslateFor] = useState<Album | null>(null);
  const tagData = useTags((t) => t.data);
  useEffect(() => {
    void useTags.getState().load();
  }, []);

  // Languages: a flag on each card, half and half with a translated version.
  const setLanguages = (patch: Record<string, string | null>) => {
    const lib = useStore.getState().library;
    if (!lib) return;
    const albumLanguages = { ...(lib.albumLanguages ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v) albumLanguages[k] = v;
      else delete albumLanguages[k];
    }
    s.set({ library: { ...lib, albumLanguages } });
    void s.saveLibrary();
  };
  const [langBusy, setLangBusy] = useState(false);
  const autoLanguages = async (all: boolean) => {
    setLangBusy(true);
    await useTags.getState().load();
    if (!useStore.getState().allItems.length) await s.loadAll();
    const known = s.library?.albumLanguages ?? {};
    const patch: Record<string, string | null> = {};
    let unsure = 0;
    const todo = s.albums.filter((a) => all || !known[a.key]);
    const { job, gate } = steppedJob({ title: "Reading album languages", source: "Albums", total: todo.length });
    try {
      for (const [n, a] of todo.entries()) {
        if (!(await gate.pass())) break;
        job.update({ done: n, detail: a.name, items: a.cover ? [{ key: a.cover.key, name: a.name }] : [] });
        const code = await guessLanguage(a.key, a.name);
        if (code) patch[a.key] = code;
        else unsure++;
      }
    } finally {
      job.finish();
    }
    setLanguages(patch);
    setLangBusy(false);
    s.toast(`${Object.keys(patch).length} album${Object.keys(patch).length === 1 ? "" : "s"} given a language${unsure ? `, ${unsure} unsure (right-click one to set it)` : ""}`, "ok");
  };

  const resolveDir = (r: string) => (r.startsWith("/") ? r : `${s.root}/${r}`);
  const hasVersions = useVersions((v) => Object.keys(v.links).length > 0);
  useEffect(() => void useVersions.getState().load(), [s.root]);
  /** The album's pages that were overwritten, back to the originals kept for them (in Activity). */
  const revertAlbum = async (a: Album) => {
    if (!s.root) return;
    const pages = await albumPages(s.root, a).catch(() => []);
    if ((await revertAll(pages, `${a.name}'s pages`)) > 0) void s.loadAlbums(true);
  };
  const trashAlbum = async (a: Album) => {
    if (!s.root || !s.library) return;
    const sure = await ask({
      title: "Move album to the trash?",
      message: (
        <>
          <b>{a.name}</b> and its {a.count} file{a.count === 1 ? "" : "s"} go to the trash folder. You can restore them from there.
        </>
      ),
      confirm: "Move to trash",
      danger: true,
    });
    if (!sure) return;
    try {
      const [moved] = await api.fsMove(s.root, [a.path], resolveDir(s.library.trashDir));
      // The album's rating, tags, language, cover and translation link go with it into the trash, and
      // where it came from is noted, so Restore brings the album back whole.
      const trashKey = storedPath(s.root, moved);
      followMoves([[a.key, trashKey]]);
      const lib = useStore.getState().library!;
      useStore.setState({ library: { ...lib, trashFrom: { ...(lib.trashFrom ?? {}), [trashKey]: a.key } } });
      void useStore.getState().saveLibrary();
      s.toast(`${a.name} moved to the trash`, "warn");
      s.set({ allStale: true, albumsLoaded: false });
    } catch (e) {
      s.toast(String(e), "error");
    }
  };
  const setTranslation = (a: Album, other: Album | null) => {
    s.setTranslation(a.key, other?.key ?? null);
    s.toast(other ? `${a.name} reads translated as ${other.name}` : `${a.name} is translated on the fly again`, "ok");
  };
  // One handler for every card, so a memoised card doesn't redraw just because this screen did.
  const menuRef = useRef<(e: React.MouseEvent, a: Album) => void>(() => {});
  const onCardMenu = useCallback((e: React.MouseEvent, a: Album) => menuRef.current(e, a), []);
  const albumMenu = (e: React.MouseEvent, a: Album) => {
    e.preventDefault();
    const translation = s.library?.albumTranslations?.[a.key];
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: <><Play /> Open</>, onClick: () => void s.openAlbum(a) },
        { label: <><Info /> Info</>, onClick: () => s.set({ infoAlbum: a }) },
        { label: <><TagIcon /> Tags…</>, onClick: () => setTagsFor(a) },
        { label: <><PaintBrush /> Artist…</>, onClick: () => setArtistFor(a) },
        { label: <><BookOpen /> {s.library?.albumCovers?.[a.key] ? "Edit the scrapbook cover…" : "Make a scrapbook cover…"}</>, onClick: () => void useScrapbook.getState().open({ kind: "album", key: a.key, name: a.name }) },
        ...(s.library?.albumCovers?.[a.key] ? [{ label: <><X /> Remove the scrapbook cover</>, onClick: () => void useScrapbook.getState().removeCover({ kind: "album", key: a.key, name: a.name }) }] : []),
        { label: <><Translate /> {translation ? "Change the translated album…" : "Set the translated album…"}</>, onClick: () => setTranslateFor(a) },
        {
          content: (
            <LanguageRows
              album={a.key}
              translation={translation}
              onPick={(key, code) => {
                setLanguages({ [key]: code });
                if (!translation) setMenu(null);
              }}
            />
          ),
        },
        // What plugins add for an album (here, not on the card, where there's no room for it).
        ...pluginItems(a),
        // Once anything has been overwritten by an edit or a plugin: its pages back as they were.
        ...(hasVersions && !a.pdf ? [{ separator: true }, { label: <><ArrowCounterClockwise /> Revert edited pages</>, onClick: () => void revertAlbum(a) }] : []),
        { separator: true },
        { label: <><Trash /> Move to trash</>, danger: true, onClick: () => void trashAlbum(a) },
      ],
    });
  };
  menuRef.current = albumMenu;
  const findAlbums = async () => {
    if (!s.root || !s.library) return;
    setGuessing(true);
    try {
      const list = await api.albumsSuggest(s.root, s.library);
      setGuesses(list);
      setComic({});
      if (!guessRoot && roots[0]) setGuessRoot(roots[0]);
      if (!list.length) s.toast("No folder outside the album folders looks like an album", "ok");
      void checkComics(list.filter((g) => g.ext === "pdf"));
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setGuessing(false);
    }
  };
  /** The tagger looks at each PDF's first pages, in Activity: one it takes for a comic comes first. */
  const checkComics = async (pdfs: AlbumGuess[]) => {
    const t = useTags.getState();
    const m = t.models?.tagger ? t.models : t.target;
    const root = s.root;
    if (!pdfs.length || !m?.tagger || !root) return;
    const { job, gate } = steppedJob({ title: `Looking at ${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"} for comics`, source: "Albums", total: pdfs.length });
    try {
      for (const [i, g] of pdfs.entries()) {
        if (!(await gate.pass())) break;
        job.update({ done: i, total: pdfs.length, items: [{ key: g.path, name: g.name }] });
        const p = await api.pdfComic(root, g.path, m.embedder, m.tagger).catch(() => null);
        setComic((c) => ({ ...c, [g.path]: p }));
      }
    } finally {
      job.finish();
    }
  };
  // Folders first (their numbered pages say album already), then PDFs, the likeliest comic first.
  const ranked = useMemo(() => {
    const score = (g: AlbumGuess) => (g.ext !== "pdf" ? 2 : (comic[g.path] ?? 0.5));
    return guesses ? [...guesses].sort((a, b) => score(b) - score(a)) : null;
  }, [guesses, comic]);
  const comicNote = (g: AlbumGuess) => {
    if (!(g.path in comic)) return "looking…";
    const p = comic[g.path];
    if (p == null) return "couldn't look";
    return p >= COMIC_SURE ? `looks like a comic (${Math.round(p * 100)}%)` : "doesn't look like a comic";
  };
  const adoptGuess = async (g: AlbumGuess) => {
    if (!s.root) return;
    const dest = resolveDir(guessRoot || roots[0]);
    try {
      const went = await api.fsMove(s.root, [g.path], dest);
      // What is kept of its pictures (ratings, tags, faces…) goes with the folder.
      useStore.getState().relocatePaths([[g.path, went[0]]]);
      setGuesses((list) => (list ?? []).filter((x) => x.path !== g.path));
      s.set({ allStale: true, albumsLoaded: false });
      s.toast(`${g.name} is an album now`, "ok");
    } catch (e) {
      s.toast(String(e), "error");
    }
  };
  const f = s.albumFilters;
  const setF = s.setAlbumFilters;
  const { query, rootSel, kind, minRating, unratedOnly, sortBy, desc, random, zoom, tags = [], tagsMode = "or", tagsOut = [], tagsOutMode = "or", artists: artistsSel = [], people: peopleSel = [] } = f;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const artistOptions = useArtistOptions();
  const peopleOptions = usePeopleOptions();
  const peopleKeys = usePeopleKeys();
  const artistsDoc = useArtists((a) => a.doc);
  // Who is in each album: the people with a face on one of its pages.
  const albumPeople = useMemo(() => {
    const albumOf = new Map(s.allItems.filter((i) => i.albumKey).map((i) => [i.key, originalOf(i.albumKey!)]));
    const out = new Map<string, Set<string>>();
    for (const [p, keys] of peopleKeys)
      for (const k of keys) {
        const a = albumOf.get(k) ?? (k.includes(".pdf#") ? originalOf(k.slice(0, k.lastIndexOf("#"))) : undefined);
        if (a) out.set(a, (out.get(a) ?? new Set()).add(p));
      }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.allItems, peopleKeys, s.library?.albumTranslations]);
  const [seed, setSeed] = useState(0);
  const toggleRandom = () => {
    setF({ random: !useStore.getState().albumFilters.random });
    setSeed((x) => x + 1);
  };

  const checkNames = async () => {
    setChecking(true);
    const p = await s.albumRenamePlan();
    setPlan(p);
    setChecking(false);
    if (p.length === 0) s.toast("No URL-encoded album names found", "ok");
    else setAdvanced(false); // the plan shows above the grid
  };

  useEffect(() => {
    void s.loadAlbums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, s.albumsLoaded]);

  const albums = useMemo(() => {
    // A translated version is read from its original's card (the viewer switches between them), so it has no card of its own.
    let list = eachOnce(s.albums);
    if (rootSel !== "all") list = list.filter((a) => a.albumRoot === rootSel);
    if (kind === "photos") list = list.filter((a) => a.videos === 0 && a.images > 0);
    else if (kind === "videos") list = list.filter((a) => a.videos > 0);
    else if (kind === "mixed") list = list.filter((a) => a.videos > 0 && a.images > 0);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((a) => a.name.toLowerCase().includes(q) || a.key.toLowerCase().includes(q));
    }
    if (tags.length || tagsOut.length) {
      // An album carries its own tags and whatever its pages carry.
      const pageTags = new Map<string, Set<string>>();
      for (const it of s.allItems) {
        if (!it.albumKey || !tagData?.tags[it.key]?.length) continue;
        const ak = originalOf(it.albumKey);
        const set = pageTags.get(ak) ?? new Set<string>();
        for (const id of tagData.tags[it.key]) set.add(id);
        pageTags.set(ak, set);
      }
      const q = { tags, tagsMode, tagsOut, tagsOutMode };
      list = list.filter((a) => matchesTagQuery([...(tagData?.tags[albumKeyOf(a.key)] ?? []), ...(pageTags.get(a.key) ?? [])], q, tagData?.bundles ?? {}));
    }
    if (unratedOnly) list = list.filter((a) => albumRatings[a.key] == null);
    else if (minRating > 0) list = list.filter((a) => (albumRatings[a.key] ?? 0) >= minRating);
    if (artistsSel.length) list = list.filter((a) => (artistsDoc?.items[albumArtistKey(a.key)] ?? []).some((id) => artistsSel.includes(id)));
    if (peopleSel.length) list = list.filter((a) => peopleSel.some((p) => albumPeople.get(a.key)?.has(p)));
    if (random) return shuffled(list);
    const cmp: Record<SortSel, (a: Album, b: Album) => number> = {
      name: (a, b) => naturalCompare(a.name, b.name),
      date: (a, b) => a.modified - b.modified,
      size: (a, b) => a.bytes - b.bytes,
      count: (a, b) => a.count - b.count,
      rating: (a, b) => (albumRatings[a.key] ?? 0) - (albumRatings[b.key] ?? 0) || a.name.localeCompare(b.name),
    };
    const out = list.slice().sort(cmp[sortBy]);
    return desc ? out.reverse() : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.albums, s.allItems, rootSel, kind, query, albumRatings, minRating, unratedOnly, random, seed, sortBy, desc, tags, tagsMode, tagsOut, tagsOutMode, tagData, s.library?.albumTranslations, artistsSel, peopleSel, artistsDoc, albumPeople]);

  // Only the rows in and near the view are rendered, a spacer standing in for the rest above and
  // below: a library can hold thousands of albums, and a card each (an observer and a cover apiece)
  // made the grid slow to open and to filter. The grid scrolls itself; its width and the tile size
  // give the columns, as the browser's auto-fill does, and a card on show gives the row height.
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridView, setGridView] = useState({ top: 0, h: 0, w: 0 });
  const [rowH, setRowH] = useState(CARD_H);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setGridView({ top: el.scrollTop, h: el.clientHeight, w: el.clientWidth - GRID_PAD * 2 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scrollRaf = useRef(0);
  const onGridScroll = () => {
    if (scrollRaf.current) return;
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0;
      const el = gridRef.current;
      if (el) setGridView((v) => ({ ...v, top: el.scrollTop, h: el.clientHeight }));
    });
  };
  const cols = Math.max(1, Math.floor((gridView.w + GRID_GAP) / (zoom + GRID_GAP)));
  const stride = rowH + GRID_GAP;
  const rows = Math.ceil(albums.length / cols);
  const firstRow = Math.max(0, Math.floor(gridView.top / stride) - OVERSCAN);
  const lastRow = Math.min(rows, Math.ceil((gridView.top + gridView.h) / stride) + OVERSCAN);
  const shown = albums.slice(firstRow * cols, lastRow * cols);
  // The row height from a card on show (each is laid out: only the rows near the view are there),
  // before the frame paints, once cards are there and as the tile size or the width changes. Not as
  // the rows shown change: a new height changes which rows those are, which mustn't measure again
  // (that fed itself until React gave up). A height only going back to the one before it, at the
  // same size and columns, isn't taken either: that is a measurement flipping, not a change.
  const measured = useRef({ at: "", before: 0 });
  const hasCards = shown.length > 0;
  useLayoutEffect(() => {
    const h = gridRef.current?.querySelector<HTMLElement>(".album-card")?.offsetHeight;
    if (!h || Math.abs(h - rowH) <= 1) return;
    const at = `${zoom}:${cols}`;
    if (measured.current.at === at && Math.abs(h - measured.current.before) <= 1) return;
    measured.current = { at, before: rowH };
    setRowH(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCards, cols, zoom, gridView.w]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || dialogOpen() || s.settingsOpen || s.trashOpen || s.driveOpen || s.backupOpen || s.vaultOpen || s.pluginsOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "a") s.openSortQueue();
      if (key === "b") s.openBrowse();
      if (key === "d") s.openDupes();
      if (key === "g") s.set({ settingsOpen: true });
      if (key === "e") s.openFiles();
      if (key === "l") s.openTags();
      if (key === "k") useStore.getState().openScrapbook();
      if (key === "p") useStore.getState().openPeople();
      if (key === "w") useStore.getState().openArtists();
      if (key === "h") s.toggleChrome();
      if (key === "s") toggleRandom();
      if (key === "enter" && albums.length) void s.openAlbums_Slideshow(albums);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s, albums]);

  const addRoot = async () => {
    const dir = await pickLibraryFolder({ title: "Choose a folder whose subfolders are albums", outside: true, why: notForAlbums(s.library, s.root ?? "") });
    if (dir) s.addAlbumRoot(dir);
  };
  // One work in two languages, by where they came from: offered to be linked.
  const versions = useMemo(() => {
    const lib = s.library;
    if (!lib?.sources) return [];
    const sourceOf = new Map<string, ItemSource>();
    for (const it of s.allItems) if (it.albumKey && lib.sources[it.key] && !sourceOf.has(it.albumKey)) sourceOf.set(it.albumKey, lib.sources[it.key]);
    const linked = new Set(Object.entries(lib.albumTranslations ?? {}).flat());
    return versionPairs(s.albums, (k) => sourceOf.get(k), (k) => lib.albumLanguages?.[k], linked, new Set(lib.albumNotVersions ?? []));
  }, [s.albums, s.allItems, s.library]);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    if (!versions.length) setReviewing(false);
  }, [versions.length]);
  const chip = (active: boolean) => `btn sm ${active ? "active" : ""}`;
  const totalBytes = albums.reduce((a, b) => a + b.bytes, 0);

  // The filters, as every screen shows them: a section each in the panel, chips for what is on.
  const filtersOff: Partial<AlbumFilters> = { rootSel: "all", kind: "all", minRating: 0, unratedOnly: false, tags: [], tagsMode: "or", tagsOut: [], tagsOutMode: "or", artists: [], people: [] };
  const tagName = (id: string) => id.slice(id.lastIndexOf("/") + 1);
  const rootName = (r: string) => r.split("/").pop() || r;
  const filters: Filter[] = [
    {
      id: "folder",
      label: "Album folder",
      chips: rootSel === "all" ? [] : [{ key: rootSel, label: rootName(rootSel), title: rootSel, remove: () => setF({ rootSel: "all" }) }],
      body: (
        <>
          {roots.length > 1 && <ChoiceFilter value={rootSel} onChange={(v) => setF({ rootSel: v })} options={[{ value: "all", label: "All", count: s.albums.length }, ...roots.map((r) => ({ value: r, label: rootName(r), title: r, count: s.albums.filter((a) => a.albumRoot === r).length }))]} />}
          {roots.length === 1 && <div className="dim small mono ellipsis" title={roots[0]}>{roots[0]}</div>}
          <button className="btn sm" onClick={() => void addRoot()} title="Another folder whose subfolders (and PDFs) are albums; Settings → Folders lists them">
            <FolderPlus /> Add album folder
          </button>
        </>
      ),
    },
    {
      id: "tags",
      label: "Tags",
      chips: [
        ...tags.map((id) => ({ key: `in:${id}`, label: `#${tagName(id)}`, title: id, remove: () => setF({ tags: tags.filter((x) => x !== id) }) })),
        ...tagsOut.map((id) => ({ key: `out:${id}`, label: `not #${tagName(id)}`, title: id, remove: () => setF({ tagsOut: tagsOut.filter((x) => x !== id) }) })),
      ],
      body: <TagFilter value={{ tags, tagsMode, tagsOut, tagsOutMode }} onChange={(patch) => setF(patch)} />,
    },
    {
      id: "contains",
      label: "Contains",
      chips: kind === "all" ? [] : [{ key: kind, label: { photos: "Photos only", videos: "Videos", mixed: "Photos and videos" }[kind as Exclude<KindSel, "all">], remove: () => setF({ kind: "all" }) }],
      body: <ChoiceFilter value={kind} onChange={(k) => setF({ kind: k })} options={(["all", "photos", "videos", "mixed"] as KindSel[]).map((k) => ({ value: k, label: k === "all" ? "Any" : k === "photos" ? "Photos only" : k === "videos" ? "Videos" : "Both" }))} />,
    },
    { id: "rating", label: "Rating", chips: ratingChips(minRating, unratedOnly, () => setF({ minRating: 0, unratedOnly: false })), body: <RatingFilter min={minRating} unrated={unratedOnly} onChange={setF} /> },
    { id: "artists", label: "Artists", chips: pickChips(artistsSel, artistOptions, (ids) => setF({ artists: ids })), body: <PickFilter picked={artistsSel} options={artistOptions} onChange={(ids) => setF({ artists: ids })} placeholder="Find an artist" empty="No artists yet: give albums one (right-click, Artist…)." /> },
    { id: "people", label: "People", chips: pickChips(peopleSel, peopleOptions, (ids) => setF({ people: ids })), body: <PickFilter picked={peopleSel} options={peopleOptions} onChange={(ids) => setF({ people: ids })} placeholder="Find a person or character" empty="No one named yet: name faces in People." /> },
  ];

  return (
    <div className={`screen ${s.sideCollapsed ? "chrome-hidden" : ""}`}>
      <TopNav current="albums" />
      <SideToggle />
    <div className="browse albums">
      <aside className="browse-side panel">
        <input className="input" placeholder="Search albums…" value={query} onChange={(e) => setF({ query: e.target.value })} />
        <FiltersButton filters={filters} open={filtersOpen} onToggle={() => setFiltersOpen(!filtersOpen)} onClear={() => setF(filtersOff)} />

        <div className="label">Order</div>
        <div className="chips">
          {(["name", "date", "size", "count", "rating"] as SortSel[]).map((k) => (
            <button
              key={k}
              className={chip(!random && sortBy === k)}
              onClick={() => setF({ sortBy: k, desc: sortBy === k && !random ? !desc : desc, random: false })}
            >
              {k} {!random && sortBy === k ? (desc ? "↓" : "↑") : ""}
            </button>
          ))}
          <button
            className={chip(random)}
            onClick={() => {
              setF({ random: true });
              setSeed((x) => x + 1);
            }}
          >
            Random <kbd className="kbd">S</kbd>
          </button>
        </div>

        <div className="label">Tile size</div>
        <div className="side-row">
          <input type="range" min={180} max={520} step={20} value={zoom} onChange={(e) => setF({ zoom: Number(e.target.value) })} />
        </div>

        <hr className="rule" />
        <button className="btn primary" disabled={!albums.length || s.busy} onClick={() => void s.openAlbums_Slideshow(albums)} title="Flip through everything in the visible albums">
          <Play /> Slideshow <kbd className="kbd">⏎</kbd>
        </button>
        <p className="dim small">Open an album to rate it as a whole.</p>

        <button className="btn sm ghost advanced-btn" onClick={() => setAdvanced(true)}>
          <SlidersHorizontal /> Advanced…
        </button>
      </aside>
      <main className="browse-main" ref={mainRef}>
        <div className="browse-head">
          <span className="mono dim">
            {albums.length} of {s.albums.length} albums · {formatBytes(totalBytes)}
          </span>
        </div>
        {versions.length > 0 && (
          <div className="album-versions-note">
            <Translate />
            <span className="grow">
              {versions.length === 1 ? "An album looks like" : `${versions.length} albums look like`} another language of one you have.
            </span>
            <button className="btn sm" onClick={() => setReviewing(true)}>
              Review
            </button>
          </div>
        )}
        {reviewing && <VersionsReview pairs={versions} onClose={() => setReviewing(false)} />}
        {advanced && (
          <Modal title="Advanced" onClose={() => setAdvanced(false)} wide>
            <OptionRow
              title="Decode URL-escaped folder names"
              info={
                <>
                  Some tools write folder names with URL escapes, so <span className="mono">Z%C3%BCrich%20Trip</span> is really{" "}
                  <span className="mono">Zürich Trip</span>. Checking shows every planned rename first; nothing changes until you confirm. Album
                  ratings follow the renamed folders.
                </>
              }
              toggle={{ on: !!s.library?.autoDecodeAlbumNames, label: "automatic on scan", onChange: (v) => s.setAutoDecodeAlbumNames(v) }}
              action={{
                label: checking ? "Checking…" : "Check now",
                disabled: checking,
                onClick: () => {
                  if (roots.length === 0) s.toast("Add an album folder first", "warn");
                  else void checkNames();
                },
              }}
            />
                      <div className="option-bar">
              <div className="option-head">
                <strong>Folders that look like albums</strong>
                <span className="dim small">
                  Folders outside the album folders whose files are numbered pages of one type (1.jpg, 2.jpg …), and PDFs, the ones the tagger takes for comics first. Adding one moves it into an album folder.
                </span>
              </div>
              <div className="row">
                {roots.length > 1 && (
                  <select className="input" value={guessRoot || roots[0]} onChange={(e) => setGuessRoot(e.target.value)} title="Which album folder they move into">
                    {roots.map((r) => (
                      <option key={r} value={r}>
                        {r.split("/").pop() || r}
                      </option>
                    ))}
                  </select>
                )}
                <button className="btn sm" disabled={guessing} onClick={() => (roots.length ? void findAlbums() : s.toast("Add an album folder first", "warn"))}>
                  <MagnifyingGlass /> {guessing ? "Looking…" : "Look for them"}
                </button>
              </div>
              {ranked && ranked.length > 0 && (
                <div className="guess-list">
                  {ranked.map((g) => (
                    <div key={g.path} className="guess-row">
                      <div className="guess-covers">
                        {g.first.map((it) => (
                          <span key={it.key} className="guess-thumb">
                            <Thumb item={it} eager aspect={1} onClick={() => {}} />
                          </span>
                        ))}
                      </div>
                      <div className="grow">
                        <div className="ellipsis" title={g.path}>
                          {g.name}
                        </div>
                        <div className="dim small mono">
                          {g.count} pages · {g.ext === "pdf" ? `PDF, ${comicNote(g)}` : g.ext} · {g.path.slice((s.root ?? "").length) || "/"}
                        </div>
                      </div>
                      <button className="btn sm primary" onClick={() => void adoptGuess(g)}>
                        Add as album
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {guesses && !guesses.length && <div className="dim small">Nothing found.</div>}
            </div>
              <div className="option-bar">
                <div className="option-head">
                  <strong>Album languages</strong>
                  <span className="dim small">
                    Each album's language from a language named in its folder name ([English], 中国翻訳 …), else from what its pages show (the pages need to be in the tag index), else from the script its name is written in. It shows as a flag on the album; an album with a translated version shows both, half and half. Right-click an album to set its language by hand.
                  </span>
                </div>
                <div className="row">
                  <button className="btn sm primary" disabled={langBusy} onClick={() => void autoLanguages(false)}>
                    {langBusy ? "Reading the albums…" : "Auto-assign languages"}
                  </button>
                  <button className="btn sm ghost" disabled={langBusy} onClick={() => void autoLanguages(true)} title="Guess again for every album, hand-set ones included">
                    Redo all
                  </button>
                </div>
              </div>
          </Modal>
        )}
        {plan && plan.length > 0 && (
          <section className="rename-plan panel">
            <div className="sec-head">
              <h3>Decode {plan.length} folder name{plan.length === 1 ? "" : "s"}</h3>
              <span className="row">
                <button
                  className="btn sm primary"
                  disabled={s.busy}
                  onClick={async () => {
                    await s.applyAlbumRenames(plan);
                    setPlan(null);
                  }}
                >
                  Rename all
                </button>
                <button className="btn sm ghost" onClick={() => setPlan(null)}>
                  Cancel
                </button>
              </span>
            </div>
            <div className="rename-list mono">
              {plan.map((r) => (
                <div key={r.from} className="rename-row">
                  <span className="dim ellipsis" title={r.from}>
                    {r.fromKey.split("/").pop()}
                  </span>
                  <span className="faint">→</span>
                  <span className="accent-text ellipsis" title={r.to}>
                    {r.toKey.split("/").pop()}
                  </span>
                  <button
                    className="btn sm ghost"
                    disabled={s.busy}
                    onClick={async () => {
                      await s.applyAlbumRenames([r]);
                      setPlan((p) => p?.filter((x) => x !== r) ?? null);
                    }}
                  >
                    Rename
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
        <div ref={gridRef} className="album-grid" onScroll={onGridScroll} style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))` }}>
          {firstRow > 0 && <div className="album-grid-spacer" style={{ height: firstRow * stride - GRID_GAP }} />}
          {shown.map((a) => (
            <AlbumCard key={a.key} album={a} onMenu={onCardMenu} />
          ))}
          {lastRow < rows && <div className="album-grid-spacer" style={{ height: (rows - lastRow) * stride - GRID_GAP }} />}
          {s.albumsLoaded && albums.length === 0 && (
            <div className="dim">
              {s.albums.length ? "No albums match these filters." : roots.length ? "No subfolders with media in the album folders." : "Add an album folder to get started."}
            </div>
          )}
        </div>
      </main>
      {filtersOpen && <FiltersPanel filters={filters} onClose={() => setFiltersOpen(false)} onClear={() => setF(filtersOff)} />}
    </div>
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
      {artistFor && (
        <Modal title={`Artist of ${artistFor.name}`} onClose={() => setArtistFor(null)}>
          <ArtistPicker keys={[albumArtistKey(artistFor.key)]} />
        </Modal>
      )}
      {tagsFor && (
        <Modal title={`Tags for ${tagsFor.name}`} onClose={() => setTagsFor(null)}>
          <TagEditor keys={[albumKeyOf(tagsFor.key)]} />
        </Modal>
      )}
      {translateFor && (
        <AlbumChooser
          title={`Read ${translateFor.name} translated as…`}
          except={translateFor.key}
          onPick={(other) => {
            setTranslation(translateFor, other);
            setTranslateFor(null);
          }}
          onClose={() => setTranslateFor(null)}
        />
      )}
    </div>
  );
}

const AlbumCard = memo(function AlbumCard({ album, onMenu }: { album: Album; onMenu: (e: React.MouseEvent, a: Album) => void }) {
  const s = useStore(useShallow((x) => ({ library: x.library, openAlbum: x.openAlbum })));
  const rating = s.library?.albumRatings[album.key];
  const [cover, setCover] = useState<string | null>(null);
  // The cover loads once the card comes near the screen, not all of them at once when the grid opens.
  const card = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = card.current;
    if (!el || near) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  // A scrapbook cover when it has one, already rendered; else its first page.
  const scrap = s.library?.albumCovers?.[album.key];
  const made = useCoverUrl(scrap, near);
  useEffect(() => {
    let alive = true;
    const c = album.cover;
    if (!c || !near || scrap) return;
    // A cover is a few hundred pixels wide: the backend's small copy, not the original.
    const root = useStore.getState().root;
    const p = root && canThumb(c) ? Promise.resolve(thumbUrl(root, c, 360)) : c.kind === "image" ? Promise.resolve(mediaUrl(c)) : c.kind === "raw" ? rawPreviewUrl(c.primary) : videoPoster(mediaUrl(c));
    p.then((u) => alive && setCover(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [album.cover, near, scrap]);

  return (
    <div ref={card} className="album-card panel" onContextMenu={(e) => onMenu(e, album)}>
      <div className="album-cover" onClick={() => void s.openAlbum(album)} title="Open album (right-click for more)">
        {made ? <img className="album-scrap" src={made} alt="" draggable={false} /> : cover && !scrap ? <FitImage src={cover} mode="fit" blurBackdrop /> : <div className="thumb-ph mono">{album.count ? "…" : "EMPTY"}</div>}
        {(() => {
          const translation = s.library?.albumTranslations?.[album.key];
          const langs = s.library?.albumLanguages ?? {};
          const mine = langs[album.key];
          const theirs = translation ? langs[translation] : undefined;
          if (!mine && !theirs) {
            return translation ? (
              <span className="badge album-translated" title="Has a translated version: switch in the viewer bar">
                <Translate />
              </span>
            ) : null;
          }
          if (translation && theirs !== mine) {
            return (
              <span className="album-flag">
                <Flag code={mine} other={theirs} size={24} corner />
              </span>
            );
          }
          return (
            <span className="album-flag">
              <Flag code={mine} size={24} corner />
            </span>
          );
        })()}
        <span className="badge accent2 album-count" title={album.pdf ? `A PDF of ${album.count} pages, ${formatBytes(album.bytes)}` : `${album.images} photos, ${album.videos} videos, ${formatBytes(album.bytes)}`}>
          {album.pdf && "PDF · "}
          {album.count}
        </span>
        {rating != null && (
          <span className="badge accent tile-rating">
            <Star /> {rating}
          </span>
        )}
        {/* Open, and no sort folders: an album stays in its album folder. */}
        <div className="album-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn sm" onClick={() => void s.openAlbum(album)}>
            Open
          </button>
        </div>
      </div>
      <div className="album-foot">
        <div className="album-name ellipsis" title={`${album.path}\n${formatDate(album.modified)}`}>
          {album.name}
        </div>
      </div>
    </div>
  );
});
