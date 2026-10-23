/** Keys the viewer uses itself; target folders cannot claim them. */
export const RESERVED_KEYS = new Set([
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  " ", "arrowleft", "arrowright", "arrowup", "arrowdown",
  "backspace", "delete", "escape", "enter", "tab",
  "z", "s", "f", "b", "u", "h", "g", "i", "?", "m", ",", ".", "d", "a", "x",
]);

export const VIEWER_KEYS: { keys: string[]; label: string }[] = [
  { keys: ["1-9", "0"], label: "Rate 1-10" },
  { keys: ["U"], label: "Clear rating" },
  { keys: ["←", "→"], label: "Previous / next" },
  { keys: ["⌫"], label: "Delete (to trash)" },
  { keys: ["⌘Z"], label: "Undo" },
  { keys: ["Space"], label: "Play / pause video" },
  { keys: ["M"], label: "Mute video" },
  { keys: [",", "."], label: "Scrub video 5s" },
  { keys: ["S"], label: "Shuffle queue" },
  { keys: ["B"], label: "Browse everything" },
  { keys: ["D"], label: "Find duplicates" },
  { keys: ["A"], label: "Albums" },
  { keys: ["X"], label: "Fit / fill the screen" },
  { keys: ["G"], label: "Open settings" },
  { keys: ["H"], label: "Hide / show HUD" },
  { keys: ["I"], label: "Show file info" },
  { keys: ["F"], label: "Toggle fullscreen" },
  { keys: ["Esc"], label: "Back / leave fullscreen" },
];

/** Pick a free single-letter hotkey for a new target, preferring letters from its name. */
export function suggestHotkey(name: string, taken: string[]): string {
  const used = new Set(taken.map((k) => k.toLowerCase()));
  const candidates = [
    ...name.toLowerCase().replace(/[^a-z]/g, ""),
    ..."abcdefghijklmnopqrstuvwxyz",
  ];
  for (const c of candidates) {
    if (!RESERVED_KEYS.has(c) && !used.has(c)) return c;
  }
  return "";
}

export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
