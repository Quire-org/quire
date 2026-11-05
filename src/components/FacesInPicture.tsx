import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, CircleNotch, Selection, UserFocus, X } from "@phosphor-icons/react";
import { selectCurrent, useStore } from "../store";
import { faceKind, kindOfFace, toggleFaceMode, useFaceMode, usePeople, type Person, type PersonKind } from "../peopleStore";
import { FaceCrop, NameField } from "../screens/People";
import { usePillsBottom } from "./PluginPanel";
import { useTags } from "../tagsStore";
import { isTypingTarget } from "../lib/hotkeys";
import { formatTime } from "../lib/format";
import type { FaceView, MediaItem } from "../lib/types";

/**
 * Faces in the picture on show (⇧P): each outlined on it with who it is, named or put right with a
 * click; one the scan missed marked by dragging over it (looked for there alone, close up; in a
 * drawing the part marked is the face if none is found); and who is in it with no face to show it.
 * One person can have several faces in a picture (a manga page shows them panel after panel).
 *
 * A video's faces were each seen in a frame at a moment: listed in time, a click goes to that moment
 * and pauses there, the faces of that frame outlined on it. Marking a missed face is for pictures.
 */

const canHaveFaces = (item: MediaItem | undefined): item is MediaItem => !!item && (item.kind === "image" || item.kind === "raw");
const canShowFaces = (item: MediaItem | undefined): item is MediaItem => !!item && (item.kind === "image" || item.kind === "raw" || item.kind === "video");

/** How near the frame shown a video's face has to have been seen to be outlined on it (seconds). */
const MOMENT = 0.25;

/** A video at a face's moment, paused there. */
function showMoment(v: HTMLVideoElement | null | undefined, at: number) {
  if (!v) return;
  v.pause();
  v.currentTime = at;
}

/** The faces in a picture, left to right, with who each is (said so) or looks like (a suggestion). */
function useFacesHere(key: string | undefined) {
  const faces = usePeople((s) => s.faces);
  const doc = usePeople((s) => s.doc);
  const matches = usePeople((s) => s.sorted?.matches);
  return useMemo(() => {
    if (!key || !doc) return [];
    const no = new Set(doc.no);
    return faces
      .filter((f) => f.key === key && !no.has(f.id))
      // A video's in time, then left to right.
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.bbox[0] - b.bbox[0])
      .map((face) => {
        const a = doc.faces[String(face.id)];
        const person = a && !a.auto ? doc.people[a.p] : undefined;
        const not = doc.not[String(face.id)] ?? [];
        const best = person ? undefined : (matches ?? []).filter((m) => m.face === face.id && doc.people[m.person] && !not.includes(m.person)).sort((x, y) => y.score - x.score)[0];
        return { face, person, guess: best ? doc.people[best.person] : undefined };
      });
  }, [key, faces, doc, matches]);
}

/** The bar's button: faces mode on and off, with how many faces in the picture are named. */
export function FacesButton({ item }: { item: MediaItem }) {
  const on = useFaceMode((m) => m.on);
  const here = useFacesHere(item.key);
  const named = here.filter((h) => h.person).length;
  if (!canShowFaces(item)) return null;
  return (
    <button className={`btn sm ${on ? "active" : "ghost"}`} onClick={toggleFaceMode} title={on ? "Hide the faces (⇧P)" : "Faces in it: who is who, or mark one it missed (⇧P)"}>
      <UserFocus />
      {named > 0 && <span className="mono small">{named}</span>}
    </button>
  );
}

