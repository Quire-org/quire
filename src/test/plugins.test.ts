import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";
import type { PluginInfo } from "../plugins/types";

const calls = vi.hoisted(() => ({ fetch: [] as unknown[], read: [] as unknown[], run: [] as unknown[] }));

vi.mock("../lib/api", () => ({
  api: {
    versionsLoad: vi.fn(async () => null),
    loadCache: vi.fn(async () => null),
    versionInfo: vi.fn(async () => ({ fp: "a-1", link: { from: "d-1", fromName: "p0.png", madeAt: "Albums/Book/p1.png", fromAt: "Albums/Book/p0.png", by: "demo", note: "cleaned", at: 0 }, kept: "/vol/.quire.originals/d-1/p0.png", original: null, versions: [{ made: "b-2", path: null, link: { from: "a-1", fromName: "p1.png", madeAt: "Albums/Book/gone.png", fromAt: "", by: "other", note: "edited", at: 0 } }, { made: "c-3", path: "/vol/Albums/Book/p1 crop.png", link: { from: "a-1", fromName: "p1.png", madeAt: "Albums/Book/p1 crop.png", fromAt: "", by: "other", note: "edited", at: 0 } }] })),
    pluginFetch: vi.fn(async (_id: string, req: unknown) => {
      calls.fetch.push(req);
      return { status: 200, headers: {}, body: "{}", bodyBase64: null };
    }),
    readMediaImage: vi.fn(async (_root: string, path: string) => {
      calls.read.push(path);
      return new ArrayBuffer(4);
    }),
    pluginEngineRun: vi.fn(async (_id: string, _root: string, path: string, options: unknown) => {
      calls.run.push(path, options);
      return { pngBase64: (options as { give?: boolean }).give ? btoa("png") : null, width: 200, height: 400, result: { bars: [[50, 100, 20, 40]] }, seconds: 1 };
    }),
    writeMediaFile: vi.fn(async (_root: string, dir: string, name: string) => `${dir}/${name}`),
    replaceMediaFile: vi.fn(async (_root: string, _lib: unknown, it: MediaItem, name: string) => ({ item: { ...it, key: `Albums/Book/${name}`, primary: `/vol/Albums/Book/${name}`, files: [`/vol/Albums/Book/${name}`], name }, trashed: [[it.primary, "/vol/_deleted/p1.png"]] })),
    pluginStorageGet: vi.fn(async () => ({})),
    pluginStorageSet: vi.fn(async () => {}),
    pluginSettingsGet: vi.fn(async () => ({})),
    pluginLog: vi.fn(async () => {}),
  },
  fileSrc: (p: string) => "file://" + p,
  mediaUrl: (i: { primary: string }) => "file://" + i.primary,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { canFetch, can } = await import("../plugins/permissions");
const { dispatch, metaFor, finishKeep, panelAction } = await import("../plugins/host");
const { useStore } = await import("../store");
const { usePlugins, directionFor } = await import("../plugins/store");

function plugin(permissions: string[], granted = permissions, patch: Partial<PluginInfo["state"]> = {}): PluginInfo {
  return {
    id: "demo",
    dir: "/x",
    manifest: { id: "demo", name: "Demo", version: "1.0.0", description: "", author: "", entry: "index.js", permissions, settings: [] },
    state: { enabled: true, allowVault: false, granted, source: "", installedAt: 0, ...patch },
  };
}

const item: MediaItem = { key: "Albums/Book/p1.png", primary: "/vol/Albums/Book/p1.png", files: ["/vol/Albums/Book/p1.png"], kind: "image", name: "p1", dir: "Albums/Book", albumKey: "Albums/Book", size: 1, modified: 0, hasRaw: false, hasVideo: false } as MediaItem;

const urls = vi.hoisted(() => ({ made: 0, revoked: [] as string[] }));
URL.createObjectURL = () => `blob:${++urls.made}`;
URL.revokeObjectURL = (u: string) => void urls.revoked.push(u);

beforeEach(() => {
  calls.fetch.length = 0;
  calls.read.length = 0;
  calls.run.length = 0;
  urls.revoked.length = 0;
  useStore.setState({ root: "/vol", queue: [item], index: 0, screen: "viewer", allItems: [item], unsorted: [], vault: null, library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
  usePlugins.setState({ directions: [], overlays: {}, buttons: [], panels: {}, panelOpen: null } as never);
});

describe("plugin permissions", () => {
  it("only counts permissions that are both granted and still asked for", () => {
    const p = plugin(["media:read", "storage"], ["media:read", "overlay"]);
    expect(can(p, "media:read")).toBe(true);
    expect(can(p, "overlay")).toBe(false); // granted, but no longer in the manifest
    expect(can(p, "storage")).toBe(false); // asked, never granted
    expect(can(plugin(["media:read"], ["media:read"], { enabled: false }), "media:read")).toBe(false);
  });

  it("matches network hosts exactly, https only", () => {
    const p = plugin(["network:api.example.com", "network:*.example.net"]);
    expect(canFetch(p, "https://api.example.com/v1/pages")).toBe(true);
    expect(canFetch(p, "https://api.example.net/v2")).toBe(true);
    expect(canFetch(p, "https://example.net/")).toBe(true);
    expect(canFetch(p, "http://api.example.com/")).toBe(false);
    expect(canFetch(p, "https://api.example.com.evil.io/")).toBe(false);
    expect(canFetch(p, "https://evilexample.net/")).toBe(false);
    expect(canFetch(p, "not a url")).toBe(false);
  });
});

describe("plugin calls", () => {
  it("refuses calls without the permission", async () => {
    const none = plugin([]);
    await expect(dispatch(none, "media.readImage", { itemKey: item.key })).rejects.toThrow(/media:read/);
    await expect(dispatch(none, "overlay.set", { itemKey: item.key, boxes: [] })).rejects.toThrow(/overlay/);
    await expect(dispatch(none, "viewer.setDirection", { dir: "rtl" })).rejects.toThrow(/viewer/);
    await expect(dispatch(none, "storage.all", null)).rejects.toThrow(/storage/);
    await expect(dispatch(none, "net.fetch", { url: "https://api.example.com/v1/pages" })).rejects.toThrow(/not allowed/);
    expect(calls.read).toEqual([]);
    expect(calls.fetch).toEqual([]);
  });

  it("hides paths and names without media:read", () => {
    expect(metaFor(plugin([]), item)).toEqual({ key: item.key });
    const meta = metaFor(plugin(["media:read"]), item) as Record<string, unknown>;
    expect(meta.name).toBe("p1");
    expect(meta.albumKey).toBe("Albums/Book");
    expect(JSON.stringify(meta)).not.toContain("/vol");
  });

  it("blocks media while an encrypted folder is unlocked, unless allowed", async () => {
    useStore.setState({ vault: { exists: true, unlocked: true } } as never);
    await expect(dispatch(plugin(["media:read"]), "media.readImage", { itemKey: item.key })).rejects.toThrow(/encrypted/);
    await dispatch(plugin(["media:read"], ["media:read"], { allowVault: true }), "media.readImage", { itemKey: item.key });
    expect(calls.read).toEqual([item.primary]);
  });

  it("clamps overlay boxes and sets reading direction per album", async () => {
    const p = plugin(["overlay", "viewer"]);
    await dispatch(p, "overlay.set", { itemKey: item.key, boxes: [{ x: -1, y: 0.5, w: 3, h: 0.1, text: "Hi" }] });
    expect(usePlugins.getState().overlays[item.key].demo).toEqual([{ x: 0, y: 0.5, w: 1, h: 0.1, text: "Hi", vertical: false }]);
    await dispatch(p, "viewer.setDirection", { dir: "rtl", albumKey: "Albums/Book" });
    expect(directionFor("Albums/Book")).toBe("rtl");
    expect(directionFor("Albums/Other")).toBe("ltr");
  });

  it("shows images in overlay boxes and lets them go when replaced", async () => {
    const p = plugin(["overlay"]);
    const png = new Uint8Array([137, 80, 78, 71]);
    await dispatch(p, "overlay.set", { itemKey: item.key, boxes: [{ x: 0, y: 0, w: 1, h: 1, image: png, mime: "image/png" }] });
    const [box] = usePlugins.getState().overlays[item.key].demo;
    expect(box.image).toMatch(/^blob:/);
    expect(box.text).toBe("");
    await dispatch(p, "overlay.clear", { itemKey: item.key });
    expect(urls.revoked).toEqual([box.image]);
  });

  it("refuses overlay images it can't show, keeping what was there", async () => {
    const p = plugin(["overlay"]);
    await dispatch(p, "overlay.set", { itemKey: item.key, boxes: [{ x: 0, y: 0, w: 1, h: 1, text: "kept" }] });
    const made = urls.made;
    await expect(dispatch(p, "overlay.set", { itemKey: item.key, boxes: [{ image: new Uint8Array(4), mime: "image/svg+xml" }] })).rejects.toThrow(/mime/);
    await expect(dispatch(p, "overlay.set", { itemKey: item.key, boxes: [{ image: "not bytes", mime: "image/png" }] })).rejects.toThrow(/ArrayBuffer/);
    const five = Array.from({ length: 5 }, () => ({ image: new Uint8Array(4), mime: "image/png" }));
    await expect(dispatch(p, "overlay.set", { itemKey: item.key, boxes: five })).rejects.toThrow(/at most 4/);
    expect(urls.made).toBe(made);
    expect(usePlugins.getState().overlays[item.key].demo[0].text).toBe("kept");
  });

  it("runs a plugin's own pipeline only with the permission, and passes its options as JSON", async () => {
    await expect(dispatch(plugin(["media:read"]), "engine.run", { itemKey: item.key })).rejects.toThrow(/engine/);
    expect(calls.run).toEqual([]);
    const p = plugin(["media:read", "engine"]);
    const r = (await dispatch(p, "engine.run", { itemKey: item.key, options: { give: true, mask: new Uint8Array([1, 2, 3]), skip: () => 1 } })) as { bytes: ArrayBuffer; mime: string; result: unknown };
    expect(calls.run).toEqual([item.primary, { give: true, mask: btoa("\x01\x02\x03"), skip: null }]);
    expect(r.mime).toBe("image/png");
    expect(r.bytes.byteLength).toBe(3);
    expect(r.result).toEqual({ bars: [[50, 100, 20, 40]] });
    const none = (await dispatch(p, "engine.run", { itemKey: item.key })) as { bytes: unknown; mime: unknown };
    expect(none.bytes).toBeNull();
    expect(none.mime).toBeNull();
  });

  it("gives a plugin a panel, whose brush needs the viewer permission, and tells it what is used", async () => {
    const spec = { title: "Demo", controls: [{ type: "heading", label: "Page" }, { type: "button", id: "go", label: "Go", primary: true }, { type: "choice", id: "colour", label: "Colour", options: [{ id: "any", label: "Any" }, { id: "white", label: "White" }], value: "white" }, { type: "toggle", id: "album", label: "Album", value: false }, { type: "brush", id: "fix", modes: [{ id: "mark", label: "Bar" }, { id: "keep", label: "Not" }], mode: "mark" }] };
    await expect(dispatch(plugin([]), "ui.panel", spec)).rejects.toThrow(/viewer/);
    const p = plugin(["viewer"]);
    await dispatch(p, "ui.panel", spec);
    const panel = usePlugins.getState().panels.demo;
    expect(panel.controls.map((c) => c.type)).toEqual(["heading", "button", "choice", "toggle", "brush"]);
    expect(panel.controls[2]).toMatchObject({ value: "white" });
    await dispatch(p, "ui.panelOpen", { open: true });
    expect(usePlugins.getState().panelOpen).toBe("demo");
    panelAction("demo", "album", true);
    expect(usePlugins.getState().panels.demo.controls[3]).toMatchObject({ value: true });
    panelAction("demo", "fix", "keep");
    expect(usePlugins.getState().panels.demo.controls[4]).toMatchObject({ mode: "keep" });
    await dispatch(p, "ui.panelPatch", { id: "go", patch: { busy: true, label: "Going" } });
    expect(usePlugins.getState().panels.demo.controls[1]).toMatchObject({ busy: true, label: "Going" });
    await expect(dispatch(p, "ui.panel", { controls: [{ type: "mystery" }] })).rejects.toThrow(/unknown/);
  });

  it("draws outline boxes for highlights", async () => {
    const p = plugin(["overlay"]);
    await dispatch(p, "overlay.set", { itemKey: item.key, boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1, outline: true }] });
    expect(usePlugins.getState().overlays[item.key].demo[0]).toMatchObject({ outline: true, text: "" });
  });

  it("lets the reader choose between a copy and overwriting for a plugin's result", async () => {
    await expect(dispatch(plugin(["media:read"]), "media.keep", { itemKey: item.key, name: "p1 clean.png", base64: "AAAA" })).rejects.toThrow(/media:write/);
    const p = plugin(["media:write"]);
    const asked = dispatch(p, "media.keep", { itemKey: item.key, name: "p1 clean.png", base64: "AAAA" });
    expect(usePlugins.getState().keeping).toMatchObject({ pluginId: "demo", itemKey: item.key, name: "p1 clean.png" });
    await expect(dispatch(p, "media.keep", { itemKey: item.key, name: "x.png", base64: "AAAA" })).rejects.toThrow(/already/);
    await finishKeep("copy");
    await expect(asked).resolves.toEqual({ name: "p1 clean.png", key: "Albums/Book/p1 clean.png", replaced: false });
    expect(usePlugins.getState().keeping).toBeNull();
    const replaced = dispatch(p, "media.keep", { itemKey: item.key, name: "p1.png", base64: "AAAA" });
    await finishKeep("replace");
    await expect(replaced).resolves.toMatchObject({ replaced: true, key: "Albums/Book/p1.png" });
    expect(useStore.getState().queue[0].name).toBe("p1.png");
    const cancelled = dispatch(p, "media.keep", { itemKey: "Albums/Book/p1.png", name: "y.png", base64: "AAAA" });
    await finishKeep(null);
    await expect(cancelled).resolves.toBeNull();
    // A plugin that offers both in its own panel says which, and no dialog opens.
    await expect(dispatch(p, "media.keep", { itemKey: "Albums/Book/p1.png", name: "z.png", base64: "AAAA", choice: "copy" })).resolves.toMatchObject({ replaced: false, name: "z.png" });
    expect(usePlugins.getState().keeping).toBeNull();
  });

  it("links what it saves to the picture it was made from, called what the plugin calls it", async () => {
    const { api } = await import("../lib/api");
    const p = plugin(["media:write"]);
    await dispatch(p, "media.save", { itemKey: item.key, name: "p1 clean.png", base64: "AAAA" });
    expect(vi.mocked(api.writeMediaFile).mock.lastCall?.[4]).toEqual({ from: item.primary, by: "demo", note: null });
    await dispatch(p, "media.save", { itemKey: item.key, name: "p1 clean.png", base64: "AAAA", note: "  redrawn  " });
    expect(vi.mocked(api.writeMediaFile).mock.lastCall?.[4]).toMatchObject({ note: "redrawn" });
    // Saying nothing, it is what its duplicate check calls its versions.
    await dispatch(p, "dupes.versions", { spec: { id: "cleaned", label: "Check for cleaned versions", prefix: "Cleaned ", note: "cleaned" } });
    await dispatch(p, "media.keep", { itemKey: item.key, name: "Cleaned p1.webp", base64: "AAAA", choice: "replace" });
    expect(vi.mocked(api.replaceMediaFile).mock.lastCall?.slice(5)).toEqual(["demo", "cleaned"]);
    // In the original's place under its name, so an album's pages stay in order.
    expect(vi.mocked(api.replaceMediaFile).mock.lastCall?.[3]).toBe("p1.webp");
    usePlugins.getState().clearRuntime("demo");
    // Its tags and the rest follow it to its new key: done before the test's world is taken down.
    await vi.dynamicImportSettled();
  });

  it("tells a plugin what it made: a page written over its original, and the versions made from it still here", async () => {
    await expect(dispatch(plugin(["media:write"]), "media.versions", { itemKey: item.key })).rejects.toThrow(/media:read/);
    await expect(dispatch(plugin(["media:read"]), "media.versions", { itemKey: item.key })).resolves.toEqual({
      madeFrom: { name: "p0.png", note: "cleaned", mine: true, kept: true },
      made: [{ name: "p1 crop.png", note: "edited", mine: false }],
    });
  });

  it("passes allowed requests to the backend proxy", async () => {
    await dispatch(plugin(["network:api.example.com"]), "net.fetch", { url: "https://api.example.com/v1/pages", method: "POST", body: "{}" });
    expect(calls.fetch).toHaveLength(1);
  });

  it("dupes.versions: a plugin that writes files tells the duplicate check which are versions it made", async () => {
    const spec = { id: "cleaned", label: "Check for cleaned versions", prefix: "Cleaned ", keys: ["a/p1.png", 7, ""], note: "cleaned" };
    await expect(dispatch(plugin(["media:read"]), "dupes.versions", { spec })).rejects.toThrow(/media:write/);
    await dispatch(plugin(["media:write"]), "dupes.versions", { spec });
    expect(usePlugins.getState().dupeVersions.demo).toMatchObject({ pluginId: "demo", id: "cleaned", label: "Check for cleaned versions", prefix: "Cleaned ", keys: ["a/p1.png"], note: "cleaned" });
    usePlugins.getState().clearRuntime("demo");
    expect(usePlugins.getState().dupeVersions.demo).toBeUndefined();
    await dispatch(plugin(["media:write"]), "dupes.versions", { spec });
    await dispatch(plugin(["media:write"]), "dupes.versions", { spec: null });
    expect(usePlugins.getState().dupeVersions).toEqual({});
  });
});
describe("the Home's shared panels", () => {
  it("hold each plugin's part by the panel's name, replaced on each call, gone with null or the plugin", async () => {
    const p = plugin([]);
    const png = new Uint8Array([137, 80, 78, 71]);
    await dispatch(p, "home.share", { panel: "new-from-followed", spec: { title: "New from followed", items: [{ id: "w1", title: "A work", thumb: "https://img.example.com/1.jpg", work: "123" }, { id: "w2", title: "Another", image: png, mime: "image/png" }, { id: "w3", thumb: "http://plain.example.com/3.jpg" }] } });
    const part = usePlugins.getState().shared["new-from-followed"].demo;
    expect(part.title).toBe("New from followed");
    expect(part.items[0]).toEqual({ id: "w1", title: "A work", thumb: "https://img.example.com/1.jpg", work: "123" });
    expect(part.items[1].image).toMatch(/^blob:/);
    // Only https addresses: a plain one is left without a picture.
    expect(part.items[2]).toEqual({ id: "w3", title: "" });
    await dispatch(p, "home.share", { panel: "new-from-followed", spec: { items: [] } });
    expect(urls.revoked).toEqual([part.items[1].image]);
    await dispatch(p, "home.share", { panel: "new-from-followed", spec: null });
    expect(usePlugins.getState().shared["new-from-followed"]).toBeUndefined();
    await dispatch(p, "home.share", { panel: "picks", spec: { items: [{ id: "a" }] } });
    usePlugins.getState().clearRuntime("demo");
    expect(usePlugins.getState().shared).toEqual({});
  });

  it("refuse a panel name that isn't lowercase words with dashes, and more than 60 things", async () => {
    const p = plugin([]);
    await expect(dispatch(p, "home.share", { panel: "New Stuff", spec: { items: [] } })).rejects.toThrow(/lowercase words with dashes/);
    await expect(dispatch(p, "home.share", { panel: "many", spec: { items: Array.from({ length: 61 }, (_, i) => ({ id: String(i) })) } })).rejects.toThrow(/at most 60/);
  });
});
