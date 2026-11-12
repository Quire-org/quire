import { describe, expect, it } from "vitest";
import type { GitHubRepo } from "../lib/api";
import { isSource, offeredRepos } from "../lib/githubRepos";

const repo = (fullName: string, priv = false): GitHubRepo => ({ fullName, private: priv, description: null, htmlUrl: `https://github.com/${fullName}` });

describe("repositories offered for a plugin", () => {
  it("tells words from a link or a path", () => {
    for (const s of ["https://github.com/ann/ms", "github.com/ann/ms", "git@github.com:ann/ms.git", "/Users/ann/plugin", "~/plugin", "C:\\plugins\\x"]) expect(isSource(s)).toBe(true);
    for (const s of ["", "reader", "ann/ms", "page reader"]) expect(isSource(s)).toBe(false);
  });

  it("lists the sign-in's own by name, narrowed by the words, before what else GitHub found, each once", () => {
    const mine = [repo("org/zeta", true), repo("org/alpha", true), repo("org/reader", true)];
    expect(offeredRepos(mine, [], "").map((r) => r.fullName)).toEqual(["org/alpha", "org/reader", "org/zeta"]);
    expect(offeredRepos(mine, [repo("org/reader", true), repo("else/reader")], "READ").map((r) => r.fullName)).toEqual(["org/reader", "else/reader"]);
  });
});