/** On the picture (inside the loupe, so it follows fit, fill and zoom): the faces outlined, and the drag that marks one. */
export function FaceLayer({ itemKey }: { itemKey: string }) {
  const on = useFaceMode((m) => m.on);
  const marking = useFaceMode((m) => m.marking);
  const picked = useFaceMode((m) => m.picked);
  const current = useStore(selectCurrent);
  const editing = useStore((s) => s.editMode);
  const here = useFacesHere(itemKey);
  const [drag, setDrag] = useState<{ a: [number, number]; b: [number, number] } | null>(null);
  const [looking, setLooking] = useState<[number, number, number, number] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (setDrag(null), setLooking(null)), [itemKey]);
  if (!on || editing || !canHaveFaces(current) || current.key !== itemKey) return null;
  const item = current;

  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const onMouseDown = (e: ReactMouseEvent) => {
    if (!marking || e.button !== 0 || looking) return;
    // Marking, not panning or zooming the loupe.
    e.preventDefault();
    e.stopPropagation();
    const a = at(e);
    let last: [number, number] = a;
    setDrag({ a, b: a });
    const move = (ev: MouseEvent) => ((last = at(ev)), setDrag({ a, b: last }));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", up);
      setDrag(null);
      const area: [number, number, number, number] = [Math.min(a[0], last[0]), Math.min(a[1], last[1]), Math.max(a[0], last[0]), Math.max(a[1], last[1])];
      // Too small to be a drag: a click, which marks nothing.
      if (area[2] - area[0] < 0.01 || area[3] - area[1] < 0.01) return;
      setLooking(area);
      usePeople
        .getState()
        .mark(item, area)
        .then((found) => {
          if (useStore.getState().queue[useStore.getState().index]?.key !== item.key) return;
          if (found.length) useFaceMode.setState({ marking: false, picked: found[0].id });
          else useStore.getState().toast("No face found there: drag a little wider around it", "warn");
        })
        .catch((err) =>
          String(err).includes("not downloaded: characters")
            ? useStore.getState().toast("Marking a drawn face needs the character finder (optional, in Settings → Local models)", "warn")
            : useStore.getState().toast(`It couldn't look there: ${String(err)}`, "error"),
        )
        .finally(() => setLooking(null));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", up);
  };

  const rect = drag && [Math.min(drag.a[0], drag.b[0]), Math.min(drag.a[1], drag.b[1]), Math.max(drag.a[0], drag.b[0]), Math.max(drag.a[1], drag.b[1])];
  return (
    <div
      ref={ref}
      className={`face-layer ${marking ? "marking" : ""}`}
      onMouseDown={onMouseDown}
      onClick={(e) => marking && e.stopPropagation()}
      onDoubleClick={(e) => marking && e.stopPropagation()}
    >
      <FaceBoxes here={here.map((h, i) => ({ ...h, n: i + 1 }))} picked={picked} />
      {rect && <span className="face-drag" style={box(rect)} />}
      {looking && (
        <span className="face-drag looking" style={box(looking)}>
          <CircleNotch className="spin" />
        </span>
      )}
    </div>
  );
}

