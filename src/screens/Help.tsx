import { useStore } from "../store";
import { Modal } from "../components/Modal";
import { VIEWER_KEYS } from "../lib/hotkeys";

export function Help() {
  const s = useStore();
  const targets = s.library?.targets ?? [];
  return (
    <Modal title="Keyboard" onClose={() => s.set({ helpOpen: false })}>
      <p className="dim small">Hold ⌘ to reveal the key on every button.</p>
      <div className="keys">
        {targets.map((t) => (
          <div key={t.id} className="key-row">
            <span>{t.hotkey ? <kbd className="kbd">{t.hotkey}</kbd> : <span className="faint">none</span>}</span>
            <span>Move to {t.name}</span>
          </div>
        ))}
        {VIEWER_KEYS.map((k) => (
          <div key={k.label} className="key-row">
            <span>
              {k.keys.map((x) => (
                <kbd key={x} className="kbd">
                  {x}
                </kbd>
              ))}
            </span>
            <span>{k.label}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
