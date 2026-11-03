import { describe, expect, it, vi } from "vitest";

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

describe("Find opened at an artist's works on another platform", () => {
  it("shows their works once the platform says who is signed in", async () => {
    useStore.setState({ root: "/vol" } as never);
    useFinders.setState({ finders: { a: { pluginId: "a", platform: "a", name: "A", sections: [{ id: "new", label: "New", kind: "works", options: [] }], artistOptions: [{ value: "works", label: "W" }], sites: null } as never, b: { pluginId: "b", platform: "b", name: "B", sections: [{ id: "rec", label: "Rec", kind: "works", options: [] }], artistOptions: [{ value: "works", label: "W" }], sites: null } as never } });
    useFind.setState({ pluginId: "a" } as never);
    let signedIn = () => {};
    vi.spyOn(finder, "account").mockImplementation(() => new Promise((r) => (signedIn = () => r({ signedIn: true }))));
    const list = vi.spyOn(finder, "list").mockImplementation(async (_id, args) => ({ items: args.section === "artist" ? [{ id: "w1" } as never] : [{ id: "rec1" } as never], artists: [], artist: null, next: null, title: null, total: null }));
    useFind.getState().choose("b");
    useFind.getState().open({ section: "artist", author: { id: "7", name: "Kaze" } });
    await new Promise((r) => setTimeout(r, 10));
    signedIn();
    await vi.waitFor(() => expect(useFind.getState().loading).toBe(false));
    await new Promise((r) => setTimeout(r, 10));
    expect(useFind.getState().view.section).toBe("artist");
    expect(useFind.getState().items.map((i) => i.id)).toEqual(["w1"]);
    expect(list.mock.calls.every(([, a]) => a.section === "artist")).toBe(true);
  });
});
