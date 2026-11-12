import { useEffect } from "react";
import { api } from "./api";
import { IS_MOBILE } from "./platform";

/** A swipe from one video with sound to the next isn't an end: this long without one, and the music comes back. */
const GIVE_BACK_MS = 1000;

const webviewAudio = () => (navigator as Navigator & { audioSession?: { type: string } }).audioSession;

/** Nothing the webview starts, a muted video making a poster or the app's small sounds, stops other apps' audio. */
export function leaveOtherAudioAlone() {
  const session = webviewAudio();
  if (session) session.type = "ambient";
}

let holding = false;
let givingBack: ReturnType<typeof setTimeout> | null = null;

function hold() {
  if (givingBack) clearTimeout(givingBack);
  givingBack = null;
  const session = webviewAudio();
  if (session) session.type = "playback";
  if (holding) return;
  holding = true;
  void api.iosHoldOtherAudio(true).catch(() => {});
}

/** The webview lets go at once: a video only just opened takes it a moment, and music told to go on
 * while the webview still has the audio can't. */
function release() {
  leaveOtherAudioAlone();
  givingBack = setTimeout(() => {
    givingBack = null;
    holding = false;
    void api.iosHoldOtherAudio(false).catch(() => {});
  }, GIVE_BACK_MS);
}

/** On a phone or tablet, while `on` (a video with sound, not muted, on the screen) it has the audio, and other apps get theirs back after. */
export function useVideoSound(on: boolean) {
  useEffect(() => {
    if (!IS_MOBILE || !on) return;
    hold();
    return release;
  }, [on]);
}
