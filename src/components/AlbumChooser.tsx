import { useState } from "react";
import { Modal } from "./Modal";
import { Thumb } from "./Thumb";
import { useStore } from "../store";
import type { Album } from "../lib/types";

/** Pick one album from all of them, by name. */
export function AlbumChooser({ title, except, onPick, onClose }: { title: string; except?: string; onPick: (album: Album | null) => void; onClose: () => void }) {
  const albums = useStore((s) => s.albums);
  const [q, setQ] = useState("");
  const list = albums.filter((a) => a.key !== except && (!q.trim() || a.name.toLowerCase().includes(q.trim().toLowerCase()) || a.key.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 60);
  return (
    <Modal title={title} onClose={onClose}>
      <input className="input" autoFocus placeholder="Find an album…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="album-chooser">
        {list.map((a) => (
          <button key={a.key} className="album-chooser-row" onClick={() => onPick(a)} title={a.path}>
            <span className="album-chooser-thumb">{a.cover && <Thumb item={a.cover} eager aspect={1} onClick={() => {}} />}</span>
            <span className="ellipsis grow">{a.name}</span>
            <span className="dim mono small">{a.count}</span>
          </button>
        ))}
        {!list.length && <div className="dim small">No album matches.</div>}
      </div>
      <div className="row pop-actions">
        <button className="btn ghost" onClick={() => onPick(null)}>
          None
        </button>
        <span className="grow" />
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
