import type { Target } from "../lib/types";
import { FolderPlus } from "@phosphor-icons/react";
import { bucketOf } from "../lib/filing";

/** The targets to sort into, each with its key; ⇧-click on one that files by the day asks which folder of yours in it (`onChoose`). */
export function TargetBar({
  targets,
  onMove,
  onChoose,
  onAdd,
  disabled,
}: {
  targets: Target[];
  onMove: (id: string) => void;
  onChoose: (target: Target) => void;
  onAdd: () => void;
  disabled: boolean;
}) {
  return (
    <div className="targets">
      <span className="label">Move to</span>
      {targets.length === 0 && <span className="dim">No target folders yet.</span>}
      {targets.map((t) => {
        const filed = !!bucketOf(t, targets);
        return (
          <button key={t.id} className="btn primary target-btn" disabled={disabled} onClick={(e) => (filed && e.shiftKey ? onChoose(t) : onMove(t.id))} title={filed ? `${t.path}, filed by the day. ⇧-click${t.hotkey ? ` or ⇧${t.hotkey.toUpperCase()}` : ""}: into a folder in it` : t.path}>
            {t.hotkey && <kbd className="kbd">{t.hotkey}</kbd>}
            {t.name}
          </button>
        );
      })}
      <button className="btn sm ghost" onClick={onAdd} title="Add a target folder">
        <FolderPlus /> Folder
      </button>
    </div>
  );
}
