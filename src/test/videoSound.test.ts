import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, { get: () => async () => null }),
  mediaUrl: () => "",
  rawPreviewUrl: async () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
  storedPath: (r: string, p: string) => p.slice(r.length + 1),
  setCurrentRoot: () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const { MediaStage, soundLetOn } = await import("../components/MediaStage");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const video = (key: string) => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "video", name: key, dir: "", size: 1, modified: 1, hasRaw: false, hasVideo: true });

/** A video shown (a picture between it and the last, as in Sort: the player starts afresh). */
async function show(key: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const ref = createRef<HTMLVideoElement>();
  await act(async () => root.render(createElement(MediaStage, { item: video(key) as never, videoRef: ref })));
  const v = ref.current!;
  const done = () => (root.unmount(), host.remove());
  return { v, done };
}
/** The reader muting or unmuting it (the M key, or its button). */
const mute = (v: HTMLVideoElement, on: boolean) =>
  act(async () => {
    v.muted = on;
    v.dispatchEvent(new Event("volumechange"));
  });

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a video's sound", () => {
  it("starts muted, but once let on, the next videos within the hour start with sound; muting one ends it", async () => {
    const first = await show("a.mp4");
    expect(first.v.muted).toBe(true);
    await mute(first.v, false);
    first.done();
    // A picture between, then the next video: with sound.
    const next = await show("b.mp4");
    expect(next.v.muted).toBe(false);
    await mute(next.v, true);
    next.done();
    const third = await show("c.mp4");
    expect(third.v.muted).toBe(true);
    third.done();
  });

  it("goes back to muted an hour after a video last played with its sound", async () => {
    const first = await show("a.mp4");
    await mute(first.v, false);
    first.done();
    const at = Number(localStorage.getItem("quire.soundOnAt"));
    expect(soundLetOn(at + 59 * 60_000)).toBe(true);
    expect(soundLetOn(at + 61 * 60_000)).toBe(false);
  });

  it("plays muted when the webview refuses to start it with sound, and keeps the sound let on for the next", async () => {
    localStorage.setItem("quire.soundOnAt", String(Date.now()));
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("not allowed", "NotAllowedError"));
    const { v, done } = await show("a.mp4");
    expect(v.muted).toBe(false);
    await act(async () => void v.dispatchEvent(new Event("canplay")));
    await act(async () => void v.dispatchEvent(new Event("volumechange")));
    expect(v.muted).toBe(true);
    expect(soundLetOn()).toBe(true);
    done();
  });
});
