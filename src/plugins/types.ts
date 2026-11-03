export type ButtonLocation = "viewer.toolbar" | "browse.selection" | "album.card";
export const BUTTON_LOCATIONS: ButtonLocation[] = ["viewer.toolbar", "browse.selection", "album.card"];

export interface SettingSpec {
  key: string;
  type: "text" | "secret" | "select" | "boolean" | "number";
  label: string;
  options?: string[];
  default?: unknown;
  help?: string;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  homepage?: string | null;
  entry: string;
  permissions: string[];
  settings: SettingSpec[];
  minAppVersion?: string | null;
  /** Ids of the local engine's models the plugin uses, shown under it in Local models. */
  models?: string[];
  /** Its logo: a picture in its folder (shown from `PluginInfo.icon`). */
  icon?: string | null;
}

export interface PluginStateInfo {
  enabled: boolean;
  allowVault: boolean;
  granted: string[];
  source: string;
  linked?: string | null;
  github?: { owner: string; repo: string; gitRef?: string | null; path?: string | null } | null;
  commit?: string | null;
  installedAt: number;
}

export interface PluginInfo {
  id: string;
  manifest: Manifest | null;
  state: PluginStateInfo;
  /** Sites the reader allowed it (with `sites`) for the library open, kept with that library: each domain, with its subdomains. */
  sites?: string[];
  dir: string;
  error?: string | null;
  /** Its logo (plugin.json's `icon`), as a `data:` picture ready to show. */
  icon?: string | null;
}

export interface UpdateInfo {
  id: string;
  current: string;
  latest: string;
  newPermissions: string[];
  manifest: Manifest;
  commit: string;
}

export interface Inspected {
  manifest: Manifest;
  kind: "github" | "local";
  location: string;
}

export interface UpdateCheck {
  id: string;
  update: UpdateInfo | null;
  error: string | null;
}

export interface PluginButton {
  pluginId: string;
  id: string;
  location: ButtonLocation;
  label: string;
  tooltip?: string;
  /** SVG markup, drawn as a mask in the theme's text colour. */
  icon?: string;
  active?: boolean;
  busy?: boolean;
}

/** A control in a plugin's panel at the right of the viewer. */
export type PanelControl =
  | { type: "heading"; label: string }
  | { type: "text"; text: string }
  | { type: "button"; id: string; label: string; tooltip?: string; primary?: boolean; active?: boolean; busy?: boolean; disabled?: boolean }
  | { type: "toggle"; id: string; label: string; value: boolean; disabled?: boolean }
  | { type: "choice"; id: string; label: string; options: { id: string; label: string }[]; value: string | null; disabled?: boolean }
  | { type: "brush"; id: string; modes: { id: string; label: string }[]; mode: string | null; hint?: string }
  /** A colour picked from the image with an eyedropper: "#rrggbb" or null. */
  | { type: "colour"; id: string; label: string; value: string | null }
  /** A line of text the reader types; each change comes back as a `panel` event. */
  | { type: "input"; id: string; label: string; value: string; placeholder?: string };

export interface PluginPanel {
  pluginId: string;
  title: string;
  /** SVG markup for the viewer bar's button that opens it. */
  icon?: string;
  controls: PanelControl[];
}

/**
 * Versions of pictures a plugin makes (cleaned-up pages, say), for the duplicate check: a toggle on the
 * Duplicates screen, and while it is on, the versions are matched with their originals.
 */
export interface PluginDupeVersions {
  pluginId: string;
  id: string;
  label: string;
  tooltip?: string;
  /** Copies it saved as `prefix` + the original's name, beside it. */
  prefix?: string;
  /** Versions it wrote in place of their original, by key. */
  keys: string[];
  /** What a version is called in the groups. */
  note: string;
}

/** A long job a plugin is running, shown in a status pill at the top until it ends. */
export interface PluginTask {
  pluginId: string;
  id: string;
  label: string;
  done: number;
  total: number;
  /** What it is on now, such as a file name. */
  detail: string;
  /** When it was first shown and last updated (ms), for the time left. */
  started: number;
  updated: number;
  /** Cancel was pressed; the plugin is finishing what it is on. */
  stopping: boolean;
  /** The item it is working on, shown as a thumbnail in Activity. */
  itemKey?: string;
  /** The plugin can pause this job (it said so, and handles the "pause" event). */
  pausable?: boolean;
  /** Paused from Activity. */
  paused?: boolean;
}

export interface OverlayBox {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  vertical?: boolean;
  /** Drawn as an outline only (a highlight), no text or background. */
  outline?: boolean;
  /** An image drawn in the box instead of text: a blob: URL the host made from the plugin's bytes. */
  image?: string;
}

export interface LogLine {
  t: number;
  level: string;
  message: string;
}

export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
  bodyBase64: string | null;
}

/** Something the local engine can download: the text tools' shared parts, a text reader, a language model, a model a plugin brings, or one the app itself uses (tags, stickers). */
export interface EngineModel {
  id: string;
  kind: "base" | "reader" | "translator" | "plugin" | "embedder" | "tagger" | "cutout" | "faces";
  name: string;
  note: string;
  /** Download size in bytes; null when it depends on the computer. */
  size: number | null;
  downloaded: boolean;
}

/** Where the engine keeps its models. */
export interface StoreInfo {
  /** The chosen folder, or null for the app's data folder. */
  path: string | null;
  default: string;
}

export interface EngineCatalog {
  /** The engine program is installed with the app. */
  available: boolean;
  models: EngineModel[];
  /** Bytes the models take on disk. */
  used: number;
  /** The language model used when a plugin's pipeline doesn't name one. */
  chosen: string;
  downloading: boolean;
}

export interface DownloadProgress {
  completed: number;
  total: number;
  name: string;
}

/** A thing a plugin shares on the Home (`home.share`): its picture by address (`thumb`) or as an image of its own (`image`, an object URL), and the work on its Find platform it opens. */
export interface SharedItem {
  id: string;
  title: string;
  thumb?: string;
  image?: string;
  work?: string;
}

/** A plugin's part of a shared panel on the Home. */
export interface SharedPart {
  title: string;
  items: SharedItem[];
}
