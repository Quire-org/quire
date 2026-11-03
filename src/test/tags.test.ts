import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem, TagData } from "../lib/types";

const saved = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("../lib/api", () => ({
  api: {
    loadTags: vi.fn(async () => null),
    saveTags: vi.fn(async (_root: string, data: unknown) => void (saved.data = data)),
    tagsTagNames: vi.fn(async () => [{ name: "general", category: 9 }, { name: "cat", category: 0 }]),
    tagsEmbedText: vi.fn(async (text: string) => Array.from({ length: 512 }, (_, i) => Math.sin(i + text.length))),
    tagsIndex: vi.fn(async () => 0),
    tagsCancel: vi.fn(async () => {}),
    tagsPause: vi.fn(async () => {}),
    scanDir: vi.fn(async () => []),
    // The backend's tag index: the embeddings and the similarity search live there.
    tagsIndexLoad: vi.fn(async () => ({ auto: {}, indexed: {}, embedded: 2, embedder: "siglip2", tagger: "pixai", next: null })),
    tagsIndexRename: vi.fn(async () => {}),
    // The backend learns from the saved tags: once p1 is saved as a cat, cats are likely elsewhere.
    tagsPredict: vi.fn(async () => ((saved.data as TagData | null)?.tags?.["Pics/p1.jpg"]?.includes("motives/cat") ? [{ tag: "motives/cat", p: 0.9, examples: true }] : [])),
    tagsCandidates: vi.fn(async () => []),
    tagsScores: vi.fn(async () => []),
  },
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  pickFolder: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

// Thumbnails load when seen; jsdom has no observer, so they never do here (fine, they aren't the point).
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { Tags } = await import("../screens/Tags");
const { useStore } = await import("../store");
const { useTags, tagsOfType } = await import("../tagsStore");

const item = (n: number): MediaItem => ({ key: `Pics/p${n}.jpg`, primary: `/vol/Pics/p${n}.jpg`, files: [`/vol/Pics/p${n}.jpg`], kind: "image", name: `p${n}`, dir: "Pics", size: 1, modified: 0, hasRaw: false, hasVideo: false }) as MediaItem;

describe("tags", () => {
  it("shows the types and tags, puts a tag on a selection, and suggests from the nearest tagged picture", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.setState({ root: "/vol", screen: "tags", allItems: [item(1), item(2), item(3)], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Tags)));
    await act(async () => {});
    expect(host.textContent).toContain("motives");
    // A tag on p1 (saved before the backend is asked, at once), then p2 gets it suggested.
    await act(async () => useTags.getState().setTag(["Pics/p1.jpg"], "motives/cat", true));
    expect(tagsOfType(useTags.getState().data!, "motives")).toEqual([{ id: "motives/cat", name: "cat", count: 1 }]);
    const suggested = await useTags.getState().suggest(["Pics/p2.jpg"]);
    expect(suggested.map((s) => s.tag)).toContain("motives/cat");
    await act(async () => useTags.getState().setFilter("all"));
    await act(async () => useTags.getState().select(new Set(["Pics/p2.jpg"])));
    await act(async () => {}); // the suggestions come back from the backend
    const chip = Array.from(host.querySelectorAll("button.chip.suggest")).find((b) => b.textContent?.includes("cat"));
    expect(chip).toBeTruthy();
    await act(async () => (chip as HTMLButtonElement).click());
    expect(useTags.getState().tagsOf("Pics/p2.jpg")).toEqual(["motives/cat"]);
    await new Promise((r) => setTimeout(r, 500));
    expect((saved.data as TagData).tags["Pics/p2.jpg"]).toEqual(["motives/cat"]);
    // What the models found is the backend's to keep: never in the tags file.
    expect(saved.data).not.toHaveProperty("auto");
    expect(saved.data).not.toHaveProperty("indexed");
    root.unmount();
  });
});
