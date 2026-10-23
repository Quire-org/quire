import { useEffect } from "react";
import { useStore } from "../store";
import { useDupes, type Sensitivity } from "../dupesStore";
import { Thumb } from "../components/Thumb";
import { isTypingTarget } from "../lib/hotkeys";
import { formatBytes, formatDate } from "../lib/format";
import { fmtTime, type DupeGroup, type DupeMember } from "../lib/dupes";

export function Dupes() {
  const s = useStore();
  const d = useDupes();
  const targets = s.library?.targets ?? [];
  const targetName = Object.fromEntries(targets.map((t) => [t.id, t.name]));

  useEffect(() => {
    void s.loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, s.allStale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || s.settingsOpen || s.trashOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "d") s.openSortQueue();
      if (key === "b") s.openBrowse();
      if (key === "g") s.set({ settingsOpen: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);

  const trash = async (m: DupeMember) => {
    if (await s.trashItem(m.item)) d.removeItem(m.item.key);
  };
  const keepOnly = async (g: DupeGroup, keep: DupeMember) => {
    for (const m of g.members) if (m !== keep) await trash(m);
  };
  const openGroup = (g: DupeGroup, idx: number) =>
    s.openViewer(
      g.members.map((m) => m.item),
      idx,
      { kind: "dupes" },
    );

  const pct = d.progress.total ? Math.round((d.progress.done / d.progress.total) * 100) : 0;
  const chip = (active: boolean) => `btn sm ${active ? "active" : ""}`;
  const wasted = d.groups.reduce((a, g) => a + g.members.slice(1).reduce((b, m) => b + m.item.size, 0), 0);

  return (
    <div className="browse dupes">
      <aside className="browse-side panel">
        <div className="side-head">
          <span className="brand">MEDIA SORTER</span>
          <button className="btn sm accent2" onClick={s.openSortQueue} title="Back to sorting (Esc)">
            Sort <kbd className="kbd">Esc</kbd>
          </button>
        </div>
        <h3>Duplicates</h3>
        <p className="dim small">
          Exact copies by content fingerprint, similar photos by perceptual hash, and videos whose footage matches or is
          contained in a longer video.
        </p>

        <div className="label">Scope</div>
        <div className="side-list">
          <button className={chip(d.scope === "all")} onClick={() => d.set({ scope: "all" })} disabled={d.running}>
            Everything
          </button>
          <button className={chip(d.scope === "unsorted")} onClick={() => d.set({ scope: "unsorted" })} disabled={d.running}>
            Unsorted
          </button>
          {targets.map((t) => (
            <button key={t.id} className={chip(d.scope === t.id)} onClick={() => d.set({ scope: t.id })} disabled={d.running}>
              {t.name}
            </button>
          ))}
        </div>

        <div className="label">Sensitivity</div>
        <div className="chips">
          {(["strict", "normal", "loose"] as Sensitivity[]).map((k) => (
            <button
              key={k}
              className={chip(d.sensitivity === k)}
              onClick={() => {
                d.set({ sensitivity: k });
                if (d.entries.length) setTimeout(() => useDupes.getState().rematch(), 0);
              }}
            >
              {k}
            </button>
          ))}
        </div>
        <label className="side-row check">
          <input type="checkbox" checked={d.includeVideos} onChange={(e) => d.set({ includeVideos: e.target.checked })} disabled={d.running} />
          Analyse videos (slower)
        </label>

        <hr className="rule" />
        {d.running ? (
          <button className="btn danger" onClick={d.cancel}>
            Cancel
          </button>
        ) : (
          <button className="btn primary" onClick={() => void d.scan()} disabled={!s.allLoaded && !!s.loading}>
            Scan for duplicates
          </button>
        )}
        {(d.running || d.progress.stage === "done") && (
          <div className="progress">
            <div className="side-row">
              <span className="label">{d.progress.stage}</span>
              {d.progress.total > 0 && (
                <span className="mono dim">
                  {d.progress.done}/{d.progress.total}
                </span>
              )}
            </div>
            {d.running && (
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
            )}
            {d.progress.detail && <div className="mono faint small ellipsis">{d.progress.detail}</div>}
          </div>
        )}
        {d.progress.stage === "done" && (
          <div className="dim small">
            <span className="mono">{d.scanned}</span> items scanned, <span className="mono">{d.groups.length}</span> groups,{" "}
            <span className="mono">{formatBytes(wasted)}</span> reclaimable.
          </div>
        )}
        <button className="btn sm ghost" onClick={s.openBrowse}>
          Browse <kbd className="kbd">B</kbd>
        </button>
      </aside>

      <main className="browse-main">
        <div className="browse-head">
          <span className="mono dim">
            {d.groups.length === 0
              ? d.progress.stage === "done"
                ? "No duplicates in this scope."
                : d.running
                  ? "Scanning…"
                  : "Pick a scope and start a scan. Results are cached next to your media, so later scans are quick."
              : `${d.groups.length} groups`}
          </span>
        </div>
        <div className="dupe-list">
          {d.groups.map((g) => (
            <section key={g.id} className="dupe-group panel">
              <div className="dupe-head">
                <span className={`badge ${g.kind === "exact" ? "accent" : "accent2"}`}>{g.kind === "exact" ? "Exact" : g.kind === "video" ? "Video" : "Similar"}</span>
                <span className="dim mono">{g.members.length} files</span>
              </div>
              <div className="dupe-members">
                {g.members.map((m, idx) => (
                  <div key={m.item.key} className="dupe-card">
                    <Thumb item={m.item} rating={s.library?.ratings[m.item.key]} label={m.item.targetId ? targetName[m.item.targetId] : undefined} onClick={() => openGroup(g, idx)} />
                    <div className="dupe-meta mono">
                      <div className="dim ellipsis" title={m.item.dir || "/"}>
                        {m.item.dir || "/"}
                      </div>
                      <div>
                        {formatBytes(m.item.size)}
                        {m.image && ` · ${m.image.width}×${m.image.height}`}
                        {m.video && ` · ${m.video.width}×${m.video.height} · ${fmtTime(m.video.duration)}`}
                      </div>
                      <div className="faint">{formatDate(m.item.modified)}</div>
                      {m.notes.slice(0, 2).map((n) => (
                        <div key={n} className="note">
                          {n}
                        </div>
                      ))}
                    </div>
                    <div className="dupe-actions">
                      <button className="btn sm" onClick={() => void keepOnly(g, m)} disabled={s.busy} title="Keep this file, trash the others in the group">
                        Keep this
                      </button>
                      <button className="btn sm danger" onClick={() => void trash(m)} disabled={s.busy}>
                        Trash
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
