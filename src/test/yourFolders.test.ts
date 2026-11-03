import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { DirEntryInfo, MediaItem, Target } from "../lib/types";

// Folders of yours in a bucket, at any depth, filed by the day in each: the rules, Sort, Import,
// Organise, and moves made in Files (in and out of buckets). A made-up library at /vol.
const be = vi.hoisted(() => ({
  tree: {} as Record<string, string[]>,
  counts: {} as Record<string, number>,
  movedItems: [] as { key: string; dest: string }[],
  moved: [] as [string[], string][],
  renamed: [] as [string, string][],
  scans: 0,
  // The drive slow to answer: folders listed only when let go.
  hold: false,
}));
vi.mock("../lib/api", () => {
  const known: Record<string, unknown> = {
    // A folder's entries: its folders from the tree, and as many files as it is said to hold.
    listDir: vi.fn(async (_root: string, dir: string) => {
      if (be.hold) await new Promise(() => {});
      const rel = dir.startsWith("/vol/") ? dir.slice(5) : dir === "/vol" ? "" : dir;
      if (rel === "unreadable") throw new Error("no");
      const dirs = (be.tree[rel] ?? []).map((name) => ({ name, path: `/vol/${rel ? `${rel}/` : ""}${name}`, isDir: true, size: 0, modified: 0, encrypted: false, count: 1 }));
      const files = Array.from({ length: be.counts[rel] ?? 0 }, (_, i) => ({ name: `f${i}.jpg`, path: `/vol/${rel}/f${i}.jpg`, isDir: false, size: 1, modified: 0, encrypted: false, count: 0 }));
      return [...dirs, ...files] as DirEntryInfo[];
    }),
    moveItem: vi.fn(async (_r: string, item: MediaItem, dest: string) => {
      be.movedItems.push({ key: item.key, dest });
      const to = (f: string) => `/vol/${dest}/${f.split("/").pop()}`;
      const key = `${dest}/${item.key.split("/").pop()}`;
      return { moved: item.files.map((f) => [f, to(f)]), item: { ...item, key, primary: `/vol/${key}`, files: item.files.map(to), dir: dest } };
    }),
    fsMove: vi.fn(async (_r: string, paths: string[], dest: string) => {
      be.moved.push([paths, dest]);
      return paths.map((p) => `${dest}/${p.split("/").pop()}`);
    }),
    fsRename: vi.fn(async (_r: string, path: string, name: string) => {
      const to = `${path.slice(0, path.lastIndexOf("/"))}/${name}`;
      be.renamed.push([path, to]);
      return to;
    }),
    scanUnsorted: vi.fn(async () => {
      be.scans++;
      return [];
    }),
    scanAll: vi.fn(async () => []),
    scanDir: vi.fn(async () => []),
    tagsIndexLoad: vi.fn(async () => ({ auto: {}, indexed: {} })),
  };
  // Everything else the store and the stores following moves ask: nothing there, nothing to say.
  return {
    api: new Proxy(known, { get: (t, k: string) => t[k] ?? (async () => null) }),
    storedPath: (root: string, p: string) => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p),
    setCurrentRoot: () => {},
    fileSrc: (p: string) => p,
    mediaUrl: () => "",
    thumbUrl: () => "",
    canThumb: () => false,
    pickFolder: async () => null,
  };
});
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

const filing = await import("../lib/filing");
const { PART, bucketOf, dateNamedInBucket, filedFolder, folderUnder, inTarget, isFilingName, ownFolderOf, ownFolders, planParts, targetFor, typedFolders } = filing;
const { useStore } = await import("../store");
const { withPlaces } = await import("../tagsStore");
const { filterPictures } = await import("../components/PictureFilters");
const { OwnFolderPicker } = await import("../components/OwnFolderPicker");
const { TargetBar } = await import("../components/TargetBar");
const { ImportDialog } = await import("../components/ImportDialog");
const { OrganiseDialog, keptName } = await import("../components/OrganiseDialog");
const { RESERVED_KEYS, suggestHotkey } = await import("../lib/hotkeys");

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const item = (key: string, targetId?: string, files?: string[]): MediaItem => ({
  key,
  name: key.split("/").pop()!.replace(/\.[^.]+$/, ""),
  dir: key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "",
  primary: `/vol/${key}`,
  files: files ?? [`/vol/${key}`],
  kind: "image",
  size: 1,
  modified: 0,
  hasRaw: false,
  hasVideo: false,
  targetId,
});

