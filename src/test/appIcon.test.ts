import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({ api: { setAppIcon: vi.fn(async () => {}) } }));

import { fillIcon, ICON_SLOTS } from "../lib/appIcon";

describe("app icon template", () => {
  const colors = { bg: "#111111", ink: "#eeeeee" };

  it("fills every slot and leaves no placeholder behind", () => {
    const svg = fillIcon(colors);
    expect(svg).not.toMatch(/\{\{/);
    for (const value of Object.values(colors)) expect(svg).toContain(value);
  });

  it("declares an explicit square size so canvas rasterising is exact", () => {
    const svg = fillIcon(colors);
    expect(svg).toMatch(/<svg[^>]*width="1024"[^>]*height="1024"/);
  });

  it("maps slots to theme variables that every theme defines", () => {
    expect(Object.values(ICON_SLOTS)).toEqual(["--bg-2", "--accent"]);
  });
});
