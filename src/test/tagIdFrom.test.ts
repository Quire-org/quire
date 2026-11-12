import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));

const { tagIdFrom } = await import("../tagsStore");

describe("a tag as typed", () => {
  it("keeps a folder given, and otherwise goes in the one named, the first, or tags", () => {
    expect(tagIdFrom(" motives / cat ", ["style"])).toBe("motives/cat");
    expect(tagIdFrom("cat", ["style", "motives"])).toBe("style/cat");
    expect(tagIdFrom("cat", ["style"], "motives")).toBe("motives/cat");
    expect(tagIdFrom("cat", [])).toBe("tags/cat");
    expect(tagIdFrom("   ", ["style"])).toBeNull();
  });
});
