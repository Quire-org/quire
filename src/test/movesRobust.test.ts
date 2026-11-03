import { describe, expect, it } from "vitest";
import { findMoves, nextSnapshot, seenIn, snapshotSig, type Orphan, type Snapshot } from "../lib/reconcile";
import { folderMoves } from "../lib/moves";
import type { MediaItem } from "../lib/types";

/**
 * Files moved outside the app, the way folders get tidied in Finder: whole folders moved and renamed,
 * folders emptied into others, copies everywhere, many files of one size. Whatever was kept must
 * follow each file, and never land on another.
 */

const item = (key: string, size: number, modified: number): MediaItem => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: key.split("/").pop()!.replace(/\.[^.]+$/, ""), dir: key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "", size, modified, hasRaw: false, hasVideo: false });

/** A tidy-up: the files before, and where each went (or null: deleted). */
interface Tidy {
  before: MediaItem[];
  to: Record<string, string | null>;
  /** Files that came in new (no history). */
  added?: MediaItem[];
}

/** Last time's snapshot (everything seen at t=1000), then the files now, then what reconciling finds. */
async function reconcile(t: Tidy, opts: { known?: (it: MediaItem) => Orphan; snapshot?: boolean; taken?: string[]; fps?: Record<string, string>; fpOf?: (it: MediaItem) => string } = {}) {
  const now: MediaItem[] = [];
  for (const it of t.before) {
    const to = t.to[it.key];
    if (to === null) continue;
    now.push(to ? { ...item(to, it.size, it.modified) } : it);
  }
  now.push(...(t.added ?? []));
  const snap = opts.snapshot === false ? null : nextSnapshot(null, t.before, () => true, 1000);
  const present = new Set(now.map((i) => i.key));
  const orphans = new Map<string, Orphan>();
  for (const it of t.before) {
    if (present.has(it.key)) continue;
    const seen = seenIn(snap, it.key);
    orphans.set(it.key, opts.known ? opts.known(it) : seen ? { s: seen[0], m: seen[1], lastSeen: snap!.at } : {});
  }
  return findMoves({
    orphans,
    items: now,
    taken: new Set(opts.taken ?? []),
    firstSeen: (key) => (snap ? (seenIn(snap, key)?.[2] ?? Number.MAX_SAFE_INTEGER) : undefined),
    fingerprint: async (p) => opts.fps?.[p] ?? (opts.fpOf ? opts.fpOf(now.find((i) => i.primary === p)!) : "?"),
  });
}

/** The moves found should be exactly the tidy-up's (none missing, none wrong). */
function expectExactly(found: [string, string][], t: Tidy) {
  const want = Object.entries(t.to).filter((e): e is [string, string] => !!e[1]);
  expect(new Map(found)).toEqual(new Map(want));
}

