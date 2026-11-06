import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../lib/types";

const be = vi.hoisted(() => ({ restored: [] as [string, string][][], saved: [] as unknown[] }));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      moveItem: async (_r: string, it: MediaItem, dest: string) => {
        const name = it.primary.split("/").pop()!;
        const primary = `/vol/${dest}/${name}`;
        return { moved: [[it.primary, primary]], item: { ...it, key: `${dest}/${name}`, primary, files: [primary], dir: dest } };
      },
      restoreFiles: async (moves: [string, string][]) => void be.restored.push(moves),
      trashItem: async (_r: string, _l: unknown, it: MediaItem) => {
        const primary = `/vol/_deleted/${it.primary.split("/").pop()}`;
        return { moved: [[it.primary, primary]], item: { ...it, key: primary.slice(5), primary, files: [primary] } };
      },
      emptyTrash: async () => 1,
      saveLibrary: async (_r: string, lib: unknown) => void be.saved.push(lib),
      versionsLoad: async () => ({ links: {} }),
      fileFingerprint: async (p: string) => `fp-${p}`,
      imageHash: async () => ({ phash: "0000000000000000", quads: ["0", "0", "0", "0"].map(() => "0000000000000000"), dhash: "0000000000000000", width: 1, height: 1 }),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));
(globalThis as Record<string, unknown>).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { joined, without, together, stacks, lookAlikes, seriesIndex, pairKey } = await import("../lib/series");
const { useStore, followMoves } = await import("../store");
const { useDupes, withoutIgnored } = await import("../dupesStore");
const { SeriesStrip } = await import("../components/SeriesStrip");
const { lookForSeries, openSeriesAdd, useSeriesAdd } = await import("../seriesStore");
const { SeriesAddDialog } = await import("../components/SeriesAdd");
const { useJobs } = await import("../lib/jobs");

const pic = (key: string): MediaItem => {
  const name = key.split("/").pop()!;
  return { key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: name.replace(/\.[^.]+$/, ""), dir: key.slice(0, key.lastIndexOf("/")), size: 10, modified: 0, hasRaw: false, hasVideo: false };
};
const sig = (phash: string, fp: string) => ({ size: 10, modified: 0, fp, image: { phash, quads: [phash, phash, phash, phash], dhash: phash, width: 1, height: 1 } });
const library = (patch = {}) => ({ version: 1, targets: [{ id: "t1", name: "Family", path: "Family", hotkey: "1" }], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, ids: {}, ...patch }) as never;

// Moves reach Tags and the rest through later imports: done before the test's world goes.
afterAll(() => vi.dynamicImportSettled());

describe("series, as kept", () => {
  it("are joined with the series their pictures are in, and a picture left alone is none", () => {
    const one = joined([["a", "b"], ["x", "y"]], ["c", "b"]);
    expect(one).toEqual([["x", "y"], ["c", "b", "a"]]);
    expect(without(one, ["c", "b"])).toEqual([["x", "y"]]);
  });

  it("come up whole where their first picture comes, and are one tile with the rest behind", () => {
    const items = ["p1", "s2", "p2", "s1", "p3"].map((key) => ({ key }));
    const index = seriesIndex([["s1", "s2"]]);
    expect(together(items, index).map((i) => i.key)).toEqual(["p1", "s1", "s2", "p2", "p3"]);
    expect(stacks(items, index).map((t) => t.members.map((m) => m.key))).toEqual([["p1"], ["s1", "s2"], ["p2"], ["p3"]]);
  });

  it("are suggested by look-alikes at any time, closest first: no exact copies, no pairs turned down", () => {
    const cache = {
      cur: sig("0000000000000000", "fp-cur"),
      near: sig("0000000000000001", "fp-near"),
      nearer: sig("0000000000000000", "fp-nearer"),
      copy: sig("0000000000000000", "fp-cur"),
      far: sig("ffffffffffffffff", "fp-far"),
      no: sig("0000000000000003", "fp-no"),
    };
    const not = new Set([pairKey("cur", "no")]);
    expect(lookAlikes("cur", Object.keys(cache), cache, (a, b) => not.has(pairKey(a, b)))).toEqual(["nearer", "near"]);
    // As alike: the one made nearer in time first.
    const twins = { cur: { ...sig("0000000000000000", "a"), modified: 1000 }, later: { ...sig("0000000000000001", "b"), modified: 900_000 }, soon: { ...sig("0000000000000003", "c"), modified: 2000 }, sooner: { ...sig("0000000000000001", "d"), modified: 1500 } };
    expect(lookAlikes("cur", Object.keys(twins), twins, () => false)).toEqual(["sooner", "later", "soon"]);
  });
});

