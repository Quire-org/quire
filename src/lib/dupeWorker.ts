import { findGroups, type DupeEntry, type MatchOptions } from "./dupes";

/** The match, run away from the UI: entries in, groups out, by request id; how far along, now and then. */
const post = (m: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);
self.onmessage = (e: MessageEvent<{ id: number; entries: DupeEntry[]; opts: MatchOptions }>) => {
  const { id, entries, opts } = e.data;
  let last = 0;
  const groups = findGroups(entries, opts, (share) => {
    const now = Date.now();
    if (now - last < 100) return;
    last = now;
    post({ id, progress: share });
  });
  post({ id, groups });
};
