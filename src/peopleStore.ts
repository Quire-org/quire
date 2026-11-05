/**
 * People: the real people in the library's photos and the characters in its drawings. The faces are
 * the face finder's, kept by the backend with the library (the face index); here, who each person is
 * and which faces are whose, said by the user or found close enough to a person's own faces by
 * themselves, also kept with the library. Faces no one has named come up in groups alike, for
 * "Who is this?". The face scan runs in Activity, after the tag index (which says which pictures are
 * drawn), over the library less the folders left out.
 */
import { debounced } from "./lib/pending";
import { create } from "zustand";
import { api } from "./lib/api";
import type { FaceView, FacesSorted, MediaItem, TagName } from "./lib/types";
import { useStore } from "./store";
import type { TagSettings } from "./tagsStore";
import { allSources } from "./lib/sources";

export type PersonKind = "person" | "character";

export interface Person {
  id: string;
  name: string;
  kind: PersonKind;
  /** A character's series (Lantern Road), from the anime tagger or the user. */
  from: string | null;
  /**
   * A character's name as the anime tagger writes it (`hatsune_miku`), which tells the matching who a
   * drawn face is: picked, said to be none (null), or, unset, worked out from their pictures (see
   * `characterTagOf`).
   */
  tag?: string | null;
  /** The face shown for them; their biggest when none is chosen. */
  portrait: number | null;
  added: number;
  /** The stickers on their banner (Scrapbook's, by id). */
  banner?: string;
}

export interface PeopleDoc {
  version: 1;
  people: Record<string, Person>;
  /**
   * Face id → whose it is: given by the user (named with a group, made from a tag; `ok` once checked
   * one by one, or a suggestion said yes to). Faces that look like someone are only suggested (on
   * their page), never theirs by themselves; and a given one not checked that is like none of their
   * others (a tagged picture's only face being someone else's) doesn't count for them until checked.
   * (`auto`, `s`: found ones kept by an earlier version; they go at the next sort.)
   */
  faces: Record<string, { p: string; auto?: boolean; s?: number; ok?: boolean }>;
  /** Faces that aren't one, or aren't wanted (a stranger in the background). */
  no: number[];
  /** Face id → the people the user said it isn't. */
  not: Record<string, string[]>;
  /** Folders (keys) the face scan leaves out. */
  exclude: string[];
  /**
   * Picture key → people in it with no face to show it (their back to us, or the face too small to
   * find): said so, or from a tag in a picture where no face of theirs was found.
   */
  present?: Record<string, string[]>;
  /**
   * People made from tags, until the user keeps them, to put back as it was: the tags on each picture,
   * their settings (subtags, linked tagger words, banners…), the people made (new ones only) and the
   * faces given to people there already. Older records lack the last two parts.
   */
  converted: { folder: string; made: string[]; tags: Record<string, string[]>; at: number; settings?: TagSettings; added?: Record<string, number[]>; present?: Record<string, string[]> } | null;
  /** The photos an earlier version looked at as drawings were looked at again (see `toRecheck`). */
  photosRechecked?: boolean;
  /**
   * Folders (keys) that say what their pictures are, for the face finders: photos (the Face finder) or
   * drawings (the Character finder), whatever the tag index takes them for. The deepest one that says
   * wins (Settings, Faces).
   */
  kinds?: Record<string, "photo" | "drawn">;
  /** Pictures to look at again for faces: their folder says otherwise now than when they were looked at. Gone once looked at. */
  relook?: string[];
}

const empty = (): PeopleDoc => ({ version: 1, people: {}, faces: {}, no: [], not: {}, exclude: [], converted: null });
const presentOf = (d: PeopleDoc) => d.present ?? {};

/** `person` out of these pictures' "in it, no face to show it" (a picture left with no one drops out). */
function withoutPresent(present: PeopleDoc["present"], keys: string[], person: string): PeopleDoc["present"] {
  if (!present || !keys.some((k) => present[k]?.includes(person))) return present;
  const out = { ...present };
  for (const k of keys) {
    const left = (out[k] ?? []).filter((p) => p !== person);
    if (left.length) out[k] = left;
    else delete out[k];
  }
  return out;
}

/**
 * Whether the tag index says a picture is drawn: the anime tagger's words on it, an empty list on a
 * photo it passed over (it looks at drawn ones only), nothing while it hasn't looked (it is
 * optional): then it isn't known.
 */
export function kindFromTags(tags: { auto: Record<string, unknown[]> } | null | undefined, key: string): "photo" | "drawn" | null {
  const seen = tags?.auto[key];
  return seen === undefined ? null : seen.length ? "drawn" : "photo";
}

/** What the deepest folder that says so says a picture in it is (People's `kinds`), if one does. */
export function folderKind(kinds: PeopleDoc["kinds"], key: string): "photo" | "drawn" | null {
  let best: string | null = null;
  for (const f of Object.keys(kinds ?? {})) if (key.startsWith(`${f}/`) && (best === null || f.length > best.length)) best = f;
  return best === null ? null : kinds![best];
}

/** What a picture is for the face finders: what its folder says, else what the tag index takes it for. */
export function faceKind(doc: PeopleDoc | null | undefined, tags: { auto: Record<string, unknown[]> } | null | undefined, key: string): "photo" | "drawn" | null {
  return folderKind(doc?.kinds, key) ?? kindFromTags(tags, key);
}

/**
 * Whether a face doesn't belong to its picture as it is taken for now: one the Character finder found
 * in a photo, or the Face finder in a drawing (once the Character finder is there to look instead). Left
 * from when the picture was taken for something else (before the tag index had looked, or its folder said).
 */
export const outOfPlace = (face: FaceView, kind: "photo" | "drawn" | null, characters: boolean) => (kind === "photo" && face.kind === "drawn") || (kind === "drawn" && characters && face.kind === "photo");