// A seeded random source, for big tidy-ups that are the same each run.
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("a folder tidy-up in Finder", () => {
  it("folders moved, renamed and emptied into others: every file found, thousands of them", async () => {
    const r = rng(7);
    const before: MediaItem[] = [];
    const to: Record<string, string | null> = {};
    // 40 folders of 100 pictures; sizes from a small range so many share one (as JPEGs of one camera do).
    for (let f = 0; f < 40; f++)
      for (let i = 0; i < 100; i++) {
        const it = item(`Phone/${2020 + (f % 5)}/Folder ${f}/IMG_${i}.jpg`, 3_000_000 + Math.floor(r() * 2000), 1_600_000_000_000 + Math.floor(r() * 1e9));
        before.push(it);
        // Half the folders moved whole (and renamed), a quarter emptied into one, a quarter left.
        to[it.key] = f % 4 < 2 ? `Private/Earlier/Trip ${f}/IMG_${i}.jpg` : f % 4 === 2 ? `Private/Everything/F${f}_IMG_${i}.jpg` : "";
      }
    for (const k of Object.keys(to)) if (to[k] === "") delete to[k];
    const t = { before, to };
    expectExactly(await reconcile(t), t);
  });

  it("a folder moved deeper (A/B → X/A/B), its subfolders with it", async () => {
    const before = [item("A/B/1.jpg", 10, 1), item("A/B/C/2.jpg", 20, 2), item("A/B/C/D/3.jpg", 30, 3)];
    const t = { before, to: { "A/B/1.jpg": "X/A/B/1.jpg", "A/B/C/2.jpg": "X/A/B/C/2.jpg", "A/B/C/D/3.jpg": "X/A/B/C/D/3.jpg" } };
    expectExactly(await reconcile(t), t);
  });

  it("exact copies in two folders, both moved: each to where its own folder went", async () => {
    // Same size, time and name in both: only the folders tell them apart.
    const before = [item("Trip/copy.jpg", 50, 5), item("Trip/a.jpg", 1, 1), item("Trip/b.jpg", 2, 2), item("Backup/copy.jpg", 50, 5), item("Backup/c.jpg", 3, 3), item("Backup/d.jpg", 4, 4)];
    const t = { before, to: { "Trip/copy.jpg": "2024/Trip/copy.jpg", "Trip/a.jpg": "2024/Trip/a.jpg", "Trip/b.jpg": "2024/Trip/b.jpg", "Backup/copy.jpg": "Old/Backup/copy.jpg", "Backup/c.jpg": "Old/Backup/c.jpg", "Backup/d.jpg": "Old/Backup/d.jpg" } };
    expectExactly(await reconcile(t), t);
  });

  it("only part of a folder moved: those found, the rest left alone", async () => {
    const before = [item("DCIM/1.jpg", 1, 1), item("DCIM/2.jpg", 2, 2), item("DCIM/3.jpg", 3, 3)];
    const t = { before, to: { "DCIM/2.jpg": "Best/2.jpg" } };
    expectExactly(await reconcile(t), t);
  });

  it("copied to another drive: times rounded by up to two seconds still match, more do not", async () => {
    const before = [item("a/1.jpg", 100, 10_000), item("a/2.jpg", 200, 20_000)];
    const now = [item("b/1.jpg", 100, 11_990), item("b/2.jpg", 200, 23_500)];
    const snap = nextSnapshot(null, before, () => true, 1000);
    const orphans = new Map<string, Orphan>(before.map((i) => [i.key, { s: i.size, m: i.modified, n: i.key.split("/").pop(), lastSeen: 1000 }]));
    const found = await findMoves({ orphans, items: now, taken: new Set(), firstSeen: (k) => seenIn(snap, k)?.[2] ?? Number.MAX_SAFE_INTEGER, fingerprint: async () => "?" });
    expect(found).toEqual([["a/1.jpg", "b/1.jpg"]]);
  });
});

describe("videos and their sidecars", () => {
  it("a video whose sidecars (.THM, .LRV, .SRT) were tidied away: its size changed, its name and time didn't", async () => {
    // An item's size is its files of one name together: the video and its sidecars.
    const before = [item("GoPro/GH010123.MP4", 4_000_000_000 + 900_000_000 + 12_000, 1_700_000_000_123), item("DJI/DJI_0001.MP4", 2_000_000_000 + 4_000, 1_700_000_100_456)];
    const now = [item("Videos/GoPro/GH010123.MP4", 4_000_000_000, 1_700_000_000_123), item("Videos/DJI_0001.MP4", 2_000_000_000, 1_700_000_100_456)];
    const snap = nextSnapshot(null, before, () => true, 1000);
    const orphans = new Map<string, Orphan>(before.map((i) => [i.key, { s: i.size, m: i.modified, lastSeen: 1000 }]));
    const found = await findMoves({ orphans, items: now, taken: new Set(), firstSeen: (k) => seenIn(snap, k)?.[2] ?? Number.MAX_SAFE_INTEGER, fingerprint: async () => "?" });
    expect(new Map(found)).toEqual(
      new Map([
        ["GoPro/GH010123.MP4", "Videos/GoPro/GH010123.MP4"],
        ["DJI/DJI_0001.MP4", "Videos/DJI_0001.MP4"],
      ]),
    );
  });

  it("but not a file that only shares the name (a camera's numbering starting again): its time differs", async () => {
    const before = [item("2023/GH010001.MP4", 500, 1_600_000_000_000)];
    const now = [item("2024/GH010001.MP4", 777, 1_700_000_000_000)];
    const found = await findMoves({ orphans: new Map([["2023/GH010001.MP4", { s: 500, m: 1_600_000_000_000, lastSeen: 1000 }]]), items: now, taken: new Set(), firstSeen: () => Number.MAX_SAFE_INTEGER, fingerprint: async () => "?" });
    expect(found).toEqual([]);
    void before;
  });
});

