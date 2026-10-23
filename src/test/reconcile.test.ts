import { describe, expect, it } from "vitest";
import { reconcile, identityOf } from "../lib/reconcile";
import type { MediaItem } from "../lib/types";

function item(key: string, size: number, modified: number): MediaItem {
  const name = key.split("/").pop()!;
  return { key, primary: "/root/" + key, files: ["/root/" + key], kind: "image", name: name.replace(/\.[^.]+$/, ""), dir: key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "", size, modified, hasRaw: false, hasVideo: false };
}

describe("reconcile ratings after files move outside the app", () => {
  it("follows a file moved to another folder by size, time and name", async () => {
    const before = item("DCIM/IMG_1.jpg", 1000, 50);
    const after = item("Trips/Iceland/IMG_1.jpg", 1000, 50);
    const r = await reconcile({ ratings: { [before.key]: 8 }, ids: { [before.key]: identityOf(before) }, viewed: { [before.key]: 123 }, items: [after, item("DCIM/other.jpg", 1000, 50)], fingerprint: async () => "x" });
    expect(r.ratings).toEqual({ "Trips/Iceland/IMG_1.jpg": 8 });
    expect(r.viewed).toEqual({ "Trips/Iceland/IMG_1.jpg": 123 });
    expect(r.moves).toEqual([["DCIM/IMG_1.jpg", "Trips/Iceland/IMG_1.jpg"]]);
  });

  it("uses the fingerprint when size, time and name are all ambiguous", async () => {
    const before = item("a/IMG_1.jpg", 1000, 50);
    const c1 = item("b/IMG_1.jpg", 1000, 50);
    const c2 = item("c/IMG_1.jpg", 1000, 50);
    const fps: Record<string, string> = { [c1.primary]: "fp-A", [c2.primary]: "fp-B" };
    const r = await reconcile({ ratings: { [before.key]: 5 }, ids: { [before.key]: { ...identityOf(before), f: "fp-B" } }, viewed: {}, items: [c1, c2], fingerprint: async (p) => fps[p] });
    expect(r.ratings).toEqual({ "c/IMG_1.jpg": 5 });
  });

  it("leaves a rating alone when nothing matches or it is ambiguous without a fingerprint", async () => {
    const before = item("a/IMG_1.jpg", 1000, 50);
    const r1 = await reconcile({ ratings: { [before.key]: 5 }, ids: { [before.key]: identityOf(before) }, viewed: {}, items: [item("b/x.jpg", 999, 50)], fingerprint: async () => "x" });
    expect(r1.ratings).toEqual({ "a/IMG_1.jpg": 5 });
    const r2 = await reconcile({ ratings: { [before.key]: 5 }, ids: { [before.key]: identityOf(before) }, viewed: {}, items: [item("b/IMG_1.jpg", 1000, 50), item("c/IMG_1.jpg", 1000, 50)], fingerprint: async () => "x" });
    expect(r2.ratings).toEqual({ "a/IMG_1.jpg": 5 });
    expect(r2.moves).toEqual([]);
  });

  it("never steals a file that already has a rating", async () => {
    const gone = item("a/IMG_1.jpg", 1000, 50);
    const rated = item("b/IMG_1.jpg", 1000, 50);
    const r = await reconcile({ ratings: { [gone.key]: 5, [rated.key]: 9 }, ids: { [gone.key]: identityOf(gone), [rated.key]: identityOf(rated) }, viewed: {}, items: [rated], fingerprint: async () => "x" });
    expect(r.ratings).toEqual({ "a/IMG_1.jpg": 5, "b/IMG_1.jpg": 9 });
  });

  it("falls back to a unique name for legacy entries without identity", async () => {
    const r = await reconcile({ ratings: { "old/IMG_7.jpg": 3 }, ids: {}, viewed: {}, items: [item("new/IMG_7.jpg", 1, 1)], fingerprint: async () => "x" });
    expect(r.ratings).toEqual({ "new/IMG_7.jpg": 3 });
  });
});
