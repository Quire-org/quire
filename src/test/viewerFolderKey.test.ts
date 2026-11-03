import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../lib/types";

// In the viewer: a bucket's key files the picture by the day; ⇧ and the key ask which folder of yours in it.
const be = vi.hoisted(() => ({ dests: [] as string[] }));
vi.mock("../lib/api", () => {
  const tree: Record<string, string[]> = { Professional: ["Weddings", "2026"], "Professional/Weddings": [] };
  const known: Record<string, unknown> = {
    listDir: async (_r: string, dir: string) => (tree[dir] ?? []).map((name) => ({ name, path: `/vol/${dir}/${name}`, isDir: true, size: 0, modified: 0, encrypted: false, count: 0 })),
    scanAlbums: async () => [],
    moveItem: async (_r: string, item: MediaItem, dest: string) => {
      be.dests.push(dest);
      const key = `${dest}/${item.key.split("/").pop()}`;
      return { moved: [[item.primary, `/vol/${key}`]], item: { ...item, key, primary: `/vol/${key}`, files: [`/vol/${key}`], dir: dest } };
    },
  };
  return {
    api: new Proxy(known, { get: (t, k: string) => t[k] ?? (async () => null) }),
    storedPath: (root: string, p: string) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p),
    mediaUrl: () => "",
    thumbUrl: () => "",
    canThumb: () => false,
    rawPreviewUrl: async () => "",
    fileSrc: (p: string) => p,
    pickFolder: async () => null,
  };
});
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

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const pic = (name: string): MediaItem => ({ key: `Inbox/${name}`, primary: `/vol/Inbox/${name}`, files: [`/vol/Inbox/${name}`], kind: "image", name, dir: "Inbox", size: 1, modified: 0, hasRaw: false, hasVideo: false });
const press = (key: string, shiftKey = false) => window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("a bucket's key in the viewer", () => {
  it("files by the day; with ⇧ it asks which folder of yours, a new one too; a plain target's ⇧-key just moves", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 2, 12));
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const targets = [
      { id: "p", name: "Professional", path: "Professional", hotkey: "n", bucket: true },
      { id: "k", name: "Keepers", path: "Keepers", hotkey: "v" },
    ];
    const queue = [pic("a.jpg"), pic("b.jpg"), pic("c.jpg")];
    useStore.setState({ root: "/vol", screen: "viewer", busy: false, library: { version: 1, targets, ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } as never, queue, unsorted: queue, allItems: queue, index: 0, source: { kind: "unsorted" }, editMode: false, undoStack: [] } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Viewer)));

    await act(async () => press("n"));
    await act(async () => settle());
    expect(be.dests).toEqual(["Professional/2026/2026-11-02"]);

    await act(async () => press("N", true));
    await act(async () => settle());
    const input = document.querySelector(".own-folder-picker input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(Array.from(document.querySelectorAll(".own-folder-row")).map((r) => r.textContent)).toEqual(["Professional", "Professional › Weddings"]);
    // The viewer's own keys stay out of it while it is open: typing "n" moves nothing.
    await act(async () => type(input, "Weddings > Lena & Max"));
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => settle());
    expect(document.querySelector(".own-folder-picker")).toBeNull();
    expect(be.dests).toEqual(["Professional/2026/2026-11-02", "Professional/Weddings/Lena & Max/2026/2026-11-02"]);

    await act(async () => press("V", true));
    await act(async () => settle());
    expect(document.querySelector(".own-folder-picker")).toBeNull();
    expect(be.dests[be.dests.length - 1]).toBe("Keepers");
    root.unmount();
    vi.useRealTimers();
  });

  it("an album's page has no folders to sort into: no Move to bar, and a folder's key moves nothing", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    be.dests = [];
    const targets = [{ id: "p", name: "Professional", path: "Professional", hotkey: "n", bucket: true }];
    const page = { ...pic("p1.jpg"), key: "Albums/Comic/p1.jpg", primary: "/vol/Albums/Comic/p1.jpg", files: ["/vol/Albums/Comic/p1.jpg"], dir: "Albums/Comic", albumKey: "Albums/Comic" };
    useStore.setState({ root: "/vol", screen: "viewer", busy: false, library: { version: 1, targets, ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: ["Albums"], albumRatings: {} } as never, queue: [page], allItems: [page], albums: [], albumsLoaded: true, index: 0, source: { kind: "albums" }, editMode: false, undoStack: [] } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Viewer)));
    expect(host.querySelector(".targets")).toBeNull();
    await act(async () => press("n"));
    await act(async () => press("N", true));
    await act(async () => settle());
    expect(be.dests).toEqual([]);
    expect(document.querySelector(".own-folder-picker")).toBeNull();
    root.unmount();
  });
});
