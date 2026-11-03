import { useEffect } from "react";
import { usePlugins } from "../plugins/store";
import { useStore } from "../store";
import { frameLoaded, frameUrl, installHost, registerFrame } from "../plugins/host";

/**
 * Hidden sandboxed frames, one per enabled plugin. `allow-scripts` without
 * `allow-same-origin` gives each plugin an opaque origin: it cannot reach the
 * app, its storage or Tauri, only post messages to the host.
 */
export function PluginHost() {
  const list = usePlugins((s) => s.list);
  const nonce = usePlugins((s) => s.nonce);
  const refresh = usePlugins((s) => s.refresh);

  useEffect(() => {
    installHost();
    void refresh();
  }, [refresh]);

  // The sites the reader allowed plugins are the open library's: read again when another opens.
  const root = useStore((s) => s.root);
  const mayHaveSites = list.filter((p) => p.state.granted.includes("sites")).map((p) => p.id).join();
  useEffect(() => void usePlugins.getState().loadSites(root), [root, mayHaveSites]);

  return (
    <div className="plugin-frames" aria-hidden>
      {list
        .filter((p) => p.state.enabled && p.manifest)
        .map((p) => (
          <iframe
            key={`${p.id}@${p.manifest!.version}#${nonce[p.id] ?? 0}`}
            ref={(el) => registerFrame(p.id, el)}
            title={`plugin ${p.id}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            src={frameUrl(p.id)}
            onLoad={() => frameLoaded(p.id)}
          />
        ))}
    </div>
  );
}
