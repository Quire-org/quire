import { useEffect } from "react";
import { useStore } from "../store";
import { OptionRow } from "../components/OptionRow";
import { pluginUpdates, useUpdates } from "../lib/updates";
import { useJobs } from "../lib/jobs";
import { usePlugins } from "../plugins/store";
import { formatAgo } from "../lib/format";

/**
 * Settings › Updates: the app's version and a newer one when found (downloaded when asked, put in
 * place with a restart once nothing runs), plugins' updates beside it, and whether to check when
 * the app opens. Nothing goes online here until Check, or that setting, says so.
 */
export function Updates() {
  const u = useUpdates();
  const updates = usePlugins((p) => p.updates);
  const plugins = usePlugins((p) => p.list);
  const running = useJobs((j) => j.jobs.length);
  useEffect(() => void useUpdates.getState().loadBuild(), []);

  const found = pluginUpdates(updates);
  const quiet = found.filter((x) => !x.newPermissions.length);
  const fromGitHub = plugins.some((p) => p.state.github);
  const failed = Object.values(updates).filter((r) => r.error);
  const a = u.app;
  const status = [u.build ? `Quire ${u.build.version}.` : null, u.build?.cannot ?? null, u.checked ? `Checked ${formatAgo(u.checked)}.` : null].filter(Boolean).join(" ");

  return (
    <>
      <p className="dim">{status}</p>
      <section className="settings-options">
        <OptionRow
          title="Check for updates"
          info="Asks GitHub whether there is a newer Quire, and newer versions of the plugins added from GitHub. Nothing is downloaded until you say."
          action={{ label: u.checking ? "Checking…" : "Check now", onClick: () => void u.check(), disabled: u.checking }}
        />
        <OptionRow
          title="Check when a library opens"
          info="On, the app asks GitHub once each time it runs, a few seconds after a library opens, even while Going online asks first: turning this on is your yes for that. What it finds waits here, with a dot on Settings; nothing is downloaded by itself. Off, nothing goes online for updates until you press Check now. Kept with this library."
          toggle={{ on: u.auto, label: u.auto ? "On" : "Off", onChange: u.setAuto }}
        />
      </section>
      <hr className="rule" />
      <section className="settings-options">
        <h3>Quire</h3>
        {a ? (
          <OptionRow
            title={`Quire ${a.version}`}
            info={<div className="update-notes">{a.notes?.trim() || "No notes came with this version."}</div>}
            control={
              <span className="dim small">
                {a.date ? `out ${formatAgo(a.date)}` : null}
                {a.downloaded && running ? `${a.date ? " · " : ""}restarts once the ${running} job${running === 1 ? "" : "s"} in Activity finish` : null}
              </span>
            }
            action={
              a.downloaded
                ? { label: "Restart to update", onClick: () => void u.install(), disabled: running > 0 }
                : { label: u.downloading ? "Downloading…" : "Download", onClick: () => void u.download(), disabled: u.downloading }
            }
          />
        ) : (
          <p className="dim small">{u.appError ? `Couldn't check: ${u.appError}` : u.build?.cannot ? "This build doesn't update itself." : u.checked ? "This is the newest version." : "Not checked yet."}</p>
        )}
      </section>
      <hr className="rule" />
      <section className="settings-options">
        <h3>Plugins</h3>
        {found.map((x) => (
          <OptionRow
            key={x.id}
            title={`${x.manifest.name} ${x.latest}`}
            info={x.newPermissions.length ? `This version asks for more than you allowed: ${x.newPermissions.join(", ")}. Review it in Plugins, where you choose what it gets.` : x.manifest.description}
            control={<span className="dim small">now {x.current}{x.newPermissions.length ? " · asks for more" : ""}</span>}
            action={
              x.newPermissions.length
                ? { label: "Review…", onClick: () => useStore.getState().set({ settingsOpen: true, updatesOpen: false, pluginsOpen: true }) }
                : { label: "Update", onClick: () => void u.updatePlugins([x.id]) }
            }
          />
        ))}
        {quiet.length > 1 && <OptionRow title={`All ${quiet.length} that ask for nothing new`} action={{ label: "Update all", onClick: () => void u.updatePlugins(quiet.map((x) => x.id)) }} />}
        {!found.length && <p className="dim small">{!fromGitHub ? "No plugin here was added from GitHub: plugins used from a folder are whatever that folder holds." : u.checked ? "Every plugin added from GitHub is up to date." : "Not checked yet."}</p>}
        {failed.length > 0 && <p className="small warn-text">Couldn't check {failed.map((r) => usePlugins.getState().byId(r.id)?.manifest?.name ?? r.id).join(", ")}.</p>}
      </section>
    </>
  );
}
