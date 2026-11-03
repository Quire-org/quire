import { useCallback, useEffect, useMemo, useState } from "react";
import { DownloadSimple, Plus } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { useStore } from "../store";
import { api } from "../lib/api";
import { steppedJob, type Gate } from "../lib/jobs";
import { PART, filedFolder, folderName, fromRoot, isFilingName, ownFolderOf, partOf, planParts, targetFor, within } from "../lib/filing";
import { naturalCompare } from "../lib/format";
import { isPdfPage } from "../lib/pdf";
import { folderLabel } from "./OwnFolderPicker";
import type { DirEntryInfo, Library, MediaItem, Target } from "../lib/types";

type Action = "leave" | "keep";

/** Pictures straight in a bucket or a folder of yours in one, not in its year and day folders yet. */
interface Loose {
  folder: string;
  bucket: Target;
  items: MediaItem[];
}

/** The name a folder kept whole gets in its bucket: its own, unless that reads as a year or a day filing makes. */
export const keptName = (name: string) => (isFilingName(name) ? `${name} (kept)` : name);

/**
 * The pictures loose in folders of yours: straight in a bucket, or in a folder of yours in one (at
 * any depth), not in a year and day folder. Albums, a PDF's pages, the trash and album folders aren't.
 */
function looseIn(items: MediaItem[], library: Library, root: string): Loose[] {
  const buckets = library.targets.filter((t) => t.bucket);
  const albumRoots = library.albumRoots.map((r) => fromRoot(root, r));
  const by = new Map<string, Loose>();
  for (const i of items) {
    if (i.albumKey || isPdfPage(i) || within(i.dir, library.trashDir) || albumRoots.some((r) => within(i.dir, r))) continue;
    const bucket = targetFor(i.dir, buckets);
    if (!bucket || ownFolderOf(i.dir, bucket.path) !== i.dir) continue;
    const at = by.get(i.dir) ?? { folder: i.dir, bucket, items: [] };
    at.items.push(i);
    by.set(i.dir, at);
  }
  return [...by.values()].sort((a, b) => naturalCompare(a.folder, b.folder));
}

/**
 * A folder's loose pictures filed by today's date inside it (`<folder>/<year>/<day>`, parts of 1000,
 * a pair kept together), each moved as a whole and told to `onEach`. What moved is followed (ratings,
 * tags and the rest), a move failing halfway too.
 */
async function fileLoose(root: string, loose: Loose, gate: Gate, onEach: (name: string) => void): Promise<void> {
  const base = filedFolder(loose.folder, new Date());
  // What the day's folder and its parts hold now: parts fill in order, so up to the first with room.
  const have: number[] = [];
  for (let k = 1; !have.length || have[have.length - 1] >= PART; k++) have.push(await api.listDir(root, partOf(base, k)).then((es) => es.filter((e) => !e.isDir).length, () => 0));
  const plan = planParts(
    loose.items.map((i) => i.primary),
    base,
    (f) => {
      const m = /, part (\d+)$/.exec(f);
      return have[m ? Number(m[1]) - 1 : 0] ?? 0;
    },
  );
  // A picture's other files (its RAW, its Live Photo's video) go with it: planned by the picture.
  const destOf = new Map(plan.map((p) => [p.src, p.dest]));
  const moved: [string, string][] = [];
  try {
    for (const it of loose.items) {
      if (!(await gate.pass())) break;
      const res = await api.moveItem(root, it, destOf.get(it.primary) ?? base);
      moved.push(...res.moved);
      onEach(it.name);
    }
  } finally {
    if (moved.length) useStore.getState().relocatePaths(moved);
  }
}

/**
 * The guided pass for what is in the library already. Each folder at its top: left as it is, kept
 * whole (its name too) straight in a bucket, its loose pictures and those of the folders of yours in
 * it then filed by the day inside each, or its pictures brought in through the import (with the
 * duplicate check), the emptied folder then removed. And pictures loose in folders of yours (in a
 * bucket, moved there in Finder, say), filed by the day where they are when ticked. Nothing moves
 * until Organise; the moves run in Activity, and ratings, tags and covers go with every file.
 */
