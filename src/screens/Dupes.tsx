import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { SENSITIVITY, alignVideos, planExact, videoStrip } from "../lib/dupes";
import { useTags, tagKeysFor } from "../tagsStore";
import { mediaUrl } from "../lib/api";
import { Modal } from "../components/Modal";
import { useStore } from "../store";
import { linkedHints, useDupes, versionHints, withParents, type Sensitivity } from "../dupesStore";
import { useVersions } from "../versionsStore";
import { usePlugins } from "../plugins/store";
import { Thumb } from "../components/Thumb";
import { useStopWhenGone } from "../lib/video";
import { TopNav, SideToggle } from "../components/TopNav";
import { FolderPicker } from "../components/FolderPicker";
import { fmtEta, useCountdown } from "../lib/eta";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { formatBytes, formatDate } from "../lib/format";
import { fmtTime, versionOf, type DupeGroup, type DupeMember, type VersionHint } from "../lib/dupes";
import type { MediaItem } from "../lib/types";
import { Stat } from "../components/Stat";
import { Stack } from "@phosphor-icons/react";
import { steppedJob } from "../lib/jobs";
import { ask } from "../components/Confirm";

export function Dupes() {
  // Only what this screen shows: scan progress ticks and unrelated store changes don't re-render the list.
  const s = useStore(
    useShallow((x) => ({
      root: x.root,
      allStale: x.allStale,
      library: x.library,
      busy: x.busy,
      loading: x.loading,
      sideCollapsed: x.sideCollapsed,
      allItems: x.allItems,
      loadAll: x.loadAll,
      trashItem: x.trashItem,
      openViewer: x.openViewer,
      toast: x.toast,
    })),
  );
  const d = useDupes(
    useShallow((x) => ({
      benchmark: x.benchmark,
      cache: x.cache,
      cancel: x.cancel,
      clearIgnored: x.clearIgnored,
      estimate: x.estimate,
      folders: x.folders,
      groups: x.groups,
      ignoreGroup: x.ignoreGroup,
      ignored: x.ignored,
      includeAlbums: x.includeAlbums,
      includeVideos: x.includeVideos,
      loadCache: x.loadCache,
      pause: x.pause,
      paused: x.paused,
      readMBps: x.readMBps,
      refreshCandidates: x.refreshCandidates,
      removeItem: x.removeItem,
      running: x.running,
      scan: x.scan,
      scanned: x.scanned,
      scope: x.scope,
      sensitivity: x.sensitivity,
      set: x.set,
      setVersionCheck: x.setVersionCheck,
      versionsOn: x.versionsOn,
      show: x.show,
      stageDone: x.progress.stage === "done",
      matchingCache: x.matchingCache,
      matchingShare: x.progress.stage === "matching" ? x.progress.done : null,
    })),
  );
  const targetList = s.library?.targets;
  const targets = targetList ?? [];
  const targetName = useMemo(() => Object.fromEntries((targetList ?? []).map((t) => [t.id, t.name])), [targetList]);
  // Plugins' checks for versions they made (a cleaned page, say), and those that are on.
  const dupeVersions = usePlugins((x) => x.dupeVersions);
  const pluginList = usePlugins((x) => x.list);
  const versionChecks = useMemo(() => Object.values(dupeVersions), [dupeVersions]);
  // And the versions linked to their pictures (edits, plugins' results): badged and first in their group too.
  const links = useVersions((v) => v.links);
  const versions = useMemo(() => [...versionHints(), ...linkedHints(links, d.cache)], [dupeVersions, d.versionsOn, links, d.cache]); // eslint-disable-line react-hooks/exhaustive-deps
  const pluginName = (id: string) => pluginList.find((p) => p.id === id)?.manifest?.name ?? id;

  useEffect(() => {
    void s.loadAll().then(async () => {
      await d.loadCache();
      void d.refreshCandidates();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.root, s.allStale]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (isTypingTarget(e.target) || dialogOpen() || s.settingsOpen || s.trashOpen || s.driveOpen || s.backupOpen || s.vaultOpen || s.pluginsOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape" || key === "d") s.openSortQueue();
      if (key === "b") s.openBrowse();
      if (key === "a") s.openAlbums();
      if (key === "g") s.set({ settingsOpen: true });
      if (key === "e") s.openFiles();
      if (key === "l") s.openTags();
      if (key === "k") useStore.getState().openScrapbook();
      if (key === "p") useStore.getState().openPeople();
      if (key === "w") useStore.getState().openArtists();
      if (key === "h") s.toggleChrome();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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


  const [timelineOf, setTimelineOf] = useState<DupeGroup | null>(null);
  // Per group: the files ticked to keep (the rest go), and a Trash all waiting for its second press.
  const [keepSel, setKeepSel] = useState<Record<string, string[]>>({});
  const [armed, setArmed] = useState<string | null>(null);
  const [whole, setWholeState] = useState(loadWhole);
  const setWhole = (on: boolean) => {
    setWholeState(on);
    try {
      localStorage.setItem(WHOLE_KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  const tick = (g: DupeGroup, key: string, on: boolean) => setKeepSel((m) => ({ ...m, [g.id]: on ? [...(m[g.id] ?? []), key] : (m[g.id] ?? []).filter((k) => k !== key) }));
  const untick = (g: DupeGroup) => setKeepSel((x) => ({ ...x, [g.id]: [] }));
  /** The ticked files kept (`asSeries`: together, as a series), the rest of the group to the trash. */
  const keepTicked = async (g: DupeGroup, asSeries = false) => {
    const keep = new Set(keepSel[g.id] ?? []);
    if (asSeries && keep.size > 1) useStore.getState().makeSeries(g.members.map((m) => m.item.key).filter((k) => keep.has(k)));
    for (const m of g.members) if (!keep.has(m.item.key)) await trash(m);
    untick(g);
    // What was kept is no duplicate set any more (a series never is one).
    const left = useDupes.getState().groups.find((x) => x.members.every((mm) => keep.has(mm.item.key)));
    if (!left || keep.size < 2) return;
    if (asSeries) useDupes.setState({ groups: useDupes.getState().groups.filter((x) => x !== left) });
    else d.ignoreGroup(left);
  };
  const trashAll = async (g: DupeGroup) => {
    setArmed(null);
    for (const m of g.members) await trash(m);
  };
  // Remove exact duplicates: per exact group the copy with the most pixels (then the most tags) stays,
  // taking over the tags of the copies that go.
  const tagData = useTags((t) => t.data);
  useEffect(() => {
    void useTags.getState().load();
  }, []);
  const exactPlan = useMemo(
    () => planExact(d.groups, (m) => ({ tags: tagData?.tags[tagKeysFor([m.item.key])[0]] ?? [], fp: d.cache[m.item.key]?.fp })),
    [d.groups, d.cache, tagData],
  );
  const exactDrop = exactPlan.reduce((a, p) => a + p.drop.length, 0);
  const exactSpared = exactPlan.reduce((a, p) => a + p.spared.length, 0);
  const exactTagged = exactPlan.filter((p) => p.tags.length).length;
  const [exactRun, setExactRun] = useState<{ done: number; total: number } | null>(null);
  const removeExact = async () => {
    const plans = exactPlan;
    const total = plans.reduce((a, p) => a + p.drop.length, 0);
    let done = 0;
    let gone = 0;
    let moved = 0;
    setExactRun({ done, total });
    const { job, gate } = steppedJob({ title: "Removing exact duplicates", source: "Duplicates", total });
    try {
    for (const p of plans) {
      // A group is done whole (tags moved, then its copies trashed): paused or stopped between groups.
      if (!(await gate.pass())) break;
      // Tags first: if a trash fails, the worst left behind is a tag on both copies.
      if (p.tags.length) {
        for (const t of p.tags) useTags.getState().setTag([p.keep.item.key], t, true);
        moved++;
      }
      for (const m of p.drop) {
        if (await s.trashItem(m.item)) {
          d.removeItem(m.item.key);
          gone++;
        }
        setExactRun({ done: ++done, total });
        job.update({ done, detail: m.item.name, items: [{ key: p.keep.item.key, name: `keeping ${p.keep.item.name}` }] });
      }
    }
    } finally {
      job.finish();
    }
    setExactRun(null);
    s.toast(`${gone} exact cop${gone === 1 ? "y" : "ies"} moved to the trash${moved ? `; tags carried over to ${moved} kept file${moved === 1 ? "" : "s"}` : ""}`, gone === total ? "ok" : "warn");
  };
  const chip = (active: boolean) => `btn sm ${active ? "active" : ""}`;
  const shown = useMemo(() => (d.show === "all" ? d.groups : d.groups.filter((g) => g.kind === d.show)), [d.groups, d.show]);
  const wasted = useMemo(() => shown.reduce((a, g) => a + g.members.slice(1).reduce((b, m) => b + m.item.size, 0), 0), [shown]);
  const kindCount = useMemo(() => {
    const c: Record<string, number> = {};
    for (const g of d.groups) c[g.kind] = (c[g.kind] ?? 0) + 1;
    return c;
  }, [d.groups]);
  // The list grows as it scrolls: a few hundred groups of thumbnails at once is what made this screen crawl.
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [d.show]);
  const more = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = more.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setLimit((n) => n + PAGE), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length > limit]); // eslint-disable-line react-hooks/exhaustive-deps
  const est = d.estimate;
  // Stable across renders, so a card only re-renders when its own group, ticks or arming change.
  const live = useRef({ trash, keepOnly, keepTicked, trashAll, tick, untick, openGroup, setArmed, setTimelineOf });
  live.current = { trash, keepOnly, keepTicked, trashAll, tick, untick, openGroup, setArmed, setTimelineOf };
  const act = useMemo<CardActions>(
    () => ({
      trash: (m) => void live.current.trash(m),
      keepOnly: (g, m) => void live.current.keepOnly(g, m),
      keepTicked: (g, asSeries) => void live.current.keepTicked(g, asSeries),
      trashAll: (g) => void live.current.trashAll(g),
      tick: (g, key, on) => live.current.tick(g, key, on),
      open: (g, idx) => live.current.openGroup(g, idx),
      ignore: (g) => useDupes.getState().ignoreGroup(g),
      series: (g, ticked) => {
        useStore.getState().makeSeries(ticked ?? g.members.map((m) => m.item.key));
        // Some of it a series, every one kept: the group is no duplicates.
        if (ticked) {
          useDupes.getState().ignoreGroup(g);
          live.current.untick(g);
        } else useDupes.setState({ groups: useDupes.getState().groups.filter((x) => x.id !== g.id) });
      },
      arm: (g) => {
        live.current.setArmed(g.id);
        setTimeout(() => live.current.setArmed((a) => (a === g.id ? null : a)), 4000);
      },
      timeline: (g) => live.current.setTimelineOf(g),
    }),
    [],
  );

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
        <FolderPicker items={s.allItems} selected={d.folders} onChange={(sel) => d.set({ folders: sel, foldersKnown: sel && new Set(s.allItems.flatMap((i) => withParents(i.dir))) })} />
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
                if (useDupes.getState().entries.length) setTimeout(() => useDupes.getState().rematch(), 0);
              }}
            >
              {k}
            </button>
          ))}
        </div>
        {versionChecks.map((v) => {
          const id = `${v.pluginId}:${v.id}`;
          return (
            <label key={id} className="side-row check" title={`${v.tooltip ? `${v.tooltip} ` : ""}(from ${pluginName(v.pluginId)})`}>
              <input type="checkbox" checked={d.versionsOn.includes(id)} onChange={(e) => d.setVersionCheck(id, e.target.checked)} disabled={d.running} />
              {v.label}
            </label>
          );
        })}

        <div className="label">Show</div>
        <div className="chips" title="Exact: byte-for-byte copies. Similar: images that look alike. Video: same footage or clips inside longer videos.">
          {(["all", "exact", "image", "video"] as const).map((k) => (
            <button key={k} className={chip(d.show === k)} onClick={() => d.set({ show: k })}>
              {k === "all" ? "All" : k === "exact" ? "Exact only" : k === "image" ? "Similar" : "Video"}
              {k !== "all" && d.groups.length > 0 && <span className="count">{kindCount[k] ?? 0}</span>}
            </button>
          ))}
        </div>
        <label className="side-row check" title="Each picture at its own shape, all of it, instead of a cropped tile: where two differ shows, top to bottom">
          <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} /> Whole pictures
        </label>

        <div className="stats">
          <Stat value={est.seconds == null ? (est.total ? "ready" : "—") : `~${fmtEta(est.seconds)}`} label="estimated time" accent wide />
          <Stat value={est.total} label="in scope" />
          <Stat value={est.cached} label="fingerprinted" />
          <Stat value={est.newStills} label="new photos" />
          <Stat value={est.newVideos} label="new videos" />
          <Stat value={formatBytes(est.newBytes)} label="to read" />
          <Stat value={d.readMBps ? `${d.readMBps.toFixed(0)} MB/s` : "40 MB/s"} label={d.readMBps ? "read speed" : "assumed speed"} onClick={() => void d.benchmark()} hint="Click to measure" />
        </div>

        {d.running ? (
          <div className="row">
            <button className="btn" onClick={() => d.pause(!d.paused)} title={d.paused ? "Carry on where it stopped" : "Hold the scan; what is done stays done"}>
              {d.paused ? "Resume" : "Pause"}
            </button>
            <button className="btn danger" onClick={d.cancel} title="Stop; everything hashed so far is kept for the next run">
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn primary" onClick={() => void d.scan()} disabled={!!s.loading}>
            Scan for duplicates
          </button>
        )}
        {d.running && <ScanProgress />}
        {d.stageDone && (
          <div className="dim small">
            <span className="mono">{d.scanned}</span> items scanned, <span className="mono">{d.groups.length}</span> groups{d.show !== "all" && shown.length !== d.groups.length ? ` (${shown.length} shown)` : ""},{" "}
            <span className="mono">{formatBytes(wasted)}</span> reclaimable.
          </div>
        )}
        {d.ignored.length > 0 && (
          <div className="side-row small">
            <span className="dim">
              <span className="mono">{d.ignored.length}</span> group{d.ignored.length === 1 ? "" : "s"} marked not duplicates
            </span>
            <button className="btn sm ghost" onClick={d.clearIgnored} title="Show those groups again">
              Clear
            </button>
          </div>
        )}
        <div className="label">Remove exact duplicates</div>
        <div className="dim small">In every exact group the copy with the most pixels stays; on a tie, the one with the most tags. Tags of the copies that go move onto it. Videos and album pages are left alone.</div>
        {exactSpared > 0 && (
          <div className="dim small">
            <span className="mono">{exactSpared}</span> cop{exactSpared === 1 ? "y" : "ies"} left alone because they are album pages.
          </div>
        )}
        <button
          className="btn sm danger"
          disabled={!exactDrop || !!exactRun}
          onClick={async () => {
            // A question of its own: the old "press again" label was easy to miss, and leaving the
            // button took it back, so pressing seemed to do nothing.
            const copies = `${exactDrop} cop${exactDrop === 1 ? "y" : "ies"}`;
            const sure = await ask({
              title: `Trash ${exactDrop} exact cop${exactDrop === 1 ? "y" : "ies"}?`,
              message: (
                <>
                  In each of {exactPlan.length} group{exactPlan.length === 1 ? "" : "s"} the copy with the most pixels stays (on a tie, the one with the most tags); the other {copies} go to the trash folder, where they can be restored.
                  {exactTagged > 0 && ` Tags of the copies that go move onto the kept file (${exactTagged} of them).`} Videos and album pages are left alone.
                </>
              ),
              confirm: `Trash ${copies}`,
              danger: true,
            });
            if (sure) void removeExact();
          }}
          title={exactTagged ? `${exactTagged} kept file${exactTagged === 1 ? "" : "s"} will take over tags` : undefined}
        >
          {exactRun
            ? `Trashing ${exactRun.done} / ${exactRun.total}…`
            : !exactDrop
              ? d.groups.length
                ? "No exact copies to remove"
                : "Scan first"
              : `Remove ${exactDrop} exact cop${exactDrop === 1 ? "y" : "ies"}`}
        </button>
      </aside>

      <main className="browse-main">
        <div className="browse-head">
          <span className="mono dim">
            {shown.length === 0 && d.matchingCache != null
              ? `Matching what was scanned before… ${Math.round(d.matchingCache * 100)}%`
              : shown.length === 0 && d.matchingShare != null
                ? `Matching… ${d.matchingShare}%`
                : shown.length === 0
              ? d.groups.length > 0
                ? "No groups of this kind; pick another under Show."
                : d.stageDone
                ? "No duplicates in this scope."
                : d.running
                  ? "Scanning… groups show up here as they are found; you can leave this screen, the scan keeps running."
                  : "Pick a scope and start a scan. Fingerprints are cached next to your media, so only new files are read next time."
              : `${shown.length} groups`}
          </span>
        </div>
        {shown.length === 0 && (d.matchingCache != null || d.matchingShare != null) && (
          <div className="progress-bar dupes-matching">
            <div className="progress-fill" style={{ width: `${d.matchingCache != null ? Math.round(d.matchingCache * 100) : d.matchingShare}%` }} />
          </div>
        )}
        <div className="dupe-list">
          {shown.slice(0, limit).map((g) => (
            <GroupCard key={g.id} g={g} kept={keepSel[g.id]} armed={armed === g.id} busy={s.busy} ratings={s.library?.ratings} targetName={targetName} act={act} versions={versions} whole={whole} />
          ))}
          {shown.length > limit && (
            <div ref={more} className="dim small dupe-more">
              Showing {limit} of {shown.length} groups…
            </div>
          )}
        </div>
      </main>
      {timelineOf && (
        <Modal title="Where these videos overlap" onClose={() => setTimelineOf(null)} wide>
          <VideoTimeline g={d.groups.find((x) => x.id === timelineOf.id) ?? timelineOf} big />
        </Modal>
      )}
    </div>
    </div>
  );
}

