import { describe, expect, it, vi } from "vitest";
import { cancelAll, debounced, flushAll } from "../lib/pending";

describe("saves that wait a moment", () => {
  it("write once after the last change, for the library the change belonged to, and at once on flush", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const save = debounced("t1", 100, async (root) => void writes.push(root));
    save.schedule("/a");
    save.schedule("/a");
    expect(writes).toEqual([]);
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(writes).toEqual(["/a"]);
    save.schedule("/b");
    await save.flush();
    expect(writes).toEqual(["/a", "/b"]);
    // Nothing waiting: a flush writes nothing.
    await save.flush();
    expect(writes).toEqual(["/a", "/b"]);
    vi.useRealTimers();
  });

  it("writes in order, never a later save before an earlier one still under way", async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const save = debounced("t2", 10, async (root) => {
      if (root === "/slow") await new Promise<void>((r) => (release = r));
      order.push(root);
    });
    save.schedule("/slow");
    const first = save.flush();
    save.schedule("/fast");
    const second = save.flush();
    expect(order).toEqual([]);
    release!();
    await first;
    await second;
    expect(order).toEqual(["/slow", "/fast"]);
  });

  it("starts the first write at once on flush (what a job reads right after is written)", async () => {
    let written = false;
    const save = debounced("t3", 10, async () => void (written = true));
    save.schedule("/a");
    void save.flush();
    expect(written).toBe(true);
  });

  it("flushes every store's pending save together, and cancel drops them unwritten", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const a = debounced("fa", 50, async (root) => void writes.push(`a:${root}`));
    const b = debounced("fb", 50, async (root) => void writes.push(`b:${root}`));
    a.schedule("/x");
    b.schedule("/x");
    await flushAll();
    expect(writes.sort()).toEqual(["a:/x", "b:/x"]);
    a.schedule("/y");
    cancelAll();
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(writes).toHaveLength(2);
    vi.useRealTimers();
  });
});
