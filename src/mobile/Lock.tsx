import { useEffect, useState } from "react";
import { Fingerprint, LockKey } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { useStore } from "../store";
import { resumeJobs, useLock } from "./lifecycle";

/** The vault, opened again after the app came back: everything is as it was left. */
export function MobileLock() {
  const root = useStore((s) => s.root);
  const vault = useStore((s) => s.vault);
  const toast = useStore((s) => s.toast);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const quick = !!vault?.quickRemembered;

  const opened = async () => {
    if (root) useStore.setState({ vault: await api.vaultStatus(root).catch(() => vault) });
    useLock.setState({ locked: false });
    resumeJobs();
  };
  const face = async () => {
    if (!root || busy) return;
    setBusy(true);
    try {
      await api.vaultUnlockQuick(root);
      await opened();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const passphrase = async () => {
    if (!root || busy || !secret.trim()) return;
    setBusy(true);
    try {
      await api.vaultUnlock(root, secret.trim());
      setSecret("");
      await opened();
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  // Face ID as soon as the app is back on the screen, once: it can't be answered any sooner.
  const cameBack = useLock((l) => l.cameBack);
  useEffect(() => {
    if (!cameBack) return;
    useLock.setState({ cameBack: false });
    if (quick) void face();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameBack]);

  return (
    <div className="m-lock" role="dialog" aria-label="Vault locked">
      <LockKey size={32} />
      <h1 className="m-title">Vault locked</h1>
      {quick && (
        <button className="btn primary" disabled={busy} onClick={() => void face()}>
          <Fingerprint /> Unlock with Face ID
        </button>
      )}
      <form
        className="m-lock-form"
        onSubmit={(e) => {
          e.preventDefault();
          void passphrase();
        }}
      >
        <input className="input mono" type="password" autoComplete="off" placeholder="Passphrase" value={secret} onChange={(e) => setSecret(e.target.value)} />
        <button className={`btn ${quick ? "" : "primary"}`} type="submit" disabled={busy || !secret.trim()}>
          Unlock
        </button>
      </form>
    </div>
  );
}
