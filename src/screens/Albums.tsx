import { useEffect, useState } from "react";
import { useStore } from "../store";
import { fileSrc, pickFolder, rawPreviewUrl } from "../lib/api";
import { videoPoster } from "../lib/poster";
import { isTypingTarget } from "../lib/hotkeys";
import { formatBytes, formatDate } from "../lib/format";
import type { Album } from "../lib/types";
import { FitImage } from "../components/FitImage";

/** Album folders: rated, categorised and opened as a whole. */
export function Albums() {
  const s = useStore();
  const roots = s.library?.albumRoots ?? [];

  useEffect(() => {
    void s.loadAlbums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, s.albumsLoaded]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || s.settingsOpen || s.trashOpen || s.driveOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "a") s.openSortQueue();
      if (key === "b") s.openBrowse();
      if (key === "d") s.openDupes();
      if (key === "g") s.set({ settingsOpen: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);

  const addRoot = async () => {
    const dir = await pickFolder("Choose a folder whose subfolders are albums", s.root ?? undefined);
    if (dir) s.addAlbumRoot(dir);
  };

  return (
    <div className="browse albums">
      <aside className="browse-side panel">
        <div className="side-head">
          <span className="brand">MEDIA SORTER</span>
          <button className="btn sm accent2" onClick={s.openSortQueue} title="Back to sorting (Esc)">
            Sort <kbd className="kbd">Esc</kbd>
          </button>
        </div>
        <h3>Albums</h3>
        <p className="dim small">
          Every subfolder of an album folder is one album. Albums stay out of the main grid and the sorting queue; rate
          and move them as a whole.
        </p>
        <div className="label">Album folders</div>
        <div className="side-list">
          {roots.length === 0 && <span className="dim small">None yet.</span>}
          {roots.map((r) => (
            <div key={r} className="side-row">
              <span className="mono small ellipsis grow" title={r}>
                {r}
              </span>
              <button className="btn sm ghost" onClick={() => s.removeAlbumRoot(r)} title="Stop treating this folder's subfolders as albums">
                ×
              </button>
            </div>
          ))}
          <button className="btn sm primary" onClick={() => void addRoot()}>
            + Add album folder
          </button>
        </div>
        <hr className="rule" />
        <button className="btn sm" onClick={s.openBrowse}>
          Browse <kbd className="kbd">B</kbd>
        </button>
        <button className="btn sm ghost" onClick={() => s.set({ settingsOpen: true })}>
          Settings <kbd className="kbd">G</kbd>
        </button>
      </aside>
      <main className="browse-main">
        <div className="browse-head">
          <span className="mono dim">
            {s.albums.length} albums · {formatBytes(s.albums.reduce((a, b) => a + b.bytes, 0))}
          </span>
        </div>
        <div className="album-grid">
          {s.albums.map((a) => (
            <AlbumCard key={a.key} album={a} />
          ))}
          {s.albumsLoaded && s.albums.length === 0 && (
            <div className="dim">{roots.length ? "No subfolders with media in the album folders." : "Add an album folder to get started."}</div>
          )}
        </div>
      </main>
    </div>
  );
}

function AlbumCard({ album }: { album: Album }) {
  const s = useStore();
  const targets = s.library?.targets ?? [];
  const rating = s.library?.albumRatings[album.key];
  const [cover, setCover] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const c = album.cover;
    if (!c) return;
    const p = c.kind === "image" ? Promise.resolve(fileSrc(c.primary)) : c.kind === "raw" ? rawPreviewUrl(c.primary) : videoPoster(fileSrc(c.primary));
    p.then((u) => alive && setCover(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [album.cover]);

  const shown = hover ?? rating ?? 0;
  return (
    <div className="album-card panel">
      <div className="album-cover" onClick={() => void s.openAlbum(album)} title="Open album">
        {cover ? <FitImage src={cover} mode="fit" blurBackdrop /> : <div className="thumb-ph mono">{album.count ? "…" : "EMPTY"}</div>}
        <span className="badge accent2 album-count">{album.count}</span>
      </div>
      <div className="album-name ellipsis" title={album.path}>
        {album.name}
      </div>
      <div className="mono faint small">
        {album.images} photos · {album.videos} videos · {formatBytes(album.bytes)} · {formatDate(album.modified)}
      </div>
      <div className="side-row">
        <div className="album-rating" onMouseLeave={() => setHover(null)}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              className={`rating-seg ${n <= shown ? "on" : ""} ${n <= shown && shown >= 9 ? "hot" : ""}`}
              onMouseEnter={() => setHover(n)}
              onClick={() => s.setAlbumRating(album, rating === n ? null : n)}
              title={`Rate ${n}`}
            />
          ))}
        </div>
        <span className="mono accent-text small">{rating != null ? `${rating}/10` : "—"}</span>
      </div>
      <div className="album-targets">
        {targets.map((t) => (
          <button key={t.id} className="btn sm primary" disabled={s.busy} onClick={() => void s.moveAlbum(album, t.id)} title={`Move the whole folder to ${t.path}`}>
            {t.name}
          </button>
        ))}
        <button className="btn sm ghost" onClick={() => void s.openAlbum(album)}>
          Open
        </button>
      </div>
    </div>
  );
}
