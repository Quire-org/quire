import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityButton } from "../components/Activity";
import { CastButton } from "../components/Cast";
import { useShallow } from "zustand/react/shallow";
import { useFind } from "../findStore";
import { PlatformIcon } from "../components/PlatformIcon";
import { useStore, originalOf, selectCurrent, selectRating } from "../store";
import { VersionSwitch } from "../components/VersionSwitch";
import { PageTurn } from "../components/PageTurn";
import { MediaStage, SPEEDS } from "../components/MediaStage";
import { ArrowCounterClockwise, ArrowLeft, Books, CaretDown, Info, Tag as TagIcon, CaretLeft, CaretRight, Copy, FolderOpen, GearSix, Pause, PencilSimple, Play, Question, Shuffle, Sparkle, SquaresFour, Trash, Scissors, BookOpen, UsersThree, PaintBrush, MagnifyingGlass } from "@phosphor-icons/react";
import { useScrapbook } from "../scrapbook/store";
import { Popover } from "../components/Popover";
import { ContextMenu } from "../components/ContextMenu";
import { PluginButtons } from "../components/PluginButtons";
import { SeriesStrip } from "../components/SeriesStrip";
import { FacesButton, FacesPanel } from "../components/FacesInPicture";
import { toggleFaceMode } from "../peopleStore";
import type { MediaItem, Target } from "../lib/types";
import { seriesCount, seriesIndex } from "../lib/series";
import { PluginPanel } from "../components/PluginPanel";
import { TagEditor } from "../components/TagPicker";
import { ArtistPicker } from "../components/ArtistPicker";
import { ArtistIcon } from "../components/ArtistIcon";
import { artistKeyOf, useArtists } from "../artistsStore";
import { albumKeyOf, useTags } from "../tagsStore";
import { directionFor, usePlugins } from "../plugins/store";
import { useFinders } from "../plugins/find";
import { BrandHome, LABEL } from "../components/TopNav";
import { Deco } from "../components/Deco";
import { RatingBar } from "../components/RatingBar";
import { EditStage } from "../components/EditStage";
import { EditBar } from "../components/EditBar";
import { Select } from "../components/Select";
import { TargetBar } from "../components/TargetBar";
import { OwnFolderPicker } from "../components/OwnFolderPicker";
import { bucketOf } from "../lib/filing";
import { mediaUrl } from "../lib/api";
import { notForTarget, pickLibraryFolder } from "../components/FolderBrowser";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { basename, ext, tailPath } from "../lib/format";

