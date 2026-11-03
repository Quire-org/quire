import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (async () => null) }),
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
  fileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe() {}
  disconnect() {}
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TopNav } = await import("../components/TopNav");
const { Find } = await import("../screens/Find");
const { useFinders } = await import("../plugins/find");
const { useFind } = await import("../findStore");
const { useStore } = await import("../store");

const platform = (pluginId: string, name: string, more: object = {}) => ({ pluginId, name, platform: pluginId, site: null, imageHeaders: {}, sections: [{ id: "latest", label: "Latest", query: false, options: [], kind: "works" }], artistOptions: [], follows: false, artistTags: false, signIn: null, taggerWords: false, lookup: false, accounts: true, albums: false, sites: null, ...more });

describe("Find's platforms in the top bar", () => {
  it("are a tab each, the one shown on, and a tab opens its platform", async () => {
    useFinders.setState({ finders: { a: platform("a", "First"), b: platform("b", "Second") } as never });
    useFind.setState({ pluginId: "b" } as never);
    useStore.setState({ root: "/vol", screen: "find" } as never);
    const box = document.createElement("div");
    const root = createRoot(box);
    await act(async () => root.render(createElement(TopNav, { current: "find" })));
    const tabs = Array.from(box.querySelectorAll<HTMLButtonElement>(".subtab"));
    expect(tabs.map((t) => [t.textContent?.trim(), t.classList.contains("on")])).toEqual([
      ["First", false],
      ["Second", true],
    ]);
    await act(async () => tabs[0].click());
    expect(useFind.getState().pluginId).toBe("a");
    expect(Array.from(box.querySelectorAll(".subtab.on")).map((t) => t.textContent?.trim())).toEqual(["First"]);
    await act(async () => root.unmount());
  });

  it("show Find for a platform of sites without accounts, its site picker in the side panel", async () => {
    useFinders.setState({ finders: { s: platform("s", "Sites", { accounts: false, albums: true, sites: { list: [{ id: "a.example", name: "a.example" }], current: "a.example", help: "" } }) } as never });
    useFind.setState({ pluginId: null } as never);
    const box = document.createElement("div");
    const root = createRoot(box);
    await act(async () => root.render(createElement(Find)));
    expect(box.querySelector(".topnav .subtab.on")?.textContent?.trim()).toBe("Sites");
    expect(box.querySelector(".find-sites .sel-btn")?.textContent).toContain("a.example");
    expect(box.querySelector('.find-sites button[title="Add a site by its address"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("keeps a work asked for from elsewhere looked at while the view behind it changes", async () => {
    const { finder } = await import("../plugins/find");
    const item = { id: "w1", title: "A work", author: { id: "7", name: "Kaze", account: "kaze" }, url: null, thumb: "https://img.example.org/w1.jpg", width: 1, height: 1, pages: 1, kind: "image", tags: [], date: null, adult: false, ai: false, likes: 0, views: 0 };
    const work = vi.spyOn(finder, "work").mockResolvedValue({ item, pages: [{ preview: "https://img.example.org/w1-big.jpg", thumb: null }], caption: "" } as never);
    const list = vi.spyOn(finder, "list").mockResolvedValue({ items: [], artists: [], artist: null, next: null, title: null, total: null });
    const account = vi.spyOn(finder, "account").mockResolvedValue({ signedIn: true });
    useFinders.setState({ finders: { p: platform("p", "Plat", { accounts: false }) } as never });
    useFind.setState({ pluginId: "p", account: { signedIn: true }, accountFor: null, lookAt: item } as never);
    const box = document.createElement("div");
    const root = createRoot(box);
    await act(async () => root.render(createElement(Find)));
    // Still asking who is signed in, then a view opened behind it: the work stays looked at.
    await vi.waitFor(() => expect(box.querySelector(".find-preview-title")?.textContent).toBe("A work"));
    await act(async () => useFind.getState().open({ section: "latest" }));
    expect(box.querySelector(".find-preview-title")?.textContent).toBe("A work");
    work.mockRestore();
    list.mockRestore();
    account.mockRestore();
    await act(async () => root.unmount());
  });
});
