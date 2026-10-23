import type { Target } from "../lib/types";

export function TargetBar({
  targets,
  onMove,
  onAdd,
  disabled,
}: {
  targets: Target[];
  onMove: (id: string) => void;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <div className="targets">
      <span className="label">Move to</span>
      {targets.length === 0 && <span className="dim">No target folders yet.</span>}
      {targets.map((t) => (
        <button key={t.id} className="btn primary target-btn" disabled={disabled} onClick={() => onMove(t.id)} title={t.path}>
          {t.hotkey && <kbd className="kbd">{t.hotkey}</kbd>}
          {t.name}
        </button>
      ))}
      <button className="btn sm ghost" onClick={onAdd} title="Add a target folder">
        + Folder
      </button>
    </div>
  );
}
