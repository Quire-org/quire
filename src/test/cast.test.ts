import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// The backend's showing: what was asked of it, and what it answers.
const be = vi.hoisted(() => ({
  frames: [] as { seq: number; jpeg: string | null; name: string; video: boolean; index: number; total: number; none: boolean; videoPath?: string | null; root?: string | null }[],
  decided: [] as [string, boolean][],
  status: { running: true, devices: [] as { id: string; name: string; ip: string; state: string }[], nav: [] as number[] },
  stopped: 0,
}));
vi.mock("../lib/api", () => ({
  api: {
    castStart: vi.fn(async () => ({ urls: [{ iface: "en0", url: "https://10.4.0.7:51000/abc/" }, { iface: "bridge100", url: "https://172.20.10.2:51000/abc/" }], fingerprint: "4F 2A 91 C0 11 22 33 44 55 66" })),
    castStop: vi.fn(async () => void be.stopped++),
    castFrame: vi.fn(async (seq: number, jpeg: string | null, name: string, video: boolean, index: number, total: number, none: boolean, videoPath: string | null = null, root: string | null = null) => void be.frames.push({ seq, jpeg, name, video, index, total, none, videoPath, root })),
    castStatus: vi.fn(async () => {
      const s = { ...be.status };
      be.status = { ...be.status, nav: [] };
      return s;
    }),
    castDecide: vi.fn(async (id: string, allow: boolean) => void be.decided.push([id, allow])),
    castRemote: vi.fn(async () => {}),
    saveHistory: vi.fn(async () => {}),
  },
  mediaUrl: () => "",
  rawPreviewUrl: async () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
  storedPath: (r: string, p: string) => p.slice(r.length + 1),
  setCurrentRoot: () => {},
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { useStore } = await import("../store");
const { useCast, CastHost } = await import("../components/Cast");

const video = (key: string) => ({ key, primary: `/vol/${key}`, files: [`/vol/${key}`], kind: "video", name: key, dir: "", size: 1, modified: 1, hasRaw: false, hasVideo: true });
const last = () => be.frames[be.frames.length - 1];
const settle = async (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return { host, root };
}

describe("showing on another device", () => {
  it("is off until started; then a device asks, and is let in only by a yes here", async () => {
    useStore.setState({ root: "/vol", screen: "viewer", queue: [video("a.mp4"), video("b.mp4")], index: 0 } as never);
    useCast.setState({ info: null, devices: [], panel: false, remote: true });
    const { host, root } = mount();
    await act(async () => root.render(createElement(CastHost)));
    expect(be.frames).toEqual([]);
    await act(async () => useCast.getState().start());
    await settle(10);
    // What the viewer shows went out: a video, to stream from its file (no picture of it).
    expect(last()).toMatchObject({ name: "a.mp4", video: true, index: 0, total: 2, jpeg: null, videoPath: "/vol/a.mp4", root: "/vol" });
    // A device asks: the Mac is asked.
    be.status = { running: true, devices: [{ id: "d1", name: "iPhone", ip: "172.20.10.3", state: "pending" }], nav: [] };
    await settle(1100);
    const ask = host.querySelector(".cast-ask")!;
    expect(ask.textContent).toContain("iPhone");
    expect(ask.textContent).toContain("172.20.10.3");
    await act(async () => (Array.from(ask.querySelectorAll("button")).find((b) => b.textContent?.includes("Allow")) as HTMLButtonElement).click());
    expect(be.decided).toEqual([["d1", true]]);
    root.unmount();
    await act(async () => useCast.getState().stop());
  });

  it("follows the viewer, goes on when an allowed device swipes, shows nothing elsewhere, and stops with the library", async () => {
    be.frames = [];
    be.stopped = 0;
    useStore.setState({ root: "/vol", screen: "viewer", queue: [video("a.mp4"), video("b.mp4"), video("c.mp4")], index: 0 } as never);
    useCast.setState({ info: null, devices: [], panel: false, remote: true });
    const { root } = mount();
    await act(async () => root.render(createElement(CastHost)));
    await act(async () => useCast.getState().start());
    await settle(10);
    await act(async () => useStore.setState({ index: 1 }));
    await settle(200);
    expect(last()).toMatchObject({ name: "b.mp4", index: 1 });
    // The phone swiped on: the viewer goes on, and the phone gets that.
    be.status = { running: true, devices: [{ id: "d1", name: "iPhone", ip: "172.20.10.3", state: "allowed" }], nav: [1] };
    await settle(1100);
    expect(useStore.getState().index).toBe(2);
    await settle(200);
    expect(last()).toMatchObject({ name: "c.mp4", index: 2 });
    // Another screen: nothing is shown.
    await act(async () => useStore.setState({ screen: "browse" } as never));
    await settle(200);
    expect(last()).toMatchObject({ none: true });
    // Its frames only ever count up (an old picture can't come back after a newer one).
    const seqs = be.frames.map((f) => f.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    // The library closes: showing stops.
    await act(async () => useStore.setState({ root: null } as never));
    await settle(10);
    expect(be.stopped).toBe(1);
    expect(useCast.getState().info).toBeNull();
    root.unmount();
  });

  it("offers the link on a shared connection (a hotspot) before Wi-Fi, as a QR code, with the certificate's fingerprint", async () => {
    useStore.setState({ root: "/vol" } as never);
    useCast.setState({ info: { urls: [{ iface: "en0", url: "https://10.4.0.7:51000/abc/" }, { iface: "bridge100", url: "https://172.20.10.2:51000/abc/" }], fingerprint: "4F 2A 91 C0 11 22 33 44 55 66" }, devices: [], panel: true });
    const { root } = mount();
    await act(async () => root.render(createElement(CastHost)));
    const panel = document.querySelector(".cast")!;
    expect(panel.querySelector(".cast-url")?.textContent).toBe("https://172.20.10.2:51000/abc/");
    expect(panel.textContent).toContain("an iPhone's hotspot");
    expect(panel.querySelector(".cast-qr path")?.getAttribute("d")?.length).toBeGreaterThan(100);
    expect(panel.querySelector(".cast-fp")?.textContent).toContain("4F 2A 91 C0");
    // On a hotspot: no warning about strangers.
    expect(panel.textContent).toContain("only your own devices are on it");
    root.unmount();
    // On the accommodation's Wi-Fi only: the warning, and the advice.
    const again = mount();
    await act(async () => again.root.render(createElement(CastHost)));
    await act(async () => useCast.setState({ info: { urls: [{ iface: "en0", url: "https://10.4.0.7:51000/abc/" }], fingerprint: "4F 2A" }, panel: true }));
    expect(document.querySelector(".cast")!.textContent).toContain("join your phone's hotspot");
    again.root.unmount();
    useCast.setState({ info: null, panel: false });
  });

  it("while a device you let in watches, the Mac's viewer doesn't play the video too", async () => {
    // jsdom plays nothing: pausing is all that is asked of it here.
    HTMLMediaElement.prototype.pause = () => {};
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const { MediaStage } = await import("../components/MediaStage");
    const { createRef } = await import("react");
    useCast.setState({ info: { urls: [], fingerprint: "" }, devices: [{ id: "d1", name: "iPhone", ip: "172.20.10.3", state: "allowed" }], panel: false });
    const { host, root } = mount();
    const ref = createRef<HTMLVideoElement>();
    await act(async () => root.render(createElement(MediaStage, { item: video("clip.mp4") as never, videoRef: ref })));
    expect(host.querySelector("video")!.autoplay).toBe(false);
    expect(host.querySelector(".video-elsewhere")?.textContent).toContain("Playing on the iPhone");
    // No one watching (or not showing): it plays here as before.
    await act(async () => useCast.setState({ devices: [{ id: "d1", name: "iPhone", ip: "172.20.10.3", state: "pending" }] }));
    expect(host.querySelector(".video-elsewhere")).toBeNull();
    root.unmount();
    const again = mount();
    await act(async () => again.root.render(createElement(MediaStage, { item: video("clip.mp4") as never, videoRef: createRef<HTMLVideoElement>() })));
    expect(again.host.querySelector("video")!.autoplay).toBe(true);
    again.root.unmount();
    useCast.setState({ info: null, devices: [] });
  });
});
