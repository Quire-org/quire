import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowCounterClockwise, ArrowLeft, CaretDoubleLeft, CaretDoubleRight, ClockCounterClockwise, FolderOpen, Info, PaintBrush, Pause, Play, Shuffle, Sparkle, Star, Tag as TagIcon, Trash } from "@phosphor-icons/react";
import { ArtistPicker } from "../components/ArtistPicker";
import { MediaStage } from "../components/MediaStage";
import { Modal } from "../components/Modal";
import { OwnFolderPicker } from "../components/OwnFolderPicker";
import { PageTurn } from "../components/PageTurn";
import { FacesButton, FacesPanel } from "../components/FacesInPicture";
import { Popover } from "../components/Popover";
import { SeriesBadge } from "../components/SeriesBadge";
import { SeriesStrip } from "../components/SeriesStrip";
import { TagEditor } from "../components/TagPicker";
import { VersionSwitch } from "../components/VersionSwitch";
import { artistKeyOf, useArtists } from "../artistsStore";
import { mediaUrl } from "../lib/api";
import { bucketOf } from "../lib/filing";
import { basename } from "../lib/format";
import { isTypingTarget } from "../lib/hotkeys";
import type { Target } from "../lib/types";
import { directionFor, usePlugins } from "../plugins/store";
import { canShowSimilar, showSimilar } from "../similarStore";
import { usePeople, useFaceMode } from "../peopleStore";
import { originalOf, selectCurrent, selectRating, SLIDESHOW_SECONDS, useStore } from "../store";
import { albumKeyOf, useTags } from "../tagsStore";
import { useVersionInfo, useVersions } from "../versionsStore";
import { SWIPE, TURN_ZONE } from "./gestures";
import { useSlideshow } from "./useSlideshow";

/** How long two taps are apart at most to be one double tap. */
const DOUBLE_TAP_MS = 260;
/** Pulled down this share of the screen, or flicked at this many pixels a millisecond, it goes back. */
const PULL_AWAY = 0.16;
const FLICK = 0.7;
/** As mobile.css has it (.m-viewer.settling). */
const SETTLE_MS = 220;
/** A double tap on a video goes this many seconds; what it went stays on show this long (as .m-skip has it). */
const SKIP_S = 10;
const SKIP_SHOWN_MS = 800;

/**
 * One picture or video at a time: Sort's queue, or what was opened from a list. A swipe goes to the
 * next or the one before and never files or deletes anything; that is what the buttons are for.
 */
