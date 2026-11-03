import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";

const be = vi.hoisted(() => ({
  restored: [] as [string, string][][],
  links: {} as Record<string, unknown>,
}));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      versionsLoad: async () => ({ links: be.links }),
      versionRevert: async (_r: string, _l: unknown, it: MediaItem) => ({
        item: { ...it, key: "A/012.jpg", primary: "/vol/A/012.jpg", files: ["/vol/A/012.jpg"], name: "012" },
        moves: [
          ["/vol/.quire.originals/d-1/012.jpg", "/vol/A/012.jpg"],
          [it.primary, `/vol/_deleted/${it.primary.split("/").pop()}`],
        ],
      }),
      restoreFiles: async (moves: [string, string][]) => void be.restored.push(moves),
      versionInfo: async (_r: string, path: string) => ({ fp: "a-made", link: null, kept: path.includes("Cleaned") ? "/vol/.quire.originals/d-1/012.jpg" : null, original: null, versions: [] }),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { findGroups, SENSITIVITY } = await import("../lib/dupes");
const { exactCopies, madeFromKnown, sizeCandidates } = await import("../lib/filing");
const { linkedHints } = await import("../dupesStore");
const { useStore } = await import("../store");
const { revertAll } = await import("../versionsStore");
const { useJobs } = await import("../lib/jobs");

const pic = (key: string, size = 10): MediaItem => {
  const name = key.split("/").pop()!;
  return { key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: name.replace(/\.[^.]+$/, ""), dir: key.slice(0, key.lastIndexOf("/")), size, modified: 0, hasRaw: false, hasVideo: false };
};
const link = (from: string, madeAt: string, note = "cleaned") => ({ from, fromName: "012.jpg", madeAt, fromAt: "A/012.jpg", by: "demo", note, at: 0 });
const h = (hex: string) => [parseInt(hex.slice(0, 8), 16) | 0, parseInt(hex.slice(8), 16) | 0] as [number, number];

describe("versions in the duplicate check", () => {
  it("are with what they were made from outright, however they look, wherever they went", () => {
    const entries = [
      { item: pic("Elsewhere/renamed.png"), fp: "a-made", image: { phash: h("0000000000000000"), dhash: h("0000000000000000"), width: 1, height: 1 } },
      { item: pic("A/012.jpg"), fp: "d-from", image: { phash: h("ffffffffffffffff"), dhash: h("ffffffffffffffff"), width: 1, height: 1 } },
      { item: pic("A/013.jpg"), fp: "e-other", image: { phash: h("f0f0f0f0f0f0f0f0"), dhash: h("0f0f0f0f0f0f0f0f"), width: 1, height: 1 } },
    ];
    const groups = findGroups(entries as never, { ...SENSITIVITY.normal, links: [{ made: "a-made", from: "d-from", note: "edited" }] });
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.item.key).sort()).toEqual(["A/012.jpg", "Elsewhere/renamed.png"]);
    expect(groups[0].members.find((m) => m.item.key === "Elsewhere/renamed.png")!.notes).toContain("edited version of 012");
    // Badged by what they are called.
    expect(linkedHints({ "a-made": link("d-from", "A/x.png", "edited") as never }, { "Elsewhere/renamed.png": { fp: "a-made" } } as never)).toEqual([{ keys: ["Elsewhere/renamed.png"], note: "edited" }]);
  });
});

describe("Import and versions", () => {
  it("knows a picture a version was made from, kept or gone, and prefers a real copy of it", () => {
    const made = madeFromKnown({ "a-made": link("d-from", "A/Cleaned 012.png") as never });
    expect(made.known).toEqual([{ path: expect.any(String), size: 13 }]);
    const incoming = [{ path: "/card/012.jpg", size: 13, inside: false }];
    const cand = sizeCandidates(incoming as never, made.known);
    expect(cand.incoming).toEqual(["/card/012.jpg"]);
    const fp = new Map([...made.fp, ["/card/012.jpg", "d-from"]]);
    const [d] = exactCopies(incoming as never, fp, made.known);
    expect(made.versionOf.get(d.of)).toEqual({ of: "A/Cleaned 012.png", note: "cleaned" });
    // A real file with it in the library is named instead.
    fp.set("/vol/B/012.jpg", "d-from");
    expect(exactCopies(incoming as never, fp, [{ path: "/vol/B/012.jpg", size: 13 }, ...made.known])[0].of).toBe("/vol/B/012.jpg");
  });
});

describe("Revert", () => {
  beforeEach(() => {
    be.restored = [];
    const version = pic("A/Cleaned 012.png");
    useStore.setState({ root: "/vol", library: { version: 1, targets: [], ratings: { "A/Cleaned 012.png": 8 }, trashDir: "_deleted", albumRoots: [], albumRatings: {}, ids: {} } as never, queue: [pic("A/011.jpg"), version], index: 1, allItems: [version], unsorted: [version], undoStack: [], busy: false });
  });

  it("puts the original back in the version's place, its rating with it, and ⌘Z brings the version back", async () => {
    const version = useStore.getState().queue[1];
    expect(await useStore.getState().revertItem(version)).toBe(true);
    let s = useStore.getState();
    expect(s.queue.map((q) => q.key)).toEqual(["A/011.jpg", "A/012.jpg"]);
    expect(s.library!.ratings).toEqual({ "A/012.jpg": 8 });
    expect(s.unsorted.map((u) => u.key)).toEqual(["A/012.jpg"]);
    await s.undo();
    s = useStore.getState();
    // The kept original goes back out of sight first, then the version comes out of the trash.
    expect(be.restored[0].map(([orig]) => orig)).toEqual(["/vol/.quire.originals/d-1/012.jpg", "/vol/A/Cleaned 012.png"]);
    expect(s.queue.map((q) => q.key)).toEqual(["A/011.jpg", "A/Cleaned 012.png"]);
    expect(s.unsorted.map((u) => u.key)).toEqual(["A/Cleaned 012.png"]);
    expect(s.library!.ratings).toEqual({ "A/Cleaned 012.png": 8 });
  });
});

describe("Revert on a selection", () => {
  it("puts back the pictures with an original kept, as a job in Activity, and leaves the rest", async () => {
    const version = pic("A/Cleaned 012.png");
    const plain = pic("A/013.jpg");
    useStore.setState({ root: "/vol", library: { version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, ids: {} } as never, queue: [], allItems: [version, plain], unsorted: [], undoStack: [] });
    const titles: string[] = [];
    const unsub = useJobs.subscribe((st) => st.jobs.forEach((j) => titles.push(j.title)));
    expect(await revertAll([version, plain])).toBe(1);
    unsub();
    expect(titles).toContain("Reverting 2 pictures");
    expect(useStore.getState().allItems.map((i) => i.key).sort()).toEqual(["A/012.jpg", "A/013.jpg"]);
    expect(useStore.getState().undoStack).toHaveLength(1);
  });
});