/** Whether a picture is a photo or a drawing, as far as is known: its folder's say, its faces, else the tag index. */
async function pictureKind(key: string, faces: FaceView[]): Promise<"photo" | "drawn" | null> {
  const said = folderKind(usePeople.getState().doc?.kinds, key);
  if (said) return said;
  const mine = faces.filter((f) => f.key === key);
  if (mine.length) return mine.filter((f) => f.kind === "drawn").length * 2 >= mine.length ? "drawn" : "photo";
  const { useTags } = await import("./tagsStore");
  return kindFromTags(useTags.getState().data, key);
}
const newId = () => `pe${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const kindOfFace = (f: FaceView): PersonKind => (f.kind === "drawn" ? "character" : "person");

interface PeopleState {
  doc: PeopleDoc | null;
  docRoot: string | null;
  faces: FaceView[];
  byId: Map<number, FaceView>;
  /** Pictures the scan looked at, as they were then: `[size, modified]`. */
  scanned: Record<string, [number, number]>;
  /** Of those, the ones looked at without the character finder: looked at again once it is downloaded. */
  noCharacters: Set<string>;
  /** Whether the character finder is downloaded (it is optional: drawn characters only). */
  characters: boolean;
  sorted: FacesSorted | null;
  scanning: boolean;
  /** The last change, to take back (⌘Z). */
  undo: { doc: PeopleDoc; what: string } | null;
  /** The person whose page is open. */
  open: string | null;
  /** The folders-left-out dialog, asked for from Settings. */
  leaveOutOpen: boolean;
  load(force?: boolean): Promise<void>;
  /** Faces matched to people again, and the rest grouped. */
  sort(): Promise<void>;
  /** Faces are this person's (one by that name, else a new one); `leftOut`, from the same group, aren't. `checked`: each was looked at. */
  name(faces: number[], name: string, from?: string | null, leftOut?: number[], checked?: boolean): string | null;
  /** Faces given them are theirs after all, checked (ones like none of their others). */
  confirm(faces: number[]): void;
  /** Suggested faces are theirs: the user says yes. */
  accept(faces: number[], person: string): void;
  /** Faces that aren't one, or aren't wanted. */
  dismiss(faces: number[]): void;
  /** Someone in a picture with no face to show it (by name: a person of it, else a new one); their id. */
  addPresent(key: string, name: string, kind: PersonKind): string | null;
  removePresent(key: string, person: string): void;
  /** A picture looked at for faces now, unless it was (as it is). */
  scanOne(item: MediaItem): Promise<void>;
  /** Faces looked for in the part of a picture marked (fractions); the faces found. */
  mark(item: MediaItem, area: [number, number, number, number]): Promise<FaceView[]>;
  notThem(faces: number[], person: string): void;
  setPortrait(person: string, face: number): void;
  setBanner(person: string, banner: string | null): void;
  rename(person: string, name: string): void;
  /** A character's series; null for none. */
  setFrom(person: string, from: string | null): void;
  /** A character's tagger name: picked, none (null), or worked out again (undefined). */
  setTag(person: string, tag: string | null | undefined): void;
  /** A person a character, or a character a person: only someone with no faces yet (a face is a photo's or a drawing's). */
  setKind(person: string, kind: PersonKind): void;
  /** `from` is the same as `into`: their faces go there. */
  merge(from: string, into: string): void;
  revert(): void;
  setExclude(folders: string[]): void;
  /** Pictures still to look at for faces. */
  pending(): MediaItem[];
  /**
   * Photos an earlier version looked at as drawings (it took the anime tagger's empty list on a photo
   * for a drawing's), so their real faces were missed: looked at again, once (ids kept for faces found
   * again). None once done, or while the tag index isn't loaded.
   */
  toRecheck(tags: { auto: Record<string, unknown[]> } | null): MediaItem[];
  /**
   * Pictures to look at again with the finder they get now: those whose folder's say changed (`relook`),
   * and those with a face found by the other finder (see `outOfPlace`), unless it is one marked by hand or
   * given to someone by the user (looking again would drop it).
   */
  toRelook(tags: { auto: Record<string, unknown[]> } | null): MediaItem[];
  /** What folders say their pictures are; the pictures that then go otherwise are looked at again. */
  setKinds(kinds: Record<string, "photo" | "drawn">): Promise<void>;
  scan(): Promise<void>;
  setOpen(id: string | null): void;
  /** People from a tag folder: each tag a person, a tagged picture's only face theirs; the tags go. */
  convert(folder: string): Promise<number>;
  /** The tags back as they were, and the people made from them gone: how many pictures got tags back. */
  revertConversion(): Promise<number>;
  keepConversion(): void;
  /** Pictures moved: their faces go with them. */
  follow(pairs: [string, string][]): void;
  forget(prefix: string): void;
}

/** The viewer's faces in the picture on show (⇧P): on, dragging to mark one, and the one picked to name. */
/**
 * Faces on the item on show (⇧P): on or off, marking a missed one, the face picked; `moment`: a
 * video opened at a face's moment (from People), which it goes to, paused, with that face picked.
 */
export const useFaceMode = create<{ on: boolean; marking: boolean; picked: number | null; moment: { key: string; at: number; face: number } | null }>(() => ({ on: false, marking: false, picked: null, moment: null }));
export const toggleFaceMode = () => useFaceMode.setState((m) => ({ on: !m.on, marking: false, picked: null }));

const peopleSave = debounced("people", 300, async (root) => {
  const { doc, docRoot } = usePeople.getState();
  if (doc && docRoot === root) await api.peopleSave(root, doc).catch((e) => useStore.getState().toast(`People couldn't be saved: ${String(e)}`, "error"));
});