const box = (r: readonly number[]) => ({ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${(r[2] - r[0]) * 100}%`, height: `${(r[3] - r[1]) * 100}%` });

/** The faces outlined, each with who it is (or its number in the list), a click picking it. */
function FaceBoxes({ here, picked }: { here: { face: FaceView; person?: Person; guess?: Person; n: number }[]; picked: number | null }) {
  return (
    <>
      {here.map(({ face, person, guess, n }) => (
        <button
          key={face.id}
          className={`face-box ${person ? "named" : guess ? "guess" : ""} ${picked === face.id ? "picked" : ""}`}
          style={box(face.bbox)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => (e.stopPropagation(), useFaceMode.setState({ picked: picked === face.id ? null : face.id, marking: false }))}
          onDoubleClick={(e) => e.stopPropagation()}
          title={person ? person.name : guess ? `Looks like ${guess.name}: click to say` : "Who is it? Click to name"}
        >
          <span className="face-box-label mono">{person ? person.name : guess ? `${guess.name}?` : n}</span>
        </button>
      ))}
    </>
  );
}

/** On a video (as large as it is shown): the faces seen in the frame it is paused on, at their moment. */
export function VideoFaceLayer({ item, time, paused }: { item: MediaItem; time: number; paused: boolean }) {
  const on = useFaceMode((m) => m.on);
  const picked = useFaceMode((m) => m.picked);
  const current = useStore(selectCurrent);
  const editing = useStore((s) => s.editMode);
  const here = useFacesHere(item.key);
  if (!on || editing || !paused || current?.key !== item.key) return null;
  const now = here.map((h, i) => ({ ...h, n: i + 1 })).filter((h) => h.face.at != null && Math.abs(h.face.at - time) < MOMENT);
  if (!now.length) return null;
  return (
    <div className="face-layer">
      <FaceBoxes here={now} picked={picked} />
    </div>
  );
}

/** Beside the picture: its faces as a list, the one picked named or put right, marking, and who is in it with no face to show it. */
export function FacesPanel({ videoRef }: { videoRef?: RefObject<HTMLVideoElement | null> }) {
  const on = useFaceMode((m) => m.on);
  const marking = useFaceMode((m) => m.marking);
  const picked = useFaceMode((m) => m.picked);
  const current = useStore(selectCurrent);
  const editing = useStore((s) => s.editMode);
  const screen = useStore((s) => s.screen);
  const top = usePillsBottom();
  const doc = usePeople((s) => s.doc);
  const scanned = usePeople((s) => (current ? s.scanned[current.key] : undefined));
  const here = useFacesHere(current?.key);
  // A drawing or a photo as marking takes it: as most of its faces are, else as its folder says or the tagger saw it.
  const tagged = useTags((t) => (current ? faceKind(doc, t.data, current.key) : null));
  const [looking, setLooking] = useState(false);
  const [adding, setAdding] = useState(false);
  const show = on && !editing && screen === "viewer" && canShowFaces(current);
  const key = current?.key;
  const video = current?.kind === "video";

  // The picture looked at for faces when it comes up (unless it was, as it is now); none found, marking is ready.
  useEffect(() => {
    if (!show || !current) return;
    let live = true;
    setAdding(false);
    useFaceMode.setState({ picked: null, marking: false });
    setLooking(true);
    usePeople
      .getState()
      .scanOne(current)
      .catch((e) => useStore.getState().toast(`It couldn't look for faces: ${String(e)}`, "error"))
      .finally(() => {
        if (!live) return;
        setLooking(false);
        // A picture with none found: marking is ready (a video's missed faces aren't marked).
        if (!video && !usePeople.getState().faces.some((f) => f.key === current.key)) useFaceMode.setState({ marking: true });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, key]);

  // Opened at a face's moment (from People): the video goes there and waits, paused, that face picked.
  useEffect(() => {
    const m = useFaceMode.getState().moment;
    if (!show || !current || !video || m?.key !== current.key) return;
    useFaceMode.setState({ moment: null, picked: m.face });
    const v = videoRef?.current;
    if (!v) return;
    if (v.readyState >= 1) showMoment(v, m.at);
    else v.addEventListener("loadedmetadata", () => showMoment(v, m.at), { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, key]);

  // Esc steps back (the face picked, then marking, then the faces) before the viewer has it.
  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isTypingTarget(e.target)) return;
      const m = useFaceMode.getState();
      if (m.picked !== null) useFaceMode.setState({ picked: null });
      else if (m.marking) useFaceMode.setState({ marking: false });
      else useFaceMode.setState({ on: false });
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show]);

  if (!show || !current || !doc) return null;
  const item = current;
  const p = usePeople.getState();
  const one = here.find((h) => h.face.id === picked);
  const drawn = here.length ? here.filter((h) => h.face.kind === "drawn").length * 2 >= here.length : tagged === "drawn";
  const present = (doc.present?.[item.key] ?? []).map((id) => doc.people[id]).filter(Boolean);
  const status = looking
    ? video
      ? "Looking for faces in a few of its frames…"
      : "Looking for faces…"
    : !scanned && !here.length
      ? "Not looked at yet."
      : here.length
        ? `${here.length} face${here.length === 1 ? "" : "s"}: click one to ${video ? "see it in its frame and " : ""}say who it is.`
        : "No faces found.";
  // A face picked: in a video, at its moment, paused there.
  const pick = (face: FaceView) => {
    const next = picked === face.id ? null : face.id;
    useFaceMode.setState({ picked: next, marking: false });
    if (next !== null && face.at != null) showMoment(videoRef?.current, face.at);
  };

  return createPortal(
    <div className="plugin-panel panel faces-panel" style={{ "--panel-top": `${top}px` } as React.CSSProperties} onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
      <div className="plugin-panel-head">
        <UserFocus />
        <strong className="ellipsis grow">Faces in it</strong>
        <button className="btn sm ghost" onClick={toggleFaceMode} title="Close (⇧P)">
          <X />
        </button>
      </div>
      <div className="dim small row">
        {looking && <CircleNotch className="spin" />}
        {status}
      </div>

      {here.length > 0 && (
        <div className="faces-list">
          {here.map(({ face, person, guess }, i) => (
            <button key={face.id} className={`faces-row ${picked === face.id ? "active" : ""}`} onClick={() => pick(face)}>
              <FaceCrop face={face} size={32} className="round" />
              <span className="ellipsis grow">{person ? person.name : guess ? <span className="dim">{guess.name}?</span> : <span className="faint">Face {i + 1}: who?</span>}</span>
              {face.at != null && <span className="faces-row-at mono faint small" title="The frame where this face was clearest">{formatTime(face.at)}</span>}
              {face.marked && <span className="faint small" title="Marked by you">marked</span>}
            </button>
          ))}
        </div>
      )}

      {one && (
        <div className="faces-naming">
          {one.face.at != null && <div className="faint small">Shown on its clearest frame, at {formatTime(one.face.at)}. It may appear at other moments too.</div>}
          {one.guess && (
            <button className="btn sm accent" onClick={() => (p.accept([one.face.id], one.guess!.id), useFaceMode.setState({ picked: null }))}>
              <Check /> Yes, {one.guess.name}
            </button>
          )}
          <NameField
            key={one.face.id}
            kind={kindOfFace(one.face)}
            placeholder={one.person ? `Someone else, not ${one.person.name}?` : undefined}
            onDone={(name) => {
              if (name) {
                if (one.person && name.toLowerCase() !== one.person.name.toLowerCase()) p.notThem([one.face.id], one.person.id);
                p.name([one.face.id], name, null, [], true);
              }
              useFaceMode.setState({ picked: null });
            }}
          />
          <div className="row">
            {one.person && (
              <button className="btn sm ghost" onClick={() => (p.notThem([one.face.id], one.person!.id), useFaceMode.setState({ picked: null }))} title={`Not ${one.person.name}: left unnamed, and never found for them again`}>
                Not {one.person.name}
              </button>
            )}
            <button className="btn sm ghost" onClick={() => (p.dismiss([one.face.id]), useFaceMode.setState({ picked: null }))} title="Not a face, or not one to name">
              Not a face
            </button>
          </div>
        </div>
      )}

      {!video && (
        <button className={`btn sm ${marking ? "active" : "ghost"}`} onClick={() => useFaceMode.setState({ marking: !marking, picked: null })} title="Drag over a face it missed: it looks there, close up">
          <Selection /> {marking ? "Drag over the face…" : "Mark a face it missed"}
        </button>
      )}
      {marking && <div className="faint small">{drawn ? "In a drawing the part you mark is the face, if none is found in it." : "It looks for a face in the part you mark, close up."} Esc stops.</div>}

      <div className="label plugin-panel-heading">In it, no face showing</div>
      {present.length > 0 && (
        <div className="faces-present">
          {present.map((x) => (
            <span key={x.id} className="chip">
              {x.name}
              <button className="chip-x" onClick={() => p.removePresent(item.key, x.id)} title={`${x.name} isn't in it`}>
                <X />
              </button>
            </span>
          ))}
        </div>
      )}
      {adding ? (
        <PresentField
          drawn={drawn}
          onDone={(name, kind) => {
            if (name) p.addPresent(item.key, name, kind);
            setAdding(false);
          }}
        />
      ) : (
        <button className="btn sm ghost" onClick={() => setAdding(true)} title="Someone in it whose face you can't see: their back to you, or too small">
          Someone with no face showing…
        </button>
      )}
    </div>,
    document.body,
  );
}

/** A name for someone in a picture with no face to show it: a person or a character (the picture's kind first). */
function PresentField({ drawn, onDone }: { drawn: boolean; onDone: (name: string | null, kind: PersonKind) => void }) {
  const [kind, setKind] = useState<PersonKind>(drawn ? "character" : "person");
  return (
    <div className="faces-naming">
      <div className="btn-group">
        <button className={`btn sm ${kind === "person" ? "active" : "ghost"}`} onClick={() => setKind("person")}>
          Person
        </button>
        <button className={`btn sm ${kind === "character" ? "active" : "ghost"}`} onClick={() => setKind("character")}>
          Character
        </button>
      </div>
      {/* Someone named already, of either kind, is offered too: picked, they are who it is. */}
      <NameField key={kind} kind={kind} anyKind onDone={(name, who) => onDone(who?.name ?? name, who?.kind ?? kind)} />
    </div>
  );
}
