import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: new Proxy(
    { findImage: async () => new ArrayBuffer(4) } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  fileSrc: (p: string) => p,
  mediaUrl: (i: { primary: string }) => `media:${i.primary}`,
  thumbUrl: (_r: string, i: { primary: string }, w: number) => `thumb:${i.primary}@${w}`,
  canThumb: () => true,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));
URL.createObjectURL = (b: Blob) => `blob:${(b as Blob & { size: number }).size}`;

const { useStore } = await import("../store");
const { finder } = await import("../plugins/find");
const { useSources } = await import("../findSource");
const { FindSourceDialog } = await import("../components/FindSourceDialog");
const { pageGroups, sameSite, shortUrl } = await import("../lib/artistPages");

const pic = { key: "in/a.jpg", primary: "/vol/in/a.jpg", files: ["/vol/in/a.jpg"], name: "a", kind: "image", dir: "in", size: 1, modified: 0, hasRaw: false, hasVideo: false } as MediaItem;
const match = (id: string) => ({
  item: { id, title: `Work ${id}`, author: { id: "a1", name: "Kaze", account: "kaze" }, url: null, thumb: `https://img.example.org/${id}-small.jpg`, width: 800, height: 1200, pages: 1, kind: "image" as const, tags: [], date: null, adult: false, ai: false, likes: 0, views: 0 },
  similarity: 0.9,
  pluginId: "look",
  platform: "example",
  name: "Example",
});

describe("a source found, compared", () => {
  it("opens both pictures large from either one, goes back with Esc, and takes a yes from there", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.setState({ root: "/vol", allItems: [pic], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, sources: {} } } as never);
    useSources.setState({ found: [{ key: pic.key, matches: [match("9")] }], open: true, running: false });
    const work = vi.spyOn(finder, "work").mockResolvedValue({ item: match("9").item, pages: [{ preview: "https://img.example.org/9-large.jpg", thumb: null }], caption: "" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(FindSourceDialog)));
    await act(async () => (document.body.querySelectorAll<HTMLButtonElement>("button.source-pic")[1]).click());
    for (let i = 0; i < 5; i++) await act(async () => {});
    const pics = document.body.querySelectorAll(".compare-pair img");
    expect(pics).toHaveLength(2);
    expect(pics[0].getAttribute("src")).toBe("thumb:/vol/in/a.jpg@1024");
    expect(work).toHaveBeenCalledWith("look", "9");
    expect(document.body.textContent).toContain("800×1200");
    // Esc: the list again, not the dialog closed.
    await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector(".source-compare")).toBeNull();
    expect(useSources.getState().open).toBe(true);
    await act(async () => (document.body.querySelectorAll<HTMLButtonElement>("button.source-pic")[0]).click());
    await act(async () => (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("Yes")) as HTMLButtonElement).click());
    expect(useStore.getState().library!.sources?.[pic.key]).toMatchObject({ platform: "example", id: "9" });
    work.mockRestore();
    root.unmount();
  });
});

describe("an artist's other pages", () => {
  it("are a site a line, the several addresses of an account together, each short", () => {
    const pages = [
      { label: "Gallery", url: "https://www.example.net/users/123" },
      { label: "Posts", url: "https://example.org/kaze" },
      { label: "Gallery", url: "https://www.example.net/stacc/kaze" },
      { label: "Posts", url: "https://example.com/kaze/" },
      { label: "Gallery", url: "https://www.example.net/users/123" },
    ];
    expect(pageGroups(pages).map((g) => [g.label, g.pages.map((p) => shortUrl(p.url))])).toEqual([
      ["Gallery", ["example.net/users/123", "example.net/stacc/kaze"]],
      ["Posts", ["example.org/kaze", "example.com/kaze"]],
    ]);
    expect(sameSite("https://www.example.net", "https://example.net/users/1")).toBe(true);
    expect(sameSite("https://www.example.net", "https://example.org/kaze")).toBe(false);
  });
});
