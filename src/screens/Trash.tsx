import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { Modal } from "../components/Modal";
import { Thumb } from "../components/Thumb";
import { formatBytes } from "../lib/format";
import type { MediaItem } from "../lib/types";

export function Trash() {
  const s = useStore();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const bytes = items.reduce((a, i) => a + i.size, 0);

  const reload = () => {
    if (s.root && s.library) api.scanTrash(s.root, s.library).then(setItems).catch((e) => s.toast(String(e), "error"));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [s.root]);

  const restore = async (item: MediaItem) => {
    if (!s.root) return;
    setBusy(true);
    try {
      await api.moveItem(s.root, item, "");
      s.toast(`Restored ${item.name} to the root folder`, "ok");
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
      {items.length === 0 ? (
        <p className="dim">Trash is empty.</p>
      ) : (
        <div className="grid small">
          {items.map((it) => (
            <div key={it.primary} className="trash-tile">
              <Thumb item={it} rating={s.library?.ratings[it.key]} onClick={() => {}} />
              <button className="btn sm" disabled={busy} onClick={() => void restore(it)}>
                Restore to root
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
