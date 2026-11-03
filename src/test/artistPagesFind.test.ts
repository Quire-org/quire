import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({
  api: new Proxy({ scanAlbums: async () => [], albumRenamePlan: async () => [] } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  rawPreviewUrl: async () => "",
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async (u: string) => void opened.push(u) }));
for (const name of ["ResizeObserver", "IntersectionObserver"])
  (globalThis as Record<string, unknown>)[name] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { Artists } = await import("../screens/Artists");
const { ConfirmHost } = await import("../components/Confirm");
const { useStore } = await import("../store");
const { useArtists } = await import("../artistsStore");
const { useFinders, finder } = await import("../plugins/find");
const { useFind, showWork } = await import("../findStore");
const { withSource, allSources, hasWork } = await import("../lib/sources");
const { findInLibrary } = await import("../lib/findCheck");

describe("an artist's page on a platform Find has", () => {
  it("opens in Find, as their works there; a page elsewhere opens in the browser", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.setState({ root: "/vol", screen: "artists", allItems: [], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    useFinders.setState({ finders: { gal: { pluginId: "gal", platform: "gallery", name: "Gallery", site: "https://www.gallery.example", icon: null, sections: [{ id: "new", label: "New", kind: "works", options: [] }], sites: null } as never } });
    const artist = { id: "ar1", name: "Kaze", renamed: false, links: [], avatar: null, avatarAt: 0, bio: "", region: "", pages: [{ label: "Gallery", url: "https://www.gallery.example/users/7" }, { label: "Elsewhere", url: "https://elsewhere.example/kaze" }], fetched: null, added: 0 };
    useArtists.setState({ doc: { version: 1, artists: { ar1: artist }, items: {}, dismissed: [] }, docRoot: "/vol", open: "ar1" } as never);
    const lookUp = vi.spyOn(finder, "artist").mockResolvedValue({ id: "7", name: "Kaze there", account: "kaze", avatar: null, followed: false, works: null } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Artists)));
    const link = (text: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>(".artist-pages-links button")).find((b) => b.textContent === text)!;
    await act(async () => link("gallery.example/users/7").click());
    expect(lookUp).toHaveBeenCalledWith("gal", { url: "https://www.gallery.example/users/7" });
    expect(useStore.getState().screen).toBe("find");
    expect(useFind.getState().pluginId).toBe("gal");
    expect(useFind.getState().view).toMatchObject({ section: "artist", author: { id: "7", name: "Kaze there" } });
    expect(opened).toEqual([]);
    // The other site has no plugin: the browser.
    useStore.setState({ screen: "artists" } as never);
    await act(async () => {});
    await act(async () => link("elsewhere.example/kaze").click());
    expect(opened).toEqual(["https://elsewhere.example/kaze"]);
    lookUp.mockRestore();
    root.unmount();
  });
});

const work = (id: string) => ({ id, title: `Work ${id}`, author: { id: "7", name: "Kaze", account: "kaze" }, url: `https://www.gallery.example/works/${id}`, thumb: `https://img.gallery.example/${id}.jpg`, width: 1, height: 1, pages: 1, kind: "image" as const, tags: [], date: null, adult: false, ai: false, likes: 0, views: 0 });
const gallery = () => useFinders.setState({ finders: { gal: { pluginId: "gal", platform: "gallery", name: "Gallery", site: "https://www.gallery.example", icon: null, sections: [{ id: "new", label: "New", kind: "works", options: [] }], sites: null } as never } });

