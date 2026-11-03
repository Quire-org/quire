import { useEffect, useMemo, useState } from "react";
import { BookOpen, Books, MagnifyingGlass, PaintBrush, Plus, Tag as TagIcon, X } from "@phosphor-icons/react";
import { TopNav } from "../components/TopNav";
import { Modal } from "../components/Modal";
import { StickerBook } from "../components/StickerBook";
import { ask } from "../components/Confirm";
import { eachOnce, useStore } from "../store";
import { allTags, nameOf, typeOf, useTags } from "../tagsStore";
import { useScrapbook } from "../scrapbook/store";
import { useCoverUrl } from "../scrapbook/pictures";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import type { Target } from "../scrapbook/model";

/**
 * Scrapbook: every cover made (album covers, tag banners), to open again or start a new one, and
 * the sticker book of your own and the built-in stickers.
 */
export function Scrapbook() {
  const s = useStore((x) => x);
  const [tab, setTab] = useState<"covers" | "stickers">("covers");
  const [choosing, setChoosing] = useState(false);
  // The right end of the tab bar, where the sticker book's page slider sits.
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const albums = s.albums;
  const albumCovers = s.library?.albumCovers;
  const tagCovers = useTags((x) => x.data?.covers);

  useEffect(() => {
    void useScrapbook.getState().load();
    void useTags.getState().load();
    if (!useStore.getState().albums.length) void useStore.getState().loadAlbums();
  }, [s.root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || dialogOpen()) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === "b") st.openBrowse();
      else if (key === "a") st.openAlbums();
      else if (key === "d") st.openDupes();
      else if (key === "e") st.openFiles();
      else if (key === "l") st.openTags();
      else if (key === "p") st.openPeople();
      else if (key === "w") st.openArtists();
      else if (key === "escape" && !useScrapbook.getState().studio) st.openSortQueue();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const albumTargets = useMemo(
    () =>
      Object.entries(albumCovers ?? {}).map(([key, book]) => ({ target: { kind: "album", key, name: albums.find((a) => a.key === key)?.name ?? key.split("/").pop() ?? key } as Target, book })),
    [albumCovers, albums],
  );
  const tagTargets = useMemo(() => Object.entries(tagCovers ?? {}).map(([id, book]) => ({ target: { kind: "tag", id, name: nameOf(id) } as Target, book })), [tagCovers]);

  return (
    <div className="screen scrapbook-home">
      <TopNav current="scrapbook" />
      <div className="page-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "covers"} className={`page-tab ${tab === "covers" ? "active" : ""}`} onClick={() => setTab("covers")}>
          <Books /> Covers
        </button>
        <button role="tab" aria-selected={tab === "stickers"} className={`page-tab ${tab === "stickers" ? "active" : ""}`} onClick={() => setTab("stickers")}>
          <BookOpen /> Stickers
        </button>
        <span className="grow" />
        <div className="page-tabs-end" ref={setBar} />
      </div>
      {tab === "covers" ? (
        <div className="covers-home">
          <div className="row covers-head">
            <span className="label">Album covers</span>
            <span className="grow" />
            <button className="btn sm primary" onClick={() => setChoosing(true)}>
              <Plus /> New cover
            </button>
          </div>
          <div className="covers-grid album">
            {albumTargets.map(({ target, book }) => (
              <CoverCard key={book} target={target} book={book} />
            ))}
            {!albumTargets.length && <div className="dim small">No album covers yet. “New cover” makes one, or right-click an album.</div>}
          </div>
          <div className="row covers-head">
            <span className="label">Tag banners</span>
          </div>
          <div className="covers-grid tag">
            {tagTargets.map(({ target, book }) => (
              <CoverCard key={book} target={target} book={book} />
            ))}
            {!tagTargets.length && <div className="dim small">No tag banners yet. “New cover” makes one, or open a tag's settings.</div>}
          </div>
        </div>
      ) : (
        <StickerBook bar={bar} onMake={() => void useScrapbook.getState().openStudio({})} />
      )}
      {choosing && <NewCover onClose={() => setChoosing(false)} />}
    </div>
  );
}

function CoverCard({ target, book }: { target: Target; book: string }) {
  const url = useCoverUrl(book);
  const open = () => void useScrapbook.getState().open(target);
  return (
    <div className={`cover-card panel ${target.kind}`}>
      <button className="cover-card-pic" onClick={open} title="Edit it">
        {url ? <img src={url} alt="" draggable={false} /> : <span className="dim small">…</span>}
      </button>
      <div className="cover-card-foot">
        {target.kind === "album" ? <Books /> : <TagIcon />}
        <span className="ellipsis grow" title={target.name}>
          {target.name}
        </span>
        {target.kind === "tag" && <span className="dim small">{typeOf(target.id)}</span>}
        <button className="btn sm ghost" title="Edit" onClick={open}>
          <PaintBrush />
        </button>
        <button
          className="btn sm ghost"
          title="Remove the cover"
          onClick={() => void ask({ title: "Remove the cover", message: <>Remove the scrapbook cover of <b>{target.name}</b>?</>, confirm: "Remove", danger: true }).then((ok) => void (ok && useScrapbook.getState().removeCover(target)))}
        >
          <X />
        </button>
      </div>
    </div>
  );
}

/** A new cover: for an album, or a banner for a tag. */
function NewCover({ onClose }: { onClose: () => void }) {
  const albums = useStore((x) => x.albums);
  const covered = useStore((x) => x.library?.albumCovers ?? {});
  const tagData = useTags((x) => x.data);
  const [kind, setKind] = useState<"album" | "tag">("album");
  const [q, setQ] = useState("");
  const t = q.trim().toLowerCase();
  // A translated version shows as its original, with the original's cover.
  const albumList = eachOnce(albums).filter((a) => !t || a.name.toLowerCase().includes(t)).slice(0, 200);
  const tagList = (tagData ? allTags(tagData) : []).filter((id) => !t || id.toLowerCase().includes(t)).slice(0, 200);
  const start = (target: Target) => {
    onClose();
    void useScrapbook.getState().open(target);
  };
  return (
    <Modal title="New cover" onClose={onClose}>
      <div className="new-cover">
        <div className="row">
          <span className="btn-group">
            <button className={`btn sm ${kind === "album" ? "active" : "ghost"}`} onClick={() => setKind("album")}>
              <Books /> An album
            </button>
            <button className={`btn sm ${kind === "tag" ? "active" : "ghost"}`} onClick={() => setKind("tag")}>
              <TagIcon /> A tag's banner
            </button>
          </span>
        </div>
        <div className="row search-field">
          <MagnifyingGlass className="dim" />
          <input className="input grow" autoFocus placeholder={kind === "album" ? "Find an album" : "Find a tag"} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="new-cover-list">
          {kind === "album"
            ? albumList.map((a) => (
                <button key={a.key} className="tags-row" onClick={() => start({ kind: "album", key: a.key, name: a.name })}>
                  <Books /> <span className="ellipsis grow">{a.name}</span>
                  {covered[a.key] && <span className="dim small">has one: edit</span>}
                </button>
              ))
            : tagList.map((id) => (
                <button key={id} className="tags-row" onClick={() => start({ kind: "tag", id, name: nameOf(id) })}>
                  <TagIcon /> <span className="ellipsis grow">{nameOf(id)}</span>
                  <span className="dim small">{tagData?.covers?.[id] ? "has one: edit" : typeOf(id)}</span>
                </button>
              ))}
          {(kind === "album" ? !albumList.length : !tagList.length) && <div className="dim small">Nothing by that name.</div>}
        </div>
      </div>
    </Modal>
  );
}