/**
 * The videos of a group on one timeline, the longest as the base: where each other one sits
 * against it (it may start before or run past the base), and a Combine that makes one video of
 * the base plus what the other has at either end. Big: pictures along each bar, a player, and a
 * playhead; clicking a bar plays that video from there.
 */
function VideoTimeline({ g, big, onOpen }: { g: DupeGroup; big?: boolean; onOpen?: () => void }) {
  const root = useStore((x) => x.root);
  const sensitivity = useDupes((x) => x.sensitivity);
  const [busy, setBusy] = useState<string | null>(null);
  const [cur, setCur] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const playerAt = useStopWhenGone(player);
  // Matched once per group, not on every playhead tick.
  const tracks = useMemo(() => {
    const vids = g.members.filter((m) => m.video);
    if (vids.length < 2) return null;
    const base = vids.reduce((a, b) => (b.video!.duration > a.video!.duration ? b : a));
    return [
      { m: base, offset: 0, al: null as ReturnType<typeof alignVideos>, isBase: true },
      ...vids
        .filter((m) => m !== base)
        .map((m) => {
          const al = alignVideos(base.video!, m.video!, SENSITIVITY[sensitivity]);
          return { m, offset: al?.offset ?? 0, al, isBase: false };
        }),
    ];
  }, [g, sensitivity]);
  if (!tracks) return null;
  const base = tracks[0].m;
  const Ld = base.video!.duration;
  const start = Math.min(0, ...tracks.map((t) => t.offset));
  const end = Math.max(Ld, ...tracks.map((t) => t.offset + t.m.video!.duration));
  const span = Math.max(1, end - start);
  const left = (t: number) => `${((t - start) / span) * 100}%`;
  const width = (dur: number) => `${(dur / span) * 100}%`;
  const current = tracks.find((t) => t.m.item.key === cur) ?? tracks[0];
  const play = (tr: (typeof tracks)[number], local: number) => {
    if (tr.m.item.key !== current.m.item.key) {
      pendingSeek.current = local;
      setCur(tr.m.item.key);
    } else if (player.current) {
      player.current.currentTime = local;
      void player.current.play().catch(() => {});
    }
  };
  const clickTrack = (e: React.MouseEvent<HTMLDivElement>, tr: (typeof tracks)[number]) => {
    if (!big) return;
    const r = e.currentTarget.getBoundingClientRect();
    const local = start + ((e.clientX - r.left) / r.width) * span - tr.offset;
    if (local >= 0 && local <= tr.m.video!.duration) play(tr, local);
  };
  const switchTo = (tr: (typeof tracks)[number]) => play(tr, Math.min(Math.max(0, (playhead ?? tr.offset) - tr.offset), Math.max(0, tr.m.video!.duration - 0.1)));
  const combine = async (tr: (typeof tracks)[number]) => {
    if (!root || !tr.al) return;
    const head = Math.max(0, -tr.offset);
    const over = tr.offset + tr.m.video!.duration - Ld;
    const tailFrom = over > 0.5 ? Ld - tr.offset : null;
    const stem = base.item.name.replace(/\.[^.]+$/, "");
    setBusy(tr.m.item.key);
    try {
      const out = await api.videoCombine(root, base.item.primary, tr.m.item.primary, head, tailFrom, `${stem} combined.mp4`);
      useStore.getState().toast(`Written ${out.split("/").pop()}`, "ok");
      useStore.getState().set({ allStale: true });
    } catch (e) {
      useStore.getState().toast(String(e), "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={`video-timeline ${big ? "big" : ""}`}>
      {big && (
        <div className="vt-player">
          <video
            ref={playerAt}
            key={current.m.item.key}
            src={mediaUrl(current.m.item)}
            controls
            autoPlay={pendingSeek.current != null}
            onLoadedMetadata={(e) => {
              if (pendingSeek.current != null) {
                e.currentTarget.currentTime = pendingSeek.current;
                pendingSeek.current = null;
              }
            }}
            onTimeUpdate={(e) => setPlayhead(current.offset + e.currentTarget.currentTime)}
            onSeeked={(e) => setPlayhead(current.offset + e.currentTarget.currentTime)}
          />
          <div className="dim small">
            Playing <span className="mono">{current.m.item.name}</span>. Click a bar to play that video from there, or a name to switch at the same moment.
          </div>
        </div>
      )}
      {big ? (
        <div className="vt-row vt-ruler">
          <span className="vt-name" />
          <div className="vt-track ruler">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <span key={f} className="vt-tick mono small dim" style={{ left: `${f * 100}%` }}>
                {start + f * span < 0 ? "−" : ""}
                {fmtTime(Math.abs(start + f * span))}
              </span>
            ))}
          </div>
          <span className="vt-extra" />
        </div>
      ) : (
        onOpen && (
          <div className="vt-row">
            <span className="grow" />
            <button className="btn sm ghost" onClick={onOpen} title="A bigger timeline, with pictures from each video and a player">
              Timeline with pictures
            </button>
          </div>
        )
      )}
      {tracks.map((tr) => {
        const Sd = tr.m.video!.duration;
        const head = tr.al ? Math.max(0, -tr.offset) : 0;
        const tail = tr.al ? Math.max(0, tr.offset + Sd - Ld) : 0;
        const extra = head > 0.5 || tail > 0.5;
        const aspect = (tr.m.video!.width || 16) / (tr.m.video!.height || 9);
        return (
          <div key={tr.m.item.key} className={`vt-row ${big && tr === current ? "current" : ""}`}>
            <span className={`vt-name ellipsis mono small ${big ? "click" : ""}`} title={big ? `Play ${tr.m.item.name}` : tr.m.item.name} onClick={() => big && switchTo(tr)}>
              {tr.m.item.name}
            </span>
            <div className="vt-track" onClick={(e) => clickTrack(e, tr)}>
              <div
                className={`vt-bar ${tr.isBase ? "base" : tr.al ? "" : "none"}`}
                style={{ left: left(tr.offset), width: width(Sd) }}
                title={tr.isBase ? `${fmtTime(Ld)} (the base)` : tr.al ? `starts at ${fmtTime(tr.offset)}, ${Math.round(tr.al.ratio * 100)}% of ${tr.al.overlap}s alike` : "no overlap found"}
              >
                {big && <Strip item={tr.m.item} duration={Sd} aspect={aspect} />}
              </div>
              {big && playhead != null && <div className="vt-playhead" style={{ left: left(playhead) }} />}
            </div>
            <span className="vt-extra small">
              {tr.isBase ? "base" : tr.al ? (extra ? [head > 0.5 ? `+${fmtTime(head)} before` : null, tail > 0.5 ? `+${fmtTime(tail)} after` : null].filter(Boolean).join(" · ") : "inside the base") : "no overlap"}
            </span>
            {!tr.isBase && tr.al && extra && (
              <button className="btn sm" disabled={!!busy} onClick={() => void combine(tr)} title="One video: the base, with what this one has before and after it">
                {busy === tr.m.item.key ? "Combining…" : "Combine"}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Pictures along one video's bar, as many as fit at the bar's height without squeezing. */
function Strip({ item, duration, aspect }: { item: MediaItem; duration: number; aspect: number }) {
  const root = useStore((st) => st.root);
  const ref = useRef<HTMLSpanElement>(null);
  const [n, setN] = useState(0);
  const [frames, setFrames] = useState<string[] | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setN(Math.max(1, Math.min(40, Math.round(el.clientWidth / Math.max(20, el.clientHeight * aspect)))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  useEffect(() => {
    if (!n) return;
    let live = true;
    const times = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * duration);
    // ffmpeg seeks straight to each frame; the webview's own decoder is the fallback.
    const viaFfmpeg = root ? api.videoThumbs(root, item.primary, times, 240).then((f) => (f.some(Boolean) ? f.filter(Boolean) : Promise.reject(new Error("none")))) : Promise.reject(new Error("no folder"));
    void viaFfmpeg.catch(() => videoStrip(mediaUrl(item), times, 200)).then((f) => live && setFrames(f));
    return () => {
      live = false;
    };
  }, [root, item, duration, n]);
  return (
    <span ref={ref} className={`vt-strip ${frames ? "" : "loading"}`}>
      {frames?.map((f, i) => <img key={i} src={f} alt="" draggable={false} />)}
    </span>
  );
}

/** The running scan: its own component, so progress ticks re-render this and not the list of groups. */
function ScanProgress() {
  const progress = useDupes((x) => x.progress);
  const paused = useDupes((x) => x.paused);
  const allItems = useStore((x) => x.allItems);
  const byKey = useMemo(() => new Map(allItems.map((i) => [i.key, i])), [allItems]);
  const left = useCountdown(progress.eta);
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="progress">
      <div className="side-row">
        <span className="label">{paused ? "paused" : progress.stage}</span>
        {(() => {
          const cur = progress.key ? byKey.get(progress.key) : undefined;
          return cur ? (
            <span className="index-pill-thumb" title={cur.name}>
              <Thumb item={cur} eager aspect={1} onClick={() => {}} />
            </span>
          ) : null;
        })()}
        <span className="mono accent2">~{fmtEta(left)} left</span>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {(progress.workers?.length ?? 0) > 0 && (
        <div className="workers">
          {progress.workers!.map((w) => {
            const it = byKey.get(w.key);
            return (
              <div key={w.key} className="worker-row" title={w.name}>
                {it && (
                  <span className="index-pill-thumb">
                    <Thumb item={it} eager aspect={1} onClick={() => {}} />
                  </span>
                )}
                <span className="ellipsis small grow">{w.name}</span>
                {w.frames != null && (
                  <span className="mono small dim">
                    {w.frame ?? 0}/{w.frames}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="side-row">
        <span className="mono dim small">
          {progress.done}/{progress.total}
        </span>
        {progress.detail && <span className="mono faint small ellipsis">{progress.detail}</span>}
      </div>
    </div>
  );
}

const PAGE = 30;

interface CardActions {
  trash(m: DupeMember): void;
  keepOnly(g: DupeGroup, m: DupeMember): void;
  keepTicked(g: DupeGroup, asSeries?: boolean): void;
  trashAll(g: DupeGroup): void;
  tick(g: DupeGroup, key: string, on: boolean): void;
  open(g: DupeGroup, idx: number): void;
  ignore(g: DupeGroup): void;
  /** Keep every one, as a series: alike on purpose (`ticked`: only those a series, the rest kept on their own). */
  series(g: DupeGroup, ticked?: string[]): void;
  arm(g: DupeGroup): void;
  timeline(g: DupeGroup): void;
}

/** A rematch makes new group objects; one whose members and notes are unchanged need not draw again. */
function sameGroup(a: DupeGroup, b: DupeGroup): boolean {
  return a === b || (a.kind === b.kind && a.members.length === b.members.length && a.members.every((m, i) => m.item === b.members[i].item && m.notes.length === b.members[i].notes.length));
}

/** "Whole pictures": each in a group at its own shape, uncropped (remembered). */
const WHOLE_KEY = "quire.dupes.whole";
function loadWhole(): boolean {
  try {
    return localStorage.getItem(WHOLE_KEY) === "1";
  } catch {
    return false;
  }
}

/** A member's own shape (width / height), as it was hashed; a tile's 4:3 when it isn't known. */
function shapeOf(m: DupeMember): number | undefined {
  const size = m.image ?? m.video;
  return size && size.width > 0 && size.height > 0 ? size.width / size.height : undefined;
}

const GroupCard = memo(
  function GroupCard({ g, kept, armed, busy, ratings, targetName, act, versions, whole }: { g: DupeGroup; kept?: string[]; armed: boolean; busy: boolean; ratings?: Record<string, number>; targetName: Record<string, string>; act: CardActions; versions: VersionHint[]; whole: boolean }) {
    // A version a plugin made first, with a badge: usually the one to keep.
    const members = g.members.map((m, idx) => ({ m, idx, version: versions.length ? versionOf(m.item, versions) : undefined }));
    if (versions.length) members.sort((a, b) => Number(!!b.version) - Number(!!a.version) || a.idx - b.idx);
    // Some of a group of pictures ticked (two at least, not all): those can be a series.
    const someTicked = g.kind === "image" && (kept?.length ?? 0) > 1 && kept!.length < g.members.length;
    return (
      <section className="dupe-group panel">
        <div className="dupe-head">
          <span className={`badge ${g.kind === "exact" ? "accent" : "accent2"}`}>{g.kind === "exact" ? "Exact" : g.kind === "video" ? "Video" : "Similar"}</span>
          <span className="dim mono">{g.members.length} files</span>
          <span className="grow" />
          {(kept?.length ?? 0) > 0 && (
            <button className="btn sm primary" disabled={busy} onClick={() => act.keepTicked(g)} title="Keep the ticked files, trash the rest of this group">
              Keep {kept!.length} ticked, trash {g.members.length - kept!.length}
            </button>
          )}
          {someTicked && (
            <button className="btn sm" disabled={busy} onClick={() => act.keepTicked(g, true)} title="The ticked ones are alike on purpose: keep them together as a series, and trash the rest of this group">
              <Stack /> Keep {kept!.length} as a series, trash {g.members.length - kept!.length}
            </button>
          )}
          <button className="btn sm ghost" onClick={() => act.ignore(g)} title="These are not duplicates: keep every one, and don't show this group again">
            Keep all
          </button>
          {someTicked ? (
            <button className="btn sm ghost" onClick={() => act.series(g, kept)} title="Keep every one, the ticked together as a series (alike on purpose), the rest on their own. Nothing goes to the trash">
              <Stack /> Keep all, the {kept!.length} ticked as a series
            </button>
          ) : (
            g.kind === "image" &&
            g.members.length <= 12 && (
              <button className="btn sm ghost" onClick={() => act.series(g)} title="Keep every one, together as a series: alike on purpose (a burst, variations). Kept together, it is one tile in Browse and whole in Sort">
                <Stack /> Keep all as a series
              </button>
            )
          )}
          <button className={`btn sm ${armed ? "danger" : "ghost"}`} disabled={busy} onClick={() => (armed ? act.trashAll(g) : act.arm(g))} title="Trash every file in this group (press twice)">
            {armed ? `Sure? Trash all ${g.members.length}` : "Trash all"}
          </button>
        </div>
        {g.members.filter((m) => m.video).length > 1 && <VideoTimeline g={g} onOpen={() => act.timeline(g)} />}
        <div className={`dupe-members ${whole ? "whole" : ""}`}>
          {members.map(({ m, idx, version }) => (
            <div key={m.item.key} className="dupe-card">
              <Thumb item={m.item} rating={ratings?.[m.item.key]} label={m.item.targetId ? targetName[m.item.targetId] : undefined} onClick={() => act.open(g, idx)} aspect={whole ? shapeOf(m) : undefined} />
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
                {version && <span className="badge accent2">{version.note}</span>}
                {m.notes.slice(0, 2).map((n) => (
                  <div key={n} className="note">
                    {n}
                  </div>
                ))}
              </div>
              <div className="dupe-actions">
                <label className="check small" title="Tick the ones to keep, then press Keep … ticked above">
                  <input type="checkbox" checked={!!kept?.includes(m.item.key)} onChange={(e) => act.tick(g, m.item.key, e.target.checked)} /> keep
                </label>
                <button className="btn sm" onClick={() => act.keepOnly(g, m)} disabled={busy} title="Keep this file, trash the others in the group">
                  Keep this
                </button>
                <button className="btn sm danger" onClick={() => act.trash(m)} disabled={busy}>
                  Trash
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  },
  (a, b) => sameGroup(a.g, b.g) && a.kept === b.kept && a.armed === b.armed && a.busy === b.busy && a.ratings === b.ratings && a.targetName === b.targetName && a.act === b.act && a.versions === b.versions && a.whole === b.whole,
);
