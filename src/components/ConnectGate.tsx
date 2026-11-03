import type { ReactNode } from "react";
import { Plugs } from "@phosphor-icons/react";
import { useStore } from "../store";
import { useOnline, useMayGoOnline } from "../lib/online";

/**
 * What would go online by itself (a platform's page, its pictures) waits behind a Connect button
 * while Quire asks before going online (Settings → Going online). `name`: the platform's, when
 * it is connected on its own; `small` for a row inside a block.
 */
export function ConnectGate({ pluginId, name, small, children }: { pluginId: string | null; name?: string; small?: boolean; children: ReactNode }) {
  const allowed = useMayGoOnline(pluginId);
  const each = useOnline((s) => s.settings.each);
  if (allowed) return <>{children}</>;
  return (
    <div className={`connect-gate ${small ? "small" : ""}`}>
      <Plugs />
      {!small && <span className="dim small">Not connected: Quire asks before going online.</span>}
      <button className="btn sm" onClick={() => useOnline.getState().connect(pluginId ?? undefined)} title={`Go online${each && name ? ` for ${name}` : ""} until ${useOnline.getState().settings.keep ? "you disconnect" : "the app closes"}`}>
        Connect{each && name ? ` to ${name}` : ""}
      </button>
      {!small && (
        <button className="btn sm ghost" onClick={() => useStore.getState().set({ settingsOpen: true })} title="Settings → Going online">
          Settings
        </button>
      )}
    </div>
  );
}
