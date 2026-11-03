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
const { useTags, conflictsOf, tagsOfType } = await import("../tagsStore");
const { Tags } = await import("../screens/Tags");
const { ConfirmHost } = await import("../components/Confirm");

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

describe("tag folders and rules", () => {
  it("moves a tag into another folder with everything that refers to it, and merges into one of the same name", () => {
    reset({
      tags: { [key(1)]: ["weather/night"], [key(2)]: ["weather/night", "motives/cat"], [key(3)]: ["time/night"] },
      autoMap: { night: "weather/night" },
      bundles: { dark: ["weather/night", "motives/cat"] },
      denied: { "weather/night": [key(4)] },
      apart: [["motives/cat", "weather/night"]],
    });
    useTags.getState().setFilter("tag:weather/night");
    useTags.getState().moveTag("weather/night", "time");
    const d = useTags.getState().data!;
    expect(tags()[key(1)]).toEqual(["time/night"]);
    expect(tags()[key(2)]).toEqual(["time/night", "motives/cat"]);
    expect(tags()[key(3)]).toEqual(["time/night"]);
    expect(tagsOfType(d, "weather")).toEqual([]);
    expect(d.autoMap).toEqual({ night: "time/night" });
    expect(d.bundles).toEqual({ dark: ["time/night", "motives/cat"] });
    expect(d.denied).toEqual({ "time/night": [key(4)] });
    expect(d.apart).toEqual([["motives/cat", "time/night"]]);
    // The page that was open follows the tag.
    expect(useTags.getState().filter).toBe("tag:time/night");
  });

  it("a “one of” folder: a new tag there takes the place of the old one, and what carried two is shown", () => {
    reset({ tags: { [key(1)]: ["time/day", "time/night"], [key(2)]: ["time/day", "motives/cat"] } });
    expect(conflictsOf(useTags.getState().data!, "time")).toEqual([key(1)]);
    useTags.getState().setExclusive("time", true);
    useTags.getState().setTag([key(2)], "time/night", true);
    expect(tags()[key(2)]).toEqual(["motives/cat", "time/night"]);
    // Picking one for the one that carried two settles it.
    useTags.getState().setTag([key(1)], "time/day", true);
    expect(tags()[key(1)]).toEqual(["time/day"]);
    expect(conflictsOf(useTags.getState().data!, "time")).toEqual([]);
    // Other folders still take several.
    useTags.getState().setTag([key(2)], "motives/dog", true);
    expect(tags()[key(2)]).toEqual(["motives/cat", "time/night", "motives/dog"]);
    // Renaming the folder keeps it "one of".
    useTags.getState().renameType("time", "time of day");
    expect(useTags.getState().data!.exclusive).toEqual(["time of day"]);
    expect(tags()[key(2)]).toContain("time of day/night");
  });

  it("never suggests a tag where a tag it is kept apart from is, either way, nor a second of a “one of” folder", async () => {
    // p1..p3 carry night with sunny's neighbours around; p4 is day, p5 is plain. The backend finds sunny and night likely.
    reset({ tags: { [key(1)]: ["weather/sunny", "time/day"], [key(2)]: ["weather/sunny", "time/day"], [key(3)]: ["time/night"], [key(4)]: ["time/day"] } });
    rank.chances = [{ tag: "weather/sunny", p: 0.9, examples: true }, { tag: "time/night", p: 0.8, examples: true }];
    const suggested = async (k: string) => (await useTags.getState().suggest([k])).map((s) => s.tag);
    expect(await suggested(key(5))).toContain("weather/sunny");
    useTags.getState().setApart("weather/sunny", "time/night", true);
    // On night pictures, sunny isn't suggested; on sunny ones, night isn't.
    useTags.getState().setTag([key(5)], "time/night", true);
    expect(await suggested(key(5))).not.toContain("weather/sunny");
    useTags.getState().setTag([key(5)], "time/night", false);
    useTags.getState().setTag([key(5)], "weather/sunny", true);
    rank.chances = [{ tag: "time/night", p: 0.95, examples: true }];
    expect(await suggested(key(5))).not.toContain("time/night");
    // A tag's own list of what might carry it leaves those out too.
    rank.cands = [{ key: key(4), p: 0.9, examples: true }, { key: key(5), p: 0.9, examples: true }, { key: key(6), p: 0.8, examples: true }];
    const forNight = (await useTags.getState().suggestedFor("time/night", "images")).map((x) => x.key);
    expect(forNight).toContain(key(4)); // day, but time isn't "one of" yet
    expect(forNight).not.toContain(key(5)); // sunny
    useTags.getState().setExclusive("time", true);
    const again = (await useTags.getState().suggestedFor("time/night", "images")).map((x) => x.key);
    expect(again).not.toContain(key(4));
    expect(again).toContain(key(6));
    expect(await suggested(key(4))).not.toContain("time/night");
    rank.chances = [];
    rank.cands = [];
  });

  it("finds what often goes with a tag: your tags overlapping it, and tagger words seen far more often on it", () => {
    // sunny on p1..p4; "sun" seen on all of them and nowhere else; "sky" seen everywhere (not telling).
    const auto: TagData["auto"] = {};
    for (let n = 1; n <= 10; n++) auto[key(n)] = [[1, 0.8], ...(n <= 4 ? ([[0, 0.7]] as [number, number][]) : [])];
    reset({ tags: { [key(1)]: ["weather/sunny", "weather/sun"], [key(2)]: ["weather/sunny", "weather/sun"], [key(3)]: ["weather/sunny", "weather/sun"], [key(4)]: ["weather/sunny", "motives/cat"], [key(5)]: ["motives/cat"], [key(6)]: ["motives/cat"], [key(7)]: ["motives/cat"] }, auto }, 10);
    useTags.setState({ names: [{ name: "sun", category: 0 }, { name: "sky", category: 0 }] });
    let r = useTags.getState().related("weather/sunny");
    expect(r.count).toBe(4);
    expect(r.tags.map((x) => x.id)).toEqual(["weather/sun"]); // cat: on 1 of 4, and 1 of its 4
    expect(r.tags[0]).toMatchObject({ both: 3, share: 0.75, theirs: 1 });
    expect(r.words.map((w) => w.name)).toEqual(["sun"]);
    expect(r.words[0].lift).toBeCloseTo(2.5);
    // Linked, the word moves to the tag's links; "not related" takes the tag off the list.
    useTags.getState().mapAuto("sun", "weather/sunny");
    useTags.getState().dismissRelated("weather/sunny", "weather/sun");
    r = useTags.getState().related("weather/sunny");
    expect(r.words).toEqual([]);
    expect(r.tags).toEqual([]);
  });

  it("the board: folders with their tags, a tag dragged into another folder, the side panel of a folder and of a tag, and a tag's grid", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    reset({ tags: { [key(1)]: ["weather/night"], [key(2)]: ["time/day"] }, exclusive: ["time"] });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Tags)));
    await act(async () => {});
    const folders = () => Array.from(document.body.querySelectorAll(".tag-folder:not(.new)"));
    expect(folders().map((f) => f.querySelector("strong")?.textContent)).toEqual(["time", "weather", "motives"]);
    // No side panels on the board.
    expect(document.body.querySelector(".tags-side")).toBeNull();
    const chip = (text: string) => Array.from(document.body.querySelectorAll(".tag-chip")).find((c) => c.textContent?.includes(text)) as HTMLElement;
    const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    await act(async () => fire(chip("night"), "dragstart"));
    const time = folders()[0];
    await act(async () => fire(time, "dragover"));
    expect(time.classList.contains("drop-over")).toBe(true);
    await act(async () => fire(time, "drop"));
    expect(tags()[key(1)]).toEqual(["time/night"]);
    expect(folders()[0].textContent).toContain("night");
    // The folder box opens its settings beside the board: "pick one" is a switch there.
    await act(async () => (folders()[1] as HTMLElement).click());
    expect(useTags.getState().filter).toBe("folder:weather");
    const pickOne = document.body.querySelector(".inspector input[type=checkbox]") as HTMLInputElement;
    expect(pickOne.checked).toBe(false);
    await act(async () => pickOne.click());
    expect(useTags.getState().data!.exclusive).toEqual(["time", "weather"]);
    expect(folders()[1].textContent).toContain("pick one");
    // A chip opens the tag's settings: opposites set there; See tagged opens its grid, with the panels beside it.
    await act(async () => chip("night").click());
    expect(useTags.getState().filter).toBe("tag:time/night");
    const panel = document.body.querySelector(".inspector")!;
    expect(panel.textContent).toContain("Opposites");
    expect(panel.textContent).toContain("day"); // "pick one": the rest of time are opposites anyway
    const see = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent?.includes("See tagged")) as HTMLButtonElement;
    await act(async () => see.click());
    expect(useTags.getState().filter).toBe("time/night");
    expect(document.body.querySelectorAll(".tags-side").length).toBe(2);
    // Esc: back to the tag's settings, then the board.
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(useTags.getState().filter).toBe("tag:time/night");
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(useTags.getState().filter).toBe("overview");
    // Selected: the "pick one" tag is a chip among its tags; clicking it opens the folder's choices to switch.
    // (In All images: a picture switched off night would leave night's grid.)
    await act(async () => useTags.getState().setFilter("all"));
    await act(async () => useTags.getState().select(new Set([key(1)])));
    const pick = document.body.querySelector(".tags-side.right .chip.pick") as HTMLButtonElement;
    expect(pick.textContent).toContain("night");
    await act(async () => pick.click());
    const choice = (text: string) => Array.from(document.body.querySelectorAll(".pick-one-choices .chip")).find((c) => c.textContent?.trim() === text) as HTMLButtonElement;
    expect(choice("night").classList.contains("active")).toBe(true);
    await act(async () => choice("day").click());
    expect(tags()[key(1)]).toEqual(["time/day"]);
    expect(document.body.querySelector(".pick-one-choices")).toBeNull();
    // "none" takes it off: the folder moves to the row of ones without a pick.
    await act(async () => (document.body.querySelector(".tags-side.right .chip.pick") as HTMLButtonElement).click());
    await act(async () => choice("none").click());
    expect(tags()[key(1)]).toBeUndefined();
    const add = Array.from(document.body.querySelectorAll(".pick-one-add button")).map((b) => b.textContent?.trim());
    expect(add).toEqual(["time"]); // weather has no tags left to pick from
    await act(async () => (document.body.querySelector(".pick-one-add button") as HTMLButtonElement).click());
    await act(async () => choice("night").click());
    expect(tags()[key(1)]).toEqual(["time/night"]);
    root.unmount();
  });

  it("settles everything carrying more than one tag of a “pick one” folder at once: all assigned one, one taken off all, or every one of the folder's", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const mixed = { [key(1)]: ["time/day", "time/night"], [key(2)]: ["time/day", "time/night", "motives/cat"], [key(3)]: ["time/day", "time/dusk"], [key(4)]: ["time/night"] };
    reset({ tags: mixed, exclusive: ["time"] });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, createElement(Tags), createElement(ConfirmHost))));
    await act(async () => {});
    await act(async () => useTags.getState().setFilter("folder:time"));
    const box = () => document.body.querySelector(".conflict-actions") as HTMLElement | null;
    expect(box()?.textContent).toContain("3 things carry more than one");
    const button = (text: RegExp) => Array.from(document.body.querySelectorAll("button")).find((b) => text.test(b.textContent?.trim() ?? "")) as HTMLButtonElement;
    const pick = async (row: number, label: RegExp) => {
      await act(async () => (box()!.querySelectorAll(".conflict-field")[row].querySelector(".sel-btn") as HTMLButtonElement).click());
      const opt = Array.from(document.querySelectorAll(".sel-opt")).find((o) => label.test(o.textContent ?? "")) as HTMLElement;
      await act(async () => opt.click());
    };
    // Assign all to night: day and dusk come off those three; the fourth (night only) and other folders untouched.
    await pick(0, /^night \(2\)/);
    await act(async () => button(/^Apply$/).click());
    expect(document.body.textContent).toContain("Give all 3 things just night?");
    await act(async () => button(/^Assign$/).click());
    expect(tags()).toEqual({ [key(1)]: ["time/night"], [key(2)]: ["time/night", "motives/cat"], [key(3)]: ["time/night"], [key(4)]: ["time/night"], "": ["time/day", "time/dusk"] });
    expect(box()).toBeNull();
    // Remove day from all of them; then every time tag.
    await act(async () => useTags.setState({ data: { ...useTags.getState().data!, tags: mixed } }));
    await pick(1, /^day \(3\)/);
    await act(async () => button(/^Remove$/).click());
    // The dialog's own Remove comes after the panel's.
    await act(async () => Array.from(document.body.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Remove").pop()!.click());
    expect(tags()[key(1)]).toEqual(["time/night"]);
    expect(tags()[key(3)]).toEqual(["time/dusk"]);
    expect(box()).toBeNull();
    await act(async () => useTags.setState({ data: { ...useTags.getState().data!, tags: mixed } }));
    await act(async () => button(/^Remove all$/).click());
    expect(document.body.textContent).toContain("Take every time tag off the 3 things?");
    // The dialog's own Remove all comes after the panel's.
    await act(async () => Array.from(document.body.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Remove all").pop()!.click());
    expect(tags()[key(1)]).toBeUndefined();
    expect(tags()[key(2)]).toEqual(["motives/cat"]);
    expect(tags()[key(4)]).toEqual(["time/night"]); // carried only one: not among them
    root.unmount();
  });
});