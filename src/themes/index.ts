/**
 * Theme registry. A theme is a CSS file that sets the custom properties
 * declared in base.css under `[data-theme="<id>"]`, plus optional
 * decorations (overlays, clip paths). Add a theme by importing its CSS in
 * main.tsx and listing it here.
 */
export interface Theme {
  id: string;
  name: string;
  description: string;
}

export const themes: Theme[] = [
  {
    id: "cp2077",
    name: "Night City",
    description: "Cyberpunk 2077: acid yellow, cyan, red, cut corners, scanlines.",
  },
  {
    id: "ghost",
    name: "Ghost",
    description: "Minimal monochrome, no decorations. Lets the image speak.",
  },
  {
    id: "cozy",
    name: "Cozy",
    description: "Warm cream, dusty rose and sage. Soft corners, calm and quiet.",
  },
];

const KEY = "mediasorter.theme";

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
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable */
  }
}
