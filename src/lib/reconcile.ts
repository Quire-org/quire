import type { MediaItem } from "./types";
import { dirOf } from "./moves";

/**
 * Finding files again after they were moved outside the app (in Finder, say). Everything the app
 * keeps is kept by a file's path, so a move loses it unless the file is recognised at its new path.
 *
 * What is known: a snapshot of the library at the last full look (each file's size, modified time
 * and when it was first seen there), the files that went missing with something kept (and when they
 * were last seen), and older records (a rated file's identity, the tag index's and the duplicate
 * scanner's). A missing file is matched to a file that turned up after it was last seen, by size and
 * time (a moved file keeps both), then by name, the folders its neighbours went to, and content.
 */

/** What we remember about a file so it can be found after being moved or renamed. */
export interface Identity {
  /** size in bytes */
  s: number;
  /** modified, ms since epoch */
  m: number;
  /** file name of the primary file */
  n: string;
  /** content fingerprint (lazily filled) */
  f?: string;
}

export function identityOf(item: MediaItem): Identity {
  return { s: item.size, m: item.modified, n: item.primary.split(/[/\\]/).pop() ?? item.name };
}

const fileName = (key: string) => key.split(/[/\\]/).pop() ?? key;

/* ---------------- the snapshot ---------------- */

/** [size, modified ms, first seen at this key ms] */
type Seen = [number, number, number];
/** [size, modified ms, last seen at this key ms] */
type Gone = [number, number, number];

export interface Snapshot {
  version: 1;
  /** When it was taken (ms). */
  at: number;
  /** The files there then, by folder and name. */
  files: Record<string, Record<string, Seen>>;
  /** Files that went missing with something kept, until found again or nothing is kept for them. */
  gone: Record<string, Gone>;
}

export function readSnapshot(raw: unknown): Snapshot | null {
  const s = raw as Partial<Snapshot> | null;
  return s && s.version === 1 && typeof s.at === "number" && s.files && s.gone ? (s as Snapshot) : null;
}

/** A file in the snapshot: [size, modified, first seen], if it was there. */
export function seenIn(snap: Snapshot | null, key: string): Seen | undefined {
  return snap?.files[dirOf(key)]?.[fileName(key)];
}

/**
 * The snapshot after a look at the library: the files there now (each keeping when it was first
 * seen, if it was there before with the same size and time), and the missing files with something
 * kept (`kept`): those there last time join, their time last seen the old snapshot's; those found
 * again (or with nothing kept any more) leave.
 */
export function nextSnapshot(prev: Snapshot | null, items: MediaItem[], kept: (key: string) => boolean, now: number): Snapshot {
  const files: Snapshot["files"] = {};
  const present = new Set<string>();
  for (const it of items) {
    present.add(it.key);
    // Changed in place (an edit) it is still the file that was there.
    const first = seenIn(prev, it.key)?.[2] ?? now;
    (files[it.dir] ??= {})[fileName(it.key)] = [it.size, it.modified, first];
  }
  const gone: Snapshot["gone"] = {};
  for (const [k, g] of Object.entries(prev?.gone ?? {})) if (!present.has(k) && kept(k)) gone[k] = g;
  if (prev)
    for (const [dir, names] of Object.entries(prev.files))
      for (const [name, [s, m]] of Object.entries(names)) {
        const k = dir ? `${dir}/${name}` : name;
        if (!present.has(k) && kept(k)) gone[k] = [s, m, prev.at];
      }
  return { version: 1, at: now, files, gone };
}

/** A short sign of a snapshot's content (not its time): unchanged, it needn't be written again. */
export function snapshotSig(s: Snapshot): string {
  let h = 0x811c9dc5;
  const add = (x: string) => {
    for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 0x01000193);
  };
  let n = 0;
  for (const dir of Object.keys(s.files).sort())
    for (const [name, [size, m]] of Object.entries(s.files[dir]).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      add(`${dir}/${name}|${size}|${m};`);
      n++;
    }
  for (const k of Object.keys(s.gone).sort()) add(`gone:${k};`);
  return `${n}:${(h >>> 0).toString(36)}`;
}

