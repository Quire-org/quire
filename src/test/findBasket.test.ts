import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FindItem } from "../plugins/find";

vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));

const { useFind } = await import("../findStore");
const { useFinders } = await import("../plugins/find");
const { useStore } = await import("../store");

const work = (pages: number, more: Partial<FindItem> = {}): FindItem => ({ id: "w1", title: "W", author: { id: "", name: "", account: "" }, url: null, thumb: "https://img.example.org/w.jpg", width: 1, height: 1, pages, kind: "pages", tags: [], date: null, adult: true, ai: false, likes: 0, views: 0, ...more });
const entry = () => useFind.getState().baskets.p?.find((b) => b.id === "w1");

beforeEach(() => {
  useStore.setState({ root: "/vol" } as never);
  useFind.setState({ pluginId: "p", baskets: { p: [] }, basketsFor: "/vol" } as never);
});

describe("the basket, for a platform whose works are albums", () => {
  beforeEach(() => useFinders.setState({ finders: { p: { pluginId: "p", albums: true } as never } }));

  it("brings a work in whole as an album, or only the pages picked from it, each a single picture", () => {
    const f = useFind.getState();
    // Known from a list as one page; from its own page as thirty, with tags and its artist.
    f.toggleBasket(work(1));
    f.setPages(work(30, { tags: [{ name: "sea", translated: null }], author: { id: "kaze", name: "Kaze", account: "kaze" }, language: "ja" }), [4, 2]);
    expect(entry()).toMatchObject({ only: [2, 4], album: false, pages: 30, author: { id: "kaze" }, language: "ja" });
    // A list's say again (one page, no tags) doesn't undo what its own page said.
    f.setPages(work(1), [2, 4, 7]);
    expect(entry()).toMatchObject({ only: [2, 4, 7], pages: 30, tags: [{ name: "sea" }] });
    f.setPages(work(30), []);
    expect(entry()?.only).toBeUndefined();
    expect(entry()?.album).toBeUndefined();
  });

  it("keeps not being an album, when said", () => {
    useFind.getState().setAlbum(work(30), false);
    expect(entry()?.album).toBe(false);
  });
});

describe("the basket, for any other platform", () => {
  beforeEach(() => useFinders.setState({ finders: { p: { pluginId: "p", albums: false } as never } }));

  it("keeps all of a work's pages unless some are left out, and leaves the album choice alone", () => {
    const f = useFind.getState();
    f.setPages(work(5), [0, 1, 2]);
    expect(entry()).toMatchObject({ only: [0, 1, 2] });
    expect(entry()?.album).toBeUndefined();
    f.setPages(work(5), [0, 1, 2, 3, 4]);
    expect(entry()?.only).toBeUndefined();
  });
});
