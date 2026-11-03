import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// The real address helpers (api.ts), over a stand-in for Tauri's.
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string, proto = "asset") => `${proto}://localhost/${encodeURIComponent(p)}`, invoke: vi.fn(async () => null), Channel: class {} }));
const posters = vi.hoisted(() => ({ asked: [] as string[] }));
vi.mock("../lib/poster", () => ({ videoPoster: async (url: string) => (posters.asked.push(url), "blob:poster") }));

const { canThumb } = await import("../lib/api");
const { Thumb } = await import("../components/Thumb");
const { useStore } = await import("../store");

afterAll(() => vi.dynamicImportSettled());

const video = (vaultId?: string) =>
  ({ key: "Clips/a.mp4", name: "a.mp4", primary: "/vol/Clips/a.mp4", dir: "Clips", kind: "video", files: ["/vol/Clips/a.mp4"], size: 1, modified: 7, vaultId }) as never;

async function tile(item: never) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(Thumb, { item, eager: true, onClick: () => {} })));
  await act(async () => {});
  return { host, unmount: () => root.unmount() };
}

describe("a video's tile", () => {
  beforeEach(() => {
    posters.asked = [];
    useStore.setState({ root: "/vol" } as never);
  });

  it("has the backend's picture in a vault, where it is kept, and the window's own outside one", () => {
    expect(canThumb({ kind: "video", primary: "/vol/a.mp4", vaultId: "v1" })).toBe(true);
    expect(canThumb({ kind: "video", primary: "/vol/a.mp4" })).toBe(false);
    expect(canThumb({ kind: "image", primary: "/vol/a.jpg" })).toBe(true);
    expect(canThumb({ kind: "image", primary: "/vol/a.heic", vaultId: "v2" })).toBe(false);
  });

  it("in a vault shows the kept picture, and the window's own when the backend has none", async () => {
    const { host, unmount } = await tile(video("v1"));
    const img = host.querySelector(".thumb-media img") as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^thumb:\/\/localhost\/.*\?w=\d+&v=7&root=%2Fvol$/);
    expect(posters.asked).toEqual([]);
    // No ffmpeg, say: the window makes it from the vault's video.
    await act(async () => img.dispatchEvent(new Event("error")));
    await act(async () => {});
    expect(posters.asked).toEqual(["vault://localhost/v1"]);
    expect(host.querySelector(".thumb-media img")!.getAttribute("src")).toBe("blob:poster");
    unmount();
  });

  it("shows it is a video by its play button and the film strip by its name, not a word", async () => {
    const { host, unmount } = await tile(video());
    expect(posters.asked).toEqual(["asset://localhost/%2Fvol%2FClips%2Fa.mp4"]);
    expect(host.querySelector(".thumb-play")).not.toBeNull();
    expect(host.querySelector(".thumb-name svg")).not.toBeNull();
    expect(host.querySelector(".thumb-badges")!.textContent).toBe("");
    unmount();
  });
});
