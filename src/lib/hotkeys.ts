/** Keys the viewer uses itself; target folders cannot claim them. */
export const RESERVED_KEYS = new Set([
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  " ", "arrowleft", "arrowright", "arrowup", "arrowdown",
  "backspace", "delete", "escape", "enter", "tab",
  "z", "s", "f", "b", "u", "g", "h", "i", "?", "m", ",", ".", "d", "a", "x", "c", "r", "e", "t", "o", "[", "]", "\\",
  "p", "w", "l", "k",
]);

export const VIEWER_KEYS: { keys: string[]; label: string }[] = [
  { keys: ["1-9", "0"], label: "Rate 1-10" },
  { keys: ["U"], label: "Clear rating" },
  { keys: ["←", "→"], label: "Previous / next" },
  { keys: ["⌫"], label: "Delete (to trash)" },
  { keys: ["⇧ + key"], label: "⇧ and a bucket's key (or ⇧-click its button): into a folder of yours in it, or a new one, filed by the day there" },
  { keys: ["⌘Z"], label: "Undo" },
  { keys: ["Space"], label: "Play / pause video" },
  { keys: ["M"], label: "Mute video" },
  { keys: [",", "."], label: "Scrub 5s, or step frames when paused" },
  { keys: ["[", "]", "\\"], label: "Playback speed down / up / reset" },
  { keys: ["C"], label: "Immersive: hide the HUD, black background, hidden cursor (no button, key only)" },
  { keys: ["H"], label: "Hide or show the HUD (viewer), or both the top bar and sidebar (list screens); each also has its own button" },
  { keys: ["R"], label: "Surprise me: a random item you haven't seen lately" },
  { keys: ["⏎"], label: "Slideshow: auto-advance on a timer (videos play to the end)" },
  { keys: ["S"], label: "Shuffle queue" },
  { keys: ["⇧H"], label: "Home: the library's board (or click QUIRE in the top bar)" },
  { keys: ["B"], label: "Browse everything" },
  { keys: ["D"], label: "Find duplicates" },
  { keys: ["A"], label: "Albums" },
  { keys: ["P"], label: "People" },
  { keys: ["⇧P"], label: "Faces in this picture: say who each is, mark one it missed, or add someone whose face doesn't show" },
  { keys: ["W"], label: "Artists: who made the pictures" },
  { keys: ["⇧W"], label: "Who made this one (an album page: the album)" },
  { keys: ["E"], label: "Files: every file and folder, drag and drop, encrypt on the way in" },
  { keys: ["O"], label: "Show / hide plugin overlays; on an edited picture, show what it was made from" },
  { keys: ["T"], label: "Edit mode: rotate, flip, crop, resize, trim, speed, convert, and the plugins' tools; Esc cancels" },
  { keys: ["X"], label: "Fit / fill the screen" },
  { keys: ["Z", "click"], label: "Loupe: click zooms to 200% at the cursor, click again to fit; Z cycles fit / 100% / 200%; drag to pan" },
  { keys: ["G"], label: "Open settings" },
  { keys: ["I"], label: "Show file info" },
  { keys: ["F"], label: "Toggle fullscreen (key only)" },
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

/**
 * Something is open over the screen that the keys belong to: a dialog, a menu, a popover, a list.
 * Each screen's keys stay out of the way then (⌫ over an Import dialog must not trash a picture).
 */
export const dialogOpen = () => !!document.querySelector(".modal-backdrop, .context-menu, .pop, .sel-pop");

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"]);

/** True when key presses should go to the focused element instead of the app's hotkeys. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
