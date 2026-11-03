import { afterAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({
  api: new Proxy({} as Record<string, unknown>, { get: () => async () => null }),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null), Channel: class {} }));

const { PluginLogo } = await import("../components/PluginLogo");
const { useFinders } = await import("../plugins/find");

afterAll(() => vi.dynamicImportSettled());

const plugin = (id: string, icon: string | null) => ({ id, manifest: null, state: { enabled: true, allowVault: false, granted: [], source: "", installedAt: 0 }, dir: "", icon });
const OWN = "data:image/png;base64,AAAA";
const SITE = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";

async function logo(p: ReturnType<typeof plugin>) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(createElement(PluginLogo, { plugin: p })));
  const box = host.querySelector(".plugin-logo") as HTMLElement;
  const out = { src: box.querySelector("img")?.getAttribute("src") ?? null, mark: !!box.querySelector("svg"), size: box.style.width };
  root.unmount();
  return out;
}

describe("a plugin's logo", () => {
  it("is its own, else its platform's icon, else the plugin mark, always one size", async () => {
    useFinders.setState({ finders: { site: { icon: SITE } } as never });
    expect(await logo(plugin("own", OWN))).toEqual({ src: OWN, mark: false, size: "28px" });
    expect(await logo(plugin("site", null))).toEqual({ src: SITE, mark: false, size: "28px" });
    expect(await logo(plugin("plain", null))).toEqual({ src: null, mark: true, size: "28px" });
  });
});
