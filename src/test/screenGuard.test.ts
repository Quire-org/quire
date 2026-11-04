import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));
const opened = vi.hoisted(() => [] as string[]);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async (u: string) => void opened.push(u)) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.0") }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ScreenGuard, withoutPaths } = await import("../components/ScreenGuard");
const { useStore } = await import("../store");

function Broken(): never {
  throw new Error("rows went below zero reading /Volumes/Pictures/Private/holiday 2025.jpg");
}

describe("a screen that fails while drawing", () => {
  it("says so with the error and a way Home, instead of leaving the window empty", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const openHome = vi.fn();
    useStore.setState({ openHome } as never);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ScreenGuard, { screen: "albums" }, createElement(Broken))));
    expect(host.textContent).toContain("This screen ran into a problem");
    expect(host.textContent).toContain("rows went below zero");
    const button = (name: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === name)!;
    // Reported: GitHub's form, filled in with the error, the folders it names left out.
    await act(async () => button("Report issue").click());
    const form = new URL(opened[0]);
    expect(form.origin + form.pathname).toBe("https://github.com/Quire-org/quire/issues/new");
    expect(form.searchParams.get("title")).toBe("albums screen: rows went below zero reading …");
    expect(form.searchParams.get("body")).toContain("albums screen · Quire 0.1.0");
    expect(opened[0]).not.toContain("holiday");
    await act(async () => button("Home").click());
    expect(openHome).toHaveBeenCalled();
    quiet.mockRestore();
    root.unmount();
  });

  it("leaves the folders out of what it reports, wherever they are", () => {
    expect(withoutPaths('reading "/Volumes/Pictures/Private/holiday 2025.jpg": no such file')).toBe('reading "…": no such file');
    expect(withoutPaths("at C:\\Users\\x\\a b.png\nnext line")).toBe("at …\nnext line");
    expect(withoutPaths("Maximum update depth exceeded.")).toBe("Maximum update depth exceeded.");
  });
});
