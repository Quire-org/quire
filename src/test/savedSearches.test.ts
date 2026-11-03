import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindItem, FindPage } from "../plugins/find";

const saved = vi.hoisted(() => ({ docs: [] as unknown[] }));

vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      findStateLoad: async () => null,
      findStateSave: async (_root: string, doc: unknown) => void saved.docs.push(doc),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));

const { freshIn, idNumber, nameFor, newer, newestOf, saveable } = await import("../lib/savedSearches");
const { useFind } = await import("../findStore");
const { finder, useFinders } = await import("../plugins/find");
const { useStore } = await import("../store");
const { useJobs } = await import("../lib/jobs");

const work = (id: string): FindItem => ({ id, title: id, author: { id: "", name: "", account: "" }, url: null, thumb: `https://img.example.org/${id}.jpg`, width: 1, height: 1, pages: 1, kind: "image", tags: [], date: null, adult: false, ai: false, likes: 0, views: 0 });
const page = (ids: string[], next: string | null = null): FindPage => ({ items: ids.map(work), artists: [], artist: null, next, title: null, total: null });
const view = (query: string) => ({ section: "search", query, option: "new", author: null, tag: null });

describe("what is new in a saved search", () => {
  it("is what came after the newest work it showed, by the number its id ends with", () => {
    expect(idNumber("site.example/1234")).toBe(1234);
    expect(idNumber("abc")).toBeNull();
    expect(newer("site.example/120", "site.example/99")).toBe(true);
    expect(newer("98", "99")).toBe(false);
    expect(newer("anything", null)).toBe(true);
    expect(newer("abc", "99")).toBe(false);
    expect(newestOf(["5", "12", "7"], "9")).toBe("12");
    expect(freshIn(["12", "11", "10", "9"], "9", new Set(["11"]))).toBe(2);
  });

  it("can be a search with terms or an artist's works with a tag, named by them", () => {
    expect(saveable(view("sea"), "search")).toBe(true);
    expect(saveable(view(" "), "search")).toBe(false);
    expect(saveable({ section: "artist", query: "", option: "", author: { id: "7", name: "Kaze" }, tag: "sea" }, "search")).toBe(true);
    expect(saveable({ section: "artist", query: "", option: "", author: { id: "7", name: "Kaze" }, tag: null }, "search")).toBe(false);
    expect(nameFor({ section: "artist", query: "", option: "", author: { id: "7", name: "Kaze" }, tag: "sea" })).toBe("Kaze · #sea");
  });
});

describe("saved searches in Find", () => {
  beforeEach(() => {
    saved.docs.length = 0;
    useStore.setState({ root: "/vol" } as never);
    useFinders.setState({ finders: { p: { pluginId: "p", platform: "plat", name: "Plat", sections: [{ id: "search", label: "Search", query: true, options: [], kind: "works" }], sites: null } as never } });
    useFind.setState({ pluginId: "p", basketsFor: "/vol", saved: [], seen: {}, visit: null, items: [], view: view("sea"), checking: false } as never);
  });

  it("are saved with what they show now as seen, checked for what came since (as a job), and opened with it marked new", async () => {
    useFind.setState({ items: ["30", "29", "28"].map(work) } as never);
    const s = useFind.getState().saveSearch()!;
    expect(s).toMatchObject({ name: "sea", platform: "plat", mark: "30", fresh: 0 });
    expect(useFind.getState().saveSearch()!.id).toBe(s.id);

    // Since then: two new works, one of which passed the screen elsewhere.
    useFind.getState().markSeen("plat", ["31"]);
    const list = vi.spyOn(finder, "list").mockResolvedValue(page(["32", "31", "30", "29"], "more"));
    const titles: string[] = [];
    const unsub = useJobs.subscribe((st) => st.jobs.forEach((j) => titles.push(j.title)));
    await useFind.getState().checkSaved("p", true);
    unsub();
    expect(titles).toContain("Checking 1 saved search on Plat");
    expect(useFind.getState().saved[0]).toMatchObject({ fresh: 1, more: false });

    // Opened: what came since is new for this visit, and the mark moves on.
    useFind.setState({ view: view("other") } as never);
    await useFind.getState().openSaved(s.id);
    await vi.waitFor(() => expect(useFind.getState().items.length).toBe(4));
    expect(useFind.getState().visit).toEqual({ id: s.id, since: "30" });
    expect(useFind.getState().saved[0]).toMatchObject({ mark: "32", fresh: 0 });
    expect(useFind.getState().seenBefore.has("31")).toBe(true);
    list.mockRestore();
  });

  it("are kept with the library, with what has passed the screen", async () => {
    useFind.getState().markSeen("plat", ["1", "2"]);
    useFind.getState().saveSearch();
    await vi.waitFor(() => expect(saved.docs.length).toBeGreaterThan(0));
    const doc = saved.docs[saved.docs.length - 1] as { saved: unknown[]; seen: Record<string, string[]> };
    expect(doc.saved).toHaveLength(1);
    expect(doc.seen.plat).toEqual(["1", "2"]);
  });
});
