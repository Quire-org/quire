import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowSquareOut, Check, Pause, Play, Stop } from "@phosphor-icons/react";
import { useStore } from "../store";
import { useActivity, overall, type Job } from "../lib/activity";
import { can } from "../lib/jobs";
import { fmtEta, useCountdown } from "../lib/eta";
import { Thumb } from "./Thumb";
import { TopNav } from "./TopNav";
import type { MediaItem } from "../lib/types";
import { formatBytes } from "../lib/format";

/** A job's count: files, or bytes as a size. */
const amount = (j: Job, n: number) => (j.bytes ? formatBytes(n) : String(Math.floor(n)));

/** Keys to items, for the thumbnails: the library, then the viewer's queue (album pages, a vault). */
function useItemLookup(): (key: string) => MediaItem | undefined {
  const all = useStore((s) => s.allItems);
  const queue = useStore((s) => s.queue);
  const byKey = useMemo(() => new Map(all.map((i) => [i.key, i])), [all]);
  const inQueue = useMemo(() => new Map(queue.map((i) => [i.key, i])), [queue]);
  return (key) => byKey.get(key) ?? inQueue.get(key);
}

const pctOf = (j: Job) => (j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0);

/** The ring at the top while anything runs; nothing at all when nothing does. */
export function ActivityButton() {
  const jobs = useActivity();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const screen = useStore((s) => s.screen);
  // Like a downloads list: once opened it stays until closed, even when the last job ends (a short
  // one could end while you reached for it, and the list vanished under the pointer).
  if (!jobs.length && !open) return null;
  const share = jobs.length ? overall(jobs) : 1;
  const paused = jobs.length > 0 && jobs.every((j) => j.paused);
  const title = !jobs.length ? "Nothing running now" : jobs.length === 1 ? `${jobs[0].title}: ${share == null ? "starting" : `${Math.round(share * 100)}%`}` : `${jobs.length} jobs running`;
  return (
    <>
      <button ref={btn} className={`btn sm ghost activity-btn ${open || screen === "activity" ? "active" : ""}`} onClick={() => setOpen(!open)} title={title}>
        <Ring share={share} paused={paused} />
        {jobs.length > 1 && <span className="activity-count mono">{jobs.length}</span>}
      </button>
      {open && <ActivityPopover jobs={jobs} anchor={btn} onClose={() => setOpen(false)} />}
    </>
  );
}

function Ring({ share, paused, size = 18 }: { share: number | null; paused?: boolean; size?: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg className={`activity-ring ${share == null ? "unknown" : ""} ${paused ? "paused" : ""}`} width={size} height={size} viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r={r} className="activity-ring-track" />
      <circle cx="9" cy="9" r={r} className="activity-ring-fill" strokeDasharray={c} strokeDashoffset={share == null ? c * 0.7 : c * (1 - share)} transform="rotate(-90 9 9)" />
      {/* A turning dot: the ring moves even while a step takes long. */}
      {!paused && <circle cx="9" cy="2" r="1.4" className="activity-ring-dot" />}
    </svg>
  );
}

