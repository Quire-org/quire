import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api, pickFolder } from "../lib/api";
import { Modal } from "../components/Modal";
import { fmtEta, useCountdown } from "../components/ScanPill";
import { formatBytes, formatDate, tailPath } from "../lib/format";
import type { BackupOutcome, BackupPlan, BackupProgress } from "../lib/types";

/**
 * Back the opened folder up into another folder. A plan is computed first
 * (new, changed, moved, unchanged, extra); the run copies only what differs,
 * renames files you moved, and optionally mirrors deletions.
 */
export function Backup() {
  const s = useStore();
  const dest = s.library?.backupDest ?? null;
  const [skipTrash, setSkipTrash] = useState(true);
  const [mirror, setMirror] = useState(false);
  const [verify, setVerify] = useState(true);
  const [plan, setPlan] = useState<BackupPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [outcome, setOutcome] = useState<BackupOutcome | null>(null);
  const [startedAt, setStartedAt] = useState(0);

  const eta = (() => {
    if (!running || !progress || !startedAt || progress.doneBytes < 2 * 1_048_576) return null;
    const elapsed = (Date.now() - startedAt) / 1000;
    return Math.round(((progress.totalBytes - progress.doneBytes) / progress.doneBytes) * elapsed);
  })();
  const left = useCountdown(eta);

  const choose = async () => {
    const dir = await pickFolder("Choose the backup folder", dest ?? undefined);
    if (dir) {
      s.setLibraryField({ backupDest: dir });
      setPlan(null);
      setOutcome(null);
    }
  };

  const analyse = async () => {
    if (!s.root || !s.library || !dest) return;
    setPlanning(true);
    setOutcome(null);
    try {
      setPlan(await api.backupPlan(s.root, dest, s.library, skipTrash));
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setPlanning(false);
    }
  };

  useEffect(() => {
    if (dest && !plan && !planning) void analyse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dest, skipTrash]);

  const run = async () => {
    if (!s.root || !dest || !plan) return;
    setRunning(true);
    setStartedAt(Date.now());
    setProgress(null);
    try {
      const out = await api.backupRun(s.root, dest, plan, mirror, verify, setProgress);
      setOutcome(out);
      if (!out.cancelled) s.setLibraryField({ lastBackup: Date.now() });
      s.toast(out.cancelled ? "Backup cancelled" : out.errors.length ? `Backup finished with ${out.errors.length} errors` : "Backup complete", out.errors.length ? "warn" : "ok");
      setPlan(await api.backupPlan(s.root, dest, s.library!, skipTrash));
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setRunning(false);
    }
  };

  const todo = plan ? plan.copy.length + plan.update.length + plan.moves.length + (mirror ? plan.extra.length : 0) : 0;
  const pct = progress && progress.totalBytes ? Math.round((progress.doneBytes / progress.totalBytes) * 100) : progress && progress.totalFiles ? Math.round((progress.doneFiles / progress.totalFiles) * 100) : 0;

  return (
    <Modal title="Backup" onClose={() => !running && s.set({ backupOpen: false })} wide>
      <section>
        <div className="sec-head">
          <h3>Backup folder</h3>
          <button className="btn sm" onClick={() => void choose()} disabled={running}>
            {dest ? "Change…" : "Choose…"}
          </button>
        </div>
        {dest ? (
          <p className="mono small">
            <span className="accent-text">{tailPath(dest, 3)}</span>
            <span className="faint"> · {dest}</span>
            {s.library?.lastBackup && <span className="dim"> · last backup {formatDate(s.library.lastBackup)}</span>}
          </p>
        ) : (
          <p className="dim small">Pick a folder on another drive. The choice is remembered with this folder's library file.</p>
        )}
      </section>

      <hr className="rule" />
      <section className="row">
        <label className="check side-row" title="Leave the _deleted folder out of the backup">
          <input type="checkbox" checked={skipTrash} disabled={running} onChange={(e) => { setSkipTrash(e.target.checked); setPlan(null); }} /> Skip trash
        </label>
        <label className="check side-row" title="Compare a fingerprint of every copied file with the source">
          <input type="checkbox" checked={verify} disabled={running} onChange={(e) => setVerify(e.target.checked)} /> Verify copies
        </label>
        <label className="check side-row" title="Delete files from the backup that no longer exist here">
          <input type="checkbox" checked={mirror} disabled={running} onChange={(e) => setMirror(e.target.checked)} /> Mirror deletions
        </label>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => void analyse()} disabled={!dest || planning || running}>
          {planning ? "Comparing…" : "Re-check"}
        </button>
      </section>

      {plan && (
        <>
          <hr className="rule" />
          <section>
            <h3>Plan</h3>
            <div className="drive-grid mono small">
              <span className="label">Source</span>
              <span>{plan.sourceFiles} files · {formatBytes(plan.sourceBytes)}</span>
              <span className="label">Unchanged</span>
              <span className="dim">{plan.unchanged} files · {formatBytes(plan.unchangedBytes)} already in the backup</span>
              <span className="label">New</span>
              <span className={plan.copy.length ? "accent-text" : "dim"}>{plan.copy.length} files</span>
              <span className="label">Changed</span>
              <span className={plan.update.length ? "accent-text" : "dim"}>{plan.update.length} files</span>
              <span className="label">Moved</span>
              <span className={plan.moves.length ? "accent-text" : "dim"}>{plan.moves.length} files renamed in the backup, no copying</span>
              <span className="label">Only in backup</span>
              <span className={plan.extra.length ? (mirror ? "accent-text" : "dim") : "dim"}>
                {plan.extra.length} files{plan.extra.length ? (mirror ? ", will be deleted" : ", kept (mirror deletions is off)") : ""}
              </span>
              <span className="label">To copy</span>
              <span className="accent-text">{formatBytes(plan.bytesToCopy)}</span>
            </div>
            {plan.moves.length > 0 && (
              <details className="advanced">
                <summary className="label">Moves</summary>
                <div className="rename-list mono small">
                  {plan.moves.slice(0, 50).map(([a, b]) => (
                    <div key={a} className="rename-row">
                      <span className="dim ellipsis">{a}</span>
                      <span className="faint">→</span>
                      <span className="ellipsis">{b}</span>
                      <span />
                    </div>
                  ))}
                  {plan.moves.length > 50 && <div className="faint">… and {plan.moves.length - 50} more</div>}
                </div>
              </details>
            )}
          </section>
          <hr className="rule" />
          <section className="row">
            {running ? (
              <button className="btn danger" onClick={() => void api.cancelBackup()}>
                Cancel
              </button>
            ) : (
              <button className="btn primary" onClick={() => void run()} disabled={todo === 0}>
                {todo === 0 ? "Backup is up to date" : `Run backup (${todo} operations)`}
              </button>
            )}
            {running && progress && (
              <div className="progress grow">
                <div className="side-row">
                  <span className="label">{progress.stage}</span>
                  <span className="mono dim small">
                    {progress.doneFiles}/{progress.totalFiles} · {formatBytes(progress.doneBytes)} of {formatBytes(progress.totalBytes)}
                    {left != null && ` · ~${fmtEta(left)} left`}
                  </span>
                </div>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="mono faint small ellipsis">{progress.current}</div>
              </div>
            )}
          </section>
        </>
      )}

      {outcome && (
        <div className={`verdict ${outcome.errors.length ? "bad" : outcome.cancelled ? "unknown" : "good"}`}>
          <h3>{outcome.cancelled ? "Cancelled" : outcome.errors.length ? `Finished with ${outcome.errors.length} errors` : "Backup complete"}</h3>
          <p className="dim small mono">
            {outcome.copied} new, {outcome.updated} updated, {outcome.moved} moved, {outcome.deleted} removed · {formatBytes(outcome.bytes)} in {(outcome.millis / 1000).toFixed(0)}s
            {verify && ` · ${outcome.verified} verified`}
          </p>
          {outcome.errors.length > 0 && (
            <div className="err-list mono">
              {outcome.errors.map(([p, e]) => (
                <div key={p}>
                  {p}: {e}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
