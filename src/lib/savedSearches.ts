/**
 * Saved searches in Find: a search (or an artist's works with one of their tags) kept to look at
 * again, and what of it is new. A platform's works come with ids that count up as they are added
 * (the number at the end of one, as "site/123" or "123"): a saved search remembers the newest it
 * showed when last opened, and newer ones are new. What has passed the reader's screen is kept too:
 * what is new to them leaves it out.
 */

/** What a saved search shows again: as Find's view of a platform. */
export interface SavedView {
  section: string;
  query: string;
  option: string;
  author: { id: string; name: string } | null;
  tag: string | null;
}

export interface SavedSearch {
  id: string;
  pluginId: string;
  platform: string;
  /** A platform of several sites: the site it is of. */
  site: string | null;
  name: string;
  view: SavedView;
  /** The newest work it showed when last opened (its id): newer ones are new. */
  mark: string | null;
  openedAt: number;
  /** How many new works it had when last checked (`more`: as many as a page, so likely more), and when. */
  fresh: number | null;
  more: boolean;
  checkedAt: number | null;
}

/** The number a work's id ends with, as works are counted on their platform; null when it has none. */
export function idNumber(id: string): number | null {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Whether a work came after the mark (none: everything is). Ids without numbers can't say: not new. */
export function newer(id: string, mark: string | null): boolean {
  if (!mark) return true;
  const a = idNumber(id);
  const b = idNumber(mark);
  return a != null && b != null && a > b;
}

/** The newest of these works, and of the mark: the mark to keep. */
export function newestOf(ids: string[], mark: string | null): string | null {
  let best = mark;
  for (const id of ids) if (newer(id, best)) best = id;
  return best;
}

export function sameView(a: SavedView, b: SavedView): boolean {
  return a.section === b.section && a.query === b.query && a.option === b.option && (a.author?.id ?? null) === (b.author?.id ?? null) && a.tag === b.tag;
}

/** Whether a view can be saved: a search with terms, or an artist's works with one of their tags. */
export function saveable(view: SavedView, searchSection: string | null): boolean {
  return (view.section === searchSection && !!view.query.trim()) || (view.section === "artist" && !!view.author && !!view.tag);
}

/** What a saved search is called to begin with: its terms, or the artist and the tag. */
export function nameFor(view: SavedView): string {
  if (view.section === "artist" && view.author) return `${view.author.name || view.author.id} · #${view.tag}`;
  return view.query.trim();
}

/** How many of a page's works are new: after the mark, and not passed the reader's screen. */
export function freshIn(ids: string[], mark: string | null, seen: Set<string>): number {
  return ids.filter((id) => newer(id, mark) && !seen.has(id)).length;
}
