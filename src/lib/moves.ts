/**
 * Keys follow their files. Everything the app keeps about a file or folder is kept under its path
 * relative to the opened folder (its key). When files or folders move, a pair [old, new] says so:
 * for a file its key, for a folder its key and that of everything under it.
 */
export type MovePair = [string, string];

/**
 * A key's new key after some moves, or null when it didn't move. Looked up by the key itself and
 * each folder above it, so thousands of moves cost no more per key than one.
 */
export function mover(pairs: MovePair[]): (key: string) => string | null {
  const to = new Map<string, string>();
  for (const [a, b] of pairs) {
    const from = a.replace(/\/+$/, "");
    const dest = b.replace(/\/+$/, "");
    if (from && dest && from !== dest && !to.has(from)) to.set(from, dest);
  }
  if (!to.size) return () => null;
  const look = (key: string): string | null => {
    const own = to.get(key);
    if (own != null) return own;
    for (let cut = key.lastIndexOf("/"); cut > 0; cut = key.lastIndexOf("/", cut - 1)) {
      const dir = to.get(key.slice(0, cut));
      if (dir != null) return dir + key.slice(cut);
    }
    return null;
  };
  return (key) => {
    const found = look(key);
    if (found != null) return found;
    // A PDF's page is keyed "book.pdf#3": it goes where its PDF went.
    const page = /^(.+\.pdf)(#\d+)$/i.exec(key);
    if (!page) return null;
    const pdf = look(page[1]);
    return pdf == null ? null : pdf + page[2];
  };
}

/**
 * A record with its moved keys under their new ones, or null when none moved. What the new key has
 * already stays (a file looked at again since it moved keeps that), or is merged with what moved
 * (`merge`: tags, both kept); the old entry goes either way.
 */
export function rekeyRecord<T>(rec: Record<string, T>, move: (key: string) => string | null, merge?: (here: T, moved: T) => T): Record<string, T> | null {
  const moved: [string, T][] = [];
  for (const [k, v] of Object.entries(rec)) {
    const to = move(k);
    if (to != null) moved.push([to, v]);
  }
  if (!moved.length) return null;
  const out = { ...rec };
  for (const k of Object.keys(rec)) if (move(k) != null) delete out[k];
  for (const [to, v] of moved) {
    if (!(to in out)) out[to] = v;
    else if (merge) out[to] = merge(out[to], v);
  }
  return out;
}

/** The folder of a key ("" at the top). */
export const dirOf = (key: string) => (key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "");

/**
 * Folders moved as a whole, read from the files found moved: every file found from one folder went
 * to the same other folder, and nothing is left at the old one. Their keys (an album's rating,
 * language, tags, a sort target, an album folder) then follow too. Folders above them as well, as
 * far as the paths agree from the end: "Phone/Trip/a.jpg" found at "Private/Earlier/Trip/a.jpg"
 * says "Phone/Trip" went to "Private/Earlier/Trip", and "Phone" to "Private/Earlier", if nothing of
 * Phone's is left and everything found from it says the same.
 */
export function folderMoves(moves: MovePair[], present: Iterable<string>): MovePair[] {
  const to = new Map<string, string | null>();
  const say = (from: string, dest: string) => {
    if (!from || from === dest) return;
    const had = to.get(from);
    to.set(from, had === undefined || had === dest ? dest : null);
  };
  for (const [a, b] of moves) {
    say(dirOf(a), dirOf(b));
    // Up through the folders both paths end in alike.
    const x = a.split("/");
    const y = b.split("/");
    for (let k = 1; k < x.length - 1 && k < y.length - 1 && x[x.length - 1 - k] === y[y.length - 1 - k]; k++) say(x.slice(0, x.length - 1 - k).join("/"), y.slice(0, y.length - 1 - k).join("/"));
  }
  const left = new Set<string>();
  for (const k of present) for (let d = dirOf(k); d; d = dirOf(d)) left.add(d);
  return [...to].filter((e): e is MovePair => !!e[1] && !left.has(e[0]));
}
