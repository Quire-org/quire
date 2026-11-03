import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { themes } from "../themes";

/** The colour tokens every theme sets, in its own mode and in the other. */
const COLOURS = ["--bg", "--bg-2", "--bg-3", "--fg", "--fg-dim", "--fg-faint", "--accent", "--accent-fg", "--accent-2", "--danger", "--ok", "--warn", "--border", "--border-strong", "--hud-bg"];

const tokensIn = (css: string, selector: string): Set<string> => {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return new Set();
  const body = css.slice(at, css.indexOf("}", at));
  return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
};

describe("every theme in both modes", () => {
  it("sets its colours for its own mode and again for the other", () => {
    for (const t of themes) {
      const css = readFileSync(`src/themes/${t.id}.css`, "utf8");
      const own = tokensIn(css, `[data-theme="${t.id}"]`);
      const other = tokensIn(css, `[data-theme="${t.id}"][data-mode="${t.native === "dark" ? "light" : "dark"}"]`);
      expect(COLOURS.filter((c) => !own.has(c)), `${t.id} in its own mode`).toEqual([]);
      expect(COLOURS.filter((c) => !other.has(c)), `${t.id} in its other mode`).toEqual([]);
    }
  });

  it("puts the theme and the mode on the root, and resolves the system's", async () => {
    const { applyLook, resolveMode } = await import("../themes");
    expect(["light", "dark"]).toContain(resolveMode("system"));
    expect(applyLook("manga", "dark")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("manga");
    expect(document.documentElement.dataset.mode).toBe("dark");
    expect(applyLook("cp2077", "light")).toBe("light");
    expect(document.documentElement.dataset.mode).toBe("light");
  });
});
