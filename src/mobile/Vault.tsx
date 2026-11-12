import { useState } from "react";
import { Fingerprint, LockKey } from "@phosphor-icons/react";
import { api } from "../lib/api";
import { flushAll } from "../lib/pending";
import { useStore } from "../store";
import { useLock } from "./lifecycle";

/** Settings' Vault on a phone or tablet: locking it and Face ID. Making one and changing its passphrase are for the computer. */
export function MobileVault() {
  const root = useStore((s) => s.root);
  const vault = useStore((s) => s.vault);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  if (!vault?.exists) return <p className="dim">This library has no vault. A library is encrypted on your computer, in Settings there.</p>;

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      if (root) useStore.setState({ vault: await api.vaultStatus(root) });
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const lock = async () => {
    await flushAll().catch(() => {});
    await api.vaultLock();
    useStore.getState().set({ settingsOpen: false, vaultOpen: false });
    useLock.setState({ locked: true });
  };

  return (
    <div className="m-settings-body">
      <p className="dim">The vault locks by itself the moment Quire leaves the screen.</p>
      <button className="btn" disabled={busy} onClick={() => void run(lock)}>
        <LockKey /> Lock now
      </button>
      <hr className="rule" />
      <p className="dim">{vault.quickRemembered ? "Face ID opens this vault on this device. The key never leaves it." : "Open this vault with Face ID on this device instead of typing its passphrase."}</p>
      <button className="btn" disabled={busy} onClick={() => void run(() => (vault.quickRemembered ? api.vaultForget(root!) : api.vaultRemember()))}>
        <Fingerprint /> {vault.quickRemembered ? "Stop using Face ID" : "Use Face ID"}
      </button>
    </div>
  );
}
