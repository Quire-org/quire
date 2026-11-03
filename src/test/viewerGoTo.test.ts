import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  rawPreviewUrl: async () => "",
  fileSrc: (p: string) => p,
  pickFolder: async () => null,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isFullscreen: async () => false, setFullscreen: async () => {} }) }));
for (const name of ["ResizeObserver", "IntersectionObserver"])
  (globalThis as Record<string, unknown>)[name] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

const { Viewer } = await import("../screens/Viewer");
const { useStore } = await import("../store");
const { useFinders } = await import("../plugins/find");
const { useFind } = await import("../findStore");

const finder = (pluginId: string, name: string, icon: string | null) => ({ pluginId, name, icon, platform: pluginId, sections: [{ id: "feed", label: "Feed", kind: "works", options: [] }], sites: null });

describe("the viewer's Go to menu", () => {
  it("lists every platform of Find with its own icon, and opens the one picked", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pic = { key: "a.jpg", primary: "/vol/a.jpg", files: ["/vol/a.jpg"], kind: "image", name: "a", dir: "", size: 1, modified: 0, hasRaw: false, hasVideo: false };
    useStore.setState({ root: "/vol", screen: "viewer", library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } as never, queue: [pic as never], index: 0, source: { kind: "unsorted" }, editMode: false });
    const mark = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>');
    useFinders.setState({ finders: { one: finder("one", "Board", mark), two: finder("two", "Gallery", null) } as never });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Viewer)));
    await act(async () => (host.querySelector('button[title="Go to…"]') as HTMLButtonElement).click());
    const items = Array.from(document.querySelectorAll(".pop-list button")).filter((b) => /Board|Gallery/.test(b.textContent ?? ""));
    expect(items.map((b) => b.textContent?.trim())).toEqual(["Board", "Gallery"]);
    expect(items[0].querySelector("img.platform-icon")?.getAttribute("src")).toBe(mark);
    await act(async () => (items[1] as HTMLButtonElement).click());
    expect(useFind.getState().pluginId).toBe("two");
    expect(useStore.getState().screen).toBe("find");
    root.unmount();
  });
});
