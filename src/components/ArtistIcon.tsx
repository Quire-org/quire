import { PaintBrush } from "@phosphor-icons/react";
import { useArtistIcon, type LocalArtist } from "../artistsStore";

/** An artist's icon (from their platform, kept with the library), else their initials: who they are at a glance, whatever script their name is in. */
export function ArtistIcon({ artist, size }: { artist: LocalArtist; size: number }) {
  const src = useArtistIcon(artist);
  const initials = artist.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return src ? <img className="artist-icon" src={src} alt="" style={{ width: size, height: size }} /> : <span className="artist-icon artist-initials" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials || <PaintBrush />}</span>;
}
