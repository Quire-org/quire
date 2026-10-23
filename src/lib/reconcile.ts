import type { MediaItem } from "./types";

/** What we remember about a rated file so it can be found after being moved or renamed. */
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

export interface ReconcileInput {
  ratings: Record<string, number>;
  ids: Record<string, Identity>;
  viewed: Record<string, number>;
  items: MediaItem[];
  fingerprint: (path: string) => Promise<string>;
}

export interface ReconcileResult {
  ratings: Record<string, number>;
  ids: Record<string, Identity>;
  viewed: Record<string, number>;
  /** (old key, new key) for every rating that followed its file */
  moves: [string, string][];
}

export function identityOf(item: MediaItem): Identity {
  return { s: item.size, m: item.modified, n: item.primary.split(/[/\\]/).pop() ?? item.name };
}

/**
 * Re-key ratings (and history) whose file is no longer at the recorded path.
 * Candidates are files that currently carry no rating. Match order:
 * 1. same size and modification time, exactly one candidate;
 * 2. several: the one with the same file name;
 * 3. still ambiguous and a fingerprint is known: the one whose content matches.
 * Older entries without an identity fall back to a unique file name match.
 */
export async function reconcile(input: ReconcileInput): Promise<ReconcileResult> {
  const ratings = { ...input.ratings };
  const ids = { ...input.ids };
  const viewed = { ...input.viewed };
  const moves: [string, string][] = [];
  const present = new Set(input.items.map((i) => i.key));
  const claimed = new Set<string>();
  const unrated = input.items.filter((i) => !(i.key in ratings));

  const bySizeTime = new Map<string, MediaItem[]>();
  const byName = new Map<string, MediaItem[]>();
  for (const i of unrated) {
    const k = `${i.size}|${i.modified}`;
    bySizeTime.set(k, [...(bySizeTime.get(k) ?? []), i]);
    const n = i.primary.split(/[/\\]/).pop() ?? i.name;
    byName.set(n, [...(byName.get(n) ?? []), i]);
  }

  const rekey = (from: string, to: string) => {
    claimed.add(to);
    ratings[to] = ratings[from];
    delete ratings[from];
    if (ids[from]) {
      ids[to] = ids[from];
      delete ids[from];
    }
    if (from in viewed) {
      viewed[to] = viewed[from];
      delete viewed[from];
    }
    moves.push([from, to]);
  };

  for (const key of Object.keys(input.ratings)) {
    if (present.has(key)) continue;
    const id = ids[key];
    if (!id) {
      // Legacy entry: only a unique file name can be trusted.
      const name = key.split(/[/\\]/).pop() ?? key;
      const c = (byName.get(name) ?? []).filter((i) => !claimed.has(i.key));
      if (c.length === 1) rekey(key, c[0].key);
      continue;
    }
    let cands = (bySizeTime.get(`${id.s}|${id.m}`) ?? []).filter((i) => !claimed.has(i.key));
    if (cands.length === 0) continue;
    if (cands.length > 1) {
      const sameName = cands.filter((i) => (i.primary.split(/[/\\]/).pop() ?? i.name) === id.n);
      if (sameName.length === 1) cands = sameName;
      else if (id.f) {
        const hits: MediaItem[] = [];
        for (const i of cands) {
          try {
            if ((await input.fingerprint(i.primary)) === id.f) hits.push(i);
          } catch {
            /* unreadable: not a match */
          }
        }
        cands = hits;
      } else continue;
    }
    if (cands.length === 1) rekey(key, cands[0].key);
  }
  return { ratings, ids, viewed, moves };
}
