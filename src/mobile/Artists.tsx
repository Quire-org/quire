import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { ArrowLeft, MagnifyingGlass, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { albumArtistKey, countsOf, useArtists, type LocalArtist } from "../artistsStore";
import { ArtistIcon } from "../components/ArtistIcon";
import { ask, askText } from "../components/Confirm";
import { AlbumCard } from "../screens/Albums";
import { ArtistCard } from "../screens/Artists";
import { eachOnce, useStore } from "../store";
import { TileGrid } from "./TileGrid";
import { MobileTop } from "./TopBar";

type Order = "pictures" | "name" | "newest";

const ignoreMenu = (e: MouseEvent) => e.preventDefault();

/** The library's artists: found, added, renamed, removed, and each one's pictures and albums. What more they are linked to is on the computer. */
export function MobileArtists() {
  const a = useArtists();
  const root = useStore((s) => s.root);
  useEffect(() => {
    void a.load();
    void useStore.getState().loadAll();
    void useStore.getState().loadAlbums();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  const open = a.open && a.doc?.artists[a.open] ? a.doc.artists[a.open] : null;
  return <div className="m-collection">{open ? <ArtistPage artist={open} /> : <Roster />}</div>;
}

function Roster() {
  const doc = useArtists((s) => s.doc);
  const create = useArtists((s) => s.create);
  const setOpen = useArtists((s) => s.setOpen);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [order, setOrder] = useState<Order>("pictures");
  const counts = useMemo(() => countsOf(doc), [doc]);
  const albumCounts = useMemo(() => countsOf(doc, true), [doc]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = Object.values(doc?.artists ?? {}).filter((x) => !needle || x.name.toLowerCase().includes(needle) || x.links.some((l) => l.account.toLowerCase().includes(needle)));
    return shown.sort((x, y) => (order === "name" ? x.name.localeCompare(y.name) : order === "newest" ? y.added - x.added : (counts[y.id] ?? 0) - (counts[x.id] ?? 0) || x.name.localeCompare(y.name)));
  }, [doc, q, order, counts]);
  const add = async () => {
    const name = await askText({ title: "New artist", message: "Their name:", initial: "", confirm: "Add" });
    const id = name ? create(name) : null;
    if (id) setOpen(id);
  };
  return (
    <>
      <MobileTop current="artists">
        <button className={`m-icon ${searching ? "on" : ""}`} aria-label="Search" onClick={() => (searching && setQ(""), setSearching(!searching))}>
          <MagnifyingGlass />
        </button>
        <button className="m-icon" aria-label="New artist" onClick={() => void add()}>
          <Plus />
        </button>
      </MobileTop>
      {searching && (
        <div className="m-search">
          <input className="input" autoFocus type="search" autoCorrect="off" autoCapitalize="off" spellCheck={false} placeholder="Search name or account" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="m-filters-row chips">
        {(["pictures", "name", "newest"] as Order[]).map((o) => (
          <button key={o} className={`btn sm ${order === o ? "active" : ""}`} onClick={() => setOrder(o)}>
            {o}
          </button>
        ))}
        <span className="grow" />
        <span className="mono faint small">{list.length}</span>
      </div>
      <div className="m-collection-body">
        {!doc && <p className="m-empty dim">Loading the artists…</p>}
        {doc && !list.length && <p className="m-empty dim">{q ? "No artist is called that." : "No artists yet: add one with the plus above."}</p>}
        <div className="artists-grid">
          {list.map((x) => (
            <ArtistCard key={x.id} artist={x} count={counts[x.id] ?? 0} albums={albumCounts[x.id] ?? 0} toCheck={0} onOpen={() => setOpen(x.id)} />
          ))}
        </div>
      </div>
    </>
  );
}

function ArtistPage({ artist }: { artist: LocalArtist }) {
  const a = useArtists();
  const all = useStore((s) => s.allItems);
  const allAlbums = useStore((s) => s.albums);
  const items = useMemo(() => all.filter((i) => a.doc?.items[i.key]?.includes(artist.id)), [all, a.doc, artist.id]);
  const albums = useMemo(() => eachOnce(allAlbums).filter((al) => a.doc?.items[albumArtistKey(al.key)]?.includes(artist.id)), [allAlbums, a.doc, artist.id]);
  const rename = async () => {
    const name = await askText({ title: "Rename artist", message: <>New name for <b>{artist.name}</b>:</>, initial: artist.name, confirm: "Rename" });
    if (name) a.rename(artist.id, name);
  };
  const remove = async () => {
    if (await ask({ title: "Remove artist", message: <>Remove <b>{artist.name}</b>? Their pictures stay in the library.</>, confirm: "Remove", danger: true })) a.remove(artist.id);
  };
  return (
    <>
      <MobileTop current="artists" />
      <div className="m-page-head">
        <button className="m-icon" aria-label="All artists" onClick={() => a.setOpen(null)}>
          <ArrowLeft />
        </button>
        <ArtistIcon artist={artist} size={40} />
        <div className="m-page-name">
          <b className="ellipsis">{artist.name}</b>
          <span className="mono faint small">
            {items.length} picture{items.length === 1 ? "" : "s"}
            {albums.length ? ` · ${albums.length} album${albums.length === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        <button className="m-icon" aria-label="Rename" onClick={() => void rename()}>
          <PencilSimple />
        </button>
        <button className="m-icon danger" aria-label="Remove" onClick={() => void remove()}>
          <Trash />
        </button>
      </div>
      <TileGrid
        items={items}
        memory={`m-artist-${artist.id}`}
        head={
          albums.length > 0 && (
            <div className="m-album-row">
              {albums.map((al) => (
                <AlbumCard key={al.key} album={al} onMenu={ignoreMenu} />
              ))}
            </div>
          )
        }
      />
    </>
  );
}