// Two buckets; Weddings in Professional has a key of its own; Keepers is a plain target, outside every bucket.
const P: Target = { id: "p", name: "Professional", path: "Professional", hotkey: "n", bucket: true };
const Q: Target = { id: "q", name: "Personal", path: "Personal", hotkey: "j", bucket: true };
const W: Target = { id: "w", name: "Weddings", path: "Professional/Weddings", hotkey: "y" };
const K: Target = { id: "k", name: "Keepers", path: "Keepers", hotkey: "v" };
const targets = [P, Q, W, K];
const library = (over: Record<string, unknown> = {}) => ({ version: 1, targets, trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {}, ...over });

function fresh(state: Record<string, unknown> = {}) {
  be.tree = {
    "": ["Professional", "Personal", "Keepers", "Inbox", "Albums", "_deleted"],
    Professional: ["Weddings", "2026", ".hidden"],
    "Professional/Weddings": ["James & Amy", "2025"],
    "Professional/Weddings/James & Amy": [],
    Personal: ["Paris trip"],
    "Personal/Paris trip": [],
  };
  be.counts = {};
  be.movedItems = [];
  be.moved = [];
  be.renamed = [];
  be.scans = 0;
  be.hold = false;
  useStore.setState({ root: "/vol", busy: false, toasts: [], viewed: {}, library: library(), unsorted: [], queue: [], index: 0, allItems: [], allLoaded: true, allStale: false, source: { kind: "unsorted" }, undoStack: [], seriesTogether: false, ...state } as never);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 2, 12));
  fresh();
});
afterEach(() => vi.useRealTimers());

