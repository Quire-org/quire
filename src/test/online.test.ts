import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({ api: new Proxy({} as Record<string, unknown>, { get: () => async () => null }), fileSrc: (p: string) => p, mediaUrl: () => "", thumbUrl: () => "", canThumb: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useOnline, mayGoOnline } = await import("../lib/online");
const { dispatch } = await import("../plugins/host");
const { findImage } = await import("../findStore");
const { useStore } = await import("../store");

const plugin = { id: "demo", dir: "/x", manifest: { id: "demo", name: "Demo", version: "1.0.0", description: "", author: "", entry: "index.js", permissions: ["network:img.example.com"], settings: [] }, state: { enabled: true, allowVault: false, granted: ["network:img.example.com"], source: "", installedAt: 0 } } as never;

beforeEach(() => {
  localStorage.clear();
  useOnline.setState({ settings: { ask: false, each: false, keep: false }, connected: { all: false, platforms: [] } });
});

describe("asking before going online", () => {
  it("asks again once the vault has been locked, even for a platform kept connected", () => {
    useOnline.getState().set({ ask: true, each: true, keep: true });
    useStore.setState({ vault: { exists: true, unlocked: true } } as never);
    useOnline.getState().connect("look");
    expect(mayGoOnline("look")).toBe(true);
    useStore.setState({ vault: { exists: true, unlocked: false } } as never);
    expect(mayGoOnline("look")).toBe(false);
    useOnline.getState().set({ ask: false, each: false, keep: false });
  });

  it("lets everything out while it doesn't ask; asking, nothing until Connect, for all at once or each platform on its own", () => {
    expect(mayGoOnline("p1")).toBe(true);
    useOnline.getState().set({ ask: true });
    expect(mayGoOnline("p1")).toBe(false);
    useOnline.getState().connect("p1");
    expect(mayGoOnline("p2")).toBe(true);
    useOnline.getState().disconnect();
    useOnline.getState().set({ each: true });
    useOnline.getState().connect("p1");
    expect([mayGoOnline("p1"), mayGoOnline("p2")]).toEqual([true, false]);
  });

  it("keeps a connection across starts only when told to stay connected", () => {
    useOnline.getState().set({ ask: true, keep: true });
    useOnline.getState().connect();
    expect(JSON.parse(localStorage.getItem("quire.online.connected")!)).toMatchObject({ all: true });
    useOnline.getState().set({ keep: false });
    expect(localStorage.getItem("quire.online.connected")).toBeNull();
  });

  it("refuses an extension's requests and a platform's pictures until Connect", async () => {
    useOnline.getState().set({ ask: true });
    await expect(dispatch(plugin, "net.fetch", { url: "https://img.example.com/a.jpg" })).rejects.toThrow(/not connected/);
    await expect(findImage("demo", "https://img.example.com/a.jpg")).rejects.toThrow(/not connected/);
  });
});
