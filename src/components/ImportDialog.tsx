import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, Books, Copy, File as FileIcon, FolderOpen, Plus, Tray, X } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { useStore } from "../store";
import { api, fileSrc } from "../lib/api";
import { PART, dayOf, exactCopies, filedFolder, folderName, folderUnder, madeFromKnown, partOf, planParts, sizeCandidates, typedFolders, within, type Duplicate, type Incoming } from "../lib/filing";
import { folderLabel, useOwnFolders } from "./OwnFolderPicker";
import { useVersions } from "../versionsStore";
import { naturalCompare } from "../lib/format";

type Into = "bucket" | "album";
type Step = { at: "choose" } | { at: "looking" } | { at: "review"; incoming: Incoming[]; dupes: Duplicate[] } | { at: "importing" } | { at: "done"; folders: string[]; count: number };

const IMAGE = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** A folder's name as the new folder's, unless it is a camera's own (DCIM, 100CANON, 101APPLE…). */
const eventName = (p: string) => (/^(dcim|\d{3}[a-z_]+|camera|camera roll)$/i.test(base(p)) ? "" : base(p));
const day = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date();
};

/**
 * Bringing pictures in: from a card, a phone or another folder (copied) or from elsewhere in the
 * library (moved), into a bucket (itself, a folder of yours in it at any depth, or a new one) or as
 * an album. Never loose into a folder: an import is filed by the day it came in, in the folder
 * chosen, split into parts of 1000. Exact copies of what the library has (or of each other) are
 * listed first and left out unless ticked back; ones already in the library can go to the trash.
 */
/** A PDF: it comes in as an album, never as a picture. */
const isPdf = (path: string) => /\.pdf$/i.test(path);

