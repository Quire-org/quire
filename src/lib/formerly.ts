/**
 * The window's saved settings had Media Sorter's names (`mediasorter.theme`…) before the app was
 * Quire. Each gets Quire's name (`quire.theme`) once, before anything reads it: main.tsx imports
 * this first. One Quire has saved under its own name already is kept, the old one let go of.
 */
const OLD = "mediasorter.";
const NEW = "quire.";

export function renameSavedSettings(store: Storage): number {
  const old: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(OLD)) old.push(key);
  }
  for (const key of old) {
    const value = store.getItem(key);
    const to = NEW + key.slice(OLD.length);
    if (value !== null && store.getItem(to) === null) store.setItem(to, value);
    store.removeItem(key);
  }
  return old.length;
}

try {
  renameSavedSettings(localStorage);
} catch {
  // No saved settings to read (a private window): nothing to rename.
}