export const usePeople = create<PeopleState>((set, get) => {
  /** A change to the doc, kept with the library soon; `what` makes it the one ⌘Z takes back. */
  const change = (fn: (d: PeopleDoc) => PeopleDoc, what?: string) => {
    const d = get().doc;
    if (!d || get().docRoot !== useStore.getState().root) return;
    set({ doc: fn(d), ...(what ? { undo: { doc: d, what } } : {}) });
    peopleSave.schedule(get().docRoot!);
  };
  const resort = () => void get().sort();
  let sorting: Promise<void> | null = null;
  let sortAgain = false;
  const sortOnce = async () => {
    const { doc, docRoot } = get();
    if (!doc || !docRoot || !get().faces.length) return set({ sorted: { matches: [], groups: [] } });
    // Only the faces the user gave stand for each person: the found ones are found again from those.
    const assigned = Object.entries(doc.faces).filter(([, a]) => !a.auto).map(([id, a]) => [Number(id), a.p, !!a.ok] as [number, string, boolean]);
    const not = Object.entries(doc.not).flatMap(([id, ps]) => ps.map((p) => [Number(id), p] as [number, string]));
    const hints = await taggerHints(doc, get().faces);
    const sorted = await api.facesSort(docRoot, { assigned, no: doc.no, not, ...hints }).catch(() => null);
    if (!sorted || get().docRoot !== docRoot) return;
    // Faces close to a person are suggestions (`sorted.matches`), theirs only once said yes to; any
    // an earlier version let join by themselves go.
    if (Object.values(get().doc!.faces).some((a) => a.auto)) change((d) => ({ ...d, faces: Object.fromEntries(Object.entries(d.faces).filter(([, a]) => !a.auto)) }));
    set({ sorted });
  };

  return {
    doc: null,
    docRoot: null,
    faces: [],
    byId: new Map(),
    scanned: {},
    noCharacters: new Set(),
    characters: false,
    sorted: null,
    scanning: false,
    undo: null,
    open: null,
    leaveOutOpen: false,

    async load(force) {
      const root = useStore.getState().root;
      if (!root || (!force && get().docRoot === root && get().doc)) return;
      const [raw, faces] = await Promise.all([Promise.resolve().then(() => api.peopleLoad(root)).catch(() => null), Promise.resolve().then(() => api.facesLoad(root)).catch(() => ({ faces: [], scanned: {}, noCharacters: [] }))]);
      if (useStore.getState().root !== root) return;
      const doc: PeopleDoc = { ...empty(), ...((raw && typeof raw === "object" ? raw : {}) as Partial<PeopleDoc>), version: 1 };
      set({ doc, docRoot: root, faces: faces.faces, byId: new Map(faces.faces.map((f) => [f.id, f])), scanned: faces.scanned, noCharacters: new Set(faces.noCharacters ?? []), open: get().docRoot === root ? get().open : null, undo: get().docRoot === root ? get().undo : null });
      await get().sort();
    },

    sort() {
      // One at a time: asked again meanwhile (a yes, then a no, quickly), once more after it with the
      // latest, rather than a sort behind every click.
      if (sorting) {
        sortAgain = true;
        return sorting;
      }
      sorting = (async () => {
        do {
          sortAgain = false;
          await sortOnce();
        } while (sortAgain);
      })().finally(() => (sorting = null));
      return sorting;
    },

    name(faces, name, from = null, leftOut = [], checked = false) {
      const d = get().doc;
      const first = faces.map((f) => get().byId.get(f)).find(Boolean);
      const clean = name.trim().slice(0, 120);
      if (!d || !first || !clean) return null;
      const kind = kindOfFace(first);
      const same = Object.values(d.people).find((p) => p.kind === kind && p.name.toLowerCase() === clean.toLowerCase());
      const id = same?.id ?? newId();
      change(
        (doc) => ({
          ...doc,
          people: same ? doc.people : { ...doc.people, [id]: { id, name: clean, kind, from, portrait: null, added: Date.now() } },
          faces: { ...doc.faces, ...Object.fromEntries(faces.map((f) => [String(f), checked ? { p: id, ok: true } : { p: id }])) },
          no: doc.no.filter((n) => !faces.includes(n)),
          // Their face in a picture said to have them in it with none: there it is now.
          present: withoutPresent(doc.present, faces.map((f) => get().byId.get(f)?.key).filter((k): k is string => !!k), id),
          // Left out of the group when it was named: not theirs, and never found for them again.
          not: leftOut.length ? { ...doc.not, ...Object.fromEntries(leftOut.map((f) => [String(f), [...new Set([...(doc.not[String(f)] ?? []), id])]])) } : doc.not,
        }),
        `${faces.length} face${faces.length === 1 ? "" : "s"} named ${clean}`,
      );
      resort();
      return id;
    },

    confirm(faces) {
      change((d) => ({ ...d, faces: { ...d.faces, ...Object.fromEntries(faces.filter((f) => d.faces[String(f)]).map((f) => [String(f), { p: d.faces[String(f)].p, ok: true }])) } }), `${faces.length} face${faces.length === 1 ? "" : "s"} confirmed`);
      resort();
    },

    accept(faces, person) {
      if (!get().doc?.people[person]) return;
      change(
        (d) => ({ ...d, faces: { ...d.faces, ...Object.fromEntries(faces.map((f) => [String(f), { p: person, ok: true }])) }, no: d.no.filter((n) => !faces.includes(n)), present: withoutPresent(d.present, faces.map((f) => get().byId.get(f)?.key).filter((k): k is string => !!k), person) }),
        `${faces.length} face${faces.length === 1 ? "" : "s"} added to ${get().doc!.people[person].name}`,
      );
      resort();
    },

    addPresent(key, name, kind) {
      const d = get().doc;
      const clean = name.trim().slice(0, 120);
      if (!d || !clean) return null;
      const same = Object.values(d.people).find((p) => p.kind === kind && p.name.toLowerCase() === clean.toLowerCase());
      const id = same?.id ?? newId();
      change(
        (doc) => ({
          ...doc,
          people: same ? doc.people : { ...doc.people, [id]: { id, name: clean, kind, from: null, portrait: null, added: Date.now() } },
          present: { ...(doc.present ?? {}), [key]: [...new Set([...(doc.present?.[key] ?? []), id])] },
        }),
        `${clean} in a picture`,
      );
      return id;
    },

    removePresent(key, person) {
      change((d) => ({ ...d, present: withoutPresent(d.present, [key], person) }), "someone out of a picture");
    },

    async scanOne(item) {
      const root = useStore.getState().root;
      if (!root) return;
      await get().load();
      const was = get().scanned[item.key];
      if (was && was[0] === item.size && was[1] === item.modified) return;
      const kind = await pictureKind(item.key, get().faces);
      await api.facesScan(root, [{ key: item.key, path: item.primary, size: item.size, modified: item.modified, kind: kind === "drawn" && !get().characters ? null : kind, raw: item.kind === "raw", video: item.kind === "video" }]);
      if (useStore.getState().root === root) await get().load(true);
    },

    async mark(item, area) {
      const root = useStore.getState().root;
      if (!root) return [];
      const found = await api.facesMark(root, item, await pictureKind(item.key, get().faces), area);
      if (found.length && useStore.getState().root === root) await get().load(true);
      return found;
    },

    dismiss(faces) {
      change((d) => ({ ...d, no: [...new Set([...d.no, ...faces])], faces: Object.fromEntries(Object.entries(d.faces).filter(([id]) => !faces.includes(Number(id)))) }), `${faces.length} face${faces.length === 1 ? "" : "s"} put aside`);
      set({ sorted: get().sorted && { ...get().sorted!, groups: get().sorted!.groups.filter((g) => !g.faces.some((f) => faces.includes(f))) } });
    },

    notThem(faces, person) {
      const who = get().doc?.people[person]?.name ?? "them";
      change(
        (d) => {
          const not = { ...d.not };
          for (const f of faces) not[String(f)] = [...new Set([...(not[String(f)] ?? []), person])];
          const portrait = d.people[person]?.portrait;
          return { ...d, not, faces: Object.fromEntries(Object.entries(d.faces).filter(([id, a]) => !(a.p === person && faces.includes(Number(id))))), people: portrait != null && faces.includes(portrait) ? { ...d.people, [person]: { ...d.people[person], portrait: null } } : d.people };
        },
        `${faces.length} face${faces.length === 1 ? "" : "s"} not ${who}`,
      );
      resort();
    },

    setPortrait(person, face) {
      change((d) => (d.people[person] ? { ...d, people: { ...d.people, [person]: { ...d.people[person], portrait: face } } } : d), "Portrait changed");
    },

    setBanner(person, banner) {
      change((d) => {
        const was = d.people[person];
        if (!was) return d;
        const { banner: _old, ...rest } = was;
        void _old;
        return { ...d, people: { ...d.people, [person]: banner ? { ...rest, banner } : rest } };
      });
    },

    rename(person, name) {
      const clean = name.trim().slice(0, 120);
      if (clean) change((d) => (d.people[person] ? { ...d, people: { ...d.people, [person]: { ...d.people[person], name: clean } } } : d), "Renamed");
    },

    setFrom(person, from) {
      const clean = from?.trim().slice(0, 120) || null;
      change((d) => (d.people[person] ? { ...d, people: { ...d.people, [person]: { ...d.people[person], from: clean } } } : d), clean ? `From ${clean}` : "Where they're from cleared");
    },

    setTag(person, tag) {
      change((d) => {
        const was = d.people[person];
        if (!was) return d;
        const { tag: _old, ...rest } = was;
        return { ...d, people: { ...d.people, [person]: tag === undefined ? rest : { ...rest, tag } } };
      }, "Tagger's name changed");
      resort();
    },

    setKind(person, kind) {
      const d = get().doc;
      if (!d?.people[person] || Object.values(d.faces).some((a) => a.p === person)) return;
      change((doc) => ({ ...doc, people: { ...doc.people, [person]: { ...doc.people[person], kind } } }), kind === "character" ? "Made a character" : "Made a person");
    },

    merge(from, into) {
      const d = get().doc;
      if (!d?.people[from] || !d.people[into] || from === into) return;
      change(
        (doc) => {
          const { [from]: gone, ...people } = doc.people;
          // Their banner goes with them, unless the one they are has their own.
          if (gone.banner && !people[into].banner) people[into] = { ...people[into], banner: gone.banner };
          const present = doc.present && Object.fromEntries(Object.entries(doc.present).map(([k, ids]) => [k, [...new Set(ids.map((p) => (p === from ? into : p)))]]));
          return { ...doc, people, faces: Object.fromEntries(Object.entries(doc.faces).map(([id, a]) => [id, a.p === from ? { ...a, p: into } : a])), not: Object.fromEntries(Object.entries(doc.not).map(([id, ps]) => [id, ps.filter((p) => p !== from)])), present };
        },
        `${d.people[from].name} is ${d.people[into].name}`,
      );
      if (get().open === from) set({ open: into });
      resort();
    },

    revert() {
      const u = get().undo;
      if (!u) return;
      change(() => u.doc);
      set({ undo: null });
      resort();
    },

    setExclude(folders) {
      change((d) => ({ ...d, exclude: [...new Set(folders.map((f) => f.replace(/\/+$/, "")).filter(Boolean))].sort() }));
    },

    pending() {
      const s = useStore.getState();
      const d = get().doc;
      if (!d || !s.library) return [];
      const trash = s.library.trashDir.replace(/\/+$/, "") + "/";
      const left = d.exclude.map((f) => f + "/");
      const { scanned, noCharacters, characters } = get();
      return s.allItems.filter((it) => {
        if (it.key.startsWith(trash) || left.some((f) => it.key.startsWith(f))) return false;
        const was = scanned[it.key];
        // Looked at without the character finder, which is here now: again, for drawn faces.
        return !was || was[0] !== it.size || was[1] !== it.modified || (characters && noCharacters.has(it.key));
      });
    },

    toRecheck(tags) {
      const d = get().doc;
      if (!d || d.photosRechecked || !tags) return [];
      const scanned = get().scanned;
      const due = new Set(get().pending().map((it) => it.key));
      const trash = (useStore.getState().library?.trashDir ?? "_deleted").replace(/\/+$/, "") + "/";
      return useStore.getState().allItems.filter((it) => scanned[it.key] && !due.has(it.key) && kindFromTags(tags, it.key) === "photo" && !it.key.startsWith(trash) && !d.exclude.some((f) => it.key.startsWith(`${f}/`)));
    },

    toRelook(tags) {
      const d = get().doc;
      if (!d) return [];
      const { scanned, faces, characters } = get();
      const due = new Set([...get().pending(), ...get().toRecheck(tags)].map((it) => it.key));
      const asked = new Set(d.relook ?? []);
      // By picture: whether it has a face out of place that may go, and one the user keeps.
      const out = new Map<string, { loose: boolean; kept: boolean }>();
      for (const f of faces) {
        if (f.marked || !outOfPlace(f, faceKind(d, tags, f.key), characters)) continue;
        const given = d.faces[String(f.id)];
        const was = out.get(f.key) ?? { loose: false, kept: false };
        if (given && !given.auto) was.kept = true;
        else was.loose = true;
        out.set(f.key, was);
      }
      const trash = (useStore.getState().library?.trashDir ?? "_deleted").replace(/\/+$/, "") + "/";
      return useStore.getState().allItems.filter((it) => {
        if (!scanned[it.key] || due.has(it.key) || it.key.startsWith(trash) || d.exclude.some((f) => it.key.startsWith(`${f}/`))) return false;
        const o = out.get(it.key);
        return asked.has(it.key) || (!!o?.loose && !o.kept);
      });
    },

    async setKinds(kinds) {
      const d = get().doc;
      if (!d) return;
      const { useTags } = await import("./tagsStore");
      const tags = useTags.getState().data;
      // The pictures looked at already that are taken for something else now.
      const now = { ...d, kinds };
      const changed = Object.keys(get().scanned).filter((k) => faceKind(d, tags, k) !== faceKind(now, tags, k));
      change((x) => ({ ...x, kinds, relook: [...new Set([...(x.relook ?? []), ...changed])] }));
      scanSoon(2_000);
    },

    async scan() {
      const root = useStore.getState().root;
      if (!root || get().scanning) return;
      await useStore.getState().loadAll();
      await get().load();
      const { useTags } = await import("./tagsStore");
      const tags = useTags.getState().data;
      const recheck = get().toRecheck(tags);
      const relook = get().toRelook(tags);
      const items = [...get().pending(), ...recheck, ...relook];
      // Noted in the people file once nothing is left to look at again (after the reload below, which
      // would otherwise read the file from before the note was saved).
      let rechecked = !recheck.length && !!tags && !!get().doc && !get().doc!.photosRechecked;
      const note = () => rechecked && change((d) => ({ ...d, photosRechecked: true }));
      if (!items.length) return void note();
      const characters = get().characters;
      // Which the picture is: what its folder says, else the tag index. A drawn one without the character
      // finder is looked at as one not known: the face finder alone, and the picture noted to look at
      // again once the finder is here.
      const kindOf = (k: string) => {
        const kind = faceKind(get().doc, tags, k);
        return kind === "drawn" && !characters ? null : kind;
      };
      set({ scanning: true });
      try {
        await api.facesScan(
          root,
          // A video too: a few frames of it are looked at, each face kept with its moment.
          items.map((it) => ({ key: it.key, path: it.primary, size: it.size, modified: it.modified, kind: kindOf(it.key), raw: it.kind === "raw", video: it.kind === "video" })),
        );
        // Looked at through to the end: the photos looked at again are done for good, and so are the pictures asked to be.
        if (recheck.length) rechecked = true;
        // (And pictures gone since they were asked.)
        const looked = new Set(relook.map((it) => it.key));
        const there = new Set(useStore.getState().allItems.map((it) => it.key));
        if (get().doc?.relook?.some((k) => looked.has(k) || !there.has(k))) change((d) => ({ ...d, relook: (d.relook ?? []).filter((k) => !looked.has(k) && there.has(k)) }));
      } catch (e) {
        if (String(e) !== "stopped") useStore.getState().toast(`Looking for faces stopped: ${String(e).replace(/^Error: /, "")}`, "warn");
      } finally {
        set({ scanning: false });
        if (useStore.getState().root === root) {
          await get().load(true);
          note();
        }
      }
    },

    setOpen(id) {
      set({ open: id });
    },

    async convert(folder) {
      const { useTags, settingsOf } = await import("./tagsStore");
      await useTags.getState().load();
      const t = useTags.getState();
      const data = t.data;
      const d = get().doc;
      if (!data || !d) return 0;
      const prefix = `${folder}/`;
      const tagged: Record<string, string[]> = {};
      for (const [k, list] of Object.entries(data.tags)) {
        const mine = list.filter((x) => x.startsWith(prefix));
        if (mine.length) tagged[k] = mine;
      }
      const names = [...new Set(Object.values(tagged).flat())];
      if (!names.length) return 0;
      const facesIn = new Map<string, FaceView[]>();
      for (const f of get().faces) facesIn.set(f.key, [...(facesIn.get(f.key) ?? []), f]);
      // Made new, or there already by that name (whose faces from the tag are noted, to take back).
      const made: string[] = [];
      const added: Record<string, number[]> = {};
      const people = { ...d.people };
      const faces = { ...d.faces };
      // A tagged picture where no face was found to be theirs (none of their kind, several, or the
      // one there someone else's): they are in it all the same, their face not known (till it is said
      // which, or marked).
      const present: Record<string, string[]> = {};
      for (const tag of names) {
        const keys = Object.keys(tagged).filter((k) => tagged[k].includes(tag));
        // A person or a character, as most of their pictures' faces are.
        const all = keys.flatMap((k) => facesIn.get(k) ?? []);
        // None found: as the pictures are, drawn ones being those the anime tagger looked at.
        const kind: PersonKind = all.length ? (all.filter((f) => f.kind === "drawn").length > all.length / 2 ? "character" : "person") : keys.filter((k) => data.auto[k]).length > keys.length / 2 ? "character" : "person";
        const name = tag.slice(prefix.length).replace(/[_-]+/g, " ").trim() || tag;
        const there = Object.values(people).find((p) => p.kind === kind && p.name.toLowerCase() === name.toLowerCase())?.id;
        const id = there ?? newId();
        if (!there) {
          people[id] = { id, name, kind, from: null, portrait: null, added: Date.now() };
          made.push(id);
        }
        // A picture with one face of theirs: that face is theirs. Others like them are suggested.
        for (const k of keys) {
          const here = (facesIn.get(k) ?? []).filter((f) => (f.kind === "drawn") === (kind === "character"));
          const had = here.length === 1 ? faces[String(here[0].id)] : undefined;
          if (here.length !== 1 || (had && !had.auto)) {
            if (!(had && had.p === id)) present[k] = [...(present[k] ?? []), id];
            continue;
          }
          faces[String(here[0].id)] = { p: id };
          if (there) added[id] = [...(added[id] ?? []), here[0].id];
        }
      }
      // Taken before the tags go: their settings, to put back too.
      const settings = settingsOf(data, names);
      const there = { ...(d.present ?? {}) };
      for (const [k, ids] of Object.entries(present)) there[k] = [...new Set([...(there[k] ?? []), ...ids])];
      change((doc) => ({ ...doc, people, faces, present: there, converted: { folder, made, tags: tagged, at: Date.now(), settings, added, present } }));
      // The tags go: from every picture, and the tags themselves.
      for (const tag of names) t.removeTag(tag);
      resort();
      return names.length;
    },

    async revertConversion() {
      const d = get().doc;
      const c = d?.converted;
      if (!d || !c) return 0;
      const { useTags, withSettings } = await import("./tagsStore");
      await useTags.getState().load();
      const data = useTags.getState().data;
      if (!data) throw new Error("the tags couldn't be read, so they can't be put back yet");
      const tags = { ...data.tags };
      for (const [k, list] of Object.entries(c.tags)) tags[k] = [...new Set([...(tags[k] ?? []), ...list])];
      const back = { ...data, tags, types: data.types.includes(c.folder) ? data.types : [...data.types, c.folder] };
      useTags.setState({ data: c.settings ? withSettings(back, c.settings) : back });
      useTags.getState().save();
      // The people it made go, with their faces; people there before keep theirs, less the faces it gave
      // them. A record from before that was noted: those made with it are the ones added as it ran (an
      // older person of a tag's name kept), and their faces from it the unchecked ones in its pictures.
      const older = !c.added;
      const made = new Set(older ? c.made.filter((id) => !d.people[id] || c.at - d.people[id].added < 60_000) : c.made);
      const given = new Set(Object.values(c.added ?? {}).flat().map(String));
      if (older) {
        const nameOf = (tag: string) => (tag.slice(c.folder.length + 1).replace(/[_-]+/g, " ").trim() || tag).toLowerCase();
        for (const id of c.made.filter((x) => !made.has(x) && d.people[x])) {
          const theirs = new Set(Object.entries(c.tags).filter(([, list]) => list.some((t) => nameOf(t) === d.people[id].name.toLowerCase())).map(([k]) => k));
          for (const [f, a] of Object.entries(d.faces)) if (a.p === id && !a.ok && theirs.has(get().byId.get(Number(f))?.key ?? "")) given.add(f);
        }
      }
      // Who it said was in pictures with no face goes too.
      const gave = c.present ?? {};
      const present = Object.fromEntries(
        Object.entries(presentOf(d))
          .map(([k, ids]) => [k, ids.filter((id) => !made.has(id) && !gave[k]?.includes(id))] as const)
          .filter(([, ids]) => ids.length),
      );
      change((doc) => ({
        ...doc,
        people: Object.fromEntries(Object.entries(doc.people).filter(([id]) => !made.has(id))),
        faces: Object.fromEntries(Object.entries(doc.faces).filter(([f, a]) => !made.has(a.p) && !given.has(f))),
        present,
        converted: null,
      }));
      if (get().open && made.has(get().open!)) set({ open: null });
      resort();
      return Object.keys(c.tags).length;
    },

    keepConversion() {
      change((d) => ({ ...d, converted: null }));
    },

    follow(pairs) {
      const root = get().docRoot;
      if (root && root === useStore.getState().root) void api.facesRename(root, pairs).then(() => get().load(true), () => {});
      const move = (k: string) => pairs.find(([from]) => k === from || k.startsWith(`${from}/`));
      const moved = (k: string) => {
        const m = move(k);
        return m ? m[1] + k.slice(m[0].length) : k;
      };
      if (get().doc?.exclude.some((f) => move(f))) change((d) => ({ ...d, exclude: d.exclude.map(moved) }));
      // What folders say goes with them; a picture moved where another folder says otherwise is looked at again.
      const kinds = get().doc?.kinds;
      const relook = get().doc?.relook ?? [];
      if (kinds || relook.length) {
        const after = Object.fromEntries(Object.entries(kinds ?? {}).map(([f, k]) => [moved(f), k]));
        const again = Object.keys(get().scanned)
          .filter((k) => move(k))
          .map((k) => [k, moved(k)] as const)
          .filter(([from, to]) => folderKind(kinds, from) !== folderKind(after, to))
          .map(([, to]) => to);
        if (again.length || relook.some((k) => move(k)) || Object.keys(kinds ?? {}).some((f) => move(f)))
          change((d) => ({ ...d, ...(d.kinds ? { kinds: after } : {}), relook: [...new Set([...(d.relook ?? []).map(moved), ...again])] }));
      }
      // Who is in a picture with no face to show it goes with the picture.
      if (Object.keys(get().doc?.present ?? {}).some((k) => move(k))) change((d) => ({ ...d, present: Object.fromEntries(Object.entries(d.present ?? {}).map(([k, ids]) => [moved(k), ids])) }));
      // A conversion still to keep or undo: its tags go back on the pictures where they are now.
      const c = get().doc?.converted;
      if (c && Object.keys(c.tags).some((k) => move(k))) change((d) => ({ ...d, converted: d.converted && { ...d.converted, tags: Object.fromEntries(Object.entries(d.converted.tags).map(([k, l]) => [moved(k), l])) } }));
    },

    forget(prefix) {
      const root = get().docRoot;
      if (root && root === useStore.getState().root) void api.facesForget(root, prefix).then(() => get().load(true), () => {});
      if (Object.keys(get().doc?.present ?? {}).some((k) => k.startsWith(prefix))) change((d) => ({ ...d, present: Object.fromEntries(Object.entries(d.present ?? {}).filter(([k]) => !k.startsWith(prefix))) }));
    },
  };
});

