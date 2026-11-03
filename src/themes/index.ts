/**
 * Theme registry. A theme is a CSS file that sets the custom properties
 * declared in base.css under `[data-theme="<id>"]`, plus optional
 * decorations (overlays, clip paths). Add a theme by importing its CSS in
 * main.tsx and listing it here.
 */
export type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

export interface Theme {
  id: string;
  name: string;
  description: string;
  /** Phosphor icon weight that matches the theme's character. */
  iconWeight: IconWeight;
  /** The mode it was designed in; the other is its own take on light or dark. */
  native: "dark" | "light";
}

/** Light or dark, or whichever the system is in. */
export type Mode = "light" | "dark" | "system";
export type ResolvedMode = Exclude<Mode, "system">;

export const themes: Theme[] = [
  {
    id: "cp2077",
    name: "Night City",
    description: "Cyberpunk 2077: acid yellow, cyan, red, cut corners, scanlines.",
    iconWeight: "fill",
    native: "dark",
  },
  {
    id: "ghost",
    name: "Ghost",
    description: "Minimal monochrome, no decorations. Lets the image speak.",
    iconWeight: "regular",
    native: "dark",
  },
  {
    id: "cozy",
    name: "Cozy",
    description: "Warm cream, dusty rose and sage. Soft corners, calm and quiet.",
    iconWeight: "duotone",
    native: "light",
  },
  {
    id: "midnight",
    name: "Midnight",
    description: "Night City's cuts and glow in cool blue and silver.",
    iconWeight: "bold",
    native: "dark",
  },
  {
    id: "sunset",
    name: "Sunset",
    description: "Peach, apricot and plum with soft gradients and round corners.",
    iconWeight: "duotone",
    native: "light",
  },
  {
    id: "manga",
    name: "Manga",
    description: "Paper white and ink black, screentone shading, hard panel outlines, a sakura accent.",
    iconWeight: "bold",
    native: "light",
  },
  {
    id: "gallery",
    name: "Gallery",
    description: "White walls, almost no chrome. The images are the only colour.",
    iconWeight: "thin",
    native: "light",
  },
];

const KEY = "quire.theme";
const MODE_KEY = "quire.mode";

export function loadModeId(): Mode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "light" || m === "dark" || m === "system") return m;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

/** The system's light or dark, as the webview reports it (dark where it can't say). */
export function systemMode(): ResolvedMode {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export const resolveMode = (mode: Mode): ResolvedMode => (mode === "system" ? systemMode() : mode);

/** Told when the system switches between light and dark; the cleanup stops listening. */
export function watchSystemMode(cb: () => void): () => void {
  try {
    if (typeof matchMedia !== "function") return () => {};
    const q = matchMedia("(prefers-color-scheme: light)");
    q.addEventListener("change", cb);
    return () => q.removeEventListener("change", cb);
  } catch {
    return () => {};
  }
}

/**
 * The look: a theme in a mode. Both go on the root (`data-theme`, `data-mode`), where every theme's
 * stylesheet reads them, and are remembered on this computer. The window's own chrome (the title
 * bar's traffic lights) follows the mode.
 */
export function applyLook(id: string, mode: Mode): ResolvedMode {
  const resolved = resolveMode(mode);
  document.documentElement.dataset.theme = id;
  document.documentElement.dataset.mode = resolved;
  try {
    localStorage.setItem(KEY, id);
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage unavailable */
  }
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme?.(resolved))
    .catch(() => {});
  return resolved;
}

export function loadThemeId(): string {
  try {
    const id = localStorage.getItem(KEY);
    if (id && themes.some((t) => t.id === id)) return id;
  } catch {
    /* storage unavailable */
  }
  return themes[0].id;
}

export function applyTheme(id: string) {
  applyLook(id, loadModeId());
}
