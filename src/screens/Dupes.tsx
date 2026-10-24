import { useEffect } from "react";
import { useStore } from "../store";
import { useDupes, type Sensitivity } from "../dupesStore";
import { Thumb } from "../components/Thumb";
import { TopNav, SideToggle } from "../components/TopNav";
import { FolderPicker } from "../components/FolderPicker";
import { fmtEta, useCountdown } from "../components/ScanPill";
import { isTypingTarget } from "../lib/hotkeys";
import { formatBytes, formatDate } from "../lib/format";
import { fmtTime, type DupeGroup, type DupeMember } from "../lib/dupes";

export function Dupes() {
  const s = useStore();
  const d = useDupes();
  const targets = s.library?.targets ?? [];
  const targetName = Object.fromEntries(targets.map((t) => [t.id, t.name]));
  const left = useCountdown(d.running ? d.progress.eta : null);

  useEffect(() => {
    void s.loadAll().then(() => {
      void d.loadCache();
      void d.refreshCandidates();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, s.allStale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || s.settingsOpen || s.trashOpen || s.driveOpen || s.backupOpen || s.vaultOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "d") s.openSortQueue();
      if (key === "b") s.openBrowse();
      if (key === "a") s.openAlbums();
      if (key === "g") s.set({ settingsOpen: true });
      if (key === "e") s.openFiles();
      if (key === "h") s.toggleChrome();
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
  const est = d.estimate;

  return (
    <div className={`screen ${s.sideCollapsed ? "chrome-hidden" : ""}`}>
      <TopNav current="dupes" />
      <SideToggle />
    <div className="browse dupes">
      <aside className="browse-side panel">
        <h3>Duplicates</h3>
        <p className="dim small">Exact copies, similar photos, and video clips contained in longer videos.</p>

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
        <div className="label">Folders</div>
        <FolderPicker items={s.allItems} selected={d.folders} onChange={(sel) => d.set({ folders: sel })} />
        <label className="side-row check">
          <input type="checkbox" checked={d.includeAlbums} onChange={(e) => d.set({ includeAlbums: e.target.checked })} disabled={d.running} />
          Include album folders
        </label>
        <label className="side-row check">
          <input type="checkbox" checked={d.includeVideos} onChange={(e) => d.set({ includeVideos: e.target.checked })} disabled={d.running} />
          Analyse video footage
        </label>

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

        <div className="estimate">
          <div className="side-row">
            <span className="label">Estimate</span>
            <span className="big">{est.seconds == null ? (est.total ? "up to date" : "—") : `~${fmtEta(est.seconds)}`}</span>
          </div>
          <div className="kv mono small">
            <span className="dim">In scope</span>
            <span>{est.total} files</span>
            <span className="dim">Fingerprinted</span>
            <span>{est.cached}</span>
            <span className="dim">New</span>
            <span>
              {est.newStills} photos · {est.newVideos} videos
            </span>
            <span className="dim">To read</span>
            <span>{formatBytes(est.newBytes)}</span>
            <span className="dim">Read speed</span>
            <span>{d.readMBps ? `${d.readMBps.toFixed(0)} MB/s` : "40 MB/s (assumed)"}</span>
          </div>
          <button className="btn sm ghost" onClick={() => void d.benchmark()} disabled={d.running} title="Read about 128 MB from the folder to measure the drive">
            Measure read speed
          </button>
        </div>

        {d.running ? (
          <button className="btn danger" onClick={d.cancel}>
            Cancel
          </button>
        ) : (
          <button className="btn primary" onClick={() => void d.scan()} disabled={!!s.loading}>
            Scan for duplicates
          </button>
        )}
        {d.running && (
          <div className="progress">
            <div className="side-row">
              <span className="label">{d.progress.stage}</span>
              <span className="mono accent2">~{fmtEta(left)} left</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="side-row">
              <span className="mono dim small">
                {d.progress.done}/{d.progress.total}
              </span>
              {d.progress.detail && <span className="mono faint small ellipsis">{d.progress.detail}</span>}
            </div>
          </div>
        )}
        {d.progress.stage === "done" && (
          <div className="dim small">
            <span className="mono">{d.scanned}</span> items scanned, <span className="mono">{d.groups.length}</span> groups,{" "}
            <span className="mono">{formatBytes(wasted)}</span> reclaimable.
          </div>
        )}
      </aside>

      <main className="browse-main">
        <div className="browse-head">
          <span className="mono dim">
            {d.groups.length === 0
              ? d.progress.stage === "done"
                ? "No duplicates in this scope."
                : d.running
                  ? "Scanning… you can leave this screen, the scan keeps running."
                  : "Pick a scope and start a scan. Fingerprints are cached next to your media, so only new files are read next time."
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
    </div>
  );
}
