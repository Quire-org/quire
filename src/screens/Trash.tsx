import { useEffect, useState } from "react";
import { applyMove, followMoves, useStore } from "../store";
import { api, storedPath } from "../lib/api";
import { dirOf } from "../lib/moves";
import { Modal } from "../components/Modal";
import { Thumb } from "../components/Thumb";
import { formatBytes } from "../lib/format";
import type { MediaItem } from "../lib/types";

export function Trash() {
  const s = useStore();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // The originals kept out of sight for Revert: not in the trash, but deleted for good from here too.
  const [kept, setKept] = useState<{ originals: number; bytes: number } | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const bytes = items.reduce((a, i) => a + i.size, 0);

  const reload = () => {
    if (s.root && s.library) api.scanTrash(s.root, s.library).then(setItems).catch((e) => s.toast(String(e), "error"));
    if (s.root) api.keptOriginals(s.root).then(setKept).catch(() => setKept(null));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [s.root]);

  // What is in the trash and where it came from (noted when it was trashed); the root for older entries.
  const from = s.library?.trashFrom ?? {};
  const trashPrefix = `${(s.library?.trashDir ?? "").replace(/\/+$/, "")}/`;
  // Albums trashed whole: a folder each, restored whole; their pages aren't listed one by one.
  const folders = Object.entries(from).filter(([k]) => items.some((i) => i.key.startsWith(`${k}/`))).map(([k, orig]) => ({ key: k, orig, name: k.slice(trashPrefix.length), items: items.filter((i) => i.key.startsWith(`${k}/`)) }));
  const loose = items.filter((i) => !folders.some((f) => i.key.startsWith(`${f.key}/`)));

  const restore = async (item: MediaItem) => {
    if (!s.root) return;
    setBusy(true);
    try {
      // Back where it came from; to the root folder when that isn't known or is gone.
      const dest = from[item.key] ? dirOf(from[item.key]) : "";
      const res = await api.moveItem(s.root, item, dest).catch(() => (dest ? api.moveItem(s.root!, item, "") : Promise.reject(new Error(`could not restore ${item.name}`))));
      // Through the store, as a move in the app: its rating, identity, series place and, by its
      // key, its tags, faces and artist go with it (moving the file alone left them in the trash).
      applyMove(res.moved, item, res.item, `Restored ${item.name}`);
      s.toast(`Restored ${item.name} to ${res.item.dir || "the root folder"}`, "ok");
      reload();
      void s.rescan();
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const restoreFolder = async (f: { key: string; orig: string; name: string }) => {
    if (!s.root) return;
    setBusy(true);
    try {
      const parent = dirOf(f.orig);
      const moved = await api.moveDir(s.root, `${s.root}/${f.key}`, parent ? `${s.root}/${parent}` : s.root).catch(() => (parent ? api.moveDir(s.root!, `${s.root}/${f.key}`, s.root!) : Promise.reject(new Error(`could not restore ${f.name}`))));
      const to = storedPath(s.root, moved);
      // The album's rating, tags, language, cover and translation link, and its pages' everything, go back with it.
      followMoves([[f.key, to]]);
      const lib = useStore.getState().library!;
      useStore.setState({ library: { ...lib, trashFrom: Object.fromEntries(Object.entries(lib.trashFrom ?? {}).filter(([k]) => k !== f.key)) }, allStale: true, albumsLoaded: false });
      void useStore.getState().saveLibrary();
      s.toast(`Restored ${f.name} to ${parent || "the root folder"}`, "ok");
      reload();
      void s.rescan();
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const purge = async () => {
    setBusy(true);
    try {
      const n = await s.emptyTrash();
      s.toast(`Permanently deleted ${n} files`, "warn");
      setItems([]);
      setConfirm(false);
      reload();
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const forgetKept = async () => {
    if (!s.root) return;
    setBusy(true);
    try {
      const n = await api.keptOriginalsForget(s.root);
      s.toast(`Deleted ${n} kept original${n === 1 ? "" : "s"} for good`, "warn");
      setForgetting(false);
      reload();
      void import("../versionsStore").then(({ useVersions }) => useVersions.getState().load(true));
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Trash" onClose={() => s.set({ trashOpen: false })} wide>
      <div className="sec-head">
        <span className="dim">
          <span className="mono">{items.length}</span> items, <span className="mono">{formatBytes(bytes)}</span> in{" "}
          <span className="mono">{s.library?.trashDir}</span>
        </span>
        {confirm ? (
          <span className="row">
            <span className="mono" style={{ color: "var(--danger)" }}>
              This cannot be undone.
            </span>
            <button className="btn sm danger" disabled={busy} onClick={() => void purge()}>
              Yes, delete everything
            </button>
            <button className="btn sm ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="btn sm danger" disabled={items.length === 0 || busy} onClick={() => setConfirm(true)}>
            Empty trash
          </button>
        )}
      </div>
      {kept && kept.originals > 0 && (
        <div className="sec-head">
          <span className="dim">
            Also kept, out of sight: <span className="mono">{kept.originals}</span> original{kept.originals === 1 ? "" : "s"} of pictures edited in place, <span className="mono">{formatBytes(kept.bytes)}</span>, so Revert in Info can bring them back. Each goes with its version when that is deleted for good.
          </span>
          {forgetting ? (
            <span className="row">
              <span className="mono" style={{ color: "var(--danger)" }}>
                Their versions stay, but can't be reverted.
              </span>
              <button className="btn sm danger" disabled={busy} onClick={() => void forgetKept()}>
                Yes, delete them
              </button>
              <button className="btn sm ghost" onClick={() => setForgetting(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="btn sm ghost" disabled={busy} onClick={() => setForgetting(true)}>
              Delete the originals
            </button>
          )}
        </div>
      )}
      {items.length === 0 ? (
        <p className="dim">Trash is empty.</p>
      ) : (
        <div className="grid small">
          {folders.map((f) => (
            <div key={f.key} className="trash-tile">
              <Thumb item={f.items[0]} rating={s.library?.albumRatings[f.key]} onClick={() => {}} />
              <span className="ellipsis small" title={f.name}>
                {f.name} · {f.items.length}
              </span>
              <button className="btn sm" disabled={busy} onClick={() => void restoreFolder(f)}>
                Restore album
              </button>
            </div>
          ))}
          {loose.map((it) => (
            <div key={it.primary} className="trash-tile">
              <Thumb item={it} rating={s.library?.ratings[it.key]} onClick={() => {}} />
              <button className="btn sm" disabled={busy} onClick={() => void restore(it)} title={from[it.key] ? `Back to ${dirOf(from[it.key]) || "the root folder"}` : "Where it came from isn't known: to the root folder"}>
                {from[it.key] ? "Restore" : "Restore to root"}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