describe("series in Sort", () => {
  beforeEach(() => {
    be.restored = [];
    const items = [pic("in/a.jpg"), pic("in/b.jpg"), pic("in/c.jpg"), pic("in/d.jpg")];
    useStore.setState({ root: "/vol", library: library(), unsorted: items, allItems: items, queue: items, index: 0, source: { kind: "unsorted" }, undoStack: [], busy: false, seriesTogether: true, screen: "viewer", editMode: false, hudHidden: false });
  });

  it("are made from the picture on show: the rest follow it, one key files all of it, and ⌘Z brings all of it back", async () => {
    useStore.getState().makeSeries(["in/a.jpg", "in/c.jpg"]);
    let s = useStore.getState();
    expect(s.library!.series).toEqual([["in/a.jpg", "in/c.jpg"]]);
    expect(s.queue.map((q) => q.key)).toEqual(["in/a.jpg", "in/c.jpg", "in/b.jpg", "in/d.jpg"]);
    await s.moveCurrent("t1");
    s = useStore.getState();
    expect(s.queue.map((q) => q.key)).toEqual(["in/b.jpg", "in/d.jpg"]);
    expect(s.library!.series).toEqual([["Family/a.jpg", "Family/c.jpg"]]);
    await s.undo();
    s = useStore.getState();
    expect(be.restored).toHaveLength(2);
    expect(s.queue.map((q) => q.key)).toEqual(["in/a.jpg", "in/c.jpg", "in/b.jpg", "in/d.jpg"]);
    expect(s.undoStack).toHaveLength(0);
  });

  it("keep a deleted picture's place for Undo, and lose it once the trash is emptied", async () => {
    useStore.getState().makeSeries(["in/a.jpg", "in/b.jpg", "in/c.jpg"]);
    await useStore.getState().trashCurrent();
    expect(useStore.getState().library!.series).toEqual([["_deleted/a.jpg", "in/b.jpg", "in/c.jpg"]]);
    await useStore.getState().undo();
    await vi.dynamicImportSettled();
    expect(useStore.getState().library!.series).toEqual([["in/a.jpg", "in/b.jpg", "in/c.jpg"]]);
    await useStore.getState().trashCurrent();
    await useStore.getState().emptyTrash();
    expect(useStore.getState().library!.series).toEqual([["in/b.jpg", "in/c.jpg"]]);
  });

  it("apart, each picture goes on its own", async () => {
    useStore.getState().makeSeries(["in/a.jpg", "in/c.jpg"]);
    useStore.setState({ seriesTogether: false });
    await useStore.getState().moveCurrent("t1");
    expect(useStore.getState().queue.map((q) => q.key)).toEqual(["in/c.jpg", "in/b.jpg", "in/d.jpg"]);
  });

  it("open together in the sort queue, and follow their pictures when they move elsewhere", () => {
    useStore.setState({ library: library({ series: [["in/b.jpg", "in/d.jpg"]], seriesNot: ["in/a.jpg|in/c.jpg"] }) });
    useStore.getState().openSortQueue();
    expect(useStore.getState().queue.map((q) => q.key)).toEqual(["in/a.jpg", "in/b.jpg", "in/d.jpg", "in/c.jpg"]);
    followMoves([["in", "Moved"]]);
    expect(useStore.getState().library!.series).toEqual([["Moved/b.jpg", "Moved/d.jpg"]]);
    expect(useStore.getState().library!.seriesNot).toEqual(["Moved/a.jpg|Moved/c.jpg"]);
  });

  it("are suggested under the picture on show: a picture left out with a click, or none of them again", async () => {
    useDupes.setState({ cacheRoot: "/vol", running: false, cache: { "in/a.jpg": sig("0000000000000000", "1"), "in/b.jpg": sig("0000000000000001", "2"), "in/c.jpg": sig("0000000000000003", "3"), "in/d.jpg": sig("ffffffffffffffff", "4") } as never });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(SeriesStrip)));
    expect(host.querySelectorAll(".series-mini")).toHaveLength(3);
    // c left out, then kept: a and b are a series, and c goes on.
    await act(async () => (host.querySelectorAll("button.series-mini")[1] as HTMLButtonElement).click());
    const keep = () => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("as a series")) as HTMLButtonElement;
    expect(keep().textContent).toContain("Keep 2 as a series");
    await act(async () => keep().click());
    expect(useStore.getState().library!.series).toEqual([["in/a.jpg", "in/b.jpg"]]);
    // c, left out, isn't suggested with them again.
    expect(useStore.getState().library!.seriesNot).toEqual([pairKey("in/a.jpg", "in/c.jpg"), pairKey("in/b.jpg", "in/c.jpg")]);
    expect(host.querySelector(".series-strip")).toBeNull();
    // Taken apart again, b has a and c alike; turned down, they aren't suggested with it again.
    await act(async () => useStore.setState({ library: library(), index: 1 }));
    expect(useStore.getState().queue[1].key).toBe("in/b.jpg");
    expect(host.querySelectorAll(".series-mini")).toHaveLength(3);
    await act(async () => (Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Not a series")) as HTMLButtonElement).click());
    expect(useStore.getState().library!.seriesNot).toEqual([pairKey("in/a.jpg", "in/b.jpg"), pairKey("in/b.jpg", "in/c.jpg")]);
    expect(host.querySelector(".series-strip")).toBeNull();
    root.unmount();
  });
});

