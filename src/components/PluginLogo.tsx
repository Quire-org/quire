import { PuzzlePiece } from "@phosphor-icons/react";
import { useFinders } from "../plugins/find";
import { PlatformIcon } from "./PlatformIcon";
import type { PluginInfo } from "../plugins/types";

/**
 * A plugin's logo, always the same size: its own (plugin.json's `icon`), else its Find platform's
 * icon (the site's own), else the plugin mark.
 */
export function PluginLogo({ plugin, size = 28 }: { plugin: PluginInfo; size?: number }) {
  const platformIcon = useFinders((f) => f.finders[plugin.id]?.icon ?? null);
  return (
    <span className="plugin-logo" style={{ width: size, height: size }} aria-hidden>
      {plugin.icon ? <img src={plugin.icon} alt="" draggable={false} /> : platformIcon ? <PlatformIcon pluginId={plugin.id} url={platformIcon} size={size} /> : <PuzzlePiece size={Math.round(size * 0.8)} />}
    </span>
  );
}
