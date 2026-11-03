import { describe, expect, it } from "vitest";
import { flipped, isLeftOut, queryOf, termsOf, withTerms } from "../lib/queryTerms";

describe("a search as terms to add, flip and take off", () => {
  it("reads a search into its words, the left-out ones too", () => {
    expect(termsOf("flower  -sketch blue")).toEqual(["flower", "-sketch", "blue"]);
    expect(termsOf(" - ")).toEqual([]);
    expect(isLeftOut("-sketch")).toBe(true);
    expect(isLeftOut("-")).toBe(false);
  });

  it("adds what was typed after the terms there are, each word once", () => {
    expect(withTerms(["flower"], "red rose")).toEqual(["flower", "red", "rose"]);
    expect(withTerms(["flower", "red"], "flower")).toEqual(["flower", "red"]);
  });

  it("gives a word there already its new sign, in its place", () => {
    expect(withTerms(["flower", "sketch", "red"], "-sketch")).toEqual(["flower", "-sketch", "red"]);
    expect(withTerms(["flower", "-sketch"], "sketch")).toEqual(["flower", "sketch"]);
  });

  it("flips a term between needed and left out, and writes the search back", () => {
    expect(flipped("sketch")).toBe("-sketch");
    expect(flipped("-sketch")).toBe("sketch");
    expect(queryOf(["flower", "-sketch"])).toBe("flower -sketch");
  });
});
