import { useEffect, useMemo, useState } from "react";
import { Minus, Plus } from "@phosphor-icons/react";
import { useArtists } from "../artistsStore";
import { ArtistIcon } from "./ArtistIcon";

/**
 * The artist of a selection of pictures (one a picture, so picked like a radio button): picked when
 * every picture is theirs (a dash when some are); a click gives them all to that artist (in place of
 * any other), or, picked, takes them away. Found by name or by their account on a platform (in Latin letters, for a name in
 * another script), with their icon. Typing a name not there yet and Enter makes a new artist.
 */
export function ArtistPicker({ keys }: { keys: string[] }) {
  const a = useArtists();
  const [q, setQ] = useState("");
  useEffect(() => {
    void a.load();
  }, [a]);
  const artists = useMemo(() => Object.values(a.doc?.artists ?? {}).sort((x, y) => x.name.localeCompare(y.name)), [a.doc]);
  const needle = q.trim().toLowerCase();
  const shown = artists.filter((x) => !needle || x.name.toLowerCase().includes(needle) || x.links.some((l) => l.account.toLowerCase().includes(needle)));
  const exact = artists.some((x) => x.name.toLowerCase() === needle);
  const have = (id: string) => keys.filter((k) => a.doc?.items[k]?.includes(id)).length;

  const toggle = (id: string) => (have(id) === keys.length ? a.unassign(keys, id) : a.assign(keys, id));
  const make = () => {
    const id = a.create(q);
    if (id) (a.assign(keys, id), setQ(""));
  };

  return (
    <div className="artist-picker">
      <input
        className="input"
        autoFocus
        placeholder="Find or add an artist"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key !== "Enter") return;
          // The artist named, or the only one left; a name matching no one is a new artist.
          const target = artists.find((x) => x.name.toLowerCase() === needle) ?? (shown.length === 1 ? shown[0] : null);
          if (target) toggle(target.id);
          else if (needle && !shown.length) make();
        }}
      />
      <div className="artist-picker-list">
        {shown.map((x) => {
          const n = have(x.id);
          return (
            <button key={x.id} className={`artist-picker-row ${n === keys.length ? "on" : n ? "some" : ""}`} onClick={() => toggle(x.id)} title={n === keys.length ? `Not ${x.name}'s` : `Give ${keys.length === 1 ? "it" : "them"} to ${x.name}`}>
              <span className="artist-picker-tick">{n === keys.length ? <span className="artist-picker-dot" /> : n ? <Minus /> : null}</span>
              <ArtistIcon artist={x} size={22} />
              <span className="artist-picker-name">
                <span className="ellipsis">{x.name}</span>
                {x.links[0]?.account && <span className="ellipsis faint small">@{x.links[0].account}</span>}
              </span>
            </button>
          );
        })}
        {needle && !exact && (
          <button className="artist-picker-row" onClick={make}>
            <span className="artist-picker-tick">
              <Plus />
            </span>
            <span className="grow ellipsis">New artist “{q.trim()}”</span>
          </button>
        )}
        {!shown.length && !needle && <div className="small dim">No artists yet: type a name.</div>}
      </div>
    </div>
  );
}