/* ---------- the scan after the tag index, by itself ---------- */

let scheduled: ReturnType<typeof setTimeout> | null = null;
let watching = false;

/** Faces looked for by themselves: when a library opens, when pictures come in, and once indexing is done. */
export function watchForFaces() {
  if (watching) return;
  watching = true;
  useStore.subscribe((s, p) => {
    if (s.root !== p.root) {
      usePeople.setState({ doc: null, docRoot: null, faces: [], byId: new Map(), scanned: {}, sorted: null, open: null, undo: null });
      if (s.root) scanSoon(30_000);
    } else if (s.allLoaded && s.allItems !== p.allItems) scanSoon();
  });
  void import("./tagsStore").then(({ useTags }) =>
    useTags.subscribe((t, p) => {
      if ((p.indexing && !t.indexing) || (p.data?.resumeIndex && !t.data?.resumeIndex)) scanSoon(5_000);
    }),
  );
  scanSoon(30_000);
}

/** Models downloaded or removed: the character finder just downloaded looks at what was looked at without it. */
let watchingModels = false;
function watchModels(engine: typeof import("./plugins/engine").useEngine) {
  if (watchingModels) return;
  watchingModels = true;
  engine.subscribe((st, prev) => {
    if (st.catalog && st.catalog !== prev.catalog) scanSoon(5_000);
  });
}

