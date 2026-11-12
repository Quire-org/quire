import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { useStore } = await import("../store");
const { useFinders, finder } = await import("../plugins/find");
const { useFind } = await import("../findStore");
const { useOnline } = await import("../lib/online");

describe("a platform behind Go online", () => {
  beforeEach(() => {
    useStore.setState({ root: "/vol" } as never);
    useFinders.setState({ finders: { a: { pluginId: "a", platform: "a", name: "A", sections: [{ id: "new", label: "New", kind: "works", options: [] }], artistOptions: [] } } } as never);
    useFind.setState({ pluginId: null, account: null, accountFor: null, items: [], error: null } as never);
    useOnline.setState({ settings: { ask: true, each: false, keep: false }, connected: { all: false, platforms: [] } });
  });

  it("is asked nothing until Connect, which then loads it with no error to try again from", async () => {
    const account = vi.spyOn(finder, "account").mockResolvedValue({ signedIn: true } as never);
    const list = vi.spyOn(finder, "list").mockResolvedValue({ items: [{ id: "w1" } as never], artists: [], next: null } as never);
    useFind.getState().choose("a");
    await new Promise((r) => setTimeout(r, 10));
    expect(account).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();

    useOnline.getState().connect();
    // As Find does the moment it may go online.
    await useFind.getState().refreshAccount();
    await vi.waitFor(() => expect(useFind.getState().items.map((i) => i.id)).toEqual(["w1"]));
    expect(useFind.getState().error).toBeNull();
    expect(account).toHaveBeenCalledOnce();
  });
});
