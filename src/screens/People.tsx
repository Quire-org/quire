import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, FolderMinus, GitMerge, Image as ImageIcon, MagnifyingGlass, PencilSimple, Scissors, SortAscending, SortDescending, UserMinus, Users, X } from "@phosphor-icons/react";
import { TopNav } from "../components/TopNav";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Modal } from "../components/Modal";
import { OnePicture } from "../components/ComparePair";
import { FolderPicker } from "../components/FolderPicker";
import { StickerBanner } from "../components/StickerBanner";
import { loadPref, savePref, useStore } from "../store";
import { useTags } from "../tagsStore";
import { asTag, characterGuess, characterTagOf, kindOfFace, nameMatches, niceTag, scanSoon, seenIn, seriesOfTag, useFaceMode, usePeople, type Person, type PersonKind } from "../peopleStore";
import { canThumb, faceUrl, mediaUrl, thumbUrl } from "../lib/api";
import { formatTime } from "../lib/format";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { allSources } from "../lib/sources";
import { useScrollMemory } from "../lib/scrollMemory";
import { useRunPick } from "../lib/useRunPick";
import type { FaceView, MediaItem } from "../lib/types";

type Filter = "all" | PersonKind;

/** The library's pictures by key (album pages too), for faces to find their pictures: one map for
 * the whole screen (every face and tile asks), made again only when the list changes. */
let itemsMap: { all: MediaItem[]; map: Map<string, MediaItem> } | null = null;
function useItems(): Map<string, MediaItem> {
  const all = useStore((s) => s.allItems);
  if (itemsMap?.all !== all) itemsMap = { all, map: new Map(all.map((i) => [i.key, i])) };
  return itemsMap.map;
}

/** Faces that look like someone, theirs once said yes to (least sure first), by person. */
function useSuggestions(): Map<string, { face: number; s: number }[]> {
  const matches = usePeople((s) => s.sorted?.matches);
  const doc = usePeople((s) => s.doc);
  return useMemo(() => {
    const out = new Map<string, { face: number; s: number }[]>();
    const no = new Set(doc?.no ?? []);
    for (const m of matches ?? []) {
      const a = doc?.faces[String(m.face)];
      // Said yes to, put aside, or said not to be them: gone at once, before the matching has looked again.
      if (!doc?.people[m.person] || (a && !a.auto) || no.has(m.face) || doc.not[String(m.face)]?.includes(m.person)) continue;
      out.set(m.person, [...(out.get(m.person) ?? []), { face: m.face, s: m.score }]);
    }
    for (const list of out.values()) list.sort((a, b) => a.s - b.s);
    return out;
  }, [matches, doc]);
}

/** The faces given someone but like none of their others, still to check, by person. */
function useDoubts(): Map<string, number[]> {
  const doubts = usePeople((s) => s.sorted?.doubts);
  const doc = usePeople((s) => s.doc);
  return useMemo(() => {
    const out = new Map<string, number[]>();
    for (const d of doubts ?? []) {
      const a = doc?.faces[String(d.face)];
      if (a && a.p === d.person && !a.ok && !a.auto) out.set(d.person, [...(out.get(d.person) ?? []), d.face]);
    }
    return out;
  }, [doubts, doc]);
}

/**
 * People: the real people in the photos and the characters in the drawings. Faces waiting for a
 * name lead the screen, named one group at a time from the keyboard; under them, everyone named.
 */
export function People() {
  const doc = usePeople((s) => s.doc);
  const open = usePeople((s) => s.open);
  const undo = usePeople((s) => s.undo);
  const root = useStore((s) => s.root);
  const [filter, setFilter] = useState<Filter>("all");
  const [converting, setConverting] = useState(false);
  const leaving = usePeople((s) => s.leaveOutOpen);
  const setLeaving = (on: boolean) => usePeople.setState({ leaveOutOpen: on });
  const person = open && doc?.people[open] ? doc.people[open] : null;
  // Back from a picture, where it was left.
  const body = useRef<HTMLDivElement>(null);
  useScrollMemory("people", body, !!doc && !person);

  useEffect(() => {
    void useStore.getState().loadAll();
    void usePeople.getState().load();
    void useTags.getState().load().then(() => useTags.getState().loadNames());
  }, [root]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || dialogOpen() || document.querySelector(".context-menu")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && usePeople.getState().undo) {
        e.preventDefault();
        usePeople.getState().revert();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === "escape") {
        if (usePeople.getState().open) usePeople.getState().setOpen(null);
        else st.openSortQueue();
      } else if (key === "b") st.openBrowse();
      else if (key === "a") st.openAlbums();
      else if (key === "d") st.openDupes();
      else if (key === "e") st.openFiles();
      else if (key === "l") st.openTags();
      else if (key === "k") st.openScrapbook();
      else if (key === "w") st.openArtists();
      else if (key === "g") st.set({ settingsOpen: true });
      else if (key === "h") st.toggleChrome();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="screen people">
      <TopNav current="people" />
      {!doc ? (
        <div className="find-note dim">Loading People…</div>
      ) : person ? (
        <PersonPage key={person.id} person={person} />
      ) : (
        <div className="people-body" ref={body}>
          <ScanState onLeave={() => setLeaving(true)} onConvert={() => setConverting(true)} />
          {doc.converted && <ConvertedBar />}
          <WhoStrip />
          <Roster filter={filter} setFilter={setFilter} />
        </div>
      )}
      {undo && (
        <div className="people-undo panel">
          <span>{undo.what}</span>
          <button className="btn sm ghost" onClick={usePeople.getState().revert}>
            Undo <kbd className="kbd">⌘Z</kbd>
          </button>
        </div>
      )}
      {converting && <ConvertDialog onClose={() => setConverting(false)} />}
      {leaving && <LeaveOutDialog onClose={() => setLeaving(false)} />}
    </div>
  );
}

/* ---------- the scan: models, what is left to look at, what is left out ---------- */

