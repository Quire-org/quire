import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { can, useJobs } from "../lib/jobs";
import { flushAll } from "../lib/pending";
import { useStore } from "../store";

/**
 * The vault locked itself as the app left the screen: nothing of the library shows until it is opened
 * again. `cameBack`: the app is back on the screen with it locked, and Face ID hasn't been asked yet.
 */
export const useLock = create<{ locked: boolean; cameBack: boolean }>(() => ({ locked: false, cameBack: false }));

/** The jobs paused as the app left the screen, to go on when it is back. */
let pausedOnLeaving: string[] = [];

function pauseJobs() {
  const jobs = useJobs.getState().jobs.filter((j) => !j.paused && can(j.pause));
  pausedOnLeaving = jobs.map((j) => j.id);
  for (const j of jobs) if (can(j.pause)) j.pause(true);
}

export function resumeJobs() {
  for (const j of useJobs.getState().jobs) if (pausedOnLeaving.includes(j.id) && can(j.pause)) j.pause(false);
  pausedOnLeaving = [];
}

async function left() {
  pauseJobs();
  const st = useStore.getState();
  if (!st.root || !st.vault?.exists || !st.vault.unlocked) return;
  useLock.setState({ locked: true });
  // What is still waiting to be saved goes into the vault: the backend locks it a moment later.
  await flushAll().catch(() => {});
}

async function back() {
  const st = useStore.getState();
  if (st.root && st.vault?.exists) {
    const vault = await api.vaultStatus(st.root).catch(() => null);
    if (vault) useStore.setState({ vault });
    if (vault && !vault.unlocked) return useLock.setState({ locked: true, cameBack: true });
  }
  resumeJobs();
}

/** Hear the app leave the screen and come back. */
export function watchApp() {
  const offs = [listen("app-left-screen", () => void left()), listen("app-back-on-screen", () => void back())];
  return () => offs.forEach((o) => void o.then((f) => f()));
}
