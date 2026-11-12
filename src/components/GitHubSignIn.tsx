import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowSquareOut, GithubLogo } from "@phosphor-icons/react";
import { api, type GitHubCode, type GitHubStatus } from "../lib/api";
import { useStore } from "../store";

/** Signing in to GitHub, for plugins in private repositories: a code to approve there. */
export function GitHubSignIn({ onSignedIn }: { onSignedIn: (yes: boolean) => void }) {
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [code, setCode] = useState<GitHubCode | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.githubStatus().then(setStatus, () => {}), []);
  useEffect(() => onSignedIn(!!status?.login), [status, onSignedIn]);

  // GitHub asked until it says the code was approved. The app may be away in the browser meanwhile:
  // on a phone this goes on when it is back.
  useEffect(() => {
    if (!code) return;
    let stopped = false;
    let wait = code.interval * 1000;
    let timer: ReturnType<typeof setTimeout>;
    const ask = async () => {
      try {
        const answer = await api.githubSignInCheck(code.deviceCode);
        if (stopped) return;
        if (answer === "done") {
          setCode(null);
          setStatus(await api.githubStatus());
          return toast("Signed in to GitHub", "ok");
        }
        if (answer === "slower") wait += 5000;
        timer = setTimeout(() => void ask(), wait);
      } catch (e) {
        if (stopped) return;
        setCode(null);
        toast(String(e), "error");
      }
    };
    timer = setTimeout(() => void ask(), wait);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [code, toast]);

  if (!status) return null;

  const start = async () => {
    setBusy(true);
    try {
      setCode(await api.githubSignIn());
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  // The code goes with you: on a phone GitHub opens over the app, and the code would be out of sight.
  const toGitHub = async (c: GitHubCode) => {
    await navigator.clipboard?.writeText(c.userCode).catch(() => {});
    await openUrl(c.verificationUri).catch((e) => toast(String(e), "error"));
  };
  const signOut = async () => {
    await api.githubSignOut().catch((e) => toast(String(e), "error"));
    setStatus(await api.githubStatus());
  };

  if (code)
    return (
      <div className="github-sign-in">
        <span className="dim small">Enter this code on GitHub and approve it. This updates by itself.</span>
        <b className="mono github-code">{code.userCode}</b>
        <button className="btn sm primary" onClick={() => void toGitHub(code)}>
          <ArrowSquareOut /> Copy it and open GitHub
        </button>
        <button className="btn sm ghost" onClick={() => setCode(null)}>
          Cancel
        </button>
      </div>
    );
  if (status.login)
    return (
      <div className="github-sign-in">
        <GithubLogo /> <span className="small">Signed in as {status.login}: private repositories you allowed can be added.</span>
        <button className="btn sm ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    );
  return (
    <div className="github-sign-in">
      <span className="dim small">For a plugin in a private repository, sign in first. It can only read the repositories you choose.</span>
      <button className="btn sm" disabled={busy} onClick={() => void start()}>
        <GithubLogo /> Sign in to GitHub
      </button>
    </div>
  );
}
