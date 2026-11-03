import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({
  api: new Proxy({ scanAlbums: async () => [], albumRenamePlan: async () => [] } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  fileSrc: (p: string) => p,
  mediaUrl: (i: { primary: string }) => `media:${i.primary}`,
  thumbUrl: (_r: string, i: { primary: string }, w: number) => `thumb:${i.primary}@${w}`,
  faceUrl: () => "face:",
  canThumb: () => true,
  rawPreviewUrl: async () => "",
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));
for (const name of ["ResizeObserver", "IntersectionObserver"])
  (globalThis as Record<string, unknown>)[name] = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const { People } = await import("../screens/People");
const { useStore } = await import("../store");
const { usePeople, useFaceMode } = await import("../peopleStore");
const { FaceLayer, FacesPanel } = await import("../components/FacesInPicture");

describe("a face suggested for someone", () => {
  it("double-clicked, shows the whole picture with the face outlined, and takes a yes from there", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pic = { key: "in/a.jpg", primary: "/vol/in/a.jpg", files: ["/vol/in/a.jpg"], name: "a", kind: "image", dir: "in", size: 1, modified: 0, hasRaw: false, hasVideo: false };
    useStore.setState({ root: "/vol", screen: "people", allItems: [pic], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    const face = { id: 5, key: "in/a.jpg", kind: "photo" as const, bbox: [0.25, 0.1, 0.5, 0.4] as [number, number, number, number], score: 0.9, size: 200 };
    usePeople.setState({
      doc: { version: 1, people: { pe1: { id: "pe1", name: "Kaze", kind: "person", from: null, portrait: null, added: 0 } }, faces: {}, no: [], not: {}, exclude: [], converted: null },
      docRoot: "/vol",
      byId: new Map([[5, face]]),
      sorted: { matches: [{ face: 5, person: "pe1", score: 0.6 }], doubts: [], groups: [], unnamed: [] },
      open: "pe1",
    } as never);
    const accept = vi.spyOn(usePeople.getState(), "accept").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(People)));
    await act(async () => (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Check them") as HTMLButtonElement).click());
    const tile = document.body.querySelector(".found-face") as HTMLElement;
    await act(async () => void tile.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const img = document.body.querySelector(".compare-one img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("thumb:/vol/in/a.jpg@1024");
    // Once the picture has come, the face is outlined where it is.
    Object.defineProperty(img, "naturalWidth", { value: 800 });
    Object.defineProperty(img, "naturalHeight", { value: 600 });
    await act(async () => void img.dispatchEvent(new Event("load")));
    const mark = document.body.querySelector(".compare-one-mark") as HTMLElement;
    expect([mark.style.left, mark.style.top, mark.style.width, mark.style.height].map((v) => Math.round(parseFloat(v)))).toEqual([25, 10, 25, 30]);
    await act(async () => (Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes("Yes, Kaze")) as HTMLButtonElement).click());
    expect(accept).toHaveBeenCalledWith([5], "pe1");
    expect(document.body.querySelector(".compare-one")).toBeNull();
    accept.mockRestore();
    root.unmount();
  });

  it("right-clicked, is said to be someone else: theirs, and not this person's", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const face = { id: 6, key: "in/a.jpg", kind: "photo" as const, bbox: [0.1, 0.1, 0.3, 0.3] as [number, number, number, number], score: 0.9, size: 200 };
    usePeople.setState({
      doc: { version: 1, people: { pe1: { id: "pe1", name: "Kaze", kind: "person", from: null, portrait: null, added: 0 }, pe2: { id: "pe2", name: "Rin", kind: "person", from: null, portrait: null, added: 0 } }, faces: {}, no: [], not: {}, exclude: [], converted: null },
      docRoot: "/vol",
      byId: new Map([[6, face]]),
      sorted: { matches: [{ face: 6, person: "pe1", score: 0.6 }], doubts: [], groups: [], unnamed: [] },
      open: "pe1",
    } as never);
    const st = usePeople.getState();
    const not = vi.spyOn(st, "notThem").mockImplementation(() => {});
    const name = vi.spyOn(st, "name").mockImplementation(() => "pe2");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(People)));
    // Open still from before (it is kept per person), or opened now.
    const check = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Check them");
    if (check) await act(async () => check.click());
    await act(async () => void (document.body.querySelector(".found-face") as HTMLElement).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })));
    const item = Array.from(document.querySelectorAll(".context-menu button")).find((b) => b.textContent?.includes("This is someone else")) as HTMLButtonElement;
    await act(async () => item.click());
    const field = document.body.querySelector(".split-field input") as HTMLInputElement;
    expect(field.placeholder).toBe("Who is this, if not Kaze?");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(field, "Rin");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(not).toHaveBeenCalledWith([6], "pe1");
    expect(name).toHaveBeenCalledWith([6], "Rin", null, [], true);
    not.mockRestore();
    name.mockRestore();
    root.unmount();
  });

  it("said not to be them, is gone at once, before the matching has looked again", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const face = { id: 9, key: "in/a.jpg", kind: "photo" as const, bbox: [0.1, 0.1, 0.3, 0.3] as [number, number, number, number], score: 0.9, size: 200 };
    usePeople.setState({
      doc: { version: 1, people: { pe1: { id: "pe1", name: "Kaze", kind: "person", from: null, portrait: null, added: 0 } }, faces: {}, no: [], not: {}, exclude: [], converted: null },
      docRoot: "/vol",
      faces: [face],
      byId: new Map([[9, face]]),
      sorted: { matches: [{ face: 9, person: "pe1", score: 0.6 }], doubts: [], groups: [] },
      open: "pe1",
    } as never);
    const sort = vi.spyOn(usePeople.getState(), "sort").mockImplementation(() => new Promise(() => {}));
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(People)));
    const check = Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent === "Check them");
    if (check) await act(async () => check.click());
    expect(document.body.querySelectorAll(".found-face")).toHaveLength(1);
    await act(async () => usePeople.getState().notThem([9], "pe1"));
    expect(document.body.querySelectorAll(".found-face")).toHaveLength(0);
    sort.mockRestore();
    root.unmount();
  });
});

