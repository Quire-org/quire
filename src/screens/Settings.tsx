import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api, pickFolder } from "../lib/api";
import { Modal } from "../components/Modal";
import { themes, applyTheme, loadThemeId } from "../themes";
import { RESERVED_KEYS } from "../lib/hotkeys";
import { formatBytes, tailPath } from "../lib/format";
import type { TrashInfo } from "../lib/types";

export function Settings() {
  const s = useStore();
  const targets = s.library?.targets ?? [];
  const [theme, setTheme] = useState(loadThemeId());
  const [trash, setTrash] = useState<TrashInfo | null>(null);

  useEffect(() => {
    if (s.root && s.library) api.trashInfo(s.root, s.library).then(setTrash).catch(() => {});
  }, [s.root, s.library, s.trashOpen]);

  const add = async () => {
    const dir = await pickFolder("Choose a target folder", s.lastTargetParent ?? s.root ?? undefined);
    if (dir) s.addTarget(dir);
  };

  const setHotkey = (id: string, raw: string) => {
    const k = raw.trim().toLowerCase().slice(-1);
    if (k && RESERVED_KEYS.has(k)) {
      s.toast(`"${k}" is reserved by the viewer`, "warn");
      return;
    }
    if (k && targets.some((t) => t.id !== id && t.hotkey === k)) {
      s.toast(`"${k}" is already used`, "warn");
      return;
    }
    s.updateTarget(id, { hotkey: k });
  };

  return (
    <Modal title="Settings" onClose={() => s.set({ settingsOpen: false })} wide>
      <section>
        <div className="sec-head">
          <h3>Target folders</h3>
          <button className="btn primary sm" onClick={() => void add()}>
            + Add folder
          </button>
        </div>
        {targets.length === 0 && <p className="dim">Add the folders you want to sort into. Each gets a hotkey.</p>}
        <div className="target-list">
          {targets.map((t) => (
            <div key={t.id} className="target-row">
              <input className="input hot" value={t.hotkey} maxLength={1} onChange={(e) => setHotkey(t.id, e.target.value)} title="Hotkey" />
              <input className="input name" value={t.name} onChange={(e) => s.updateTarget(t.id, { name: e.target.value })} title="Display name" />
              <span className="mono faint path" title={t.path}>
                {tailPath(t.path, 3)}
              </span>
              <button className="btn sm danger" onClick={() => s.removeTarget(t.id)} title="Remove (files stay where they are)">
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>

      <hr className="rule" />
      <section>
        <h3>Theme</h3>
        <div className="theme-list">
          {themes.map((t) => (
            <button
              key={t.id}
              className={`btn ${theme === t.id ? "active" : ""}`}
              onClick={() => {
                applyTheme(t.id);
                setTheme(t.id);
              }}
              title={t.description}
            >
              {t.name}
            </button>
          ))}
        </div>
      </section>

      <hr className="rule" />
      <section>
        <div className="sec-head">
          <h3>Trash</h3>
          <button className="btn sm" onClick={() => s.set({ trashOpen: true, settingsOpen: false })}>
            Open trash
          </button>
        </div>
        <p className="dim">
          Deleted items go to <span className="mono">{s.library?.trashDir}</span> inside the opened folder.
          {trash && (
            <>
              {" "}
              Currently <span className="mono">{trash.files}</span> files, <span className="mono">{formatBytes(trash.bytes)}</span>.
            </>
          )}
        </p>
      </section>

      <hr className="rule" />
      <section className="row">
        <button className="btn" onClick={() => void s.rescan()}>
          Rescan folder
        </button>
        <button className="btn ghost" onClick={s.closeRoot}>
          Close folder
        </button>
        <span className="faint mono grow">{s.root}</span>
      </section>
    </Modal>
  );
}