describe("what must never happen", () => {
  it("a copy that was there all along never takes a trashed twin's things", async () => {
    // The twin went to the trash (out of the library); its copy was there before, same size, time, name.
    const before = [item("A/IMG_1.jpg", 9, 9), item("B/IMG_1.jpg", 9, 9)];
    const t = { before, to: { "A/IMG_1.jpg": null } };
    expect(await reconcile(t)).toEqual([]);
  });

  it("a deleted file's look-alike that turns up new elsewhere, with nothing else to go on, is left alone when two could be it", async () => {
    // Two copies gone (one deleted, one moved): one new file with their size, time and name.
    const before = [item("A/dup.jpg", 9, 9), item("B/dup.jpg", 9, 9)];
    const found = await reconcile({ before, to: { "A/dup.jpg": null, "B/dup.jpg": "C/dup.jpg" } });
    // Either could be it: nothing is given rather than maybe the wrong one.
    expect(found).toEqual([]);
  });

  it("one file of one size and time among many alike: decided by name, never by order", async () => {
    const before = [item("x/a.jpg", 5, 5), item("x/b.jpg", 5, 5), item("x/c.jpg", 5, 5)];
    const t = { before, to: { "x/a.jpg": "y/a.jpg", "x/b.jpg": "z/b.jpg", "x/c.jpg": "w/c.jpg" } };
    expectExactly(await reconcile(t), t);
  });

  it("a file already fingerprinted or indexed at its new place still gets its old things (only kept things block, and only without a snapshot)", async () => {
    const before = [item("old/p.jpg", 7, 7)];
    const t = { before, to: { "old/p.jpg": "new/p.jpg" } };
    // With a snapshot it is known to be new there, even if something of its own is kept already.
    expectExactly(await reconcile(t, { taken: ["new/p.jpg"] }), t);
    // Without one, as before: not given another's if it has something of its own.
    expect(await reconcile(t, { snapshot: false, taken: ["new/p.jpg"], known: (i) => ({ s: i.size, m: i.modified }) })).toEqual([]);
    expectExactly(await reconcile(t, { snapshot: false, known: (i) => ({ s: i.size, m: i.modified }) }), t);
  });

  it("something kept with nothing known of the file but its key: by name where its neighbours went, never by name alone", async () => {
    const before = [item("Trip/1.jpg", 1, 1), item("Trip/2.jpg", 2, 2), item("Trip/tagged.jpg", 3, 3), item("Other/tagged.jpg", 4, 4)];
    const known = (i: MediaItem): Orphan => (i.key === "Trip/tagged.jpg" ? {} : { s: i.size, m: i.modified, lastSeen: 1000 });
    const found = await reconcile({ before, to: { "Trip/1.jpg": "2024/Trip/1.jpg", "Trip/2.jpg": "2024/Trip/2.jpg", "Trip/tagged.jpg": "2024/Trip/tagged.jpg" } }, { known });
    expect(new Map(found).get("Trip/tagged.jpg")).toBe("2024/Trip/tagged.jpg");
    // A lone file gone, a file of its name new elsewhere: not it.
    const alone = await reconcile({ before: [item("Lone/x.jpg", 1, 1)], to: { "Lone/x.jpg": null }, added: [item("Elsewhere/x.jpg", 1, 1)] }, { known: () => ({}) });
    expect(alone).toEqual([]);
  });
});

describe("folders that moved with their files", () => {
  it("folders above too, as far as the paths agree from the end, if nothing of theirs is left", () => {
    const moves: [string, string][] = [
      ["Phone/Trip/a.jpg", "Private/Earlier/Trip/a.jpg"],
      ["Phone/Other/b.jpg", "Private/Earlier/Other/b.jpg"],
    ];
    const present = moves.map(([, b]) => b);
    expect(new Map(folderMoves(moves, present))).toEqual(
      new Map([
        ["Phone/Trip", "Private/Earlier/Trip"],
        ["Phone/Other", "Private/Earlier/Other"],
        ["Phone", "Private/Earlier"],
      ]),
    );
    // Something of Phone's left: only its subfolders moved.
    expect(new Map(folderMoves(moves, [...present, "Phone/stay.jpg"])).has("Phone")).toBe(false);
    // Its folders went different ways: Phone itself didn't move anywhere.
    const split: [string, string][] = [
      ["Phone/Trip/a.jpg", "X/Trip/a.jpg"],
      ["Phone/Other/b.jpg", "Y/Other/b.jpg"],
    ];
    expect(new Map(folderMoves(split, split.map(([, b]) => b))).has("Phone")).toBe(false);
  });
});