function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  return createRoot(host);
}
const button = (text: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;
const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const last = <T,>(list: T[]): T => list[list.length - 1];
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("the rules", () => {
  it("knows the folders filing makes from yours", () => {
    for (const n of ["2026", "2026-03-14", "2026-03-14, part 2", "2026-03-14 Wedding Jansen"]) expect(isFilingName(n)).toBe(true);
    for (const n of ["2019 Holidays", "Weddings", "20260", "2026-3-14", "Paris 2026-03-14"]) expect(isFilingName(n)).toBe(false);
  });

  it("finds the folder of yours a folder is in, at any depth, within its bucket", () => {
    expect(ownFolderOf("Professional/Weddings/James & Amy/2026/2026-11-02", "Professional")).toBe("Professional/Weddings/James & Amy");
    expect(ownFolderOf("Professional/2026/2026-11-02, part 2", "Professional")).toBe("Professional");
    expect(ownFolderOf("Professional/Weddings", "Professional")).toBe("Professional/Weddings");
    // A folder made inside a day is part of that day, not a folder of yours.
    expect(ownFolderOf("Professional/2026/2026-11-02/Extra", "Professional")).toBe("Professional");
    // A bucket named like a year still holds folders of yours: names count from inside it.
    expect(ownFolderOf("2019/Trip/2026/2026-01-01", "2019")).toBe("2019/Trip");
    expect(filedFolder("Professional/Weddings/James & Amy", new Date())).toBe("Professional/Weddings/James & Amy/2026/2026-11-02");
  });

  it("reads typed folder paths, made safe, and refuses one that reads as a date", () => {
    expect(typedFolders("Weddings > James & Amy")).toEqual({ names: ["Weddings", "James & Amy"] });
    expect(typedFolders("Weddings/James & Amy").names).toEqual(["Weddings", "James & Amy"]);
    expect(typedFolders("  > Paris trip >  ").names).toEqual(["Paris trip"]);
    expect(typedFolders('What? "Now".').names).toEqual(["What- -Now-"]);
    expect(typedFolders("")).toEqual({ names: [] });
    expect(typedFolders("Trips > 2019").bad).toBe("2019");
    expect(typedFolders("2026-03-14 Wedding").bad).toBe("2026-03-14 Wedding");
  });

  it("spells a typed folder as the one there is, in any case or way of writing an accent", () => {
    const known = ["Professional", "Professional/Weddings", "Professional/Weddings/James & Amy", "Professional/Café"];
    expect(folderUnder("Professional", ["weddings", "JAMES & AMY"], known)).toBe("Professional/Weddings/James & Amy");
    expect(folderUnder("Professional", ["Weddings", "Lena & Max"], known)).toBe("Professional/Weddings/Lena & Max");
    expect(folderUnder("Professional", ["café"], known)).toBe("Professional/Café");
    // Only a folder right under the one before counts: James & Amy isn't in Professional itself.
    expect(folderUnder("Professional", ["James & Amy"], known)).toBe("Professional/James & Amy");
  });

  it("keeps a pair together in parts, in the next part when the one filling hasn't room for both", () => {
    const files = ["/card/IMG_1.CR2", "/card/IMG_1.JPG", "/card/IMG_2.jpg", "/card/IMG_2.MOV", "/card/x/IMG_2.jpg"];
    const plan = planParts(files, "B", (f) => (f === "B" ? PART - 1 : 0));
    const dest = Object.fromEntries(plan.map((p) => [p.src, p.dest]));
    expect(dest["/card/IMG_1.CR2"]).toBe("B, part 2");
    expect(dest["/card/IMG_1.JPG"]).toBe("B, part 2");
    // Same name in another folder: not a pair.
    expect(plan).toHaveLength(5);
    expect(new Set(plan.map((p) => p.dest))).toEqual(new Set(["B, part 2"]));
    const roomy = planParts(["/c/a.jpg", "/c/b.jpg"], "B", (f) => (f === "B" ? PART - 1 : 0));
    expect(roomy.map((p) => p.dest)).toEqual(["B", "B, part 2"]);
  });

  it("says which target holds a path, and which targets file by the day", () => {
    expect(targetFor("Professional/Weddings/James & Amy/2026", targets)?.id).toBe("w");
    expect(targetFor("Professional/2026/2026-11-02", targets)?.id).toBe("p");
    expect(targetFor("Professionals/x", targets)).toBeUndefined();
    expect(bucketOf(P, targets)?.id).toBe("p");
    expect(bucketOf(W, targets)?.id).toBe("p");
    expect(bucketOf(K, targets)).toBeUndefined();
    expect(bucketOf({ id: "out", name: "Out", path: "/elsewhere/Out", hotkey: "" }, targets)).toBeUndefined();
    // Weddings' pictures are in Professional; Professional's own aren't in Weddings.
    expect(inTarget(item("Professional/Weddings/a.jpg", "w"), P, targets)).toBe(true);
    expect(inTarget(item("Professional/b.jpg", "p"), W, targets)).toBe(false);
    expect(dateNamedInBucket("Professional/Weddings/2019", targets)).toBe("2019");
    expect(dateNamedInBucket("Inbox/2019", targets)).toBeNull();
    expect(dateNamedInBucket("Professional/Weddings", targets)).toBeNull();
    expect(keptName("2019")).toBe("2019 (kept)");
    expect(keptName("Old phone")).toBe("Old phone");
  });

  it("lists the folders of yours from a bucket down, empty ones too, never the filing ones or hidden ones", async () => {
    be.tree.Professional = ["Weddings", "2026", ".hidden", "Locked", "Albums"];
    be.tree["Professional/2026"] = ["2026-11-02"];
    be.tree["Professional/Locked"] = ["Inside"];
    be.tree["Professional/Albums"] = ["Comic"];
    // Locked can't be read: it is there, with nothing seen in it. Albums (an album folder) is left out.
    const list = (d: string) => (d === "Professional/Locked" ? Promise.reject(new Error("no")) : import("../lib/api").then(({ api }) => api.listDir("/vol", d)));
    const got = await ownFolders("Professional", list, (abs) => abs.slice(5), new Set(["Professional/Albums"]));
    expect(got).toEqual(["Professional", "Professional/Locked", "Professional/Weddings", "Professional/Weddings/James & Amy"]);
  });

  it("can't give a target a key the viewer has (P is People, W artists, L tags, K the scrapbook)", () => {
    for (const k of ["p", "w", "l", "k"]) expect(RESERVED_KEYS.has(k)).toBe(true);
    const k = suggestHotkey("Professional", []);
    expect(k).not.toBe("p");
    expect(RESERVED_KEYS.has(k)).toBe(false);
  });
});

describe("sorting into folders of yours", () => {
  it("files into the bucket's own day, or the day of the folder chosen in it, at any depth", async () => {
    const a = item("Inbox/a.jpg");
    fresh({ unsorted: [a], queue: [a] });
    await act(async () => void (await useStore.getState().moveItem(a, "p")));
    expect(last(be.movedItems)).toEqual({ key: "Inbox/a.jpg", dest: "Professional/2026/2026-11-02" });

    const b = item("Inbox/b.jpg");
    fresh({ unsorted: [b], queue: [b] });
    await act(async () => void (await useStore.getState().moveItem(b, "p", false, undefined, "Professional/Weddings/James & Amy")));
    expect(last(be.movedItems)!.dest).toBe("Professional/Weddings/James & Amy/2026/2026-11-02");
    // It is in the deepest target holding it now, and the toast says where.
    expect(useStore.getState().allItems.find((i) => i.name === "b")?.targetId).toBe("w");
    expect(last(useStore.getState().toasts)?.text).toBe("→ Professional › Weddings › James & Amy");

    // A folder that isn't in the target: the target's own day.
    const c = item("Inbox/c.jpg");
    fresh({ unsorted: [c], queue: [c] });
    await act(async () => void (await useStore.getState().moveItem(c, "p", false, undefined, "Personal/Paris trip")));
    expect(last(be.movedItems)!.dest).toBe("Professional/2026/2026-11-02");
  });

  it("files a target inside a bucket by the day too; one outside every bucket takes it as it is", async () => {
    const a = item("Inbox/a.jpg");
    fresh({ unsorted: [a], queue: [a] });
    await act(async () => void (await useStore.getState().moveItem(a, "w")));
    expect(last(be.movedItems)!.dest).toBe("Professional/Weddings/2026/2026-11-02");
    const b = item("Inbox/b.jpg");
    fresh({ unsorted: [b], queue: [b] });
    await act(async () => void (await useStore.getState().moveItem(b, "k")));
    expect(last(be.movedItems)!.dest).toBe("Keepers");
  });

  it("leaves a picture where it is when it is in the target, or the folder chosen, already", async () => {
    const z = item("Professional/Weddings/2026/2026-11-01/z.jpg", "w");
    fresh({ allItems: [z] });
    for (const [target, folder] of [["p", undefined], ["w", undefined], ["p", "Professional/Weddings"]] as const) {
      expect(await useStore.getState().moveItem(z, target, false, undefined, folder)).toBe(true);
    }
    expect(be.movedItems).toEqual([]);
    // Another folder of the bucket: it moves.
    await act(async () => void (await useStore.getState().moveItem(z, "p", false, undefined, "Professional/Weddings/James & Amy")));
    expect(last(be.movedItems)!.dest).toBe("Professional/Weddings/James & Amy/2026/2026-11-02");
  });

  it("puts a pair where there is room for both of its files", async () => {
    be.counts["Professional/2026/2026-11-02"] = PART - 1;
    const pair = item("Inbox/IMG_1.JPG", undefined, ["/vol/Inbox/IMG_1.JPG", "/vol/Inbox/IMG_1.CR2"]);
    fresh({ unsorted: [pair], queue: [pair] });
    be.counts["Professional/2026/2026-11-02"] = PART - 1;
    await act(async () => void (await useStore.getState().moveItem(pair, "p")));
    expect(last(be.movedItems)!.dest).toBe("Professional/2026/2026-11-02, part 2");
    const one = item("Inbox/IMG_2.JPG");
    fresh({ unsorted: [one], queue: [one] });
    be.counts["Professional/2026/2026-11-02"] = PART - 1;
    await act(async () => void (await useStore.getState().moveItem(one, "p")));
    expect(last(be.movedItems)!.dest).toBe("Professional/2026/2026-11-02");
  });

  it("moves a series kept together into the folder chosen, every picture of it", async () => {
    const a = item("Inbox/s1.jpg");
    const b = item("Inbox/s2.jpg");
    fresh({ unsorted: [a, b], queue: [a, b], seriesTogether: true, library: library({ series: [["Inbox/s1.jpg", "Inbox/s2.jpg"]] }) });
    await act(async () => void (await useStore.getState().moveCurrent("p", "Personal/Paris trip")));
    // Paris trip is in Personal, not Professional: the bucket's own day for both.
    expect(be.movedItems.map((m) => m.dest)).toEqual(["Professional/2026/2026-11-02", "Professional/2026/2026-11-02"]);
    const c = item("Inbox/s3.jpg");
    const d = item("Inbox/s4.jpg");
    fresh({ unsorted: [c, d], queue: [c, d], seriesTogether: true, library: library({ series: [["Inbox/s3.jpg", "Inbox/s4.jpg"]] }) });
    await act(async () => void (await useStore.getState().moveCurrent("q", "Personal/Paris trip")));
    expect(be.movedItems.map((m) => m.dest)).toEqual(["Personal/Paris trip/2026/2026-11-02", "Personal/Paris trip/2026/2026-11-02"]);
  });
});

describe("moves made in Files", () => {
  it("into a bucket: out of the Sort queue at once, in the target that holds it, its rating with it", async () => {
    const a = item("Inbox/a.jpg");
    const b = item("Inbox/b.jpg");
    fresh({ unsorted: [a, b], queue: [a, b], index: 1, allItems: [a, b], library: library({ ratings: { "Inbox/a.jpg": 8 } }) });
    await act(async () => useStore.getState().relocatePaths([["/vol/Inbox/a.jpg", "/vol/Professional/Weddings/a.jpg"]]));
    await act(async () => settle());
    const s = useStore.getState();
    expect(s.unsorted.map((i) => i.key)).toEqual(["Inbox/b.jpg"]);
    // The picture shown (b) stays the one shown.
    expect(s.queue.map((i) => i.key)).toEqual(["Inbox/b.jpg"]);
    expect(s.index).toBe(0);
    expect(s.allItems.find((i) => i.name === "a")).toMatchObject({ key: "Professional/Weddings/a.jpg", dir: "Professional/Weddings", targetId: "w" });
    expect(s.library!.ratings).toEqual({ "Professional/Weddings/a.jpg": 8 });
    expect(be.scans).toBe(0);
  });

  it("the picture shown moved into a bucket: the next one shows", async () => {
    const a = item("Inbox/a.jpg");
    const b = item("Inbox/b.jpg");
    fresh({ unsorted: [a, b], queue: [a, b], index: 0, allItems: [a, b] });
    await act(async () => useStore.getState().relocatePaths([["/vol/Inbox/a.jpg", "/vol/Personal/a.jpg"]]));
    expect(useStore.getState().queue[useStore.getState().index].key).toBe("Inbox/b.jpg");
  });

  it("a whole folder into a bucket: everything in it leaves the queue", async () => {
    const a = item("Trip/a.jpg");
    const b = item("Trip/day 2/b.jpg");
    const c = item("Inbox/c.jpg");
    fresh({ unsorted: [a, b, c], queue: [a, b, c], allItems: [a, b, c] });
    await act(async () => useStore.getState().relocatePaths([["/vol/Trip", "/vol/Personal/Trip"]]));
    const s = useStore.getState();
    expect(s.unsorted.map((i) => i.key)).toEqual(["Inbox/c.jpg"]);
    expect(s.allItems.filter((i) => i.targetId === "q").map((i) => i.key)).toEqual(["Personal/Trip/a.jpg", "Personal/Trip/day 2/b.jpg"]);
  });

  it("out of a bucket to where Sort looks: in no target, and found again by a scan", async () => {
    const x = item("Professional/2026/2026-11-01/x.jpg", "p");
    fresh({ allItems: [x] });
    await act(async () => useStore.getState().relocatePaths([["/vol/Professional/2026/2026-11-01/x.jpg", "/vol/Inbox/x.jpg"]]));
    await act(async () => settle());
    expect(useStore.getState().allItems[0]).toMatchObject({ key: "Inbox/x.jpg", targetId: undefined });
    expect(be.scans).toBe(1);
  });

  it("a folder with a key of its own moved to another bucket: the key goes with it, and it files there", async () => {
    const a = item("Professional/Weddings/2026/2026-11-01/a.jpg", "w");
    fresh({ allItems: [a] });
    await act(async () => useStore.getState().relocatePaths([["/vol/Professional/Weddings", "/vol/Personal/Weddings"]]));
    await act(async () => settle());
    const s = useStore.getState();
    const w = s.library!.targets.find((t) => t.id === "w")!;
    expect(w.path).toBe("Personal/Weddings");
    expect(bucketOf(w, s.library!.targets)?.id).toBe("q");
    expect(s.allItems[0]).toMatchObject({ key: "Personal/Weddings/2026/2026-11-01/a.jpg", targetId: "w" });
    // Still in a target: nothing to scan for.
    expect(be.scans).toBe(0);
  });

  it("within where Sort looks: still in the queue, under its new path", async () => {
    const d = item("Inbox/d.jpg");
    fresh({ unsorted: [d], queue: [d], allItems: [d] });
    await act(async () => useStore.getState().relocatePaths([["/vol/Inbox/d.jpg", "/vol/Inbox/Old/d.jpg"]]));
    expect(useStore.getState().unsorted.map((i) => i.key)).toEqual(["Inbox/Old/d.jpg"]);
    expect(be.scans).toBe(0);
  });

  it("into the trash or an album folder: out of the queue too", async () => {
    const a = item("Inbox/a.jpg");
    const b = item("Inbox/b.jpg");
    fresh({ unsorted: [a, b], queue: [a, b], allItems: [a, b] });
    await act(async () => useStore.getState().relocatePaths([["/vol/Inbox/a.jpg", "/vol/_deleted/a.jpg"], ["/vol/Inbox/b.jpg", "/vol/Albums/Comic/b.jpg"]]));
    expect(useStore.getState().unsorted).toEqual([]);
  });
});

describe("pictures in a folder with a key of its own count for the bucket around it", () => {
  it("in Browse's filter and the bucket's tag", () => {
    const inW = item("Professional/Weddings/2026/2026-11-01/a.jpg", "w");
    const inP = item("Professional/2026/2026-11-01/b.jpg", "p");
    const out = item("Inbox/c.jpg");
    const d = { viewed: {}, tags: null, ratings: {}, artistItems: undefined, peopleKeys: new Map() } as never;
    expect(filterPictures([inW, inP, out], { location: "p" }, d).map((i) => i.key)).toEqual([inW.key, inP.key]);
    expect(filterPictures([inW, inP, out], { location: "w" }, d).map((i) => i.key)).toEqual([inW.key]);
    const tags = { version: 1, types: ["where"], tags: {}, autoMap: {}, albums: {}, places: ["where"], exclusive: ["where"], placeOf: { "where/work": "p" } } as never;
    const placed = withPlaces(tags, [inW, inP], targets);
    expect((placed as { tags: Record<string, string[]> }).tags[inW.key]).toEqual(["where/work"]);
    expect((placed as { tags: Record<string, string[]> }).tags[inP.key]).toEqual(["where/work"]);
  });
});

describe("the folder picker (⇧ and a bucket's key)", () => {
  async function open(onPick = vi.fn()) {
    const root = mount();
    await act(async () => root.render(createElement(OwnFolderPicker, { target: P, onPick, onClose: () => {} })));
    await act(async () => settle());
    return { root, onPick, input: document.querySelector(".own-folder-picker input") as HTMLInputElement, rows: () => Array.from(document.querySelectorAll(".own-folder-row")).map((r) => r.textContent) };
  }

  it("lists the folders of yours, finds them by typing, and Enter picks the one marked", async () => {
    const { root, onPick, input, rows } = await open();
    expect(rows()).toEqual(["Professional", "Professional › Weddings", "Professional › Weddings › James & Amy"]);
    await act(async () => type(input, "jam"));
    expect(rows()).toEqual(["Professional › Weddings › James & Amy", "New folder: Professional › jam"]);
    await act(async () => key(input, "Enter"));
    expect(onPick).toHaveBeenCalledWith("Professional/Weddings/James & Amy");
    root.unmount();
  });

  it("makes a new folder at any depth, spelled as the ones there; one named like a date it won't", async () => {
    const { root, onPick, input, rows } = await open();
    await act(async () => type(input, "weddings > Lena & Max"));
    expect(rows()).toEqual(["New folder: Professional › Weddings › Lena & Max"]);
    await act(async () => key(input, "Enter"));
    expect(onPick).toHaveBeenCalledWith("Professional/Weddings/Lena & Max");
    // The one there, typed in another case: that one, not a second.
    await act(async () => type(input, "WEDDINGS > james & amy"));
    expect(rows()[0]).toBe("Professional › Weddings › James & Amy");
    await act(async () => type(input, "Weddings > 2019"));
    expect(rows().some((r) => r?.startsWith("New folder"))).toBe(false);
    expect(document.querySelector(".own-folder-picker .warn-text")?.textContent).toContain("“2019” would read as one of the year or day folders");
    root.unmount();
  });

  it("makes no new folder before the folders there are read (one there in another case would be made twice)", async () => {
    be.hold = true;
    const { root, input, rows } = await open();
    expect(document.querySelector(".own-folder-picker")?.textContent).toContain("Reading its folders…");
    await act(async () => type(input, "weddings"));
    expect(rows()).toEqual([]);
    root.unmount();
  });

  it("↓ and ↑ mark the next and the one before", async () => {
    const { root, onPick, input } = await open();
    await act(async () => key(input, "ArrowDown"));
    await act(async () => key(input, "ArrowDown"));
    await act(async () => key(input, "ArrowUp"));
    await act(async () => key(input, "Enter"));
    expect(onPick).toHaveBeenCalledWith("Professional/Weddings");
    root.unmount();
  });

  it("opens from the target bar with ⇧-click, only on a target that files by the day", async () => {
    const onMove = vi.fn();
    const onChoose = vi.fn();
    const root = mount();
    await act(async () => root.render(createElement(TargetBar, { targets, onMove, onChoose, onAdd: () => {}, disabled: false })));
    const btn = (name: string) => Array.from(document.querySelectorAll(".target-btn")).find((b) => b.textContent?.includes(name)) as HTMLButtonElement;
    await act(async () => btn("Professional").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(onChoose).toHaveBeenCalledWith(P);
    await act(async () => btn("Weddings").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(onChoose).toHaveBeenLastCalledWith(W);
    await act(async () => btn("Keepers").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(onMove).toHaveBeenCalledWith("k");
    await act(async () => btn("Professional").click());
    expect(onMove).toHaveBeenLastCalledWith("p");
    root.unmount();
  });
});

describe("importing into folders of yours", () => {
  it("names no new folder before the folders there are read", async () => {
    fresh({ importOpen: { sources: ["/card/Lisbon"] }, library: library({ targets: [P, Q] }) });
    be.hold = true;
    const root = mount();
    await act(async () => root.render(createElement(ImportDialog)));
    await act(async () => settle());
    // Named after the folder chosen, but not placed until it is known whether Lisbon is there already.
    expect((document.querySelector('input[placeholder^="A new folder in it"]') as HTMLInputElement).value).toBe("Lisbon");
    expect(document.querySelector(".import-dest")).toBeNull();
    expect(button("Next").disabled).toBe(true);
    root.unmount();
  });

  it("into a folder chosen from the list, or a new one in it, filed by the day", async () => {
    vi.mocked((await import("../lib/api")).api.listDir);
    fresh({ importOpen: { sources: ["/card/DCIM"] }, library: library({ targets: [P, Q] }) });
    const root = mount();
    await act(async () => root.render(createElement(ImportDialog)));
    await act(async () => settle());
    const dest = () => document.querySelector(".import-dest")?.textContent ?? "";
    expect(dest()).toContain("Professional/2026/2026-11-02/");
    // In: Weddings, from the list of the folders of yours (empty ones too).
    await act(async () => (document.querySelector(".sel-btn[title='Professional']") as HTMLButtonElement).click());
    const opts = Array.from(document.querySelectorAll(".sel-opt")).map((o) => o.textContent);
    expect(opts).toEqual(["Professional", "Weddings", "James & Amy"]);
    await act(async () => (Array.from(document.querySelectorAll(".sel-opt")).find((o) => o.textContent === "Weddings") as HTMLElement).click());
    expect(dest()).toContain("Professional/Weddings/2026/2026-11-02/");
    expect(dest()).not.toContain("a new folder");
    const name = document.querySelector('input[placeholder^="A new folder in it"]') as HTMLInputElement;
    await act(async () => type(name, "james & AMY"));
    expect(dest()).toContain("Professional/Weddings/James & Amy/2026/2026-11-02/");
    expect(dest()).not.toContain("a new folder");
    await act(async () => type(name, "Lena & Max > Ceremony"));
    expect(dest()).toContain("Professional/Weddings/Lena & Max/Ceremony/2026/2026-11-02/ (a new folder;");
    // Another bucket: back to its own day, the folder chosen in the other one gone.
    await act(async () => type(name, ""));
    await act(async () => (document.querySelector(".scrap-field .sel-btn[title='Professional, Private…']") as HTMLButtonElement).click());
    await act(async () => (Array.from(document.querySelectorAll(".sel-opt")).find((o) => o.textContent === "Personal") as HTMLElement).click());
    await act(async () => settle());
    expect(dest()).toContain("Personal/2026/2026-11-02/");
    root.unmount();
  });
});

describe("organising: loose pictures in folders of yours", () => {
  const loose = () => [
    item("Professional/random.png", "p"),
    item("Professional/Weddings/James & Amy/a.jpg", "w"),
    item("Professional/Weddings/James & Amy/b.jpg", "w"),
    item("Professional/2026/2026-10-01/c.jpg", "p"),
    item("Professional/Weddings/2025/2025-01-01/d.jpg", "w"),
    { ...item("Albums/Comic/p1.jpg"), albumKey: "Albums/Comic" },
    item("Inbox/e.jpg"),
    { ...item("Professional/doc.pdf#1", "p"), primary: "/vol/Professional/doc.pdf#1" },
  ];

  it("lists them by folder, and files only the ticked ones, by the day inside the folder they're in", async () => {
    fresh({ allItems: loose(), organiseOpen: true, library: library({ ratings: { "Professional/Weddings/James & Amy/a.jpg": 7 } }) });
    be.tree[""] = ["Professional", "Personal", "Albums", "_deleted"];
    const root = mount();
    await act(async () => root.render(createElement(OrganiseDialog)));
    await act(async () => settle());
    const rows = Array.from(document.querySelectorAll("label.organise-row")).map((r) => r.textContent);
    expect(rows).toEqual(["Professional1 picture", "Professional › Weddings › James & Amy2 pictures"]);
    expect(button("Organise").disabled).toBe(true);
    await act(async () => (document.querySelectorAll("label.organise-row input")[1] as HTMLInputElement).click());
    await act(async () => button("File loose pictures in 1 folder").click());
    await act(async () => settle());
    expect(be.movedItems).toEqual([
      { key: "Professional/Weddings/James & Amy/a.jpg", dest: "Professional/Weddings/James & Amy/2026/2026-11-02" },
      { key: "Professional/Weddings/James & Amy/b.jpg", dest: "Professional/Weddings/James & Amy/2026/2026-11-02" },
    ]);
    // What moved is known at its new place (its rating with it); the one not ticked stays loose.
    const s = useStore.getState();
    expect(s.library!.ratings).toEqual({ "Professional/Weddings/James & Amy/2026/2026-11-02/a.jpg": 7 });
    expect(s.allItems.find((i) => i.name === "a")?.key).toBe("Professional/Weddings/James & Amy/2026/2026-11-02/a.jpg");
    expect(s.allItems.find((i) => i.name === "random")?.key).toBe("Professional/random.png");
    expect(Array.from(document.querySelectorAll("label.organise-row")).map((r) => r.textContent)).toEqual(["Professional1 picture"]);
    root.unmount();
  });

  it("Tick all ticks every folder, and again unticks them", async () => {
    fresh({ allItems: loose(), organiseOpen: true });
    be.tree[""] = ["Professional", "Albums", "_deleted"];
    const root = mount();
    await act(async () => root.render(createElement(OrganiseDialog)));
    await act(async () => settle());
    await act(async () => button("Tick all").click());
    expect(button("File loose pictures in 2 folders")).toBeTruthy();
    await act(async () => button("Untick all").click());
    expect(button("Organise").disabled).toBe(true);
    root.unmount();
  });

  it("a folder kept whole: straight in the bucket, renamed if its name reads as a date, what is loose in it and its folders filed where it is", async () => {
    const kept = [item("Old phone/y.jpg"), item("Old phone/Trip/x.jpg"), item("Old phone/2018/z.jpg"), item("2019/w.jpg")];
    fresh({ allItems: kept, organiseOpen: true, library: library({ targets: [P] }) });
    be.tree[""] = ["Professional", "Old phone", "2019", "_deleted"];
    const root = mount();
    await act(async () => root.render(createElement(OrganiseDialog)));
    await act(async () => settle());
    const top = Array.from(document.querySelectorAll("div.organise-row"));
    expect(top.map((r) => r.querySelector("b")?.textContent)).toEqual(["2019", "Old phone"]);
    for (const r of top) await act(async () => (Array.from(r.querySelectorAll("button")).find((b) => b.textContent === "Keep, in a bucket") as HTMLButtonElement).click());
    expect(top[0].textContent).toContain("→ Professional/2019 (kept)/");
    expect(top[0].textContent).toContain("renamed: “2019” reads as a year or a day");
    await act(async () => button("Organise 2 folders").click());
    await act(async () => settle());
    expect(be.renamed).toEqual([["/vol/2019", "/vol/2019 (kept)"]]);
    expect(be.moved).toEqual([
      [["/vol/2019 (kept)"], "/vol/Professional"],
      [["/vol/Old phone"], "/vol/Professional"],
    ]);
    const where = Object.fromEntries(be.movedItems.map((m) => [m.key, m.dest]));
    expect(where).toEqual({
      "Professional/2019 (kept)/w.jpg": "Professional/2019 (kept)/2026/2026-11-02",
      "Professional/Old phone/y.jpg": "Professional/Old phone/2026/2026-11-02",
      "Professional/Old phone/Trip/x.jpg": "Professional/Old phone/Trip/2026/2026-11-02",
    });
    // In a folder named like a year: part of that year, left as it is.
    expect(useStore.getState().allItems.find((i) => i.name === "z")?.key).toBe("Professional/Old phone/2018/z.jpg");
    root.unmount();
  });
});
