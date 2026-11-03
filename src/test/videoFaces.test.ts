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

const { useStore } = await import("../store");
const { usePeople, useFaceMode } = await import("../peopleStore");
const { VideoFaceLayer, FacesPanel, FacesButton } = await import("../components/FacesInPicture");
const { atItsMoment } = await import("../screens/People");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clip = { key: "Clips/party.mp4", primary: "/vol/Clips/party.mp4", files: ["/vol/Clips/party.mp4"], name: "party", kind: "video", dir: "Clips", size: 1, modified: 0, hasRaw: false, hasVideo: false };
const face = (id: number, at: number, x: number) => ({ id, key: clip.key, kind: "photo" as const, bbox: [x, 0.2, x + 0.2, 0.5] as [number, number, number, number], score: 0.9, size: 120, at });

/** A video element as far as faces need it: where it is, whether it plays, loaded. */
function fakeVideo() {
  return { currentTime: 0, paused: false, readyState: 4, pause() { this.paused = true; }, addEventListener() {} };
}

function setUp() {
  // Seen at 0:12 (two people in one frame) and 0:03, listed in time.
  const faces = [face(21, 12, 0.6), face(20, 3, 0.1), face(22, 12, 0.1)];
  useStore.setState({ root: "/vol", screen: "viewer", editMode: false, allItems: [clip], queue: [clip], index: 0, albums: [], library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} } } as never);
  usePeople.setState({
    doc: { version: 1, people: { pe1: { id: "pe1", name: "Mila", kind: "person", from: null, portrait: null, added: 0 } }, faces: { "20": { p: "pe1", ok: true } }, no: [], not: {}, exclude: [], converted: null },
    docRoot: "/vol",
    faces,
    byId: new Map(faces.map((f) => [f.id, f])),
    scanned: { [clip.key]: [1, 0] },
    sorted: { matches: [], groups: [] },
    open: null,
  } as never);
}

async function show(time: number, paused: boolean, video = fakeVideo()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const ref = { current: video as unknown as HTMLVideoElement };
  const draw = () => createElement("div", null, createElement(FacesButton, { item: clip as never }), createElement(VideoFaceLayer, { item: clip as never, time, paused }), createElement(FacesPanel, { videoRef: ref }));
  await act(async () => root.render(draw()));
  await act(async () => await new Promise((r) => setTimeout(r, 0)));
  return { host, video, rerender: async (t: number, p: boolean) => ((time = t), (paused = p), await act(async () => root.render(draw()))), unmount: () => (root.unmount(), host.remove()) };
}

describe("faces in a video", () => {
  it("are listed in time with their moments; a click goes there, paused, the faces of that frame outlined", async () => {
    setUp();
    useFaceMode.setState({ on: true, marking: false, picked: null, moment: null });
    const v = await show(0, false);
    expect(v.host.querySelector(".btn .mono")?.textContent).toBe("1"); // one face named, on the bar's button
    const rows = Array.from(document.querySelectorAll(".faces-panel .faces-row")) as HTMLElement[];
    expect(rows.map((r) => `${r.querySelector(".ellipsis")!.textContent} ${r.querySelector(".faces-row-at")!.textContent}`)).toEqual(["Mila 0:03", "Face 2: who? 0:12", "Face 3: who? 0:12"]);
    // Playing: nothing drawn on it, and no marking (that is for pictures).
    expect(document.querySelectorAll(".face-box")).toHaveLength(0);
    expect(Array.from(document.querySelectorAll(".faces-panel button")).some((b) => b.textContent?.includes("Mark a face"))).toBe(false);
    // The second face: to 0:12, paused, picked, and both faces of that frame outlined.
    await act(async () => rows[1].click());
    expect([v.video.currentTime, v.video.paused, useFaceMode.getState().picked]).toEqual([12, true, 22]);
    await v.rerender(12, true);
    const boxes = Array.from(document.querySelectorAll(".face-box")) as HTMLElement[];
    expect(boxes.map((b) => b.textContent)).toEqual(["2", "3"]);
    expect(boxes[0].classList.contains("picked")).toBe(true);
    expect(boxes[1].style.left).toBe("60%");
    // Named there, as on a picture, told this is the face's clearest frame.
    expect(document.querySelector(".faces-panel .faces-naming input")).not.toBeNull();
    expect(document.querySelector(".faces-panel .faces-naming")!.textContent).toContain("Shown on its clearest frame, at 0:12");
    // Another frame, or playing again: none of these outlined.
    await v.rerender(3, true);
    expect(Array.from(document.querySelectorAll(".face-box")).map((b) => b.textContent)).toEqual(["Mila"]);
    await v.rerender(12, false);
    expect(document.querySelectorAll(".face-box")).toHaveLength(0);
    v.unmount();
  });

  it("opened from People, the video is at the face's moment, paused, the face picked", async () => {
    setUp();
    useFaceMode.setState({ on: false, marking: false, picked: null, moment: null });
    atItsMoment(face(21, 12, 0.6));
    expect(useFaceMode.getState()).toMatchObject({ on: true, picked: 21 });
    const v = await show(0, false);
    expect([v.video.currentTime, v.video.paused]).toEqual([12, true]);
    expect(useFaceMode.getState()).toMatchObject({ picked: 21, moment: null });
    expect(document.querySelector(".faces-row.active")?.textContent).toContain("0:12");
    v.unmount();
    // A face in a picture opens the picture as before.
    useFaceMode.setState({ on: false, picked: null, moment: null });
    atItsMoment({ ...face(30, 0, 0.1), at: undefined });
    expect(useFaceMode.getState()).toMatchObject({ on: false, picked: null, moment: null });
  });
});
