// End-to-end tests: the app in Chrome against its browser mock (made-up pictures and data, nothing
// real), through every screen at two window sizes in a dark and a light theme. Each screen is
// checked for anything spilling where it shouldn't (e2e/overflow.js) and saved as a screenshot in
// e2e/out to look over; the features that need it are used and checked too. `npm run e2e`, or
// `npm run e2e -- people` for the scenes whose name has "people" in it. Chrome is the one installed
// (CHROME to name another).
//
// The size-and-theme passes run side by side, a few at a time (E2E_PARALLEL, 2 to 4), each in a
// browser context of its own against the one Vite server, with a folder of its own in e2e/out. The
// features are used and checked on the first pass only; the others walk the same screens for their
// overflow check and screenshot. `--smoke` (or E2E_SMOKE=1) runs that first pass alone.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { startFileServer } from "./server.mjs";
import { findOverflow } from "./overflow.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(repo, "e2e", "out");
// Find's scenes need a Find plugin beside this repository that brings a made-up site for the tests
// (its test/fake-site.js, with the `examples` on it the tests use: a plugin's own test fakes are no
// such site): the folder E2E_FIND names, else the first such plugin found there.
const FIND =
  process.env.E2E_FIND ||
  readdirSync(join(repo, "..")).find((d) => {
    const dir = join(repo, "..", d);
    try {
      const site = join(dir, "test", "fake-site.js");
      return existsSync(site) && /export const examples\b/.test(readFileSync(site, "utf8")) && JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).permissions?.includes("find");
    } catch {
      return false;
    }
  });
if (!FIND) console.log("No Find plugin with a made-up site (test/fake-site.js) beside this repository: Find's scenes will fail.");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const smoke = args.includes("--smoke") || process.env.E2E_SMOKE === "1";
const only = args.find((a) => !a.startsWith("--")) ?? "";
const SIZES = [
  [1440, 900],
  [1100, 720],
];
const THEMES = ["cp2077", "gallery"];
// The first pass, at the first size in the first theme, is the one that uses the features. The
// first size runs dark and the second light, so each theme is seen in both its modes.
const passes = SIZES.flatMap(([w, h], i) => THEMES.map((theme) => ({ w, h, theme, mode: i === 0 ? "dark" : "light" }))).slice(0, smoke ? 1 : undefined);
const PARALLEL = Math.min(4, Math.max(2, Number(process.env.E2E_PARALLEL) || 3));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A moment for a screen's animations (a panel sliding in, a tile fading) before its screenshot.
const SETTLE = 300;

/** Keys, one after another, as the person at the keyboard would. */
async function press(page, ...keys) {
  for (const k of keys) {
    await page.keyboard.press(k);
    await wait(150);
  }
}
const textOf = (page, sel) => page.locator(sel).first().innerText().catch(() => "");
/** Whether `sel` shows within `ms` (Playwright's `:has-text()` can name the text it should carry). */
const shows = (page, sel, ms = 10000) => page.locator(sel).first().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
/** Whether nothing matching `sel` shows any more within `ms`. */
const gone = (page, sel, ms = 10000) => page.locator(sel).first().waitFor({ state: "hidden", timeout: ms }).then(() => true, () => false);
/** Whether `fn`, run in the page with `arg`, comes true within `ms` (asked every tenth of a second). */
async function until(page, fn, arg, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(fn, arg).catch(() => false)) return true;
    if (Date.now() > end) return false;
    await wait(100);
  }
}
/** How many `sel` there are once there are `n` of them (or as many as there are when `ms` is up). */
async function countOf(page, sel, n, ms = 10000) {
  await until(page, ([s, k]) => document.querySelectorAll(s).length === k, [sel, n], ms);
  return page.locator(sel).count();
}
const picturesOf = async (page) => Number((await textOf(page, ".banner-line")).match(/(\d+) picture/i)?.[1]);

/**
 * The scenes, in order: each gets the app where the last one left it, with `t` for the pass it runs
 * in: `t.check(ok, what)` notes a failed check, `t.shot(name)` saves a screenshot along the way, and
 * `t.full` says whether this is the pass that uses the features (the others walk the screens for
 * their overflow check and screenshot, and leave a scene once the screen is reached).
 */
