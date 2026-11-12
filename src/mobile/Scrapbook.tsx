import { useEffect, useMemo, useState } from "react";
import { X } from "@phosphor-icons/react";
import { FitImage } from "../components/FitImage";
import { pageOf, type ScrapDoc } from "../scrapbook/model";
import { useCoverUrl } from "../scrapbook/pictures";
import { useScrapbook } from "../scrapbook/store";
import { useStore } from "../store";
import { nameOf, useTags } from "../tagsStore";
import { MobileTop } from "./TopBar";

type Shown = { url: string; name: string };

function Card({ book, name, kind, ratio, onShow }: { book: string; name: string; kind: "album" | "tag" | "board"; ratio?: string; onShow: (s: Shown) => void }) {
  const url = useCoverUrl(book);
  return (
    <div className={`cover-card panel ${kind}`}>
      <button className="cover-card-pic" style={ratio ? { aspectRatio: ratio } : undefined} disabled={!url} aria-label={`Show ${name}`} onClick={() => url && onShow({ url, name })}>
        {url ? <img src={url} alt="" draggable={false} /> : <span className="dim small">…</span>}
      </button>
      <span className="ellipsis small">{name}</span>
    </div>
  );
}

/** What was made in the Scrapbook, to look at: covers, tag banners and boards. They are made and changed on the computer. */
export function MobileScrapbook() {
  const root = useStore((s) => s.root);
  const albums = useStore((s) => s.albums);
  const albumCovers = useStore((s) => s.library?.albumCovers);
  const tagCovers = useTags((t) => t.data?.covers);
  const books = useScrapbook((x) => x.lib?.books);
  const [tab, setTab] = useState<"covers" | "boards">("covers");
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    void useScrapbook.getState().load();
    void useTags.getState().load();
    void useStore.getState().loadAlbums();
  }, [root]);
  const boards = useMemo(() => Object.values(books ?? {}).filter((b: ScrapDoc) => b.kind === "board").sort((a, b) => b.updated - a.updated), [books]);
  const covers = useMemo(
    () => [
      ...Object.entries(albumCovers ?? {}).map(([key, book]) => ({ book, kind: "album" as const, name: albums.find((a) => a.key === key)?.name ?? key.split("/").pop() ?? key })),
      ...Object.entries(tagCovers ?? {}).map(([id, book]) => ({ book, kind: "tag" as const, name: nameOf(id) })),
    ],
    [albumCovers, tagCovers, albums],
  );
  const closeShown = () => {
    useStore.getState().setZoom({ ...useStore.getState().zoom, level: 0, focal: { x: 0.5, y: 0.5 }, pan: { px: 0, py: 0 } });
    setShown(null);
  };
  return (
    <div className="m-collection">
      <MobileTop current="scrapbook" />
      <div className="m-filters-row chips">
        {(["covers", "boards"] as const).map((t) => (
          <button key={t} className={`btn sm ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
        <span className="grow" />
        <span className="mono faint small">{tab === "covers" ? covers.length : boards.length}</span>
      </div>
      <div className="m-collection-body">
        {tab === "covers" && !covers.length && <p className="m-empty dim">No covers yet: they are made on your computer.</p>}
        {tab === "boards" && !boards.length && <p className="m-empty dim">No boards yet: they are made on your computer.</p>}
        <div className="m-scrap-grid">
          {tab === "covers" && covers.map((c) => <Card key={c.book} book={c.book} name={c.name} kind={c.kind} onShow={setShown} />)}
          {tab === "boards" &&
            boards.map((b) => {
              const { w, h } = pageOf(b);
              return <Card key={b.id} book={b.id} name={b.name || "Board"} kind="board" ratio={`${w} / ${h}`} onShow={setShown} />;
            })}
        </div>
      </div>
      {shown && (
        <div className="m-full" role="dialog" aria-label={shown.name}>
          <FitImage src={shown.url} mode="fit" alt={shown.name} zoomable />
          <button className="m-icon m-full-close" aria-label="Close" onClick={closeShown}>
            <X />
          </button>
        </div>
      )}
    </div>
  );
}