/** Look for faces in what is new, once the tag index has nothing to do (it says which pictures are drawn). */
export function scanSoon(delay = 15_000) {
  if (scheduled) clearTimeout(scheduled);
  scheduled = setTimeout(async () => {
    scheduled = null;
    const s = useStore.getState();
    if (!s.root || usePeople.getState().scanning) return;
    const [{ useTags }, { useEngine }] = await Promise.all([import("./tagsStore"), import("./plugins/engine")]);
    const t = useTags.getState();
    // Indexing runs, or waits to carry on (paused): faces after it.
    if (t.indexing || t.data?.resumeIndex) return;
    if (!useEngine.getState().catalog) await useEngine.getState().refresh().catch(() => {});
    watchModels(useEngine);
    const models = useEngine.getState().catalog?.models ?? [];
    // The face finder is needed; the character finder (drawn characters) is optional.
    usePeople.setState({ characters: !!models.find((m) => m.id === "characters")?.downloaded });
    if (!models.find((m) => m.id === "faces")?.downloaded) return;
    await usePeople.getState().load();
    const p = usePeople.getState();
    if (p.pending().length || p.toRecheck(t.data).length || p.toRelook(t.data).length) void p.scan();
  }, delay);
}

/** How sure the tagger must be that a character is in a picture to vouch for them there, and to rule the others out. */
const NAMES_THEM = 0.5;
const SURE_OF_THEM = 0.85;

