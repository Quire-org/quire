/**
 * The app's settings kept with the library (in its `.quire.json`, inside a vault when it is one), so
 * whichever copy of the app opens it has them: the released app and a dev build keep storage of
 * their own, as two computers do. Each is remembered on the computer too, as the one last used, for
 * before a library is open (the welcome card's theme). A library opened without some is given this
 * computer's, once. Changes go in through `keepSettings` in the store, from each setting's setter.
 */
import { takingFromLibrary, useStore } from "../store";
import { themes } from "../themes";
import { useOnline } from "./online";
import { useSounds } from "./sounds";
import { useUpdates } from "./updates";
import type { LibrarySettings } from "./types";

/** This computer's settings now: what a library without its own is given. */
export function settingsHere(): LibrarySettings {
  const s = useStore.getState();
  const { menus, sorting, volume } = useSounds.getState();
  const online = useOnline.getState();
  return {
    theme: s.theme,
    mode: s.themeMode,
    sounds: { menus, sorting, volume },
    slideshow: { interval: s.slideshow.interval, hideUi: s.slideshow.hideUi },
    pageTurns: s.pageTurns,
    seriesTogether: s.seriesTogether,
    fit: s.fitMode,
    online: online.settings,
    connected: online.settings.keep ? online.connected : undefined,
    updates: { auto: useUpdates.getState().auto },
  };
}

/** Updates are looked for once a run, when the first library that asks for it opens. */
let looked = false;

/** The open library's settings taken in; those it hasn't, given it from this computer's. */
export function adoptSettings() {
  const s = useStore.getState();
  if (!s.library) return;
  const kept = s.library.settings ?? {};
  takingFromLibrary(() => {
    if (kept.theme && kept.theme !== s.theme && themes.some((t) => t.id === kept.theme)) s.setTheme(kept.theme);
    if (kept.mode && kept.mode !== useStore.getState().themeMode) s.setThemeMode(kept.mode);
    if (kept.sounds) useSounds.getState().set(kept.sounds);
    if (kept.slideshow) {
      s.setSlideshowInterval(kept.slideshow.interval);
      s.setSlideshowHideUi(kept.slideshow.hideUi);
    }
    if (kept.pageTurns !== undefined && kept.pageTurns !== s.pageTurns) s.setPageTurns(kept.pageTurns);
    if (kept.seriesTogether !== undefined && kept.seriesTogether !== s.seriesTogether) s.setSeriesTogether(kept.seriesTogether);
    if (kept.fit && kept.fit !== s.fitMode) s.setFitMode(kept.fit);
    if (kept.online) useOnline.getState().take(kept.online, kept.connected);
    if (kept.updates) useUpdates.getState().setAuto(kept.updates.auto);
  });
  const here = settingsHere();
  const missing = Object.fromEntries((Object.keys(here) as (keyof LibrarySettings)[]).filter((k) => kept[k] === undefined && here[k] !== undefined).map((k) => [k, here[k]]));
  if (Object.keys(missing).length) useStore.getState().keepSettings(missing);
  if (!looked && useUpdates.getState().auto) {
    looked = true;
    setTimeout(() => void useUpdates.getState().check(true), 5000);
  }
}
