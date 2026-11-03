import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaItem } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {
    readMediaImage: vi.fn(async (_root: string, path: string) => (path.includes("broken") ? Promise.reject(new Error("unreadable")) : new ArrayBuffer(8))),
    saveLibrary: vi.fn(async () => {}),
    loadTags: vi.fn(async () => ({ version: 1, types: [], tags: {}, autoMap: {}, albums: {} })),
    tagsIndexLoad: vi.fn(async () => null),
    engineModels: vi.fn(async () => []),
    saveTags: vi.fn(async () => {}),
  },
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("../lib/smallJpeg", () => ({ smallJpeg: vi.fn(async () => "SMALL") }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { useStore } = await import("../store");
const { finder, useFinders } = await import("../plugins/find");
const { usePlugins } = await import("../plugins/store");
const { findSources, acceptMatch, notIt, useSources, MAYBE } = await import("../findSource");
const { useJobs } = await import("../lib/jobs");

const pic = (key: string, kind = "image") => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], name: key, kind, dir: "", size: 1, modified: 0, hasRaw: false, hasVideo: false }) as unknown as MediaItem;
const work = (id: string, similarity: number) => ({
  item: { id, title: `Work ${id}`, author: { id: "a1", name: "Kaze", account: "kaze" }, url: `https://example.org/posts/${id}`, thumb: `https://img.example.org/${id}.jpg`, width: 1, height: 1, pages: 1, kind: "image" as const, tags: [{ name: "someone_(series)", translated: null, kind: "character" as const }], date: null, adult: false, ai: false, likes: 0, views: 0 },
  similarity,
});

beforeEach(() => {
  useStore.setState({ root: "/vol", vault: null, library: { sources: { "had.jpg": { platform: "example", id: "1" } } }, allItems: [pic("a.jpg"), pic("b.jpg"), pic("had.jpg")] } as never);
  useFinders.setState({ finders: { look: { pluginId: "look", platform: "example", name: "Example", lookup: true } as never, plain: { pluginId: "plain", platform: "plain", name: "Plain", lookup: false } as never } });
  usePlugins.setState({ list: [{ id: "look", state: { enabled: true, allowVault: false } }] } as never);
  useSources.setState({ found: [], open: false, running: false });
});

describe("Find source", () => {
  it("looks up the pictures without a source on the platforms that can, as a job, keeping what is alike enough", async () => {
    const lookup = vi.spyOn(finder, "lookup").mockImplementation(async (_id, image) => (expect(image).toBe("SMALL"), [work("9", 0.97), work("8", 0.6), work("7", MAYBE - 0.01)]));
    const jobs: string[] = [];
    const unsub = useJobs.subscribe((s) => s.jobs.forEach((j) => jobs.push(j.title)));
    await findSources([pic("a.jpg"), pic("had.jpg"), pic("v.mp4", "video"), pic("broken.jpg")]);
    unsub();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toBe("look");
    expect(jobs.some((t) => /Finding sources of 2 pictures on Example/.test(t))).toBe(true);
    const found = useSources.getState().found;
    expect(found.map((f) => [f.key, f.matches.map((m) => m.item.id)])).toEqual([["a.jpg", ["9", "8"]]]);
    expect(useSources.getState().open).toBe(true);
    lookup.mockRestore();
  });

  it("makes a match said yes to the picture's source, and shows the next one for a no", async () => {
    useSources.setState({ found: [{ key: "a.jpg", matches: [{ ...work("9", 0.97), pluginId: "look", platform: "example", name: "Example" }, { ...work("8", 0.6), pluginId: "look", platform: "example", name: "Example" }] }], open: true });
    notIt("a.jpg", useSources.getState().found[0].matches[0]);
    expect(useSources.getState().found[0].matches.map((m) => m.item.id)).toEqual(["8"]);
    acceptMatch("a.jpg", useSources.getState().found[0].matches[0]);
    expect(useSources.getState().found).toEqual([]);
    expect(useSources.getState().open).toBe(false);
    const src = useStore.getState().library!.sources!["a.jpg"];
    expect(src).toMatchObject({ platform: "example", id: "8", url: "https://example.org/posts/8", author: { name: "Kaze" } });
    expect(src.tags[0].kind).toBe("character");
  });

  it("stops at a platform that can't (signed out), and says so", async () => {
    const lookup = vi.spyOn(finder, "lookup").mockRejectedValue(new Error("Sign in to look pictures up"));
    const toast = vi.spyOn(useStore.getState(), "toast");
    await findSources([pic("a.jpg"), pic("b.jpg")]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls.map((c) => c[0])).toContain("Example: Sign in to look pictures up");
    lookup.mockRestore();
  });

  it("sends nothing from an open encrypted folder to a platform not allowed there", async () => {
    useStore.setState({ vault: { exists: true, unlocked: true } } as never);
    const lookup = vi.spyOn(finder, "lookup");
    await findSources([pic("a.jpg")]);
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
  });
});
