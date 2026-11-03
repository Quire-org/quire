import { ArrowRight, Check, X } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { Flag } from "./Flag";
import { useStore } from "../store";
import { thumbUrl, canThumb } from "../lib/api";
import { versionsKey, type VersionPair } from "../lib/versions";
import type { Album } from "../lib/types";

/** Albums that look like one work in two languages: linked as original and translation, or said not to be. */
export function VersionsReview({ pairs, onClose }: { pairs: VersionPair[]; onClose: () => void }) {
  const albums = useStore((s) => s.albums);
  const lib = useStore((s) => s.library);
  const byKey = new Map(albums.map((a) => [a.key, a]));
  const link = (p: VersionPair) => useStore.getState().setTranslation(p.original, p.translation);
  const notSame = (p: VersionPair) => {
    const l = useStore.getState().library;
    if (!l) return;
    useStore.setState({ library: { ...l, albumNotVersions: [...new Set([...(l.albumNotVersions ?? []), versionsKey(p.original, p.translation)])] } });
    void useStore.getState().saveLibrary();
  };
  const shown = pairs.filter((p) => byKey.has(p.original) && byKey.has(p.translation));
  if (!shown.length) return null;
  return (
    <Modal title={`${shown.length} work${shown.length === 1 ? "" : "s"} in two languages?`} onClose={onClose} wide>
      <p className="dim">These came in from the same artist with about as many pages and most of their tags the same, in another language. Linked, they are one album: the translation is read through its original, and tags, artist and rating go on both.</p>
      <div className="source-list">
        {shown.map((p) => (
          <div key={`${p.original}|${p.translation}`} className="version-row">
            <Side album={byKey.get(p.original)!} code={lib?.albumLanguages?.[p.original]} />
            <ArrowRight className="dim" />
            <Side album={byKey.get(p.translation)!} code={lib?.albumLanguages?.[p.translation]} />
            <div className="source-acts">
              <button className="btn sm primary" onClick={() => link(p)} title="The second is a translation of the first">
                <Check /> Link
              </button>
              <button className="btn sm ghost" onClick={() => notSame(p)}>
                <X /> Not the same
              </button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function Side({ album, code }: { album: Album; code?: string }) {
  const root = useStore((s) => s.root);
  return (
    <div className="version-side">
      <div className="source-pic">{album.cover && root && canThumb(album.cover) ? <img src={thumbUrl(root, album.cover, 160)} alt="" /> : null}</div>
      <div className="source-what">
        <span className="row">
          {code && <Flag code={code} size={14} />}
          <b className="ellipsis">{album.name}</b>
        </span>
        <span className="small dim">{album.count} pages</span>
      </div>
    </div>
  );
}
