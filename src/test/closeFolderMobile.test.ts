import { beforeEach, describe, expect, it, vi } from "vitest";

const be = vi.hoisted(() => ({ calls: [] as string[], fail: null as string | null }));

vi.mock("../lib/platform", async (original) => ({ ...(await original<typeof import("../lib/platform")>()), IS_MOBILE: true, HOME_DEVICE: "tablet" }));
vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => async () => {
      be.calls.push(k);
      if (k === be.fail) throw new Error("no");
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
const { useJobs } = await import("../lib/jobs");

describe("closing a library on a phone or tablet", () => {
  const toast = vi.fn();
  beforeEach(() => {
    be.calls.length = 0;
    be.fail = null;
    toast.mockClear();
    useJobs.setState({ jobs: [] });
    useStore.setState({ root: "/vol", toast } as never);
  });

  it("locks the vault and lets go of the drive before saying it can be unplugged", async () => {
    useStore.getState().closeRoot();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith("Everything is saved. You can unplug the drive.", "ok"));
    expect(be.calls.indexOf("libraryRelease")).toBeLessThan(be.calls.indexOf("vaultLock"));
    expect(be.calls.indexOf("vaultLock")).toBeLessThan(be.calls.indexOf("iosCloseFolder"));
  });

  it("leaves the drive alone while a job is still at work on it", async () => {
    useJobs.setState({ jobs: [{ id: "j" }] } as never);
    useStore.getState().closeRoot();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("still running"), "warn"));
    expect(be.calls).not.toContain("iosCloseFolder");
    expect(be.calls).not.toContain("vaultLock");
  });

  it("doesn't say the drive can be unplugged when letting go of it failed", async () => {
    be.fail = "vaultLock";
    useStore.getState().closeRoot();
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining("no"), "error"));
    expect(toast).not.toHaveBeenCalledWith("Everything is saved. You can unplug the drive.", "ok");
  });
});
