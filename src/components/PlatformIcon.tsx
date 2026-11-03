import { useEffect } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { keepFetchedIcon, useFind, useFindImage } from "../findStore";

/**
 * A platform's (or one of its sites') own icon: one its plugin brings along as it is, else the one
 * kept with the library, else fetched through the plugin (and kept, so it shows while Quire
 * waits to go online); Find's mark until it has come, or when it has none.
 */
export function PlatformIcon({ pluginId, url, size = 16 }: { pluginId: string; url: string | null; size?: number }) {
  const inline = url?.startsWith("data:image/") ? url : null;
  const kept = useFind((f) => (url && !inline ? f.icons[url] : undefined));
  const img = useFindImage(pluginId, inline || kept ? null : url);
  useEffect(() => {
    if (url && img.src && !kept) keepFetchedIcon(url, img.src);
  }, [url, img.src, kept]);
  const src = inline ?? kept ?? img.src;
  return src ? <img className="platform-icon" src={src} alt="" width={size} height={size} draggable={false} /> : <MagnifyingGlass size={size} />;
}
