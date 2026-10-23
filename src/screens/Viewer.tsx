import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, selectCurrent, selectRating } from "../store";
import { MediaStage, SPEEDS } from "../components/MediaStage";
import { Deco } from "../components/Deco";
import { RatingBar } from "../components/RatingBar";
import { TargetBar } from "../components/TargetBar";
import { fileSrc, pickFolder } from "../lib/api";
import { isTypingTarget } from "../lib/hotkeys";
import { basename, ext, formatBytes, formatDate, tailPath } from "../lib/format";

export function Viewer() {
  const s = useStore();
  const current = useStore(selectCurrent);
  const rating = useStore(selectRating);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [cursorHidden, setCursorHidden] = useState(false);
  const targets = s.library?.targets ?? [];
  const album = current?.albumKey ? s.albums.find((a) => a.key === current.albumKey) : undefined;
  const albumKey = current?.albumKey;
  const albumRating = albumKey ? s.library?.albumRatings[albumKey] : undefined;

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

  const rate = (r: number | null) => {
    if (!current) return;
    if (albumKey) s.setAlbumRatingByKey(albumKey, r);
    else s.setRating(current, r);
  };
  const anyModal = s.settingsOpen || s.trashOpen || s.helpOpen || s.driveOpen || s.backupOpen;

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
  }, []);

  const addTarget = useCallback(async () => {
    const dir = await pickFolder("Choose a target folder", s.lastTargetParent ?? s.root ?? undefined);
    if (dir) s.addTarget(dir);
  }, [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const st = useStore.getState();
      const cur = st.queue[st.index];

      if (key === "escape") {
        if (st.settingsOpen || st.trashOpen || st.helpOpen || st.infoOpen || st.driveOpen || st.backupOpen) {
          st.set({ settingsOpen: false, trashOpen: false, helpOpen: false, infoOpen: false, driveOpen: false, backupOpen: false });
        } else if (st.immersive) {
          st.toggleImmersive();
        } else if (st.fullscreen) {
          void st.toggleFullscreen();
        } else if (st.source.kind === "browse") {
          st.openBrowse();
        } else if (st.source.kind === "dupes") {
          st.openDupes();
        } else if (st.source.kind === "albums") {
          st.openAlbums();
        }
        return;
      }
      if (anyModal) return;

      if ((e.metaKey || e.ctrlKey) && key === "z") {
        e.preventDefault();
        void st.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (key) {
        case "arrowright":
          st.next();
          return;
        case "arrowleft":
          st.prev();
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
        case "x":
          st.toggleFit();
          return;
        case "g":
          st.set({ settingsOpen: true });
          return;
        case "i":
          st.set({ infoOpen: !st.infoOpen });
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
      const target = st.library?.targets.find((t) => t.hotkey.toLowerCase() === key);
      if (target) {
        e.preventDefault();
        void st.moveCurrent(target.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyModal]);

  // Warm the cache for the next couple of images.
  const upcoming = s.queue.slice(s.index + 1, s.index + 3).filter((i) => i.kind === "image");

  return (
    <div ref={rootRef} className={`viewer ${s.hudHidden ? "hud-hidden" : ""} ${s.immersive ? "immersive" : ""} ${cursorHidden ? "cursor-hidden" : ""}`}>
      <div className="stage">
        {current ? (
          <MediaStage item={current} videoRef={videoRef} fit={s.fitMode} />
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
        {upcoming.map((i) => (
          <img key={i.primary} src={fileSrc(i.primary)} alt="" className="preload" />
        ))}
        {s.infoOpen && current && (
          <div className="info panel mono">
            <div className="label">File</div>
            {current.files.map((f) => (
              <div key={f}>{basename(f)}</div>
            ))}
            <div className="label">Folder</div>
            <div>{current.dir || "/"}</div>
            <div className="label">Size</div>
            <div>{formatBytes(current.size)}</div>
            <div className="label">Modified</div>
            <div>{formatDate(current.modified)}</div>
            <div className="label">Key</div>
            <div className="faint">{current.key}</div>
          </div>
        )}
      </div>

      <div className="hud hud-top">
        <div className="hud-left">
          <span className="brand">MEDIA SORTER</span>
          {s.source.kind === "unsorted" && (
            <span className="faint mono hud-root" title={s.root ?? ""}>
              {s.root ? tailPath(s.root, 2) : ""}
            </span>
          )}
          {s.source.kind !== "unsorted" && (
            <button
              className="btn sm accent2"
              onClick={s.source.kind === "browse" ? s.openBrowse : s.source.kind === "albums" ? s.openAlbums : s.openDupes}
              title={`Back to ${s.source.kind === "browse" ? "Browse" : s.source.kind === "albums" ? "Albums" : "Duplicates"} (Esc)`}
            >
              ← <kbd className="kbd">Esc</kbd>
            </button>
          )}
        </div>
        <div className="hud-center">
          {current && (
            <>
              <span className="mono item-name">{basename(current.primary)}</span>
              <span className="badge accent2">{ext(current.primary)}</span>
              {album && <span className="badge accent">ALBUM · {album.name}</span>}
              {!album && current.albumKey && <span className="badge accent">ALBUM</span>}
              {current.hasRaw && current.kind !== "raw" && <span className="badge">+RAW</span>}
              {current.hasVideo && current.kind !== "video" && <span className="badge">+VID</span>}
              <span className="dim mono">{current.dir || "/"}</span>
            </>
          )}
        </div>
        <div className="hud-right">
          <span className="mono counter" title="Position in the current queue">
            {s.queue.length ? s.index + 1 : 0} of {s.queue.length}
          </span>
          <button className="btn sm ghost" onClick={() => void s.surprise()} title="Surprise me (R)">
            ✦ <kbd className="kbd">R</kbd>
          </button>
          <button className={`btn sm ghost ${s.fitMode === "fill" ? "active" : ""}`} onClick={s.toggleFit} title="Fit whole image / fill screen (X)">
            {s.fitMode === "fit" ? "Fit" : "Fill"} <kbd className="kbd">X</kbd>
          </button>
          <button className={`btn sm ${s.shuffle ? "active" : ""}`} onClick={s.toggleShuffle} title="Shuffle (S)">
            Shuffle <kbd className="kbd">S</kbd>
          </button>
          <button className="btn sm" onClick={s.openBrowse} title="Browse everything (B)">
            Browse <kbd className="kbd">B</kbd>
          </button>
          <button className="btn sm" onClick={s.openAlbums} title="Albums (A)">
            Albums <kbd className="kbd">A</kbd>
          </button>
          <button className="btn sm" onClick={s.openDupes} title="Find duplicates (D)">
            Dupes <kbd className="kbd">D</kbd>
          </button>
          <button className="btn sm" onClick={() => s.set({ settingsOpen: true })} title="Settings (G)">
            Settings <kbd className="kbd">G</kbd>
          </button>
          <button className="btn sm ghost" onClick={() => s.set({ helpOpen: true })} title="Keys (?)">
            ?
          </button>
          <button className={`btn sm ghost ${s.immersive ? "active" : ""}`} onClick={s.toggleImmersive} title="Immersive (C)">
            ◼ <kbd className="kbd">C</kbd>
          </button>
          <button className="btn sm ghost" onClick={() => void s.toggleFullscreen()} title="Fullscreen (F)">
            ⛶
          </button>
        </div>
      </div>

      <div className="hud hud-bottom">
        <div className="hud-row">
          <RatingBar value={albumKey ? albumRating : rating} onChange={rate} label={albumKey ? `Album rating${album ? ` · ${album.name}` : ""}` : "Rating"} />
          <div className="nav">
            <button className="btn" onClick={s.prev} disabled={s.queue.length < 2} title="Previous (←)">
              <kbd className="kbd">←</kbd> Prev
            </button>
            <button className="btn" onClick={s.next} disabled={s.queue.length < 2} title="Next (→)">
              Next <kbd className="kbd">→</kbd>
            </button>
            <button className="btn ghost" onClick={() => void s.undo()} disabled={s.undoStack.length === 0 || s.busy} title="Undo (⌘Z)">
              Undo <kbd className="kbd">⌘Z</kbd>
            </button>
            <button className="btn danger" onClick={() => void s.trashCurrent()} disabled={!current || s.busy} title="Delete (⌫)">
              Delete <kbd className="kbd">⌫</kbd>
            </button>
          </div>
        </div>
        <div className="hud-row">
          <TargetBar targets={targets} onMove={(id) => void s.moveCurrent(id)} onAdd={() => void addTarget()} disabled={!current || s.busy} />
        </div>
      </div>
    </div>
  );
}
