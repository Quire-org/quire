import { useEffect, useRef } from "react";
import { create } from "zustand";

/**
 * The app's sounds: off until turned on (Settings → Look and reading), each theme with its own, all
 * of them low and soft: a quiet touch to what is done, not a feature.
 * Two kinds, each turned on by itself: the menus' (a menu, list or dialog opening and closing, an
 * entry chosen, a switch flipped, something going wrong) and sorting's (a rating, a picture filed,
 * one to the trash). The sounds are Kenney's Interface Sounds (CC0, kenney.nl), in assets/sounds
 * with their licence.
 */

export type Cue = "open" | "close" | "select" | "toggle" | "error" | "rate" | "move" | "trash";
const SORTING = new Set<Cue>(["rate", "move", "trash"]);
export const CUES: Cue[] = ["open", "close", "select", "toggle", "error", "rate", "move", "trash"];

/** A sound: its file in assets/sounds (without .wav), and how loud against the theme's others. */
type Sound = [file: string, gain?: number];

export interface ThemeSounds {
  /** How loud the theme is, all told. */
  gain: number;
  /** Played this much slower and lower (1: as recorded). */
  pitch: number;
  /** Softened: only what is below this many hertz is heard. */
  lowpass: number;
  cues: Record<Cue, Sound>;
}

/**
 * Each theme's sound: low and soft in all of them, a touch under what is done rather than a sound
 * of its own (Kenney's brighter clicks, glass and glitches played lower, slower and softened, or
 * left out). What closes is quieter than what opens; a press is the quietest of all.
 */
export const THEME_SOUNDS: Record<string, ThemeSounds> = {
  // Night City: muted synth, low sweeps up and down, a soft confirming tone.
  cp2077: {
    gain: 0.55,
    pitch: 0.9,
    lowpass: 3200,
    cues: { open: ["maximize_008"], close: ["minimize_008", 0.7], select: ["click_005", 0.8], toggle: ["back_004"], error: ["error_007"], rate: ["select_002", 0.7], move: ["confirmation_001"], trash: ["back_002"] },
  },
  // Midnight: slow sweeps, and a low chime for what is filed.
  midnight: {
    gain: 0.5,
    pitch: 0.8,
    lowpass: 2600,
    cues: { open: ["maximize_006"], close: ["minimize_006", 0.7], select: ["click_001", 1.2], toggle: ["select_007", 0.8], error: ["error_008"], rate: ["select_007", 0.7], move: ["glass_006"], trash: ["drop_003"] },
  },
  // Cozy: drops of water, warm and round.
  cozy: {
    gain: 0.55,
    pitch: 0.85,
    lowpass: 2200,
    cues: { open: ["drop_002"], close: ["drop_003", 0.7], select: ["click_001", 1.2], toggle: ["drop_001", 0.8], error: ["error_008"], rate: ["click_001"], move: ["confirmation_001"], trash: ["back_002"] },
  },
  // Sunset: rounded tones.
  sunset: {
    gain: 0.5,
    pitch: 0.85,
    lowpass: 2600,
    cues: { open: ["select_004"], close: ["select_005", 0.7], select: ["click_001", 1.2], toggle: ["select_002", 0.7], error: ["error_003", 0.8], rate: ["select_007", 0.7], move: ["confirmation_004", 0.8], trash: ["drop_004"] },
  },
  // Manga: paper turned and set down, a soft stamp for what is filed.
  manga: {
    gain: 0.5,
    pitch: 0.85,
    lowpass: 2000,
    cues: { open: ["scratch_004", 0.8], close: ["scratch_001", 0.5], select: ["click_005", 0.8], toggle: ["back_004", 0.8], error: ["error_007"], rate: ["click_001"], move: ["bong_001"], trash: ["scratch_005", 0.7] },
  },
  // Gallery: almost nothing.
  gallery: {
    gain: 0.4,
    pitch: 0.9,
    lowpass: 2400,
    cues: { open: ["select_005"], close: ["select_002", 0.6], select: ["click_001"], toggle: ["click_001"], error: ["error_008"], rate: ["click_001"], move: ["select_007"], trash: ["back_003"] },
  },
  // Ghost: less than that.
  ghost: {
    gain: 0.3,
    pitch: 0.9,
    lowpass: 2000,
    cues: { open: ["click_001"], close: ["click_001", 0.6], select: ["click_001", 0.8], toggle: ["click_005"], error: ["error_008"], rate: ["click_001"], move: ["select_002"], trash: ["back_003"] },
  },
};

