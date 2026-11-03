/**
 * Find source: pictures of yours looked up on the platforms in Find that can look a picture up by
 * how it looks. What they find is only offered: a match said yes to becomes the picture's source,
 * as if it had come in through Find, so its tags linked to yours come in, its artist is suggested in
 * Artists and its characters help People.
 */
import { create } from "zustand";
import { api } from "./lib/api";
import { steppedJob } from "./lib/jobs";
import { smallJpeg } from "./lib/smallJpeg";
import type { MediaItem } from "./lib/types";
import { finder, useFinders, type Finder, type FindMatch } from "./plugins/find";
import { usePlugins } from "./plugins/store";
import { useStore } from "./store";
import { allSources } from "./lib/sources";

/** How alike a work must be to be offered at all, and to be surely it. */
export const MAYBE = 0.5;
export const SURE = 0.9;

export interface SourceMatch extends FindMatch {
  pluginId: string;
  platform: string;
  /** The platform's name, as Find shows it. */
  name: string;
}

/** A picture of yours, and the works that look like it, best first. */
export interface SourceFound {
  key: string;
  matches: SourceMatch[];
}

export const useSources = create<{ found: SourceFound[]; open: boolean; running: boolean }>(() => ({ found: [], open: false, running: false }));

/** The platforms that can look a picture up. */
const lookupFinders = (): Finder[] => Object.values(useFinders.getState().finders).filter((f) => f.lookup);

/** Look these pictures up (the ones without a source yet), as a job in Activity; what is found waits for a yes. */
export async function findSources(items: MediaItem[]) {
  const st = useStore.getState();
  const root = st.root;
  if (!root || useSources.getState().running) return;
  const finders = lookupFinders();
  if (!finders.length) return st.toast("No platform in Find can look pictures up: add one in Settings → Plugins.", "warn");
  // While an encrypted folder is open, only a platform allowed on encrypted folders may see its pictures.
  const allowed = finders.filter((f) => !st.vault?.unlocked || usePlugins.getState().byId(f.pluginId)?.state.allowVault);
  if (!allowed.length) return st.toast("That would send pictures from an encrypted folder: allow the platform on encrypted folders in Settings → Plugins first.", "warn");
  const pictures = items.filter((i) => i.kind === "image");
  // A picture from another platform is looked up too: the same work there is a crosspost, kept beside it.
  const sources = st.library?.sources ?? {};
  const todo = pictures.filter((i) => !allSources(sources[i.key]).some((s) => allowed.some((f) => f.platform === s.platform)));
  const had = pictures.length - todo.length;
  if (!todo.length) return st.toast(pictures.length ? `${had === 1 ? "It has" : "They all have"} a source there already` : "Find source looks pictures up, not videos", "warn");

  useSources.setState({ running: true });
  const names = allowed.map((f) => f.name).join(" and ");
  const { job, gate } = steppedJob({ title: `Finding sources of ${todo.length} picture${todo.length === 1 ? "" : "s"} on ${names}`, source: "Find source", total: todo.length, open: { label: "Review", go: () => useSources.setState({ open: true }) } });
  let found = 0;
  let unreadable = 0;
  let stopped: string | null = null;
  try {
    for (const [n, it] of todo.entries()) {
      // Another library opened: this one's pictures are looked up no further.
      if (!(await gate.pass()) || useStore.getState().root !== root) break;
      job.update({ done: n, detail: it.name, items: [{ key: it.key, name: it.name }] });
      let image: string;
      try {
        image = await smallJpeg(await api.readMediaImage(root, it.primary));
      } catch {
        unreadable++;
        continue;
      }
      const matches: SourceMatch[] = [];
      for (const f of allowed) {
        try {
          for (const m of await finder.lookup(f.pluginId, image)) if (m.similarity >= MAYBE) matches.push({ ...m, pluginId: f.pluginId, platform: f.platform, name: f.name });
        } catch (e) {
          // A platform that can't (signed out, say) can't for the next one either.
          stopped = `${f.name}: ${String(e).replace(/^Error: /, "")}`;
        }
        if (stopped) break;
      }
      if (stopped) break;
      if (matches.length) {
        found++;
        const one = { key: it.key, matches: matches.sort((a, b) => b.similarity - a.similarity).slice(0, 4) };
        useSources.setState((s) => ({ found: [...s.found.filter((x) => x.key !== it.key), one] }));
      }
    }
  } finally {
    job.finish();
    useSources.setState({ running: false });
  }
  // What was found is of the library that is gone: nothing of it opens over another.
  if (useStore.getState().root !== root) return;
  if (stopped) st.toast(stopped, "error");
  const notes = [had ? `${had} had a source already` : "", unreadable ? `${unreadable} couldn't be read` : ""].filter(Boolean).join(", ");
  st.toast(`${found ? `Found ${found} source${found === 1 ? "" : "s"}: say yes to the right ones` : "No sources found"}${notes ? ` (${notes})` : ""}`, found ? "ok" : "warn");
  if (found) useSources.setState({ open: true });
}

/** A match said yes to: the picture's source from now on. */
export function acceptMatch(key: string, m: SourceMatch) {
  const it = m.item;
  useStore.getState().addSources([[key, { platform: m.platform, id: it.id, url: it.url ?? "", title: it.title, author: it.author, tags: it.tags, date: it.date, adult: it.adult, ...(it.language ? { language: it.language } : {}), added: Date.now() }]]);
  drop(key);
}

/** A match that isn't it: the next one shown, or the picture left once there are none. */
export function notIt(key: string, m: SourceMatch) {
  useSources.setState((s) => ({
    found: s.found.flatMap((f) => {
      if (f.key !== key) return [f];
      const rest = f.matches.filter((x) => !(x.pluginId === m.pluginId && x.item.id === m.item.id));
      return rest.length ? [{ ...f, matches: rest }] : [];
    }),
  }));
}

function drop(key: string) {
  useSources.setState((s) => {
    const found = s.found.filter((f) => f.key !== key);
    return { found, open: s.open && found.length > 0 };
  });
}

// Another library (or none): what was found for the last one's pictures goes, and its review closes.
useStore.subscribe((s, p) => {
  if (s.root !== p.root) useSources.setState({ found: [], open: false });
});
