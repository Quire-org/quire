import { naturalCompare } from "./format";
import type { DirEntryInfo, MediaItem, Target } from "./types";

/**
 * Where imported and sorted pictures are filed. A bucket (Professional, Private…) is where a tree of
 * your own folders starts, at any depth: `Professional/Weddings/James & Amy`. Whatever is filed into
 * one of them (the bucket itself too) goes into a folder per year and in it a folder per day:
 * `Professional/Weddings/James & Amy/2026/2026-03-14/`. The day is the day of filing, never a date
 * read from the file (a download's can be anything), so it is always known and never changes. No
 * folder filing makes gets more than PART files: the rest go into "…, part 2" and on, in name order.
 * The year, day and part folders are the app's own ("filing folders"); every other folder in a
 * bucket is one of yours.
 */

export const PART = 1000;

const pad = (n: number) => String(n).padStart(2, "0");

/** A day as YYYY-MM-DD, in local time. */
export const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A name safe as one folder name on any drive the library may be on (FAT and exFAT refuse `*?"<>|`, and a name ending in a dot). */
export const folderName = (name: string) =>
  name
    .trim()
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");

/**
 * A folder the app makes in filing: a year (`2026`), a day (`2026-03-14`), or a day's part
 * (`2026-03-14, part 2`); a day named after an event, as earlier versions named them, too
 * (`2026-03-14 Wedding Jansen`). A folder of yours can't have such a name: it would be read as one.
 */
export const isFilingName = (name: string) => /^\d{4}$/.test(name) || /^\d{4}-\d{2}-\d{2}(?:[ ,].*)?$/.test(name);

/** Where pictures filed into a folder (a bucket, or a folder of yours in one) on a day go: `<folder>/<year>/<day>`. */
export function filedFolder(folder: string, day: Date): string {
  return `${folder}/${day.getFullYear()}/${dayOf(day)}`;
}

/** The k-th folder of a set, from 1: the folder itself, then "…, part 2" and on. */
export const partOf = (base: string, k: number) => (k <= 1 ? base : `${base}, part ${k}`);

/** A path as the library keeps it: from the root when inside it (`Albums`, given `/vol/Albums` or `Albums`), else as it is. */
export const fromRoot = (root: string, path: string) => {
  const r = root.replace(/\/+$/, "");
  return path.startsWith(`${r}/`) ? path.slice(r.length + 1) : path;
};

/** `path` is `folder` or inside it (paths from the root, without a slash at the end). */
export const within = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * The folder of yours a folder is in, within the bucket at `bucket`: the folder itself, or the one
 * above its first filing folder (`Professional/Weddings/2026/2026-03-14` is in `Professional/Weddings`).
 */
export function ownFolderOf(dir: string, bucket: string): string {
  if (!within(dir, bucket)) return dir;
  const parts = dir.slice(bucket.length).split("/").filter(Boolean);
  const at = parts.findIndex(isFilingName);
  return at < 0 ? dir : [bucket, ...parts.slice(0, at)].join("/");
}

/** Files that travel together, as the scan pairs them: in one folder, with the same name but for the extension (any case). */
const groupOf = (path: string) => {
  const cut = path.lastIndexOf("/");
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf(".");
  return `${path.slice(0, cut + 1)}${(dot > 0 ? name.slice(0, dot) : name).toLowerCase()}`;
};

/**
 * Which folder each file goes to: in name order (by full path, so a card's folders keep their order),
 * the base folder filled up to PART counting what it holds already (`has`), then its parts. A pair
 * (a RAW and its JPEG, a Live Photo's picture and video) stays together, in the next part if the
 * one being filled hasn't room for both.
 */
export function planParts(files: string[], base: string, has: (folder: string) => number = () => 0): { src: string; dest: string }[] {
  const groups = new Map<string, string[]>();
  for (const src of [...files].sort(naturalCompare)) {
    const g = groupOf(src);
    groups.set(g, [...(groups.get(g) ?? []), src]);
  }
  const out: { src: string; dest: string }[] = [];
  let k = 1;
  let room = PART - has(partOf(base, 1));
  for (const group of groups.values()) {
    while (room < group.length && room < PART) room = PART - has(partOf(base, ++k));
    for (const src of group) out.push({ src, dest: partOf(base, k) });
    room -= group.length;
  }
  return out;
}

/**
 * Folder names as typed: one, or a path of them (`Weddings > James & Amy`, or with `/`), each made
 * safe. `bad`: a name that would be read as one of the app's own year or day folders.
 */
export function typedFolders(text: string): { names: string[]; bad?: string } {
  const names = text
    .split(/[>/\\]/)
    .map(folderName)
    .filter(Boolean);
  const bad = names.find(isFilingName);
  return bad ? { names, bad } : { names };
}

/** Folder names compare as the drive does: any case, however an accent is written (APFS and FAT both). */
const sameName = (a: string, b: string) => a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();

/**
 * A folder of yours under `parent` by names, each spelled as the folder there already is when one is
 * (`weddings` finds `Weddings`): else the drive would hold one folder and the library's records
 * another spelling of it. `known`: the folders there are, as paths from the root.
 */
export function folderUnder(parent: string, names: string[], known: string[]): string {
  let at = parent;
  for (const n of names) {
    const there = known.find((k) => k.lastIndexOf("/") === at.length && k.startsWith(`${at}/`) && sameName(k.slice(at.length + 1), n));
    at = there ?? `${at}/${n}`;
  }
  return at;
}

/**
 * The folders of yours from `base` down (it first), as paths from the root: every folder but the
 * filing ones and what is in them, hidden ones and those in `skip` (the trash, album folders).
 * `list` gives a folder's entries (by its path from the root); one that can't be read shows nothing in it.
 */
