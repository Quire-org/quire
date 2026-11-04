// The reference collector's workflow video: Find with the Pixiv plugin (beside this checkout, on its
// made-up site), works into the basket and through Import, the artist suggested from them, and the
// library's tags made on this computer (see ../../kit.mjs; script.json puts it together).
// `npm run workflows -- references`.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "../../kit.mjs";

await capture({
  work: dirname(fileURLToPath(import.meta.url)),
  query: "&find=pixiv-find",
  steps: async ({ page, act, settle, shot, middleOf, gridOf, tall }) => {
    const button = (name) => page.getByRole("button", { name }).first();
    const side = (name) => page.locator(".side-list button", { hasText: name }).first();

    console.log("find");
    await page.evaluate(async () => {
      const { useFinders } = await import("/src/plugins/find.ts");
      for (let i = 0; i < 80 && !useFinders.getState().finders["pixiv-find"]; i++) await new Promise((r) => setTimeout(r, 250));
      (await import("/src/findStore.ts")).useFind.getState().choose("pixiv-find");
      (await import("/src/store.ts")).useStore.getState().openFind();
    });
    const signIn = page.locator("button", { hasText: "Sign in to" });
    await signIn.waitFor({ timeout: 30000 });
    await signIn.click();
    await page.waitForSelector(".find-tile", { timeout: 30000 });
    await settle(2500);
    await shot("feed", { grid: await gridOf(".find-tile") });
    await tall("feed-tall");

    console.log("basket");
    for (const n of [0, 1]) {
      await page.locator(".find-tile").nth(n).click();
      await page.keyboard.press("Enter");
      await page.waitForSelector(".find-preview", { timeout: 15000 });
      await settle(1800);
      const into = page.locator(".find-preview button", { hasText: "Into the basket" });
      if (n === 0) await shot("work", { click: await middleOf(into) });
      await into.click();
      await settle(700);
      if (n === 0) await shot("work-basket");
      await page.keyboard.press("Escape");
      await settle(500);
    }
    await side("Basket").click();
    await settle(2000);
    await page.locator('.find-pickbar button[title^="Choose all"]').click();
    await settle(600);
    const pull = button(/^Import/);
    await shot("basket", { click: await middleOf(pull) });
    await pull.click();
    // Import: the first bucket named (the demo's library has none yet), then through its steps to the files coming in.
    const bucket = page.locator('.modal input[placeholder^="Name the first bucket"]');
    await bucket.waitFor({ timeout: 15000 });
    await bucket.fill("References");
    await page.locator(".modal button", { hasText: "Add" }).click();
    await settle(800);
    await shot("import-where");
    for (let i = 0; i < 5; i++) {
      await settle(1500);
      const go = page.locator(".modal .btn.primary").first();
      if (!(await go.isVisible().catch(() => false))) break;
      const label = (await go.textContent()) ?? "";
      if (/^Import \d/.test(label.trim())) {
        await shot("import", { click: await middleOf(go) });
        await go.click();
        await settle(2000);
        break;
      }
      await go.click();
    }

    console.log("artists");
    await act("openArtists");
    await settle(2000);
    const make = button(/Make them an artist/);
    await shot("artists", { click: await middleOf(make) });
    await make.evaluate((b) => b.click());
    await settle(2500);
    await shot("artist");

    console.log("tags");
    await act("openTags");
    await settle(1500);
    await page.evaluate(async () => (await import("/src/tagsStore.ts")).useTags.getState().setFilter("style/digital-painting"));
    await settle(2500);
    await shot("tag");
    await act("openBrowse");
    await act("setBrowseFilters", { layout: "masonry", zoom: 250, sortBy: "name", tags: ["style/concept-art", "style/character-sheet"], tagsMode: "or" });
    await settle(2000);
    await shot("browse-tags");
  },
});