export function ImportDialog() {
  const req = useStore((x) => x.importOpen);
  const root = useStore((x) => x.root);
  const library = useStore((x) => x.library);
  const buckets = useMemo(() => library?.targets.filter((t) => t.bucket) ?? [], [library]);
  // Whether an import ran: what asked for it hears so as the dialog closes.
  const ran = useRef(false);
  const close = (back = true) => {
    useStore.setState({ importOpen: null });
    if (ran.current) req?.done?.(back);
    req?.closed?.();
  };
  // Picks from Find: their files are the sources; a work of several pages chosen as an album is one of its own, every other page a single picture.
  const works = req?.works;
  const several = works?.filter((w) => w.album && w.files.length > 1) ?? [];
  const singles = (works?.length ?? 0) - several.length;

  const [sources, setSources] = useState<string[]>(() => (works ? works.flatMap((w) => w.files) : (req?.sources ?? [])));
  const [into, setInto] = useState<Into>("bucket");
  const [bucket, setBucket] = useState(buckets[0]?.id ?? "");
  const [newBucket, setNewBucket] = useState("");
  // The folder of yours it goes into (the bucket's own when none is chosen), and one to make in it.
  const [folder, setFolder] = useState("");
  const [name, setName] = useState(() => (req?.sources?.length === 1 ? eventName(req.sources[0]) : ""));
  const [date, setDate] = useState(dayOf(new Date()));
  const [albumRoot, setAlbumRoot] = useState(library?.albumRoots[0] ?? "");
  const [album, setAlbum] = useState(() => (req?.sources?.length === 1 ? base(req.sources[0]) : ""));
  const [checkDupes, setCheckDupes] = useState(true);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [trashDupes, setTrashDupes] = useState(true);
  const [step, setStep] = useState<Step>({ at: "choose" });

  useEffect(() => {
    void useStore.getState().loadAll();
  }, []);
  useEffect(() => {
    if (!bucket && buckets[0]) setBucket(buckets[0].id);
  }, [buckets, bucket]);

  const target = buckets.find((b) => b.id === bucket);
  // The folders of yours in the chosen bucket, empty ones too (the bucket itself first).
  const known = useOwnFolders(target?.path);
  const parent = target && folder && within(folder, target.path) ? folder : (target?.path ?? "");
  // A new folder named in it, each name spelled as a folder there already is when one is.
  const typed = typedFolders(name);
  // Not before the folders there are read: one there in another case would be made again.
  const filedIn = target && (known || !typed.names.length) ? folderUnder(parent, typed.names, known ?? []) : "";
  const isNew = !!known && !!filedIn && !known.includes(filedIn);
  // Where it goes, before parts.
  const dest = into === "album" ? (albumRoot && folderName(album) ? `${albumRoot}/${folderName(album)}` : "") : !filedIn || typed.bad ? "" : filedFolder(filedIn, day(date));
  // Find's works chosen as albums go into the album folder (or, without one, a folder each where the rest go).
  const severalIn = albumRoot || dest;
  const ready = works ? sources.length > 0 && (!singles || !!dest) && (!several.length || !!severalIn) : sources.length > 0 && !!dest;

  const pick = async (directory: boolean) => {
    const got = await open({ multiple: true, directory });
    const list = (Array.isArray(got) ? got : got ? [got] : []).map(String);
    if (!list.length) return;
    setSources((s) => [...new Set([...s, ...list])]);
    if (list.length === 1 && directory) {
      if (!name) setName(eventName(list[0]));
      if (!album) setAlbum(base(list[0]));
    }
  };

  const makeBucket = async () => {
    const t = await useStore.getState().addBucket(newBucket);
    if (t) {
      setBucket(t.id);
      setFolder("");
      setNewBucket("");
    }
  };

  const look = async () => {
    if (!root || !library) return;
    setStep({ at: "looking" });
    try {
      const incoming = await api.importScan(root, sources, library.trashDir);
      if (!incoming.length) {
        useStore.getState().toast("No pictures or videos in what was chosen", "warn");
        setStep({ at: "choose" });
        return;
      }
      let dupes: Duplicate[] = [];
      if (checkDupes) {
        // The pictures versions were made from count too (a page already cleaned, say): known by fingerprint.
        await useVersions.getState().load();
        const madeFrom = madeFromKnown(useVersions.getState().links);
        const known = [...useStore.getState().allItems.map((i) => ({ path: i.primary, size: i.size })), ...madeFrom.known];
        const cand = sizeCandidates(incoming, known);
        const paths = [...cand.incoming, ...cand.library.filter((p) => !madeFrom.fp.has(p))];
        if (paths.length) {
          const prints = await api.importFingerprints(root, paths);
          const fp = new Map(madeFrom.fp);
          paths.forEach((p, i) => prints[i] && fp.set(p, prints[i]!));
          dupes = exactCopies(incoming, fp, known).map((d) => {
            const v = madeFrom.versionOf.get(d.of);
            return v ? { ...d, of: `${root}/${v.of}`, where: "version" as const, note: v.note } : d;
          });
        }
      }
      setKeep(new Set());
      setStep({ at: "review", incoming, dupes });
    } catch (e) {
      if (String(e) !== "stopped") useStore.getState().toast(`Could not look through it: ${String(e)}`, "error");
      setStep({ at: "choose" });
    }
  };

  const run = async (incoming: Incoming[], dupes: Duplicate[]) => {
    const s = useStore.getState();
    if (!root || !s.library) return;
    setStep({ at: "importing" });
    try {
      const skipped = new Set(dupes.filter((d) => !keep.has(d.path)).map((d) => d.path));
      const files = incoming.filter((f) => !skipped.has(f.path)).map((f) => f.path);
      // An album stays whole; anything else fills its folder up to PART and then its parts. A work of
      // several pages from Find chosen as an album is one of its own.
      const albumOf = new Map(several.flatMap((w) => w.files.map((f) => [f, `${severalIn}/${folderName(w.folder) || "Untitled"}`] as const)));
      const own = files.filter((f) => albumOf.has(f)).sort(naturalCompare).map((src) => ({ src, dest: albumOf.get(src)! }));
      // A PDF is an album of its own: straight into the album folder, whatever the rest does.
      const pdfs = files.filter(isPdf);
      if (pdfs.length && !albumRoot) s.toast(`${pdfs.length} PDF${pdfs.length === 1 ? " was" : "s were"} left out: PDFs come in as albums, and there's no album folder yet (Settings → Folders)`, "warn");
      const pdfPlan = albumRoot ? pdfs.map((src) => ({ src, dest: albumRoot })) : [];
      const rest = files.filter((f) => !albumOf.has(f) && !isPdf(f));
      let plan: { src: string; dest: string }[];
      if (!rest.length) plan = [];
      else if (into === "album") plan = [...rest].sort(naturalCompare).map((src) => ({ src, dest }));
      else {
        // What the folder and its parts hold now: parts fill in order, so up to the first with room.
        const have: number[] = [];
        for (let k = 1; !have.length || have[have.length - 1] >= PART; k++) have.push(await api.listDir(root, partOf(dest, k)).then((es) => es.filter((e) => !e.isDir).length, () => 0));
        plan = planParts(rest, dest, (f) => {
          const m = /, part (\d+)$/.exec(f);
          return have[m ? Number(m[1]) - 1 : 0] ?? 0;
        });
      }
      plan = [...plan, ...own, ...pdfPlan];
      const placed = await api.importFiles(root, plan);
      req?.placed?.(plan.map((p, i) => [p.src, placed[i]] as [string, string | null]).filter((m): m is [string, string] => !!m[1]));
      // Those moved from inside the library: their ratings, tags and the rest go with them.
      const inside = new Set(incoming.filter((f) => f.inside).map((f) => f.path));
      const moved = plan.map((p, i) => [p.src, placed[i]] as [string, string | null]).filter((m): m is [string, string] => !!m[1] && inside.has(m[0]));
      if (moved.length) s.relocatePaths(moved);
      // Exact copies already in the library, left behind: to the trash if asked.
      const extra = dupes.filter((d) => !keep.has(d.path) && inside.has(d.path)).map((d) => d.path);
      if (trashDupes && extra.length) {
        const trash = `${root}/${s.library.trashDir}`;
        const went = await api.fsMove(root, extra, trash);
        s.relocatePaths(extra.map((p, i) => [p, went[i]] as [string, string]).filter(([, to]) => !!to));
      }
      useStore.setState({ allStale: true, albumsLoaded: false });
      await s.rescan(true);
      const count = placed.filter(Boolean).length;
      s.toast(`Imported ${count} file${count === 1 ? "" : "s"}${skipped.size ? `, ${skipped.size} duplicate${skipped.size === 1 ? "" : "s"} left out` : ""}`, "ok");
      ran.current = true;
      setStep({ at: "done", folders: [...new Set(plan.map((p) => p.dest))], count });
    } catch (e) {
      s.toast(`Import stopped: ${String(e)}`, "error");
      setStep({ at: "choose" });
    }
  };

  const lookThrough = async (folders: string[]) => {
    if (!root) return;
    const items = (await Promise.all(folders.map((f) => api.scanDir(root, f)))).flat();
    close(false);
    if (items.length) useStore.getState().openViewer(items, 0, { kind: "browse" });
  };

  if (!req) return null;
  return (
    <Modal title={works ? `Import from ${req?.from ?? "Find"}` : "Import"} onClose={() => close()} wide>
      <div className="import-dialog">
        {step.at === "choose" && (
          <>
            {works ? (
              <section className="import-sources">
                <span className="label">From {req?.from ?? "Find"}</span>
                <div>
                  {works.length} pick{works.length === 1 ? "" : "s"}, {sources.length} file{sources.length === 1 ? "" : "s"}, downloaded.
                  {several.length > 0 && (
                    <span className="dim">
                      {" "}
                      {several.length} {several.length === 1 ? "comes" : "come"} in as {several.length === 1 ? "an album of its" : "albums of their"} own, in <span className="mono">{severalIn || "the folder below"}/</span>; every other page as a single picture.
                    </span>
                  )}
                </div>
              </section>
            ) : (
              <section className="import-sources">
                <div className="row">
                  <span className="label grow">From</span>
                  <button className="btn sm" onClick={() => void pick(true)}>
                    <FolderOpen /> Folders…
                  </button>
                  <button className="btn sm" onClick={() => void pick(false)}>
                    <FileIcon /> Files…
                  </button>
                </div>
                {sources.map((p) => (
                  <div key={p} className="row import-source">
                    <span className="mono small ellipsis grow" title={p}>
                      {root && p.startsWith(`${root}/`) ? `${p.slice(root.length + 1)} (in the library: moved)` : p}
                    </span>
                    <button className="btn sm ghost" onClick={() => setSources(sources.filter((x) => x !== p))} title="Leave out">
                      <X />
                    </button>
                  </div>
                ))}
                {!sources.length && <div className="dim small">A card, a phone's folder, downloads… Copied in; what is in the library already is moved.</div>}
              </section>
            )}

            <section>
              <div className="row">
                <span className="label grow">{works ? (several.length && singles ? "Single pictures into" : "Into") : "Into"}</span>
                {!works && (
                  <span className="btn-group">
                    <button className={`btn sm ${into === "bucket" ? "active" : "ghost"}`} onClick={() => setInto("bucket")}>
                      <Tray /> A bucket
                    </button>
                    <button className={`btn sm ${into === "album" ? "active" : "ghost"}`} onClick={() => setInto("album")}>
                      <Books /> An album
                    </button>
                  </span>
                )}
              </div>
              {into === "bucket" ? (
                <div className="import-where">
                  <div className="scrap-field">
                    <span className="small dim">Bucket</span>
                    {buckets.length > 0 && (
                      <Select
                        compact
                        value={bucket}
                        options={buckets.map((b) => ({ value: b.id, label: b.name }))}
                        onChange={(v) => {
                          setBucket(v);
                          setFolder("");
                        }}
                        title="Professional, Private…"
                      />
                    )}
                    <input className="input" placeholder={buckets.length ? "or a new one" : "Name the first bucket: Private, Professional…"} value={newBucket} onChange={(e) => setNewBucket(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void makeBucket()} />
                    <button className="btn sm" disabled={!folderName(newBucket)} onClick={() => void makeBucket()}>
                      <Plus /> Add
                    </button>
                  </div>
                  {target && (
                    <>
                      <div className="scrap-field">
                        <span className="small dim">In</span>
                        <Select
                          compact
                          searchable
                          value={parent}
                          options={(known ?? [target.path]).map((f) => ({ value: f, label: f === target.path ? target.name : base(f), indent: f.split("/").length - target.path.split("/").length }))}
                          onChange={setFolder}
                          title={folderLabel(target, parent)}
                        />
                        <input className="input grow" autoFocus placeholder="A new folder in it: Weddings > James & Amy" value={name} onChange={(e) => setName(e.target.value)} title="Optional: a folder to make in the one chosen (> for one inside another)" />
                      </div>
                      <div className="scrap-field">
                        <span className="small dim">Came in</span>
                        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value || dayOf(new Date()))} title="The day it came in (today, unless you're filing an older one)" />
                      </div>
                      {typed.bad && <div className="small warn-text">“{typed.bad}” would read as one of the year or day folders filing makes: name it something else.</div>}
                    </>
                  )}
                </div>
              ) : (
                <div className="import-where">
                  {(library?.albumRoots.length ?? 0) > 1 && (
                    <div className="scrap-field">
                      <span className="small dim">Albums in</span>
                      <Select compact value={albumRoot} options={(library?.albumRoots ?? []).map((r) => ({ value: r, label: r }))} onChange={setAlbumRoot} />
                    </div>
                  )}
                  {library?.albumRoots.length ? (
                    <input className="input" placeholder="The album's name" value={album} onChange={(e) => setAlbum(e.target.value)} />
                  ) : (
                    <div className="dim small">No album folder yet: add one under Albums first.</div>
                  )}
                </div>
              )}
              {dest && (
                <div className="mono small import-dest">
                  → {dest}/{into === "bucket" ? <span className="dim"> ({isNew ? "a new folder; " : ""}parts of {PART} if it's more)</span> : null}
                </div>
              )}
            </section>

            <label className="check small">
              <input type="checkbox" checked={checkDupes} onChange={(e) => setCheckDupes(e.target.checked)} /> Look for duplicates: exact copies of what's in the library, or twice in this import
            </label>
            <div className="row">
              {!works && (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    close();
                    useStore.setState({ organiseOpen: true });
                  }}
                >
                  Organise what's here already…
                </button>
              )}
              <span className="grow" />
              <button className="btn ghost" onClick={() => close()}>
                Cancel
              </button>
              <button className="btn primary" disabled={!ready} onClick={() => void look()}>
                Next
              </button>
            </div>
          </>
        )}

        {step.at === "looking" && <div className="dim">Looking through it{checkDupes ? " and for duplicates" : ""}… (in Activity)</div>}

        {step.at === "review" && (
          <Review
            incoming={step.incoming}
            dupes={step.dupes}
            keep={keep}
            setKeep={setKeep}
            trashDupes={trashDupes}
            setTrashDupes={setTrashDupes}
            onBack={() => setStep({ at: "choose" })}
            onImport={() => void run(step.incoming, step.dupes)}
            dest={dest || severalIn}
            from={works ? (req?.from ?? "Find") : undefined}
          />
        )}

        {step.at === "importing" && <div className="dim">Importing… (in Activity, where it can be paused or stopped)</div>}

        {step.at === "done" && (
          <div className="import-done">
            <div>
              {step.count} file{step.count === 1 ? "" : "s"} in {step.folders.length === 1 ? <span className="mono">{step.folders[0]}</span> : `${step.folders.length} folders`}.
            </div>
            <div className="row">
              <span className="grow" />
              <button className="btn ghost" onClick={() => close()}>
                Close
              </button>
              <button className="btn primary" onClick={() => void lookThrough(step.folders)}>
                Look through them
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The import before it runs: how many come in (copied, moved), and the exact copies, left out unless ticked. */
function Review({ incoming, dupes, keep, setKeep, trashDupes, setTrashDupes, onBack, onImport, dest, from }: { incoming: Incoming[]; dupes: Duplicate[]; keep: Set<string>; setKeep: (k: Set<string>) => void; trashDupes: boolean; setTrashDupes: (v: boolean) => void; onBack: () => void; onImport: () => void; dest: string; from?: string }) {
  const root = useStore((x) => x.root);
  const left = dupes.filter((d) => !keep.has(d.path));
  const coming = incoming.length - left.length;
  const moved = incoming.filter((f) => f.inside && !left.some((d) => d.path === f.path)).length;
  const insideDupes = left.filter((d) => incoming.find((f) => f.path === d.path)?.inside).length;
  const rel = (p: string) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const toggle = (p: string) => {
    const next = new Set(keep);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setKeep(next);
  };
  return (
    <div className="import-review">
      <div>
        <b>{coming}</b> file{coming === 1 ? "" : "s"} into <span className="mono">{dest}</span>
        {from ? <span className="dim"> (downloaded from {from})</span> : moved ? <span className="dim"> ({moved} moved from elsewhere in the library, the rest copied)</span> : <span className="dim"> (copied; the originals stay)</span>}
      </div>
      {dupes.length > 0 ? (
        <>
          <div className="row">
            <Copy />
            <span className="grow">
              <b>{dupes.length}</b> exact cop{dupes.length === 1 ? "y" : "ies"}: left out, unless you tick {dupes.length === 1 ? "it" : "them"}.
            </span>
            <button className="btn sm ghost" onClick={() => setKeep(keep.size ? new Set() : new Set(dupes.map((d) => d.path)))}>
              {keep.size ? "Leave all out" : "Import all anyway"}
            </button>
          </div>
          <div className="import-dupes">
            {dupes.map((d) => (
              <label key={d.path} className={`import-dupe ${keep.has(d.path) ? "kept" : ""}`}>
                <input type="checkbox" checked={keep.has(d.path)} onChange={() => toggle(d.path)} />
                <span className="import-thumb">{IMAGE.test(d.path) ? <img src={fileSrc(d.path)} alt="" loading="lazy" draggable={false} /> : <FileIcon />}</span>
                <span className="grow ellipsis">
                  <span className="mono small" title={d.path}>
                    {base(d.path)}
                  </span>
                  <span className="dim small ellipsis" title={d.of}>
                    {d.where === "library" ? `in the library already: ${rel(d.of)}` : d.where === "version" ? `its ${d.note} version is in the library: ${rel(d.of)}` : `twice in this import: also ${base(d.of)}`}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {insideDupes > 0 && (
            <label className="check small">
              <input type="checkbox" checked={trashDupes} onChange={(e) => setTrashDupes(e.target.checked)} /> Put the {insideDupes} left out that are in the library already into the trash
            </label>
          )}
        </>
      ) : (
        <div className="dim small">No exact copies.</div>
      )}
      <div className="row">
        <button className="btn ghost" onClick={onBack}>
          <ArrowLeft /> Back
        </button>
        <span className="grow" />
        <button className="btn primary" disabled={!coming} onClick={onImport}>
          Import {coming} file{coming === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}
