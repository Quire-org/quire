import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { useStore } from "../store";
import { useFinders } from "../plugins/find";
import { whereKept } from "../screens/Find";

/**
 * While a platform's sign-in page is open in its own window: what happens, where the sign-in is
 * kept, and the way round for accounts (Google, Apple) that won't sign in inside an app's window:
 * sign in with the browser, then paste what it ends on.
 */
export function FindLogin() {
  const login = useFinders((s) => s.login);
  const vault = useStore((s) => s.vault);
  const [browser, setBrowser] = useState(false);
  const [pasted, setPasted] = useState("");
  if (!login) return null;
  const close = () => {
    setBrowser(false);
    setPasted("");
    login.done(null);
  };
  const send = () => {
    const back = pasted.trim();
    if (!back) return;
    setBrowser(false);
    setPasted("");
    login.done(back);
  };
  return (
    <Modal title={`Signing in to ${login.name}`} onClose={close}>
      <div className="find-login">
        <p>{login.name}'s sign-in page is open in its own window. Sign in there; it closes by itself when you're in.</p>
        <p className="dim small">{whereKept(vault).text}</p>
        {!browser ? (
          <p className="small">
            Signing in with Google or Apple? They refuse an app's own window.{" "}
            <button
              className="btn sm ghost"
              onClick={() => {
                setBrowser(true);
                void openUrl(login.url);
              }}
            >
              <ArrowSquareOut /> Sign in with your browser instead
            </button>
          </p>
        ) : (
          <div className="find-login-browser">
            <p className="small">
              Sign in in the browser that opened. When the page goes blank at the end, open the browser's developer tools (<kbd className="kbd">⌥⌘I</kbd>), Network, and copy the address of the last <span className="mono">callback?…</span> entry (or just its <span className="mono">code</span>). Paste it here
              within 30 seconds: that's how long it lasts.
            </p>
            <div className="row">
              <input className="input grow" autoFocus placeholder="https://…/callback?…&code=…" value={pasted} onChange={(e) => setPasted(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && send())} />
              <button className="btn primary" disabled={!pasted.trim()} onClick={send}>
                Sign in
              </button>
            </div>
            <button className="btn sm ghost" onClick={() => void openUrl(login.url)}>
              Open the sign-in page again
            </button>
          </div>
        )}
        <div className="row">
          <span className="grow" />
          <button className="btn ghost" onClick={close}>
            Not now
          </button>
        </div>
      </div>
    </Modal>
  );
}