describe("adding to a series", () => {
  it("suggests the library's look-alikes, unticked; the ones ticked join it", async () => {
    const items = ["in/a.jpg", "in/b.jpg", "in/c.jpg", "in/d.jpg", "in/e.jpg"].map(pic);
    useStore.setState({ root: "/vol", allItems: items, loadAll: async () => items, library: library({ series: [["in/a.jpg", "in/b.jpg"]], seriesNot: [pairKey("in/a.jpg", "in/e.jpg")] }) } as never);
    // c and e look like a; d doesn't; e was said not to be with a.
    useDupes.setState({ cacheRoot: "/vol", running: false, loadCache: async () => {}, cache: { "in/a.jpg": sig("0000000000000000", "1"), "in/b.jpg": sig("0000000000000001", "2"), "in/c.jpg": sig("0000000000000003", "3"), "in/d.jpg": sig("ffffffffffffffff", "4"), "in/e.jpg": sig("0000000000000001", "5") } } as never);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(SeriesAddDialog)));
    await act(async () => openSeriesAdd("in/b.jpg"));
    // The dialog shows over everything (on the page, not in the host).
    const picks = () => Array.from(document.querySelectorAll<HTMLElement>(".series-add-grid .thumb"));
    expect(picks().map((b) => b.title)).toEqual(["/vol/in/c.jpg"]);
    expect(document.querySelectorAll(".series-add-grid .thumb.selected")).toHaveLength(0);
    await act(async () => picks()[0].click());
    expect(document.querySelectorAll(".series-add-grid .thumb.selected")).toHaveLength(1);
    await act(async () => (Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("to the series")) as HTMLButtonElement).click());
    expect(useStore.getState().library!.series).toEqual([["in/a.jpg", "in/b.jpg", "in/c.jpg"]]);
    expect(useSeriesAdd.getState().of).toBeNull();
    root.unmount();
    host.remove();
  });
});

describe("looking for series", () => {
  it("looks at the pictures waiting in Sort once, in Activity, into the duplicate check's cache", async () => {
    useStore.setState({ root: "/vol" });
    useDupes.setState({ cacheRoot: "/vol", running: false, cache: {} as never, loadCache: async () => {} } as never);
    const titles: string[] = [];
    const unsub = useJobs.subscribe((st) => st.jobs.forEach((j) => titles.push(j.title)));
    await lookForSeries([pic("in/a.jpg"), { ...pic("in/v.mp4"), kind: "video" }]);
    unsub();
    expect(titles).toContain("Looking for series");
    expect(Object.keys(useDupes.getState().cache)).toEqual(["in/a.jpg"]);
    expect(useDupes.getState().cache["in/a.jpg"]).toMatchObject({ fp: "fp-/vol/in/a.jpg", image: { phash: "0000000000000000" } });
  });
});

describe("series in Duplicates", () => {
  it("are no duplicates: a group that is one series isn't shown, one with others is", () => {
    useStore.setState({ library: library({ series: [["a.jpg", "b.jpg"]] }) });
    const member = (key: string) => ({ item: pic(key), notes: [] });
    const groups = [
      { id: "g1", kind: "image", members: [member("a.jpg"), member("b.jpg")] },
      { id: "g2", kind: "image", members: [member("a.jpg"), member("b.jpg"), member("c.jpg")] },
    ];
    expect(withoutIgnored(groups as never, [], () => undefined).map((g) => g.id)).toEqual(["g2"]);
  });
});
