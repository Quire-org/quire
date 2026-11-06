import { afterAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MediaItem } from "../lib/types";

const asked = vi.hoisted(() => [] as unknown[]);
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      // The tag index: b looks like the seed, c a little.
      tagsRank: async (_root: string, req: unknown) => (asked.push(req), [["in/b.jpg", 0.9], ["in/c.jpg", 0.6]]),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useStore, followMoves } = await import("../store");
const { showSimilar, toggleSignal, useSimilar, useSimilarOrder } = await import("../similarStore");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => vi.dynamicImportSettled());

const none = { tags: null, artistItems: undefined, peopleKeys: new Map<string, Set<string>>() };
const pic = (key: string): MediaItem => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: key, dir: "in", size: 1, modified: 0, hasRaw: false, hasVideo: false });

describe("Show similar", () => {
  it("opens Browse with the seed first and the most alike after it, as what is switched on has it", async () => {
    useStore.setState({ root: "/vol", screen: "viewer" });
    const all = ["in/a.jpg", "in/b.jpg", "in/c.jpg", "in/d.jpg"].map(pic);
    let got: ReturnType<typeof useSimilarOrder> = null;
    const Probe = () => ((got = useSimilarOrder(all, none)), null);
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    expect(got).toBeNull();
    await act(async () => showSimilar(all[0]));
    expect(useStore.getState().screen).toBe("browse");
    // Other videos' frames count too.
    expect(asked[0]).toMatchObject({ queries: [{ keys: ["in/a.jpg"] }], skip: ["in/a.jpg"], parts: true });
    // c's cosine is too low to count as alike.
    expect(got).toEqual({ keys: ["in/a.jpg", "in/b.jpg"], looking: false });
    await act(async () => toggleSignal("looks"));
    expect(got!.keys).toEqual(["in/a.jpg"]);
    root.unmount();
    // Back in Browse (from one of them opened), it is all there at once: the index isn't asked again.
    const again = createRoot(document.createElement("div"));
    await act(async () => again.render(createElement(Probe)));
    expect(asked).toHaveLength(1);
    expect(got!.looking).toBe(false);
    again.unmount();
  });

  it("asks by a video's frames, not their mean", async () => {
    const all = [{ ...pic("in/v.mp4"), kind: "video" as const }, pic("in/b.jpg")];
    const Probe = () => (useSimilarOrder(all, none), null);
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Probe)));
    await act(async () => showSimilar(all[0]));
    expect(asked[asked.length - 1]).toMatchObject({ queries: [{ parts: "in/v.mp4" }], parts: true });
    root.unmount();
  });

  it("goes on with its picture, and those it found, when they move, and ends with the library", async () => {
    useSimilar.setState({ seed: "in/a.jpg", off: [], looks: { of: "in/a.jpg", near: new Map([["in/b.jpg", 0.9]]) } });
    followMoves([["in", "kept"]]);
    await vi.dynamicImportSettled();
    expect(useSimilar.getState().seed).toBe("kept/a.jpg");
    expect(useSimilar.getState().looks).toEqual({ of: "kept/a.jpg", near: new Map([["kept/b.jpg", 0.9]]) });
    useStore.setState({ root: "/other" });
    expect(useSimilar.getState().seed).toBeNull();
  });
});