const scenes = [
  ["sort", async (page) => press(page, "Escape")],
  ["browse", async (page) => press(page, "Escape", "b")],
  [
    "browse-selection",
    async (page, t) => {
      for (let i = 0; i < 3; i++) await page.locator(".browse .thumb").nth(i).click({ modifiers: ["Meta"] });
      await shows(page, ".selection-bar");
      if (!t.full) return;
      t.check((await textOf(page, ".selection-bar")).includes("3 selected"), "Browse: three picked show as 3 selected");
    },
  ],
  [
    "browse-artist-picker",
    async (page, t) => {
      await page.locator(".selection-bar button", { hasText: "Artist" }).click();
      t.check(await shows(page, ".artist-picker"), "Browse: Artist… opens the picker");
    },
  ],
  ["nav-menu", async (page) => (await press(page, "Escape", "Escape"), await page.locator(".nav-group").click())],
  ["albums", async (page) => press(page, "Escape", "a")],
  ["files", async (page) => press(page, "e")],
  ["duplicates", async (page) => press(page, "d")],
  ["tags", async (page) => press(page, "l")],
  [
    "tags-suggestions",
    async (page, t) => {
      await page.locator(".tag-folder .tag-chip", { hasText: /^sea\d+$/ }).click();
      await page.locator(".tags-side button", { hasText: "Check suggestions" }).click();
      t.check(await shows(page, ".tags-tile.suggested"), "Tags: a tag's view shows suggestions");
      await page.evaluate(() => (document.querySelector(".tags-grid").scrollTop = 500));
      if (!t.full) return;
      const bar = page.locator(".tags-seen-bar button", { hasText: "down to here" });
      if (!t.check(await shows(page, ".tags-seen-bar button:has-text('down to here')"), "Tags: the suggestions scrolled past can be said yes to at once")) return;
      const carrying = () => page.evaluate(() => import("/src/tagsStore.ts").then((m) => Object.values(m.useTags.getState().data.tags).filter((t) => t.includes("motives/sea")).length));
      const carries = (k) => until(page, (k) => import("/src/tagsStore.ts").then((m) => Object.values(m.useTags.getState().data.tags).filter((t) => t.includes("motives/sea")).length === k), k);
      const before = await carrying();
      // The count on the button grows while tiles sit on screen (seen after half a second), so the
      // number to hold the app to is the one it says it tagged, read after the click.
      await bar.click();
      if (!t.check(await shows(page, ".tags-seen-bar:has-text('tagged')"), "Tags: saying yes to them says how many were tagged")) return;
      const n = Number((await page.locator(".tags-seen-bar").innerText()).match(/(\d+) tagged/)?.[1]);
      t.check(n > 0 && (await carries(before + n)), "Tags: the ones said yes to carry the tag");
      await page.locator(".tags-seen-bar button", { hasText: "Undo" }).click();
      t.check(await carries(before), "Tags: Undo takes the yes back");
      await page.evaluate(() => (document.querySelector(".tags-grid").scrollTop = 500));
      await wait(SETTLE);
    },
  ],
  [
    "tags-back",
    async (page, t) => {
      const was = await page.evaluate(() => document.querySelector(".tags-grid").scrollTop);
      await page.locator(".tags-tile").nth(9).dblclick();
      await shows(page, ".hud-left button.accent2");
      if (t.full) t.check((await page.locator(".hud-left button.accent2").getAttribute("title"))?.includes("Back to Tags"), "Viewer: opened from Tags, back says Tags");
      await press(page, "Escape");
      const back = await shows(page, ".tags-grid");
      if (!t.full) return;
      t.check(back, "Viewer: back goes to the tag's pictures");
      t.check(was > 0 && Math.abs((await page.evaluate(() => document.querySelector(".tags-grid").scrollTop)) - was) < 3, "Viewer: back to the tag's pictures where they were scrolled");
    },
  ],
  [
    "people",
    async (page, t) => {
      await press(page, "Escape", "p");
      t.check(await shows(page, ".who"), "People: Who is this? shows a group");
      if (!t.full) return;
      await shows(page, ".roster-person:has-text('Lena') .roster-doubts");
      t.check((await textOf(page, ".roster-person:has-text('Lena') .roster-doubts")).toLowerCase().includes("1 to check"), "People: a face given someone unlike their others shows as one to check");
    },
  ],
  [
    "people-check",
    async (page, t) => {
      await page.locator(".who-check").click();
      await shows(page, ".who-check-face");
      if (!t.full) return;
      const unsure = page.locator(".who-check-face.unsure");
      t.check((await unsure.count()) >= 1, "People: the face less like the rest is marked less sure");
      await unsure.first().click();
      t.check(await shows(page, ".who-check-face.out"), "People: a face can be left out of the group");
    },
  ],
  [
    "people-named",
    async (page, t) => {
      if (!t.full) return;
      await page.locator(".who-actions button", { hasText: /Name|Someone else/ }).first().click();
      await page.keyboard.type("Ines");
      await press(page, "Enter");
      t.check(await shows(page, ".roster-person:has-text('Ines')"), "People: naming a group makes the person");
      t.check((await page.locator(".roster-person", { hasText: "Ines" }).count()) === 1, "People: naming a group makes one person");
    },
  ],
  [
    "people-from-tags",
    async (page, t) => {
      if (!t.full) return;
      const kaiTags = () => page.evaluate(() => import("/src/tagsStore.ts").then((m) => Object.values(m.useTags.getState().data.tags).filter((t) => t.includes("people/kai_ito")).length));
      const before = await kaiTags();
      if (!t.check(before > 2, "People: the made-up library has a person's tag to convert")) return;
      await page.locator(".people-body button", { hasText: "From tags" }).click();
      await page.locator(".modal button", { hasText: /^Make 1 person$/ }).click();
      t.check(await shows(page, ".roster-person:has-text('kai ito')"), "People from tags: a tag makes a person");
      t.check((await page.locator(".roster-person", { hasText: "kai ito" }).count()) === 1, "People from tags: a tag makes one person");
      t.check((await kaiTags()) === 0, "People from tags: the tags go");
      t.check((await textOf(page, ".roster-person:has-text('kai ito') .roster-doubts")).toLowerCase().includes("1 to check"), "People from tags: the tagged picture with someone else's face is one to check");
      t.check((await textOf(page, ".convert-bar")).includes("like none of the others"), "People from tags: the bar says some faces are to check");
      await t.shot("people-converted");
      await page.locator(".convert-bar button", { hasText: "Undo the conversion" }).click();
      t.check(await gone(page, ".roster-person:has-text('kai ito')"), "People from tags: undone, the person goes");
      t.check((await kaiTags()) === before, "People from tags: undone, every tag is back");
    },
  ],
  [
    "person",
    async (page, t) => {
      await page.locator(".roster-person", { hasText: "Lena" }).click();
      t.check(await shows(page, ".person-page"), "People: a person opens their page");
    },
  ],
  [
    "person-found",
    async (page, t) => {
      if (!t.full) return;
      const found = page.locator(".found button", { hasText: "Check them" });
      if (!t.check(await found.isVisible(), "People: faces found by themselves can be checked")) return;
      await found.click();
      t.check(await shows(page, ".found-face"), "People: the found faces are listed");
      const doubts = page.locator(".found-face.doubt");
      if (!t.check((await doubts.count()) === 1, "People: the face unlike the rest is listed to check")) return;
      await t.shot("person-doubt");
      await doubts.first().locator("button[title^='Not']").click();
      t.check(await gone(page, ".found-face.doubt"), "People: “not them” takes the doubtful face off");
    },
  ],
  [
    "person-menu",
    async (page, t) => {
      const tiles = await page.locator(".person-pic").count();
      await page.locator(".person-pic").first().click({ button: "right" });
      await shows(page, ".context-menu");
      if (!t.full) return;
      const remove = page.locator(".context-menu button, .context-menu [role='menuitem'], .context-menu *", { hasText: /^Remove from / }).first();
      if (!t.check(await remove.isVisible(), "People: right-click on a picture offers to remove it from the person")) return;
      await t.shot("person-menu");
      await remove.click();
      t.check((await countOf(page, ".person-pic", tiles - 1)) === tiles - 1, "People: removed from the person, the picture goes from their page");
      await press(page, "Meta+z");
      t.check((await countOf(page, ".person-pic", tiles)) === tiles, "People: ⌘Z puts it back");
    },
  ],
  [
    "person-back",
    async (page, t) => {
      // The menu of the scene before is still open where it was only looked at (Esc closes it alone).
      if (await page.locator(".context-menu").isVisible().catch(() => false)) await press(page, "Escape");
      const was = await page.locator(".person-page").evaluate((el) => ((el.scrollTop = 400), el.scrollTop));
      // The scroll is remembered as it happens: a moment for that before leaving the page.
      await wait(SETTLE);
      await page.locator(".person-pic").nth(2).dblclick();
      await shows(page, ".hud-left button.accent2");
      if (t.full) t.check((await page.locator(".hud-left button.accent2").getAttribute("title"))?.includes("Back to People"), "Viewer: opened from a person, back says People");
      await press(page, "Escape");
      const back = await shows(page, ".person-page");
      if (!t.full) return;
      t.check(back, "Viewer: back goes to the person's page");
      t.check(was > 0 && Math.abs((await page.locator(".person-page").evaluate((el) => el.scrollTop)) - was) < 3, "Viewer: back to the person's page where it was scrolled");
    },
  ],
  ["artists", async (page) => (await press(page, "Escape", "w"), await shows(page, ".artist-card, .artist-tabs"))],
  [
    "artist",
    async (page) => {
      // Artists opens where it was left: Kaze's page, or the list.
      const card = page.locator(".artist-card").first();
      if (await card.isVisible().catch(() => false)) await card.click();
      await shows(page, ".artist-tabs");
    },
  ],
  ["scrapbook", async (page) => (await press(page, "Escape", "k"), await shows(page, ".scrapbook-home"))],
  [
    "find",
    async (page, t) => {
      await page.locator(".nav-group").click();
      await page.locator(".nav-item").last().click();
      await shows(page, ".find-tile, button:has-text('Sign in to')");
      const signIn = page.locator("button", { hasText: "Sign in to" });
      if (await signIn.isVisible().catch(() => false)) await signIn.click();
      t.check(await shows(page, ".find-tile", 20000), "Find: signed in, a page of works shows");
    },
  ],
  [
    "find-check",
    async (page, t) => {
      if (!t.full) return;
      await page.locator(".find-tile").first().click({ button: "right" });
      await page.locator(".context-menu *", { hasText: /^Do I have this\?/ }).first().click();
      t.check(await shows(page, ".find-check-pop:has-text('In your library')", 15000), "Find: a work brought in before is found in the library");
      if (!t.check(await shows(page, ".find-check-artist:has-text('Given to')"), "Find: found in the library, its copy is given the work's artist")) return;
      const given = () => page.evaluate(() => import("/src/artistsStore.ts").then((m) => Object.values(m.useArtists.getState().doc.items).filter((ids) => ids.length).length));
      const by = await given();
      await t.shot("find-check-result");
      await page.locator(".find-check-artist button", { hasText: "Undo" }).click();
      t.check(await gone(page, ".find-check-artist:has-text('Given to')"), "Find: Undo takes the artist back");
      t.check((await given()) === by - 1, "Find: Undo leaves the picture without that artist");
      await press(page, "Escape");
      await page.mouse.click(5, 5);
      await gone(page, ".find-check-pop");
    },
  ],
  [
    "find-preview",
    async (page, t) => {
      if (t.full) {
        await press(page, "Space");
        t.check(await shows(page, ".side-list button:has-text('Basket'):has-text('1')"), "Find: Space puts a work in the basket");
      }
      await press(page, "Enter");
      await shows(page, ".find-preview", 15000);
    },
  ],
  [
    "find-basket",
    async (page, t) => {
      await press(page, "Escape");
      await page.locator(".side-list button", { hasText: "Basket" }).click();
      if (!t.full) return;
      await shows(page, ".find-tile");
      await press(page, "Meta+a");
      t.check(await shows(page, ".find-pickbar:has-text('1 of 1 chosen')"), "Find: ⌘A chooses the whole basket");
    },
  ],
  [
    "find-basket-check",
    async (page, t) => {
      if (!t.full) return;
      // The work in the basket was looked for before it went in: that's kept, so it's "Look again".
      t.check((await textOf(page, ".find-basket-check")).includes("All looked for"), "Find: a work looked for before it went into the basket stays looked for");
      const look = page.locator(".find-basket-check button", { hasText: /Look (for|again)/ });
      if (!t.check(await look.isVisible(), "Find: the basket offers to look for what's in it in the library")) return;
      await look.click();
      t.check(await shows(page, ".find-basket-check:has-text('All looked for')", 20000), "Find: every work in the basket looked for");
      t.check((await page.locator(".find-tile .find-have").count()) >= 1, "Find: the basket's works marked in the library or not");
      const seen = await page.evaluate(() => import("/src/findStore.ts").then((m) => Object.values(m.useFind.getState().baskets).flat().every((b) => b.seen)));
      t.check(seen, "Find: what was looked for is kept with the basket");
    },
  ],
  [
    "artist-found",
    async (page, t) => {
      await press(page, "w");
      await shows(page, ".artist-card, .artist-tabs");
      const card = page.locator(".artist-card", { hasText: "Kaze" });
      if (await card.isVisible().catch(() => false)) await card.click();
      await shows(page, ".artist-tabs");
      await page.locator(".artist-tabs .page-tab", { hasText: "From" }).click();
      await shows(page, ".artist-found");
      if (!t.full) return;
      const pictures = await picturesOf(page);
      await page.locator(".artist-found button", { hasText: "Look for their works" }).click();
      // Until the look is done (Activity's job gone): their works are listed through the plugin.
      // Paced as for the platform: up to two minutes for the made-up 90 works.
      await until(page, () => import("/src/artistsStore.ts").then((m) => !m.useArtists.getState().looking && Object.keys(m.useArtists.getState().doc?.looked ?? {}).length > 0), null, 120000);
      if (!t.check((await countOf(page, ".artist-found-tile", 2)) === 2, "Artists: their works in your library are found (one as it is, one painted again)")) return;
      t.check((await page.locator(".artist-found-tile.unsure").count()) === 1, "Artists: the one painted again is found, less sure");
      await t.shot("artist-found-list");
      await page.locator(".artist-found button", { hasText: "sure one" }).click();
      t.check((await countOf(page, ".artist-found-tile", 1)) === 1, "Artists: yes to the sure one gives it them");
      t.check((await picturesOf(page)) === pictures + 1, "Artists: the one said yes to is theirs");
      await page.locator(".artist-found-tile button[title^='Not']").click();
      t.check((await countOf(page, ".artist-found-tile", 0)) === 0, "Artists: no to the other takes it off");
      t.check((await textOf(page, ".artist-found")).includes("of their works looked for"), "Artists: how many of their works were looked for is kept");
    },
  ],
  [
    "artist-style",
    async (page, t) => {
      await page.locator(".artist-tabs .page-tab", { hasText: "style" }).click();
      await page.locator(".artist-style button", { hasText: "Find pictures like theirs" }).click();
      await shows(page, ".artist-style-tile");
      if (!t.full) return;
      const tiles = page.locator(".artist-style-tile");
      const n = await tiles.count();
      if (!t.check(n >= 3, "Artists: pictures like theirs are suggested")) return;
      const pictures = await picturesOf(page);
      await tiles.nth(0).locator(".thumb").click();
      await tiles.nth(1).locator(".thumb").click({ modifiers: ["Shift"] });
      await t.shot("artist-style-picked");
      await page.locator(".artist-style button", { hasText: "Not theirs" }).click();
      t.check((await countOf(page, ".artist-style-tile", n - 2)) === n - 2, "Artists: no to the picked ones takes them off");
      await tiles.nth(0).locator(".thumb").click();
      await page.locator(".artist-style button", { hasText: "picked" }).click();
      t.check(await shows(page, `.banner-line:has-text('${pictures + 1} picture')`), "Artists: yes to a picked one gives it them");
      await page.locator(".artist-style button", { hasText: "Look again" }).click();
      // Looked again (the button says "Looking…" meanwhile): the ones said no to stay off.
      await gone(page, ".artist-style button:has-text('Looking')", 15000);
      t.check((await tiles.count()) <= n - 3, "Artists: looked again, the ones said no to stay off");
    },
  ],
  [
    "artist-more",
    async (page, t) => {
      // Artists opens where it was left: Kaze's page, or the list.
      const card = page.locator(".artist-card", { hasText: "Kaze" });
      if (await card.isVisible().catch(() => false)) await card.click();
      await page.locator(".artist-tabs .page-tab", { hasText: "More on" }).click();
      if (!t.check(await shows(page, ".artist-more-tile", 15000), "Artists: a linked artist's page shows more of their work")) return;
      if (!t.full) return;
      const tiles = page.locator(".artist-more-tile");
      const basketed = () => page.evaluate(() => import("/src/findStore.ts").then((m) => Object.values(m.useFind.getState().baskets).flat().length));
      const basket = await basketed();
      await tiles.first().locator(".find-corner.basket").click();
      t.check(await until(page, (k) => import("/src/findStore.ts").then((m) => Object.values(m.useFind.getState().baskets).flat().length === k), basket + 1), "Artists: one of their works goes into the basket from their page");
      await t.shot("artist-more-page");
      await tiles.nth(1).locator(".artist-more-open").click();
      t.check(await shows(page, ".find-preview", 15000), "Artists: one of their works opens in Find, looked at closer");
    },
  ],
  [
    "sort-artist",
    async (page, t) => {
      // Out of the preview, and Esc again: the Sort queue.
      if (await page.locator(".find-preview").isVisible().catch(() => false)) {
        await press(page, "Escape");
        await gone(page, ".find-preview");
      }
      await press(page, "Escape");
      await shows(page, ".viewer-artist");
      if (!t.full) return;
      await press(page, "Shift+W");
      if (!t.check(await shows(page, ".artist-picker"), "Sort: ⇧W asks who made it")) return;
      await page.keyboard.type("Kaze");
      await press(page, "Enter");
      await wait(SETTLE);
      await t.shot("sort-artist-pick");
      await press(page, "Escape");
      await gone(page, ".artist-picker");
      t.check(((await page.locator(".viewer-artist").getAttribute("title")) ?? "").includes("By Kaze"), "Sort: the picture's artist shows on its button");
    },
  ],
  [
    "info",
    async (page, t) => {
      await press(page, "i");
      const panel = page.locator(".info-panel");
      if (!t.check(await shows(page, ".info-panel"), "Info: I opens it as a popup")) return;
      if (!t.full) return;
      const first = await textOf(page, ".info-title h2");
      const box = await panel.boundingBox();
      const view = page.viewportSize();
      t.check(!!box && !!view && Math.abs(box.x + box.width / 2 - view.width / 2) < 4 && box.y >= 0 && box.y + box.height <= view.height, "Info: the popup sits in the middle, whole on the screen");
      await t.shot("info-open");
      await press(page, "ArrowRight");
      t.check(await until(page, (was) => document.querySelector(".info-title h2")?.innerText !== was, first), "Info: it follows the picture on show");
      await page.locator(".info-more summary", { hasText: "Tag suggestions" }).click();
      t.check(await shows(page, ".info-more[open] .info-more-body"), "Info: the tag suggestions unfold");
      await press(page, "i");
      t.check(await gone(page, ".info-panel"), "Info: I again closes it");
      await press(page, "i");
      await shows(page, ".info-panel");
      await wait(SETTLE);
      await page.mouse.click(8, Math.round((view?.height ?? 720) / 2));
      t.check(await gone(page, ".info-panel"), "Info: a click beside it closes it");
    },
  ],
  [
    "album-artist",
    async (page, t) => {
      // Info is still open where it was only looked at: I again closes it.
      if (await page.locator(".info-panel").isVisible().catch(() => false)) (await press(page, "i"), await gone(page, ".info-panel"));
      await press(page, "a");
      await shows(page, ".album-card");
      await page.locator(".album-card").first().click({ button: "right" });
      await page.locator(".context-menu button", { hasText: "Artist…" }).first().click();
      if (!t.check(await shows(page, ".modal .artist-picker"), "Albums: an album's artist can be chosen")) return;
      if (!t.full) return;
      await page.locator(".modal .artist-picker-row", { hasText: "Kaze" }).click();
      await press(page, "Escape");
      await press(page, "w");
      await shows(page, ".artist-card, .artist-tabs");
      // Artists opens where it was left: Kaze's page (from before), or the list.
      const card = page.locator(".artist-card", { hasText: "Kaze" });
      if (await card.isVisible().catch(() => false)) {
        t.check((await card.innerText()).toLowerCase().includes("1 album"), "Albums: the artist's card counts the album");
        await card.click();
        await shows(page, ".artist-tabs");
      }
      await page.locator(".artist-tabs .page-tab", { hasText: "Theirs" }).click();
      t.check(await shows(page, ".banner-line:has-text('1 album')"), "Albums: the artist's page counts the album");
      t.check((await countOf(page, ".artist-album", 1)) === 1, "Albums: the album shows on the artist's page");
    },
  ],
  [
    "album-info",
    async (page, t) => {
      // The artist picker is still open where it was only looked at.
      if (await page.locator(".modal").isVisible().catch(() => false)) (await press(page, "Escape"), await gone(page, ".modal"));
      await press(page, "a");
      await shows(page, ".album-card");
      await page.locator(".album-card").first().click({ button: "right" });
      await page.locator(".context-menu button", { hasText: "Info" }).first().click();
      if (!t.check(await shows(page, ".info-panel"), "Info: an album's Info opens")) return;
      if (!t.full) return;
      t.check((await textOf(page, ".info-panel")).includes("Kaze"), "Info: the album's artist shows");
      await t.shot("album-info-open");
      await press(page, "Escape");
      t.check(await gone(page, ".info-panel"), "Info: Esc closes it");
    },
  ],
  ["settings", async (page) => (await press(page, "Escape", "g"), await shows(page, ".settings-list"))],
  ["settings-viewing", async (page) => (await page.locator(".settings-list button", { hasText: "Look and reading" }).click(), await wait(SETTLE))],
  ["settings-plugins", async (page) => (await page.locator(".settings-list button", { hasText: "Plugins" }).click(), await wait(SETTLE))],
  ["settings-online", async (page) => (await page.locator(".settings-list button", { hasText: "Going online" }).click(), await wait(SETTLE))],
  [
    "import",
    async (page, t) => {
      await page.locator(".settings-list button", { hasText: "Bringing in" }).click();
      await page.locator(".settings-page button", { hasText: "Import" }).first().click();
      t.check(await shows(page, ".modal:has-text('Import')"), "Settings: Import… opens the import");
    },
  ],
  [
    "home",
    async (page, t) => {
      await press(page, "Escape", "Escape");
      await page.locator(".brand-home").first().click();
      await shows(page, ".home-preset, .home-block");
      // The mock's library has no board yet: the presets first.
      if (await page.locator(".home-preset").first().isVisible().catch(() => false)) await page.locator(".home-preset", { hasText: "Everything" }).click();
      await until(page, () => document.querySelectorAll(".home-block").length >= 20);
      if (!t.full) return;
      t.check((await page.locator(".home-block").count()) >= 20, "Home: Everything puts every kind of block on the board");
      t.check(await shows(page, ".kind-sort .home-block-title"), "Home: Waiting to sort shows");
    },
  ],
  [
    "home-arrange",
    async (page, t) => {
      await page.locator(".home-arrange-btn").click();
      await shows(page, ".topnav .home-arrange");
      if (!t.full) return;
      t.check(!(await page.locator(".home-panel").isVisible().catch(() => false)), "Home: Arrange leaves the board as it is (no side panel)");
      await page.locator(".topnav .home-arrange button", { hasText: "Add" }).click();
      t.check(await shows(page, ".home-menu"), "Home: Add opens the block menu");
      await press(page, "Escape");
      await page.locator(".topnav .home-arrange button", { hasText: "Stickers" }).click();
      await page.locator(".home-menu button", { hasText: "A random sticker" }).click();
      t.check((await countOf(page, ".home-sticker", 1)) === 1, "Home: a random sticker goes on the board");
      t.check(await shows(page, ".home-panel:has-text('Random sticker')"), "Home: a new sticker's panel opens");
      await press(page, "Escape");
      await page.locator(".kind-random").click({ position: { x: 40, y: 60 } });
      t.check(await shows(page, ".home-panel"), "Home: a block clicked opens its panel, with its filters");
    },
  ],
  [
    "home-done",
    async (page, t) => {
      await press(page, "Escape", "Escape");
      t.check(await gone(page, ".topnav .home-arrange"), "Home: Esc closes the panel, then ends Arrange");
    },
  ],
  [
    "home-offline",
    async (page, t) => {
      // Asking before going online, each platform on its own, with works in three platforms' baskets: one strip of Connect buttons, nothing spilling.
      await page.evaluate(async () => {
        const { useOnline } = await import("/src/lib/online.ts");
        const { useFind } = await import("/src/findStore.ts");
        useOnline.getState().set({ ask: true, each: true });
        useOnline.getState().disconnect();
        const work = (id) => ({ id, title: `Made-up work ${id}`, author: { id: "a", name: "A", account: "a" }, url: null, thumb: "https://example.org/t.jpg", width: 1, height: 1, pages: 1, kind: "image", tags: [], date: null, adult: false });
        useFind.setState({ baskets: { "made-up-a": [work("1"), work("2")], "made-up-b": [work("3")], "made-up-c": [work("4"), work("5"), work("6")] } });
      });
      await shows(page, ".kind-basket");
      await page.locator(".kind-basket").scrollIntoViewIfNeeded();
      t.check(await shows(page, ".kind-basket .home-rows-connect"), "Home: platforms waiting for Connect share one strip of buttons");
    },
  ],
  [
    "home-offline-small",
    async (page, t) => {
      await page.evaluate(async () => {
        const { useHome } = await import("/src/home/store.ts");
        const b = useHome.getState().doc.blocks.find((x) => x.type === "basket");
        useHome.getState().resizeBlock(b.id, 3, 2);
      });
      await shows(page, ".kind-basket");
      await page.locator(".kind-basket").scrollIntoViewIfNeeded();
      t.check(await shows(page, ".kind-basket .home-rows-connect"), "Home: a small basket block still offers Connect");
      await page.evaluate(async () => {
        const { useOnline } = await import("/src/lib/online.ts");
        useOnline.getState().set({ ask: false, each: false });
      });
    },
  ],
];

