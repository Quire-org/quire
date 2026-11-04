// The photographer's workflow video: a shoot culled in Sort with single keys, look-alikes kept as a
// series, duplicates weeded out, an edit with the original kept and Revert, the best of it in Browse
// (see ../../kit.mjs; script.json puts it together). `npm run workflows -- photographer`.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "../../kit.mjs";

/** The keys pressed in Sort, in turn: what each is called on its keycap, and what it did. */
const CULL = [
  ["8", "8", "Rated 8"],
  ["j", "J", "Into Photos"],
  ["Backspace", "⌫", "Into the trash"],
  ["9", "9", "Rated 9"],
  ["j", "J", "Into Photos"],
];

await capture({
  work: dirname(fileURLToPath(import.meta.url)),
  steps: async ({ page, act, settle, shot, middleOf }) => {
    const button = (name) => page.getByRole("button", { name }).first();

    console.log("cull");
    await act("openSortQueue");
    await settle(1200);
    await shot("cull-0");
    for (const [n, [press, key, note]] of CULL.entries()) {
      await page.keyboard.press(press);
      await settle(800);
      await shot(`cull-${n + 1}`, { key, note });
    }

    console.log("series");
    await shot("series-1", { click: await middleOf(button(/Keep as a series/)) });
    await button(/Keep as a series/).click();
    await settle(900);
    await shot("series-2");

    console.log("duplicates");
    await act("openDupes");
    await settle(1200);
    if (await button(/Scan for duplicates/).isVisible().catch(() => false)) {
      await button(/Scan for duplicates/).click();
      await page.waitForTimeout(2500);
    }
    await settle(1000);
    await shot("dupes-1", { click: await middleOf(button("Keep this")) });
    await button("Keep this").click();
    await settle(1200);
    await shot("dupes-2");

    console.log("edit");
    await page.evaluate(async () => {
      const { useStore } = await import("/src/store.ts");
      const s = useStore.getState();
      const photos = s.allItems.filter((i) => i.dir === "Photos").sort((a, b) => a.name.localeCompare(b.name));
      s.openViewer(photos, photos.findIndex((i) => i.name === "geiranger-fjord"), { kind: "browse" });
    });
    await settle(1200);
    await page.keyboard.press("t");
    await settle(800);
    await shot("edit-1", { key: "T", note: "Edit" });
    await page.evaluate(async () => {
      const { useEdit } = await import("/src/editStore.ts");
      useEdit.getState().setState({ cropping: true });
      useEdit.getState().set({ crop: [0.14, 0.08, 0.72, 0.84] });
    });
    await settle(700);
    await shot("edit-2");
    await page.evaluate(async () => (await import("/src/editStore.ts")).useEdit.getState().setState({ cropping: false }));
    await settle(300);
    await shot("edit-3", { click: await middleOf(button(/Overwrite/)) });
    await button(/Overwrite/).click();
    await settle(1800);
    await shot("edit-4");
    await page.keyboard.press("i");
    await settle(1200);
    await button(/Revert/).scrollIntoViewIfNeeded().catch(() => {});
    await settle(400);
    await shot("edit-5", { key: "I", note: "Info", click: await middleOf(button(/Revert/)) });
    await button(/Revert/).click();
    await settle(1500);
    await shot("edit-6");
    await page.keyboard.press("i");
    await page.keyboard.press("Escape");

    console.log("best");
    await act("openBrowse");
    await act("setBrowseFilters", { minRating: 8, sortBy: "rating", tags: [] });
    await settle(2000);
    await shot("best");
  },
});
