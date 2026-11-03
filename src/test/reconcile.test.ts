import { describe, expect, it } from "vitest";
import { findMoves, identityOf, type Identity } from "../lib/reconcile";
import { folderMoves, mover, rekeyRecord } from "../lib/moves";
import type { MediaItem } from "../lib/types";

function item(key: string, size: number, modified: number): MediaItem {
  const name = key.split("/").pop()!;
  return { key, primary: "/root/" + key, files: ["/root/" + key], kind: "image", name: name.replace(/\.[^.]+$/, ""), dir: key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "", size, modified, hasRaw: false, hasVideo: false };
}
const search = (orphans: Record<string, Partial<Identity> & { byName?: boolean }>, items: MediaItem[], taken: string[] = [], fps: Record<string, string> = {}) =>
  findMoves({ orphans: new Map(Object.entries(orphans)), items, taken: new Set(taken), firstSeen: () => undefined, fingerprint: async (p) => fps[p] ?? "x" });

describe("files moved outside the app are found again", () => {
  it("by size, time and name", async () => {
    const before = item("DCIM/IMG_1.jpg", 1000, 50);
    const after = item("Trips/Iceland/IMG_1.jpg", 1000, 50);
    expect(await search({ [before.key]: identityOf(before) }, [after, item("DCIM/other.jpg", 1000, 50)])).toEqual([["DCIM/IMG_1.jpg", "Trips/Iceland/IMG_1.jpg"]]);
  });

  it("by content when size, time and name are all ambiguous", async () => {
    const before = item("a/IMG_1.jpg", 1000, 50);
    const c1 = item("b/IMG_1.jpg", 1000, 50);
    const c2 = item("c/IMG_1.jpg", 1000, 50);
    expect(await search({ [before.key]: { ...identityOf(before), f: "fp-B" } }, [c1, c2], [], { [c1.primary]: "fp-A", [c2.primary]: "fp-B" })).toEqual([["a/IMG_1.jpg", "c/IMG_1.jpg"]]);
  });

  it("not when nothing matches, or it is ambiguous without a fingerprint", async () => {
    const before = item("a/IMG_1.jpg", 1000, 50);
    expect(await search({ [before.key]: identityOf(before) }, [item("b/x.jpg", 999, 50)])).toEqual([]);
    expect(await search({ [before.key]: identityOf(before) }, [item("b/IMG_1.jpg", 1000, 50), item("c/IMG_1.jpg", 1000, 50)])).toEqual([]);
  });

  it("never onto a file that has something of its own", async () => {
    const gone = item("a/IMG_1.jpg", 1000, 50);
    const rated = item("b/IMG_1.jpg", 1000, 50);
    expect(await search({ [gone.key]: identityOf(gone) }, [rated], [rated.key])).toEqual([]);
  });

  it("an old rating without size and time: only by a name unique on both sides; anything else not by name alone", async () => {
    expect(await search({ "old/IMG_7.jpg": { byName: true } }, [item("new/IMG_7.jpg", 1, 1)])).toEqual([["old/IMG_7.jpg", "new/IMG_7.jpg"]]);
    expect(await search({ "old/IMG_7.jpg": { byName: true }, "other/IMG_7.jpg": { byName: true } }, [item("new/IMG_7.jpg", 1, 1)])).toEqual([]);
    expect(await search({ "old/IMG_7.jpg": {} }, [item("new/IMG_7.jpg", 1, 1)])).toEqual([]);
  });
});

describe("keys follow moved files and folders", () => {
  it("a file, or a folder with everything under it, never a folder that only starts the same", () => {
    const move = mover([["Albums/Trip", "Albums/Iceland 2024"], ["DCIM/a.jpg", "Sorted/a.jpg"]]);
    expect(move("Albums/Trip")).toBe("Albums/Iceland 2024");
    expect(move("Albums/Trip/p01.jpg")).toBe("Albums/Iceland 2024/p01.jpg");
    expect(move("Albums/Trip 2/p01.jpg")).toBeNull();
    expect(move("DCIM/a.jpg")).toBe("Sorted/a.jpg");
    expect(move("DCIM/b.jpg")).toBeNull();
  });

  it("a record keeps what is already at the new key, and swapped keys swap", () => {
    expect(rekeyRecord({ a: 1, b: 2 }, mover([["c", "d"]]))).toBeNull();
    expect(rekeyRecord({ a: 1, b: 2 }, mover([["a", "b"]]))).toEqual({ b: 2 });
    expect(rekeyRecord({ a: 1, b: 2 }, mover([["a", "b"], ["b", "a"]]))).toEqual({ b: 1, a: 2 });
  });

  it("a folder moved whole is read from its files, unless something stayed behind", () => {
    const moves: [string, string][] = [["Albums/Trip/p1.jpg", "Albums/Iceland/p1.jpg"], ["Albums/Trip/p2.jpg", "Albums/Iceland/p2.jpg"], ["DCIM/x.jpg", "Sorted/x.jpg"]];
    expect(folderMoves(moves, ["Albums/Iceland/p1.jpg", "Albums/Iceland/p2.jpg", "Sorted/x.jpg", "DCIM/y.jpg"])).toEqual([["Albums/Trip", "Albums/Iceland"]]);
    // Split up between two folders: not a folder move.
    expect(folderMoves([["A/1.jpg", "B/1.jpg"], ["A/2.jpg", "C/2.jpg"]], [])).toEqual([]);
  });
});
