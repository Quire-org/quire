import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IndexedItem, IndexModels, IndexProgress, MediaItem, TagData } from "../lib/types";

// The backend: one index, its pictures' vectors, and the anime tagger's words once it has looked (it
// is optional: an index made without it takes it on in place). Tags live in their own file: `saved`.
const be = vi.hoisted(() => ({
  saved: null as unknown,
  current: { embedder: "", tagger: "", indexed: {} as Record<string, { s: number; m: number }>, auto: {} as Record<string, [number, number][]> },
  /** The models downloaded. */
  downloaded: ["siglip2"] as string[],
  runs: [] as { keys: string[]; tag: boolean; models: unknown; remembered: unknown }[],
  unreadable: new Set<string>(),
  stopAfter: Infinity,
  names: [] as string[],
  cands: [] as { key: string; p: number; examples: boolean }[],
}));
vi.mock("../lib/api", () => ({
  api: {
    loadTags: vi.fn(async () => be.saved),
    saveTags: vi.fn(async (_r: string, data: unknown) => void (be.saved = data)),
    tagsTagNames: vi.fn(async (tagger: string) => (be.names.push(tagger), [{ name: `${tagger}-word`, category: 0 }])),
    tagsIndexLoad: vi.fn(async () => ({ ...be.current, embedded: Object.keys(be.current.indexed).length })),
    tagsIndexRename: vi.fn(async () => {}),
    tagsIndex: vi.fn(async (_root: string, items: MediaItem[], _e: boolean, tag: boolean, models: IndexModels, onProgress: (p: IndexProgress) => void, onItem: (r: IndexedItem) => void) => {
      be.runs.push({ keys: items.map((i) => i.key), tag, models, remembered: (be.saved as TagData | null)?.resumeIndex ?? null });
      // As the backend: an empty index takes the matcher, the tagger joins when a run brings it.
      be.current.embedder ||= models.embedder;
      if (tag) be.current.tagger ||= models.tagger;
      let done = 0;
      for (const it of items) {
        if (done >= be.stopAfter) break;
        onProgress({ done, total: items.length, current: it.name, key: it.key });
        if (be.unreadable.has(it.key)) onItem({ key: it.key, embedding: null, tags: null, error: "not an image Quire can index" });
        else {
          be.current.indexed[it.key] = { s: it.size, m: it.modified };
          if (tag) be.current.auto[it.key] = [[0, 0.9]];
          onItem({ key: it.key, embedding: null, tags: tag ? [[0, 0.9]] : null, error: null });
        }
        done++;
      }
      return done;
    }),
    tagsPredict: vi.fn(async () => []),
    tagsCandidates: vi.fn(async () => be.cands),
    tagsCancel: vi.fn(async () => {}),
    tagsPause: vi.fn(async () => {}),
    scanDir: vi.fn(async () => []),
    engineModels: vi.fn(async () => catalog()),
    engineStoreGet: vi.fn(async () => null),
  },
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  pickFolder: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
/** The engine's list of models, as it is with `be.downloaded`. */
function catalog() {
  return { available: true, used: 0, chosen: "", downloading: false, models: [["siglip2", "embedder"], ["pixai", "tagger"]].map(([id, kind]) => ({ id, kind: kind as "embedder" | "tagger", name: id, note: "", size: 1, downloaded: be.downloaded.includes(id) })) };
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { useStore } = await import("../store");
const { useTags, contextBoost, withContext, inOrder, telling } = await import("../tagsStore");
const { useEngine } = await import("../plugins/engine");

const item = (n: number, dir = "Pics"): MediaItem => ({ key: `${dir}/p${n}.jpg`, primary: `/vol/${dir}/p${n}.jpg`, files: [], kind: "image", name: `p${n}`, dir, size: 10 + n, modified: n, hasRaw: false, hasVideo: false }) as MediaItem;
const library = Array.from({ length: 8 }, (_, i) => item(i + 1));
// Tags on most of them, as they are before anything is remade.
const tags: TagData["tags"] = { "": ["motives/empty"], "Pics/p1.jpg": ["motives/cat", "time/night"], "Pics/p2.jpg": ["motives/cat"], "Pics/p5.jpg": ["people/grandma"], "album:A": ["series/one"] };

async function open(indexed = false) {
  // Indexed already (with the matcher alone), or not at all.
  be.current = indexed
    ? { embedder: "siglip2", tagger: "", indexed: Object.fromEntries(library.map((it) => [it.key, { s: it.size, m: it.modified }])), auto: {} }
    : { embedder: "", tagger: "", indexed: {}, auto: {} };
  be.downloaded = ["siglip2"];
  be.runs = [];
  be.unreadable = new Set();
  be.stopAfter = Infinity;
  be.names = [];
  be.saved = { version: 1, types: ["motives", "time", "people", "series"], tags, autoMap: { cat_ears: "motives/cat" }, albums: {}, denied: { "motives/cat": ["Pics/p3.jpg"] } };
  useStore.setState({ root: "/vol", screen: "tags", allItems: library, albums: [], queue: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
  useEngine.setState({ catalog: null, needed: [] });
  useTags.setState({ loaded: false, data: null, models: null, target: null, indexing: null, names: null, mode: "images" });
  await useTags.getState().load();
  await useTags.getState().refreshTarget();
}

describe("the tag index", () => {
  it("is made with the picture and word matcher alone: the anime tagger is optional", async () => {
    await open();
    expect(useTags.getState().target).toEqual({ embedder: "siglip2", tagger: "" });
    expect((await useTags.getState().pending("images")).length).toBe(8);
    await useTags.getState().startIndex();
    // Pictures, crops on, the tagger not asked for.
    expect(be.runs.map((r) => [r.tag, r.models])).toEqual([[false, { embedder: "siglip2", tagger: "", parts: true, drawnOnly: true, paused: false }]]);
    // Remembered with the tags while it went (a restart would carry on with it), and not after.
    expect(be.runs[0].remembered).toEqual({ paused: false });
    await useTags.getState().flush();
    expect((be.saved as TagData).resumeIndex).toBeUndefined();
    expect(useTags.getState().models).toEqual({ embedder: "siglip2", tagger: "" });
    expect(useTags.getState().data!.auto).toEqual({});
    expect(be.names).toEqual([]);
    expect(await useTags.getState().pending("images")).toEqual([]);
  });

  it("takes on the anime tagger when it is downloaded: what is indexed is looked at again by itself, every tag as it was", async () => {
    await open(true);
    const before = JSON.stringify((be.saved as TagData).tags);
    expect(await useTags.getState().pending("images")).toEqual([]);
    // Downloaded in Local models: a job goes through the pictures (and albums) the tagger hasn't seen.
    be.downloaded = ["siglip2", "pixai"];
    await act(async () => useEngine.setState({ catalog: catalog() }));
    await vi.waitFor(() => expect(be.runs.length).toBe(1));
    await vi.waitFor(() => expect(useTags.getState().indexing).toBeNull());
    expect(be.runs[0]).toMatchObject({ tag: true, models: { embedder: "siglip2", tagger: "pixai" } });
    expect(be.runs[0].keys).toHaveLength(8);
    // Into the same index: its words show, under the tagger's names.
    expect(useTags.getState().models).toEqual({ embedder: "siglip2", tagger: "pixai" });
    expect(Object.keys(useTags.getState().data!.auto)).toHaveLength(8);
    await vi.waitFor(() => expect(be.names).toContain("pixai"));
    // Not one tag moved, in memory or on disk; turned-down suggestions and tagger links too.
    expect(JSON.stringify(useTags.getState().data!.tags)).toBe(before);
    await useTags.getState().flush();
    expect(JSON.stringify((be.saved as TagData).tags)).toBe(before);
    expect((be.saved as TagData).denied).toEqual({ "motives/cat": ["Pics/p3.jpg"] });
    expect((be.saved as TagData).autoMap).toEqual({ cat_ears: "motives/cat" });
    expect(await useTags.getState().pending("images")).toEqual([]);
    // Removed again: new pictures are indexed without it, and its words stay on the others.
    be.downloaded = ["siglip2"];
    await act(async () => useEngine.setState({ catalog: catalog() }));
    await useTags.getState().refreshTarget();
    useStore.setState({ allItems: [...library, item(9)] } as never);
    await useTags.getState().startIndex();
    expect(be.runs[be.runs.length - 1]).toMatchObject({ tag: false, keys: ["Pics/p9.jpg"] });
    expect(Object.keys(useTags.getState().data!.auto)).toHaveLength(8);
    useStore.setState({ allItems: library } as never);
  });

  it("carries on where a stopped run left off", async () => {
    await open();
    be.stopAfter = 3;
    await useTags.getState().startIndex();
    be.stopAfter = Infinity;
    await useTags.getState().startIndex();
    expect(be.runs[1].keys).toEqual(library.slice(3).map((i) => i.key));
  });

  it("asks for the picture and word matcher when it isn't downloaded", async () => {
    await open();
    be.downloaded = [];
    useEngine.setState({ catalog: catalog() });
    await useTags.getState().refreshTarget();
    expect(useTags.getState().target).toBeNull();
    await useTags.getState().startIndex();
    expect(be.runs).toEqual([]);
    expect(useEngine.getState().needed).toEqual(["siglip2"]);
  });

  it("carries on after a restart, held if it was, without visiting Tags", async () => {
    await open();
    // The app was killed while a paused run was going: the tags say so.
    be.saved = { ...(be.saved as TagData), resumeIndex: { paused: true } };
    be.runs = [];
    useTags.setState({ loaded: false, data: null, indexing: null });
    await act(async () => useStore.setState({ root: "/vol2" } as never));
    await vi.waitFor(() => expect(be.runs.length).toBe(1));
    expect(be.runs[0].models).toMatchObject({ paused: true });
    await vi.waitFor(() => expect(useTags.getState().indexing).toBeNull());
    await useTags.getState().flush();
    expect((be.saved as TagData).resumeIndex).toBeUndefined();
    await act(async () => useStore.setState({ root: "/vol" } as never));
  });

  it("can index without crops", async () => {
    await open();
    useTags.getState().setLookCloser(false);
    await useTags.getState().startIndex();
    expect(be.runs[0].models).toMatchObject({ parts: false });
    await useTags.getState().flush();
    expect((be.saved as TagData).lookCloser).toBe(false);
  });
});

describe("what's around a picture nudges a suggestion", () => {
  const d = (t: TagData["tags"]): TagData => ({ version: 1, types: [], tags: t, auto: {}, indexed: {}, autoMap: {}, albums: {} });

  it("its folder: most of the others there carry the tag", () => {
    useStore.setState({ allItems: [...Array.from({ length: 6 }, (_, i) => item(i + 1, "2024/2024-07-12 Beach")), ...Array.from({ length: 4 }, (_, i) => item(i + 1, "2024/2024-08-01"))] } as never);
    const beach = Object.fromEntries([1, 2, 3, 4].map((n) => [`2024/2024-07-12 Beach/p${n}.jpg`, ["places/beach"]]));
    const data = d(beach);
    const near = contextBoost(data, "places/beach", "2024/2024-07-12 Beach/p6.jpg");
    expect(near.boost).toBeGreaterThan(0.8);
    expect(near.note).toBe("4 of 5 in its folder have it");
    // Another day's folder, where nothing has it: held back a little.
    expect(contextBoost(data, "places/beach", "2024/2024-08-01/p2.jpg").boost).toBeLessThan(0);
  });

  it("a tag it carries that this one usually goes with", () => {
    useStore.setState({ allItems: Array.from({ length: 12 }, (_, i) => item(i + 1, `d${i}`)) } as never);
    const t: TagData["tags"] = {};
    for (let n = 1; n <= 5; n++) t[`d${n - 1}/p${n}.jpg`] = ["motives/snow", "seasons/winter"];
    t["d5/p6.jpg"] = ["motives/snow"];
    for (let n = 7; n <= 11; n++) t[`d${n - 1}/p${n}.jpg`] = ["motives/cat"];
    const data = d(t);
    const withSnow = contextBoost(data, "seasons/winter", "d5/p6.jpg");
    expect(withSnow.boost).toBeGreaterThan(0.5);
    expect(withSnow.note).toBe("usually goes with snow");
    expect(contextBoost(data, "seasons/winter", "d6/p7.jpg").boost).toBe(0);
  });

  it("never suggests on its own: only where the picture already speaks for it a little", () => {
    expect(withContext(0.1, 2.5)).toBe(0.1);
    expect(withContext(0.4, 2)).toBeGreaterThan(0.8);
    expect(withContext(0.6, -0.5)).toBeLessThan(0.6);
  });
});

describe("a tag's suggestions", () => {
  it("can show the ones it is least sure of first", () => {
    const list = [{ key: "a", score: 0.97 }, { key: "b", score: 0.35 }, { key: "c", score: 0.52 }, { key: "d", score: 0.8 }];
    expect(inOrder(list, "likely").map((x) => x.key)).toEqual(["a", "d", "c", "b"]);
    expect(inOrder(list, "unsure").map((x) => x.key)).toEqual(["c", "b", "d", "a"]);
  });
});

describe("the tagger's words offered as tags", () => {
  it("leaves out words on most of what it looked at (comic on every manga page), and ones turned away", async () => {
    await open();
    // 30 manga pages (the tagger looked) and 30 photos (it didn't): comic on all pages, monochrome on most, Hu Tao on a few.
    const auto: TagData["auto"] = {};
    for (let n = 1; n <= 30; n++) {
      auto[`Pics/m${n}.jpg`] = [[0, 0.95], ...(n <= 25 ? ([[2, 0.8]] as [number, number][]) : []), ...(n <= 4 ? ([[1, 0.9]] as [number, number][]) : [])];
      auto[`Pics/ph${n}.jpg`] = [];
    }
    useTags.setState({ data: { ...useTags.getState().data!, auto, autoMap: {} }, names: [{ name: "comic", category: 0 }, { name: "hu_tao_(genshin_impact)", category: 4 }, { name: "monochrome", category: 0 }] });
    const d = () => useTags.getState().data!;
    expect(telling(d(), 0)).toBe(0);
    expect(telling(d(), 2)).toBe(0);
    expect(telling(d(), 1)).toBeCloseTo(26 / 30);
    expect(useTags.getState().suggestedAuto("images").map((w) => w.name)).toEqual(["hu_tao_(genshin_impact)"]);
    // On a page itself: Hu Tao is offered as a new tag, comic and monochrome aren't.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { TagEditor } = await import("../components/TagPicker");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(TagEditor, { keys: ["Pics/m1.jpg"] })));
    const offered = () => Array.from(host.querySelectorAll(".chip.suggest.new")).map((b) => b.textContent?.replace(/\s+/g, " ").trim());
    expect(offered()).toEqual(["hu tao (genshin impact) new"]);
    // Right-click: never offered again, here or on the board.
    await act(async () => host.querySelector(".chip.suggest.new")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    expect(offered()).toEqual([]);
    expect(useTags.getState().suggestedAuto("images")).toEqual([]);
    await useTags.getState().flush();
    expect((be.saved as TagData).ignoredWords).toEqual(["hu_tao_(genshin_impact)"]);
    root.unmount();
  });
});
