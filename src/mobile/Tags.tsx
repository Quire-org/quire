import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { ArrowLeft, MagnifyingGlass, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { ask, askText } from "../components/Confirm";
import { renameTagTo } from "../components/TagBits";
import { AlbumCard } from "../screens/Albums";
import { eachOnce, useStore } from "../store";
import { albumKeyOf, nameOf, tagIdFrom, treeOfType, typeOf, useTags } from "../tagsStore";
import { TileGrid } from "./TileGrid";
import { MobileTop } from "./TopBar";

const ignoreMenu = (e: MouseEvent) => e.preventDefault();

/** The library's tags by folder: found, made, renamed, deleted, and what carries each. Merging, subtags and folder rules are on the computer. */
export function MobileTags() {
  const root = useStore((s) => s.root);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void useTags.getState().load();
    void useStore.getState().loadAll();
    void useStore.getState().loadAlbums();
  }, [root]);
  return <div className="m-collection">{open ? <TagPage id={open} onMoved={setOpen} /> : <Folders onOpen={setOpen} />}</div>;
}

function Folders({ onOpen }: { onOpen: (id: string) => void }) {
  const d = useTags((s) => s.data);
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const needle = q.trim().toLowerCase();
  const folders = useMemo(() => (d ? d.types.map((type) => ({ type, tags: treeOfType(d, type).filter((t) => !needle || t.name.toLowerCase().includes(needle)) })).filter((f) => f.tags.length || !needle) : []), [d, needle]);
  const add = async () => {
    const typed = await askText({ title: "New tag", message: d?.types.length ? <>As folder/name, or just a name to put it in <b>{d.types[0]}</b>:</> : "As folder/name, or just a name:", initial: "", confirm: "Make it" });
    const id = typed ? tagIdFrom(typed, d?.types ?? []) : null;
    if (id) useTags.getState().addTag(id);
  };
  return (
    <>
      <MobileTop current="tags">
        <button className={`m-icon ${searching ? "on" : ""}`} aria-label="Search" onClick={() => (searching && setQ(""), setSearching(!searching))}>
          <MagnifyingGlass />
        </button>
        <button className="m-icon" aria-label="New tag" onClick={() => void add()}>
          <Plus />
        </button>
      </MobileTop>
      {searching && (
        <div className="m-search">
          <input className="input" autoFocus type="search" autoCorrect="off" autoCapitalize="off" spellCheck={false} placeholder="Search tags" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      <div className="m-collection-body">
        {!d && <p className="m-empty dim">Loading the tags…</p>}
        {d && !folders.length && <p className="m-empty dim">{needle ? "No tag is called that." : "No tags yet: make one with the plus above."}</p>}
        {folders.map((f) => (
          <section key={f.type} className="m-tag-folder">
            <div className="label">{f.type}</div>
            <div className="m-tag-chips">
              {f.tags.map((t) => (
                <button key={t.id} className="btn sm" onClick={() => onOpen(t.id)}>
                  {t.name} <span className="mono faint small">{t.count}</span>
                </button>
              ))}
              {!f.tags.length && <span className="dim small">Nothing in it yet.</span>}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function TagPage({ id, onMoved }: { id: string; onMoved: (id: string | null) => void }) {
  const d = useTags((s) => s.data);
  const all = useStore((s) => s.allItems);
  const allAlbums = useStore((s) => s.albums);
  const items = useMemo(() => all.filter((i) => d?.tags[i.key]?.includes(id)), [all, d, id]);
  const albums = useMemo(() => eachOnce(allAlbums).filter((al) => d?.tags[albumKeyOf(al.key)]?.includes(id)), [allAlbums, d, id]);
  const name = nameOf(id);
  const rename = async () => {
    const to = await askText({ title: "Rename tag", message: <>New name for <b>{name}</b>:</>, initial: name, confirm: "Rename" });
    if (!to) return;
    await renameTagTo(id, to);
    const moved = `${typeOf(id)}/${to.trim().replace(/\//g, " ")}`;
    if (useTags.getState().data?.types.includes(typeOf(id))) onMoved(moved);
  };
  const remove = async () => {
    if (!(await ask({ title: "Delete tag", message: <>Take <b>{name}</b> off everything that carries it? The pictures stay.</>, confirm: "Delete", danger: true }))) return;
    useTags.getState().removeTag(id);
    onMoved(null);
  };
  return (
    <>
      <MobileTop current="tags" />
      <div className="m-page-head">
        <button className="m-icon" aria-label="All tags" onClick={() => onMoved(null)}>
          <ArrowLeft />
        </button>
        <div className="m-page-name">
          <b className="ellipsis">{name}</b>
          <span className="mono faint small">
            {typeOf(id)} · {items.length + albums.length}
          </span>
        </div>
        <button className="m-icon" aria-label="Rename" onClick={() => void rename()}>
          <PencilSimple />
        </button>
        <button className="m-icon danger" aria-label="Delete" onClick={() => void remove()}>
          <Trash />
        </button>
      </div>
      <TileGrid
        items={items}
        memory={`m-tag-${id}`}
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
