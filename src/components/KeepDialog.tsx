import { useStore } from "../store";
import { usePlugins } from "../plugins/store";
import { finishKeep } from "../plugins/host";
import { Modal } from "./Modal";
import { FloppyDisk } from "@phosphor-icons/react";

/** A plugin made a new version of an item (`media.keep`): the reader keeps it in place of the original (kept for Revert), as a copy, or not at all. */
export function KeepDialog() {
  const keeping = usePlugins((s) => s.keeping);
  const list = usePlugins((s) => s.list);
  const items = useStore((s) => s.allItems);
  const queue = useStore((s) => s.queue);
  if (!keeping) return null;
  const plugin = list.find((p) => p.id === keeping.pluginId)?.manifest?.name ?? keeping.pluginId;
  const item = queue.find((i) => i.key === keeping.itemKey) ?? items.find((i) => i.key === keeping.itemKey);
  const busy = keeping.busy;
  return (
    <Modal title={`Keep the result from ${plugin}?`} onClose={() => !busy && void finishKeep(null)}>
      <p className="small">
        <span className="mono">{item?.name ?? keeping.itemKey}</span>
        {item?.files.length ? <span className="dim"> · {item.files.length > 1 ? `${item.files.length} files` : "1 file"}</span> : null}
      </p>
      <p className="dim small">
        Overwrite puts the result in its place and keeps the original out of sight: Revert in Info brings it back. Save as copy keeps both, with <span className="mono">{keeping.name}</span> next to it, and Info says which it was made from.
      </p>
      <div className="row pop-actions">
        <button className="btn ghost" onClick={() => void finishKeep(null)} disabled={busy}>
          Cancel
        </button>
        <span className="grow" />
        <button className="btn" onClick={() => void finishKeep("copy")} disabled={busy} title="Keep the original and save the result next to it">
          Save as copy
        </button>
        <button className="btn primary" autoFocus onClick={() => void finishKeep("replace")} disabled={busy} title="The result takes the original's place; the original is kept, and Revert in Info brings it back">
          <FloppyDisk /> {busy ? "Saving…" : "Overwrite"}
        </button>
      </div>
    </Modal>
  );
}