/**
 * What the anime tagger says about each drawn face's picture, for matching: the characters it names
 * there (a face somewhat like one of theirs goes with them), and, when it is sure of one, the
 * characters it doesn't name (not them). A character is known to the tagger by its name for them:
 * the one it sees most on their own faces, or their name written as the tagger writes it.
 */
export async function taggerHints(doc: PeopleDoc, faces: FaceView[]): Promise<{ named: [number, string[]][]; ruledOut: [number, string[]][] }> {
  const none = { named: [], ruledOut: [] };
  const { useTags } = await import("./tagsStore");
  const { data, names } = useTags.getState();
  if (!data || !names?.length) return none;
  const index = new Map(names.map((n, i) => [n.name, i]));
  const theirs = picturesOf(doc, faces);
  const auto = seenIn(new Set([...faces.map((f) => f.key), ...Object.keys(doc.present ?? {})]), data.auto, names);
  // Each character's tagger name (its index): picked, or one that stands out.
  const tagOf = new Map<number, string>();
  for (const p of Object.values(doc.people)) {
    const t = characterTagOf(p, theirs.get(p.id) ?? [], auto, names, index);
    if (t && !tagOf.has(t.i)) tagOf.set(t.i, p.id);
  }
  if (!tagOf.size) return none;
  const named: [number, string[]][] = [];
  const ruledOut: [number, string[]][] = [];
  for (const f of faces) {
    if (f.kind !== "drawn" || doc.faces[f.id]) continue;
    const said = (auto[f.key] ?? []).filter(([i]) => names[i]?.category === 4);
    const here = said.filter(([i, p]) => p >= NAMES_THEM && tagOf.has(i)).map(([i]) => tagOf.get(i)!);
    if (here.length) named.push([f.id, here]);
    // Sure of someone: the characters it doesn't see at all aren't this face.
    if (said.some(([, p]) => p >= SURE_OF_THEM)) {
      const out = [...tagOf].filter(([i]) => !said.some(([j, p]) => j === i && p >= 0.3)).map(([, who]) => who);
      if (out.length) ruledOut.push([f.id, out]);
    }
  }
  return { named, ruledOut };
}