describe("faces in the picture on show", () => {
  it("are outlined with who each is, named one by one (the same person twice on a page), and someone added with no face showing", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pic = { key: "manga/p1.png", primary: "/vol/manga/p1.png", files: ["/vol/manga/p1.png"], name: "p1", kind: "image", dir: "manga", size: 1, modified: 0, hasRaw: false, hasVideo: false };
    const f = (id: number, x: number) => ({ id, key: pic.key, kind: "drawn" as const, bbox: [x, 0.1, x + 0.2, 0.3] as [number, number, number, number], score: 0.9, size: 100 });
    const faces = [f(8, 0.6), f(7, 0.1)];
    useStore.setState({ root: "/vol", screen: "viewer", editMode: false, allItems: [pic], queue: [pic], index: 0, albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    usePeople.setState({
      doc: { version: 1, people: { pe1: { id: "pe1", name: "Rin", kind: "character", from: null, portrait: null, added: 0 } }, faces: { "7": { p: "pe1", ok: true } }, no: [], not: {}, exclude: [], converted: null },
      docRoot: "/vol",
      faces,
      byId: new Map(faces.map((x) => [x.id, x])),
      scanned: { [pic.key]: [1, 0] },
      sorted: { matches: [], groups: [] },
      open: null,
    } as never);
    useFaceMode.setState({ on: true, marking: false, picked: null });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, createElement(FaceLayer, { itemKey: pic.key }), createElement(FacesPanel))));
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
    // Left to right: Rin, then a face still to name.
    const boxes = Array.from(document.body.querySelectorAll(".face-box")) as HTMLElement[];
    expect(boxes.map((b) => b.textContent)).toEqual(["Rin", "2"]);
    expect(boxes[1].style.left).toBe("60%");
    await act(async () => boxes[1].click());
    const field = document.querySelector(".faces-panel .faces-naming input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = async (input: HTMLInputElement, text: string) => {
      await act(async () => {
        setter.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    };
    await type(field, "rin");
    expect(usePeople.getState().doc!.faces).toEqual({ "7": { p: "pe1", ok: true }, "8": { p: "pe1", ok: true } });
    expect(Array.from(document.body.querySelectorAll(".face-box")).map((b) => b.textContent)).toEqual(["Rin", "Rin"]);
    // Someone in it whose face doesn't show: a character, as the page is drawn.
    await act(async () => (Array.from(document.querySelectorAll(".faces-panel button")).find((b) => b.textContent?.includes("no face showing")) as HTMLButtonElement).click());
    await type(document.querySelector(".faces-panel .faces-naming input") as HTMLInputElement, "Kai");
    const kai = Object.values(usePeople.getState().doc!.people).find((x) => x.name === "Kai")!;
    expect(kai.kind).toBe("character");
    expect(usePeople.getState().doc!.present).toEqual({ [pic.key]: [kai.id] });
    expect(document.querySelector(".faces-panel .faces-present")?.textContent).toContain("Kai");
    root.unmount();
  });

  it("missed by the scan, is marked by dragging over it and looked for there", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const pic = { key: "in/b.jpg", primary: "/vol/in/b.jpg", files: ["/vol/in/b.jpg"], name: "b", kind: "image", dir: "in", size: 1, modified: 0, hasRaw: false, hasVideo: false };
    useStore.setState({ root: "/vol", screen: "viewer", editMode: false, allItems: [pic], queue: [pic], index: 0 } as never);
    usePeople.setState({ doc: { version: 1, people: {}, faces: {}, no: [], not: {}, exclude: [], converted: null }, docRoot: "/vol", faces: [], byId: new Map(), scanned: { [pic.key]: [1, 0] }, sorted: { matches: [], groups: [] } } as never);
    const found = { id: 11, key: pic.key, kind: "photo" as const, bbox: [0.2, 0.2, 0.4, 0.5] as [number, number, number, number], score: 0.8, size: 60, marked: true };
    const mark = vi.spyOn(usePeople.getState(), "mark").mockImplementation(async () => (usePeople.setState({ faces: [found], byId: new Map([[11, found]]) }), [found]));
    useFaceMode.setState({ on: true, marking: false, picked: null });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement("div", null, createElement(FaceLayer, { itemKey: pic.key }), createElement(FacesPanel))));
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
    // None found: ready to mark.
    expect(useFaceMode.getState().marking).toBe(true);
    const layer = document.body.querySelector(".face-layer.marking") as HTMLElement;
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => void layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 40, clientY: 20 })));
    await act(async () => void window.dispatchEvent(new MouseEvent("mousemove", { clientX: 80, clientY: 50 })));
    await act(async () => void window.dispatchEvent(new MouseEvent("mouseup", {})));
    expect(mark).toHaveBeenCalledWith(pic, [0.2, 0.2, 0.4, 0.5]);
    expect(useFaceMode.getState()).toMatchObject({ marking: false, picked: 11 });
    expect(document.querySelector(".faces-panel .faces-row")?.textContent).toContain("marked");
    mark.mockRestore();
    root.unmount();
  });
});

