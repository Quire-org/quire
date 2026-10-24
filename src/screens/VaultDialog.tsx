import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api, pickFolder } from "../lib/api";
import { Modal } from "../components/Modal";
import { formatBytes } from "../lib/format";
import { strength } from "../lib/strength";
import type { VaultProgress } from "../lib/types";
import { Copy, Fingerprint, Key, LockKey, LockKeyOpen, ShieldCheck, Warning } from "@phosphor-icons/react";

/**
 * Vault management: create (shows the recovery code once), encrypt plain
 * files, change passphrase, new recovery code, export decrypted copies,
 * remove the vault. Unlocking happens in VaultUnlock on the welcome screen.
 */
export function VaultDialog() {
  const s = useStore();
  const v = s.vault;
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [oldPass, setOldPass] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<VaultProgress | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    void s.refreshVault();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    if (code && !saved) return; // the code must be acknowledged first
    s.set({ vaultOpen: false, needsNewPassphrase: false });
  };

  const create = async () => {
    if (!s.root) return;
    if (pass !== pass2) return s.toast("Passphrases do not match", "warn");
    setBusy(true);
    try {
      const c = await api.vaultCreate(s.root, pass);
      setCode(c);
      setPass("");
      setPass2("");
      await s.refreshVault();
      await s.rescan(true);
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const encryptAll = async () => {
    if (!s.root) return;
    setBusy(true);
    setProgress(null);
    try {
      const n = await api.vaultEncryptAll(s.root, setProgress);
      s.toast(`Encrypted ${n} files`, "ok");
      await s.refreshVault();
      await s.rescan(true);
      await s.loadAll(true);
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const changePass = async () => {
    if (pass !== pass2) return s.toast("Passphrases do not match", "warn");
    setBusy(true);
    try {
      if (s.needsNewPassphrase) await api.vaultResetPassphrase(pass);
      else await api.vaultChangePassphrase(oldPass, pass);
      s.toast("Passphrase changed", "ok");
      s.set({ needsNewPassphrase: false });
      setPass("");
      setPass2("");
      setOldPass("");
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const newCode = async () => {
    setBusy(true);
    try {
      setCode(await api.vaultNewRecoveryCode(oldPass));
      setSaved(false);
      setOldPass("");
      await s.refreshVault();
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    if (!s.root) return;
    const dest = await pickFolder("Choose where to write decrypted copies");
    if (!dest) return;
    setBusy(true);
    try {
      const all = await s.loadAll(true);
      const paths = all.flatMap((i) => i.files);
      const n = await api.vaultExport(s.root, paths, dest);
      s.toast(`Exported ${n} files`, "ok");
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!s.root) return;
    setBusy(true);
    setProgress(null);
    try {
      const n = await api.vaultRemove(s.root, setProgress);
      s.toast(`Decrypted ${n} files, vault removed`, "ok");
      setConfirmRemove(false);
      await s.refreshVault();
      await s.rescan(true);
      await s.loadAll(true);
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const pct = progress && progress.totalBytes ? Math.round((progress.bytes / progress.totalBytes) * 100) : 0;
  const st = strength(pass);
  const okPass = pass.length >= 12 && st.label !== "weak" && pass === pass2;
  const meter = pass ? (
    <div className={`strength ${st.label}`}>
      <div className="strength-bar">
        <div className="strength-fill" style={{ width: `${Math.min(100, (st.bits / 90) * 100)}%` }} />
      </div>
      <span className="mono small">
        {st.label} · ~{st.bits} bits · {st.hint}
        {pass.length < 12 ? " · at least 12 characters" : ""}
      </span>
    </div>
  ) : null;
  const quickName = v?.quickMethod === "touchid" ? "Touch ID" : v?.quickMethod === "hello" ? "Windows Hello" : "the system keyring";
  const toggleQuick = async () => {
    if (!s.root || !v) return;
    setBusy(true);
    try {
      if (v.quickRemembered) {
        await api.vaultForget(s.root);
        s.toast("This computer no longer remembers the vault", "ok");
      } else {
        await api.vaultRemember();
        s.toast(`Remembered. Next time: ${quickName}`, "ok");
      }
      await s.refreshVault();
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Vault" onClose={close} wide>
      {code ? (
        <section className="vault-code">
          <h3>
            <Key /> Recovery code
          </h3>
          <p className="dim small">
            This is the only way back in if you forget the passphrase. It is shown once and stored nowhere. Write it down or put it in
            your password manager now.
          </p>
          <div className="code-box mono">{code}</div>
          <div className="row">
            <button className="btn sm" onClick={() => navigator.clipboard?.writeText(code).then(() => s.toast("Copied", "ok"))}>
              <Copy /> Copy
            </button>
            <label className="check side-row">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved this code somewhere safe
            </label>
            <span className="grow" />
            <button className="btn primary" disabled={!saved} onClick={() => setCode(null)}>
              Done
            </button>
          </div>
        </section>
      ) : !v?.exists ? (
        <section>
          <h3>
            <LockKey /> Encrypt this folder
          </h3>
          <p className="dim small">
            Every file becomes an opaque blob with a random name; names, folders and ratings live only in an encrypted index. The
            camera and other apps will no longer be able to read the files, and the app needs the passphrase to open the folder.
          </p>
          <div className="verdict unknown">
            <p className="small">
              <Warning /> Without the passphrase or the recovery code the files are gone for good. There is no other way in, by design.
            </p>
          </div>
          <div className="row">
            <input className="input grow" type="password" placeholder="Passphrase (12+ characters, or four random words)" value={pass} onChange={(e) => setPass(e.target.value)} />
            <input className="input grow" type="password" placeholder="Repeat" value={pass2} onChange={(e) => setPass2(e.target.value)} />
            <button className="btn primary" disabled={busy || !okPass} onClick={() => void create()}>
              Create vault
            </button>
          </div>
          {meter}
        </section>
      ) : (
        <>
          <section>
            <div className="sec-head">
              <h3>
                <ShieldCheck /> Vault is {v.unlocked ? "unlocked" : "locked"}
              </h3>
              <button className="btn sm" onClick={() => void s.lockVault()}>
                <LockKey /> Lock and close
              </button>
            </div>
            <div className="drive-grid mono small">
              <span className="label">Encrypted</span>
              <span>{v.encryptedFiles} files</span>
              <span className="label">Still plain</span>
              <span className={v.plaintextFiles ? "accent-text" : "dim"}>
                {v.plaintextFiles} files · {formatBytes(v.plaintextBytes)}
              </span>
              <span className="label">Recovery code</span>
              <span>{v.hasRecovery ? "set" : "none"}</span>
            </div>
            {v.plaintextFiles > 0 && (
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" disabled={busy} onClick={() => void encryptAll()}>
                  <LockKey /> Encrypt {v.plaintextFiles} new files
                </button>
                <span className="dim small">Files the camera or another app wrote since the last time. Plaintext is deleted once encrypted.</span>
              </div>
            )}
            {progress && (
              <div className="progress" style={{ marginTop: 8 }}>
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="mono faint small ellipsis">
                  {progress.done}/{progress.total} · {formatBytes(progress.bytes)} of {formatBytes(progress.totalBytes)} · {progress.current}
                </div>
              </div>
            )}
          </section>

          <hr className="rule" />
          <section>
            <div className="sec-head">
              <h3>
                <Fingerprint /> Quick unlock on this computer
              </h3>
              <button className={`btn sm ${v.quickRemembered ? "active" : "primary"}`} disabled={busy} onClick={() => void toggleQuick()}>
                {v.quickRemembered ? "Forget this computer" : `Remember with ${quickName}`}
              </button>
            </div>
            <p className="dim small">
              Stores the vault key in the {v.quickMethod === "keyring" ? "Secret Service keyring" : v.quickMethod === "hello" ? "Windows Credential Manager" : "macOS Keychain"}, released only after {quickName}
              {v.quickMethod === "keyring" ? " is unlocked by your login session" : ""}. Only on this machine; the passphrase and recovery code keep working everywhere.
            </p>
          </section>

          <hr className="rule" />
          <section>
            <h3>{s.needsNewPassphrase ? "Choose a new passphrase" : "Change passphrase"}</h3>
            {s.needsNewPassphrase && <p className="dim small">You unlocked with the recovery code. Set a passphrase you will remember.</p>}
            <div className="row">
              {!s.needsNewPassphrase && <input className="input grow" type="password" placeholder="Current" value={oldPass} onChange={(e) => setOldPass(e.target.value)} />}
              <input className="input grow" type="password" placeholder="New (12+ characters)" value={pass} onChange={(e) => setPass(e.target.value)} />
              <input className="input grow" type="password" placeholder="Repeat" value={pass2} onChange={(e) => setPass2(e.target.value)} />
              <button className="btn" disabled={busy || !okPass || (!s.needsNewPassphrase && !oldPass)} onClick={() => void changePass()}>
                Change
              </button>
            </div>
            {meter}
          </section>

          <hr className="rule" />
          <section>
            <h3>
              <Key /> Recovery code
            </h3>
            <p className="dim small">Issue a new code if you lost the old one. The old code stops working. Needs the passphrase.</p>
            <div className="row">
              <input className="input grow" type="password" placeholder="Passphrase" value={oldPass} onChange={(e) => setOldPass(e.target.value)} />
              <button className="btn" disabled={busy || !oldPass} onClick={() => void newCode()}>
                New recovery code
              </button>
            </div>
          </section>

          <hr className="rule" />
          <section>
            <h3>
              <LockKeyOpen /> Decrypt
            </h3>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void exportAll()}>
                Export decrypted copies…
              </button>
              {confirmRemove ? (
                <>
                  <span className="mono small" style={{ color: "var(--danger)" }}>
                    Everything is decrypted back in place and the vault is deleted.
                  </span>
                  <button className="btn sm danger" disabled={busy} onClick={() => void remove()}>
                    Yes, remove the vault
                  </button>
                  <button className="btn sm ghost" onClick={() => setConfirmRemove(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn danger" disabled={busy} onClick={() => setConfirmRemove(true)}>
                  Remove vault…
                </button>
              )}
            </div>
            <p className="dim small">Export keeps the vault and writes readable copies elsewhere, e.g. to share a selection.</p>
          </section>
        </>
      )}
    </Modal>
  );
}