/**
 * The files, bundled with the app (each a few kilobytes). Never inlined into the code as `data:`
 * addresses, as the build does with small files: the app's content policy wouldn't let them be read.
 */
const FILES = import.meta.glob("../assets/sounds/*.wav", { eager: true, query: "?no-inline", import: "default" }) as Record<string, string>;
export const soundUrl = (file: string): string | undefined => FILES[`../assets/sounds/${file}.wav`];

export interface SoundPrefs {
  menus: boolean;
  sorting: boolean;
  /** 0 to 1. */
  volume: number;
}

const KEY = "quire.sounds";
const DEFAULTS: SoundPrefs = { menus: false, sorting: false, volume: 0.35 };

function loadPrefs(): SoundPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (v && typeof v === "object") return { menus: v.menus === true, sorting: v.sorting === true, volume: typeof v.volume === "number" ? Math.min(1, Math.max(0, v.volume)) : DEFAULTS.volume };
  } catch {
    /* storage unavailable */
  }
  return DEFAULTS;
}

/** The sound settings, kept on this computer like the theme. */
export const useSounds = create<SoundPrefs & { set: (patch: Partial<SoundPrefs>) => void }>((set, get) => ({
  ...loadPrefs(),
  set(patch) {
    set(patch);
    const { menus, sorting, volume } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ menus, sorting, volume }));
    } catch {
      /* storage unavailable */
    }
  },
}));

/** When each cue was last heard (ms), for the rules below. */
const heard: Partial<Record<Cue, number>> = {};
/** When a press last made its sound (ms): what the press then does is heard in it, not again. */
let pressedAt = -Infinity;
/** What a press is heard as already: a menu or dialog opening or closing, an entry chosen, a switch. */
const ON_PRESS = new Set<Cue>(["open", "close", "select", "toggle"]);
/** How long after a press what it did is taken as its doing (a press held, a slow commit). */
const PRESS_MS = 700;

/**
 * Whether a cue is heard now. The same one twice within a moment, once (a key held, React's checks
 * in development); a menu closing just after an entry in it was chosen, or just after it opened, not
 * again; and nothing of a kind turned off.
 */
export function shouldPlay(cue: Cue, now: number, prefs: SoundPrefs): boolean {
  if (!(SORTING.has(cue) ? prefs.sorting : prefs.menus) || prefs.volume <= 0) return false;
  // The press it follows was heard already, the instant it happened.
  if (ON_PRESS.has(cue) && now - pressedAt < PRESS_MS) return false;
  const since = (c: Cue) => now - (heard[c] ?? -Infinity);
  if (since(cue) < 120) return false;
  if (cue === "close" && (since("select") < 250 || since("open") < 100)) return false;
  heard[cue] = now;
  return true;
}

/** Forget what was heard (tests). */
export function resetHeard() {
  for (const c of CUES) delete heard[c];
  pressedAt = -Infinity;
}

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

function buffer(file: string): Promise<AudioBuffer | null> {
  let b = buffers.get(file);
  if (!b) {
    const url = soundUrl(file);
    b = !url || !ctx
      ? Promise.resolve(null)
      : fetch(url)
          .then((r) => r.arrayBuffer())
          .then((data) => ctx!.decodeAudioData(data))
          .catch(() => null);
    buffers.set(file, b);
  }
  return b;
}

/** The theme on show (as the root says), whose sounds are played. */
const themeNow = () => (typeof document !== "undefined" && document.documentElement.dataset.theme) || "cp2077";

/**
 * Readies the audio, from a press or a key: WebKit (the app's webview) lets sound start only from
 * one, not from what follows it a moment later (a menu opening once the press is handled). A silent
 * sample started then is what it wants before it plays the later ones.
 */
function ready() {
  const { menus, sorting } = useSounds.getState();
  if ((!menus && !sorting) || typeof AudioContext === "undefined") return;
  try {
    ctx ??= new AudioContext({ latencyHint: "interactive" });
    if (ctx.state !== "running") {
      void ctx.resume();
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, 22050);
      silent.connect(ctx.destination);
      silent.start();
    }
  } catch {
    return;
  }
  const theme = THEME_SOUNDS[themeNow()] ?? THEME_SOUNDS.cp2077;
  for (const [f] of Object.values(theme.cues)) void buffer(f);
}

