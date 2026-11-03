import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("../lib/api", () => ({
  api: { saveLibrary: vi.fn(async () => {}), loadCache: vi.fn(async () => null) },
  storedPath: (r: string, p: string) => p.slice(r.length + 1),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

const { useStore } = await import("../store");
const { LanguageRows } = await import("../screens/Albums");

describe("an album's languages", () => {
  it("with a translated version: a row for the original and one for the translation, each set on its own", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useStore.setState({ library: { version: 1, targets: [], trashDir: "_deleted", albumRoots: ["Albums"], autoDecodeAlbumNames: false, ratings: {}, ids: {}, albumRatings: {}, albumLanguages: { "Albums/Tale": "ja" } }, albums: [{ key: "Albums/Tale EN", name: "Tale EN", path: "/vol/Albums/Tale EN", count: 3, cover: null }] } as never);
    const picks: [string, string | null][] = [];
    const onPick = (key: string, code: string | null) => {
      picks.push([key, code]);
      const lib = useStore.getState().library!;
      useStore.setState({ library: { ...lib, albumLanguages: { ...lib.albumLanguages, [key]: code ?? undefined } } } as never);
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(LanguageRows, { album: "Albums/Tale", translation: "Albums/Tale EN", onPick })));
    const rows = host.querySelectorAll(".lang-row");
    expect(Array.from(rows).map((r) => r.querySelector(".label")!.textContent)).toEqual(["Original", "Translated: Tale EN"]);
    const flag = (row: Element, code: string) => Array.from(row.querySelectorAll("button")).find((b) => b.getAttribute("title") === code) as HTMLButtonElement;
    expect(flag(rows[0], "Japanese").classList.contains("active")).toBe(true);
    // The translation's language: set, and shown at once.
    await act(async () => flag(rows[1], "English").click());
    expect(picks).toEqual([["Albums/Tale EN", "en"]]);
    expect(flag(host.querySelectorAll(".lang-row")[1], "English").classList.contains("active")).toBe(true);
    expect(flag(host.querySelectorAll(".lang-row")[0], "Japanese").classList.contains("active")).toBe(true);
    // Without one: a single Language row.
    await act(async () => root.render(createElement(LanguageRows, { album: "Albums/Tale", onPick })));
    expect(Array.from(host.querySelectorAll(".lang-row .label")).map((l) => l.textContent)).toEqual(["Language"]);
    root.unmount();
  });
});
