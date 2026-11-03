import { describe, expect, it } from "vitest";
import { justify, ratioOf } from "../lib/justify";

describe("justified rows", () => {
  it("fills each row to the width and leaves the last at the target height", () => {
    const rows = justify([1, 1, 1, 1, 1, 0.5], 1000, 300, 10);
    expect(rows.map((r) => [r.start, r.end])).toEqual([
      [0, 4],
      [4, 6],
    ]);
    // Four squares and three gaps make the width exactly.
    expect(rows[0].height * 4 + 30).toBeCloseTo(1000);
    expect(rows[1].height).toBe(300);
  });

  it("puts a picture wider than the row on a row of its own", () => {
    const rows = justify([3, 1], 500, 300, 10);
    expect(rows[0]).toEqual({ start: 0, end: 1, height: 500 / 3 });
  });

  it("has nothing to lay out without a width", () => {
    expect(justify([1, 1], 0, 300, 10)).toEqual([]);
  });

  it("keeps extreme shapes within reason", () => {
    expect(ratioOf(100, 10_000)).toBe(0.33);
    expect(ratioOf(10_000, 100)).toBe(3);
    expect(ratioOf(0, 0)).toBe(0.75);
    expect(ratioOf(1200, 1600)).toBe(0.75);
  });
});
