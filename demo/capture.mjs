// Captures Quire's browser preview in its demo mode (`?mock&demo`: the example library) step by
// step, as the frames the demo video and the README's screenshots are made of: public/scenes/*.png,
// and public/scenes.json listing them with what each step does (a key pressed, a click and where).
// The app's own Vite and the preview's file server run for it; Chrome is the one installed (or
// $CHROME). `npm run capture`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const load = (p) => import(pathToFileURL(join(repo, p)).href);
const { startFileServer } = await load("e2e/server.mjs");
const { createServer } = await load("node_modules/vite/dist/node/index.js");
const { chromium } = await load("node_modules/playwright-core/index.mjs");

/** The window the app is shown in, in CSS pixels, captured at twice that. */
const W = 1440;
const H = 900;
const SCALE = 2;
const LOOK = { theme: "midnight", mode: "dark" };
/** Other looks, for the themes part. */
const LOOKS = [
  { theme: "cp2077", mode: "dark" },
  { theme: "cozy", mode: "light" },
  { theme: "manga", mode: "light" },
  { theme: "gallery", mode: "dark" },
];

const out = join(here, "public", "scenes");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The mark, in the app icon's neutral colours, for the video's title and end.
const mark = readFileSync(join(repo, "src/assets/app-icon.svg"), "utf8").replace(/<!--[\s\S]*?-->\s*/g, "");
writeFileSync(join(here, "public", "mark.svg"), mark.replaceAll("{{bg}}", "#14161c").replaceAll("{{ink}}", "#e8eaf0"));

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

/** A store action in the page, by name, with its arguments. */
const act = (name, ...args) => page.evaluate(async ([name, args]) => (await import("/src/store.ts")).useStore.getState()[name](...args), [name, args]);
/** Every picture on screen loaded, then a moment for the layout to settle. */
async function settle(ms = 700) {
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 30000 }).catch(() => console.warn("some pictures didn't load"));
  await page.waitForTimeout(ms);
}
async function shot(id, extra = {}) {
  await page.screenshot({ path: join(out, `${id}.png`) });
  frames.push({ id, file: `scenes/${id}.png`, width: page.viewportSize().width, height: page.viewportSize().height, ...extra });
  console.log("  ", id);
}
/** Where a click lands on the first element matching: its middle, in window pixels. */
async function middleOf(locator) {
  const b = await locator.first().boundingBox();
  return b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null;
}
async function look({ theme, mode }) {
  await act("setTheme", theme);
  await act("setThemeMode", mode);
  await page.waitForTimeout(400);
}

try {
  await page.goto("http://127.0.0.1:5199/?mock&demo");
  await page.waitForSelector(".brand-home", { state: "attached", timeout: 60000 });
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await look(LOOK);

  console.log("home");
  await act("openHome");
  await page.evaluate(async () => {
    const { useHome } = await import("/src/home/store.ts");
    await new Promise((r) => setTimeout(r, 500));
    const h = useHome.getState();
    if (!h.doc?.blocks.length) h.start("gallery");
    // The slideshow and the one picture from the photos and the art, so they show something whole.
    for (const b of useHome.getState().doc.blocks) {
      if (b.type === "slideshow") h.updateBlock(b.id, { filter: { folders: ["Photos"] } });
      if (b.type === "picture") h.updateBlock(b.id, { filter: { folders: ["Artworks"] } });
    }
  });
  await settle(2500);
  await shot("home");

  console.log("sort");
  await act("openSortQueue");
  await settle(1200);
  await shot("sort-1");
  await page.keyboard.press("9");
  await settle(500);
  await shot("sort-2", { key: "9", note: "Rated 9" });
  await page.keyboard.press("j");
  await settle(1200);
  await shot("sort-3", { key: "J", note: "Into Photos" });

  console.log("browse");
  await act("openBrowse");
  await page.evaluate(async () => {
    const { useStore } = await import("/src/store.ts");
    const s = useStore.getState();
    s.set({ browseFilters: { ...s.browseFilters, layout: "masonry", zoom: 250, sortBy: "name", tags: [] } });
  });
  await settle(2000);
  // Where the grid scrolls, inside the window: the video scrolls only that, under the bars and the sidebar.
  const grid = await page.evaluate(() => {
    let el = document.querySelector(".mtile");
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    const r = el?.getBoundingClientRect();
    return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
  await shot("browse", { grid });
  // Taller, for the video to scroll through.
  await page.setViewportSize({ width: W, height: H * 2.6 });
  await settle(2500);
  await shot("browse-tall");
  await page.setViewportSize({ width: W, height: H });
  await page.evaluate(async () => {
    const { useStore } = await import("/src/store.ts");
    const s = useStore.getState();
    s.set({ browseFilters: { ...s.browseFilters, tags: ["series/pepper-and-carrot"] } });
  });
  await settle(2000);
  await shot("browse-tags", { note: "series/pepper-and-carrot" });
  await page.evaluate(async () => {
    const { useStore } = await import("/src/store.ts");
    const s = useStore.getState();
    s.set({ browseFilters: { ...s.browseFilters, tags: [] } });
  });

  console.log("albums");
  await act("openAlbums");
  await settle(2000);
  const card = page.locator(".album-card", { hasText: "Pepper and Carrot 06" });
  await shot("albums", { click: await middleOf(card) });
  await page.evaluate(async () => {
    const { useStore } = await import("/src/store.ts");
    const s = useStore.getState();
    const album = s.albums.find((a) => a.name.includes("Pepper and Carrot 06"));
    await s.openAlbum(album);
  });
  await settle(1500);
  await shot("reader-1");
  for (const n of [2, 3]) {
    await page.keyboard.press("ArrowRight");
    await settle(900);
    await shot(`reader-${n}`, { key: "→" });
  }
  await page.keyboard.press("Escape");

  console.log("tags");
  await act("openTags");
  await settle(2500);
  await shot("tags");

  console.log("files");
  await act("openFiles");
  await settle(2000);
  await shot("files");

  console.log("looks");
  await act("openHome");
  for (const l of LOOKS) {
    await look(l);
    await settle(900);
    await shot(`look-${l.theme}-${l.mode}`, { note: `${l.theme} ${l.mode}` });
  }
  await look(LOOK);
} finally {
  writeFileSync(join(here, "public", "scenes.json"), JSON.stringify({ scale: SCALE, frames }, null, 1));
  await browser.close();
  await vite.close();
  files.close();
}
console.log(`${frames.length} frames in public/scenes`);
