import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MediaItem } from "../lib/types";

// The app's own folder browser, for choosing a folder of the library (the system's dialog can't see
// into a vault). A made-up library at /vol.
const be = vi.hoisted(() => ({ tree: {} as Record<string, string[]>, made: [] as [string, string][], outside: null as string | null }));
vi.mock("../lib/api", () => {
  const known: Record<string, unknown> = {
    listDir: vi.fn(async (_root: string, dir: string) =>
      (be.tree[dir] ?? []).map((name) => ({ name, path: `${dir}/${name}`, isDir: !name.includes("."), size: 0, modified: 0, encrypted: true, count: 3 })),
    ),
    fsMkdir: vi.fn(async (_root: string, dir: string, name: string) => {
      be.made.push([dir, name]);
      be.tree[dir] = [...(be.tree[dir] ?? []), name];
      return `${dir}/${name}`;
    }),
  };
  return {
    api: new Proxy(known, { get: (t, k: string) => t[k] ?? (async () => null) }),
    pickFolder: vi.fn(async () => be.outside),
    canThumb: () => true,
    thumbUrl: (_root: string, it: { primary: string }) => `thumb:${it.primary}`,
    mediaUrl: () => "",
    fileSrc: (p: string) => p,
    storedPath: (root: string, p: string) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p),
    setCurrentRoot: () => {},
  };
});
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));

