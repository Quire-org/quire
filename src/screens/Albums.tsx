import { useEffect, useMemo, useState } from "react";
import { TopNav, SideToggle } from "../components/TopNav";
import { FolderPlus, Play, SlidersHorizontal, Star, X } from "@phosphor-icons/react";
import { Modal } from "../components/Modal";
import { useStore } from "../store";
import { mediaUrl, pickFolder, rawPreviewUrl } from "../lib/api";
import { videoPoster } from "../lib/poster";
import { isTypingTarget } from "../lib/hotkeys";
import { formatBytes, formatDate, shuffled } from "../lib/format";
import type { Album, AlbumRename } from "../lib/types";
import { FitImage } from "../components/FitImage";
import { Deco } from "../components/Deco";

type KindSel = "all" | "photos" | "videos" | "mixed";
type SortSel = "name" | "date" | "size" | "count" | "rating";

/** Album folders: rated, categorised and opened as a whole. */
export function Albums() {
  const s = useStore();
  const roots = s.library?.albumRoots ?? [];
  const albumRatings = s.library?.albumRatings ?? {};
  const [plan, setPlan] = useState<AlbumRename[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const f = s.albumFilters;
  const setF = s.setAlbumFilters;
  const { query, rootSel, kind, minRating, unratedOnly, sortBy, desc, random, zoom } = f;
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
    let list = s.albums;
    if (rootSel !== "all") list = list.filter((a) => a.albumRoot === rootSel);
    if (kind === "photos") list = list.filter((a) => a.videos === 0 && a.images > 0);
    else if (kind === "videos") list = list.filter((a) => a.videos > 0);
    else if (kind === "mixed") list = list.filter((a) => a.videos > 0 && a.images > 0);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((a) => a.name.toLowerCase().includes(q) || a.key.toLowerCase().includes(q));
    }
    if (unratedOnly) list = list.filter((a) => albumRatings[a.key] == null);
    else if (minRating > 0) list = list.filter((a) => (albumRatings[a.key] ?? 0) >= minRating);
    if (random) return shuffled(list);
    const cmp: Record<SortSel, (a: Album, b: Album) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      date: (a, b) => a.modified - b.modified,
      size: (a, b) => a.bytes - b.bytes,
      count: (a, b) => a.count - b.count,
      rating: (a, b) => (albumRatings[a.key] ?? 0) - (albumRatings[b.key] ?? 0) || a.name.localeCompare(b.name),
    };
    const out = list.slice().sort(cmp[sortBy]);
    return desc ? out.reverse() : out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.albums, rootSel, kind, query, albumRatings, minRating, unratedOnly, random, seed, sortBy, desc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || s.settingsOpen || s.trashOpen || s.driveOpen || s.backupOpen || s.vaultOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "a") s.openSortQueue();
      if (key === "b") s.openBrowse();
      if (key === "d") s.openDupes();
      if (key === "g") s.set({ settingsOpen: true });
      if (key === "e") s.openFiles();
      if (key === "h") s.toggleChrome();
      if (key === "s") toggleRandom();
      if (key === "enter" && albums.length) void s.openAlbums_Slideshow(albums);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s, albums]);

  const addRoot = async () => {
    const dir = await pickFolder("Choose a folder whose subfolders are albums", s.root ?? undefined);
    if (dir) s.addAlbumRoot(dir);
  };
  const chip = (active: boolean) => `btn sm ${active ? "active" : ""}`;
  const totalBytes = albums.reduce((a, b) => a + b.bytes, 0);

  return (
    <div className={`screen ${s.sideCollapsed ? "chrome-hidden" : ""}`}>
      <TopNav current="albums" />
      <SideToggle />
    <div className="browse albums">
      <aside className="browse-side panel">
        <input className="input" placeholder="Search albums…" value={query} onChange={(e) => setF({ query: e.target.value })} />

        <div className="label">Album folders</div>
        <div className="side-list">
          {roots.length > 1 && (
            <button className={chip(rootSel === "all")} onClick={() => setF({ rootSel: "all" })}>
              All <span className="faint mono">{s.albums.length}</span>
            </button>
          )}
          {roots.map((r) => (
            <div key={r} className="side-row">
              <button className={`${chip(rootSel === r)} grow`} onClick={() => setF({ rootSel: roots.length > 1 && rootSel !== r ? r : "all" })} title={r}>
                <span className="ellipsis">{r.split("/").pop() || r}</span>
                <span className="faint mono">{s.albums.filter((a) => a.albumRoot === r).length}</span>
              </button>
              <button className="btn sm ghost" onClick={() => s.removeAlbumRoot(r)} title="Stop treating this folder's subfolders as albums">
                <X />
              </button>
            </div>
          ))}
          <button className="btn sm primary" onClick={() => void addRoot()}>
            <FolderPlus /> Add album folder
          </button>
        </div>

        <div className="label">Contains</div>
        <div className="chips">
          {(["all", "photos", "videos", "mixed"] as KindSel[]).map((k) => (
            <button key={k} className={chip(kind === k)} onClick={() => setF({ kind: k })}>
              {k === "all" ? "Any" : k === "photos" ? "Photos only" : k === "videos" ? "Videos" : "Both"}
            </button>
          ))}
        </div>

        <div className="label">Rating</div>
        <div className="side-row">
          <input type="range" min={0} max={10} value={minRating} onChange={(e) => setF({ minRating: Number(e.target.value) })} disabled={unratedOnly} />
          <span className="mono">{unratedOnly ? "—" : minRating === 0 ? "any" : `≥ ${minRating}`}</span>
        </div>
        <label className="side-row check">
          <input type="checkbox" checked={unratedOnly} onChange={(e) => setF({ unratedOnly: e.target.checked })} /> Unrated only
        </label>

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

        <Deco kind="sprout" className="deco-side" />
        <button className="btn sm ghost advanced-btn" onClick={() => setAdvanced(true)}>
          <SlidersHorizontal /> Advanced…
        </button>
      </aside>
      <main className="browse-main">
        <div className="browse-head">
          <span className="mono dim">
            {albums.length} of {s.albums.length} albums · {formatBytes(totalBytes)}
          </span>
        </div>
        {advanced && (
          <Modal title="Advanced" onClose={() => setAdvanced(false)}>
            <section>
              <h3>Folder names</h3>
              <p className="dim small">
                Some tools write folder names with URL escapes, so <span className="mono">Z%C3%BCrich%20Trip</span> is really{" "}
                <span className="mono">Zürich Trip</span>. These can be decoded back to their real names. Album ratings follow the renamed
                folders.
              </p>
              <label className="check side-row" title="Decode whenever albums are scanned">
                <input type="checkbox" checked={!!s.library?.autoDecodeAlbumNames} onChange={(e) => s.setAutoDecodeAlbumNames(e.target.checked)} />
                Decode automatically whenever albums are scanned
              </label>
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  className="btn primary"
                  onClick={() => {
                    if (roots.length === 0) s.toast("Add an album folder first", "warn");
                    else void checkNames();
                  }}
                  disabled={checking}
                >
                  {checking ? "Checking…" : "Check names now"}
                </button>
                <span className="dim small">Shows every planned rename first; nothing changes until you confirm.</span>
              </div>
            </section>
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
        <div className="album-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${zoom}px, 1fr))` }}>
          {albums.map((a) => (
            <AlbumCard key={a.key} album={a} />
          ))}
          {s.albumsLoaded && albums.length === 0 && (
            <div className="dim">
              {s.albums.length ? "No albums match these filters." : roots.length ? "No subfolders with media in the album folders." : "Add an album folder to get started."}
            </div>
          )}
        </div>
      </main>
    </div>
    </div>
  );
}

function AlbumCard({ album }: { album: Album }) {
  const s = useStore();
  const targets = s.library?.targets ?? [];
  const rating = s.library?.albumRatings[album.key];
  const [cover, setCover] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const c = album.cover;
    if (!c) return;
    const p = c.kind === "image" ? Promise.resolve(mediaUrl(c)) : c.kind === "raw" ? rawPreviewUrl(c.primary) : videoPoster(mediaUrl(c));
    p.then((u) => alive && setCover(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [album.cover]);

  return (
    <div className="album-card panel">
      <div className="album-cover" onClick={() => void s.openAlbum(album)} title="Open album">
        {cover ? <FitImage src={cover} mode="fit" blurBackdrop /> : <div className="thumb-ph mono">{album.count ? "…" : "EMPTY"}</div>}
        <span className="badge accent2 album-count" title={`${album.images} photos, ${album.videos} videos, ${formatBytes(album.bytes)}`}>
          {album.count}
        </span>
        {rating != null && (
          <span className="badge accent tile-rating">
            <Star /> {rating}
          </span>
        )}
        <div className="album-actions" onClick={(e) => e.stopPropagation()}>
          {targets.map((t) => (
            <button key={t.id} className="btn sm primary" disabled={s.busy} onClick={() => void s.moveAlbum(album, t.id)} title={`Move the whole folder to ${t.path}`}>
              {t.name}
            </button>
          ))}
          <button className="btn sm" onClick={() => void s.openAlbum(album)}>
            Open
          </button>
        </div>
      </div>
      <div className="album-foot">
        <div className="album-name ellipsis" title={`${album.path}\n${formatDate(album.modified)}`}>
          {album.name}
        </div>
        {rating != null && <span className="mono accent-text small">{rating}/10</span>}
      </div>
    </div>
  );
}
