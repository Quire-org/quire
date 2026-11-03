import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem, TagData } from "../lib/types";

// The backend's tag index answers: everything indexed is "near" everything (the rules are what's tested).
const rank = vi.hoisted(() => ({ chances: [] as { tag: string; p: number; examples: boolean }[], cands: [] as { key: string; p: number; examples: boolean }[], saved: null as unknown }));
vi.mock("../lib/api", () => ({
  api: {
    loadTags: vi.fn(async () => rank.saved),
    saveTags: vi.fn(async () => {}),
    tagsTagNames: vi.fn(async () => [{ name: "sun", category: 0 }, { name: "sky", category: 0 }, { name: "cat", category: 0 }, { name: "general", category: 9 }]),
    tagsEmbedText: vi.fn(async () => Array.from({ length: 4 }, () => 0)),
    tagsIndexLoad: vi.fn(async () => ({ auto: {}, indexed: {}, embedded: 0, embedder: "siglip2", tagger: "pixai", next: null })),
    tagsIndexRename: vi.fn(async () => {}),
    // What the backend learned: every tag in `chances` for whatever is asked about; `cands` for a tag's own list.
    tagsPredict: vi.fn(async () => rank.chances),
    tagsCandidates: vi.fn(async (_r: string, _t: string, _a: boolean, skip: string[]) => rank.cands.filter((c) => !skip.includes(c.key))),
    tagsScores: vi.fn(async () => []),
    scanDir: vi.fn(async () => []),
  },
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  pickFolder: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { useStore } = await import("../store");
const { useTags, conflictsOf } = await import("../tagsStore");
const { Tags } = await import("../screens/Tags");

const key = (n: number) => `Pics/p${n}.jpg`;
const item = (n: number): MediaItem => ({ key: key(n), primary: `/vol/${key(n)}`, files: [`/vol/${key(n)}`], kind: "image", name: `p${n}`, dir: "Pics", size: 1, modified: 0, hasRaw: false, hasVideo: false }) as MediaItem;
const base = (patch: Partial<TagData> = {}): TagData => ({ version: 1, types: ["time", "weather", "motives"], tags: {}, auto: {}, indexed: {}, autoMap: {}, albums: {}, ...patch });
const tags = () => useTags.getState().data!.tags;

function reset(patch: Partial<TagData> = {}, n = 6) {
  const indexed = Object.fromEntries(Array.from({ length: n }, (_, i) => [key(i + 1), { s: 1, m: 0 }]));
  rank.saved = base({ indexed, ...patch });
  useStore.setState({ root: "/vol", screen: "tags", allItems: Array.from({ length: n }, (_, i) => item(i + 1)), albums: [], queue: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
  useTags.setState({ data: base({ indexed, ...patch }), loaded: true, mode: "images", filter: "overview", selected: new Set(), names: null, models: { embedder: "siglip2", tagger: "pixai" } });
}

describe("subtags", () => {
  it("a subtag brings its parent along, taking the parent off takes the subtag, and the tree moves and survives as one", () => {
    reset({ tags: { [key(1)]: ["motives/kitten"], [key(2)]: ["motives/cat"], [key(3)]: ["motives/animal"] } });
    const t = () => useTags.getState();
    t().setParent("motives/kitten", "motives/cat");
    expect(tags()[key(1)]).toEqual(["motives/kitten", "motives/cat"]); // what carried it now carries the parent
    t().setParent("motives/cat", "motives/animal");
    expect(tags()[key(1)]).toEqual(["motives/kitten", "motives/cat", "motives/animal"]);
    expect(tags()[key(2)]).toEqual(["motives/cat", "motives/animal"]);
    // Not the other way round, and no loops.
    expect(tags()[key(3)]).toEqual(["motives/animal"]);
    t().setParent("motives/animal", "motives/kitten");
    expect(useTags.getState().data!.parents!["motives/animal"]).toBeUndefined();
    // Tagging a subtag tags its parents; taking a parent off takes its subtags; a subtag off keeps the parent.
    t().setTag([key(4)], "motives/kitten", true);
    expect(tags()[key(4)]).toEqual(["motives/animal", "motives/cat", "motives/kitten"]);
    t().setTag([key(4)], "motives/kitten", false);
    expect(tags()[key(4)]).toEqual(["motives/animal", "motives/cat"]);
    t().setTag([key(4)], "motives/kitten", true);
    t().setTag([key(4)], "motives/cat", false);
    expect(tags()[key(4)]).toEqual(["motives/animal"]);
    // Moving a tag moves its subtags; it is a top tag there.
    t().moveTag("motives/cat", "pets");
    const d = useTags.getState().data!;
    expect(d.parents).toEqual({ "pets/kitten": "pets/cat" });
    expect(tags()[key(1)]).toEqual(["pets/kitten", "pets/cat", "motives/animal"]);
    // Under a tag in another folder: moved there with its own subtags.
    t().setParent("pets/cat", "motives/animal");
    expect(useTags.getState().data!.parents).toEqual({ "motives/kitten": "motives/cat", "motives/cat": "motives/animal" });
    // Deleting a parent leaves its subtags, one level up.
    t().removeTag("motives/cat");
    expect(useTags.getState().data!.parents).toEqual({ "motives/kitten": "motives/animal" });
    expect(tags()[key(1)]).toEqual(["motives/kitten", "motives/animal"]);
    // Made a top tag again, the things keep the parent they had.
    t().setParent("motives/kitten", null);
    expect(useTags.getState().data!.parents).toEqual({});
    expect(tags()[key(1)]).toEqual(["motives/kitten", "motives/animal"]);
  });

  it("in a “pick one” folder a branch is one pick: midnight brings night, day replaces both, and its opposites count", async () => {
    reset({ tags: { [key(1)]: ["time/day"], [key(2)]: ["time/night"], [key(3)]: ["time/night"] }, exclusive: ["time"] });
    const t = () => useTags.getState();
    t().addTag("time/midnight");
    t().setParent("time/midnight", "time/night");
    t().setTag([key(1)], "time/midnight", true);
    expect(tags()[key(1)]).toEqual(["time/night", "time/midnight"]);
    expect(conflictsOf(useTags.getState().data!, "time")).toEqual([]);
    t().setTag([key(1)], "time/day", true);
    expect(tags()[key(1)]).toEqual(["time/day"]);
    // A night picture may get midnight suggested; a day one may not, by the folder or by an opposite of night.
    rank.chances = [{ tag: "time/midnight", p: 0.9, examples: true }];
    t().setTag([key(6)], "time/midnight", true);
    const suggested = async (k: string) => (await t().suggest([k])).map((s) => s.tag);
    expect(await suggested(key(2))).toContain("time/midnight");
    expect(await suggested(key(1))).not.toContain("time/midnight");
    t().setExclusive("time", false);
    expect(await suggested(key(1))).toContain("time/midnight");
    t().setApart("time/day", "time/night", true);
    expect(await suggested(key(1))).not.toContain("time/midnight");
    rank.chances = [];
  });

  it("often together leaves out a tag's own parents and subtags; tagger words are found however rare", () => {
    reset({ tags: { [key(1)]: ["motives/cat", "motives/kitten"], [key(2)]: ["motives/cat", "motives/kitten"] }, parents: { "motives/kitten": "motives/cat" }, auto: { [key(1)]: [[0, 0.9]], [key(2)]: [[0, 0.9], [1, 0.8]], [key(3)]: [[0, 0.9]] } });
    useTags.setState({ names: [{ name: "cat_ears", category: 0 }, { name: "catwalk", category: 0 }, { name: "scattered", category: 0 }, { name: "cat_rating", category: 9 }] });
    expect(useTags.getState().related("motives/cat").tags).toEqual([]);
    expect(useTags.getState().findWords("cat").map((w) => [w.name, w.count])).toEqual([["cat_ears", 3], ["catwalk", 1], ["scattered", 0]]);
    expect(useTags.getState().findWords("cat ears")[0].name).toBe("cat_ears");
  });

  it("on the board: a tag dropped on a tag becomes its subtag, dropped on the folder a top tag; the panel adds subtags and synonyms by search", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset({ tags: { [key(1)]: ["motives/kitten"], [key(2)]: ["motives/cat"] }, auto: { [key(1)]: [[0, 0.9]], [key(2)]: [[0, 0.9]] } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Tags)));
    await act(async () => {});
    await act(async () => useTags.setState({ names: [{ name: "sun", category: 0 }, { name: "sunset", category: 0 }, { name: "cat", category: 0 }] }));
    const chip = (text: string) => Array.from(host.querySelectorAll(".tag-chip")).find((c) => c.childNodes[0]?.textContent === text || c.textContent?.startsWith(text)) as HTMLElement;
    const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    await act(async () => fire(chip("kitten"), "dragstart"));
    await act(async () => fire(chip("cat"), "dragover"));
    expect(chip("cat").classList.contains("drop-over")).toBe(true);
    await act(async () => fire(chip("cat"), "drop"));
    expect(useTags.getState().data!.parents).toEqual({ "motives/kitten": "motives/cat" });
    expect(tags()[key(1)]).toEqual(["motives/kitten", "motives/cat"]);
    expect(host.querySelector(".chip-tree")?.textContent).toMatch(/cat.*kitten/);
    // Back out onto the folder: a top tag again.
    const motives = Array.from(host.querySelectorAll(".tag-folder")).find((f) => f.querySelector("strong")?.textContent === "motives")!;
    await act(async () => fire(chip("kitten"), "dragstart"));
    await act(async () => fire(motives, "dragover"));
    await act(async () => fire(motives, "drop"));
    expect(useTags.getState().data!.parents).toEqual({});
    // The tag's panel: a tagger word, found by typing, made a linked subtag; another linked as a synonym.
    await act(async () => chip("cat").click());
    const panel = host.querySelector(".inspector")!;
    const type = async (input: HTMLInputElement, text: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        set.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const [subSearch, wordSearch] = Array.from(panel.querySelectorAll<HTMLInputElement>(".search-field input"));
    await type(subSearch, "suns");
    const word = Array.from(panel.querySelectorAll(".chip.auto")).find((c) => c.textContent?.startsWith("sunset")) as HTMLButtonElement;
    await act(async () => word.click());
    const d = useTags.getState().data!;
    expect(d.parents).toEqual({ "motives/sunset": "motives/cat" });
    expect(d.autoMap).toEqual({ sunset: "motives/sunset" });
    await type(wordSearch, "cat");
    const link = Array.from(panel.querySelectorAll(".word-row button")).find((b) => b.textContent?.includes("Link")) as HTMLButtonElement;
    await act(async () => link.click());
    expect(useTags.getState().data!.autoMap).toEqual({ sunset: "motives/sunset", cat: "motives/cat" });
    root.unmount();
  });

  it("adds a tagger word as a subtag from the styled place picker, found by typing", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset({ tags: { [key(1)]: ["motives/animal"], [key(2)]: ["motives/cat"] }, parents: { "motives/cat": "motives/animal" } });
    const { PlaceSelect, adoptWord } = await import("../components/TagBits");
    let place = "in:time";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const draw = () => root.render(createElement(PlaceSelect, { value: place, onChange: (v: string) => ((place = v), draw()) }));
    await act(async () => draw());
    await act(async () => (host.querySelector(".sel-btn") as HTMLButtonElement).click());
    expect(Array.from(document.querySelectorAll(".sel-group")).map((g) => g.textContent)).toEqual(["In a folder", "As a subtag of"]);
    const search = document.querySelector(".sel-search") as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(search, "cat");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const opts = Array.from(document.querySelectorAll(".sel-opt"));
    expect(opts.map((o) => o.textContent)).toEqual(["cat"]);
    await act(async () => (opts[0] as HTMLElement).click());
    expect(place).toBe("under:motives/cat");
    const id = adoptWord("cat_ears", "cat ears", place);
    expect(id).toBe("motives/cat ears");
    expect(useTags.getState().data!.parents!["motives/cat ears"]).toBe("motives/cat");
    expect(useTags.getState().data!.autoMap).toEqual({ cat_ears: "motives/cat ears" });
    root.unmount();
  });
});