describe("an artist's works on their platform", () => {
  it("come page after page until a screenful isn't in the library, and more on asking", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    gallery();
    // 50 works, 10 a page; the newest 10 are in the library already.
    const sources = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`have/${i}.jpg`, { platform: "gallery", id: String(i), url: "", title: "", author: { id: "7", name: "Kaze" }, tags: [], date: null, adult: false, added: 0 }]));
    useStore.setState({ root: "/vol", screen: "artists", allItems: [], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, sources } } as never);
    const artist = { id: "ar1", name: "Kaze", renamed: false, links: [{ platform: "gallery", id: "7", account: "kaze", url: null }], avatar: null, avatarAt: 0, bio: "", region: "", pages: [], fetched: null, added: 0 };
    useArtists.setState({ doc: { version: 1, artists: { ar1: artist }, items: {}, dismissed: [] }, docRoot: "/vol", open: "ar1" } as never);
    const list = vi.spyOn(finder, "list").mockImplementation(async (_id, args) => {
      const from = Number(args.cursor ?? 0);
      return { items: Array.from({ length: 10 }, (_, i) => work(String(from + i))), artists: [], artist: null, next: from + 10 < 50 ? String(from + 10) : null, title: null, total: 50 };
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Artists)));
    await act(async () => (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.startsWith("More on")) as HTMLButtonElement).click());
    await vi.waitFor(() => expect(document.body.querySelectorAll(".artist-more-tile")).toHaveLength(24));
    expect(list.mock.calls.length).toBe(4);
    await act(async () => (document.body.querySelector(".artist-more-next") as HTMLButtonElement).click());
    await vi.waitFor(() => expect(document.body.querySelectorAll(".artist-more-tile")).toHaveLength(40));
    expect(document.body.querySelector(".artist-more-next")).toBeNull();
    expect(document.body.textContent).toContain("40 of their 50 not in your library");
    list.mockRestore();
    root.unmount();
  });
});

describe("a work shown from elsewhere", () => {
  it("opens in Find on its platform, looked at closer; in the browser when the platform can't say", async () => {
    gallery();
    opened.length = 0;
    const one = vi.spyOn(finder, "work").mockResolvedValueOnce({ item: work("12"), pages: [], caption: "" }).mockRejectedValueOnce(new Error("gone"));
    await showWork("gallery", "12", "https://www.gallery.example/works/12");
    expect(useStore.getState().screen).toBe("find");
    expect(useFind.getState().lookAt?.id).toBe("12");
    useFind.setState({ lookAt: null } as never);
    await showWork("gallery", "13", "https://www.gallery.example/works/13");
    await vi.waitFor(() => expect(opened).toEqual(["https://www.gallery.example/works/13"]));
    await showWork("elsewhere", "1", "https://elsewhere.example/1");
    await vi.waitFor(() => expect(opened).toContain("https://elsewhere.example/1"));
    one.mockRestore();
  });
});

describe("a picture posted on several platforms", () => {
  const src = (platform: string, id: string, title = "") => ({ platform, id, url: "", title, author: { id: "1", name: "Kaze" }, tags: [], date: null, adult: false, added: 0 });
  it("keeps the work it came in as, and the same work met elsewhere beside it", () => {
    let s = withSource(undefined, src("gallery", "1"));
    s = withSource(s, src("board", "9"));
    s = withSource(s, src("board", "9", "again"));
    s = withSource(s, src("gallery", "1", "renamed"));
    expect(allSources(s).map((x) => `${x.platform}:${x.id}:${x.title}`)).toEqual(["gallery:1:renamed", "board:9:again"]);
    expect(hasWork(s, { platform: "board", id: "9" })).toBe(true);
    // Known as had on either platform.
    const pic = { key: "a.jpg", primary: "/vol/a.jpg", files: ["/vol/a.jpg"], name: "a", kind: "image", dir: "", size: 1, modified: 0, hasRaw: false, hasVideo: false };
    expect(findInLibrary({ platform: "board", id: "9" }, [], [pic as never], { "a.jpg": s }, {}).matches.map((m) => m.item.key)).toEqual(["a.jpg"]);
  });

  it("are noted as crossposts when found again, not written over", () => {
    useStore.setState({ library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, sources: { "a.jpg": src("gallery", "1") } } as never, allItems: [] });
    useStore.getState().addSources([["a.jpg", src("board", "9")]]);
    expect(useStore.getState().library!.sources!["a.jpg"]).toMatchObject({ platform: "gallery", id: "1", also: [{ platform: "board", id: "9" }] });
  });
});

