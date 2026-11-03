import type { PluginInfo } from "./types";

/** Plain-language description of a permission, and whether it deserves attention. */
export function describePermission(p: string): { title: string; detail: string; sensitive: boolean } {
  if (p.startsWith("login:")) {
    const host = p.slice(6);
    return { title: `Sign you in on ${host}`, detail: `Can open ${host}'s sign-in page in a window of its own and receive the sign-in when you finish.`, sensitive: true };
  }
  if (p.startsWith("network:")) {
    const host = p.slice(8);
    return { title: `Contact ${host}`, detail: `Can send data to ${host}, which may include your photos if it can also read them.`, sensitive: true };
  }
  switch (p) {
    case "media:read":
      return { title: "See your photos and videos", detail: "File names, folders and image contents of what is open in the app.", sensitive: true };
    case "media:write":
      return { title: "Save new files", detail: "Can add files next to your media, and replace a file with its own version of it when you ask it to; the original then goes to the trash, where Undo brings it back.", sensitive: false };
    case "overlay":
      return { title: "Draw over images", detail: "Text and boxes on top of the viewer, for example labels or notes.", sensitive: false };
    case "viewer":
      return { title: "Control the viewer", detail: "Go to the next or previous item, change reading direction, and ask you to mark part of an image.", sensitive: false };
    case "engine":
      return { title: "Run its own pipeline on this computer", detail: "Runs the plugin's own image pipeline on your pictures in Quire's local engine, sandboxed: it sees only the picture it is given and the models it names, which you download in Settings → Local models. Nothing leaves this computer.", sensitive: false };
    case "storage":
      return { title: "Keep its own data", detail: "A private store on this computer (not on the card), up to 5 MB.", sensitive: false };
    case "library:storage":
      return { title: "Keep data with the library", detail: "Up to 1 MB with the library on its drive, such as a sign-in: in its vault when it has one, otherwise unencrypted, where anyone with the drive can read it.", sensitive: true };
    case "find":
      return { title: "Add a platform to Find", detail: "Its searches and pages show in Find, and the pictures you pick from it come into the library through Import.", sensitive: false };
    case "sites":
      return { title: "Ask to use sites you add", detail: "When you add a site to it, it asks you to allow that site (and its subdomains): then it may contact it, and open it in a window of its own to pass its browser check. The sites are listed here, to remove.", sensitive: true };
    default:
      return { title: p, detail: "Unknown permission.", sensitive: true };
  }
}

/** Permissions in effect: granted by the user and still asked for by the manifest. */
export function effective(p: PluginInfo): Set<string> {
  if (!p.manifest || !p.state.enabled) return new Set();
  const asked = new Set(p.manifest.permissions);
  const out = new Set(p.state.granted.filter((g) => asked.has(g)));
  // Each site the reader allowed: it and its subdomains, to contact and to open in a window.
  if (out.has("sites")) for (const d of p.sites ?? []) (out.add(`network:*.${d}`), out.add(`login:*.${d}`));
  return out;
}

export function can(p: PluginInfo, perm: string): boolean {
  return effective(p).has(perm);
}

/** May the plugin open `url` as a sign-in page (https, on a `login:` host)? The backend checks again. */
export function canLogin(p: PluginInfo, url: string): boolean {
  return hostGranted(p, url, "login:");
}

/** Is `url` within the plugin's granted hosts? (The backend checks again.) */
export function canFetch(p: PluginInfo, url: string): boolean {
  return hostGranted(p, url, "network:");
}

function hostGranted(p: PluginInfo, url: string, kind: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const g of effective(p)) {
    if (!g.startsWith(kind)) continue;
    const h = g.slice(kind.length);
    if (h.startsWith("*.") ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h) return true;
  }
  return false;
}
