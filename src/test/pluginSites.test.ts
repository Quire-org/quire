import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../plugins/types";

const calls = vi.hoisted(() => ({ kept: {} as Record<string, unknown>, told: [] as unknown[], checks: [] as unknown[], yes: true }));

vi.mock("../lib/api", () => ({
  api: {
    // The library's store (in its vault when it has one), and what the backend is told.
    pluginLibraryGet: vi.fn(async (id: string, root: string, key: string) => calls.kept[`${root}|${id}|${key}`] ?? null),
    pluginLibrarySet: vi.fn(async (id: string, root: string, key: string, value: unknown) => void (calls.kept[`${root}|${id}|${key}`] = value)),
    pluginSitesSet: vi.fn(async (id: string, sites: string[]) => (calls.told.push([id, sites]), sites)),
    pluginCheck: vi.fn(async (...a: unknown[]) => (calls.checks.push(a), { cookies: "cf_clearance=ok", userAgent: "Window/1" })),
    pluginBrowse: vi.fn(async (...a: unknown[]) => (calls.checks.push(["browse", ...a]), { status: 200, body: "<html>page</html>" })),
    pluginSettingsGet: vi.fn(async () => ({})),
  },
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
vi.mock("../components/Confirm", () => ({ ask: vi.fn(async () => calls.yes) }));

function plugin(permissions: string[], sites: string[] = [], granted = permissions): PluginInfo {
  return {
    id: "demo",
    dir: "/x",
    manifest: { id: "demo", name: "Demo", version: "1.0.0", description: "", author: "", entry: "index.js", permissions, settings: [] },
    state: { enabled: true, allowVault: false, granted, source: "", installedAt: 0 },
    sites,
  };
}

const { dispatch } = await import("../plugins/host");
const { canFetch, canLogin, describePermission } = await import("../plugins/permissions");
const { usePlugins } = await import("../plugins/store");
const { useStore } = await import("../store");

beforeEach(() => {
  calls.kept = {};
  calls.told.length = 0;
  calls.checks.length = 0;
  calls.yes = true;
  usePlugins.setState({ list: [plugin(["find", "sites"])], sites: {} } as never);
  useStore.setState({ root: "/vol", toast: vi.fn() } as never);
});

describe("sites the reader adds to a plugin", () => {
  it("are its hosts with their subdomains, to contact and open, only with the permission", () => {
    const p = plugin(["find", "sites"], ["gallery.example"]);
    expect(canFetch(p, "https://gallery.example/gallery/1/")).toBe(true);
    expect(canFetch(p, "https://i3.gallery.example/1/1.jpg")).toBe(true);
    expect(canLogin(p, "https://gallery.example/")).toBe(true);
    expect(canFetch(p, "https://other.example/")).toBe(false);
    expect(canFetch(plugin(["find", "sites"], ["gallery.example"], ["find"]), "https://gallery.example/")).toBe(false);
    expect(describePermission("sites").sensitive).toBe(true);
  });

  it("are added when the reader says yes, by their domain, kept with the library open, and removed", async () => {
    const p = usePlugins.getState().list[0];
    await expect(dispatch(p, "sites.add", { url: "not a site" })).rejects.toThrow(/isn't a site's address/);
    expect(await dispatch(p, "sites.add", { url: "https://www.Gallery.example/some/page" })).toBe("gallery.example");
    expect(calls.kept["/vol|demo|__sites"]).toEqual(["gallery.example"]);
    expect(calls.told).toEqual([["demo", ["gallery.example"]]]);
    expect(await dispatch(usePlugins.getState().list[0], "sites.list", {})).toEqual(["gallery.example"]);
    expect(usePlugins.getState().list[0].sites).toEqual(["gallery.example"]);
    calls.yes = false;
    expect(await dispatch(usePlugins.getState().list[0], "sites.add", { url: "other.example" })).toBeNull();
    await dispatch(usePlugins.getState().list[0], "sites.remove", { domain: "gallery.example" });
    expect(calls.kept["/vol|demo|__sites"]).toEqual([]);
    await expect(dispatch(plugin(["find"]), "sites.list", {})).rejects.toThrow(/"sites" was not granted/);
    // The plugin's own store has no say over them.
    await expect(dispatch(plugin(["find", "sites", "library:storage"]), "library.set", { key: "__sites", value: ["evil.example"] })).rejects.toThrow(/keys starting with __ are the app's/);
  });

  it("are another library's when another opens, and none without one", async () => {
    calls.kept["/vol|demo|__sites"] = ["a.example"];
    calls.kept["/other|demo|__sites"] = ["b.example"];
    await usePlugins.getState().loadSites("/vol");
    expect(usePlugins.getState().sites.demo).toEqual(["a.example"]);
    await usePlugins.getState().loadSites("/other");
    expect(usePlugins.getState().list[0].sites).toEqual(["b.example"]);
    await usePlugins.getState().loadSites(null);
    expect(calls.told[calls.told.length - 1]).toEqual(["demo", []]);
  });

  it("can have their browser check passed, on a site it may open", async () => {
    const p = plugin(["find", "sites"], ["gallery.example"]);
    expect(await dispatch(p, "login.check", { url: "https://gallery.example/", name: "Gallery" })).toEqual({ cookies: "cf_clearance=ok", userAgent: "Window/1" });
    expect(calls.checks).toEqual([["demo", "https://gallery.example/", "Gallery"]]);
    await expect(dispatch(p, "login.check", { url: "https://other.example/" })).rejects.toThrow(/not allowed to open other.example/);
  });

  it("can have their pages read through their browser session, with the cookies kept from the check", async () => {
    const p = plugin(["find", "sites"], ["gallery.example"]);
    expect(await dispatch(p, "net.browse", { url: "https://gallery.example/gallery/1/", cookies: "cf_clearance=ok" })).toEqual({ status: 200, body: "<html>page</html>" });
    expect(calls.checks).toEqual([["browse", "demo", "https://gallery.example/gallery/1/", "cf_clearance=ok"]]);
    await expect(dispatch(p, "net.browse", { url: "https://other.example/" })).rejects.toThrow(/not allowed to open other.example/);
  });
});