export function MobileViewer({ over }: { over?: boolean }) {
  const s = useStore(useShallow((x) => ({ albums: x.albums, albumsLoaded: x.albumsLoaded, busy: x.busy, closeViewer: x.closeViewer, fitMode: x.fitMode, hudHidden: x.hudHidden, index: x.index, library: x.library, loadAlbums: x.loadAlbums, moveCurrent: x.moveCurrent, next: x.next, prev: x.prev, queue: x.queue, rescan: x.rescan, root: x.root, set: x.set, setAlbumRatingByKey: x.setAlbumRatingByKey, setRating: x.setRating, setSlideshowHideUi: x.setSlideshowHideUi, setSlideshowInterval: x.setSlideshowInterval, shuffle: x.shuffle, slideshow: x.slideshow, source: x.source, toggleHud: x.toggleHud, toggleShuffle: x.toggleShuffle, toggleSlideshow: x.toggleSlideshow, trashCurrent: x.trashCurrent, undo: x.undo, undoStack: x.undoStack })));
  const current = useStore(selectCurrent);
  const rating = useStore(selectRating);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sheet, setSheet] = useState<"tags" | "artist" | null>(null);
  const [chooseIn, setChooseIn] = useState<Target | null>(null);
  const show = useSlideshow();
  // Rate, File and the slideshow's options, each a small list over its button.
  const [menu, setMenu] = useState<"rate" | "file" | "show" | null>(null);
  const closedAt = useRef(0);
  const closeMenu = () => {
    closedAt.current = Date.now();
    setMenu(null);
  };
  const targets = s.library?.targets ?? [];
  const albumKey = current?.albumKey;
  const albumRating = albumKey ? s.library?.albumRatings[originalOf(albumKey)] : undefined;
  const album = albumKey ? s.albums.find((a) => a.key === albumKey) : undefined;
  usePlugins((p) => p.directions);
  const rtl = directionFor(albumKey) === "rtl";
  const originalOn = usePlugins((p) => p.overlaysHidden);
  const version = useVersionInfo(current);
  const hasOriginal = !!(version?.kept ?? version?.original);
  const tagCount = useTags((t) => (current ? (t.data?.tags[albumKey ? albumKeyOf(albumKey) : current.key]?.length ?? 0) : 0));
  const artistKey = current ? artistKeyOf(current) : null;

  useEffect(() => {
    void useTags.getState().load();
    void useArtists.getState().load();
    void useVersions.getState().load();
    void usePeople.getState().load();
  }, [s.root]);
  useEffect(() => {
    if (albumKey && !s.albumsLoaded) void s.loadAlbums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumKey]);
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => useStore.getState().recordView(current), 700);
    return () => clearTimeout(t);
  }, [current?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const rate = (r: number | null) => {
    if (!current) return;
    if (albumKey) s.setAlbumRatingByKey(albumKey, r);
    else s.setRating(current, r);
  };
  const inSort = s.source.kind === "unsorted";
  const shownRating = albumKey ? albumRating : rating;
  const forward = rtl ? s.prev : s.next;
  const back = rtl ? s.next : s.prev;

  // A keyboard on a tablet: the same keys as on a computer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || sheet || document.querySelector(".modal-backdrop")) return;
      const st = useStore.getState();
      const cur = st.queue[st.index];
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "z") return void st.undo();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (key === "arrowright") forward();
      else if (key === "arrowleft") back();
      else if ((key === "backspace" || key === "delete") && !e.repeat) void st.trashCurrent();
      else if (key === "enter" && !e.repeat) st.toggleSlideshow();
      else if (key === "escape" && st.slideshow.playing) st.toggleSlideshow();
      else if (key === "escape" && st.source.kind !== "unsorted") st.closeViewer();
      else if (/^[0-9]$/.test(key) && cur) (cur.albumKey ? st.setAlbumRatingByKey(cur.albumKey, key === "0" ? 10 : Number(key)) : st.setRating(cur, key === "0" ? 10 : Number(key)));
      else {
        const t = cur?.albumKey ? undefined : st.library?.targets.find((x) => x.hotkey.toLowerCase() === key);
        if (t && !e.repeat) void st.moveCurrent(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, forward, back]);

  // Swipes across the picture go to the next or the one before; pulled down, a picture opened from a
  // list follows the finger and goes back to it. Which of the two is settled by where the finger first goes.
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const finger = useRef<{ x: number; y: number; at: number; axis: "across" | "down" | null } | null>(null);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [skip, setSkip] = useState<{ side: -1 | 1; secs: number } | null>(null);
  useEffect(() => {
    if (!skip) return;
    const t = setTimeout(() => setSkip(null), SKIP_SHOWN_MS);
    return () => clearTimeout(t);
  }, [skip]);
  const skipBy = (side: -1 | 1) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + side * SKIP_S));
    setSkip((was) => ({ side, secs: was?.side === side ? was.secs + SKIP_S : SKIP_S }));
  };
  const setPull = (dy: number) => {
    const el = root.current;
    if (!el || !stage.current) return;
    const share = Math.max(0, Math.min(1, dy / el.clientHeight));
    el.style.setProperty("--pull", String(share));
    stage.current.style.transform = dy > 0 ? `translateY(${dy}px) scale(${1 - share * 0.35})` : "";
  };
  const settle = (leaving: boolean) => {
    const el = root.current;
    if (!el) return;
    el.classList.remove("pulling");
    el.classList.add("settling");
    setPull(leaving ? el.clientHeight : 0);
    setTimeout(() => (leaving ? useStore.getState().closeViewer() : el.classList.remove("settling")), SETTLE_MS);
  };
  const onTouchStart = (e: React.TouchEvent) => {
    const pulling = finger.current?.axis === "down";
    const onControls = (e.target as HTMLElement).closest?.(".video-controls");
    finger.current = e.touches.length === 1 && !onControls && useStore.getState().zoom.level === 0 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now(), axis: null } : null;
    if (pulling && !finger.current) settle(false);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const f = finger.current;
    if (!f || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - f.x;
    const dy = e.touches[0].clientY - f.y;
    if (!f.axis) {
      if (Math.hypot(dx, dy) < 10) return;
      f.axis = !inSort && dy > 0 && Math.abs(dy) > Math.abs(dx) ? "down" : "across";
      if (f.axis === "down") root.current?.classList.add("pulling");
    }
    if (f.axis === "down") setPull(Math.max(0, dy));
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const f = finger.current;
    finger.current = null;
    const t = e.changedTouches[0];
    if (!f || !t) return;
    const dx = t.clientX - f.x;
    const dy = t.clientY - f.y;
    if (f.axis === "down") {
      const height = root.current?.clientHeight ?? 1;
      return settle(dy > height * PULL_AWAY || dy / Math.max(1, Date.now() - f.at) > FLICK);
    }
    if (Math.abs(dx) >= SWIPE && Math.abs(dx) > Math.abs(dy) * 2) (dx < 0 ? forward : back)();
  };
  const onTouchCancel = () => {
    if (finger.current?.axis === "down") settle(false);
    finger.current = null;
  };
  // Before the picture's own double tap: the sides of a page only turn it, and the middle keeps the bars and the zoom.
  const onTurnTap = (e: React.MouseEvent) => {
    if (!albumKey || current?.kind === "video" || useFaceMode.getState().on || useStore.getState().zoom.level > 0 || Date.now() - closedAt.current < 400) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = (e.clientX - r.left) / r.width;
    if (at > TURN_ZONE && at < 1 - TURN_ZONE) return;
    e.stopPropagation();
    (at < 0.5 ? back : forward)();
  };
  const onTap = (e: React.MouseEvent) => {
    // A tap that only closed Rate or File leaves the bars alone.
    if ((e.target as HTMLElement).closest?.(".video-controls") || Date.now() - closedAt.current < 400) return;
    // On a video a double tap goes back on the left half and on on the right; each tap while that shows goes further.
    const r = e.currentTarget.getBoundingClientRect();
    const side = e.clientX < r.left + r.width / 2 ? -1 : 1;
    const video = current?.kind === "video";
    if (video && skip) return skipBy(side);
    if (tapTimer.current) {
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
      if (video) skipBy(side);
      return;
    }
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null;
      useStore.getState().toggleHud();
    }, DOUBLE_TAP_MS);
  };

  const upcoming = s.queue.slice(s.index + 1, s.index + 3).filter((i) => i.kind === "image");

  return (
    <div ref={root} className={`m-viewer ${over ? "over" : ""} ${s.hudHidden ? "hud-hidden" : ""}`}>
      <div className="m-backdrop" />
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
      <div ref={stage} className="stage m-stage" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchCancel} onClickCapture={onTurnTap} onClick={onTap}>
        {current ? (
          <>
            <MediaStage item={current} videoRef={videoRef} fit={s.fitMode} loop={show.loop} onEnded={show.onEnded} />
            <PageTurn item={current} index={s.index} fit={s.fitMode} />
          </>
        ) : (
          <div className="fitbox">
            <div className="m-empty">
              <h2>{inSort ? "Everything is sorted" : "Nothing here"}</h2>
              <p className="dim">{inSort ? "No unsorted pictures or videos left in this library." : "This selection has nothing in it."}</p>
              <button className="btn" onClick={() => void s.rescan()}>
                Look again
              </button>
            </div>
          </div>
        )}
        {upcoming.map((i) => (
          <img key={i.primary} src={mediaUrl(i)} alt="" className="preload" />
        ))}
        {skip && (
          <div key={`${skip.side}${skip.secs}`} className={`m-skip panel mono ${skip.side > 0 ? "on" : ""}`} role="status">
            {skip.side < 0 && <CaretDoubleLeft />}
            {skip.secs} s
            {skip.side > 0 && <CaretDoubleRight />}
          </div>
        )}
      </div>

      <SeriesStrip />
      <FacesPanel videoRef={videoRef} />

      <div className="m-hud m-hud-top">
        {!inSort && (
          <button className="m-icon" aria-label="Back" onClick={s.closeViewer}>
            <ArrowLeft />
          </button>
        )}
        <div className="m-hud-where">
          {current && <span className="mono ellipsis">{album ? album.name : basename(current.primary)}</span>}
          <span className="mono faint small">{s.queue.length ? `${s.index + 1} of ${s.queue.length}` : ""}</span>
        </div>
        {albumKey && <VersionSwitch albumKey={albumKey} />}
        {current && <SeriesBadge item={current} />}
        {current && <FacesButton item={current} />}
        {hasOriginal && (
          <button className={`m-icon ${originalOn ? "on" : ""}`} aria-label="Show what it was made from" aria-pressed={originalOn} onClick={() => usePlugins.getState().toggleOverlays()}>
            <ClockCounterClockwise />
          </button>
        )}
        {current && canShowSimilar(current) && (
          <button className="m-icon" aria-label="Show similar" onClick={() => showSimilar(current)}>
            <Sparkle />
          </button>
        )}
        {current && (
          <button className="m-icon" aria-label="Info" onClick={() => s.set({ infoItem: current })}>
            <Info />
          </button>
        )}
        {current && (
          <button className="m-icon m-count" aria-label="Tags" onClick={() => setSheet("tags")}>
            <TagIcon />
            {tagCount > 0 && <span className="mono">{tagCount}</span>}
          </button>
        )}
        {current && artistKey && (
          <button className="m-icon" aria-label="Artist" onClick={() => setSheet("artist")}>
            <PaintBrush />
          </button>
        )}
      </div>

      <div className="m-hud m-hud-bottom">
        <div className="m-acts">
          <div className="m-show">
            <Popover
              className="m-drop"
              open={menu === "show"}
              onClose={closeMenu}
              width={256}
              trigger={
                <button
                  className={`btn ${s.slideshow.playing || menu === "show" ? "active" : "ghost"}`}
                  disabled={!current}
                  aria-label={s.slideshow.playing ? "Pause slideshow" : "Start slideshow"}
                  aria-expanded={menu === "show"}
                  onClick={s.toggleSlideshow}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu("show");
                  }}
                >
                  {s.slideshow.playing ? <Pause /> : <Play />}
                </button>
              }
            >
              <div className="m-list">
                <div className="pop-title">Seconds per picture</div>
                <div className="m-rate-all">
                  {SLIDESHOW_SECONDS.map((n) => (
                    <button key={n} className={`btn ${s.slideshow.interval === n ? "active" : ""}`} onClick={() => s.setSlideshowInterval(n)}>
                      {n}
                    </button>
                  ))}
                </div>
                <label className="check side-row">
                  <input type="checkbox" checked={s.slideshow.hideUi} onChange={(e) => s.setSlideshowHideUi(e.target.checked)} /> Hide the bars while playing
                </label>
                <button className={`btn ${s.shuffle ? "active" : "ghost"}`} onClick={s.toggleShuffle}>
                  <Shuffle /> Shuffle
                </button>
              </div>
            </Popover>
          </div>
          <button className="btn ghost" onClick={() => void s.undo()} disabled={!s.undoStack.length || s.busy}>
            <ArrowCounterClockwise /> Undo
          </button>
          <Popover
            className="m-drop"
            open={menu === "rate"}
            onClose={closeMenu}
            width={256}
            trigger={
              <button className={`btn ${menu === "rate" ? "active" : "ghost"}`} disabled={!current} aria-expanded={menu === "rate"} onClick={() => setMenu(menu === "rate" ? null : "rate")}>
                <Star weight={shownRating != null ? "fill" : "regular"} /> {shownRating ?? "Rate"}
              </button>
            }
          >
            <div className="m-rate-all">
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  className={`btn ${shownRating === n ? "active" : ""}`}
                  onClick={() => {
                    rate(shownRating === n ? null : n);
                    closeMenu();
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
            {shownRating != null && (
              <button
                className="btn sm ghost"
                onClick={() => {
                  rate(null);
                  closeMenu();
                }}
              >
                Clear rating
              </button>
            )}
          </Popover>
          {!albumKey && (
            <Popover
              className="m-drop"
              open={menu === "file"}
              onClose={closeMenu}
              width={240}
              trigger={
                <button className={`btn ${menu === "file" ? "active" : "ghost"}`} disabled={!current || s.busy} aria-expanded={menu === "file"} onClick={() => setMenu(menu === "file" ? null : "file")}>
                  <FolderOpen /> File
                </button>
              }
            >
              <div className="m-list">
                {targets.map((t) => (
                  <button
                    key={t.id}
                    className="btn m-target"
                    onClick={() => {
                      closeMenu();
                      void s.moveCurrent(t.id);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!bucketOf(t, targets)) return;
                      closeMenu();
                      setChooseIn(t);
                    }}
                  >
                    <span className="ellipsis">{t.name}</span>
                  </button>
                ))}
                {!targets.length && <span className="dim small">No folders to sort into yet: add them on your computer.</span>}
              </div>
            </Popover>
          )}
          <button className="btn danger" data-own-sound onClick={() => void s.trashCurrent()} disabled={!current || s.busy}>
            <Trash /> Trash
          </button>
        </div>
      </div>

      {sheet === "tags" && current && (
        <Modal title="Tags" onClose={() => setSheet(null)}>
          <TagEditor keys={[current.key]} />
        </Modal>
      )}
      {sheet === "artist" && artistKey && (
        <Modal title="Artist" onClose={() => setSheet(null)}>
          <ArtistPicker keys={[artistKey]} />
        </Modal>
      )}
    </div>
  );
}
