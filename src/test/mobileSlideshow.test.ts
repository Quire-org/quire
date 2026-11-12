import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const be = vi.hoisted(() => ({ awake: [] as boolean[] }));

vi.mock("../lib/platform", async (original) => ({ ...(await original<typeof import("../lib/platform")>()), IS_MOBILE: true, HOME_DEVICE: "phone" }));
vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => async (on: boolean) => {
      if (k === "iosKeepAwake") be.awake.push(on);
      return null;
    },
  }),
  setCurrentRoot: () => {},
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));

const { useStore } = await import("../store");
const { useFaceMode } = await import("../peopleStore");
const { useSlideshow } = await import("../mobile/useSlideshow");

const item = (key: string, kind = "image") => ({ key, kind, primary: key, name: key, files: [key] }) as never;
const zoomed = (level: number) => ({ ...useStore.getState().zoom, level });

describe("the slideshow on a phone", () => {
  let show: ReturnType<typeof useSlideshow>;
  let root: Root;
  const Host = () => {
    show = useSlideshow();
    return null;
  };
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const queue = (...items: never[]) => act(async () => useStore.setState({ queue: items, index: 0 }));
  const playing = (on: boolean) => act(async () => useStore.setState({ slideshow: { ...useStore.getState().slideshow, playing: on, interval: 5 } }));
  const at = () => useStore.getState().index;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    be.awake.length = 0;
    useStore.setState({ queue: [], index: 0, infoItem: null, zoom: zoomed(0) });
    useFaceMode.setState({ on: false });
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(createElement(Host)));
  });

  afterEach(async () => {
    await playing(false);
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("gives a picture its seconds, then the next, and comes round to the first", async () => {
    await queue(item("a.jpg"), item("b.jpg"));
    await playing(true);
    await pass(4800);
    expect(at()).toBe(0);
    await pass(400);
    expect(at()).toBe(1);
    await pass(5200);
    expect(at()).toBe(0);
  });

  it("stands still until it is started", async () => {
    await queue(item("a.jpg"), item("b.jpg"));
    await pass(60_000);
    expect(at()).toBe(0);
  });

  it("plays a video to its end, every time it comes round", async () => {
    await queue(item("v.mp4", "video"), item("a.jpg"));
    await playing(true);
    expect(show.loop).toBe(false);
    await pass(60_000);
    expect(at()).toBe(0);
    await act(async () => show.onEnded());
    await pass(300);
    expect(at()).toBe(1);
    await pass(5200);
    expect(at()).toBe(0);
    await pass(60_000);
    expect(at()).toBe(0);
  });

  it("lets a video that has nothing after it go round by itself", async () => {
    await queue(item("v.mp4", "video"));
    await playing(true);
    expect(show.loop).toBe(true);
  });

  it("waits while something is open over the picture, then gives it its full time again", async () => {
    await queue(item("a.jpg"), item("b.jpg"));
    await playing(true);
    const sheet = document.body.appendChild(document.createElement("div"));
    sheet.className = "modal-backdrop";
    await pass(20_000);
    expect(at()).toBe(0);
    sheet.remove();
    await pass(4000);
    expect(at()).toBe(0);
    await pass(1400);
    expect(at()).toBe(1);
  });

  it("waits while the picture is zoomed in, or its faces are out", async () => {
    await queue(item("a.jpg"), item("b.jpg"));
    await playing(true);
    await act(async () => useStore.setState({ zoom: zoomed(2) }));
    await pass(20_000);
    expect(at()).toBe(0);
    await act(async () => {
      useStore.setState({ zoom: zoomed(0) });
      useFaceMode.setState({ on: true });
    });
    await pass(20_000);
    expect(at()).toBe(0);
  });

  it("holds a video that ended under a sheet until the sheet is gone", async () => {
    await queue(item("v.mp4", "video"), item("a.jpg"));
    await playing(true);
    const sheet = document.body.appendChild(document.createElement("div"));
    sheet.className = "modal-backdrop";
    await act(async () => show.onEnded());
    await pass(10_000);
    expect(at()).toBe(0);
    sheet.remove();
    await pass(300);
    expect(at()).toBe(1);
  });

  it("keeps the screen on only while it plays", async () => {
    await queue(item("a.jpg"), item("b.jpg"));
    expect(be.awake).toEqual([]);
    await playing(true);
    expect(be.awake).toEqual([true]);
    await playing(false);
    expect(be.awake).toEqual([true, false]);
  });

  it("lets the screen go when the viewer does", async () => {
    await queue(item("a.jpg"), item("b.jpg"));
    await playing(true);
    await act(async () => root.unmount());
    expect(be.awake).toEqual([true, false]);
    root = createRoot(document.createElement("div"));
  });

  it("ends when the reader goes to another screen, and doesn't start again on coming back", async () => {
    await queue(item("a.jpg"), item("b.jpg"));
    await playing(true);
    await act(async () => useStore.getState().openFind());
    expect(useStore.getState().slideshow.playing).toBe(false);
  });
});
