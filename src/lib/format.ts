export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How long ago, in words: "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  const n = (v: number, unit: string) => `${Math.floor(v)} ${unit}${Math.floor(v) === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return n(s / 60, "minute");
  if (s < 86_400) return n(s / 3600, "hour");
  if (s < 2 * 86_400) return "yesterday";
  if (s < 14 * 86_400) return n(s / 86_400, "day");
  if (s < 60 * 86_400) return n(s / (7 * 86_400), "week");
  if (s < 365 * 86_400) return n(s / (30 * 86_400), "month");
  return n(s / (365 * 86_400), "year");
}

export function formatTime(s: number): string {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function ext(path: string): string {
  const m = /\.([^./\\]+)$/.exec(path);
  return m ? m[1].toUpperCase() : "";
}

/** Last `n` path segments, prefixed with an ellipsis when something was cut. */
export function tailPath(path: string, n = 2): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= n) return path;
  return "…/" + parts.slice(-n).join("/");
}

/** A page's number from its name: the last run of digits before the extension (page_012 → 12, "Chapter 3 - 07" → 7). */
export function pageNumber(name: string): number | null {
  const stem = name.replace(/\.[^.]+$/, "");
  const runs = stem.match(/\d+/g);
  return runs ? Number(runs[runs.length - 1]) : null;
}

export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * A shuffle. With a `seed`, each item's place comes from a hash of its own key and the seed, so
 * the order is the same every time for that seed, and an item arriving or leaving (a rescan,
 * a move) shifts nothing else: only Shuffle changes the order.
 */
export function shuffled<T>(arr: T[], seed?: number, keyOf: (item: T) => string = (item) => String((item as { key?: unknown }).key ?? item)): T[] {
  if (seed == null) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const rank = (key: string) => {
    // FNV-1a over the key, mixed with the seed.
    let h = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995) >>> 0;
    return (h ^ (h >>> 15)) >>> 0;
  };
  return arr
    .map((item, i) => ({ item, r: rank(keyOf(item)), i }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Natural order ("2" before "10"), with one shared collator: `localeCompare` with options builds a new
 * one on every call, which made sorting a big library slow.
 */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true }).compare;
const plainCollator = new Intl.Collator().compare;
export const plainCompare = (a: string, b: string) => plainCollator(a, b);