describe("a character's page", () => {
  it("shows the tagger's name for them and how it was had, and takes where they are from from what their pictures say", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const { useTags } = await import("../tagsStore");
    const pic = { key: "art/p.png", primary: "/vol/art/p.png", files: ["/vol/art/p.png"], name: "p", kind: "image", dir: "art", size: 1, modified: 0, hasRaw: false, hasVideo: false };
    useStore.setState({ root: "/vol", screen: "people", allItems: [pic], albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
    const face = { id: 21, key: pic.key, kind: "drawn" as const, bbox: [0.2, 0.1, 0.4, 0.3] as [number, number, number, number], score: 0.9, size: 200 };
    usePeople.setState({
      doc: { version: 1, people: { c1: { id: "c1", name: "Pepper", kind: "character", from: null, portrait: null, added: 0 } }, faces: { "21": { p: "c1", ok: true } }, no: [], not: {}, exclude: [], converted: null },
      docRoot: "/vol",
      faces: [face],
      byId: new Map([[21, face]]),
      sorted: { matches: [], groups: [] },
      open: "c1",
    } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(People)));
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
    const names = [
      { name: "pepper_(peppercarrot)", category: 4 },
      { name: "pepper&carrot", category: 3 },
    ];
    await act(async () => useTags.setState({ names, data: { version: 1, types: [], tags: {}, auto: { [pic.key]: [[0, 0.9], [1, 0.8]] }, indexed: {}, autoMap: {}, albums: {} } } as never));
    const facts = document.body.querySelector(".character-facts") as HTMLElement;
    expect(facts.textContent).toContain("pepper (peppercarrot)");
    expect(facts.textContent).toContain("seen in 1 of their 1 pictures");
    await act(async () => (Array.from(facts.querySelectorAll("button")).find((b) => b.textContent?.includes("Add")) as HTMLButtonElement).click());
    const chip = Array.from(facts.querySelectorAll(".suggest-field button.chip")).find((b) => b.textContent?.includes("Pepper&Carrot")) as HTMLButtonElement;
    expect(chip.title).toBe("In 1 of their pictures");
    await act(async () => chip.click());
    expect(usePeople.getState().doc!.people.c1.from).toBe("Pepper&Carrot");
    root.unmount();
  });
});
