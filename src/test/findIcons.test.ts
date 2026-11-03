import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const be = vi.hoisted(() => ({ saved: [] as unknown[] }));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      findStateLoad: async () => ({ baskets: {}, icons: { "https://made-up.example/icon.png": "data:image/png;base64,AAAA", "https://made-up.example/bad.png": "not a picture" } }),
      findStateSave: async (_r: string, d: unknown) => void be.saved.push(d),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useStore } = await import("../store");
const { useFind } = await import("../findStore");
const { useOnline } = await import("../lib/online");
const { PlatformIcon } = await import("../components/PlatformIcon");

describe("platform icons kept with the library", () => {
  it("show while Quire waits to go online, and new ones are kept with Find's state", async () => {
    useStore.setState({ root: "/vol" } as never);
    useOnline.setState({ settings: { ask: true, each: false, keep: false }, connected: { all: false, platforms: [] } });
    await useFind.getState().loadBaskets();
    // Only pictures are kept: the bad entry is dropped as it is read.
    expect(Object.keys(useFind.getState().icons)).toEqual(["https://made-up.example/icon.png"]);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(PlatformIcon, { pluginId: "made-up", url: "https://made-up.example/icon.png" })));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    root.unmount();
    useFind.getState().keepIcon("https://made-up.example/site.png", "data:image/png;base64,BBBB");
    useFind.getState().keepIcon("https://made-up.example/huge.png", `data:image/png;base64,${"A".repeat(200_000)}`);
    expect(Object.keys(useFind.getState().icons)).toEqual(["https://made-up.example/icon.png", "https://made-up.example/site.png"]);
    await vi.waitFor(() => expect(be.saved.length).toBeGreaterThan(0));
    expect((be.saved[be.saved.length - 1] as { icons: Record<string, string> }).icons["https://made-up.example/site.png"]).toBe("data:image/png;base64,BBBB");
  });
});