/* ---------------- finding moved files ---------------- */

/**
 * A missing file: what is known of it, and when it was last seen at its key (unknown: from before
 * snapshots). `byName`: with nothing else known, a name one of a kind on both sides is enough (a
 * rating from before files had identities); else only the same name where its neighbours went.
 */
export type Orphan = Partial<Identity> & { lastSeen?: number; byName?: boolean };

export interface MoveSearch {
  /** Keys something is kept under whose file isn't there any more. */
  orphans: Map<string, Orphan>;
  /** The files there now. */
  items: MediaItem[];
  /** When a file was first seen at its key; unknown for files from before snapshots. */
  firstSeen: (key: string) => number | undefined;
  /** Files with something of their own kept (a rating, your tags). */
  taken: Set<string>;
  fingerprint: (path: string) => Promise<string>;
}

/** Modified times a copy to another drive can round (FAT's two seconds). */
const SLACK = 2000;

/**
 * Files moved outside the app: [old key, new key]. A file can only be where a missing one went if it
 * turned up after that one was last seen there (so a copy that was there all along never takes a
 * trashed twin's things); where that isn't known, only if it has nothing of its own kept.
 *
 * 1. Same size and modified time, or same name and modified time (sidecars change a size), or
 *    either within FAT's two seconds: one such file, wanted by no other missing file: it.
 * 2. Several: the one with the same name; else in the folder the missing file's neighbours went to;
 *    else the one with the same content, when that is known.
 * 3. Nothing known but the key (things kept before files had identities): the same name in the
 *    folder its neighbours went to; for an old rating, also a name one of a kind on both sides.
 */
