import { describe, expect, it } from "vitest";
import { useTags } from "../tagsStore";
import { useStore } from "../store";
import type { MediaItem, TagData } from "../lib/types";

const page = (key: string, albumKey?: string) => ({ key, primary: `/r/${key}`, files: [`/r/${key}`], name: key.split("/").pop(), kind: "image", dir: "", size: 1, modified: 0, hasRaw: false, hasVideo: false, albumKey }) as unknown as MediaItem;
const data = (tags: Record<string, string[]>): TagData => ({ version: 1, types: ["motives"], tags, embeddings: {}, scales: {}, auto: {}, indexed: {}, autoMap: {}, albums: {} }) as unknown as TagData;

describe("albums are tagged whole", () => {
  it("moves tags from album pages onto the album when the library is read", () => {
    useTags.setState({ data: data({ "A/1.jpg": ["motives/sea"], "A/2.jpg": ["motives/sky"], "loose.jpg": ["motives/sea"] }), loaded: true });
    useStore.setState({ allItems: [page("A/1.jpg", "A"), page("A/2.jpg", "A"), page("loose.jpg")] });
    const tags = useTags.getState().data!.tags;
    expect(tags["album:A"]?.sort()).toEqual(["motives/sea", "motives/sky"]);
    expect(tags["A/1.jpg"]).toBeUndefined();
    expect(tags["A/2.jpg"]).toBeUndefined();
    expect(tags["loose.jpg"]).toEqual(["motives/sea"]);
  });
  it("tagging a page tags its album", () => {
    useTags.getState().setTag(["A/2.jpg"], "motives/night", true);
    const tags = useTags.getState().data!.tags;
    expect(tags["album:A"]).toContain("motives/night");
    expect(tags["A/2.jpg"]).toBeUndefined();
  });
});
