// What a demo's capture needs: Quire's browser preview in its demo mode (`?mock&demo`, the example
// library), run by the app's own Vite and the preview's file server, in Chrome (the installed one,
// or $CHROME), and a way to keep each step as a frame. Quire's own demo (capture.mjs) uses it, and
// so can a plugin's, from a checkout of Quire beside the plugin (the file server serves a plugin
// from the folder of its id there). The frames go in <work>/public/scenes, listed with what each
// step does (a key pressed, a click and where) in <work>/public/scenes.json, which the renderer
// (render.mjs) reads with <work>/script.json.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => import(pathToFileURL(join(repo, p)).href);

/** The window the app is shown in, in CSS pixels, captured at twice that. */
export const W = 1440;
export const H = 900;
const SCALE = 2;

/**
 * Runs `steps` against the preview opened with `query` (added to `?mock&demo`, such as
 * `&find=<plugin id>`), keeping what they `shot` in `work`'s public folder.
 */
export async function capture({ work, query = "", look = { theme: "midnight", mode: "dark" }, steps }) {
  const out = join(work, "public", "scenes");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Quire's mark, in the app icon's neutral colours, for the video's title and end.
  const mark = readFileSync(join(repo, "src/assets/app-icon.svg"), "utf8").replace(/<!--[\s\S]*?-->\s*/g, "");
  writeFileSync(join(work, "public", "mark.svg"), mark.replaceAll("{{bg}}", "#14161c").replaceAll("{{ink}}", "#e8eaf0"));

  const { startFileServer } = await load("e2e/server.mjs");
  const { createServer } = await load("node_modules/vite/dist/node/index.js");
  const { chromium } = await load("node_modules/playwright-core/index.mjs");
  const files = await startFileServer();
  const vite = await createServer({ root: repo, logLevel: "error", server: { port: 5199, strictPort: true, host: "127.0.0.1", hmr: false } });
  await vite.listen();
  const chrome =
    process.env.CHROME ??
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ].find((p) => existsSync(p));
  if (!chrome) throw new Error("Chrome wasn't found: set CHROME to its path");
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  page.on("pageerror", (e) => console.error("page error:", e.message));

  /** Each frame: its file, and what happens on the way to it (a key, a click). */
  const frames = [];
  const t = {
    page,
    /** A store action in the page, by name, with its arguments. */
    act: (name, ...args) => page.evaluate(async ([name, args]) => (await import("/src/store.ts")).useStore.getState()[name](...args), [name, args]),
    /** Every picture on screen loaded, then a moment for the layout to settle. */
    async settle(ms = 700) {
      await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 30000 }).catch(() => console.warn("some pictures didn't load"));
      await page.waitForTimeout(ms);
    },
    async shot(id, extra = {}) {
      await page.screenshot({ path: join(out, `${id}.png`) });
      frames.push({ id, file: `scenes/${id}.png`, width: page.viewportSize().width, height: page.viewportSize().height, ...extra });
      console.log("  ", id);
    },
    /** Where a click lands on the first element matching: its middle, in window pixels. */
    async middleOf(locator) {
      const b = await locator.first().boundingBox();
      return b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null;
    },
    async look({ theme, mode }) {
      await t.act("setTheme", theme);
      await t.act("setThemeMode", mode);
      await page.waitForTimeout(400);
    },
    /** The box that scrolls around the first element matching, in window pixels: a video scrolls only that. */
    gridOf: (selector) =>
      page.evaluate((selector) => {
        let el = document.querySelector(selector);
        while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
        const r = el?.getBoundingClientRect();
        return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
      }, selector),
    /** The screen as a taller window shows it, for a video to scroll through. */
    async tall(id, times = 2.6, ms = 2500) {
      await page.setViewportSize({ width: W, height: Math.round(H * times) });
      await t.settle(ms);
      await t.shot(id);
      await page.setViewportSize({ width: W, height: H });
    },
  };

  try {
    await page.goto(`http://127.0.0.1:5199/?mock&demo${query}`);
    await page.waitForSelector(".brand-home", { state: "attached", timeout: 60000 });
    await t.look(look);
    await steps(t);
  } finally {
    writeFileSync(join(work, "public", "scenes.json"), JSON.stringify({ scale: SCALE, frames }, null, 1));
    await browser.close();
    await vite.close();
    files.close();
  }
  console.log(`${frames.length} frames in ${join(work, "public", "scenes")}`);
}