describe("linking an artist from their pages", () => {
  const pages = [
    { label: "Gallery", url: "https://www.gallery.example/shop/kaze" },
    { label: "Gallery", url: "https://www.gallery.example/users/7" },
    { label: "Gallery", url: "https://sketch.gallery.example/@kaze" },
  ];
  const artist = (id: string, name: string, links: unknown[] = [], extra = {}) => ({ id, name, renamed: false, links, avatar: null, avatarAt: 0, bio: "", region: "", pages: [], fetched: null, added: 0, ...extra });
  const lookUp = () =>
    vi.spyOn(finder, "artist").mockImplementation(async (_id, a) => {
      if (!/\/users\/7$/.test(a.url ?? "")) throw new Error("That isn't the address of an artist there");
      return { id: "7", name: "Kaze", account: "kaze", avatar: null, followed: false, works: null, url: "https://www.gallery.example/users/7" } as never;
    });
  const render = async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, createElement(Artists), createElement(ConfirmHost))));
    return { host, root };
  };
  const button = (_scope: HTMLElement, text: string) => Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement;

  it("takes the one page that is an account, the others left alone", async () => {
    gallery();
    useStore.setState({ root: "/vol", screen: "artists", allItems: [], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    useArtists.setState({ doc: { version: 1, artists: { ar1: artist("ar1", "コイビ", [], { pages }) }, items: {}, dismissed: [] }, docRoot: "/vol", open: "ar1" } as never);
    const spy = lookUp();
    const { host, root } = await render();
    await act(async () => button(host, "Link").click());
    await vi.waitFor(() => expect(useArtists.getState().doc!.artists.ar1.links).toEqual([{ platform: "gallery", id: "7", account: "kaze", url: "https://www.gallery.example/users/7" }]));
    expect(document.body.textContent).toContain("linked above");
    spy.mockRestore();
    root.unmount();
  });

  it("offers to join them with the artist that account is linked to already", async () => {
    gallery();
    useArtists.setState({ doc: { version: 1, artists: { ar1: artist("ar1", "コイビ", [], { pages }), ar2: artist("ar2", "Kaze", [{ platform: "gallery", id: "7", account: "kaze", url: null }]) }, items: {}, dismissed: [] }, docRoot: "/vol", open: "ar1" } as never);
    const spy = lookUp();
    const { host, root } = await render();
    await act(async () => button(host, "Link").click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Kaze on Gallery already"));
    await act(async () => button(host, "Join them").click());
    await vi.waitFor(() => expect(Object.keys(useArtists.getState().doc!.artists)).toHaveLength(1));
    spy.mockRestore();
    root.unmount();
  });
});

describe("an artist linked on two platforms", () => {
  it("names both in the tabs that look on them", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useFinders.setState({
      finders: {
        gal: { pluginId: "gal", platform: "gallery", name: "Gallery", site: null, icon: null, sections: [{ id: "new", label: "New", kind: "works", options: [] }], sites: null } as never,
        brd: { pluginId: "brd", platform: "board", name: "Board", site: null, icon: null, sections: [{ id: "new", label: "New", kind: "works", options: [] }], sites: null } as never,
      },
    });
    const links = [{ platform: "gallery", id: "7", account: "kaze", url: null }, { platform: "board", id: "9", account: "kaze", url: null }];
    useArtists.setState({ doc: { version: 1, artists: { ar1: { id: "ar1", name: "Kaze", renamed: false, links, avatar: null, avatarAt: 0, bio: "", region: "", pages: [], fetched: null, added: 0 } }, items: {}, dismissed: [] }, docRoot: "/vol", open: "ar1" } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Artists)));
    const tabs = Array.from(document.body.querySelectorAll(".page-tab")).map((t) => t.textContent);
    expect(tabs).toContain("From Gallery and Board, in your library");
    expect(tabs).toContain("More on Gallery and Board");
    root.unmount();
  });
});

