import { create } from "zustand";
import type { LibrarySettings } from "./types";

/**
 * Asking before going online: with it on, nothing an extension fetches (Find's searches, works and
 * pictures, artists' pages, the basket's pictures, saved searches checked, an extension's own
 * requests) goes out until the reader says Connect, for every platform at once or each on its own.
 * For a reader on mobile data or a public Wi-Fi. Kept with the library (see librarySettings) and on
 * this computer as last used; a connection lasts until the app closes, or until Disconnect.
 */
export interface OnlineSettings {
  ask: boolean;
  /** Connect each platform on its own, rather than all at once. */
  each: boolean;
  /** A connection stays (across launches) until Disconnect, rather than until the app closes. */
  keep: boolean;
}

interface Connected {
  all: boolean;
  /** Platforms (their plugins' ids) connected one by one. */
  platforms: string[];
}

const SETTINGS_KEY = "quire.online";
const KEPT_KEY = "quire.online.connected";
const NONE: Connected = { all: false, platforms: [] };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage off: it lasts this run */
  }
}

/** Kept with the open library too (the store is reached lazily: it imports this). */
function keep(patch: Partial<LibrarySettings>) {
  void import("../store").then(({ useStore }) => useStore.getState().keepSettings(patch));
}

interface OnlineState {
  settings: OnlineSettings;
  connected: Connected;
  set(patch: Partial<OnlineSettings>): void;
  /** A library's settings taken in, and what it kept connected (when connections are kept). */
  take(settings: OnlineSettings, connected?: Connected): void;
  /** Connected: a platform (when each is asked for on its own), or all. */
  connect(pluginId?: string): void;
  disconnect(): void;
  /** A platform removed: no longer connected. */
  forget(pluginId: string): void;
}

const initial = read<OnlineSettings>(SETTINGS_KEY, { ask: false, each: false, keep: false });

export const useOnline = create<OnlineState>((set, get) => ({
  settings: initial,
  connected: initial.keep ? read<Connected>(KEPT_KEY, NONE) : NONE,
  set(patch) {
    const settings = { ...get().settings, ...patch };
    write(SETTINGS_KEY, settings);
    write(KEPT_KEY, settings.keep ? get().connected : null);
    set({ settings });
    keep({ online: settings, connected: settings.keep ? get().connected : undefined });
  },
  take(settings, kept) {
    const connected = settings.keep ? (kept ?? NONE) : get().connected;
    write(SETTINGS_KEY, settings);
    write(KEPT_KEY, settings.keep ? connected : null);
    set({ settings, connected });
  },
  connect(pluginId) {
    const c = get().connected;
    const connected = get().settings.each && pluginId ? { ...c, platforms: [...new Set([...c.platforms, pluginId])] } : { ...c, all: true };
    if (get().settings.keep) write(KEPT_KEY, connected), keep({ connected });
    set({ connected });
  },
  disconnect() {
    write(KEPT_KEY, null);
    set({ connected: NONE });
    keep({ connected: undefined });
  },
  forget(pluginId) {
    const c = get().connected;
    if (!c.platforms.includes(pluginId)) return;
    const connected = { ...c, platforms: c.platforms.filter((p) => p !== pluginId) };
    if (get().settings.keep) write(KEPT_KEY, connected), keep({ connected });
    set({ connected });
  },
}));

/** Whether an extension (a platform) may go online now. */
export function mayGoOnline(pluginId: string | null, s: Pick<OnlineState, "settings" | "connected"> = useOnline.getState()): boolean {
  if (!s.settings.ask || s.connected.all) return true;
  return !!pluginId && s.settings.each && s.connected.platforms.includes(pluginId);
}

/** The same, kept up to date for a screen. */
export const useMayGoOnline = (pluginId: string | null) => useOnline((s) => mayGoOnline(pluginId, s));

/** What a refused request says. */
export const NOT_CONNECTED = "not connected: Quire asks before going online (Settings → Going online)";
