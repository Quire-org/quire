import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemSource } from "../lib/types";
import type { PluginInfo } from "../plugins/types";

const calls = vi.hoisted(() => ({ library: [] as unknown[], login: [] as unknown[], closed: [] as string[] }));

vi.mock("../lib/api", () => ({
  api: {
    pluginLibraryGet: vi.fn(async (...a: unknown[]) => (calls.library.push(["get", ...a]), { refresh: "r" })),
    pluginLibrarySet: vi.fn(async (...a: unknown[]) => void calls.library.push(["set", ...a])),
    pluginLogin: vi.fn(async (...a: unknown[]) => (calls.login.push(a), { url: "https://app-api.example.org/callback?code=abc", cookies: Object.fromEntries(((a[4] as string[]) ?? []).map((c) => [c, "session=s"])) })),
    pluginLoginClose: vi.fn(async (id: string) => void calls.closed.push(id)),
    pluginSettingsGet: vi.fn(async () => ({})),
    loadCache: vi.fn(async () => null),
    saveLibrary: vi.fn(async () => {}),
  },
  fileSrc: (p: string) => "file://" + p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { canLogin, describePermission } = await import("../plugins/permissions");
const { dispatch, registerFrame } = await import("../plugins/host");
const { finder, useFinders } = await import("../plugins/find");
const { useStore, followMoves } = await import("../store");
// Loaded before any move: the store follows one into the tags by importing this lazily, and two
// such imports at once can get it half made in the test runner (never in the app).
await import("../tagsStore");
const { usePlugins } = await import("../plugins/store");

function plugin(permissions: string[], id = "demo"): PluginInfo {
  return {
    id,
    dir: "/x",
    manifest: { id, name: "Demo", version: "1.0.0", description: "", author: "", entry: "index.js", permissions, settings: [] },
    state: { enabled: true, allowVault: false, granted: permissions, source: "", installedAt: 0 },
  };
}

const PERMS = ["find", "library:storage", "login:app-api.example.org", "network:app-api.example.org", "network:img.example.org"];
const sections = [{ id: "feed", label: "Feed" }, { id: "follows", label: "Follows", kind: "artists" }, { id: "search", label: "Search", query: true, options: [{ value: "new", label: "Newest" }] }];

/** The asks Find posts to the demo plugin's frame. */
let posted: { name: string; payload: { ask: number; op: string; args: unknown } }[] = [];

beforeEach(() => {
  calls.library.length = 0;
  calls.login.length = 0;
  calls.closed.length = 0;
  posted = [];
  const p = plugin(PERMS);
  usePlugins.setState({ list: [p] } as never);
  useFinders.setState({ finders: {}, login: null });
  registerFrame("demo", { contentWindow: { postMessage: (m: never) => posted.push((m as { name: string; payload: never }) as never) } } as never);
  useStore.setState({ root: "/vol", vault: null, allItems: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
});

/** Let the dynamic import inside an ask settle, then answer the last ask. */
async function answerLast(p: PluginInfo, value: unknown, ok = true) {
  await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
  const { ask } = posted[posted.length - 1].payload;
  await dispatch(p, "find.answer", ok ? { ask, ok: true, value } : { ask, ok: false, error: value });
}

describe("Find's permissions", () => {
  it("says plainly what each one allows, a sign-in kept on the drive included", () => {
    expect(describePermission("login:app-api.example.org").title).toBe("Sign you in on app-api.example.org");
    expect(describePermission("library:storage").detail).toMatch(/vault when it has one, otherwise unencrypted/);
    expect(describePermission("find").sensitive).toBe(false);
  });

  it("opens sign-in pages only on login hosts, https only", () => {
    const p = plugin(["login:app-api.example.org", "network:img.example.org"]);
    expect(canLogin(p, "https://app-api.example.org/web/login")).toBe(true);
    expect(canLogin(p, "http://app-api.example.org/web/login")).toBe(false);
    expect(canLogin(p, "https://img.example.org/")).toBe(false);
  });
});

describe("a platform in Find", () => {
  it("needs the find permission to provide one, and is cleaned on the way in", async () => {
    await expect(dispatch(plugin(["network:img.example.org"]), "find.provide", { name: "Demo", sections })).rejects.toThrow(/"find" was not granted/);
    await dispatch(plugin(PERMS), "find.provide", { name: "Demo", platform: "Demo Site!", sections: [...sections, { id: "", label: "nameless" }], imageHeaders: { Referer: "https://app-api.example.org/", "Bad Header": "x" } });
    const f = useFinders.getState().finders.demo;
    expect(f.platform).toBe("demosite");
    expect(f.sections.map((s) => [s.id, s.kind])).toEqual([
      ["feed", "works"],
      ["follows", "artists"],
      ["search", "works"],
    ]);
    expect(f.sections[2]).toMatchObject({ query: true, options: [{ value: "new", label: "Newest" }] });
    expect(f.imageHeaders).toEqual({ Referer: "https://app-api.example.org/" });
    await expect(dispatch(plugin(PERMS), "find.provide", { name: "Demo", sections: [] })).rejects.toThrow(/at least one section/);
  });

  it("takes its icon from one of its hosts, or brought along as a small picture, never from elsewhere", async () => {
    const svg = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const icon = async (v: string) => {
      await dispatch(plugin(PERMS), "find.provide", { name: "Demo", sections, icon: v });
      return useFinders.getState().finders.demo.icon;
    };
    expect(await icon("https://img.example.org/favicon.ico")).toBe("https://img.example.org/favicon.ico");
    expect(await icon(svg)).toBe(svg);
    expect(await icon("https://elsewhere.example.com/favicon.ico")).toBeNull();
    expect(await icon("data:text/html,<script>1</script>")).toBeNull();
  });

  it("takes a sign-in by what the reader types, tagger words and Find source from what it provides", async () => {
    await dispatch(plugin(PERMS), "find.provide", {
      name: "Demo",
      sections,
      taggerWords: true,
      lookup: true,
      signIn: { fields: [{ id: "username", label: "Username" }, { id: "key", label: "API key", secret: true }, { id: "bad id!", label: "Dropped" }, { id: "x", label: "" }], help: "Make a key on the site.", link: { label: "Make a key", url: "https://example.org/keys" }, optional: true },
    });
    const f = useFinders.getState().finders.demo;
    expect(f.signIn).toEqual({ fields: [{ id: "username", label: "Username", secret: false }, { id: "key", label: "API key", secret: true }], help: "Make a key on the site.", link: { label: "Make a key", url: "https://example.org/keys" }, optional: true });
    expect([f.taggerWords, f.lookup]).toEqual([true, true]);
    await dispatch(plugin(PERMS), "find.provide", { name: "Demo", sections, signIn: { fields: [], link: { label: "Not https", url: "http://example.org/" } } });
    expect(useFinders.getState().finders.demo).toMatchObject({ taggerWords: false, lookup: false, signIn: { fields: [], link: null, optional: false } });
    // Signing in passes what was typed to the plugin.
    const signed = finder.signIn("demo", { username: "kile", key: "k" });
    await answerLast(plugin(PERMS), null);
    expect(posted[posted.length - 1].payload).toMatchObject({ op: "signIn", args: { fields: { username: "kile", key: "k" } } });
    // Then who is signed in, asked after.
    await vi.waitFor(() => expect(posted[posted.length - 1].payload.op).toBe("account"));
    await answerLast(plugin(PERMS), { signedIn: true, name: "kile" });
    expect((await signed).signedIn).toBe(true);
  });

  it("takes a platform of the reader's own sites, with no accounts, galleries as albums and works' languages", async () => {
    await dispatch(plugin(PERMS), "find.provide", { name: "Demo", sections, accounts: false, albums: true, icon: "https://img.example.org/a.ico", sites: { list: [{ id: "a.example", name: "A", icon: "https://img.example.org/a.ico" }, { id: "b.example", icon: "https://evil.example.com/b.ico" }, { name: "no id" }], current: "nowhere.example", add: { help: "One of these sites." } } });
    const f = useFinders.getState().finders.demo;
    // Icons only from its own hosts.
    expect(f).toMatchObject({ accounts: false, albums: true, icon: "https://img.example.org/a.ico", sites: { list: [{ id: "a.example", name: "A", icon: "https://img.example.org/a.ico" }, { id: "b.example", name: "b.example", icon: null }], current: "a.example", help: "One of these sites." } });
    const page = finder.list("demo", { section: "feed" });
    await answerLast(plugin(PERMS), { items: [{ id: "1", thumb: "https://img.example.org/1.jpg", language: "ja" }, { id: "2", thumb: "https://img.example.org/2.jpg", language: "Japanese" }] });
    const got = await page;
    expect(got.items.map((i) => i.language)).toEqual(["ja", undefined]);
    // Switching site, and adding one, are asked of the plugin.
    const switched = finder.site("demo", "b.example");
    await vi.waitFor(() => expect(posted[posted.length - 1].payload).toMatchObject({ op: "site", args: { id: "b.example" } }));
    await answerLast(plugin(PERMS), null);
    await switched;
    const added = finder.addSite("demo", "https://c.example/");
    await vi.waitFor(() => expect(posted[posted.length - 1].payload.op).toBe("addSite"));
    await answerLast(plugin(PERMS), { id: "c.example" });
    expect(await added).toBe("c.example");
  });

  it("keeps a work's tag kinds, and cleans Find source's matches", async () => {
    const p = plugin(PERMS);
    const looked = finder.lookup("demo", "SMALL");
    await answerLast(p, {
      matches: [
        { item: { id: "1", thumb: "https://img.example.org/1.jpg", tags: [{ name: "kaze", kind: "artist" }, { name: "someone", kind: "character" }, { name: "odd", kind: "nonsense" }] }, similarity: 0.62 },
        { item: { id: "2", thumb: "https://img.example.org/2.jpg" }, similarity: 3 },
        { item: { id: "3", thumb: "https://evil.example.com/3.jpg" }, similarity: 0.99 },
      ],
    });
    expect(posted[posted.length - 1].payload).toMatchObject({ op: "lookup", args: { image: "SMALL", mime: "image/jpeg" } });
    const got = await looked;
    expect(got.map((m) => [m.item.id, m.similarity])).toEqual([
      ["2", 1],
      ["1", 0.62],
    ]);
    expect(got[1].item.tags).toEqual([{ name: "kaze", translated: null, kind: "artist" }, { name: "someone", translated: null, kind: "character" }, { name: "odd", translated: null }]);
  });

  it("asks the plugin for a page and takes only what it may show", async () => {
    const p = plugin(PERMS);
    const page = finder.list("demo", { section: "feed" });
    await answerLast(p, {
      items: [
        { id: "1", title: "Kept", thumb: "https://img.example.org/1.jpg", width: 100, height: 200, pages: 3, kind: "pages", adult: true, url: "https://example.org/w/1" },
        { id: "2", title: "Elsewhere", thumb: "https://evil.example.com/2.jpg" },
        { id: "3", title: "Plain http", thumb: "http://img.example.org/3.jpg" },
        { title: "No id", thumb: "https://img.example.org/4.jpg" },
      ],
      next: "https://app-api.example.org/next",
    });
    const got = await page;
    expect(posted[0]).toMatchObject({ name: "find.ask", payload: { op: "list", args: { section: "feed" } } });
    expect(got.items.map((i) => i.id)).toEqual(["1"]);
    expect(got.items[0]).toMatchObject({ kind: "pages", pages: 3, adult: true, url: "https://example.org/w/1" });
    expect(got.next).toBe("https://app-api.example.org/next");
  });

  it("lists artists (the ones followed) and says who an artist is, with the same care", async () => {
    const p = plugin(PERMS);
    const page = finder.list("demo", { section: "artists" });
    await answerLast(p, {
      artists: [
        { id: "7", name: "Artist", account: "artist", avatar: "https://img.example.org/a7.png", followed: true, recent: [{ id: "1", thumb: "https://img.example.org/1.jpg" }, { id: "2", thumb: "https://evil.example.com/2.jpg" }] },
        { id: "8", name: "Elsewhere", avatar: "https://evil.example.com/a8.png" },
        { name: "No id" },
      ],
      artist: { id: "7", name: "Artist", works: 42, url: "https://example.org/users/7" },
    });
    const got = await page;
    expect(got.artists.map((a) => [a.id, a.avatar, a.followed, a.recent.map((r) => r.id)])).toEqual([
      ["7", "https://img.example.org/a7.png", true, ["1"]],
      ["8", null, false, []],
    ]);
    expect(got.artist).toMatchObject({ id: "7", works: 42, url: "https://example.org/users/7" });
  });

  it("asks for works related to one, and their next page", async () => {
    const p = plugin(PERMS);
    const page = finder.related("demo", { id: "5", cursor: "https://app-api.example.org/related?page=2" });
    await answerLast(p, { items: [{ id: "6", thumb: "https://img.example.org/6.jpg" }] });
    expect(posted[0].payload).toMatchObject({ op: "related", args: { id: "5", cursor: "https://app-api.example.org/related?page=2" } });
    expect((await page).items.map((i) => i.id)).toEqual(["6"]);
  });

  it("passes a plugin's error on, and ignores an answer from another plugin", async () => {
    const p = plugin(PERMS);
    const page = finder.list("demo", { section: "feed" });
    await vi.waitFor(() => expect(posted.length).toBe(1));
    const { ask } = posted[0].payload;
    const other = plugin(PERMS, "other");
    usePlugins.setState({ list: [p, other] } as never);
    await dispatch(other, "find.answer", { ask, ok: true, value: { items: [] } });
    await answerLast(p, "The site asks to slow down.", false);
    await expect(page).rejects.toThrow("The site asks to slow down.");
  });

  it("keeps a pick's files only on granted hosts, and its source as Find knows the platform", async () => {
    const p = plugin(PERMS);
    await dispatch(p, "find.provide", { name: "Demo", platform: "demo", sections });
    const files = finder.files("demo", "9");
    await answerLast(p, {
      source: { platform: "spoofed", id: "9", url: "https://example.org/w/9", title: "Nine", author: { id: "7", name: "Artist" }, tags: [{ name: "sky", translated: null }] },
      folder: "Artist - Nine (9)",
      files: [
        { url: "https://img.example.org/9_1.png", name: "9_1.png" },
        { url: "https://evil.example.com/9_2.png", name: "9_2.png" },
      ],
    });
    const f = await files;
    expect(f.files).toEqual([{ url: "https://img.example.org/9_1.png", name: "9_1.png" }]);
    expect(f.source.platform).toBe("demo");
    expect(f.animation).toBeNull();
  });
});

describe("signing in and the library's store", () => {
  it("opens a sign-in page only on a login host, and gives back where it ended", async () => {
    const p = plugin(PERMS);
    await expect(dispatch(p, "login.open", { url: "https://evil.example.com/login", until: ["https://app-api.example.org/callback"] })).rejects.toThrow(/not allowed to open a sign-in page/);
    await expect(dispatch(p, "login.open", { url: "https://app-api.example.org/login", until: [] })).rejects.toThrow(/needs `until`/);
    const back = await dispatch(p, "login.open", { url: "https://app-api.example.org/login", until: ["https://app-api.example.org/callback"], name: "Demo" });
    expect(back).toBe("https://app-api.example.org/callback?code=abc");
    // It ends as the callback is asked for, unless the plugin wants that page loaded first.
    expect(calls.login[0]).toEqual(["demo", "https://app-api.example.org/login", ["https://app-api.example.org/callback"], "Demo", [], false]);
    expect(useFinders.getState().login).toBeNull();
    expect(calls.closed).toEqual(["demo"]);
    await dispatch(p, "login.open", { url: "https://app-api.example.org/login", until: ["https://app-api.example.org/callback"], load: true });
    expect((calls.login[1] as unknown[])[5]).toBe(true);
  });

  it("gives the sign-in window's cookies for the plugin's own hosts, when asked", async () => {
    const p = plugin(PERMS);
    const ask = { url: "https://app-api.example.org/login", until: ["https://app-api.example.org/callback"] };
    await expect(dispatch(p, "login.open", { ...ask, cookies: ["https://elsewhere.example.com/"] })).rejects.toThrow(/not allowed to keep cookies/);
    const back = await dispatch(p, "login.open", { ...ask, cookies: ["https://app-api.example.org/"] });
    expect(back).toEqual({ url: "https://app-api.example.org/callback?code=abc", cookies: { "https://app-api.example.org/": "session=s" } });
  });

  it("keeps a plugin's values with the open library, with the permission only", async () => {
    await expect(dispatch(plugin(["find"]), "library.get", { key: "login" })).rejects.toThrow(/"library:storage" was not granted/);
    const p = plugin(PERMS);
    expect(await dispatch(p, "library.get", { key: "login" })).toEqual({ refresh: "r" });
    await dispatch(p, "library.set", { key: "login", value: null });
    expect(calls.library).toEqual([
      ["get", "demo", "/vol", "login"],
      ["set", "demo", "/vol", "login", null],
    ]);
    useStore.setState({ root: null } as never);
    await expect(dispatch(p, "library.get", { key: "login" })).rejects.toThrow(/no library is open/);
  });
});

describe("where a picture came from", () => {
  const source: ItemSource = { platform: "example", id: "9", url: "https://example.org/works/9", title: "Nine", author: { id: "7", name: "Artist" }, tags: [], date: null, adult: false, added: 1 };

  it("is kept by key and follows the file when it moves", () => {
    useStore.getState().addSources([["Private/2026/2026-10-29/9_1.png", source]]);
    expect(useStore.getState().library?.sources).toEqual({ "Private/2026/2026-10-29/9_1.png": source });
    followMoves([["Private/2026/2026-10-29", "Private/2026/Example"]]);
    expect(useStore.getState().library?.sources).toEqual({ "Private/2026/Example/9_1.png": source });
  });
});