/** Plays a cue in the current theme's sound, if sounds of its kind are on. */
export function cue(c: Cue, force = false) {
  const prefs = useSounds.getState();
  if (!force && !shouldPlay(c, performance.now(), prefs)) return;
  if (typeof AudioContext === "undefined") return;
  const theme = THEME_SOUNDS[themeNow()] ?? THEME_SOUNDS.cp2077;
  const [file, gain = 1] = theme.cues[c];
  try {
    ctx ??= new AudioContext({ latencyHint: "interactive" });
    // A context made before the first click starts suspended; a click resumes it.
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    return;
  }
  // The theme's other sounds read now too, so the next cue isn't late.
  for (const [f] of Object.values(theme.cues)) void buffer(f);
  void buffer(file).then((b) => {
    if (!b || !ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = theme.pitch;
    // Softened, with no edge: the brightness taken off, and faded in over a few milliseconds so it
    // doesn't start with a snap.
    const soft = ctx.createBiquadFilter();
    soft.type = "lowpass";
    soft.frequency.value = theme.lowpass;
    soft.Q.value = 0;
    const level = ctx.createGain();
    const t = ctx.currentTime;
    level.gain.setValueAtTime(0, t);
    level.gain.linearRampToValueAtTime(prefs.volume * theme.gain * gain, t + 0.008);
    src.connect(soft).connect(level).connect(ctx.destination);
    src.start();
  });
}

/** A menu or list that opens and closes (not on its first showing closed). */
export function useOpenSound(open: boolean) {
  const was = useRef(open);
  useEffect(() => {
    if (open === was.current) return;
    was.current = open;
    cue(open ? "open" : "close");
  }, [open]);
}

/** In a menu, a list or a folder browser: an entry there chosen. */
const MENU_ENTRY = ".pop button, .sel-opt, .context-menu button, .own-folder-row, .folder-card";
/** What a press is heard on: a button, or what stands for one, and a switch or tick box. */
const PRESSABLE = "button, [role=button], a[href], .sel-opt, .own-folder-row, .folder-card, label, input[type=checkbox], input[type=radio]";
/** What opens a menu or list from where it sits (not an entry in one). */
const OPENER = ".sel-btn, .pop-anchor > button, .pop-anchor > .btn";
/** Buttons whose own sound is sorting's (moving, trashing, rating): no click besides. */
const OWN_SOUND = ".target-btn, .rating-seg, [data-own-sound]";

/** What a press on this will be heard as, the instant it happens; null for nothing. */
export function pressCue(el: Element): Cue | null {
  const at = el.closest(PRESSABLE);
  if (!at || (at as HTMLButtonElement).disabled || at.closest(OWN_SOUND)) return null;
  const box = at instanceof HTMLInputElement ? at : at instanceof HTMLLabelElement ? at.querySelector("input") : null;
  if (box && (box.type === "checkbox" || box.type === "radio")) return box.disabled ? null : "toggle";
  if (at instanceof HTMLLabelElement) return null;
  if (at.closest(MENU_ENTRY)) return "select";
  // A menu's button: it opens it, or (open) closes it.
  if (at.closest(OPENER) && !at.closest(".pop")) return document.querySelector(".pop, .sel-pop") ? "close" : "open";
  return "select";
}

/**
 * Listened to once, for the whole app. A press is heard the instant it goes down (not when it is let
 * go, nor once what it does has happened): a click for a button, an opening for a menu's button, a
 * flip for a switch. What the press then does (a menu or dialog opening, the switch changing) is
 * heard in it, not again. A key readies the audio; what keys do is heard as it happens.
 */
export function listenForSounds(): () => void {
  const onDown = (e: PointerEvent) => {
    ready();
    // A new press: whatever the last one did is over.
    pressedAt = -Infinity;
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const c = pressCue(e.target);
    if (c && shouldPlay(c, performance.now(), useSounds.getState())) {
      cue(c, true);
      pressedAt = performance.now();
    }
  };
  const onKey = () => ready();
  const onChange = (e: Event) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) cue("toggle");
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("change", onChange, true);
  return () => {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("change", onChange, true);
  };
}