export function OrganiseDialog() {
  const root = useStore((x) => x.root);
  const library = useStore((x) => x.library);
  const all = useStore((x) => x.allItems);
  const buckets = useMemo(() => library?.targets.filter((t) => t.bucket) ?? [], [library]);
  const [rows, setRows] = useState<DirEntryInfo[] | null>(null);
  const [plan, setPlan] = useState<Record<string, { action: Action; bucket: string }>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [newBucket, setNewBucket] = useState("");
  const [running, setRunning] = useState(false);
  const close = () => useStore.setState({ organiseOpen: false });

  // The folders at the top, but the targets (the buckets among them), the album folders and the trash.
  const load = useCallback(async () => {
    if (!root || !library) return;
    const skip = new Set([...library.targets.filter((t) => !t.path.startsWith("/")).map((t) => t.path), ...library.albumRoots.map((r) => fromRoot(root, r)), library.trashDir]);
    const top = (await api.listDir(root, root)).filter((e) => e.isDir && !e.name.startsWith(".") && !skip.has(e.name)).sort((a, b) => naturalCompare(a.name, b.name));
    setRows(top);
  }, [root, library]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void useStore.getState().loadAll();
  }, []);
  const loose = useMemo(() => (root && library ? looseIn(all, library, root) : []), [all, library, root]);

  const rowPlan = (path: string) => plan[path] ?? { action: "leave" as Action, bucket: buckets[0]?.id ?? "" };
  const setRow = (path: string, patch: Partial<{ action: Action; bucket: string }>) => setPlan((p) => ({ ...p, [path]: { ...rowPlan(path), ...patch } }));
  const keeping = (rows ?? []).filter((r) => rowPlan(r.path).action === "keep" && buckets.some((b) => b.id === rowPlan(r.path).bucket));
  const filing = loose.filter((l) => ticked.has(l.folder));
  const tick = (folder: string) =>
    setTicked((t) => {
      const next = new Set(t);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  const makeBucket = async () => {
    if (await useStore.getState().addBucket(newBucket)) setNewBucket("");
  };

  // Its pictures into a folder, through the import; the folder goes once it is empty.
  const importRow = (r: DirEntryInfo) => {
    useStore.setState({
      organiseOpen: false,
      importOpen: {
        sources: [r.path],
        done: (back) => {
          void (async () => {
            const s = useStore.getState();
            if (!s.root) return;
            const left = await api.listDir(s.root, r.path).catch(() => null);
            if (left && left.every((e) => e.isDir && e.count === 0)) await api.fsDelete(s.root, [r.path]).catch(() => {});
            if (back) useStore.setState({ organiseOpen: true });
          })();
        },
      },
    });
  };

  const organise = async () => {
    const s = useStore.getState();
    if (!root || !s.library || (!keeping.length && !filing.length)) return;
    setRunning(true);
    let total = keeping.length + filing.reduce((n, l) => n + l.items.length, 0);
    let done = 0;
    const { job, gate } = steppedJob({ title: keeping.length ? `Organising ${keeping.length} folder${keeping.length === 1 ? "" : "s"}` : "Filing loose pictures", source: "Organise", total });
    const each = (name: string) => job.update({ done: ++done, detail: name });
    try {
      // Everything known: what is in a folder kept is filed from it.
      await s.loadAll();
      for (const r of keeping) {
        if (!(await gate.pass())) break;
        const bucket = buckets.find((b) => b.id === rowPlan(r.path).bucket)!;
        job.update({ done, detail: r.name });
        // Whole, straight in the bucket: its name kept, unless that reads as a year or a day.
        let from = r.path;
        if (keptName(r.name) !== r.name) {
          const renamed = await api.fsRename(root, from, keptName(r.name));
          s.relocatePaths([[from, renamed]]);
          from = renamed;
        }
        const [now] = await api.fsMove(root, [from], `${root}/${bucket.path}`);
        s.relocatePaths([[from, now]]);
        job.update({ done: ++done });
        // Its loose pictures, and those of the folders of yours in it, filed by the day in each.
        const lib = useStore.getState().library!;
        const inside = looseIn(useStore.getState().allItems, lib, root).filter((l) => within(l.folder, fromRoot(root, now)));
        total += inside.reduce((n, l) => n + l.items.length, 0);
        job.update({ total });
        for (const l of inside) await fileLoose(root, l, gate, each);
      }
      for (const l of filing) {
        if (!(await gate.pass())) break;
        // As they are now (a move just before may have filed some already).
        const fresh = looseIn(useStore.getState().allItems, useStore.getState().library!, root).find((x) => x.folder === l.folder);
        if (fresh) await fileLoose(root, fresh, gate, each);
      }
      useStore.setState({ allStale: true, albumsLoaded: false });
      await s.rescan(true);
      if (gate.stopped) s.toast(`Organising stopped: ${done} of ${total} done, the rest left as they were`, "warn");
      else s.toast(keeping.length ? `Organised ${keeping.length} folder${keeping.length === 1 ? "" : "s"}` : `Filed the loose pictures of ${filing.length} folder${filing.length === 1 ? "" : "s"}`, "ok");
      setPlan({});
      setTicked(new Set());
      await load();
    } catch (e) {
      s.toast(`Organising stopped: ${String(e)}`, "error");
    } finally {
      job.finish();
      setRunning(false);
    }
  };

  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const action = keeping.length && filing.length ? `Organise ${plural(keeping.length, "folder")}, file ${filing.length}` : keeping.length ? `Organise ${plural(keeping.length, "folder")}` : filing.length ? `File loose pictures in ${plural(filing.length, "folder")}` : "Organise";

  return (
    <Modal title="Organise what's here" onClose={close} wide>
      <div className="organise">
        <div className="dim small">Each folder at the top of the library: leave it, keep it whole (with its name) in a bucket, or bring its pictures in through the import, with the duplicate check. Kept, the pictures loose in it, and in the folders inside it, are filed by today's date where they are. Nothing moves until you press Organise; ratings, tags and covers go with every file.</div>
        <div className="scrap-field">
          <span className="small dim">Buckets</span>
          <span className="small">{buckets.length ? buckets.map((b) => b.name).join(", ") : "none yet"}</span>
          <span className="grow" />
          <input className="input" placeholder="New bucket: Private, Professional…" value={newBucket} onChange={(e) => setNewBucket(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void makeBucket()} />
          <button className="btn sm" disabled={!folderName(newBucket)} onClick={() => void makeBucket()}>
            <Plus /> Add
          </button>
        </div>
        {!rows ? (
          <div className="dim small">Looking at the library…</div>
        ) : !rows.length ? (
          <div className="dim small">Nothing left at the top: every folder is in a bucket, a target or an album folder.</div>
        ) : (
          <div className="organise-rows">
            {rows.map((r) => {
              const p = rowPlan(r.path);
              const into = buckets.find((b) => b.id === p.bucket);
              return (
                <div key={r.path} className="organise-row">
                  <span className="grow ellipsis" title={r.path}>
                    <b>{r.name}</b> <span className="dim small">{plural(r.count, "file")}</span>
                  </span>
                  <span className="btn-group">
                    <button className={`btn sm ${p.action === "leave" ? "active" : "ghost"}`} onClick={() => setRow(r.path, { action: "leave" })}>
                      Leave
                    </button>
                    <button className={`btn sm ${p.action === "keep" ? "active" : "ghost"}`} disabled={!buckets.length} onClick={() => setRow(r.path, { action: "keep" })} title="Moved whole into a bucket, its name kept">
                      Keep, in a bucket
                    </button>
                    <button className="btn sm ghost" onClick={() => importRow(r)} title="Its pictures into a folder of yours (duplicates checked); the folder goes when it's empty">
                      <DownloadSimple /> Import into…
                    </button>
                  </span>
                  {p.action === "keep" && (
                    <span className="organise-to">
                      <Select compact value={p.bucket} options={buckets.map((b) => ({ value: b.id, label: b.name }))} onChange={(v) => setRow(r.path, { bucket: v })} />
                      <span className="mono small dim">
                        → {into?.path}/{keptName(r.name)}/
                      </span>
                      {keptName(r.name) !== r.name && <span className="small dim"> · renamed: “{r.name}” reads as a year or a day</span>}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {loose.length > 0 && (
          <>
            <div className="row">
              <span className="label grow">Loose in your folders</span>
              <button className="btn sm ghost" onClick={() => setTicked(ticked.size === loose.length ? new Set() : new Set(loose.map((l) => l.folder)))}>
                {ticked.size === loose.length ? "Untick all" : "Tick all"}
              </button>
            </div>
            <div className="dim small">Pictures straight in a bucket or a folder of yours, not in its year and day folders. Ticked, they're filed by today's date inside the folder they're in, parts of {PART} past that.</div>
            <div className="organise-rows">
              {loose.map((l) => (
                <label key={l.folder} className="organise-row check">
                  <input type="checkbox" checked={ticked.has(l.folder)} onChange={() => tick(l.folder)} />
                  <span className="grow ellipsis" title={l.folder}>
                    {folderLabel(l.bucket, l.folder)}
                  </span>
                  <span className="dim small">{plural(l.items.length, "picture")}</span>
                </label>
              ))}
            </div>
          </>
        )}
        <div className="row">
          <span className="grow" />
          <button className="btn ghost" onClick={close}>
            Close
          </button>
          <button className="btn primary" disabled={(!keeping.length && !filing.length) || running} onClick={() => void organise()}>
            {running ? "Organising…" : action}
          </button>
        </div>
      </div>
    </Modal>
  );
}
