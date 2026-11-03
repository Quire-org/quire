import { useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { ArtistIcon } from "./ArtistIcon";
import { countsOf, useArtists, type LocalArtist } from "../artistsStore";

/** A name as names are compared: its letters and digits, in any case. */
const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** How much two names look like one person's: the same, one inside the other, or the same beginning. */
function alike(a: string, b: string): number {
  const [x, y] = [bare(a), bare(b)];
  if (!x || !y) return 0;
  if (x === y) return 3;
  if (x.includes(y) || y.includes(x)) return 2;
  return x.slice(0, 4) === y.slice(0, 4) && x.length >= 4 ? 1 : 0;
}

/**
 * One of the library's artists to link a platform account to (the same person there too): the ones
 * whose names look like it first, then everyone by how many pictures they have; found by typing.
 */
export function ArtistLinkPicker({ name, title, onPick, onClose, without }: { name: string; title: string; onPick: (artist: LocalArtist) => void; onClose: () => void; without?: string }) {
  const doc = useArtists((a) => a.doc);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const counts = countsOf(doc);
    const albums = countsOf(doc, true);
    const needle = bare(q);
    return Object.values(doc?.artists ?? {})
      .filter((a) => a.id !== without && (!needle || bare(`${a.name} ${a.links.map((l) => l.account).join(" ")}`).includes(needle)))
      .map((a) => ({ a, like: Math.max(alike(a.name, name), ...a.links.map((l) => alike(l.account, name))), n: (counts[a.id] ?? 0) + (albums[a.id] ?? 0) }))
      .sort((x, y) => y.like - x.like || y.n - x.n || x.a.name.localeCompare(y.a.name));
  }, [doc, q, name, without]);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="row search-field">
        <MagnifyingGlass className="dim" />
        <input className="input grow" autoFocus placeholder="Find one of your artists" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && list[0] && onPick(list[0].a)} />
      </div>
      <div className="pick-list artist-link-list">
        {list.slice(0, 60).map(({ a, like, n }) => (
          <button key={a.id} className="pick-row" onClick={() => onPick(a)}>
            <ArtistIcon artist={a} size={28} />
            <span className="ellipsis grow">{a.name}</span>
            {like > 0 && <span className="badge accent2">Looks alike</span>}
            <span className="faint small">
              {a.links.map((l) => l.platform).join(", ")}
              {n ? ` · ${n}` : ""}
            </span>
          </button>
        ))}
        {!list.length && <div className="dim small">{q ? "No artist of yours by that name." : "No artists of yours yet."}</div>}
      </div>
    </Modal>
  );
}
