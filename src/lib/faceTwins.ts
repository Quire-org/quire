import { naturalCompare, samePages } from "./format";
import type { FaceView, MediaItem } from "./types";
import type { PeopleDoc } from "../peopleStore";

/**
 * A face's twin: the same face on the same page of the album's other version (its translation, or the
 * original), so that what is said of one is said of both. A translation changes the words, not the
 * drawing: the face is where it was. Pages go together as the viewer's version switch has them
 * (`samePages`, by place only when both have as many); faces, by how much of each other they cover.
 */

/** Two faces at least this much one (their overlap over their union) are one face. */
const TWIN_OVERLAP = 0.5;

const overlap = (a: FaceView["bbox"], b: FaceView["bbox"]) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const both = w * h;
  const area = (r: FaceView["bbox"]) => (r[2] - r[0]) * (r[3] - r[1]);
  return both / Math.max(1e-9, area(a) + area(b) - both);
};

/** Each face's twins on the other version of its album (both ways). */
export function faceTwins(faces: readonly FaceView[], items: readonly MediaItem[], translations: Readonly<Record<string, string>>): Map<number, number[]> {
  const twins = new Map<number, number[]>();
  const links = Object.entries(translations);
  if (!links.length) return twins;
  const linked = new Set(links.flat());
  const pagesOf = new Map<string, MediaItem[]>();
  for (const it of items) {
    if (!it.albumKey || !linked.has(it.albumKey)) continue;
    const pages = pagesOf.get(it.albumKey);
    if (pages) pages.push(it);
    else pagesOf.set(it.albumKey, [it]);
  }
  const onLinked = new Set([...pagesOf.values()].flat().map((p) => p.key));
  const facesOn = new Map<string, FaceView[]>();
  for (const f of faces) {
    if (f.at != null || !onLinked.has(f.key)) continue;
    const on = facesOn.get(f.key);
    if (on) on.push(f);
    else facesOn.set(f.key, [f]);
  }
  const tie = (a: number, b: number) => {
    twins.set(a, [...(twins.get(a) ?? []), b]);
    twins.set(b, [...(twins.get(b) ?? []), a]);
  };
  // In an album's own order (one folder: by name).
  const inOrder = (key: string) => (pagesOf.get(key) ?? []).sort((x, y) => naturalCompare(x.name, y.name));
  for (const [one, other] of links) {
    const a = inOrder(one);
    const b = inOrder(other);
    for (const [i, j] of samePages(a, b, true)) {
      const theirs = (facesOn.get(b[j].key) ?? []).slice();
      for (const f of facesOn.get(a[i].key) ?? []) {
        let best = -1;
        let most = TWIN_OVERLAP;
        theirs.forEach((g, k) => {
          const o = g.kind === f.kind ? overlap(f.bbox, g.bbox) : 0;
          if (o >= most) (best = k), (most = o);
        });
        if (best >= 0) tie(f.id, theirs.splice(best, 1)[0].id);
      }
    }
  }
  return twins;
}

type Said = Pick<PeopleDoc, "faces" | "no" | "not">;

const sameFace = (a: Said["faces"][string] | undefined, b: Said["faces"][string] | undefined) => a === b || (!!a && !!b && a.p === b.p && !!a.ok === !!b.ok && !!a.auto === !!b.auto);
const sameNot = (a: string[] | undefined, b: string[] | undefined) => a === b || (a ?? []).join("\n") === (b ?? []).join("\n");

/**
 * `after`, with what a change said of a face (whose it is, put aside, not someone) said of its twins
 * too: every change to the People document goes through this, so no way of saying it misses the twin.
 */
export function mirrored<T extends Said>(before: T, after: T, twins: ReadonlyMap<number, number[]>): T {
  if (!twins.size || (before.faces === after.faces && before.no === after.no && before.not === after.not)) return after;
  const wasNo = new Set(before.no);
  const isNo = new Set(after.no);
  const changed = new Set<number>();
  for (const id of new Set([...Object.keys(before.faces), ...Object.keys(after.faces)])) if (!sameFace(before.faces[id], after.faces[id])) changed.add(Number(id));
  for (const id of wasNo) if (!isNo.has(id)) changed.add(id);
  for (const id of isNo) if (!wasNo.has(id)) changed.add(id);
  for (const id of new Set([...Object.keys(before.not), ...Object.keys(after.not)])) if (!sameNot(before.not[id], after.not[id])) changed.add(Number(id));
  const touched = [...changed].filter((id) => twins.has(id));
  if (!touched.length) return after;
  const faces = { ...after.faces };
  const not = { ...after.not };
  const said = new Set(after.no);
  for (const id of touched)
    for (const t of twins.get(id)!) {
      // Said of in this change itself: as said.
      if (changed.has(t)) continue;
      const a = after.faces[String(id)];
      if (a) faces[String(t)] = a;
      else delete faces[String(t)];
      if (isNo.has(id)) said.add(t);
      else said.delete(t);
      const n = after.not[String(id)];
      if (n) not[String(t)] = n;
      else delete not[String(t)];
    }
  return { ...after, faces, no: [...said], not };
}

/**
 * What was said of faces, said of their twins too where nothing is said of them yet (said before the
 * two were known to be one, or before the translation was made): whose each is (checked or not), put
 * aside, not someone. Null when nothing changes.
 */
export function carriedToTwins(doc: Said, twins: ReadonlyMap<number, number[]>): Said | null {
  if (!twins.size) return null;
  let faces = doc.faces;
  let not = doc.not;
  const no = new Set(doc.no);
  const was = no.size;
  for (const [id, a] of Object.entries(doc.faces)) {
    if (a.auto) continue;
    for (const t of twins.get(Number(id)) ?? []) {
      if (faces[String(t)] || no.has(t) || not[String(t)]?.includes(a.p)) continue;
      if (faces === doc.faces) faces = { ...doc.faces };
      faces[String(t)] = a.ok ? { p: a.p, ok: true } : { p: a.p };
    }
  }
  for (const id of doc.no) for (const t of twins.get(id) ?? []) if (!faces[String(t)]) no.add(t);
  for (const [id, people] of Object.entries(doc.not))
    for (const t of twins.get(Number(id)) ?? []) {
      const add = people.filter((p) => faces[String(t)]?.p !== p && !not[String(t)]?.includes(p));
      if (!add.length) continue;
      if (not === doc.not) not = { ...doc.not };
      not[String(t)] = [...(not[String(t)] ?? []), ...add];
    }
  return faces === doc.faces && no.size === was && not === doc.not ? null : { faces, no: [...no], not };
}
