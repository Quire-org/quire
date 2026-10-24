import { useState } from "react";
import { useStore } from "../store";
import { Modal } from "../components/Modal";
import { Fingerprint, Key, LockKey } from "@phosphor-icons/react";

/** Passphrase (or recovery code) prompt for a folder with a locked vault. */
export function VaultUnlock() {
  const s = useStore();
  const [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = s.pendingRoot ?? "";
  const quick = s.vault?.quickRemembered ? s.vault.quickMethod : null;
  const quickLabel = quick === "touchid" ? "Unlock with Touch ID" : quick === "hello" ? "Unlock with Windows Hello" : "Unlock (remembered on this computer)";

  const go = async () => {
    setBusy(true);
    const ok = await s.unlockVault(secret.trim(), recovery);
    setBusy(false);
    if (ok) setSecret("");
  };

  return (
    <Modal title="Locked folder" onClose={() => s.set({ pendingRoot: null, vault: null })}>
      <p className="dim small">
        <LockKey /> <span className="mono">{root.split("/").filter(Boolean).slice(-2).join("/")}</span> is encrypted.
      </p>
      {quick && (
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await s.unlockVaultQuick();
            setBusy(false);
          }}
        >
          <Fingerprint /> {quickLabel}
        </button>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input
          className="input grow mono"
          type={recovery ? "text" : "password"}
          placeholder={recovery ? "Recovery code (XXXX-XXXX-…)" : "Passphrase"}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          autoFocus
        />
        <button className="btn primary" type="submit" disabled={busy || !secret.trim()}>
          Unlock
        </button>
      </form>
      <button className="btn sm ghost" onClick={() => setRecovery((r) => !r)}>
        <Key /> {recovery ? "Use the passphrase instead" : "Forgot it? Use the recovery code"}
      </button>
      {recovery && <p className="dim small">After a recovery unlock you will be asked to set a new passphrase.</p>}
    </Modal>
  );
}
