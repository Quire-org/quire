import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const be = vi.hoisted(() => ({ moved: [] as [string, string][], made: [] as string[], tags: null as unknown }));
vi.mock("../lib/api", () => ({
  api: {
    saveLibrary: vi.fn(async () => {}),
    saveTags: vi.fn(async () => {}),
    loadTags: vi.fn(async () => be.tags),
    tagsIndexLoad: vi.fn(async () => ({ auto: {}, indexed: {} })),
    scanAll: vi.fn(async () => []),
    loadCache: vi.fn(async () => null),
    saveHistory: vi.fn(async () => {}),
    listDir: vi.fn(async () => []),
    fsMkdir: vi.fn(async (_r: string, _d: string, name: string) => void be.made.push(name)),
    moveItem: vi.fn(async (_r: string, item: { key: string; primary: string }, dest: string) => {
      be.moved.push([item.key, dest]);
      const to = `${dest}/${item.key.split("/").pop()}`;
      return { moved: [[item.primary, `/vol/${to}`]], item: { ...item, key: to, primary: `/vol/${to}`, dir: dest } };
    }),
  },
  storedPath: (r: string, p: string) => p.slice(r.length + 1),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

const { useStore } = await import("../store");
const { useTags, withPlaces } = await import("../tagsStore");
const { FolderInspector } = await import("../components/TagSide");

const item = (key: string, targetId?: string) => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "image", name: key.split("/").pop()!, dir: key.slice(0, key.lastIndexOf("/")), size: 1, modified: 0, hasRaw: false, hasVideo: false, targetId });
const library = (targets: unknown[]) => ({ version: 1, targets, trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {} });
const tags = (extra: object = {}) => ({ version: 1, types: ["where", "motives"], tags: { "Private/2026/2026-10-28/a.jpg": ["motives/sea"], "Pics/stray.jpg": ["where/work"] }, autoMap: {}, albums: {}, auto: {}, indexed: {}, ...extra });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("bucket folders in Tags", () => {
  it("give each picture the tag of the bucket it is in, and none outside them", () => {
    const d = tags({ places: ["where"], placeOf: { "where/home": "p", "where/work": "w" } });
    const items = [item("Private/2026/2026-10-28/a.jpg", "p"), item("Pics/stray.jpg"), item("Work/2026/b.jpg", "w"), item("Albums/x/1.jpg", "p")];
    items[3] = { ...items[3], albumKey: "Albums/x" } as never;
    const next = withPlaces(d as never, items as never);
    expect(next.tags["Private/2026/2026-10-28/a.jpg"]).toEqual(["motives/sea", "where/home"]);
    expect(next.tags["Work/2026/b.jpg"]).toEqual(["where/work"]);
    // Out of every bucket: the bucket tag goes (it was wrong).
    expect(next.tags["Pics/stray.jpg"]).toBeUndefined();
    // Album pages stay out of it.
    expect(next.tags["Albums/x/1.jpg"]).toBeUndefined();
    // Nothing changed: the same data back.
    expect(withPlaces(next, items as never)).toBe(next);
  });

  it("setting a bucket tag moves the pictures into that bucket, filed by the day; taking it off doesn't", async () => {
    be.moved = [];
    const a = item("Pics/a.jpg");
    // The tags file is there before the library opens (opening it starts the tags loading).
    be.tags = tags({ places: ["where"], exclusive: ["where"], placeOf: { "where/home": "p" }, tags: { "": ["where/home"] } });
    useStore.setState({ root: "/vol", busy: false, library: library([{ id: "p", name: "Private", path: "Private", hotkey: "1", bucket: true }]), allItems: [a], unsorted: [a], allLoaded: true, allStale: false } as never);
    await act(async () => useTags.getState().load());
    await act(async () => useTags.getState().setTag(["Pics/a.jpg"], "where/home", true));
    await act(async () => settle());
    expect(be.moved).toHaveLength(1);
    expect(be.moved[0][1]).toMatch(/^Private\/\d{4}\/\d{4}-\d{2}-\d{2}$/);
    // The tag follows the picture to its new place.
    const moved = useStore.getState().allItems[0];
    expect(useTags.getState().data!.tags[moved.key]).toEqual(["where/home"]);
    await act(async () => useTags.getState().setTag([moved.key], "where/home", false));
    expect(be.moved).toHaveLength(1);
    expect(useTags.getState().data!.tags[moved.key]).toEqual(["where/home"]);
  });

  it("the folder's settings: made a bucket folder (pick one), and each tag given its folder", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    be.made = [];
    useStore.setState({ root: "/vol", library: library([]), allItems: [], allLoaded: true, allStale: false } as never);
    useTags.setState({ data: tags({ tags: { "": ["where/home", "where/work"] } }) as never, loaded: true });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const props = { type: "where", onClose: () => {}, onOpenTag: () => {}, onPreviews: () => {}, onConflicts: () => {} };
    await act(async () => root.render(createElement(FolderInspector, props)));
    const check = (label: string) => Array.from(host.querySelectorAll("label.check")).find((l) => l.textContent?.includes(label))!.querySelector("input") as HTMLInputElement;
    await act(async () => check("Bucket folder").click());
    expect(useTags.getState().data!.places).toEqual(["where"]);
    expect(useTags.getState().data!.exclusive).toEqual(["where"]);
    expect(check("Pick one").disabled).toBe(true);
    expect(host.querySelector(".place-missing")?.textContent).toContain("2 tags have no folder yet");
    // "home" gets a new bucket of its name.
    const pick = host.querySelectorAll(".place-row")[0];
    await act(async () => (pick.querySelector(".sel-btn, button") as HTMLButtonElement).click());
    const option = Array.from(document.querySelectorAll(".sel-pop button, .sel-pop [role=option]")).find((o) => o.textContent?.includes("New bucket: home/")) as HTMLElement;
    await act(async () => option.click());
    await act(async () => settle());
    expect(be.made).toEqual(["home"]);
    const bucket = useStore.getState().library!.targets[0];
    expect(bucket).toMatchObject({ path: "home", bucket: true });
    expect(useTags.getState().data!.placeOf).toEqual({ "where/home": bucket.id });
    expect(host.querySelector(".place-missing")?.textContent).toContain("A tag has no folder yet");
    root.unmount();
  });
});
