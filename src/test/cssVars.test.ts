import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Every CSS variable the styles use exists: a theme defines it, or it is set where it is used (an
 * inline style, a rule of its own). A misspelt one (--accent2 for --accent-2) silently draws nothing.
 */
// Tests run from the project root (under jsdom, import.meta.url isn't a file path).
const files = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "test" ? [] : files(`${dir}/${e.name}`, ext)) : ext.test(e.name) ? [`${dir}/${e.name}`] : []));
const read = (ext: RegExp) => files("src", ext).map((f) => readFileSync(f, "utf8")).join("\n");

describe("theme colours and other CSS variables", () => {
  it("are all defined somewhere", () => {
    const css = read(/\.css$/);
    const code = read(/\.tsx?$/);
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g), ...code.matchAll(/["'`](--[a-z0-9-]+)["'`]/g), ...code.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    // Set from script (sizes measured at run time).
    for (const v of ["--hud-top-h", "--hud-bottom-h", "--panel-top"]) defined.add(v);
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g), ...code.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((v) => !defined.has(v)).sort()).toEqual([]);
  });
});