export async function findMoves(input: MoveSearch): Promise<[string, string][]> {
  const claimed = new Set<string>();
  const moves: [string, string][] = [];
  const done = new Set<string>();
  const may = (it: MediaItem, o: Orphan) => {
    if (claimed.has(it.key)) return false;
    const first = input.firstSeen(it.key);
    if (first != null && o.lastSeen != null) return first > o.lastSeen;
    return !input.taken.has(it.key);
  };
  const take = (from: string, to: MediaItem) => {
    claimed.add(to.key);
    done.add(from);
    moves.push([from, to.key]);
  };
  const bySize = new Map<number, MediaItem[]>();
  const byFileName = new Map<string, MediaItem[]>();
  const byKey = new Map<string, MediaItem>();
  for (const i of input.items) {
    bySize.set(i.size, [...(bySize.get(i.size) ?? []), i]);
    byFileName.set(fileName(i.key), [...(byFileName.get(fileName(i.key)) ?? []), i]);
    byKey.set(i.key, i);
  }
  // What it could be, best first: the same size and time; the same name and time (a file's size here
  // is its sidecars' too, a video's .THM, .LRV or .SRT, and those get tidied away: its own time, to the
  // millisecond, and name stay); then either with the time rounded by another drive.
  const bySizeTime = (o: Orphan, key: string) => {
    const name = o.n ?? fileName(key);
    const sized = (bySize.get(o.s!) ?? []).filter((i) => may(i, o));
    const named = (byFileName.get(name) ?? []).filter((i) => may(i, o));
    for (const list of [sized.filter((i) => i.modified === o.m), named.filter((i) => i.modified === o.m), sized.filter((i) => Math.abs(i.modified - o.m!) <= SLACK), named.filter((i) => Math.abs(i.modified - o.m!) <= SLACK)]) if (list.length) return list;
    return [];
  };

  // 1. One of a kind both ways: the only such file, and no other missing file could be it.
  const cands = new Map<string, MediaItem[]>();
  for (const [key, o] of input.orphans) if (o.s != null && o.m != null) cands.set(key, bySizeTime(o, key));
  const wanted = new Map<string, number>();
  for (const list of cands.values()) for (const i of list) wanted.set(i.key, (wanted.get(i.key) ?? 0) + 1);
  for (const [key, list] of cands) if (list.length === 1 && wanted.get(list[0].key) === 1) take(key, list[0]);

  // Where the folders went, from the files found so far: a folder's files mostly went to one other.
  const dirMap = () => {
    const votes = new Map<string, Map<string, number>>();
    for (const [a, b] of moves) {
      const from = dirOf(a);
      const v = votes.get(from) ?? new Map<string, number>();
      v.set(dirOf(b), (v.get(dirOf(b)) ?? 0) + 1);
      votes.set(from, v);
    }
    const best = new Map<string, string>();
    for (const [from, v] of votes) {
      const [to, n] = [...v].sort((x, y) => y[1] - x[1])[0];
      const total = [...v.values()].reduce((a, b) => a + b, 0);
      if (n * 2 > total) best.set(from, to);
    }
    // A folder none of whose files was found: where its parent went, with its own name.
    const of = (dir: string): string | undefined => {
      if (best.has(dir)) return best.get(dir);
      if (!dir) return undefined;
      const up = of(dirOf(dir));
      return up == null ? undefined : `${up ? `${up}/` : ""}${fileName(dir)}`;
    };
    return of;
  };

  // 2. Several alike: by name, by where the neighbours went, by content; taken only when no other
  // missing file still comes down to the same one. Twice, as each find tells more.
  for (let round = 0; round < 2; round++) {
    const to = dirMap();
    const narrowed = new Map<string, MediaItem[]>();
    for (const [key, o] of input.orphans) {
      if (done.has(key) || o.s == null || o.m == null) continue;
      let list = bySizeTime(o, key);
      if (list.length > 1) {
        const name = o.n ?? fileName(key);
        const sameName = list.filter((i) => fileName(i.key) === name);
        if (sameName.length) list = sameName;
      }
      if (list.length > 1) {
        const dir = to(dirOf(key));
        const there = dir == null ? [] : list.filter((i) => dirOf(i.key) === dir);
        if (there.length) list = there;
      }
      if (list.length > 1 && o.f) {
        const hits: MediaItem[] = [];
        for (const i of list) {
          try {
            if ((await input.fingerprint(i.primary)) === o.f) hits.push(i);
          } catch {
            /* unreadable: not a match */
          }
        }
        list = hits;
      }
      narrowed.set(key, list);
    }
    const wants = new Map<string, number>();
    for (const list of narrowed.values()) for (const i of list) wants.set(i.key, (wants.get(i.key) ?? 0) + 1);
    for (const [key, list] of narrowed) if (list.length === 1 && wants.get(list[0].key) === 1 && !claimed.has(list[0].key)) take(key, list[0]);
  }

  // 3. Nothing known but the key: the same name where its neighbours went, or one of a kind both sides.
  const to = dirMap();
  const free = input.items.filter((i) => !claimed.has(i.key));
  const names = new Map<string, MediaItem[]>();
  for (const i of free) names.set(fileName(i.key), [...(names.get(fileName(i.key)) ?? []), i]);
  const orphanNames = new Map<string, number>();
  for (const key of input.orphans.keys()) if (!done.has(key)) orphanNames.set(fileName(key), (orphanNames.get(fileName(key)) ?? 0) + 1);
  for (const [key, o] of input.orphans) {
    if (done.has(key) || (o.s != null && o.m != null)) continue;
    const name = o.n ?? fileName(key);
    const dir = to(dirOf(key));
    const there = dir == null ? undefined : byKey.get(dir ? `${dir}/${name}` : name);
    if (there && may(there, o)) {
      take(key, there);
      continue;
    }
    if (!o.byName) continue;
    const c = (names.get(name) ?? []).filter((i) => may(i, o));
    if (c.length === 1 && orphanNames.get(fileName(key)) === 1) take(key, c[0]);
  }
  return moves;
}
