import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const be = vi.hoisted(() => ({
  build: { version: "0.1.0", cannot: null as string | null },
  found: null as unknown,
  plugins: [] as unknown[],
  calls: [] as string[],
  claim: null as string | null,
}));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      appBuild: async () => be.build,
      appUpdateCheck: async () => (be.calls.push("check"), be.found),
      appUpdateDownload: async () => void be.calls.push("download"),
      appUpdateInstall: async () => void be.calls.push("install"),
      pluginCheckUpdates: async () => be.plugins,
      pluginUpdate: async (id: string, accept: boolean) => void be.calls.push(`plugin ${id} ${accept}`),
      pluginList: async () => [],
      libraryClaim: async (root: string) => {
        be.calls.push(`claim ${root}`);
        if (be.claim) throw be.claim;
      },
      libraryRelease: async () => void be.calls.push("release"),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useUpdates } = await import("../lib/updates");
const { usePlugins } = await import("../plugins/store");
const { useStore } = await import("../store");
const { startJob } = await import("../lib/jobs");
const { Updates } = await import("../screens/Updates");

afterAll(() => vi.dynamicImportSettled());

const manifest = (id: string, version: string) => ({ id, name: id.toUpperCase(), version, description: "", permissions: [] });
const pluginUpdate = (id: string, newPermissions: string[] = []) => ({ id, update: { id, current: "1.0.0", latest: "1.1.0", newPermissions, manifest: manifest(id, "1.1.0"), commit: "c" }, error: null });

beforeEach(() => {
  be.build = { version: "0.1.0", cannot: null };
  be.found = null;
  be.plugins = [];
  be.calls = [];
  be.claim = null;
  localStorage.clear();
  useUpdates.setState({ auto: false, build: null, app: null, appError: null, checking: false, checked: null, downloading: false });
  usePlugins.setState({ updates: {} });
  useStore.setState({ toasts: [], root: null } as never);
});

const toasts = () => useStore.getState().toasts.map((t) => t.text);

describe("updates", () => {
  it("are not checked as the app opens unless that is turned on, and the choice is kept", () => {
    expect(useUpdates.getState().auto).toBe(false);
    useUpdates.getState().setAuto(true);
    expect(JSON.parse(localStorage.getItem("quire.updates")!)).toEqual({ auto: true });
  });

  it("find a newer app and plugins in one check, and say so", async () => {
    be.found = { version: "0.2.0", notes: "Better", date: 1, downloaded: false };
    be.plugins = [pluginUpdate("a"), { id: "b", update: null, error: null }];
    await useUpdates.getState().check();
    expect(useUpdates.getState().app?.version).toBe("0.2.0");
    expect(Object.keys(usePlugins.getState().updates)).toEqual(["a", "b"]);
    expect(toasts()[0]).toBe("New: Quire 0.2.0, A 1.1.0. See Settings › Updates.");
  });

  it("don't go online for the app from a build that can't update itself (a dev build)", async () => {
    be.build = { version: "0.1.0", cannot: "This is a development build." };
    await useUpdates.getState().check(true);
    expect(be.calls).not.toContain("check");
    expect(toasts()).toEqual([]);
  });

  it("restart into the new version only once nothing is running", async () => {
    useUpdates.setState({ app: { version: "0.2.0", notes: null, date: null, downloaded: true } });
    const job = startJob({ title: "Encrypting", source: "Vault", total: 3, pause: { cannot: "x" }, stop: { cannot: "x" } });
    await useUpdates.getState().install();
    expect(be.calls).not.toContain("install");
    expect(toasts()[0]).toMatch(/Waiting for 1 job/);
    job.finish();
    await useUpdates.getState().install();
    expect(be.calls).toContain("install");
  });

  it("update the plugins asked for, and forget them as waiting", async () => {
    usePlugins.setState({ updates: { a: pluginUpdate("a"), c: pluginUpdate("c", ["network"]) } as never });
    await useUpdates.getState().updatePlugins(["a"]);
    expect(be.calls).toEqual(["plugin a false"]);
    expect(Object.keys(usePlugins.getState().updates)).toEqual(["c"]);
    expect(toasts()[0]).toBe("Updated A");
  });

  it("show in Settings, with a plugin asking for more sent to Plugins to review", async () => {
    useUpdates.setState({ build: { version: "0.1.0", cannot: null }, app: { version: "0.2.0", notes: "Better", date: null, downloaded: false }, checked: Date.now() });
    usePlugins.setState({ updates: { a: pluginUpdate("a"), c: pluginUpdate("c", ["network"]) } as never });
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Updates)));
    const text = host.textContent ?? "";
    expect(text).toContain("Quire 0.1.0. Checked just now.");
    expect(text).toContain("Quire 0.2.0");
    const buttons = Array.from(host.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["Download", "Update", "Review…"]));
    await act(async () => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Review…")!.click());
    expect(useStore.getState().pluginsOpen).toBe(true);
    root.unmount();
  });
});

describe("a library open in another copy of the app", () => {
  it("doesn't open here, and says why", async () => {
    be.claim = "This library is open in another copy of Quire.";
    await useStore.getState().openRoot("/vol");
    expect(be.calls).toEqual(["claim /vol"]);
    expect(useStore.getState().root).toBeNull();
    expect(toasts()).toEqual(["This library is open in another copy of Quire."]);
  });

  it("is let go of when it closes", async () => {
    useStore.getState().closeRoot();
    await new Promise((r) => setTimeout(r, 0));
    expect(be.calls).toContain("release");
  });
});