function ScanState({ onLeave, onConvert }: { onLeave: () => void; onConvert: () => void }) {
  const p = usePeople();
  const all = useStore((s) => s.allItems);
  const tagTypes = useTags((t) => t.data?.types ?? []);
  const [models, setModels] = useState<boolean | null>(null);
  useEffect(() => {
    void import("../plugins/engine").then(async ({ useEngine }) => {
      if (!useEngine.getState().catalog) await useEngine.getState().refresh().catch(() => {});
      const list = useEngine.getState().catalog?.models ?? [];
      // The face finder is needed; the character finder (drawn characters) is optional.
      usePeople.setState({ characters: !!list.find((m) => m.id === "characters")?.downloaded });
      setModels(!!list.find((m) => m.id === "faces")?.downloaded);
    });
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pending = useMemo(() => p.pending().length, [p.doc, p.scanned, all]);
  const faces = p.faces.length;
  return (
    <div className="people-scan">
      {models === false ? (
        <span className="grow">People needs the face finder (run on this computer): download it in Settings → Local models, under Used by Quire. The character finder beside it is optional, for drawn characters.</span>
      ) : p.scanning ? (
        <span className="grow dim">Looking for faces… (in Activity, where it can be paused or stopped). {faces.toLocaleString("en-GB")} found so far.</span>
      ) : pending ? (
        <span className="grow dim">
          {pending.toLocaleString("en-GB")} picture{pending === 1 ? "" : "s"} to look at for faces: by themselves once the tag index has nothing to do.
        </span>
      ) : (
        <span className="grow dim">
          {faces.toLocaleString("en-GB")} face{faces === 1 ? "" : "s"} found{p.doc!.exclude.length ? `, ${p.doc!.exclude.length} folder${p.doc!.exclude.length === 1 ? "" : "s"} left out` : ""}.
        </span>
      )}
      {models === false && (
        <button className="btn" onClick={() => useStore.getState().set({ modelsOpen: true })}>
          Local models…
        </button>
      )}
      {models && pending > 0 && !p.scanning && (
        <button className="btn" onClick={() => void p.scan()}>
          <MagnifyingGlass /> Look now
        </button>
      )}
      <button className="btn ghost" onClick={onLeave} title="Folders the face scan leaves out (strangers at a paid shoot, say)">
        <FolderMinus /> Leave out folders…
      </button>
      {tagTypes.length > 0 && !p.doc!.converted && (
        <button className="btn ghost" onClick={onConvert} title="Make people from a tag folder you used for people">
          <Users /> From tags…
        </button>
      )}
    </div>
  );
}

function LeaveOutDialog({ onClose }: { onClose: () => void }) {
  const p = usePeople();
  const all = useStore((s) => s.allItems);
  const [left, setLeft] = useState<Set<string> | null>(p.doc?.exclude.length ? new Set(p.doc.exclude) : null);
  const save = () => {
    const before = new Set(p.doc?.exclude ?? []);
    const now = [...(left ?? [])];
    p.setExclude(now);
    // Faces already found in what is now left out go; nothing there is looked at again.
    for (const f of now) if (!before.has(f)) p.forget(`${f}/`);
    onClose();
    scanSoon(2_000);
  };
  return (
    <Modal title="Folders left out of People" onClose={onClose}>
      <div className="leave-out">
        <p className="dim small">The face scan doesn't look in these, and faces already found there go. Pictures in them can still be anyone's by hand.</p>
        <FolderPicker items={all} selected={left} onChange={setLeft} />
        <div className="row">
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Leave these out
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- people from a tag folder ---------- */

function ConvertedBar() {
  const p = usePeople();
  const c = p.doc!.converted!;
  const doubts = useDoubts();
  const doubted = c.made.reduce((n, id) => n + (doubts.get(id)?.length ?? 0), 0);
  return (
    <div className="convert-bar panel">
      <Check size={20} />
      <div className="convert-bar-text">
        <b>
          {c.made.length} {c.made.length === 1 ? "person" : "people"} made from the “{c.folder}” tags; the tags are gone.
        </b>
        <div className="dim">The tags as they were are kept with People until you keep the people, so this can be undone.</div>
        {doubted > 0 && (
          <div className="dim">
            {doubted} tagged {doubted === 1 ? "picture's face looks" : "pictures' faces look"} like none of the others given that person (someone else in the picture, perhaps): they don't count for them until checked, under “to check” on their cards.
          </div>
        )}
      </div>
      <button
        className="btn ghost"
        onClick={() =>
          void p.revertConversion().then(
            (n) => useStore.getState().toast(`The “${c.folder}” tags are back on ${n.toLocaleString("en-GB")} pictures, and the people made from them gone`, "ok"),
            (e) => useStore.getState().toast(`Not undone: ${String(e)}`, "error"),
          )
        }
      >
        Undo the conversion
      </button>
      <button className="btn ghost" onClick={p.keepConversion} title="The people stay, and the tags can't be put back after this">
        Keep
      </button>
    </div>
  );
}

function ConvertDialog({ onClose }: { onClose: () => void }) {
  const p = usePeople();
  const data = useTags((t) => t.data);
  const types = data?.types ?? [];
  const likely = types.find((t) => /^(people|persons?|family|friends|characters?|who)$/i.test(t)) ?? types[0] ?? "";
  const [folder, setFolder] = useState(likely);
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const list of Object.values(data?.tags ?? {})) for (const t of list) if (t.startsWith(`${folder}/`)) out.set(t, (out.get(t) ?? 0) + 1);
    return [...out.entries()].sort((a, b) => b[1] - a[1]);
  }, [data, folder]);
  const total = counts.reduce((n, [, c]) => n + c, 0);
  return (
    <Modal title="People from tags" onClose={onClose}>
      <div className="convert">
        <label className="row">
          <span className="label">Tag folder</span>
          <select className="input" value={folder} onChange={(e) => setFolder(e.target.value)}>
            {types.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <ul className="convert-list">
          {counts.map(([t, c]) => (
            <li key={t}>
              <span className="chip">{t}</span>
              <ArrowRight className="faint" />
              <b>{t.slice(folder.length + 1).replace(/[_-]+/g, " ")}</b>
              <span className="mono faint">{c.toLocaleString("en-GB")}</span>
            </li>
          ))}
          {!counts.length && <li className="dim">No tags in this folder.</li>}
        </ul>
        <p className="dim">
          {counts.length} {counts.length === 1 ? "person" : "people"}, {total.toLocaleString("en-GB")} tagged pictures. In a picture with one face, that face becomes theirs (one like none of their others waits to be checked); faces in other pictures that look like them are suggested on their page, theirs only if you say yes. Then the tags go; until you keep the people, this can be undone, the tags' settings too.
        </p>
        <div className="row convert-actions">
          <span className="grow" />
          <button className="btn ghost" onClick={onClose}>
            Not now
          </button>
          <button
            className="btn primary"
            disabled={!counts.length}
            onClick={async () => {
              onClose();
              const n = await p.convert(folder);
              useStore.getState().toast(`${n} ${n === 1 ? "person" : "people"} made from the “${folder}” tags`, "ok");
            }}
          >
            Make {counts.length} {counts.length === 1 ? "person" : "people"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- a face, cut from its picture ---------- */

/** A face cut from its picture, square, with some of what is around it (`around`: how much more than the face). */
export const FaceCrop = memo(function FaceCrop({ face, size, around = 1.8, className = "" }: { face: FaceView; size: number; around?: number; className?: string }) {
  const items = useItems();
  const root = useStore((s) => s.root);
  const item = items.get(face.key);
  const [ratio, setRatio] = useState<number | null>(null);
  if (!item || !root) return <span className={`face-crop ${className}`} style={{ width: size, height: size }} />;
  // Cut out by the backend: a small square, not the whole picture (only once it scrolls near). A
  // face in a video is cut from the frame at its moment, which the crop says.
  if (canThumb(item) || item.kind === "video")
    return (
      <span className={`face-crop ${className}`} style={{ width: size, height: size }}>
        <img className="face-cut" src={faceUrl(root, item, face.bbox, size, around, face.at)} alt="" width={size} height={size} loading="lazy" decoding="async" draggable={false} />
        {face.at != null && <span className="face-at mono">{formatTime(face.at)}</span>}
      </span>
    );
  // A picture only the webview can read (HEIC, say): the whole of it, moved and clipped.
  const [x0, y0, x1, y1] = face.bbox;
  const src = mediaUrl(item);
  let style: React.CSSProperties = { opacity: 0 };
  if (ratio) {
    const h = 1 / ratio; // the picture's height, its width being 1
    const side = Math.max(x1 - x0, (y1 - y0) * h) * around;
    const scale = size / side;
    // Moved inside the picture where it's big enough, so no empty edge shows beside a face near one.
    const inside = (c: number, extent: number) => (side >= extent ? extent / 2 : Math.min(extent - side / 2, Math.max(side / 2, c)));
    const cx = inside((x0 + x1) / 2, 1);
    const cy = inside(((y0 + y1) / 2) * h, h);
    style = { width: scale, height: scale * h, left: size / 2 - cx * scale, top: size / 2 - cy * scale };
  }
  return (
    <span className={`face-crop ${className}`} style={{ width: size, height: size }}>
      <img src={src} alt="" draggable={false} loading="lazy" decoding="async" style={style} onLoad={(e) => setRatio(e.currentTarget.naturalWidth / Math.max(1, e.currentTarget.naturalHeight))} />
    </span>
  );
});

/** The face that stands for a person: theirs chosen, else their biggest. */
/** A face in a video, opened in the viewer: at the moment it was seen, paused there, the face picked. */
export function atItsMoment(face: FaceView) {
  if (face.at != null) useFaceMode.setState({ on: true, marking: false, picked: face.id, moment: { key: face.key, at: face.at, face: face.id } });
}

export function portraitOf(person: Person, faces: FaceView[]): FaceView | null {
  const chosen = person.portrait != null ? faces.find((f) => f.id === person.portrait) : null;
  return chosen ?? bestFace(faces);
}

/** The face that shows someone best: the largest, as surely a face as it is. */
const bestFace = (faces: FaceView[]) => faces.reduce<FaceView | null>((best, f) => (!best || f.size * f.score > best.size * best.score ? f : best), null);

/** Each person's faces. */
function useFacesOf(): Map<string, FaceView[]> {
  const doc = usePeople((s) => s.doc);
  const byId = usePeople((s) => s.byId);
  return useMemo(() => {
    const out = new Map<string, FaceView[]>();
    for (const [id, a] of Object.entries(doc?.faces ?? {})) {
      const f = byId.get(Number(id));
      if (f) out.set(a.p, [...(out.get(a.p) ?? []), f]);
    }
    return out;
  }, [doc, byId]);
}

/* ---------- who is this? ---------- */

/** Below this a face is "less sure": less like the rest of its group than faces of one person usually are. */
const SURE = { photo: 0.38, drawn: 0.74 };
/** A suggestion less sure: close to the line a face has to pass to be suggested at all (0.40, 0.74 in the face index). */
const SURE_SUGGESTED = { photo: 0.48, drawn: 0.8 };
/** Faces shown at once in a list of them (a group checked, faces to check): more on asking. */
const CHECK_PAGE = 120;
/** How many of each person's pictures were shown (Show more), and whose faces to check were open, for coming back to their page. */
const shownUpTo = new Map<string, number>();
const checking = new Set<string>();

/** Suggested faces the surest first, or the least sure first (those teach the matching the most): kept on this computer. */
const SUREST_KEY = "quire.people.surestFirst";

function WhoStrip() {
  const p = usePeople();
  const tags = useTags((t) => t.data);
  const names = useTags((t) => t.names);
  const [naming, setNaming] = useState(false);
  const [order, setOrder] = useState<number[]>([]);
  const [checking, setChecking] = useState(false);
  const [left, setLeft] = useState<Set<number>>(new Set());
  const strip = useRef<HTMLElement>(null);
  // Groups still waiting: their faces not named or put aside since they were sorted.
  const groups = useMemo(() => {
    const d = p.doc!;
    const no = new Set(d.no);
    return (p.sorted?.groups ?? [])
      .map((g) => {
        const keep = g.faces.map((f, i) => [f, g.scores[i] ?? 1] as const).filter(([f]) => !d.faces[String(f)] && !no.has(f));
        return { kind: g.kind, faces: keep.map(([f]) => f), scores: keep.map(([, s]) => s) };
      })
      .filter((g) => g.faces.length >= 2);
  }, [p.sorted, p.doc]);
  // "Later" puts a group at the back, for now.
  const queue = useMemo(() => [...groups].sort((a, b) => order.indexOf(a.faces[0]) - order.indexOf(b.faces[0])), [groups, order]);
  const g = queue[0];
  const first = g?.faces[0];
  // A new group: everything in it ticked again, the check closed.
  useEffect(() => {
    setLeft(new Set());
    setChecking(false);
    setCheckLimit(CHECK_PAGE);
  }, [first]);
  const ticked = g ? g.faces.filter((f) => !left.has(f)) : [];
  const unsure = g ? g.faces.filter((_, i) => g.scores[i] < SURE[g.kind]) : [];
  const keys = useMemo(() => [...new Set((g?.faces ?? []).map((f) => p.byId.get(f)?.key).filter((k): k is string => !!k))], [g, p.byId]);
  const guess = useMemo(() => (g?.kind === "drawn" ? characterGuess(keys, seenIn(keys, tags?.auto, names), names) : null), [g, keys, tags, names]);
  const later = () => g && setOrder([...order.filter((x) => x !== g.faces[0]), g.faces[0]]);
  const earlier = () => {
    const last = queue[queue.length - 1];
    if (last) setOrder([last.faces[0], ...order.filter((x) => x !== last.faces[0])]);
  };
  // Named after "Check all", each face was looked at: they're checked.
  const nameThem = (name: string, from: string | null) => ticked.length && p.name(ticked, name, from, [...left], checking);
  const [checkLimit, setCheckLimit] = useState(CHECK_PAGE);
  const putAside = () => ticked.length && p.dismiss(ticked);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!g || isTypingTarget(e.target) || dialogOpen() || e.metaKey || e.ctrlKey || e.altKey || naming) return;
      const el = document.activeElement;
      if (el && el !== document.body && !strip.current?.contains(el)) return;
      if (e.key === "Enter" && guess) nameThem(guess.name, guess.from);
      else if (e.key === "n" || e.key === "N") setNaming(true);
      else if (e.key === "x" || e.key === "X") putAside();
      else if (e.key === "c" || e.key === "C") setChecking(!checking);
      else if (e.key === "ArrowRight") later();
      else if (e.key === "ArrowLeft") earlier();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!g) return p.faces.length ? <div className="who-done dim">Every group of faces found has a name, or was put aside.</div> : null;
  const faces = g.faces.map((id) => p.byId.get(id)).filter((f): f is FaceView => !!f);
  // Most like the rest first: the ones to doubt come last.
  const byLikeness = g.faces.map((id, i) => ({ id, s: g.scores[i] })).sort((a, b) => b.s - a.s);
  const toggle = (id: number) => setLeft((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <section className="who panel" aria-label="Who is this?" ref={strip}>
      <div className="who-top">
        <div className="who-faces">
          {faces.slice(0, 3).map((f) => (
            <FaceCrop key={f.id} face={f} size={160} className={left.has(f.id) ? "left-out" : ""} />
          ))}
        </div>
        <div className="who-main">
          <h2>Who is this?</h2>
          <div className="mono dim">
            {g.faces.length} face{g.faces.length === 1 ? "" : "s"} in {keys.length} {g.kind === "photo" ? "photo" : "picture"}
            {keys.length === 1 ? "" : "s"} · {g.kind === "photo" ? "a person" : "a character"}
            {left.size > 0 && ` · ${left.size} left out`}
          </div>
          {guess && (
            <div className="who-guess">
              The anime tagger says <b>{guess.name}</b> {guess.from && <span className="faint">({guess.from})</span>}
            </div>
          )}
          <button className={`btn sm ${unsure.length ? "" : "ghost"} who-check`} onClick={() => setChecking(!checking)} title="Every face in the group, the ones least like the rest last: untick any that aren't them (C)">
            {checking ? "Done checking" : unsure.length ? `Check all ${g.faces.length}: ${unsure.length} less sure` : `Check all ${g.faces.length}`} <kbd className="kbd">C</kbd>
          </button>
          {naming ? (
            <NameField kind={g.kind === "drawn" ? "character" : "person"} onDone={(name) => (name && nameThem(name, guess && name === guess.name ? guess.from : null), setNaming(false))} />
          ) : (
            <div className="row who-actions keyed">
              {guess && (
                <button className="btn primary" disabled={!ticked.length} onClick={() => nameThem(guess.name, guess.from)}>
                  <Check /> It's {guess.name} <kbd className="kbd">⏎</kbd>
                </button>
              )}
              <button className={`btn ${guess ? "" : "primary"}`} disabled={!ticked.length} onClick={() => setNaming(true)}>
                <PencilSimple /> {guess ? "Someone else" : "Name"} <kbd className="kbd">N</kbd>
              </button>
              <button className="btn ghost" disabled={!ticked.length} onClick={putAside} title="Not a face, or no one to keep (a stranger)">
                <X /> Put aside <kbd className="kbd">X</kbd>
              </button>
              <button className="btn ghost" onClick={later} disabled={queue.length < 2}>
                Later <kbd className="kbd">→</kbd>
              </button>
            </div>
          )}
        </div>
        <div className="who-queue">
          <span className="label">1 of {queue.length} waiting</span>
          <div className="who-queue-list">
            {queue.slice(0, 9).map((x, i) => {
              const f = p.byId.get(x.faces[0]);
              return (
                <button key={x.faces[0]} className={`who-mini ${i === 0 ? "now" : ""}`} onClick={() => setOrder([x.faces[0], ...order.filter((o) => o !== x.faces[0])])} title={`${x.faces.length} faces`}>
                  {f && <FaceCrop face={f} size={56} />}
                  <span className="mono">{x.faces.length}</span>
                </button>
              );
            })}
          </div>
          {queue.length > 1 && <span className="faint small keyed">← → move through them</span>}
        </div>
      </div>
      {checking && (
        <div className="who-check-all">
          <div className="small dim">Untick the ones that aren't the same {g.kind === "photo" ? "person" : "character"}: they're left out of the name, and never found for them later. Less sure ones are last.</div>
          <div className="who-check-grid">
            {byLikeness.slice(0, checkLimit).map(({ id, s }) => {
              const f = p.byId.get(id);
              if (!f) return null;
              const out = left.has(id);
              return (
                <button key={id} className={`who-check-face ${out ? "out" : ""} ${s < SURE[g.kind] ? "unsure" : ""}`} onClick={() => toggle(id)} title={out ? "Left out: click to put it back" : "Click to leave it out"}>
                  <FaceCrop face={f} size={104} />
                  <span className="who-check-tick">{out ? <X /> : <Check />}</span>
                  {s < SURE[g.kind] && <span className="who-check-unsure">less sure</span>}
                </button>
              );
            })}
          </div>
          {byLikeness.length > checkLimit && (
            <div className="row person-more">
              <button className="btn sm" onClick={() => setCheckLimit(checkLimit + CHECK_PAGE)}>
                Show more ({(byLikeness.length - checkLimit).toLocaleString("en-GB")} left)
              </button>
            </div>
          )}
          <div className="row">
            <button className="btn sm ghost" onClick={() => setLeft(new Set(unsure))} disabled={!unsure.length}>
              Leave out the {unsure.length} less sure
            </button>
            <button className="btn sm ghost" onClick={() => setLeft(new Set())} disabled={!left.size}>
              Tick them all again
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** A name: a new person, or one named already (whose faces these join). */
export function NameField({ kind, onDone, placeholder, anyKind }: { kind: PersonKind; onDone: (name: string | null, person?: Person) => void; placeholder?: string; anyKind?: boolean }) {
  const people = usePeople((s) => s.doc?.people ?? {});
  const facesOf = useFacesOf();
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const one = kind === "person" ? "person" : "character";
  // Of either kind where it may be either (someone in a picture with no face to show it).
  const matches = nameMatches(
    Object.values(people).filter((x) => anyKind || x.kind === kind),
    text,
    (id) => facesOf.get(id)?.length ?? 0,
  ).slice(0, 5);
  const same = (x: Person) => x.name.toLowerCase() === text.trim().toLowerCase();
  const join = matches.find((x) => same(x) && x.kind === kind) ?? matches.find(same);
  return (
    <div className="name-field">
      <input
        ref={ref}
        className="input"
        placeholder={placeholder ?? (kind === "person" ? "Who is it?" : "Which character?")}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onDone(text.trim() || null, join);
          if (e.key === "Escape") onDone(null);
        }}
      />
      <div className="row">
        {matches.map((m) => {
          const face = portraitOf(m, facesOf.get(m.id) ?? []);
          return (
            <button key={m.id} className="chip link" onClick={() => onDone(m.name, m)}>
              {face && <FaceCrop face={face} size={20} className="round" />} Add to {m.name}
              {m.kind === "character" && m.from && <span className="faint">{m.from}</span>}
              {anyKind && m.kind !== kind && <span className="faint">{m.kind}</span>}
            </button>
          );
        })}
        {!matches.length && <span className="faint small">{text ? `A new ${one}, on Enter.` : `Type a name, or part of one you've named.`}</span>}
        {join && <span className="faint small">Enter adds them to {join.name}.</span>}
      </div>
    </div>
  );
}

/* ---------- everyone named ---------- */

function Roster({ filter, setFilter }: { filter: Filter; setFilter: (f: Filter) => void }) {
  const p = usePeople();
  const facesOf = useFacesOf();
  const doubts = useDoubts();
  const suggested = useSuggestions();
  const [q, setQ] = useState("");
  const find = useRef<HTMLInputElement>(null);
  const people = Object.values(p.doc!.people);
  // Each person's pictures, counted once (not in every comparison of the sort).
  const counts = useMemo(() => {
    const keys = new Map([...facesOf].map(([id, fs]) => [id, new Set(fs.map((f) => f.key))]));
    // With the pictures they are in whose face isn't known.
    for (const [k, ids] of Object.entries(p.doc?.present ?? {})) for (const id of ids) keys.set(id, (keys.get(id) ?? new Set()).add(k));
    return new Map([...keys].map(([id, ks]) => [id, ks.size]));
  }, [facesOf, p.doc]);
  const countOf = (id: string) => counts.get(id) ?? 0;
  const shown = people.filter((x) => (filter === "all" || x.kind === filter) && (!q || x.name.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => countOf(b.id) - countOf(a.id) || a.name.localeCompare(b.name));
  const n = (k: Filter) => people.filter((x) => k === "all" || x.kind === k).length;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !isTypingTarget(e.target) && !dialogOpen()) {
        e.preventDefault();
        find.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <section className="roster">
      <div className="roster-head">
        <h2>People</h2>
        <label className="roster-find keyed">
          <MagnifyingGlass />
          <input
            ref={find}
            className="input"
            placeholder="Find someone"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && shown[0]) p.setOpen(shown[0].id);
              if (e.key === "Escape") (setQ(""), e.currentTarget.blur());
            }}
          />
          <kbd className="kbd">/</kbd>
        </label>
        <span className="grow" />
        <span className="btn-group">
          {(["all", "person", "character"] as const).map((k) => (
            <button key={k} className={`btn sm ${filter === k ? "active" : "ghost"}`} onClick={() => setFilter(k)}>
              {{ all: "Everyone", person: "People", character: "Characters" }[k]} <span className="mono faint">{n(k)}</span>
            </button>
          ))}
        </span>
      </div>
      {shown.length ? (
        <div className="roster-grid">
          {shown.map((x) => {
            const face = portraitOf(x, facesOf.get(x.id) ?? []);
            const count = countOf(x.id);
            return (
              <button key={x.id} className="roster-person" onClick={() => p.setOpen(x.id)}>
                {face ? <FaceCrop face={face} size={160} className="roster-face" /> : <span className="face-crop roster-face" style={{ width: 160, height: 160 }} />}
                <span className="roster-name">{x.name}</span>
                <span className="mono dim roster-meta">{x.kind === "character" ? (x.from ?? `${count} pictures`) : `${count.toLocaleString("en-GB")} photo${count === 1 ? "" : "s"}`}</span>
                {(!!doubts.get(x.id)?.length || !!suggested.get(x.id)?.length) && (
                  <span className="roster-checks">
                    {!!doubts.get(x.id)?.length && (
                      <span className="badge roster-doubts" title="Faces given them that look like none of their others: check them on their page">
                        {doubts.get(x.id)!.length} to check
                      </span>
                    )}
                    {!!suggested.get(x.id)?.length && (
                      <span className="badge roster-suggested" title="Faces that look like them, not theirs until you say yes on their page">
                        {suggested.get(x.id)!.length.toLocaleString("en-GB")} suggested
                      </span>
                    )}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="dim roster-empty">{q ? `No one called “${q}”.` : filter === "character" ? "No characters named yet. Name one above when a drawn face comes up." : "No one named yet. Name the faces above as they come up, or make people from your people tags."}</div>
      )}
    </section>
  );
}

/* ---------- a person's page ---------- */

function PersonPage({ person }: { person: Person }) {
  const p = usePeople();
  const items = useItems();
  const facesOf = useFacesOf();
  const mine = useMemo(() => facesOf.get(person.id) ?? [], [facesOf, person.id]);
  const drawn = person.kind === "character";
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [merging, setMerging] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [year, setYear] = useState<number | null>(null);
  // How far they had got (Show more) and scrolled, kept for coming back from a picture.
  const [limit, setLimitNow] = useState(() => shownUpTo.get(person.id) ?? 300);
  const setLimit = (n: number) => (shownUpTo.set(person.id, n), setLimitNow(n));
  const page = useRef<HTMLDivElement>(null);
  useScrollMemory(`person:${person.id}`, page, true);
  const doubted = useDoubts().get(person.id);
  const doubtSet = useMemo(() => new Set(doubted ?? []), [doubted]);
  const yearOf = (f: FaceView) => new Date(items.get(f.key)?.modified ?? 0).getFullYear();
  // Pictures, not faces: one they are in twice counts once.
  const years = useMemo(() => {
    const out = new Map<number, number>();
    const seen = new Set<string>();
    for (const f of mine) if (items.get(f.key) && !seen.has(f.key)) (seen.add(f.key), out.set(yearOf(f), (out.get(yearOf(f)) ?? 0) + 1));
    return [...out.entries()].sort((a, b) => a[0] - b[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, items]);
  const shown = useMemo(() => mine.filter((f) => items.get(f.key) && (year === null || yearOf(f) === year)).sort((a, b) => (items.get(b.key)?.modified ?? 0) - (items.get(a.key)?.modified ?? 0)), [mine, items, year]);
  // A picture once, with all their faces in it (a video: its faces are at different moments, so one tile, its first face marked).
  const tiles = useMemo(() => {
    const byKey = new Map<string, FaceView[]>();
    for (const f of shown) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
    return [...byKey.values()].map((faces) => (faces[0].at != null ? [faces.reduce((a, b) => ((b.at ?? 0) < (a.at ?? 0) ? b : a))] : faces));
  }, [shown]);
  const max = Math.max(1, ...years.map(([, n]) => n));
  // Who else is in their pictures, most often first.
  const withThem = useMemo(() => {
    const keys = new Set(mine.map((f) => f.key));
    const count = new Map<string, number>();
    for (const [id, a] of Object.entries(p.doc!.faces)) {
      const f = p.byId.get(Number(id));
      if (f && a.p !== person.id && keys.has(f.key)) count.set(a.p, (count.get(a.p) ?? 0) + 1);
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => p.doc!.people[id]).filter(Boolean);
  }, [mine, p.doc, p.byId, person.id]);
  const others = Object.values(p.doc!.people).filter((x) => x.kind === person.kind && x.id !== person.id).sort((a, b) => a.name.localeCompare(b.name));
  // One picture picked: its best face of theirs can be their portrait.
  const pickedFaces = mine.filter((f) => picked.has(f.id));
  const one = pickedFaces.length && pickedFaces.every((f) => f.key === pickedFaces[0].key) ? bestFace(pickedFaces)!.id : null;
  const face = portraitOf(person, mine);
  // Pictures they are in with no face known to be theirs (said so, or from a tag): counted with the rest.
  const noFace = useMemo(() => Object.entries(p.doc!.present ?? {}).filter(([k, ids]) => ids.includes(person.id) && items.get(k)).map(([k]) => k), [p.doc, person.id, items]);
  const theirKeys = useMemo(() => [...new Set([...mine.map((f) => f.key), ...noFace])], [mine, noFace]);
  const pictures = theirKeys.length;
  const first = years[0]?.[0];
  const last = years[years.length - 1]?.[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || dialogOpen() || e.metaKey || e.ctrlKey || e.altKey || !picked.size) return;
      if (e.key === "x" || e.key === "X") (p.notThem([...picked], person.id), setPicked(new Set()));
      else if (e.key === "s" || e.key === "S") setSplitting(true);
      else if ((e.key === "u" || e.key === "U") && one !== null) (p.setPortrait(person.id, one), setPicked(new Set()));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const openPictures = useCallback(
    (f: FaceView) => {
      const list = [...new Set(shown.map((x) => x.key))].map((k) => items.get(k)).filter((i): i is MediaItem => !!i);
      atItsMoment(f);
      useStore.getState().openViewer(list, Math.max(0, list.findIndex((i) => i.key === f.key)), { kind: "browse" });
    },
    [shown, items],
  );
  // A picture picked is all of their faces in it.
  const togglePick = useCallback((ids: number[]) => setPicked((s) => { const n = new Set(s); const on = ids.every((id) => n.has(id)); for (const id of ids) if (on) n.delete(id); else n.add(id); return n; }), []);
  // Right-click: the picture, or all those picked if it's one of them.
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const onMenu = useCallback(
    (e: React.MouseEvent, faces: FaceView[]) => {
      e.preventDefault();
      const f = faces[0];
      const mineHere = faces.map((x) => x.id);
      const ids = mineHere.every((id) => picked.has(id)) && picked.size > mineHere.length ? [...picked] : mineHere;
      const these = ids.length === 1 ? "" : ` these ${ids.length}`;
      setMenu({
        at: { x: e.clientX, y: e.clientY },
        items: [
          { label: "Open", onClick: () => openPictures(f) },
          ...(ids === mineHere ? [{ label: "Use as portrait", onClick: () => usePeople.getState().setPortrait(person.id, bestFace(faces)!.id) }] : []),
          { label: `Someone else${these}…`, onClick: () => (setPicked(new Set(ids)), setSplitting(true)) },
          { separator: true },
          { label: `Remove${these} from ${person.name}`, danger: true, onClick: () => (usePeople.getState().notThem(ids, person.id), setPicked(new Set())) },
        ],
      });
    },
    [picked, openPictures, person.id, person.name],
  );

  return (
    <div className="person-page" ref={page}>
      <div className="person-head">
        <button className="btn sm ghost keyed" onClick={() => p.setOpen(null)}>
          <ArrowLeft /> People <kbd className="kbd">Esc</kbd>
        </button>
        {renaming && (
          <input
            className="input person-rename"
            defaultValue={person.name}
            autoFocus
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && e.currentTarget.value.trim()) (p.rename(person.id, e.currentTarget.value), setRenaming(false));
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={() => setRenaming(false)}
          />
        )}
        <span className="grow" />
        {/* With no face yet, which kind they are can still change (a face is a photo's or a drawing's). */}
        {!mine.length && (
          <button className="btn sm ghost" onClick={() => p.setKind(person.id, drawn ? "person" : "character")} title={drawn ? "A real person, in photos" : "A character, in drawings"}>
            {drawn ? "Make a person" : "Make a character"}
          </button>
        )}
        <button className="btn sm ghost" onClick={() => setRenaming(true)}>
          <PencilSimple /> Rename
        </button>
        <span className="merge">
          <button className="btn sm ghost" disabled={!others.length} onClick={() => setMerging(!merging)}>
            <GitMerge /> Same as…
          </button>
          {merging && (
            <div className="merge-menu panel">
              {others.map((x) => (
                <button key={x.id} className="btn sm ghost" onClick={() => (setMerging(false), p.merge(person.id, x.id))}>
                  {x.name}
                </button>
              ))}
            </div>
          )}
        </span>
      </div>
      {/* The one keepsake: a page from the theme's own sticker book. */}
      <StickerBanner
        key={person.id}
        target={{ kind: "person", id: person.id }}
        banner={person.banner}
        tape={drawn ? (person.from ?? "Characters") : "People"}
        photo={face && <FaceCrop face={face} size={150} around={2.2} />}
        name={person.name}
        line={
          <>
            {pictures.toLocaleString("en-GB")} {drawn ? "pictures" : "photos"}
            {first ? ` · ${first}${last && last !== first ? ` – ${last}` : ""}` : ""}
          </>
        }
      />
      {drawn && <CharacterFacts person={person} keys={theirKeys} />}
      <div className="person-cols">
        <div>
          <div className="label">Over the years · click one to see it</div>
          <div className="years">
            {years.map(([y, v]) => (
              <button key={y} className={`year ${year === y ? "on" : ""}`} title={`${y}: ${v}`} onClick={() => setYear(year === y ? null : y)}>
                <span style={{ height: `${(v / max) * 100}%` }} />
                <em className="mono">{String(y).slice(2)}</em>
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="label">Often with</div>
          <div className="with">
            {withThem.length ? (
              withThem.map((x) => {
                const f = portraitOf(x, facesOf.get(x.id) ?? []);
                return (
                  <button key={x.id} className="chip link" onClick={() => p.setOpen(x.id)}>
                    {f && <FaceCrop face={f} size={20} className="round" />}
                    {x.name}
                  </button>
                );
              })
            ) : (
              <span className="dim small">No one else named in their pictures yet.</span>
            )}
          </div>
        </div>
      </div>
      <CheckFaces person={person} doubted={doubted ?? []} />
      {noFace.length > 0 && <NoFaceFound person={person} keys={noFace} />}
      <div className="person-pics-head keyed">
        <div className="label">
          {drawn ? "Pictures" : "Photos"}
          {year !== null && ` · ${year}`} · their face marked · {tiles.length.toLocaleString("en-GB")}
        </div>
        {year !== null && (
          <button className="btn sm ghost" onClick={() => setYear(null)}>
            All years
          </button>
        )}
        <span className="grow" />
        {picked.size > 0 && !splitting && (
          <>
            <span className="mono">{picked.size} picked</span>
            {one !== null && (
              <button className="btn sm" onClick={() => (p.setPortrait(person.id, one), setPicked(new Set()))}>
                <ImageIcon /> Use as portrait <kbd className="kbd">U</kbd>
              </button>
            )}
            <button className="btn sm" onClick={() => setSplitting(true)}>
              <Scissors /> Someone else… <kbd className="kbd">S</kbd>
            </button>
            <button className="btn sm" onClick={() => (p.notThem([...picked], person.id), setPicked(new Set()))}>
              <UserMinus /> Not {person.name} <kbd className="kbd">X</kbd>
            </button>
            <button className="btn sm ghost" onClick={() => setPicked(new Set())}>
              Clear
            </button>
          </>
        )}
        {splitting && (
          <div className="split-field">
            <NameField
              kind={person.kind}
              placeholder={`Who ${picked.size === 1 ? "is this" : `are these ${picked.size}`}?`}
              onDone={(name) => {
                if (name) {
                  p.notThem([...picked], person.id);
                  p.name([...picked], name, null, [], true);
                }
                setSplitting(false);
                setPicked(new Set());
              }}
            />
          </div>
        )}
      </div>
      <div className="person-pics">
        {tiles.slice(0, limit).map((faces) => (
          <PictureTile key={faces[0].key} faces={faces} doubts={doubtSet} picked={faces.every((f) => picked.has(f.id))} onPick={togglePick} onOpen={openPictures} onMenu={onMenu} />
        ))}
      </div>
      {tiles.length > limit && (
        <div className="row person-more">
          <button className="btn sm" onClick={() => setLimit(limit + 300)}>
            Show more ({(tiles.length - limit).toLocaleString("en-GB")} left)
          </button>
        </div>
      )}
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </div>
  );
}

/**
 * What is known of a character beside their pictures: where they are from (the anime, game or
 * series), and their name as the anime tagger writes it, which tells the matching who a drawn face is.
 * Each shown with how it was had, and changed with suggestions from their pictures.
 */
function CharacterFacts({ person, keys }: { person: Person; keys: string[] }) {
  const p = usePeople();
  const data = useTags((t) => t.data);
  const names = useTags((t) => t.names);
  const sources = useStore((s) => s.library?.sources);
  const [editing, setEditing] = useState<"from" | "tag" | null>(null);
  const auto = useMemo(() => seenIn(keys, data?.auto, names), [keys, data, names]);
  const tag = names ? characterTagOf(person, keys, auto, names) : null;
  // What the tagger sees in their pictures, of a category, most often first.
  const counted = (category: number, keyz: Iterable<string>, said: Record<string, [number, number][]>) => {
    const n = new Map<number, number>();
    for (const k of keyz) for (const [i, pr] of said[k] ?? []) if (pr >= 0.5 && names?.[i]?.category === category) n.set(i, (n.get(i) ?? 0) + 1);
    return [...n].sort((a, b) => b[1] - a[1]);
  };
  const tagsSeen = useMemo(() => counted(4, keys, auto), [keys, auto]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where they are from: the series in their pictures (the tagger's, and their platforms'), the
  // series the tagger sees with their name across the library, and those of other characters.
  const seriesSeen = useMemo(() => {
    const n = new Map<string, number>();
    const add = (label: string, by = 1) => {
      const k = label.toLowerCase();
      n.set(k, (n.get(k) ?? 0) + by);
      if (!shown.has(k)) shown.set(k, label);
    };
    const shown = new Map<string, string>();
    for (const [i, c] of counted(3, keys, auto)) add(niceTag(names![i].name), c);
    for (const k of keys) for (const src of allSources(sources?.[k])) for (const t of src.tags ?? []) if (t.kind === "series") add(niceTag(t.translated || t.name));
    if (tag && data) {
      const withThem = Object.keys(data.auto).filter((k) => data.auto[k].some(([i, pr]) => i === tag.i && pr >= 0.5));
      for (const [i] of counted(3, withThem, data.auto).slice(0, 3)) add(niceTag(names![i].name), 0);
    }
    return [...n].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({ label: shown.get(k)!, count: c }));
  }, [keys, auto, sources, tag?.i, data, names]); // eslint-disable-line react-hooks/exhaustive-deps
  const othersFrom = useMemo(() => [...new Set(Object.values(p.doc!.people).filter((x) => x.id !== person.id && x.kind === "character" && x.from).map((x) => x.from!))], [p.doc, person.id]);

  const suggestFrom = (q: string) => {
    const want = q.trim().toLowerCase();
    const fits = (label: string) => !want || label.toLowerCase().includes(want);
    const out = new Map<string, { value: string; label: React.ReactNode; title?: string }>();
    const put = (label: string, note?: React.ReactNode, title?: string) => {
      if (fits(label) && !out.has(label.toLowerCase()) && out.size < 8) out.set(label.toLowerCase(), { value: label, label: <>{label}{note}</>, title });
    };
    // The series in their tag's brackets first: what the tagger's name says they are from.
    const bracketed = tag && names ? seriesOfTag(names[tag.i].name) : null;
    if (bracketed) put(bracketed, null, "In their character tag");
    for (const x of seriesSeen) put(x.label, x.count ? <span className="dim mono small">{x.count}</span> : null, x.count ? `In ${x.count} of their pictures` : "Seen with their name elsewhere in the library");
    for (const f of othersFrom) put(f, null, "Another character's");
    if (want && names) for (const n of names) if (n.category === 3 && n.name.includes(asTag(q))) put(niceTag(n.name), null, "A series the tagger knows");
    return [...out.values()];
  };
  const suggestTag = (q: string) => {
    const want = asTag(q);
    const out = new Map<string, { value: string; label: React.ReactNode; title?: string }>();
    const put = (name: string, count?: number) => {
      if ((!want || name.includes(want)) && !out.has(name) && out.size < 8) out.set(name, { value: name, label: <>{name.replace(/_/g, " ")}{count ? <span className="dim mono small">{count}</span> : null}</>, title: count ? `Seen in ${count} of their pictures` : name });
    };
    for (const [i, c] of tagsSeen) put(names![i].name, c);
    if (want && names) {
      const all = names.filter((n) => n.category === 4 && n.name.includes(want)).sort((a, b) => Number(!a.name.startsWith(want)) - Number(!b.name.startsWith(want)) || a.name.length - b.name.length);
      for (const n of all) put(n.name);
    }
    return [...out.values()];
  };

  const how = tag && { picked: "picked", seen: `seen in ${tag.seen} of their ${tag.of} pictures`, name: "the tagger's name for theirs" }[tag.how];
  return (
    <div className="character-facts">
      <div className="fact">
        <div className="label">From</div>
        {editing === "from" ? (
          <SuggestField placeholder="The anime, game or series" initial={person.from ?? ""} free suggest={suggestFrom} onPick={(v) => (p.setFrom(person.id, v), setEditing(null))} onCancel={() => setEditing(null)} />
        ) : (
          <div className="row">
            {person.from ? <span className="chip">{person.from}</span> : <span className="dim small">Not said yet.</span>}
            <button className="btn sm ghost" onClick={() => setEditing("from")} title="Where they are from">
              <PencilSimple /> {person.from ? "Change" : "Add"}
            </button>
            {person.from && (
              <button className="btn sm ghost" onClick={() => p.setFrom(person.id, null)} title="Clear it">
                <X />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="fact">
        <div className="label" title="Tells the face matching who a drawn face is: a face the tagger names so is suggested for them more readily, and not when it surely sees someone else">
          Character tag
        </div>
        {!names ? (
          <span className="dim small">Needs the anime tagger (Settings → Local models).</span>
        ) : editing === "tag" ? (
          <SuggestField
            placeholder="The tagger's name for them"
            initial=""
            suggest={suggestTag}
            extra={
              <>
                <button className="chip" onClick={() => (p.setTag(person.id, null), setEditing(null))} title="The tagger has no name for them">
                  None
                </button>
                {person.tag !== undefined && (
                  <button className="chip" onClick={() => (p.setTag(person.id, undefined), setEditing(null))} title="As their pictures say, or their name">
                    Work it out
                  </button>
                )}
              </>
            }
            onPick={(v) => {
              p.setTag(person.id, v);
              // Where they are from not said yet: as the tag's brackets have it.
              const from = seriesOfTag(v);
              if (!person.from && from) p.setFrom(person.id, from);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="row">
            {tag ? (
              <span className="chip" title={names[tag.i].name}>
                {names[tag.i].name.replace(/_/g, " ")}
              </span>
            ) : person.tag ? (
              <span className="chip" title="Picked, but not a name the tagger in use knows">
                {person.tag.replace(/_/g, " ")} <span className="faint">unknown to this tagger</span>
              </span>
            ) : (
              <span className="dim small">{person.tag === null ? "None, as you said." : "None found: the tagger doesn't see them in their pictures, or by their name."}</span>
            )}
            {how && <span className="faint small">{how}</span>}
            <button className="btn sm ghost" onClick={() => setEditing("tag")} title="Pick the tagger's name for them">
              <PencilSimple /> {tag ? "Change" : "Pick"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A text field with suggestions under it as chips: one clicked, or Enter (the first, or what was typed where any text goes). */
function SuggestField({ placeholder, initial, free, suggest, extra, onPick, onCancel }: { placeholder: string; initial: string; free?: boolean; suggest: (q: string) => { value: string; label: React.ReactNode; title?: string }[]; extra?: React.ReactNode; onPick: (value: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const list = suggest(text);
  return (
    <div className="name-field suggest-field">
      <input
        className="input"
        autoFocus
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onCancel();
          if (e.key !== "Enter") return;
          const exact = list.find((x) => x.value.toLowerCase() === text.trim().toLowerCase());
          const v = exact?.value ?? (free ? text.trim() : list[0]?.value);
          if (v) onPick(v);
        }}
      />
      <div className="row">
        {list.map((x) => (
          <button key={x.value} className="chip link" title={x.title} onClick={() => onPick(x.value)}>
            {x.label}
          </button>
        ))}
        {extra}
        {!list.length && <span className="faint small">{text ? (free ? "Enter keeps what you typed." : "Nothing by that name.") : "Type to look for more."}</span>}
        <button className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Pictures they are in with no face known to be theirs: from a tag where the scan found none of
 * their kind, or several (which is theirs?), or said to have them in it with no face showing.
 * Opened, the viewer shows its faces (⇧P), to say which is theirs or mark it.
 */
function NoFaceFound({ person, keys }: { person: Person; keys: string[] }) {
  const items = useItems();
  const root = useStore((s) => s.root);
  const [all, setAll] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const list = keys.map((k) => items.get(k)).filter((i): i is MediaItem => !!i).sort((a, b) => b.modified - a.modified);
  const open = (it: MediaItem) => {
    useFaceMode.setState({ on: true, marking: false, picked: null });
    useStore.getState().openViewer(list, Math.max(0, list.indexOf(it)), { kind: "browse" });
  };
  if (!root) return null;
  return (
    <div className="no-face-found">
      <div className="person-pics-head">
        <div className="label">
          In these, their face not known · {list.length.toLocaleString("en-GB")}
        </div>
        <span className="dim small">Open one to say which face is theirs or mark it, or leave them in it with none showing.</span>
        <span className="grow" />
        {list.length > 12 && (
          <button className="btn sm ghost" onClick={() => setAll(!all)}>
            {all ? "Fewer" : `All ${list.length.toLocaleString("en-GB")}`}
          </button>
        )}
      </div>
      <div className="person-pics">
        {(all ? list : list.slice(0, 12)).map((it) => (
          <button
            key={it.key}
            className="thumb person-pic"
            onClick={() => open(it)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                at: { x: e.clientX, y: e.clientY },
                items: [
                  { label: "Open and mark their face", onClick: () => open(it) },
                  { separator: true },
                  { label: `${person.name} isn't in it`, danger: true, onClick: () => usePeople.getState().removePresent(it.key, person.id) },
                ],
              });
            }}
            title="Open it to mark their face; right-click for more"
          >
            <img src={canThumb(it) ? thumbUrl(root, it, 320) : mediaUrl(it)} alt="" draggable={false} loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </div>
  );
}

/**
 * Their faces to check, a page at a time: those given them (from a tag, or with a group) that are like
 * none of their others, which don't count for them until checked; and faces that look like them
 * (two of theirs agreeing), each with how alike, the surest or the least sure first, theirs only once
 * said yes to. No, not them, keeps it from being suggested for them again. Picked with clicks (shift:
 * a run), many are said yes or no to at once.
 */
function CheckFaces({ person, doubted }: { person: Person; doubted: number[] }) {
  const p = usePeople();
  // Open and as far along as it was, coming back from a picture.
  const [open, setOpenNow] = useState(() => checking.has(person.id));
  const setOpen = (on: boolean) => (on ? checking.add(person.id) : checking.delete(person.id), setOpenNow(on));
  const [limit, setLimit] = useState(CHECK_PAGE);
  // A face double-clicked: the whole picture it is in, to tell whether it is them.
  const [looking, setLooking] = useState<{ face: FaceView; yes: () => void } | null>(null);
  // Right-click: its menu; "someone else": who, typed (an existing person, or a new one).
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const [naming, setNaming] = useState<FaceView | null>(null);
  const items = useItems();
  const lookingAt = looking ? items.get(looking.face.key) : undefined;
  const suggested = useSuggestions().get(person.id);
  const found = useMemo(() => (suggested ?? []).map(({ face, s }) => ({ face: p.byId.get(face), s })).filter((x): x is { face: FaceView; s: number } => !!x.face), [suggested, p.byId]);
  const doubts = useMemo(() => doubted.map((id) => p.byId.get(id)).filter((f): f is FaceView => !!f), [doubted, p.byId]);
  const [surest, setSurestNow] = useState(() => loadPref(SUREST_KEY, { v: true }).v);
  const setSurest = (on: boolean) => (savePref(SUREST_KEY, { v: on }), setSurestNow(on));
  const ordered = useMemo(() => (surest ? [...found].reverse() : found), [found, surest]);
  // What shows, in order (the faces given them first): picking a run goes by it.
  const shownDoubts = doubts.slice(0, limit);
  const shownFound = ordered.slice(0, Math.max(0, limit - doubts.length));
  const shown = [...shownDoubts.map((f) => f.id), ...shownFound.map((x) => x.face.id)];
  const { picked, pick, setPicked } = useRunPick(shown);
  if (!found.length && !doubts.length) return null;
  const pickedNow = shown.filter((id) => picked.has(id));
  const doubtIds = new Set(doubts.map((f) => f.id));
  /** The picked faces theirs: those given them checked, those suggested taken. */
  const yesPicked = () => {
    const given = pickedNow.filter((id) => doubtIds.has(id));
    const suggested = pickedNow.filter((id) => !doubtIds.has(id));
    if (given.length) p.confirm(given);
    if (suggested.length) p.accept(suggested, person.id);
    setPicked(new Set());
  };
  const noPicked = () => (p.notThem(pickedNow, person.id), setPicked(new Set()));
  const kind = (doubts[0] ?? found[0].face).kind;
  const unsure = found.filter((x) => x.s < SURE_SUGGESTED[kind]).length;
  const what = [doubts.length ? `${doubts.length} like none of their others` : "", found.length ? `${found.length.toLocaleString("en-GB")} suggested` : ""].filter(Boolean).join(" · ");
  /** It is someone else: theirs (a person by that name, else a new one), and not this person's. */
  const someoneElse = (f: FaceView, name: string | null) => {
    setNaming(null);
    if (!name) return;
    p.notThem([f.id], person.id);
    p.name([f.id], name, null, [], true);
  };
  const faceMenu = (e: React.MouseEvent, f: FaceView, yes: () => void) => {
    e.preventDefault();
    setMenu({
      at: { x: e.clientX, y: e.clientY },
      items: [
        { label: "The whole picture", onClick: () => setLooking({ face: f, yes }) },
        { separator: true },
        { label: `Yes, ${person.name}`, onClick: yes },
        { label: `Not ${person.name}`, onClick: () => p.notThem([f.id], person.id) },
        { label: `This is someone else…`, onClick: () => setNaming(f) },
      ],
    });
  };
  const face = (f: FaceView, i: number, yes: () => void, cls = "", s?: number) => (
    <div key={f.id} className={`found-face ${cls} ${picked.has(f.id) ? "picked" : ""} ${naming?.id === f.id ? "naming" : ""}`} onClick={(e) => pick(i, e)} onDoubleClick={() => setLooking({ face: f, yes })} onContextMenu={(e) => faceMenu(e, f, yes)} title="Click: pick it (shift: a run); double-click: the whole picture it is in; right-click for more">
      <FaceCrop face={f} size={104} />
      {s != null && (
        <span className={`match-score mono ${s < SURE_SUGGESTED[f.kind] ? "unsure" : ""}`} title={`${Math.round(s * 100)}% like the closest of their faces${s < SURE_SUGGESTED[f.kind] ? ": less sure, look closer" : ""}`}>
          {Math.round(s * 100)}%
        </span>
      )}
      {picked.has(f.id) && (
        <span className="tile-check">
          <Check />
        </span>
      )}
      <span className="found-actions">
        <button className="btn sm" title={`Yes, ${person.name}`} onClick={(e) => (e.stopPropagation(), yes())}>
          <Check />
        </button>
        <button className="btn sm" title={`Not ${person.name}`} onClick={(e) => (e.stopPropagation(), p.notThem([f.id], person.id))}>
          <X />
        </button>
      </span>
    </div>
  );
  return (
    <section className={`found panel ${doubts.length ? "has-doubts" : ""}`}>
      <div className="row found-head">
        <b className="grow">
          Faces to check: {what}
          {unsure ? <span className="dim">, {unsure} less sure</span> : null}
        </b>
        {open && pickedNow.length > 0 && (
          <>
            <span className="small mono">{pickedNow.length} picked</span>
            <button className="btn sm primary" onClick={yesPicked} title={`Every one picked is ${person.name}`}>
              <Check /> Yes, {person.name}
            </button>
            <button className="btn sm" onClick={noPicked} title={`None of those picked is ${person.name}: not suggested for them again`}>
              <X /> Not {person.name}
            </button>
            <button className="btn sm ghost" onClick={() => setPicked(new Set())}>
              Unpick
            </button>
          </>
        )}
        {open && pickedNow.length < shown.length && (
          <button className="btn sm ghost" onClick={() => setPicked(new Set(shown))} title="Pick every face shown, to say yes or no to all of them">
            Pick all {shown.length.toLocaleString("en-GB")} shown
          </button>
        )}
        <button className="btn sm" onClick={() => setOpen(!open)}>
          {open ? "Done" : "Check them"}
        </button>
      </div>
      {naming && (
        <div className="split-field">
          <NameField kind={person.kind} placeholder={`Who is this, if not ${person.name}?`} onDone={(name) => someoneElse(naming, name)} />
        </div>
      )}
      {open && doubts.length > 0 && (
        <>
          <div className="small dim">Given them (by a tag, or with a group) but like none of their other faces: perhaps someone else in the picture. They don't count for them until you say yes.</div>
          <div className="found-grid">{shownDoubts.map((f, i) => face(f, i, () => p.confirm([f.id]), "doubt"))}</div>
        </>
      )}
      {open && found.length > 0 && (
        <>
          <div className="row found-sub">
            <span className="small dim">Suggested: faces in other pictures that look like them, each with how alike it is to the closest of theirs. None is theirs until you say yes; no keeps it from being suggested for them again. Click faces to pick them (shift for a run), double-click for the whole picture. Least sure first teaches the matching the most: a yes there shows it a new side of them (another angle, outfit or style), and a no a look-alike to keep apart, while a yes to a sure one adds little.</span>
            <button className="btn sm ghost" onClick={() => setSurest(!surest)} title={surest ? "The surest first: click for the least sure first (the ones that teach the matching the most)" : "The least sure first: click for the surest first"}>
              {surest ? <SortDescending /> : <SortAscending />} {surest ? "Surest first" : "Least sure first"}
            </button>
            <button className="btn sm primary" onClick={() => p.accept(found.map((x) => x.face.id), person.id)} title={`Every one of these is ${person.name}`}>
              <Check /> Yes, all {found.length.toLocaleString("en-GB")}
            </button>
          </div>
          <div className="found-grid">{shownFound.map(({ face: f, s }, i) => face(f, shownDoubts.length + i, () => p.accept([f.id], person.id), s < SURE_SUGGESTED[kind] ? "unsure" : "", s))}</div>
        </>
      )}
      {open && doubts.length + found.length > limit && (
        <div className="row person-more">
          <button className="btn sm" onClick={() => setLimit(limit + CHECK_PAGE)}>
            Show more ({(doubts.length + found.length - limit).toLocaleString("en-GB")} left)
          </button>
        </div>
      )}
      {looking && lookingAt && (
        <Modal title={`${person.name}?`} onClose={() => setLooking(null)} wide>
          <div className="source-compare">
            <OnePicture item={lookingAt} mark={looking.face.bbox} caption={<span className="mono">{lookingAt.name}</span>} />
            <div className="row source-compare-acts">
              <button className="btn sm ghost" onClick={() => setLooking(null)}>
                <ArrowLeft /> Back <kbd className="kbd">Esc</kbd>
              </button>
              <span className="grow" />
              <button className="btn sm ghost" onClick={() => (setLooking(null), atItsMoment(looking.face), useStore.getState().openViewer([lookingAt], 0, { kind: "browse" }))} title="The picture in the viewer">
                Open in the viewer
              </button>
              <button className="btn sm ghost" onClick={() => (setNaming(looking.face), setLooking(null))} title="Someone else is in it: who">
                Someone else…
              </button>
              <button className="btn sm ghost" onClick={() => (p.notThem([looking.face.id], person.id), setLooking(null))} title={`Not ${person.name}`}>
                <X /> Not them
              </button>
              <button className="btn sm primary" onClick={() => (looking.yes(), setLooking(null))} title={`Yes, ${person.name}`}>
                <Check /> Yes, {person.name}
              </button>
            </div>
          </div>
        </Modal>
      )}
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </section>
  );
}

/**
 * A picture of theirs with each of their faces in it marked (dotted: like none of their others), drawn
 * again only when it changes: a click picks it (all their faces in it), a double click opens it.
 */
const PictureTile = memo(function PictureTile({ faces, doubts, picked, onPick, onOpen, onMenu }: { faces: FaceView[]; doubts: ReadonlySet<number>; picked: boolean; onPick: (ids: number[]) => void; onOpen: (f: FaceView) => void; onMenu: (e: React.MouseEvent, faces: FaceView[]) => void }) {
  const items = useItems();
  const root = useStore((s) => s.root);
  const face = faces[0];
  const item = items.get(face.key);
  const box = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  if (!item || !root) return null;
  const src = canThumb(item) ? thumbUrl(root, item, 320) : mediaUrl(item);
  // All their faces in it together, kept in view.
  const x0 = Math.min(...faces.map((f) => f.bbox[0]));
  const y0 = Math.min(...faces.map((f) => f.bbox[1]));
  const x1 = Math.max(...faces.map((f) => f.bbox[2]));
  const y1 = Math.max(...faces.map((f) => f.bbox[3]));
  // The picture fills its box, moved so that the faces are in view, and the marks go on the faces: in
  // hundredths of the box, which keeps its shape (so they hold when the grid is resized).
  const place = (img: HTMLImageElement) => {
    const b = box.current?.getBoundingClientRect();
    if (!b || !b.width || !b.height) return;
    const scale = Math.max(b.width / Math.max(1, img.naturalWidth), b.height / Math.max(1, img.naturalHeight));
    const width = (img.naturalWidth * scale) / b.width;
    const height = (img.naturalHeight * scale) / b.height;
    const at = (size: number, c: number) => Math.min(0, Math.max(1 - size, 0.5 - c * size));
    setFit({ left: at(width, (x0 + x1) / 2) * 100, top: at(height, (y0 + y1) / 2) * 100, width: width * 100, height: height * 100 });
  };
  const pct = (n: number) => `${n}%`;
  return (
    <button ref={box} className={`thumb person-pic ${picked ? "selected" : ""}`} onClick={() => onPick(faces.map((f) => f.id))} onDoubleClick={() => onOpen(face)} onContextMenu={(e) => onMenu(e, faces)} title="Click to pick; double-click to open; right-click for more">
      {seen && <img src={src} alt="" draggable={false} onLoad={(e) => place(e.currentTarget)} style={fit ? { position: "absolute", maxWidth: "none", left: pct(fit.left), top: pct(fit.top), width: pct(fit.width), height: pct(fit.height) } : undefined} />}
      {fit &&
        faces.map(({ id, bbox: [a, b, c, d] }) => (
          <span key={id} className={`facebox ${doubts.has(id) ? "doubt" : ""}`} style={{ left: pct(fit.left + a * fit.width), top: pct(fit.top + b * fit.height), width: pct((c - a) * fit.width), height: pct((d - b) * fit.height) }} />
        ))}
      {picked && (
        <span className="tile-check">
          <Check />
        </span>
      )}
    </button>
  );
});

export { kindOfFace };
