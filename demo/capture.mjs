// Quire's demo, step by step, as the frames its video, screenshots and loop are made of (see
// kit.mjs; script.json says how they're put together). `npm run capture`.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "./kit.mjs";

/** Other looks, for the themes part. */
const LOOKS = [
  { theme: "cp2077", mode: "dark" },
  { theme: "cozy", mode: "light" },
  { theme: "manga", mode: "light" },
  { theme: "gallery", mode: "dark" },
];

/** Other ways to lay out the Home, fitted to the window, for its part. */
const LAYOUTS = {
  mosaic: [
    { type: "slideshow", x: 0, y: 0, w: 6, h: 6, filter: { folders: ["Artworks"] } },
    { type: "picture", x: 6, y: 0, w: 6, h: 6, filter: { folders: ["Photos"] } },
    { type: "newest", x: 0, y: 6, w: 4, h: 4 },
    { type: "favourites", x: 4, y: 6, w: 4, h: 4 },
    { type: "random", x: 8, y: 6, w: 4, h: 4 },
  ],
  hero: [
    { type: "picture", x: 0, y: 0, w: 4, h: 6, filter: { folders: ["People"] } },
    { type: "slideshow", x: 4, y: 0, w: 8, h: 6, filter: { folders: ["Photos"] } },
    { type: "unseen", x: 0, y: 6, w: 12, h: 4 },
  ],
  trio: [
    { type: "picture", x: 0, y: 0, w: 4, h: 6, filter: { folders: ["Artworks"] } },
    { type: "picture", x: 4, y: 0, w: 4, h: 6, filter: { folders: ["Photos"] } },
    { type: "picture", x: 8, y: 0, w: 4, h: 6, filter: { folders: ["People"] } },
    { type: "random", x: 0, y: 6, w: 12, h: 4 },
  ],
};

await capture({
  work: dirname(fileURLToPath(import.meta.url)),
  steps: async ({ page, act, settle, shot, middleOf, look, gridOf, tall }) => {
    console.log("home");
    await act("openHome");
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
    const browse = (patch) =>
      page.evaluate(async (patch) => {
        const { useStore } = await import("/src/store.ts");
        const s = useStore.getState();
        s.set({ browseFilters: { ...s.browseFilters, ...patch } });
      }, patch);
    await browse({ layout: "masonry", zoom: 250, sortBy: "name", tags: [] });
    await settle(2000);
    await shot("browse", { grid: await gridOf(".mtile") });
    await tall("browse-tall");
    await browse({ tags: ["series/pepper-and-carrot"] });
    await settle(2000);
    await shot("browse-tags");
    await browse({ tags: [] });

    console.log("albums");
    await act("openAlbums");
    await settle(2000);
    await shot("albums", { click: await middleOf(page.locator(".album-card", { hasText: "Pepper and Carrot 06" })) });
    await page.evaluate(async () => {
      const { useStore } = await import("/src/store.ts");
      const s = useStore.getState();
      await s.openAlbum(s.albums.find((a) => a.name.includes("Pepper and Carrot 06")));
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

    console.log("looks");
    await act("openHome");
    for (const l of LOOKS) {
      await look(l);
      await settle(900);
      await shot(`look-${l.theme}-${l.mode}`);
    }

    console.log("layouts");
    await look({ theme: "midnight", mode: "dark" });
    for (const [name, blocks] of Object.entries(LAYOUTS)) {
      await page.evaluate(
        async ([name, blocks]) => {
          const { useHome } = await import("/src/home/store.ts");
          const doc = useHome.getState().doc;
          useHome.setState({ doc: { ...doc, fit: true, blocks: blocks.map((b, i) => ({ id: `${name}-${i}`, ...b })) } });
        },
        [name, blocks],
      );
      await settle(1500);
      await shot(`layout-${name}`);
    }
  },
});
