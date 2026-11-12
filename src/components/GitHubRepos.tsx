import { useEffect, useState } from "react";
import { GithubLogo, LockKey } from "@phosphor-icons/react";
import { api, type GitHubRepo } from "../lib/api";
import { isSource, offeredRepos } from "../lib/githubRepos";

/** How long after the last key GitHub is asked (its search allows a few a minute), and how many are listed. */
const SEARCH_AFTER_MS = 400;
const LISTED = 30;

/**
 * Repositories to add a plugin from, for someone signed in to GitHub: their own (private ones too)
 * as they are, narrowed by what is typed, and what else GitHub finds by those words. A link or a
 * path typed instead is added as it is, and this steps aside.
 */
export function GitHubRepos({ typed, disabled, onPick }: { typed: string; disabled: boolean; onPick: (url: string) => void }) {
  const [mine, setMine] = useState<GitHubRepo[] | null>(null);
  const [found, setFound] = useState<{ of: string; repos: GitHubRepo[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const words = isSource(typed) ? "" : typed.trim();

  useEffect(() => {
    api.githubMyRepos().then(setMine, (e) => {
      setMine([]);
      setProblem(String(e));
    });
  }, []);
  useEffect(() => {
    if (words.length < 2) return;
    let stale = false;
    const timer = setTimeout(() => {
      api.githubSearchRepos(words).then(
        (repos) => {
          if (stale) return;
          setFound({ of: words, repos });
          setProblem(null);
        },
        (e) => {
          if (!stale) setProblem(String(e));
        },
      );
    }, SEARCH_AFTER_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [words]);

  if (isSource(typed)) return null;
  const repos = offeredRepos(mine ?? [], found?.of === words ? found.repos : [], words).slice(0, LISTED);
  const asking = !mine || (words.length >= 2 && found?.of !== words && !problem);
  return (
    <div className="github-repos">
      {repos.map((r) => (
        <button key={r.fullName} type="button" className="github-repo" disabled={disabled} onClick={() => onPick(r.htmlUrl)} title={r.description ?? r.fullName}>
          {r.private ? <LockKey aria-label="Private" /> : <GithubLogo aria-label="Public" />}
          <span className="mono ellipsis">{r.fullName}</span>
          {r.description && <span className="dim small ellipsis grow">{r.description}</span>}
        </button>
      ))}
      {(problem || asking || !repos.length) && <span className="dim small github-repos-note">{problem ?? (asking ? "Looking on GitHub…" : "No repository is called that.")}</span>}
    </div>
  );
}