function ActivityPopover({ jobs, anchor, onClose }: { jobs: Job[]; anchor: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const lookup = useItemLookup();
  // Jobs that end while this is open stay in it, marked as ended, until it closes.
  const [ended, setEnded] = useState<Job[]>([]);
  const last = useRef<Job[]>(jobs);
  useEffect(() => {
    const now = new Set(jobs.map((j) => j.id));
    const left = last.current.filter((j) => !now.has(j.id));
    if (left.length) setEnded((e) => [...left.map((j) => ({ ...j, state: j.stopping ? "stopped" : "done" })), ...e.filter((x) => !now.has(x.id) && !left.some((l) => l.id === x.id))].slice(0, 8));
    last.current = jobs;
  }, [jobs]);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => {
    const away = (e: Event) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  if (!pos) return null;
  return createPortal(
    <div ref={pop} className="activity-pop panel" style={{ top: pos.top, right: pos.right }}>
      <div className="activity-pop-head">
        <span className="label">{jobs.length ? "Running" : "Nothing running now"}</span>
        <span className="mono dim small">{jobs.length || ""}</span>
      </div>
      {jobs.map((j) => (
        <JobRow key={j.id} j={j} lookup={lookup} />
      ))}
      {ended.map((j) => (
        <div key={j.id} className="activity-row ended">
          <span className="activity-row-thumb">
            <Check />
          </span>
          <div className="activity-row-main">
            <div className="activity-row-top">
              <span className="ellipsis" title={j.title}>
                {j.title}
              </span>
              <span className="mono small dim">{j.state === "stopped" ? "stopped" : "done"}</span>
            </div>
            <div className="mono dim small ellipsis">{j.source}</div>
          </div>
        </div>
      ))}
      <button
        className="btn sm primary activity-open"
        onClick={() => {
          onClose();
          useStore.getState().openActivity();
        }}
      >
        <ArrowSquareOut /> Open Activity
      </button>
    </div>,
    document.body,
  );
}

/** One job, small: for the drop-down (and the Home's Activity block). */
export function JobRow({ j, lookup }: { j: Job; lookup: (k: string) => MediaItem | undefined }) {
  const left = useCountdown(j.paused ? null : j.eta);
  const first = j.items.map((x) => lookup(x.key)).find(Boolean);
  const pct = pctOf(j);
  return (
    <div className="activity-row">
      <span className="activity-row-thumb">{first ? <Thumb item={first} eager aspect={1} onClick={() => {}} /> : <Ring share={j.total ? j.done / j.total : null} paused={j.paused} size={28} />}</span>
      <div className="activity-row-main">
        <div className="activity-row-top">
          <span className="ellipsis" title={j.title}>
            {j.title}
          </span>
          <span className="mono accent2 small">{j.paused ? "paused" : j.total ? `${pct}%` : "…"}</span>
        </div>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="mono dim small ellipsis">
          {j.source} · {j.percent ? `${pct}%` : j.unknown ? "working…" : `${amount(j, j.done)}/${amount(j, j.total)}`}
          {left != null && j.total > j.done ? ` · ~${fmtEta(left)} left` : ""}
        </div>
      </div>
      <JobControls j={j} small />
    </div>
  );
}

function JobControls({ j, small }: { j: Job; small?: boolean }) {
  // Always both buttons: one a job can't offer is greyed out, saying why.
  const pause = j.pause;
  const stop = j.stop;
  return (
    <div className="activity-controls">
      <button
        className="btn sm ghost"
        disabled={!can(pause) || j.stopping}
        onClick={() => can(pause) && pause(!j.paused)}
        title={!can(pause) ? pause.cannot : j.paused ? "Carry on" : "Pause; what is done stays done"}
      >
        {j.paused ? <Play /> : <Pause />}
        {!small && (j.paused ? " Resume" : " Pause")}
      </button>
      <button className="btn sm ghost" disabled={!can(stop) || j.stopping} onClick={() => can(stop) && stop()} title={!can(stop) ? stop.cannot : j.stopping ? "Stopping after the step it is on" : "Stop; what is done stays done"}>
        <Stop />
        {!small && (j.stopping ? " Stopping…" : " Stop")}
      </button>
    </div>
  );
}

/** Everything running, with what each one is working on. Not in the tab bar: the ring at the top leads here. */
export function ActivityScreen() {
  const jobs = useActivity();
  const lookup = useItemLookup();
  const back = useStore((s) => s.closeActivity);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) back();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [back]);
  return (
    <div className="screen">
      <TopNav current="activity" />
      <div className="activity-page">
        <div className="activity-page-head">
          <button className="btn sm ghost" onClick={back} title="Back (Esc)">
            <ArrowLeft /> Back
          </button>
          <h2>Activity</h2>
          <span className="mono dim">{jobs.length ? `${jobs.length} running` : ""}</span>
        </div>
        {jobs.length === 0 && (
          <div className="activity-empty panel">
            <div>Nothing is running.</div>
            <div className="dim small">Duplicate scans, tag indexing, downloads and plugins' jobs show up here while they run.</div>
            <button className="btn primary" onClick={back}>
              Back
            </button>
          </div>
        )}
        {jobs.map((j) => (
          <JobCard key={j.id} j={j} lookup={lookup} />
        ))}
      </div>
    </div>
  );
}

function JobCard({ j, lookup }: { j: Job; lookup: (k: string) => MediaItem | undefined }) {
  const left = useCountdown(j.paused ? null : j.eta);
  const pct = pctOf(j);
  const items = j.items.map((x) => ({ ...x, item: lookup(x.key) }));
  return (
    <section className="job-card panel">
      <div className="job-head">
        <Ring share={j.total ? j.done / j.total : null} paused={j.paused} size={26} />
        <div className="job-title">
          <h3 className="ellipsis" title={j.title}>
            {j.title}
          </h3>
          <span className="dim small">{j.source}</span>
        </div>
        {j.state && <span className="badge accent2">{j.state}</span>}
        <span className="grow" />
        <JobControls j={j} />
        {j.open && (
          <button className="btn sm" onClick={j.open.go}>
            {j.open.label}
          </button>
        )}
      </div>
      <div className="progress-bar job-bar">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="job-stats mono">
        {j.percent ? (
          <b>{pct}%</b>
        ) : j.unknown ? (
          <span className="dim" title={j.unknown}>
            working…
          </span>
        ) : (
          <span>
            <b>{amount(j, j.done)}</b>
            <span className="dim"> / {j.total ? amount(j, j.total) : "?"}</span>
          </span>
        )}
        <span className="accent2">{j.total ? `${pct}%` : "starting"}</span>
        <span className="dim">{j.paused ? "paused" : left != null && j.total > j.done ? `~${fmtEta(left)} left` : ""}</span>
      </div>
      {j.detail && (
        <div className="job-detail mono small dim ellipsis" title={j.detail}>
          {j.detail}
        </div>
      )}
      {items.length > 0 && (
        <div className="job-thumbs">
          {items.map((x) => (
            <div key={x.key} className="job-thumb">
              {x.item ? <Thumb item={x.item} eager aspect={1} onClick={() => {}} /> : <div className="thumb-ph mono">…</div>}
              <div className="small ellipsis" title={x.name ?? x.item?.name ?? x.key}>
                {x.name ?? x.item?.name ?? x.key.split("/").pop()}
              </div>
              {x.note && <div className="mono dim small">{x.note}</div>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
