// The reference collector's workflow video: hand references looked for on Pinterest in Find (its
// plugin beside this checkout, on its made-up site, where a search for hands finds old drawings of
// them), two kept and brought in with Import, pinned to a board with a note and an arrow, and the
// board in a window of its own above other apps (see ../../kit.mjs; script.json puts it together).
// `npm run workflows -- references`.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "../../kit.mjs";

await capture({
  work: dirname(fileURLToPath(import.meta.url)),
  query: "&find=pinterest-find",
  steps: async ({ page, settle, shot, middleOf }) => {
    const button = (name) => page.getByRole("button", { name }).first();
    const side = (name) => page.locator(".side-list button", { hasText: name }).first();

    console.log("search");
    await page.evaluate(async () => {
      const { useFinders } = await import("/src/plugins/find.ts");
      for (let i = 0; i < 80 && !useFinders.getState().finders["pinterest-find"]; i++) await new Promise((r) => setTimeout(r, 250));
      (await import("/src/findStore.ts")).useFind.getState().choose("pinterest-find");
      (await import("/src/store.ts")).useStore.getState().openFind();
    });
    const box = page.locator(".find-query input");
    await box.waitFor({ timeout: 30000 });
    await settle(1500);
    await box.click();
    await box.fill("hand pose reference");
    await shot("search-typed");
    await box.press("Enter");
    await page.waitForSelector(".find-tile", { timeout: 30000 });
    await settle(3000);
    await shot("search", { key: "⏎" });

    console.log("keep");
    // The clasped hands and the open right hand: looked at closer, into the basket.
    for (const [i, n] of [3, 1].entries()) {
      await page.locator(".find-tile").nth(n).click();
      await page.keyboard.press("Enter");
      await page.waitForSelector(".find-preview", { timeout: 15000 });
      await settle(2200);
      const into = page.locator(".find-preview button", { hasText: "Into the basket" });
      if (i === 0) await shot("pin", { click: await middleOf(into) });
      await into.click();
      await settle(700);
      if (i === 0) await shot("pin-basket");
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
        // Done: the dialog closed, so it isn't over what comes next.
        await page.locator(".modal button", { hasText: /^Close$/ }).click();
        await settle(500);
        break;
      }
      await go.click();
    }

    console.log("board");
    // A new board; the two drawings taken from the library on its left, where they are the newest.
    const brought = await page.evaluate(async () => {
      const { useStore } = await import("/src/store.ts");
      await useStore.getState().loadAll();
      await (await import("/src/scrapbook/store.ts")).useScrapbook.getState().newBoard("Hands", { w: 1920, h: 1080 });
      return useStore.getState().allItems.filter((i) => i.key.startsWith("References/")).map((i) => i.key);
    });
    await settle(2000);
    // The folder Import brought them into, picked above the library's pictures.
    const dir = brought[0].slice(0, brought[0].lastIndexOf("/"));
    await page.locator(".scrap-add .mini-head .sel-btn").click();
    await page.locator(".sel-opt", { hasText: dir }).last().click();
    await settle(1500);
    const tile = (n) => page.locator(`.scrap-add .mini-tile[title^="${dir}/"] .mini-pick`).nth(n);
    const first = tile(0);
    await first.waitFor({ timeout: 15000 });
    await shot("board-empty", { click: await middleOf(first) });
    await first.click();
    await settle(1500);
    const second = tile(1);
    await shot("board-one", { click: await middleOf(second) });
    await second.click();
    await settle(1500);
    // Put where they go, with a note and an arrow from it.
    await page.evaluate(async () => {
      const { useScrapbook } = await import("/src/scrapbook/store.ts");
      const st = useScrapbook.getState();
      const spots = [
        { x: 0.3, y: 0.42, rot: -3, w: 0.27 },
        { x: 0.66, y: 0.44, rot: 2, w: 0.22 },
      ];
      st.change((d) => ({
        ...d,
        layers: [
          ...d.layers.map((l, i) => ({ ...l, ...spots[i] })),
          { id: "arrow", type: "arrow", color: "#e5484d", thickness: 0.006, heads: "end", x: 0.47, y: 0.79, w: 0.12, rot: -32 },
          { id: "note", type: "note", text: "Knuckles sit on a curve: draw the arc first", paper: "#fff3a8", fix: { kind: "tape", where: "one" }, x: 0.31, y: 0.8, w: 0.17, rot: -2 },
        ],
      }));
      st.type("note");
    });
    await settle(1500);
    await shot("board-note");
    await page.evaluate(async () => (await import("/src/scrapbook/store.ts")).useScrapbook.getState().type(null));
    await settle(800);
    await shot("board");

    console.log("window");
    // Its own window, as the board's Own window opens it: shown over the app here (the preview keeps the board in this page only).
    await page.evaluate(async () => {
      const { useStore } = await import("/src/store.ts");
      const { useScrapbook } = await import("/src/scrapbook/store.ts");
      const id = useScrapbook.getState().editing.doc.id;
      await useScrapbook.getState().done();
      // The same React the app runs (its address as Vite gives it to the app's own modules).
      const dep = async (file, name) => (await (await fetch(file)).text()).match(new RegExp(`"(/node_modules/\\.vite/deps/${name}\\.js\\?v=\\w+)"`))[1];
      const R = await import(await dep("/src/screens/BoardWindow.tsx", "react"));
      const D = await import(await dep("/src/main.tsx", "react-dom_client"));
      const React = R.createElement ? R : R.default;
      const createRoot = D.createRoot ?? D.default.createRoot;
      const { BoardWindow } = await import("/src/screens/BoardWindow.tsx");
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;inset:0;z-index:99999";
      document.body.appendChild(el);
      createRoot(el).render(React.createElement(BoardWindow, { id, root: useStore.getState().root }));
    });
    await settle(3000);
    await shot("board-window");
  },
});
