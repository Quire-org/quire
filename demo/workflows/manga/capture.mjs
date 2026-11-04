// The manga reader's workflow video: albums read page by page, then a Japanese album read in English
// with the Manga Translate plugin (beside this checkout). Its pages are the plugin's own test pages,
// and the translation is the run recorded beside each (its `.answer.json`), played back as the
// engine would give it (see ../../kit.mjs; script.json puts it together). `npm run workflows -- manga`.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "../../kit.mjs";

const NEMO = "Albums/Little Nemo in Slumberland (1905)";
const MANGA = "Albums/Rooftop";

await capture({
  work: dirname(fileURLToPath(import.meta.url)),
  query: "&find=manga-translate",
  init: () => {
    const pages = ["rooftop", "street", "webtoon"];
    window.__demoFiles = pages.map((p, n) => ({ rel: `Albums/Rooftop/00${n + 1}.png`, from: `__plugin/manga-translate/test/pages/${p}.png` }));
    window.__demoEngine = async (args, src) => {
      if (!String(args.path).includes("/Albums/Rooftop/")) return null;
      const [page, answer] = await Promise.all([fetch(src).then((r) => r.arrayBuffer()), fetch(src.replace(/\.png$/, ".answer.json")).then((r) => r.json())]);
      const bytes = new Uint8Array(page);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const box = (b) => (b ? [b.left, b.top, b.right - b.left, b.bottom - b.top] : null);
      await new Promise((r) => setTimeout(r, 900));
      return {
        pngBase64: btoa(bin),
        width: answer.width,
        height: answer.height,
        result: { regions: answer.regions.map((r) => ({ source: r.original, translation: r.translation, text: box(r.text), balloon: box(r.balloon) })), model: "gemma4-e4b-it" },
        seconds: 0.9,
      };
    };
  },
  steps: async ({ page, act, settle, shot, middleOf }) => {
    const button = (name) => page.getByRole("button", { name }).first();
    const open = (key) =>
      page.evaluate(async (key) => {
        const s = (await import("/src/store.ts")).useStore.getState();
        await s.openAlbum(s.albums.find((a) => a.key === key || a.path?.endsWith(key)));
      }, key);

    console.log("albums");
    await page.evaluate(async ([nemo]) => {
      const s = (await import("/src/store.ts")).useStore.getState();
      s.setAlbumRatingByKey(nemo, 9);
      s.setAlbumRatingByKey("Albums/Pepper and Carrot 06 - The Potion Contest", 8);
    }, [NEMO]);
    await act("openAlbums");
    await settle(2000);
    await shot("albums", { click: await middleOf(page.locator(".album-card", { hasText: "Little Nemo" })) });
    await open(NEMO);
    await settle(1500);
    await shot("reader-1");
    for (const n of [2, 3]) {
      await page.keyboard.press("ArrowRight");
      await settle(900);
      await shot(`reader-${n}`, { key: "→" });
    }
    await page.keyboard.press("Escape");

    console.log("translate");
    // The plugin's models, as if downloaded (the mock pretends in a few seconds each).
    await page.evaluate(async () => {
      const { useEngine } = await import("/src/plugins/engine.ts");
      for (const id of ["manga-ocr", "hayai-ocr", "qwen3.5-4b", "gemma4-e4b-it", "gemma4-12b-it"]) await useEngine.getState().start(id).catch(() => {});
    });
    await open(MANGA);
    await settle(1500);
    // The viewer bar's Plugins menu, then Manga Translate in it.
    const plugins = page.locator(".plugin-btn").first();
    await shot("page-ja", { click: await middleOf(plugins) });
    await plugins.click();
    await settle(500);
    const translate = page.locator('.plugin-btn[title^="Manga Translate"]').first();
    await shot("menu", { click: await middleOf(translate) });
    await translate.click();
    await settle(1000);
    const english = page.locator(".pick-group button", { hasText: "English" }).first();
    await shot("panel", { click: await middleOf(english) });
    await english.click();
    await page.waitForTimeout(2500);
    await settle(800);
    console.log("   overlay boxes:", await page.locator("[class^=overlay-]").count());
    await shot("page-en");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(2500);
    await settle(800);
    await shot("page2-en", { key: "→" });
    await page.keyboard.press("o");
    await settle(800);
    await shot("page2-ja", { key: "O", note: "The original" });
    await page.keyboard.press("o");
    await settle(800);
    await shot("page2-back", { key: "O", note: "In English" });
  },
});
