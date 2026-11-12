import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const be = vi.hoisted(() => ({ held: [] as boolean[] }));

vi.mock("../lib/platform", async (original) => ({ ...(await original<typeof import("../lib/platform")>()), IS_MOBILE: true, HOME_DEVICE: "phone" }));
vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => async (hold: boolean) => {
      if (k === "iosHoldOtherAudio") be.held.push(hold);
      return null;
    },
  }),
  mediaUrl: (m: { primary: string }) => m.primary,
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

const { leaveOtherAudioAlone, useVideoSound } = await import("../lib/otherAudio");
const { MediaStage } = await import("../components/MediaStage");

const webview = { type: "auto" };

describe("other apps' audio on a phone", () => {
  let root: Root;
  const Video = ({ sound }: { sound: boolean }) => {
    useVideoSound(sound);
    return null;
  };
  const show = (sound: boolean) => act(async () => root.render(createElement(Video, { sound })));
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    Object.defineProperty(navigator, "audioSession", { value: webview, configurable: true });
    webview.type = "ambient";
    be.held.length = 0;
    root = createRoot(document.createElement("div"));
    await show(false);
  });

  afterEach(async () => {
    await show(false);
    await pass(2000);
    await act(async () => root.unmount());
    vi.useRealTimers();
  });

  it("is left alone from the start", () => {
    webview.type = "auto";
    leaveOtherAudioAlone();
    expect(webview.type).toBe("ambient");
  });

  it("is left alone where the webview has no say in it", () => {
    Object.defineProperty(navigator, "audioSession", { value: undefined, configurable: true });
    expect(() => leaveOtherAudioAlone()).not.toThrow();
  });

  it("stays alone with a muted or silent video on the screen", async () => {
    await show(false);
    await pass(5000);
    expect(be.held).toEqual([]);
    expect(webview.type).toBe("ambient");
  });

  it("is taken for a video with sound", async () => {
    await show(true);
    expect(be.held).toEqual([true]);
    expect(webview.type).toBe("playback");
  });

  it("comes back a moment after the video is left, the webview letting go of it first", async () => {
    await show(true);
    await show(false);
    expect(webview.type).toBe("ambient");
    await pass(900);
    expect(be.held).toEqual([true]);
    await pass(200);
    expect(be.held).toEqual([true, false]);
    expect(webview.type).toBe("ambient");
  });

  it("comes back for a video left as soon as it was opened", async () => {
    await show(true);
    await pass(50);
    await show(false);
    await pass(1100);
    expect(be.held).toEqual([true, false]);
  });

  it("isn't handed back and forth going from one video with sound to the next", async () => {
    await show(true);
    await show(false);
    await pass(400);
    await show(true);
    await pass(5000);
    expect(be.held).toEqual([true]);
    expect(webview.type).toBe("playback");
  });

  it("comes back when the viewer goes", async () => {
    await show(true);
    await act(async () => root.unmount());
    await pass(1100);
    expect(be.held).toEqual([true, false]);
    root = createRoot(document.createElement("div"));
  });
});

describe("a video on a phone", () => {
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  let root: Root;
  /** A video on the screen that can play: with this many sound tracks, its sound on or not. */
  async function stage(tracks: number, soundOn: boolean) {
    if (soundOn) localStorage.setItem("quire.soundOnAt", String(Date.now()));
    const ref = createRef<HTMLVideoElement>();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const item = { key: "a.mp4", primary: "/vol/a.mp4", files: ["/vol/a.mp4"], kind: "video", name: "a.mp4", dir: "", size: 1, modified: 1, hasRaw: false, hasVideo: true };
    await act(async () => root.render(createElement(MediaStage, { item: item as never, videoRef: ref })));
    const v = ref.current!;
    Object.defineProperty(v, "audioTracks", { value: { length: tracks } });
    await act(async () => void v.dispatchEvent(new Event("canplay")));
    return v;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    be.held.length = 0;
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await pass(2000);
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("with sound, takes the audio", async () => {
    await stage(1, true);
    expect(be.held).toEqual([true]);
  });

  it("muted, leaves it alone", async () => {
    await stage(1, false);
    await pass(3000);
    expect(be.held).toEqual([]);
  });

  it("with no sound track, leaves it alone even with its sound on", async () => {
    await stage(0, true);
    await pass(3000);
    expect(be.held).toEqual([]);
  });

  it("gives it back when it is muted", async () => {
    const v = await stage(1, true);
    await act(async () => {
      v.muted = true;
      v.dispatchEvent(new Event("volumechange"));
    });
    await pass(1100);
    expect(be.held).toEqual([true, false]);
  });

  it("gives it back when it is left", async () => {
    await stage(1, true);
    await act(async () => root.unmount());
    await pass(1100);
    expect(be.held).toEqual([true, false]);
    root = createRoot(document.createElement("div"));
  });
});