/** One pass through the scenes, at one size in one theme, in a browser context of its own. */
async function runPass(browser, { w, h, theme, mode }, full) {
  const run = `${w}x${h}-${theme}-${mode}`;
  const dir = join(OUT, run);
  mkdirSync(dir, { recursive: true });
  const failures = [];
  const report = [];
  const context = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  let scene = "start";
  page.on("pageerror", (e) => {
    const what = `${run} ${scene}: the page threw: ${e.message.split("\n")[0]}`;
    if (!failures.includes(what)) failures.push(what);
  });
  const t = {
    full,
    check(ok, what) {
      if (!ok) failures.push(what);
      return ok;
    },
    shot: (name) => page.screenshot({ path: join(dir, `${name}.png`) }),
  };
  try {
    // Every frame runs it, the plugins' sandboxed ones too (no storage there).
    await context.addInitScript(([th, md]) => {
      try {
        localStorage.setItem("quire.theme", th);
        localStorage.setItem("quire.mode", md);
      } catch {}
    }, [theme, mode]);
    await page.goto(`http://127.0.0.1:5183/?mock&e2e${FIND ? `&find=${encodeURIComponent(FIND)}` : ""}`);
    // The app is up once its bar is, with the mock's library open behind it.
    await shows(page, ".topnav", 30000);
    await until(page, () => import("/src/store.ts").then((m) => !!m.useStore.getState().root && m.useStore.getState().allItems.length > 0), null, 30000);
    // Some of the scenes on their own: from Browse, the way into the rest.
    if (only) await press(page, "Escape", "b");
    for (const [name, act] of scenes) {
      if (only && !name.includes(only)) continue;
      scene = name;
      const before = failures.length;
      try {
        await act(page, t);
      } catch (e) {
        failures.push(`${run} ${name}: ${String(e.message ?? e).split("\n")[0]}`);
      }
      await wait(SETTLE);
      const spills = await page.evaluate(findOverflow);
      for (let i = before; i < failures.length; i++) if (!failures[i].startsWith(run)) failures[i] = `${run} ${name}: ${failures[i]}`;
      report.push({ run, scene: name, spills });
      await page.screenshot({ path: join(dir, `${name}.png`) });
    }
  } finally {
    await context.close();
  }
  console.log(`${run}: ${report.length} screens looked at, ${failures.length} checks failed`);
  return { failures, report };
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const files = await startFileServer();
  const vite = await createServer({ root: repo, logLevel: "error", server: { port: 5183, strictPort: true, host: "127.0.0.1" } });
  await vite.listen();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const results = new Array(passes.length);
  try {
    // The passes a few at a time, each taking the next one as it finishes; the results in their order.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, passes.length) }, async () => {
        while (next < passes.length) {
          const i = next++;
          results[i] = await runPass(browser, passes[i], i === 0);
        }
      }),
    );
  } finally {
    await browser.close();
    await vite.close();
    files.close();
  }
  const failures = results.flatMap((r) => r?.failures ?? []);
  const report = results.flatMap((r) => r?.report ?? []);
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ failures, report }, null, 1));
  const spilled = report.filter((r) => r.spills.length);
  for (const r of spilled) {
    console.log(`\n${r.run} ${r.scene}:`);
    for (const s of r.spills.slice(0, 8)) console.log(`  ${s.what} by ${s.by}px: ${s.el}`);
    if (r.spills.length > 8) console.log(`  …and ${r.spills.length - 8} more`);
  }
  for (const f of failures) console.log(`FAILED ${f}`);
  console.log(`\n${report.length} screens looked at, ${spilled.length} with something spilling, ${failures.length} checks failed. Screenshots in e2e/out.`);
  process.exit(failures.length || spilled.length ? 1 : 0);
}

await main();
