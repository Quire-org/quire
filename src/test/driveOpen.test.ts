import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const be = vi.hoisted(() => ({ calls: [] as string[], status: null as unknown, unsharded: false }));
vi.mock("../lib/api", () => ({
  api: new Proxy(
    {
      libraryClaim: async () => void be.calls.push("claim"),
      vaultStatus: () => (be.calls.push("status"), be.status === "never" ? new Promise(() => {}) : Promise.resolve(be.status)),
      loadLibrary: async () => ({ version: 1, targets: [], ratings: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {}, ids: {} }),
      scanUnsorted: async () => [],
      scanAll: async () => [],
      vaultUnsharded: async () => (be.calls.push("unsharded?"), be.unsharded),
      vaultShard: async () => (be.calls.push("shard"), 3),
      vaultAdopt: async () => (be.calls.push("adopt"), { documents: ["tags", "scrapbook", "tagindex", "tagvectors"], restored: ["home"], aside: [], pictures: 12 }),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => null) },
  ),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useStore } = await import("../store");

afterAll(() => vi.dynamicImportSettled());

beforeEach(() => {
  be.calls = [];
  be.unsharded = false;
  useStore.setState({ toasts: [], root: null, loading: null } as never);
});

describe("opening a library on a drive", () => {
  it("that stops answering says so after 15 seconds, rather than waiting with no word", async () => {
    vi.useFakeTimers();
    be.status = "never";
    void useStore.getState().openRoot("/vol");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(useStore.getState().toasts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(useStore.getState().loading).toBe("Waiting for the drive to answer…");
    expect(useStore.getState().toasts[0].text).toMatch(/^The drive isn't answering/);
    vi.useRealTimers();
  });

  it("with a vault takes in what an earlier version left beside it, before reading the library, and says so", async () => {
    be.status = { exists: true, unlocked: true };
    await useStore.getState().openRoot("/vol3");
    expect(be.calls.indexOf("adopt")).toBeGreaterThan(be.calls.indexOf("status"));
    expect(useStore.getState().toasts.map((t) => t.text)).toContain(
      "Brought into the vault from before it was made: your tags, the scrapbook, the tag index, the Home, 12 scrapbook pictures (stickers, covers, artists' icons). The ones made since in their place are kept aside in the vault.",
    );
  });

  it("with a vault still in one folder moves its files into folders, once", async () => {
    be.status = { exists: true, unlocked: true };
    be.unsharded = true;
    await Promise.all([useStore.getState().openRoot("/vol2"), useStore.getState().openRoot("/vol2")]);
    await vi.waitFor(() => expect(be.calls.filter((c) => c === "shard")).toHaveLength(1));
    expect(useStore.getState().toasts.map((t) => t.text)).not.toContain(expect.stringMatching(/drive isn't answering/));
  });
});
