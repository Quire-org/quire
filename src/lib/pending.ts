/**
 * Saves that wait a moment before they write (a rating, a tag, a block moved on the Home): each
 * store debounces its own, and registers it here so that all of them can be written at once when
 * waiting would lose them: the library closing, another one opening, the window closing. Without
 * this, a rating pressed and ⌘Q a quarter second later was gone.
 */
export interface PendingSave {
  /** Write now what waits, if anything; cancels the timer. */
  flush(): Promise<void>;
  /** Drop what waits without writing (the library it belonged to is no longer open). */
  cancel(): void;
}

const saves = new Map<string, PendingSave>();

/** A store's pending save, by a name of its own; registering again replaces. */
export function registerPending(name: string, save: PendingSave) {
  saves.set(name, save);
}

/** Every waiting save written, each on its own so one failing doesn't stop the rest. */
export async function flushAll(): Promise<void> {
  await Promise.all([...saves.values()].map((s) => s.flush().catch(() => {})));
}

/** Every waiting save dropped (nothing written): for when the saves would go to the wrong library. */
export function cancelAll() {
  for (const s of saves.values()) s.cancel();
}

/**
 * A debounced save: `write` runs `ms` after the last `schedule()`, or at once on `flush()`. It is
 * given the root the change belonged to, so a save never lands in a library opened since.
 */
export function debounced(name: string, ms: number, write: (root: string) => Promise<void>): { schedule(root: string): void; flush(): Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let forRoot: string | null = null;
  let inFlight: Promise<void> | null = null;
  const fire = () => {
    timer = null;
    const root = forRoot;
    forRoot = null;
    if (!root) return inFlight ?? Promise.resolve();
    // One write at a time, in order: a later save never lands before an earlier one. The first
    // starts at once (a flush before a job runs has written by the time the job starts).
    const started = inFlight ? inFlight.then(() => write(root)) : write(root);
    const p: Promise<void> = started.catch(() => {}).finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };
  const save = {
    schedule(root: string) {
      if (timer) clearTimeout(timer);
      forRoot = root;
      timer = setTimeout(fire, ms);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      await fire();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      forRoot = null;
    },
  };
  registerPending(name, save);
  return save;
}
