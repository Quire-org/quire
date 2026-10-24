import { describe, expect, it } from "vitest";
import { strength } from "../lib/strength";

describe("passphrase strength", () => {
  it("flags the usual suspects as weak", () => {
    for (const p of ["password1", "Summer2024!", "qwerty123", "aaaaaaaaaa", "12345678"]) expect(strength(p).label, p).toBe("weak");
  });
  it("likes a few random words or a long random string", () => {
    expect(strength("correct horse battery staple").label).toBe("fair");
    expect(strength("velvet otter granite kettle bloom").label).toBe("good");
    expect(strength("Tq7#mVp2!xL9@kRw").label).toBe("strong");
  });
  it("is monotonic in length for random strings", () => {
    expect(strength("Tq7#mVp2").bits).toBeLessThan(strength("Tq7#mVp2!xL9").bits);
  });
});
