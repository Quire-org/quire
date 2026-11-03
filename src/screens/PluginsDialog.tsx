import { useEffect, useState } from "react";
import { useStore } from "../store";
import { api, pickFolder } from "../lib/api";
import { Modal } from "../components/Modal";
import { PluginLogo } from "../components/PluginLogo";
import { Select } from "../components/Select";
import { usePlugins } from "../plugins/store";
import { describePermission } from "../plugins/permissions";
import { nextLoad, notifySettings } from "../plugins/host";
import { useEngine } from "../plugins/engine";
import type {
  Inspected,
  PluginInfo,
  SettingSpec,
  UpdateInfo,
} from "../plugins/types";
import {
  ArrowsClockwise,
  Check,
  Cpu,
  DownloadSimple,
  FolderOpen,
  GithubLogo,
  LockKey,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";

type Pending =
  | { kind: "install"; source: string; found: Inspected }
  | { kind: "update"; info: UpdateInfo }
  /** An installed plugin now asks for more than it was granted (a reload after an edit, or an update that was accepted before the change). */
  | { kind: "grant"; p: PluginInfo; perms: string[] };

/** Permissions a plugin's manifest asks for that the user hasn't granted. */
export function ungranted(p: PluginInfo): string[] {
  return (p.manifest?.permissions ?? []).filter((x) => !p.state.granted.includes(x));
}

/** Settings → Plugins: install, enable, permissions, settings, updates. */
export function PluginsDialog() {
  const s = useStore();
  const plugins = usePlugins();
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [checking, setChecking] = useState(false);
  const fromGitHub = plugins.list.some((p) => p.state.github);

  // A plugin edited in place may ask for more than it was granted: ask as soon as the dialog opens.
  useEffect(() => {
    if (pending) return;
    const p = plugins.list.find((x) => x.state.enabled && ungranted(x).length);
    if (p) setPending({ kind: "grant", p, perms: ungranted(p) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugins.list]);

  const inspect = async (value: string) => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      const found = await api.pluginInspect(value.trim());
      setPending({ kind: "install", source: value.trim(), found });
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const dir = await pickFolder(
      "Choose a plugin folder (the one with plugin.json)",
    );
    if (dir) {
      setSource(dir);
      await inspect(dir);
    }
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "update") {
        await api.pluginUpdate(pending.info.id, true);
        s.toast(
          `${pending.info.manifest.name} updated to ${pending.info.latest}`,
          "ok",
        );
      } else if (pending.kind === "grant") {
        await api.pluginSetState(pending.p.id, {
          granted: [...new Set([...pending.p.state.granted, ...pending.perms])],
        });
        setPending(null);
        await plugins.refresh();
        plugins.reload(pending.p.id);
        return;
      } else {
        const m = await api.pluginInstall(
          pending.source,
          pending.found.manifest.permissions,
        );
        s.toast(`${m.name} ${m.version} installed`, "ok");
        setSource("");
      }
      setPending(null);
      await plugins.refresh();
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const checkUpdates = async () => {
    setChecking(true);
    try {
      const res = await api.pluginCheckUpdates();
      usePlugins.setState({
        updates: Object.fromEntries(res.map((r) => [r.id, r])),
      });
      const n = res.filter((r) => r.update).length;
      const failed = res.filter((r) => r.error).length;
      s.toast(
        n
          ? `${n} update${n === 1 ? "" : "s"} available`
          : failed
            ? "Some plugins could not be checked"
            : "All plugins are up to date",
        failed && !n ? "warn" : "ok",
      );
    } catch (e) {
      s.toast(String(e), "error");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <Modal
        title="Plugins"
        onClose={() => !busy && !pending && s.set({ pluginsOpen: false })}
        wide
      >
        <form
          className="row plugin-add"
          onSubmit={(e) => {
            e.preventDefault();
            void inspect(source);
          }}
        >
          <input
            className="input grow mono"
            placeholder="GitHub link or folder path"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={busy}
            spellCheck={false}
            title="For example https://github.com/owner/repo, a folder inside a repository (…/tree/main/folder), or /path/to/plugin"
          />
          <button
            className="btn"
            type="button"
            onClick={() => void browse()}
            disabled={busy}
            title="Choose a folder on this computer"
          >
            <FolderOpen /> Browse…
          </button>
          <button
            className="btn primary"
            type="submit"
            disabled={busy || !source.trim()}
          >
            <DownloadSimple /> {busy && !pending ? "Looking…" : "Add"}
          </button>
        </form>
        <div className="row plugin-sub">
          <span className="dim small">
            GitHub plugins update from their repository. Folders are used in
            place. Plugins run sandboxed, only get what you allow, and live on
            this computer.
          </span>
          <span className="grow" />
          <button
            className="btn sm"
            disabled={checking || !fromGitHub}
            onClick={() => void checkUpdates()}
            title={
              fromGitHub
                ? "Check GitHub for newer versions"
                : "Only plugins added from GitHub can update"
            }
          >
            <ArrowsClockwise /> {checking ? "Checking…" : "Check for updates"}
          </button>
        </div>

        <div className="plugin-list">
          {plugins.list.length === 0 && (
            <div className="dim plugin-empty">
              No plugins yet. Paste a GitHub link or choose a folder above. A
              plugin is a folder with a{" "}
              <span className="mono">plugin.json</span> and a script; see{" "}
              <span className="mono">docs/plugins.md</span>.
            </div>
          )}
          {plugins.list.map((p) => (
            <PluginCard
              key={p.id}
              p={p}
              onUpdate={(info) => setPending({ kind: "update", info })}
              onGrant={(perms) => setPending({ kind: "grant", p, perms })}
            />
          ))}
        </div>
      </Modal>
      {pending && (
        <Consent
          pending={pending}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </>
  );
}

function Consent({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: Pending;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const m =
    pending.kind === "update" ? pending.info.manifest : pending.kind === "grant" ? pending.p.manifest! : pending.found.manifest;
  const perms =
    pending.kind === "update" ? pending.info.newPermissions : pending.kind === "grant" ? pending.perms : m.permissions;
  const isUpdate = pending.kind === "update";
  const isGrant = pending.kind === "grant";
  return (
    <Modal
      title={isUpdate ? `Update ${m.name}` : isGrant ? `${m.name} asks for more` : `Install ${m.name}?`}
      onClose={onCancel}
    >
      <p className="small">
        <span className="mono">
          {m.name}{" "}
          {isUpdate
            ? `${pending.info.current} → ${pending.info.latest}`
            : m.version}
        </span>
        {m.author && <span className="dim"> by {m.author}</span>}
      </p>
      {m.description && <p className="dim small">{m.description}</p>}
      {perms.length ? (
        <>
          <div className="label">
            {isUpdate || isGrant ? "This version asks for new permissions" : "It asks to"}
          </div>
          <div className="perm-list">
            {perms.map((p) => {
              const d = describePermission(p);
              return (
                <div
                  key={p}
                  className={`perm ${d.sensitive ? "sensitive" : ""}`}
                >
                  <div className="perm-title">
                    {d.sensitive && <Warning />} {d.title}
                  </div>
                  <div className="dim small">{d.detail}</div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="dim small">
          {isUpdate ? "No new permissions." : "It asks for no permissions."}
        </p>
      )}
      {pending.kind === "install" && (
        <p className="dim small">
          {pending.found.kind === "github" ? <GithubLogo /> : <FolderOpen />}{" "}
          <span className="mono">{pending.found.location}</span>
          <br />
          {pending.found.kind === "github"
            ? "Downloaded from GitHub at its current commit. Updates come from the same repository."
            : "Used in place from this folder. Edits show up after Reload."}
        </p>
      )}
      <p className="dim small">
        <LockKey /> Encrypted folders stay off-limits until you allow it for
        this plugin.
      </p>
      <div className="row pop-actions">
        <button className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="grow" />
        <button className="btn primary" onClick={onConfirm} disabled={busy}>
          {isUpdate
            ? perms.length
              ? "Update and allow"
              : "Update"
            : isGrant
              ? "Allow and reload"
              : "Install"}
        </button>
      </div>
    </Modal>
  );
}

function PluginCard({
  p,
  onUpdate,
  onGrant,
}: {
  p: PluginInfo;
  onUpdate: (u: UpdateInfo) => void;
  onGrant: (perms: string[]) => void;
}) {
  const s = useStore();
  const plugins = usePlugins();
  const [open, setOpen] = useState<"settings" | "log" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const m = p.manifest;
  const upd = plugins.updates[p.id];
  const logs = plugins.logs[p.id] ?? [];
  const errors = logs.filter((l) => l.level === "error").length;
  const missing = ungranted(p);
  // A reload says how it went: reloading, then reloaded, or what went wrong (which opens the log).
  const [reloading, setReloading] = useState<"busy" | { problem: string | null } | null>(null);
  useEffect(() => {
    if (!reloading || reloading === "busy") return;
    const t = setTimeout(() => setReloading(null), reloading.problem ? 8000 : 2500);
    return () => clearTimeout(t);
  }, [reloading]);

  const removeSite = async (domain: string) => {
    try {
      await plugins.setSites(p.id, (p.sites ?? []).filter((d) => d !== domain));
      // Started again, it says what it has now.
      plugins.reload(p.id);
    } catch (e) {
      s.toast(String(e), "error");
    }
  };

  const reload = async () => {
    setReloading("busy");
    const since = Date.now();
    // plugin.json read again: an edit in place may ask for more, or not load at all.
    await plugins.refresh();
    const now = usePlugins.getState().byId(p.id);
    const asks = now ? ungranted(now) : [];
    if (asks.length) {
      setReloading(null);
      return onGrant(asks);
    }
    if (!now?.manifest) return setReloading({ problem: "Couldn't load it" });
    if (!now.state.enabled) return setReloading({ problem: null });
    const loaded = nextLoad(p.id);
    plugins.reload(p.id);
    const started = await loaded;
    // What it reports as it starts up counts too.
    await new Promise((r) => setTimeout(r, 600));
    const failed = (usePlugins.getState().logs[p.id] ?? []).filter((l) => l.level === "error" && l.t >= since).length;
    setReloading({ problem: !started ? "Didn't start" : failed ? `${failed} error${failed === 1 ? "" : "s"}` : null });
  };

  const setState = async (patch: {
    enabled?: boolean;
    allowVault?: boolean;
  }) => {
    try {
      await api.pluginSetState(p.id, patch);
      await plugins.refresh();
      if (patch.allowVault !== undefined) plugins.reload(p.id);
    } catch (e) {
      s.toast(String(e), "error");
    }
  };

  return (
    <div className={`plugin-card panel ${p.state.enabled ? "" : "off"}`}>
      <div className="plugin-head">
        <PluginLogo plugin={p} />
        <div className="plugin-title">
          <div className="plugin-title-line">
            <strong>{m?.name ?? p.id}</strong>
            <span className="mono dim small">{m?.version}</span>
            {p.state.linked && <span className="badge">local folder</span>}
          </div>
          <div className="dim small ellipsis">{m?.description ?? p.error}</div>
        </div>
        <span className="grow" />
        {upd?.update && (
          <button
            className="btn sm primary"
            onClick={() => onUpdate(upd.update!)}
          >
            Update to {upd.update.latest}
          </button>
        )}
        {upd?.error && (
          <span
            className="small"
            style={{ color: "var(--warn)" }}
            title={upd.error}
          >
            <Warning /> update check failed
          </span>
        )}
        <label className="check side-row" title="Run this plugin">
          <input
            type="checkbox"
            checked={p.state.enabled}
            onChange={(e) => void setState({ enabled: e.target.checked })}
          />{" "}
          Enabled
        </label>
      </div>
      {p.error && (
        <div className="small" style={{ color: "var(--danger)" }}>
          <Warning /> {p.error}
        </div>
      )}
      {missing.length > 0 && p.state.enabled && (
        <div className="row small" style={{ color: "var(--warn)" }}>
          <Warning /> Asks for {missing.length === 1 ? "a permission" : `${missing.length} permissions`} you haven't allowed yet.
          <button className="btn sm" onClick={() => onGrant(missing)}>
            Review
          </button>
        </div>
      )}
      {m?.permissions.includes("sites") && p.state.granted.includes("sites") && (
        <div className="row small plugin-sites">
          <span className="dim">Sites you allowed, for this library:</span>
          {(p.sites ?? []).length ? (
            <span className="chips">
              {(p.sites ?? []).map((d) => (
                <span key={d} className="chip">
                  <span className="mono">{d}</span>
                  <button className="chip-x" onClick={() => void removeSite(d)} title={`${m.name} stops using ${d}`}>
                    <X />
                  </button>
                </span>
              ))}
            </span>
          ) : (
            <span className="dim">none yet: you add them where the plugin shows itself, such as Find.</span>
          )}
        </div>
      )}
      {m && (
        <div className="chips perm-chips">
          {m.permissions.map((perm) => (
            <span
              key={perm}
              className={`badge ${p.state.granted.includes(perm) ? "accent2" : ""}`}
              title={
                describePermission(perm).detail +
                (p.state.granted.includes(perm) ? "" : " (not granted)")
              }
            >
              {describePermission(perm).title}
            </span>
          ))}
          {!m.permissions.length && (
            <span className="dim small">No permissions</span>
          )}
        </div>
      )}
      <div className="row plugin-actions">
        <label
          className="check side-row"
          title="Plugin data is stored unencrypted on this computer, so anything it keeps from an encrypted folder leaves the vault"
        >
          <input
            type="checkbox"
            checked={p.state.allowVault}
            onChange={(e) => void setState({ allowVault: e.target.checked })}
          />{" "}
          Allow on encrypted folders
        </label>
        <span className="grow" />
        {m && m.settings.length > 0 && (
          <button
            className={`btn sm ${open === "settings" ? "active" : "ghost"}`}
            onClick={() => setOpen(open === "settings" ? null : "settings")}
          >
            Settings
          </button>
        )}
        {(m?.models?.length || m?.permissions.includes("engine")) && (
          <button
            className="btn sm ghost"
            onClick={() => useEngine.getState().open()}
            title="Download the models it uses"
          >
            <Cpu /> Models
          </button>
        )}
        <button
          className={`btn sm ${open === "log" ? "active" : "ghost"}`}
          onClick={() => setOpen(open === "log" ? null : "log")}
        >
          Log{errors ? ` (${errors})` : ""}
        </button>
        <button
          className={`btn sm ghost reload-btn ${reloading && reloading !== "busy" ? (reloading.problem ? "bad" : "good") : ""}`}
          disabled={reloading === "busy"}
          onClick={() => (reloading && reloading !== "busy" && reloading.problem ? (setReloading(null), setOpen("log")) : void reload())}
          title={reloading && reloading !== "busy" && reloading.problem ? "Show its log" : "Read plugin.json again and restart the plugin"}
          aria-live="polite"
        >
          {reloading === "busy" ? (
            <>
              <ArrowsClockwise className="spin" /> Reloading…
            </>
          ) : reloading?.problem ? (
            <>
              <Warning /> {reloading.problem}
            </>
          ) : reloading ? (
            <>
              <Check /> Reloaded
            </>
          ) : (
            <>
              <ArrowsClockwise /> Reload
            </>
          )}
        </button>
        {confirmRemove ? (
          <>
            <button
              className="btn sm danger"
              onClick={async () => {
                await forgetPluginData(p);
                await api
                  .pluginUninstall(p.id, false)
                  .catch((e) => s.toast(String(e), "error"));
                await plugins.refresh();
              }}
            >
              Remove with its data
            </button>
            <button
              className="btn sm ghost"
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="btn sm ghost"
            onClick={() => setConfirmRemove(true)}
            title="Uninstall"
          >
            <Trash />
          </button>
        )}
      </div>
      {open === "settings" && m && <SettingsForm p={p} specs={m.settings} />}
      {open === "log" && (
        <div className="plugin-log mono small">
          {logs.length === 0 && <div className="dim">Nothing logged.</div>}
          {logs.map((l, i) => (
            <div key={i} className={l.level === "error" ? "err" : ""}>
              <span className="faint">
                {new Date(l.t).toLocaleTimeString()}
              </span>{" "}
              {l.message}
            </div>
          ))}
        </div>
      )}
      <div
        className="faint small mono ellipsis"
        title={p.state.source || p.dir}
      >
        {p.state.github ? <GithubLogo /> : <FolderOpen />}{" "}
        {p.state.source || p.dir}
        {p.state.commit && <span> @ {p.state.commit.slice(0, 7)}</span>}
      </div>
    </div>
  );
}

function SettingsForm({ p, specs }: { p: PluginInfo; specs: SettingSpec[] }) {
  const s = useStore();
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [dirty, setDirty] = useState(false);
  if (values === null) {
    void api.pluginSettingsGet(p.id).then((saved) => {
      const v: Record<string, unknown> = {};
      for (const sp of specs)
        v[sp.key] =
          sp.key in saved
            ? saved[sp.key]
            : (sp.default ?? (sp.type === "boolean" ? false : ""));
      setValues(v);
    });
    return <div className="dim small">Loading…</div>;
  }
  const set = (k: string, v: unknown) => {
    setValues({ ...values, [k]: v });
    setDirty(true);
  };
  return (
    <form
      className="plugin-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.pluginSettingsSet(p.id, values);
          notifySettings(p.id, values);
          setDirty(false);
          s.toast("Plugin settings saved", "ok");
        } catch (err) {
          s.toast(String(err), "error");
        }
      }}
    >
      {specs.map((sp) => (
        <label key={sp.key} className="plugin-setting">
          <span className="small">{sp.label}</span>
          {sp.type === "boolean" ? (
            <input
              type="checkbox"
              checked={!!values[sp.key]}
              onChange={(e) => set(sp.key, e.target.checked)}
            />
          ) : sp.type === "select" ? (
            <Select
              value={String(values[sp.key] ?? "")}
              onChange={(v) => set(sp.key, v)}
              options={(sp.options ?? []).map((o) => ({ value: o, label: o }))}
            />
          ) : (
            <input
              className="input mono"
              type={
                sp.type === "secret"
                  ? "password"
                  : sp.type === "number"
                    ? "number"
                    : "text"
              }
              value={String(values[sp.key] ?? "")}
              onChange={(e) =>
                set(
                  sp.key,
                  sp.type === "number"
                    ? Number(e.target.value)
                    : e.target.value,
                )
              }
              autoComplete="off"
            />
          )}
          {sp.help && <span className="dim small">{sp.help}</span>}
        </label>
      ))}
      <div className="row">
        <span className="dim small">
          Secrets are stored in a file only your account can read, on this
          computer.
        </span>
        <span className="grow" />
        <button className="btn sm primary" type="submit" disabled={!dirty}>
          Save
        </button>
      </div>
    </form>
  );
}

/**
 * A plugin removed with its data: what it left beyond its own folder goes too, before it is gone.
 * What it kept with the library open (its sign-ins, the sites allowed it), its part of Find there
 * (basket, saved searches), the models it brought (while the engine still knows them; one another
 * plugin uses stays), and what this computer remembers of it. Other libraries keep what it kept with
 * them until it is removed while they are open.
 */
async function forgetPluginData(p: PluginInfo) {
  const root = useStore.getState().root;
  const { useFinders } = await import("../plugins/find");
  const platform = useFinders.getState().finders[p.id]?.platform ?? null;
  if (root) {
    await api.pluginLibraryForget(p.id, root).catch(() => {});
    const { useFind } = await import("../findStore");
    useFind.getState().forgetPlugin(p.id, platform);
  }
  const own = ((p.manifest as { ownModels?: { id?: unknown }[] } | null)?.ownModels ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  const others = usePlugins.getState().list.filter((x) => x.id !== p.id).flatMap((x) => x.manifest?.models ?? []);
  for (const id of own) if (!others.includes(id)) await api.engineRemove(id).catch(() => {});
  const { useOnline } = await import("../lib/online");
  useOnline.getState().forget(p.id);
  const { useDupes } = await import("../dupesStore");
  if (useDupes.getState().versionsOn.includes(p.id)) useDupes.getState().setVersionCheck(p.id, false);
  try {
    localStorage.removeItem(`quire.find.ltr.${p.id}`);
  } catch {
    /* nothing kept */
  }
}
