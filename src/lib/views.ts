/**
 * What each screen was left showing in the library open (Browse's and Albums' filters, the tag
 * list's folded types, the duplicate check's scope): kept with that library, encrypted in its vault
 * when it has one. Not in this computer's browser storage, where it held the library's folder, tag
 * and people names in the clear, and one library's filters showed in another.
 */
import { api } from "./api";
import { debounced } from "./pending";

let doc: Record<string, unknown> = {};
let docRoot: string | null = null;

const save = debounced("views", 500, async (root) => {
  if (docRoot === root) await Promise.resolve().then(() => api.viewsSave(root, doc)).catch(() => {});
});

// What earlier versions kept in the browser: not taken over (it was one for every library), gone.
for (const key of ["quire.browseFilters", "quire.albumFilters", "quire.tags.collapsed", "quire.dupes.scope"]) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* no storage */
  }
}

/** The library's views, read as it opens (before its screens show). */
export async function loadViews(root: string): Promise<void> {
  const raw = await Promise.resolve().then(() => api.viewsLoad(root)).catch(() => null);
  doc = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  docRoot = root;
}

/** No library open: nothing of the last one's views stays. */
export function closeViews() {
  doc = {};
  docRoot = null;
}

/** One of the library's views, or `fallback` when it has none (or no library is open). */
export function view<T>(key: string, fallback: T): T {
  return docRoot && key in doc ? (doc[key] as T) : fallback;
}

/** A view changed: kept with the library, a moment later. */
export function setView(key: string, value: unknown) {
  if (!docRoot) return;
  doc = { ...doc, [key]: value };
  save.schedule(docRoot);
}
