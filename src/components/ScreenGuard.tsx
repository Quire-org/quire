import { Component, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "../store";

const ISSUES = "https://github.com/Quire-org/quire/issues/new";

/**
 * A text without the folders it names (where a library is, its pictures' names): "…" in their
 * place, to the end of the line or the quote around it (names have spaces).
 */
export const withoutPaths = (text: string) => text.replace(/(?:\/(?:Users|Volumes|home|mnt|media|private|var)\/|[A-Za-z]:\\)[^\n'"`]*/g, "…");

/**
 * A screen that fails while drawing says so, with the error and a way on (Home, reporting it, or
 * reloading the app), instead of taking the whole window with it: an empty window could only be
 * left by quitting. A new screen starts afresh (App gives each its own key).
 */
export class ScreenGuard extends Component<{ screen: string; children?: ReactNode }, { error: Error | null; stack: string }> {
  state = { error: null as Error | null, stack: "" };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("A screen failed:", error, info.componentStack);
    this.setState({ stack: info.componentStack ?? "" });
  }

  /** GitHub's form for a new issue, filled in with the error (the folders it names left out), to look over and send there. */
  report = async () => {
    const { error, stack } = this.state;
    const message = withoutPaths(String(error?.message || error));
    const version = await getVersion().catch(() => "");
    // Where in the screen it failed: the components' names, no more.
    const where = withoutPaths(stack).trim().split("\n").slice(0, 12).map((l) => l.trim()).join("\n");
    const body = [
      "**What happened**",
      "<!-- What were you doing when it failed? -->",
      "",
      "**The error**",
      "```",
      message,
      "```",
      where && ["**Where**", "```", where, "```"].join("\n"),
      `${this.props.screen} screen · Quire ${version || "?"} · ${navigator.platform}`,
    ]
      .filter(Boolean)
      .join("\n");
    const title = `${this.props.screen} screen: ${message.split("\n")[0].slice(0, 80)}`;
    await openUrl(`${ISSUES}?${new URLSearchParams({ title, body: body.slice(0, 6000) })}`);
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const home = () => {
      this.setState({ error: null, stack: "" });
      useStore.getState().openHome();
    };
    return (
      <div className="welcome">
        <div className="welcome-card panel">
          <h2>This screen ran into a problem</h2>
          <p className="dim">Go Home and carry on, or reload the app if Home fails too. Reporting it opens GitHub's form with the error filled in (without the folders it names), for you to look over and send.</p>
          <pre className="mono small dim screen-error">{String(error.message || error)}</pre>
          <div className="row">
            <button className="btn primary" onClick={home}>
              Home
            </button>
            <button className="btn" onClick={() => void this.report()}>
              Report issue
            </button>
            <button className="btn" onClick={() => location.reload()}>
              Reload the app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
