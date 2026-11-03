import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// The backend as far as importing goes: a library at /vol with a picture in it, and a card with three.
const be = vi.hoisted(() => ({
  dirs: {} as Record<string, { name: string; path: string; isDir: boolean; count: number }[]>,
  imported: [] as { src: string; dest: string }[],
  moved: [] as [string[], string][],
  movedItems: [] as string[],
  made: [] as string[],
}));
vi.mock("../lib/api", () => ({
  api: {
    versionsLoad: vi.fn(async () => null),
    saveLibrary: vi.fn(async () => {}),
    scanUnsorted: vi.fn(async () => []),
    scanAll: vi.fn(async () => []),
    scanDir: vi.fn(async () => []),
    loadCache: vi.fn(async () => null),
    saveHistory: vi.fn(async () => {}),
    listDir: vi.fn(async (_r: string, dir: string) => be.dirs[dir] ?? []),
    fsMkdir: vi.fn(async (_r: string, _d: string, name: string) => void be.made.push(name)),
    importScan: vi.fn(async () => [
      { path: "/card/DCIM/IMG_0003.JPG", size: 300, inside: false },
      { path: "/card/DCIM/IMG_0001.JPG", size: 100, inside: false },
      { path: "/card/DCIM/IMG_0002.JPG", size: 200, inside: false },
      { path: "/card/DCIM/copy/IMG_0002.JPG", size: 200, inside: false },
    ]),
    // IMG_0001 is the library's beach.jpg; the two IMG_0002 are the same picture.
    importFingerprints: vi.fn(async (_r: string, paths: string[]) => paths.map((p) => (p.endsWith("beach.jpg") || p.endsWith("IMG_0001.JPG") ? "fp-beach" : p.includes("IMG_0002") ? "fp-two" : null))),
    importFiles: vi.fn(async (_r: string, items: { src: string; dest: string }[]) => {
      be.imported = items;
      return items.map((it) => `/vol/${it.dest}/${it.src.split("/").pop()}`);
    }),
    fsMove: vi.fn(async (_r: string, paths: string[], dest: string) => {
      be.moved.push([paths, dest]);
      return paths.map((p) => `${dest}/${p.split("/").pop()}`);
    }),
    fsDelete: vi.fn(async () => 0),
    moveItem: vi.fn(async (_r: string, item: { key: string; primary: string }, dest: string) => {
      be.movedItems.push(dest);
      const to = `${dest}/${item.key.split("/").pop()}`;
      return { moved: [[item.primary, `/vol/${to}`]], item: { ...item, key: to, primary: `/vol/${to}` } };
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

const { PART, dayOf, exactCopies, filedFolder, folderName, partOf, planParts, sizeCandidates } = await import("../lib/filing");
const { useStore } = await import("../store");
const { ImportDialog } = await import("../components/ImportDialog");
const { OrganiseDialog } = await import("../components/OrganiseDialog");

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const library = (targets: unknown[] = []) => ({ version: 1, targets, trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {} });
const beach = { key: "Pics/beach.jpg", primary: "/vol/Pics/beach.jpg", files: ["/vol/Pics/beach.jpg"], kind: "image", name: "beach.jpg", dir: "Pics", size: 100, modified: 0, hasRaw: false, hasVideo: false };
function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}
const button = (text: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement;
const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("filing", () => {
  it("files by the folder, year and the day it came in", () => {
    const d = new Date(2026, 9, 28);
    expect(dayOf(d)).toBe("2026-10-28");
    expect(filedFolder("Private", d)).toBe("Private/2026/2026-10-28");
    expect(filedFolder("Professional/Weddings/James & Amy", d)).toBe("Professional/Weddings/James & Amy/2026/2026-10-28");
    // Safe on any drive: FAT refuses these, and a name ending in a dot.
    expect(folderName(' Wedding: Jansen/2 "best"? ')).toBe("Wedding- Jansen-2 -best--");
    expect(folderName("Paris trip.")).toBe("Paris trip");
    expect(partOf("Private/2026/2026-10-28", 1)).toBe("Private/2026/2026-10-28");
    expect(partOf("Private/2026/2026-10-28", 3)).toBe("Private/2026/2026-10-28, part 3");
  });

  it("fills a folder up to a thousand, counting what it holds, then its parts, in name order", () => {
    const files = Array.from({ length: 2500 }, (_, i) => `/card/IMG_${i + 1}.JPG`).reverse();
    const plan = planParts(files, "B", (f) => (f === "B" ? 600 : 0));
    const count = (dest: string) => plan.filter((p) => p.dest === dest).length;
    expect([count("B"), count("B, part 2"), count("B, part 3"), count("B, part 4")]).toEqual([400, PART, PART, 100]);
    // Name order, numbers as numbers: IMG_2 before IMG_10.
    expect(plan[0].src).toBe("/card/IMG_1.JPG");
    expect(plan[1].src).toBe("/card/IMG_2.JPG");
    expect(plan[400].dest).toBe("B, part 2");
  });

  it("finds exact copies by size first, then fingerprint: of the library, or earlier in the import", () => {
    const incoming = [
      { path: "/card/a.jpg", size: 100, inside: false },
      { path: "/card/b.jpg", size: 200, inside: false },
      { path: "/card/x/b.jpg", size: 200, inside: false },
      { path: "/card/c.jpg", size: 300, inside: false },
    ];
    const lib = [
      { path: "/vol/beach.jpg", size: 100 },
      { path: "/vol/other.jpg", size: 999 },
    ];
    // c (a size nothing else has) isn't even read.
    expect(sizeCandidates(incoming, lib)).toEqual({ incoming: ["/card/a.jpg", "/card/b.jpg", "/card/x/b.jpg"], library: ["/vol/beach.jpg"] });
    const fp = new Map([
      ["/card/a.jpg", "F1"],
      ["/vol/beach.jpg", "F1"],
      ["/card/b.jpg", "F2"],
      ["/card/x/b.jpg", "F2"],
    ]);
    expect(exactCopies(incoming, fp, lib)).toEqual([
      { path: "/card/a.jpg", of: "/vol/beach.jpg", where: "library" },
      { path: "/card/x/b.jpg", of: "/card/b.jpg", where: "import" },
    ]);
    // Moving within the library: a file isn't a copy of itself.
    expect(exactCopies([{ path: "/vol/beach.jpg", size: 100, inside: true }], new Map([["/vol/beach.jpg", "F1"]]), lib)).toEqual([]);
  });
});

describe("importing", () => {
  it("into a new bucket's new folder, by the day it came in; exact copies listed and left out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 12));
    useStore.setState({ root: "/vol", library: library(), allItems: [beach], allLoaded: true, allStale: false, importOpen: { sources: ["/card/DCIM"] } } as never);
    const { root } = mount();
    await act(async () => root.render(createElement(ImportDialog)));
    // No bucket yet: the first one is made here.
    const bucketName = document.querySelector('input[placeholder^="Name the first bucket"]') as HTMLInputElement;
    await act(async () => type(bucketName, "Private"));
    await act(async () => button("Add").click());
    await act(async () => settle());
    expect(be.made).toEqual(["Private"]);
    expect(useStore.getState().library!.targets[0]).toMatchObject({ name: "Private", path: "Private", bucket: true });
    // A camera's own folder name (DCIM) isn't taken as the new folder's.
    const name = document.querySelector('input[placeholder^="A new folder in it"]') as HTMLInputElement;
    expect(name.value).toBe("");
    await act(async () => type(name, "Lisbon"));
    await act(async () => settle());
    expect(document.querySelector(".import-dest")?.textContent).toContain("Private/Lisbon/2026/2026-10-28/ (a new folder; parts of 1000");
    await act(async () => button("Next").click());
    await act(async () => settle());
    // Two exact copies: IMG_0001 is in the library already, the second IMG_0002 is twice in the import.
    const review = document.querySelector(".import-review")!;
    expect(review.textContent).toContain("2 exact copies");
    expect(review.textContent).toContain("in the library already: Pics/beach.jpg");
    expect(review.textContent).toContain("twice in this import");
    expect(Array.from(review.querySelectorAll<HTMLInputElement>(".import-dupe input")).every((c) => !c.checked)).toBe(true);
    await act(async () => button("Import 2 files").click());
    await act(async () => settle());
    // Of the twins the first by name comes in (copy/ sorts before IMG_).
    expect(be.imported).toEqual([
      { src: "/card/DCIM/copy/IMG_0002.JPG", dest: "Private/Lisbon/2026/2026-10-28" },
      { src: "/card/DCIM/IMG_0003.JPG", dest: "Private/Lisbon/2026/2026-10-28" },
    ]);
    expect(document.querySelector(".import-done")?.textContent).toContain("2 files in Private/Lisbon/2026/2026-10-28");
    root.unmount();
    vi.useRealTimers();
  });

  it("never loose: with no new folder named, into the bucket's own day; a name like a date is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 12));
    useStore.setState({ root: "/vol", library: library([{ id: "p", name: "Private", path: "Private", hotkey: "1", bucket: true }]), allItems: [beach], allLoaded: true, allStale: false, importOpen: { sources: ["/card/DCIM"] } } as never);
    const { root } = mount();
    await act(async () => root.render(createElement(ImportDialog)));
    await act(async () => settle());
    const name = document.querySelector('input[placeholder^="A new folder in it"]') as HTMLInputElement;
    expect(button("Next").disabled).toBe(false);
    expect(document.querySelector(".import-dest")?.textContent).toContain("Private/2026/2026-10-28/");
    // "Trips > 2019" would make a folder the app reads as a year of Trips.
    await act(async () => type(name, "Trips > 2019"));
    expect(button("Next").disabled).toBe(true);
    expect(document.querySelector(".warn-text")?.textContent).toContain("“2019” would read as one of the year or day folders");
    expect(document.querySelector(".import-dest")).toBeNull();
    root.unmount();
    vi.useRealTimers();
  });

  it("sorting into a bucket files the picture under the year and day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 12));
    be.movedItems = [];
    be.dirs["Private/2026/2026-10-28"] = Array.from({ length: PART }, (_, i) => ({ name: `f${i}`, path: `/vol/x/f${i}`, isDir: false, count: 0 }));
    useStore.setState({ root: "/vol", busy: false, library: library([{ id: "p", name: "Private", path: "Private", hotkey: "1", bucket: true }]), unsorted: [beach], allItems: [beach] } as never);
    await act(async () => void (await useStore.getState().moveItem(beach as never, "p")));
    // That day's folder is full: its part 2.
    expect(be.movedItems).toEqual(["Private/2026/2026-10-28, part 2"]);
    delete be.dirs["Private/2026/2026-10-28"];
    vi.useRealTimers();
  });
});

describe("organising what's there", () => {
  it("keeps a folder whole straight in a bucket, its name kept, its loose pictures filed by the day inside it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 12));
    be.moved = [];
    be.movedItems = [];
    const loose = Array.from({ length: 1500 }, (_, i) => ({ ...beach, key: `Old phone/IMG_${i + 1}.JPG`, primary: `/vol/Old phone/IMG_${i + 1}.JPG`, files: [`/vol/Old phone/IMG_${i + 1}.JPG`], name: `IMG_${i + 1}`, dir: "Old phone" }));
    be.dirs["/vol"] = [
      { name: "Old phone", path: "/vol/Old phone", isDir: true, count: 1500 },
      { name: "Private", path: "/vol/Private", isDir: true, count: 3 },
      { name: "Albums", path: "/vol/Albums", isDir: true, count: 40 },
      { name: "_deleted", path: "/vol/_deleted", isDir: true, count: 2 },
    ];
    useStore.setState({ root: "/vol", busy: false, library: library([{ id: "p", name: "Private", path: "Private", hotkey: "1", bucket: true }]), allItems: loose, allLoaded: true, allStale: false, organiseOpen: true } as never);
    const { root } = mount();
    await act(async () => root.render(createElement(OrganiseDialog)));
    await act(async () => settle());
    // Only the folder that is in no bucket, album folder or the trash; nothing loose in a bucket yet.
    const rows = document.querySelectorAll(".organise-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Old phone");
    await act(async () => button("Keep, in a bucket").click());
    expect(rows[0].textContent).toContain("→ Private/Old phone/");
    await act(async () => button("Organise 1 folder").click());
    await act(async () => settle());
    expect(be.moved[0]).toEqual([["/vol/Old phone"], "/vol/Private"]);
    // Its 1500 loose pictures by the day inside it: the first 1000 by name, the last 500 in part 2.
    expect(be.movedItems).toHaveLength(1500);
    expect(be.movedItems.filter((d) => d === "Private/Old phone/2026/2026-10-28")).toHaveLength(1000);
    expect(be.movedItems.filter((d) => d === "Private/Old phone/2026/2026-10-28, part 2")).toHaveLength(500);
    root.unmount();
    vi.useRealTimers();
  });
});
