import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: { scanDir: vi.fn(async () => []), loadTags: vi.fn(async () => null), tagsIndexLoad: vi.fn(async () => ({ auto: {}, indexed: {} })) },
  canThumb: () => true,
  thumbUrl: (_root: string, it: { primary: string }) => `thumb:${it.primary}`,
  mediaUrl: () => "",
  fileSrc: (p: string) => p,
  storedPath: (r: string, p: string) => p.slice(r.length + 1),
  setCurrentRoot: () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { useStore } = await import("../store");
const { MiniBrowser } = await import("../components/MiniBrowser");

const item = (key: string, extra: Partial<MediaItem> = {}): MediaItem =>
  ({ key, name: key.split("/").pop()!.replace(/\.[^.]+$/, ""), dir: key.slice(0, key.lastIndexOf("/")), primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", size: 1, modified: 0, hasRaw: false, hasVideo: false, ...extra }) as MediaItem;

describe("the mini browser", () => {
  it("shows the cover's own pictures or the library's (album pages left out), by folder and name, whole", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const own = [item("Trips/sea.jpg"), item("Trips/sun.jpg")];
    const lib = [...own, item("Pets/cat.jpg"), item("Pets/old/dog.jpg"), item("Albums/Manga/p1.jpg", { albumKey: "Albums/Manga" }), item("Clips/a.mp4", { kind: "video" })];
    useStore.setState({ root: "/vol", allItems: lib } as never);
    const picked: string[] = [];
    const backgrounds: string[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(MiniBrowser, { own, ownLabel: "This album", row: 110, onPick: (it: MediaItem) => picked.push(it.key), action: { label: "▣", title: "bg", onClick: (it: MediaItem) => backgrounds.push(it.key) } })));
    const shown = () => Array.from(host.querySelectorAll(".mini-tile")).map((t) => t.getAttribute("title"));
    expect(shown()).toEqual(["Trips/sea", "Trips/sun"]);
    // Whole pictures, sharp small copies.
    expect((host.querySelector(".mini-pick img") as HTMLImageElement).getAttribute("src")).toBe("thumb:/vol/Trips/sea.jpg");
    await act(async () => (Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Library") as HTMLButtonElement).click());
    expect(shown().sort()).toEqual(["Pets/cat", "Pets/old/dog", "Trips/sea", "Trips/sun"]); // no album page, no video
    // A folder (with what's in it), then a name.
    await act(async () => (host.querySelector(".mini-head .sel-btn") as HTMLButtonElement).click());
    await act(async () => (Array.from(document.querySelectorAll(".sel-opt")).find((o) => o.textContent === "Pets") as HTMLElement).click());
    expect(shown().sort()).toEqual(["Pets/cat", "Pets/old/dog"]);
    const input = host.querySelector(".mini-search input") as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(input, "do");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(shown()).toEqual(["Pets/old/dog"]);
    await act(async () => (host.querySelector(".mini-pick") as HTMLButtonElement).click());
    await act(async () => (host.querySelector(".mini-action") as HTMLButtonElement).click());
    expect(picked).toEqual(["Pets/old/dog.jpg"]);
    expect(backgrounds).toEqual(["Pets/old/dog.jpg"]);
    root.unmount();
  });
});
