import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({ api: {}, fileSrc: (p: string) => p, mediaUrl: () => "" }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { PluginButtons } = await import("../components/PluginButtons");
const { useStore } = await import("../store");
const { usePlugins } = await import("../plugins/store");

const btn = (pluginId: string, id: string, label: string) => ({ pluginId, id, location: "viewer.toolbar" as const, label });

describe("plugins in the viewer bar", () => {
  it("are all behind one Plugins button: a panel by its plugin's name, buttons under theirs", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const manifest = (id: string, name: string) => ({ id, dir: "", manifest: { id, name, version: "1", description: "", author: "", entry: "", permissions: [], settings: [] }, state: { enabled: true, allowVault: false, granted: [], source: "", installedAt: 0 } });
    usePlugins.setState({
      list: [manifest("md", "Page Cleaner"), manifest("other", "Reader"), manifest("tr", "Translate")],
      buttons: [btn("md", "clean", "Clean"), btn("md", "mark", "Mark"), btn("other", "one", "Read"), btn("tr", "go", "Translate page")],
      panels: { tr: { pluginId: "tr", title: "Translate", controls: [] } },
      panelOpen: null,
    } as never);
    useStore.setState({ editMode: false, pluginsOpen: false } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(PluginButtons, { location: "viewer.toolbar", compact: true, context: () => ({}) })));
    // However many plugins: one button in the bar.
    expect(Array.from(host.querySelectorAll("button")).map((b) => b.title)).toEqual(["Plugins"]);
    await act(async () => host.querySelector("button")!.click());
    const menu = () => Array.from(document.querySelectorAll(".plugin-menu > button, .plugin-menu > .pop-list > *")).map((b) => b.textContent);
    // By name: Page Cleaner's two buttons under its name, Reader's one beside its name, Translate's panel (its buttons live in it).
    expect(menu()).toEqual(["Page Cleaner", "Clean", "Mark", "ReadReader", "Translate"]);
    const item = (text: string) => Array.from(document.querySelectorAll(".plugin-menu button")).find((b) => b.textContent?.startsWith(text)) as HTMLButtonElement;
    // The panel opens from the menu, without Edit, and the menu closes.
    await act(async () => item("Translate").click());
    expect(usePlugins.getState().panelOpen).toBe("tr");
    expect(useStore.getState().editMode).toBe(false);
    expect(document.querySelector(".plugin-menu")).toBeNull();
    expect(host.querySelector("button")!.title).toBe("Plugins: Translate is open");
    expect(host.querySelector("button")!.className).toContain("active");
    // Open again: it says so, and closes it from there.
    await act(async () => host.querySelector("button")!.click());
    expect(item("Translate").textContent).toBe("Translateopen");
    await act(async () => item("Translate").click());
    expect(usePlugins.getState().panelOpen).toBeNull();
    // Manage plugins… opens the Plugins dialog.
    await act(async () => host.querySelector("button")!.click());
    await act(async () => (Array.from(document.querySelectorAll(".pop-actions button")).find((b) => b.textContent === "Manage plugins…") as HTMLButtonElement).click());
    expect(useStore.getState().pluginsOpen).toBe(true);
    root.unmount();
  });

  it("show nothing when no plugin added anything", async () => {
    usePlugins.setState({ buttons: [], panels: {}, panelOpen: null } as never);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(PluginButtons, { location: "viewer.toolbar", compact: true, context: () => ({}) })));
    expect(host.querySelector("button")).toBeNull();
    root.unmount();
  });
});
