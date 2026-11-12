import type { GitHubRepo } from "./api";

/** Whether what was typed is a link or a path to add, not words to look for a repository by. */
export function isSource(typed: string): boolean {
  return /^(https?:|git@|github\.com\/|[/~.]|[A-Za-z]:\\)/.test(typed.trim());
}

/** What to offer for the words typed: the sign-in's own repositories that match, by name, then what else GitHub found. */
export function offeredRepos(mine: GitHubRepo[], found: GitHubRepo[], words: string): GitHubRepo[] {
  const needle = words.trim().toLowerCase();
  const own = mine.filter((r) => r.fullName.toLowerCase().includes(needle)).sort((a, b) => a.fullName.localeCompare(b.fullName));
  const have = new Set(own.map((r) => r.fullName));
  return [...own, ...found.filter((r) => !have.has(r.fullName))];
}