describe("more of their works, on two platforms", () => {
  it("shows one platform at a time, and a work clicked opens in Find, looked at closer", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pf = (pluginId: string, name: string) => ({ pluginId, platform: pluginId, name, site: null, icon: null, sections: [{ id: "new", label: "New", kind: "works", options: [] }], artistOptions: [], sites: null }) as never;
    useFinders.setState({ finders: { gal: pf("gal", "Gallery"), brd: pf("brd", "Board") } });
    useStore.setState({ root: "/vol", screen: "artists", allItems: [], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    const links = [{ platform: "gal", id: "7", account: "kaze", url: null }, { platform: "brd", id: "9", account: "kaze", url: null }];
    useArtists.setState({ doc: { version: 1, artists: { ar1: { id: "ar1", name: "Kaze", renamed: false, links, avatar: null, avatarAt: 0, bio: "", region: "", pages: [], fetched: null, added: 0 } }, items: {}, dismissed: [] }, docRoot: "/vol", open: "ar1" } as never);
    const list = vi.spyOn(finder, "list").mockImplementation(async (id) => ({ items: [work(`${id}-1`)], artists: [], artist: null, next: null, title: null, total: 1 }));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Artists)));
    await act(async () => (Array.from(document.body.querySelectorAll(".page-tab")).find((b) => b.textContent?.startsWith("More on")) as HTMLButtonElement).click());
    await vi.waitFor(() => expect(document.body.querySelectorAll(".artist-more-tile")).toHaveLength(1));
    expect(document.body.querySelectorAll(".artist-more")).toHaveLength(1);
    expect(list.mock.calls.map(([id]) => id)).toEqual(["gal"]);
    await act(async () => (Array.from(document.body.querySelectorAll(".artist-more-platforms button")).find((b) => b.textContent?.includes("Board")) as HTMLButtonElement).click());
    await vi.waitFor(() => expect(document.body.querySelector(".artist-more h2")?.textContent).toContain("on Board"));
    // The basket's corner, as in Find.
    expect(document.body.querySelector(".artist-more-tile .find-corner.basket")).not.toBeNull();
    await vi.waitFor(() => expect(document.body.querySelector(".artist-more-open")).not.toBeNull());
    await act(async () => (document.body.querySelector(".artist-more-open") as HTMLButtonElement).click());
    expect(useStore.getState().screen).toBe("find");
    expect(useFind.getState().pluginId).toBe("brd");
    expect(useFind.getState().lookAt?.id).toBe("brd-1");
    expect(useFind.getState().view.section).not.toBe("artist");
    list.mockRestore();
    root.unmount();
  });
});

describe("a work of theirs found in your library", () => {
  it("opens yours and theirs side by side, a page at a time, and takes a yes from there", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    gallery();
    const pic = { key: "in/a.jpg", primary: "/vol/in/a.jpg", files: ["/vol/in/a.jpg"], name: "a", kind: "image", dir: "in", size: 1, modified: 0, hasRaw: false, hasVideo: false };
    useStore.setState({ root: "/vol", screen: "artists", allItems: [pic], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, sources: {} } } as never);
    const found = { artist: "ar1", key: "in/a.jpg", item: "in/a.jpg", platform: "gallery", work: "12", title: "Sea", url: null, score: 1, at: 0 };
    const artist = { id: "ar1", name: "Kaze", renamed: false, links: [{ platform: "gallery", id: "7", account: "kaze", url: null }], avatar: null, avatarAt: 0, bio: "", region: "", pages: [], fetched: null, added: 0 };
    useArtists.setState({ doc: { version: 1, artists: { ar1: artist }, items: {}, dismissed: [], found: [found] }, docRoot: "/vol", open: "ar1" } as never);
    const pages = vi.spyOn(finder, "work").mockResolvedValue({ item: work("12"), pages: [{ preview: "https://img.gallery.example/12-p0.jpg", thumb: null }, { preview: "https://img.gallery.example/12-p1.jpg", thumb: null }], caption: "" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Artists)));
    await act(async () => (Array.from(document.body.querySelectorAll(".page-tab")).find((b) => b.textContent?.startsWith("From")) as HTMLButtonElement).click());
    await act(async () => (document.body.querySelector(".artist-found-tile .thumb") as HTMLElement).click());
    await vi.waitFor(() => expect(document.body.querySelectorAll(".compare-pair figure")).toHaveLength(2));
    expect(pages).toHaveBeenCalledWith("gal", "12");
    await vi.waitFor(() => expect(document.body.querySelector(".compare-pair-pages")?.textContent).toContain("1/2"));
    await act(async () => (document.body.querySelector('.compare-pair-pages button[title="The next page"]') as HTMLButtonElement).click());
    expect(document.body.querySelector(".compare-pair-pages")?.textContent).toContain("2/2");
    await act(async () => (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("Yes, theirs")) as HTMLButtonElement).click());
    expect(useArtists.getState().doc!.items["in/a.jpg"]).toEqual(["ar1"]);
    expect(document.body.querySelector(".compare-pair")).toBeNull();
    pages.mockRestore();
    root.unmount();
  });
});