export function Viewer() {
  // Find's platforms, each with its own icon, as in the top bar; Back names the one Find shows.
  const finders = useFinders((f) => f.finders);
  const platforms = Object.values(finders);
  const findOn = useFind((f) => f.pluginId);
  const finderName = (findOn ? finders[findOn] : platforms[0])?.name;
  const s = useStore(useShallow((x) => ({ addTarget: x.addTarget, albums: x.albums, closeViewer: x.closeViewer, viewerBack: x.viewerBack, albumsLoaded: x.albumsLoaded, backupOpen: x.backupOpen, busy: x.busy, driveOpen: x.driveOpen, editItems: x.editItems, editMode: x.editMode, fitMode: x.fitMode, helpOpen: x.helpOpen, hudHidden: x.hudHidden, immersive: x.immersive, index: x.index, infoOpen: x.infoOpen, lastTargetParent: x.lastTargetParent, library: x.library, loadAlbums: x.loadAlbums, moveCurrent: x.moveCurrent, next: x.next, openAlbums: x.openAlbums, openBrowse: x.openBrowse, openDupes: x.openDupes, openEdit: x.openEdit, openFiles: x.openFiles, openTags: x.openTags, pluginsOpen: x.pluginsOpen, showInFiles: x.showInFiles, prev: x.prev, queue: x.queue, rescan: x.rescan, root: x.root, set: x.set, setAlbumRatingByKey: x.setAlbumRatingByKey, setRating: x.setRating, setSlideshowHideUi: x.setSlideshowHideUi, setSlideshowInterval: x.setSlideshowInterval, settingsOpen: x.settingsOpen, shuffle: x.shuffle, slideshow: x.slideshow, source: x.source, surprise: x.surprise, switchTranslation: x.switchTranslation, toggleShuffle: x.toggleShuffle, toggleSlideshow: x.toggleSlideshow, trashCurrent: x.trashCurrent, trashOpen: x.trashOpen, undo: x.undo, undoStack: x.undoStack, vaultOpen: x.vaultOpen })));
  const current = useStore(selectCurrent);
  const rating = useStore(selectRating);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [cursorHidden, setCursorHidden] = useState(false);
  const [menu, setMenu] = useState<"show" | "goto" | "tags" | "artist" | null>(null);
  // Right-click on the file's name or its folder: where it is, in Files.
  const [pathMenu, setPathMenu] = useState<{ x: number; y: number } | null>(null);
  const onPathMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setPathMenu({ x: e.clientX, y: e.clientY });
  };
  // ⇧ and a key (or ⇧-click) of a target that files by the day: which folder of yours in it.
  const [chooseIn, setChooseIn] = useState<Target | null>(null);
  const infoShown = useStore((x) => !!x.infoItem) && !s.editMode;
  // How many tags the item carries (an album page: its album's), kept up to date for the tag button.
  const tagCount = useTags((t) => (current ? (t.data?.tags[current.albumKey ? albumKeyOf(current.albumKey) : current.key]?.length ?? 0) : 0));
  // Its artists (an album page: the album's).
  const artistsDoc = useArtists((a) => a.doc);
  useEffect(() => void useArtists.getState().load(), [s.root]);
  const artistKey = current ? artistKeyOf(current) : null;
  const artistOf = artistKey ? artistsDoc?.artists[artistsDoc?.items[artistKey]?.[0] ?? ""] : undefined;
  useEffect(() => {
    void useTags.getState().load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root]);
  const targets = s.library?.targets ?? [];
  const album = current?.albumKey ? s.albums.find((a) => a.key === current.albumKey) : undefined;
  const albumKey = current?.albumKey;
  // A translated version's rating is its original's: the two are one album.
  const albumRating = albumKey ? s.library?.albumRatings[originalOf(albumKey)] : undefined;

  useEffect(() => {
    if (albumKey && !s.albumsLoaded) void s.loadAlbums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumKey]);

  // Remember what was looked at (after a moment, so flicking past does not count).
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => useStore.getState().recordView(current), 700);
    return () => clearTimeout(t);
  }, [current?.key]);

  // Immersive mode hides the cursor after a second of stillness.
  useEffect(() => {
    if (!s.immersive) {
      setCursorHidden(false);
      return;
    }
    let timer = setTimeout(() => setCursorHidden(true), 1000);
    const onMove = () => {
      setCursorHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorHidden(true), 1000);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", onMove);
    };
  }, [s.immersive]);

  // Slideshow: images advance after the interval, videos when they end.
  const show = s.slideshow;
  const modalOpen = s.settingsOpen || s.trashOpen || s.helpOpen || s.driveOpen || s.backupOpen || s.vaultOpen || s.pluginsOpen || s.editMode;
  useEffect(() => {
    if (!show.playing || !current || modalOpen) return;
    if (current.kind === "video") return; // handled by onEnded
    const t = setTimeout(() => useStore.getState().next(), show.interval * 1000);
    return () => clearTimeout(t);
  }, [show.playing, show.interval, current?.key, modalOpen, s.index]);

  const rate = (r: number | null) => {
    if (!current) return;
    if (albumKey) s.setAlbumRatingByKey(albumKey, r);
    else s.setRating(current, r);
  };
  const anyModal = s.settingsOpen || s.trashOpen || s.helpOpen || s.driveOpen || s.backupOpen || s.vaultOpen || s.pluginsOpen;
  usePlugins((ps) => ps.directions); // re-render when a plugin changes reading direction
  const rtl = directionFor(current?.albumKey) === "rtl";
  const [videoDuration, setVideoDuration] = useState(0);
  useEffect(() => {
    // Duration for the trim sliders: read it from the media element when a video is current.
    setVideoDuration(0);
    if (!current || current.kind !== "video") return;
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = mediaUrl(current);
    v.onloadedmetadata = () => setVideoDuration(isFinite(v.duration) ? v.duration : 0);
    return () => {
      v.removeAttribute("src");
      v.load();
    };
  }, [current?.key]);

  // Keep the stage clear of the HUD bars whatever their height (target buttons may wrap).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const top = el.querySelector<HTMLElement>(".hud-top");
    const bottom = el.querySelector<HTMLElement>(".hud-bottom");
    if (!top || !bottom) return;
    const apply = () => {
      el.style.setProperty("--hud-top-h", `${top.offsetHeight}px`);
      el.style.setProperty("--hud-bottom-h", `${bottom.offsetHeight}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(top);
    ro.observe(bottom);
    return () => ro.disconnect();
  }, [s.editMode]);

  const addTarget = useCallback(async () => {
    const dir = await pickLibraryFolder({ title: "Choose a target folder", start: s.lastTargetParent ?? s.root, outside: true, why: notForTarget(s.library, s.root ?? "") });
    if (dir) s.addTarget(dir);
  }, [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const st = useStore.getState();
      const cur = st.queue[st.index];

      if (key === "escape") {
        if (st.editMode) {
          st.leaveEdit();
        } else if (st.settingsOpen || st.trashOpen || st.helpOpen || st.infoOpen || st.driveOpen || st.backupOpen || st.vaultOpen || st.pluginsOpen) {
          st.set({ settingsOpen: false, trashOpen: false, helpOpen: false, infoOpen: false, driveOpen: false, backupOpen: false, vaultOpen: false, pluginsOpen: false });
        } else if (usePlugins.getState().panelOpen) {
          // A plugin's panel (a tool of Edit) closes first.
          usePlugins.getState().setPanelOpen(null);
        } else if (st.slideshow.playing) {
          st.toggleSlideshow();
        } else if (st.immersive) {
          st.toggleImmersive();
        } else if (st.fullscreen) {
          void st.toggleFullscreen();
        } else if (st.source.kind !== "unsorted") {
          st.closeViewer();
        }
        return;
      }
      if (anyModal || dialogOpen()) return;
      // A key held down repeats; filing or trashing must not.
      if (e.repeat && (key === "backspace" || key === "delete" || st.library?.targets.some((t) => t.hotkey.toLowerCase() === key))) return;
      if (st.editMode) {
        // In edit mode only a few keys act: T leaves, arrows are ignored (the edit targets this item).
        if (key === "t") st.leaveEdit();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && key === "z") {
        e.preventDefault();
        void st.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Plugins can set right-to-left reading (manga): the arrows follow the page order.
      const rtlNow = directionFor(cur?.albumKey) === "rtl";
      switch (key) {
        case "arrowright":
          if (rtlNow) st.prev();
          else st.next();
          return;
        case "arrowleft":
          if (rtlNow) st.next();
          else st.prev();
          return;
        case "o":
          usePlugins.getState().toggleOverlays();
          return;
        case "backspace":
        case "delete":
          e.preventDefault();
          void st.trashCurrent();
          return;
        case "u":
          if (cur) (cur.albumKey ? st.setAlbumRatingByKey(cur.albumKey, null) : st.setRating(cur, null));
          return;
        case "c":
          st.toggleImmersive();
          return;
        case "h":
          st.toggleHud();
          return;
        case "enter":
          st.toggleSlideshow();
          return;
        case "r":
          void st.surprise();
          return;
        case "[":
        case "]":
        case "\\": {
          const v = videoRef.current;
          if (!v) return;
          const i = Math.max(0, SPEEDS.indexOf(v.playbackRate));
          v.playbackRate = key === "\\" ? 1 : SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i + (key === "]" ? 1 : -1)))];
          return;
        }
        case "s":
          st.toggleShuffle();
          return;
        case "b":
          st.openBrowse();
          return;
        case "d":
          st.openDupes();
          return;
        case "a":
          st.openAlbums();
          return;
        case "e":
          st.openFiles();
          return;
        case "l":
          st.openTags();
          return;
        case "k":
          st.openScrapbook();
          return;
        case "p":
          // ⇧P: the faces in this picture or video; P: People.
          if (e.shiftKey) {
            if (cur) toggleFaceMode();
          } else st.openPeople();
          return;
        case "w":
          // ⇧W: who made it (the key isn't typed into its search, which takes the focus); W: the artists.
          if (e.shiftKey) {
            e.preventDefault();
            setMenu("artist");
          } else st.openArtists();
          return;
        case "i":
          // Info beside the picture, following it; I again closes it.
          st.set({ infoItem: st.infoItem ? null : (cur ?? null) });
          return;
        case "t":
          if (cur) st.openEdit([cur]);
          return;
        case "x":
          st.toggleFit();
          return;
        case "z":
          st.cycleZoom();
          return;
        case "g":
          st.set({ settingsOpen: true });
          return;
        case "?":
          st.set({ helpOpen: true });
          return;
        case "f":
          void st.toggleFullscreen();
          return;
        case " ": {
          e.preventDefault();
          const v = videoRef.current;
          if (v) v.paused ? void v.play() : v.pause();
          return;
        }
        case "m": {
          const v = videoRef.current;
          if (v) v.muted = !v.muted;
          return;
        }
        case ",":
        case ".": {
          const v = videoRef.current;
          if (!v) return;
          // Paused: step a frame; playing: skip 5 seconds.
          const step = v.paused ? 1 / 30 : 5;
          v.currentTime = Math.max(0, v.currentTime + (key === "," ? -step : step));
          return;
        }
      }
      if (/^[0-9]$/.test(key)) {
        const r = key === "0" ? 10 : Number(key);
        if (cur) (cur.albumKey ? st.setAlbumRatingByKey(cur.albumKey, r) : st.setRating(cur, r));
        return;
      }
      // An album's page is in its album folder already: no folder to sort it into (an album moves whole, in Albums).
      const target = cur?.albumKey ? undefined : st.library?.targets.find((t) => t.hotkey.toLowerCase() === key);
      if (target) {
        e.preventDefault();
        if (e.shiftKey && cur && bucketOf(target, st.library!.targets)) setChooseIn(target);
        else void st.moveCurrent(target.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyModal]);

  // Warm the cache for the next couple of images.
  const upcoming = s.queue.slice(s.index + 1, s.index + 3).filter((i) => i.kind === "image");

  return (
    <div ref={rootRef} className={`viewer ${s.hudHidden ? "hud-hidden" : ""} ${s.immersive ? "immersive" : ""} ${cursorHidden ? "cursor-hidden" : ""} ${s.editMode ? "editing" : ""}`}>
      {chooseIn && (
        <OwnFolderPicker
          target={chooseIn}
          onClose={() => setChooseIn(null)}
          onPick={(folder) => {
            setChooseIn(null);
            void s.moveCurrent(chooseIn.id, folder === chooseIn.path ? undefined : folder);
          }}
        />
      )}
      <div className="stage">
        {current && s.editMode ? (
          <EditStage item={current} />
        ) : current ? (
          <>
            <MediaStage item={current} videoRef={videoRef} fit={s.fitMode} loop={!show.playing} onEnded={() => show.playing && s.next()} />
            <PageTurn item={current} index={s.index} fit={s.fitMode} />
          </>
        ) : (
          <div className="fitbox">
          <div className="stage-empty panel">
            <div className="label">Queue empty</div>
            <h2>{s.source.kind === "unsorted" ? "Everything is sorted" : "Nothing here"}</h2>
            <p className="dim">
              {s.source.kind === "unsorted" ? "No unsorted media left in this folder." : "This selection has no items."}
            </p>
            <Deco kind="cat" />
            <div className="row">
              <button className="btn" onClick={() => void s.rescan()}>
                Rescan
              </button>
              <button className="btn accent2" onClick={s.openBrowse}>
                Browse <kbd className="kbd">B</kbd>
              </button>
            </div>
          </div>
          </div>
        )}
        {show.playing && current && current.kind !== "video" && (
          <div key={`${current.key}-${show.interval}`} className="slide-progress" style={{ animationDuration: `${show.interval}s` }} />
        )}
        {upcoming.map((i) => (
          <img key={i.primary} src={mediaUrl(i)} alt="" className="preload" />
        ))}
      </div>

      <div className="hud hud-top">
        <div className="hud-left">
          <BrandHome current="viewer" />
          {s.source.kind === "unsorted" && (
            <span className="faint mono hud-root" title={s.root ?? ""}>
              {s.root ? tailPath(s.root, 2) : ""}
            </span>
          )}
          {s.source.kind !== "unsorted" && (
            <button className="btn sm accent2" onClick={s.closeViewer} title={`Back to ${s.viewerBack === "find" ? (finderName ?? LABEL.find) : (LABEL[s.viewerBack] ?? "Browse")} (Esc)`}>
              <ArrowLeft /> <kbd className="kbd">Esc</kbd>
            </button>
          )}
          {current?.albumKey && <VersionSwitch albumKey={current.albumKey} />}
        </div>
        <div className="hud-center">
          {current && (
            <div className="hud-center-inner">
              <span className="mono item-name" title={`${basename(current.primary)} (right-click: Show in Files)`} onContextMenu={onPathMenu}>
                {basename(current.primary)}
              </span>
              <span className="badge accent2">{ext(current.primary)}</span>
              {album && <span className="badge accent">ALBUM · {album.name}</span>}
              {!album && current.albumKey && <span className="badge accent">ALBUM</span>}
              {current.hasRaw && current.kind !== "raw" && <span className="badge">+RAW</span>}
              {current.hasVideo && current.kind !== "video" && <span className="badge">+VID</span>}
              <SeriesBadge item={current} />
              <span className="dim mono hud-dir ellipsis" title={`${current.dir || "/"} (right-click: Show in Files)`} onContextMenu={onPathMenu}>
                {current.dir || "/"}
              </span>
              <ContextMenu at={pathMenu} items={[{ label: <><FolderOpen /> Show in Files</>, onClick: () => s.showInFiles(current.primary) }]} onClose={() => setPathMenu(null)} />
            </div>
          )}
        </div>
        <div className="hud-right">
          <ActivityButton />
          <span className="mono counter" title="Position in the current queue">
            {s.queue.length ? s.index + 1 : 0} of {s.queue.length}
          </span>

          {/* On a phone or tablet nearby. */}
          <CastButton />

          {/* Slideshow: play/pause, with a menu for interval, HUD hiding, shuffle and surprise. */}
          <span className="btn-group">
            <button className={`btn sm ghost ${show.playing ? "active" : ""}`} onClick={s.toggleSlideshow} title={show.playing ? "Pause slideshow (⏎)" : "Start slideshow (⏎)"}>
              {show.playing ? <Pause /> : <Play />} <kbd className="kbd">⏎</kbd>
            </button>
            <Popover
              open={menu === "show"}
              onClose={() => setMenu(null)}
              width={260}
              trigger={
                <button className="btn sm ghost caret" onClick={() => setMenu(menu === "show" ? null : "show")} title="Slideshow options">
                  <CaretDown />
                </button>
              }
            >
              <div className="pop-title">Slideshow</div>
              <div className="pop-row">
                <span className="small">Seconds per image</span>
                <Select compact value={String(show.interval)} onChange={(v) => s.setSlideshowInterval(Number(v))} options={[2, 3, 5, 8, 10, 15, 20, 30, 60].map((n) => ({ value: String(n), label: `${n}s` }))} />
              </div>
              <label className="check side-row">
                <input type="checkbox" checked={show.hideUi} onChange={(e) => s.setSlideshowHideUi(e.target.checked)} /> Hide the HUD while playing
              </label>
              <div className="pop-list">
                <button className={`btn sm ${s.shuffle ? "active" : "ghost"}`} onClick={s.toggleShuffle}>
                  <Shuffle /> Shuffle <kbd className="kbd">S</kbd>
                </button>
                <button className="btn sm ghost" onClick={() => { setMenu(null); void s.surprise(); }}>
                  <Sparkle /> Surprise me <kbd className="kbd">R</kbd>
                </button>
              </div>
            </Popover>
          </span>

          <PluginButtons location="viewer.toolbar" compact context={() => ({ item: useStore.getState().queue[useStore.getState().index] })} />
          <PluginPanel />
          <FacesPanel videoRef={videoRef} />
          {rtl && (
            <span className="badge accent2" title="Right-to-left reading set by a plugin: ← goes forward">
              RTL
            </span>
          )}

          {current && (
            <button className={`btn sm ${infoShown ? "active" : "ghost"}`} onClick={() => s.set({ infoItem: infoShown ? null : current })} title="Everything known about it (I)">
              <Info />
            </button>
          )}
          {/* Tags on the current item. */}
          {current && (
            <Popover
              open={menu === "tags"}
              onClose={() => setMenu(null)}
              width={320}
              trigger={
                <button className={`btn sm ${menu === "tags" ? "active" : "ghost"}`} onClick={() => setMenu(menu === "tags" ? null : "tags")} title={tagCount ? `${tagCount} tag${tagCount === 1 ? "" : "s"} on this item` : "Tags on this item"}>
                  <TagIcon />
                  {tagCount > 0 && <span className="mono small">{tagCount}</span>}
                </button>
              }
            >
              <div className="pop-title">Tags on {current.name}</div>
              <TagEditor keys={[current.key]} />
            </Popover>
          )}
          {/* Who is in it: its faces on the picture, named here (a video's each at its moment). */}
          {current && <FacesButton item={current} />}
          {/* Who made it (an album page: the album). */}
          {current && artistKey && (
            <Popover
              open={menu === "artist"}
              onClose={() => setMenu(null)}
              width={280}
              trigger={
                <button className={`btn sm viewer-artist ${menu === "artist" ? "active" : "ghost"}`} onClick={() => setMenu(menu === "artist" ? null : "artist")} title={artistOf ? `By ${artistOf.name} (⇧W)` : "Who made it (⇧W)"}>
                  {/* Only their icon: a name would push the bar onto two lines. */}
                  {artistOf ? <ArtistIcon artist={artistOf} size={18} /> : <PaintBrush />}
                </button>
              }
            >
              <div className="pop-title">Artist of {current.albumKey ? (album?.name ?? "this album") : current.name}</div>
              <ArtistPicker keys={[artistKey]} />
            </Popover>
          )}
          {current && (current.kind === "image" || current.kind === "raw") && (
            <button className="btn sm ghost" onClick={() => void useScrapbook.getState().openStudio({ item: current })} title="Make a sticker: cut its subjects out for Scrapbook">
              <Scissors />
            </button>
          )}

          {/* Go to: the list screens. */}
          <Popover
            open={menu === "goto"}
            onClose={() => setMenu(null)}
            width={220}
            trigger={
              <button className="btn sm ghost" onClick={() => setMenu(menu === "goto" ? null : "goto")} title="Go to…">
                <SquaresFour /> <CaretDown />
              </button>
            }
          >
            <div className="pop-title">Go to</div>
            <div className="pop-list">
              <button className="btn sm ghost" onClick={s.openBrowse}>
                <SquaresFour /> Browse <kbd className="kbd">B</kbd>
              </button>
              <button className="btn sm ghost" onClick={s.openAlbums}>
                <Books /> Albums <kbd className="kbd">A</kbd>
              </button>
              <button className="btn sm ghost" onClick={s.openDupes}>
                <Copy /> Duplicates <kbd className="kbd">D</kbd>
              </button>
              <button className="btn sm ghost" onClick={s.openFiles}>
                <FolderOpen /> Files <kbd className="kbd">E</kbd>
              </button>
              <button className="btn sm ghost" onClick={s.openTags}>
                <TagIcon /> Tags <kbd className="kbd">L</kbd>
              </button>
              <button className="btn sm ghost" onClick={() => useStore.getState().openPeople()}>
                <UsersThree /> People <kbd className="kbd">P</kbd>
              </button>
              <button className="btn sm ghost" onClick={() => useStore.getState().openArtists()}>
                <PaintBrush /> Artists <kbd className="kbd">W</kbd>
              </button>
              <button className="btn sm ghost" onClick={() => useStore.getState().openScrapbook()}>
                <BookOpen /> Scrapbook <kbd className="kbd">K</kbd>
              </button>
              {platforms.length ? (
                platforms.map((p) => (
                  <button
                    key={p.pluginId}
                    className="btn sm ghost"
                    onClick={() => {
                      useFind.getState().choose(p.pluginId);
                      useStore.getState().openFind();
                    }}
                  >
                    <PlatformIcon pluginId={p.pluginId} url={p.icon} /> {p.name}
                  </button>
                ))
              ) : (
                <button className="btn sm ghost" onClick={() => useStore.getState().openFind()}>
                  <MagnifyingGlass /> Find
                </button>
              )}
            </div>
          </Popover>

          <button className="btn sm ghost" onClick={() => s.set({ settingsOpen: true })} title="Settings (G)">
            <GearSix /> <kbd className="kbd">G</kbd>
          </button>
          <button className="btn sm ghost" onClick={() => s.set({ helpOpen: true })} title="Keys (?)">
            <Question />
          </button>
        </div>
      </div>

      <SeriesStrip />
      {s.editMode && current ? (
        <EditBar item={current} items={s.editItems.length ? s.editItems : [current]} videoDuration={videoDuration} />
      ) : (
      <div className="hud hud-bottom">
        <div className="hud-row">
          <RatingBar value={albumKey ? albumRating : rating} onChange={rate} label={albumKey ? `Album rating${album ? ` · ${album.name}` : ""}` : "Rating"} />
          <div className="nav">
            <button className="btn" onClick={s.prev} disabled={s.queue.length < 2} title="Previous (←)">
              <CaretLeft /> Prev
            </button>
            <button className="btn" onClick={s.next} disabled={s.queue.length < 2} title="Next (→)">
              Next <CaretRight />
            </button>
            <button className="btn ghost" onClick={() => void s.undo()} disabled={s.undoStack.length === 0 || s.busy} title="Undo (⌘Z)">
              <ArrowCounterClockwise /> Undo <kbd className="kbd">⌘Z</kbd>
            </button>
            <button className="btn ghost" onClick={() => current && s.openEdit([current])} disabled={!current || s.busy} title="Edit: rotate, flip, crop, resize, trim, convert (T)">
              <PencilSimple /> Edit <kbd className="kbd">T</kbd>
            </button>
            <button className="btn danger" data-own-sound onClick={() => void s.trashCurrent()} disabled={!current || s.busy} title="Delete (⌫)">
              <Trash /> Delete <kbd className="kbd">⌫</kbd>
            </button>
          </div>
        </div>
        {/* Sorting into folders, but not an album's pages: the album is in its album folder already. */}
        {!current?.albumKey && (
          <div className="hud-row">
            <TargetBar targets={targets} onMove={(id) => void s.moveCurrent(id)} onChoose={(t) => setChooseIn(t)} onAdd={() => void addTarget()} disabled={!current || s.busy} />
          </div>
        )}
      </div>
      )}
    </div>
  );
}

/** The picture on show is one of a series: which of it (kept together, in a row), and how many. */
function SeriesBadge({ item }: { item: MediaItem }) {
  const series = useStore((s) => seriesIndex(s.library?.series).get(item.key));
  const queue = useStore((s) => s.queue);
  const together = useStore((s) => s.seriesTogether);
  const trashDir = useStore((s) => s.library?.trashDir);
  if (!series) return null;
  const inQueue = queue.filter((q) => series.includes(q.key));
  const at = inQueue.findIndex((q) => q.key === item.key);
  return (
    <span className="badge accent" title={together ? "One of a series kept together: a target key files all of it" : "One of a series (kept apart: Settings, Look and reading)"}>
      SERIES {together && inQueue.length > 1 ? `${at + 1}/${inQueue.length}` : `· ${seriesCount(series, trashDir)}`}
    </span>
  );
}
