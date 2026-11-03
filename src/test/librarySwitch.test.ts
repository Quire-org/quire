import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, { get: () => async () => null }),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  rawPreviewUrl: async () => "",
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useStore } = await import("../store");
const { useFind } = await import("../findStore");
const { useDupes } = await import("../dupesStore");
const { useSources } = await import("../findSource");

afterAll(() => vi.dynamicImportSettled());

describe("another library opened", () => {
  it("keeps nothing of the last one in Find, Duplicates or Find source", () => {
    useStore.setState({ root: "/a" } as never);
    useFind.setState({ checks: { w1: { key: "Pics/x.jpg" } } as never, items: [{ id: "w1" }] as never, picks: ["w1"] as never, lookAt: { id: "w1" } as never });
    useDupes.setState({ groups: [{ keys: ["Pics/x.jpg", "Pics/y.jpg"] }] as never, ignored: [{ keys: ["Pics/x.jpg"] }] as never, cacheRoot: "/a", cache: { "Pics/x.jpg": {} } as never });
    useSources.setState({ found: [{ key: "Pics/x.jpg", matches: [] }], open: true });
    useStore.setState({ root: "/b" } as never);
    const f = useFind.getState();
    expect([f.checks, f.items, f.picks, f.lookAt]).toEqual([{}, [], [], null]);
    const d = useDupes.getState();
    expect([d.groups, d.ignored, d.cacheRoot, d.cache]).toEqual([[], [], null, {}]);
    expect(useSources.getState()).toMatchObject({ found: [], open: false });
  });
});