describe("the snapshot", () => {
  it("keeps when each file was first seen, records files gone with something kept, and forgets found ones", () => {
    const a = item("a/1.jpg", 1, 1);
    const b = item("a/2.jpg", 2, 2);
    const s1 = nextSnapshot(null, [a, b], () => true, 1000);
    expect(seenIn(s1, "a/1.jpg")).toEqual([1, 1, 1000]);
    // Later: 1 edited in place (still first seen then), 2 gone with a rating, 3 new.
    const c = item("b/3.jpg", 3, 3);
    const s2 = nextSnapshot(s1, [{ ...a, size: 5 }, c], (k) => k === "a/2.jpg", 2000);
    expect(seenIn(s2, "a/1.jpg")).toEqual([5, 1, 1000]);
    expect(seenIn(s2, "b/3.jpg")).toEqual([3, 3, 2000]);
    expect(s2.gone).toEqual({ "a/2.jpg": [2, 2, 1000] });
    // Found again (or nothing kept any more): no longer gone. Still gone: its last-seen time stays.
    expect(nextSnapshot(s2, [c], () => false, 3000).gone).toEqual({});
    expect(nextSnapshot(s2, [c], () => true, 3000).gone["a/2.jpg"]).toEqual([2, 2, 1000]);
  });

  it("is only written again when what it says changed, not its time", () => {
    const s1 = nextSnapshot(null, [item("a/1.jpg", 1, 1)], () => true, 1000);
    const s2 = nextSnapshot(s1, [item("a/1.jpg", 1, 1)], () => true, 5000);
    expect(snapshotSig(s2)).toBe(snapshotSig(s1));
    expect(snapshotSig(nextSnapshot(s1, [item("a/1.jpg", 2, 1)], () => true, 5000))).not.toBe(snapshotSig(s1));
  });

  it("over several looks: a file moved while it couldn't be matched is still found later", async () => {
    // Look 1: p there. Moved, and look 2 couldn't match it (say the folder was half copied): gone.
    const p = item("old/p.jpg", 7, 7);
    const s1 = nextSnapshot(null, [p], () => true, 1000);
    const s2 = nextSnapshot(s1, [item("new/half.jpg", 1, 1)], () => true, 2000);
    expect(s2.gone["old/p.jpg"]).toEqual([7, 7, 1000]);
    // Look 3: it is there now (first seen since it went): found.
    const now = [item("new/half.jpg", 1, 1), item("new/p.jpg", 7, 7)];
    const s3 = nextSnapshot(s2, now, () => true, 3000);
    const g = s2.gone["old/p.jpg"];
    const found = await findMoves({
      orphans: new Map([["old/p.jpg", { s: g[0], m: g[1], lastSeen: g[2] }]]),
      items: now,
      taken: new Set(),
      firstSeen: (k) => seenIn(s2, k)?.[2] ?? Number.MAX_SAFE_INTEGER,
      fingerprint: async () => "?",
    });
    expect(found).toEqual([["old/p.jpg", "new/p.jpg"]]);
    expect(Object.keys(s3.files)).toContain("new");
  });

  it("stays quick with tens of thousands of files", async () => {
    const r = rng(3);
    const before: MediaItem[] = [];
    const to: Record<string, string | null> = {};
    for (let i = 0; i < 30_000; i++) {
      const it = item(`F${i % 300}/IMG_${i}.jpg`, 2_000_000 + Math.floor(r() * 50_000), 1_600_000_000_000 + Math.floor(r() * 1e10));
      before.push(it);
      if (i % 3 === 0) to[it.key] = `Moved/F${i % 300}/IMG_${i}.jpg`;
    }
    const t0 = performance.now();
    const found = await reconcile({ before, to });
    expect(performance.now() - t0).toBeLessThan(5000);
    expectExactly(found, { before, to });
  });
});

export type { Snapshot };