export async function ownFolders(base: string, list: (dir: string) => Promise<DirEntryInfo[]>, rel: (abs: string) => string, skip: Set<string> = new Set()): Promise<string[]> {
  const out = [base];
  let level = [base];
  // A cap, so a folder tree that is really a dump of thousands doesn't hold the dialog up.
  while (level.length && out.length < 5000) {
    const below = await Promise.all(level.map((d) => list(d).catch(() => [] as DirEntryInfo[])));
    level = below
      .flat()
      .filter((e) => e.isDir && !e.name.startsWith(".") && !isFilingName(e.name))
      .map((e) => rel(e.path))
      .filter((p) => !skip.has(p));
    out.push(...level);
  }
  return out.sort(naturalCompare);
}

/** The target a path from the root is in: the deepest one whose folder holds it (as the scan finds it). */
export function targetFor(path: string, targets: Target[]): Target | undefined {
  let best: Target | undefined;
  for (const t of targets) if (!t.path.startsWith("/") && within(path, t.path) && (!best || t.path.length > best.path.length)) best = t;
  return best;
}

/**
 * A folder in a bucket (made or renamed by hand) whose name reads as a year or a day filing makes:
 * that name, else null. The app takes it for one of its own, so doesn't offer it as a folder of yours.
 */
export function dateNamedInBucket(path: string, targets: Target[]): string | null {
  const bucket = targetFor(path, targets.filter((t) => t.bucket));
  const name = path.slice(path.lastIndexOf("/") + 1);
  return bucket && path !== bucket.path && isFilingName(name) ? name : null;
}

/** The bucket a target is in: itself when it is one, else the nearest bucket above its folder. */
export function bucketOf(target: Target, targets: Target[]): Target | undefined {
  if (target.bucket) return target;
  return targetFor(target.path, targets.filter((t) => t.bucket && t.id !== target.id));
}

/** An item is in a target: in its folder, or in a target inside it (`Professional` holds `Professional/Weddings`'s pictures too). */
export function inTarget(item: MediaItem, target: Target, targets: Target[]): boolean {
  if (item.targetId === target.id) return true;
  const own = targets.find((t) => t.id === item.targetId);
  return !!own && !target.path.startsWith("/") && within(own.path, target.path);
}

/** A file an import would bring in (`inside`: in the library already, so moved). */
export interface Incoming {
  path: string;
  size: number;
  inside: boolean;
}

/** A file of the library to compare against: its path and size. */
export interface Known {
  path: string;
  size: number;
}

/**
 * The files worth fingerprinting for exact copies: an exact copy has the same size, so only files
 * whose size another one has (in the library, or in the import) can be one.
 */
export function sizeCandidates(incoming: Incoming[], library: Known[]): { incoming: string[]; library: string[] } {
  const coming = new Set(incoming.map((f) => f.path));
  const libSizes = new Map<number, string[]>();
  for (const k of library) if (!coming.has(k.path)) libSizes.set(k.size, [...(libSizes.get(k.size) ?? []), k.path]);
  const inSizes = new Map<number, number>();
  for (const f of incoming) inSizes.set(f.size, (inSizes.get(f.size) ?? 0) + 1);
  const inc = incoming.filter((f) => libSizes.has(f.size) || (inSizes.get(f.size) ?? 0) > 1);
  const sizes = new Set(inc.map((f) => f.size));
  return { incoming: inc.map((f) => f.path), library: [...libSizes.entries()].filter(([size]) => sizes.has(size)).flatMap(([, paths]) => paths) };
}

/**
 * A file of the import that is an exact copy: of a file in the library, of one earlier in the import,
 * or of a picture a version in the library was made from (`of` is then the version, called `note`).
 */
export interface Duplicate {
  path: string;
  of: string;
  where: "library" | "import" | "version";
  note?: string;
}

/** Where the pictures versions were made from stand among the library's files: by fingerprint only, after every real file. */
const MADE_FROM = "\uffffmade-from:";

/**
 * The pictures the library's versions were made from, as files to compare the import with: kept
 * for Revert or gone, a version of each is in the library. A fingerprint starts with the size.
 */
export function madeFromKnown(links: Record<string, { from: string; madeAt: string; note: string }>): { known: Known[]; fp: Map<string, string>; versionOf: Map<string, { of: string; note: string }> } {
  const known: Known[] = [];
  const fp = new Map<string, string>();
  const versionOf = new Map<string, { of: string; note: string }>();
  for (const l of Object.values(links)) {
    const path = MADE_FROM + l.from;
    if (fp.has(path)) continue;
    known.push({ path, size: parseInt(l.from.split("-")[0], 16) });
    fp.set(path, l.from);
    versionOf.set(path, { of: l.madeAt, note: l.note });
  }
  return { known, fp, versionOf };
}

/** The import's exact copies, by fingerprint (`fp`, for the candidates): the first of several in the import is not one. */
export function exactCopies(incoming: Incoming[], fp: Map<string, string>, library: Known[]): Duplicate[] {
  const coming = new Set(incoming.map((f) => f.path));
  const inLibrary = new Map<string, string>();
  for (const k of [...library].sort((a, b) => naturalCompare(a.path, b.path))) {
    const f = fp.get(k.path);
    if (f && !coming.has(k.path) && !inLibrary.has(f)) inLibrary.set(f, k.path);
  }
  const first = new Map<string, string>();
  const out: Duplicate[] = [];
  for (const inc of [...incoming].sort((a, b) => naturalCompare(a.path, b.path))) {
    const f = fp.get(inc.path);
    if (!f) continue;
    const had = inLibrary.get(f);
    if (had) out.push({ path: inc.path, of: had, where: "library" });
    else if (first.has(f)) out.push({ path: inc.path, of: first.get(f)!, where: "import" });
    else first.set(f, inc.path);
  }
  return out;
}