/** Each person's pictures, once each: those with a face given them, and those they are in with none known. */
export function picturesOf(doc: PeopleDoc, faces: FaceView[]): Map<string, string[]> {
  const keyOf = new Map(faces.map((f) => [f.id, f.key]));
  const out = new Map<string, Set<string>>();
  const add = (p: string, k: string) => out.set(p, (out.get(p) ?? new Set()).add(k));
  for (const [id, a] of Object.entries(doc.faces)) {
    const k = keyOf.get(Number(id));
    if (k && !a.auto) add(a.p, k);
  }
  for (const [k, ids] of Object.entries(doc.present ?? {})) for (const p of ids) add(p, k);
  return new Map([...out].map(([p, ks]) => [p, [...ks]]));
}

/**
 * The people whose name fits what is being typed, closest first: the name itself, then names that
 * start so, then a word in them that does (Miku for Hatsune Miku), then any part of it; between as
 * close, those with more faces. Everyone counts, faces or none.
 */
export function nameMatches(people: Person[], text: string, faces: (id: string) => number): Person[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const rank = (p: Person) => {
    const n = p.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[\s\-_.·・()]+/).some((w) => w.startsWith(q))) return 2;
    return n.includes(q) ? 3 : -1;
  };
  return people
    .map((p) => ({ p, r: rank(p) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || faces(b.p.id) - faces(a.p.id) || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}

/** A tag as a name is written: underscores as spaces, each word capitalised (`hatsune_miku` → Hatsune Miku). */
export const niceTag = (s: string) => s.replace(/_/g, " ").replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());

/** The series a tagger name carries in brackets, as such names do (`pepper_(peppercarrot)` → Peppercarrot). */
export const seriesOfTag = (tag: string): string | null => {
  const m = /_\(([^()]+)\)$/.exec(tag);
  return m ? niceTag(m[1]) : null;
};

/** A name as the tagger would write it. */
export const asTag = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "_");

