import { afterAll, vi } from "vitest";

// Work a test set off without waiting for it (a move followed into the tags through a lazy import,
// a scan's reconciling) finishes before the file's modules are torn down, or it fails on them.
afterAll(async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 10));
    await vi.dynamicImportSettled();
  }
});
