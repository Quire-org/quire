/**
 * Runtime app icon. The bundled icon (Finder, Launchpad, Explorer) is static, but the
 * Dock icon on macOS and the window / taskbar icon on Windows and Linux can be replaced
 * while the app runs. On every theme change the icon template is re-tinted from the
 * theme's CSS variables, rasterised in the webview and handed to the backend.
 */
import template from "../assets/app-icon.svg?raw";
import { api } from "./api";

/** Template slot -> CSS custom property it is filled from. */
export const ICON_SLOTS = {
  bg: "--bg-2",
  ink: "--accent",
} as const;

export type IconColors = Record<keyof typeof ICON_SLOTS, string>;

export function fillIcon(colors: IconColors): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => colors[k as keyof IconColors] ?? "magenta");
}

function themeColors(): IconColors {
  const cs = getComputedStyle(document.documentElement);
  const out = {} as IconColors;
  for (const [slot, prop] of Object.entries(ICON_SLOTS)) {
    out[slot as keyof IconColors] = cs.getPropertyValue(prop).trim();
  }
  return out;
}

function rasterise(svg: string, size: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      canvas.getContext("2d")!.drawImage(img, 0, 0, size, size);
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error("could not encode icon"));
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      }, "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("could not render icon"));
    };
    img.src = url;
  });
}

let lastSvg = "";

/** Re-tint the running app's icon from the current theme. Cheap when nothing changed. */
export async function syncAppIcon(): Promise<void> {
  const svg = fillIcon(themeColors());
  if (svg === lastSvg) return;
  lastSvg = svg;
  try {
    await api.setAppIcon(await rasterise(svg, 1024));
  } catch (e) {
    lastSvg = "";
    console.warn("app icon not updated", e);
  }
}