/**
 * A character's tagger name (its index in `names`), and how it was had: picked; seen in at least
 * half their pictures (`seen` of `of`); or the tagger's name for their name. None for a person, or a
 * character said to have none.
 */
export function characterTagOf(person: Person, keys: string[], auto: Record<string, [number, number][]>, names: TagName[], index = new Map(names.map((n, i) => [n.name, i]))): { i: number; how: "picked" | "seen" | "name"; seen: number; of: number } | null {
  if (person.kind !== "character" || person.tag === null) return null;
  const seen = new Map<number, number>();
  for (const k of keys) for (const [i, pr] of auto[k] ?? []) if (pr >= NAMES_THEM && names[i]?.category === 4) seen.set(i, (seen.get(i) ?? 0) + 1);
  const at = (i: number | undefined, how: "picked" | "seen" | "name") => (i != null && names[i]?.category === 4 ? { i, how, seen: seen.get(i) ?? 0, of: keys.length } : null);
  if (person.tag) return at(index.get(person.tag), "picked");
  const most = [...seen].sort((a, b) => b[1] - a[1])[0];
  if (most && most[1] >= Math.max(1, keys.length / 2)) return at(most[0], "seen");
  return at(index.get(asTag(person.name)), "name");
}

/**
 * Who is in these pictures, by the tagger's names: what it saw, and the characters their platform
 * tagged them with (said surely, as 1).
 */
export function seenIn(keys: Iterable<string>, auto: Record<string, [number, number][]> | undefined, names: { name: string; category: number }[] | null): Record<string, [number, number][]> {
  const sources = useStore.getState().library?.sources ?? {};
  const index = new Map((names ?? []).map((n, i) => [n.name, i]));
  const out: Record<string, [number, number][]> = {};
  for (const k of keys) {
    const sure = allSources(sources[k])
      .flatMap((s) => s.tags ?? [])
      .filter((t) => t.kind === "character")
      // As the tagger writes names, or with dashes or spaces where it has underscores.
      .map((t) => index.get(t.name) ?? index.get(t.name.toLowerCase().replace(/[- ]/g, "_")))
      .filter((i): i is number => i != null && names![i]?.category === 4);
    const said = auto?.[k] ?? [];
    if (said.length || sure.length) out[k] = [...said.filter(([i]) => !sure.includes(i)), ...sure.map((i) => [i, 1] as [number, number])];
  }
  return out;
}

/** The character the anime tagger saw most in these pictures, with their series: a guess at who a drawn face is. */
export function characterGuess(keys: string[], auto: Record<string, [number, number][]> | undefined, names: { name: string; category: number }[] | null): { name: string; from: string | null } | null {
  if (!auto || !names?.length || !keys.length) return null;
  const count = (category: number) => {
    const seen = new Map<number, number>();
    for (const k of keys) for (const [i, p] of auto[k] ?? []) if (p >= 0.5 && names[i]?.category === category) seen.set(i, (seen.get(i) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  };
  const who = count(4);
  if (!who || who[1] < Math.max(1, keys.length / 2)) return null;
  const series = count(3);
  return { name: niceTag(names[who[0]].name), from: series && series[1] >= Math.max(1, keys.length / 2) ? niceTag(names[series[0]].name) : null };
}