const { useStore } = await import("../store");
const { FolderBrowserHost, notForAlbums, notForTarget, pickLibraryFolder } = await import("../components/FolderBrowser");

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const pic = (key: string): MediaItem => ({ key, name: key.split("/").pop()!, dir: key.slice(0, key.lastIndexOf("/")), primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", size: 1, modified: 0, hasRaw: false, hasVideo: false });
const library = { version: 1, targets: [{ id: "k", name: "Keepers", path: "Keepers", hotkey: "v" }], trashDir: "_deleted", albumRoots: ["/vol/Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {} };
const button = (text: string) => Array.from(document.querySelectorAll(".folder-browser button")).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;
const tiles = () => Array.from(document.querySelectorAll(".folder-card")).map((t) => t.querySelector(".file-tile-name")?.textContent);
const tile = (name: string) => Array.from(document.querySelectorAll(".folder-card")).find((t) => t.querySelector(".file-tile-name")?.textContent === name) as HTMLButtonElement;
const crumbs = () => Array.from(document.querySelectorAll(".folder-browser .crumb")).map((c) => c.textContent);
const find = () => document.querySelector(".folder-browser-find input") as HTMLInputElement;
const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const press = (el: Element, key: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

let root: Root;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  be.tree = {
    "/vol": ["Professional", "Keepers", "Albums", "_deleted", ".quire.vault", "notes.txt"],
    "/vol/Professional": ["Weddings", "2026"],
    "/vol/Professional/Weddings": [],
    "/vol/Albums": ["Comic"],
  };
  be.made = [];
  be.outside = null;
  useStore.setState({ root: "/vol", library, allItems: [pic("Professional/Weddings/a.jpg"), pic("Professional/2026/2026-11-02/b.jpg"), pic("Professional/Weddings/2026/c.jpg"), pic("Keepers/d.jpg")], allLoaded: true, allStale: false } as never);
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(FolderBrowserHost)));
});
afterEach(() => root.unmount());

async function open(p: Parameters<typeof pickLibraryFolder>[0]) {
  let answer: string | null | undefined;
  const done = pickLibraryFolder(p).then((a) => (answer = a));
  await act(async () => settle());
  return { answer: () => answer, done };
}

describe("choosing a folder of the library", () => {
  it("shows the folders where it opens, each with pictures from inside it; the trash and hidden ones aren't", async () => {
    const got = await open({ title: "Choose a target folder" });
    expect(tiles()).toEqual(["Albums", "Keepers", "Professional"]);
    // Professional's tile: the pictures from inside it, at any depth (up to four).
    expect(Array.from(tile("Professional").querySelectorAll("img")).map((i) => i.getAttribute("src"))).toEqual(["thumb:/vol/Professional/Weddings/a.jpg", "thumb:/vol/Professional/2026/2026-11-02/b.jpg", "thumb:/vol/Professional/Weddings/2026/c.jpg"]);
    expect(tile("Albums").querySelector("img")).toBeNull();
    // The top can't be chosen as a target.
    expect(button("Choose").disabled).toBe(true);
    expect(document.querySelector(".folder-browser .pop-actions")?.textContent).toContain("The library itself");
    await act(async () => tile("Professional").click());
    await act(async () => settle());
    expect(crumbs()).toEqual(["Professional"]);
    expect(tiles()).toEqual(["2026", "Weddings"]);
    await act(async () => tile("Weddings").click());
    await act(async () => settle());
    expect(crumbs()).toEqual(["Professional", "Weddings"]);
    expect(document.querySelector(".folder-browser-empty")?.textContent).toBe("No folders in here.");
    await act(async () => button("Choose “Weddings”").click());
    await got.done;
    expect(got.answer()).toBe("/vol/Professional/Weddings");
    expect(document.querySelector(".folder-browser")).toBeNull();
  });

  it("says why a folder can't be chosen, on its tile and when in it", async () => {
    const got = await open({ title: "Choose a target folder", why: notForTarget(library as never, "/vol") });
    expect(tile("Keepers").textContent).toContain("A target folder already");
    expect(tile("Albums").textContent).toContain("In an album folder");
    await act(async () => tile("Albums").click());
    await act(async () => settle());
    expect(button("Choose").disabled).toBe(true);
    await act(async () => tile("Comic").click());
    await act(async () => settle());
    expect(button("Choose").disabled).toBe(true);
    expect(document.querySelector(".folder-browser .pop-actions")?.textContent).toContain("In an album folder");
    await act(async () => press(find(), "Escape"));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await got.done;
    expect(got.answer()).toBeNull();
  });

  it("opens where it is asked to (the top when that isn't in the library), ⌫ goes up, ⏎ goes in or chooses", async () => {
    const got = await open({ title: "Move into…", start: "/vol/Professional/Weddings", allowTop: true, confirm: "Move here" });
    expect(crumbs()).toEqual(["Professional", "Weddings"]);
    await act(async () => press(find(), "Backspace"));
    await act(async () => settle());
    expect(crumbs()).toEqual(["Professional"]);
    await act(async () => type(find(), "wed"));
    expect(tiles()).toEqual(["Weddings"]);
    await act(async () => press(find(), "Enter"));
    await act(async () => settle());
    expect(crumbs()).toEqual(["Professional", "Weddings"]);
    await act(async () => press(find(), "Enter"));
    await got.done;
    expect(got.answer()).toBe("/vol/Professional/Weddings");

    const again = await open({ title: "Move into…", start: "/elsewhere/Pictures", allowTop: true, confirm: "Move here" });
    expect(crumbs()).toEqual([]);
    // The top is allowed here: moving something to the library's top level.
    await act(async () => button("Move here").click());
    await again.done;
    expect(again.answer()).toBe("/vol");
  });

  it("makes a new folder where it is, and goes into it", async () => {
    const got = await open({ title: "Choose a target folder", start: "Professional/Weddings" });
    await act(async () => button("New folder").click());
    const name = document.querySelector('.folder-browser-new input') as HTMLInputElement;
    await act(async () => type(name, "Lena & Max"));
    await act(async () => (document.querySelector(".folder-browser-new button[type=submit]") as HTMLButtonElement).click());
    await act(async () => settle());
    expect(be.made).toEqual([["/vol/Professional/Weddings", "Lena & Max"]]);
    expect(crumbs()).toEqual(["Professional", "Weddings", "Lena & Max"]);
    await act(async () => button("Choose “Lena & Max”").click());
    await got.done;
    expect(got.answer()).toBe("/vol/Professional/Weddings/Lena & Max");
  });

  it("can take a folder outside the library, from the system's dialog, when asked to", async () => {
    const plain = await open({ title: "Choose a folder" });
    expect(button("Outside the library")).toBeUndefined();
    // Asked again before answering: the first is cancelled.
    be.outside = "/Users/someone/Elsewhere";
    const got = await open({ title: "Choose a target folder", outside: true });
    await plain.done;
    expect(plain.answer()).toBeNull();
    await act(async () => button("Outside the library").click());
    await got.done;
    expect(got.answer()).toBe("/Users/someone/Elsewhere");
  });

  it("knows what can't be an album folder or a target", () => {
    const albums = notForAlbums(library as never, "/vol");
    expect(albums("Albums")).toBe("An album folder already, or in one");
    expect(albums("Albums/Comic")).toBe("An album folder already, or in one");
    expect(albums("_deleted/x")).toBe("The trash");
    expect(albums("Comics")).toBeNull();
    const target = notForTarget(library as never, "/vol");
    expect(target("Keepers")).toBe("A target folder already");
    expect(target("Keepers/Best")).toBeNull();
    expect(target("_deleted")).toBe("The trash");
  });
});
