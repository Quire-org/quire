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

/** A sticker on the Home: one of the built-in ones, where it sits (across, a fraction; down, in rows), its width and turn. */
const sticker = (id, x, y, w, rot) => ({ src: { builtin: id }, aspect: 1, look: "original", outline: true, x, y, w, rot });

/**
 * Ways to lay out the Home, fitted to the window, for its part: each with what reading has got to,
 * the board made below, or a sticker or two on top. `home` opens the video, and the themes are seen on it.
 */
const LAYOUTS = {
  home: {
    blocks: [
      { type: "slideshow", x: 0, y: 0, w: 7, h: 6, filter: { folders: ["Photos"] } },
      { type: "reading", x: 7, y: 0, w: 5, h: 3 },
      { type: "board", x: 7, y: 3, w: 5, h: 3 },
      { type: "newest", x: 0, y: 6, w: 12, h: 4 },
    ],
    stickers: [sticker("red-heart", 0.565, 0.55, 0.05, -14)],
  },
  board: {
    blocks: [
      { type: "board", x: 0, y: 0, w: 7, h: 6 },
      { type: "picture", x: 7, y: 0, w: 5, h: 6, filter: { folders: ["Artworks"] } },
      { type: "favourites", x: 0, y: 6, w: 5, h: 4 },
      { type: "reading", x: 5, y: 6, w: 3, h: 4 },
      { type: "random", x: 8, y: 6, w: 4, h: 4 },
    ],
    stickers: [sticker("artist-palette", 0.555, 5.3, 0.055, 12), sticker("sparkles", 0.955, 0.55, 0.04, 8)],
  },
  hero: {
    blocks: [
      { type: "picture", x: 0, y: 0, w: 4, h: 6, filter: { folders: ["People"] } },
      { type: "slideshow", x: 4, y: 0, w: 8, h: 6, filter: { folders: ["Photos"] } },
      { type: "unseen", x: 0, y: 6, w: 8, h: 4 },
      { type: "reading", x: 8, y: 6, w: 4, h: 4 },
    ],
    stickers: [sticker("camera", 0.315, 5.3, 0.05, -10)],
  },
  trio: {
    blocks: [
      { type: "picture", x: 0, y: 0, w: 4, h: 6, filter: { folders: ["Artworks"] } },
      { type: "picture", x: 4, y: 0, w: 4, h: 6, filter: { folders: ["Photos"] } },
      { type: "picture", x: 8, y: 0, w: 4, h: 6, filter: { folders: ["People"] } },
      { type: "board", x: 0, y: 6, w: 6, h: 4 },
      { type: "random", x: 6, y: 6, w: 6, h: 4 },
    ],
    stickers: [sticker("cherry-blossom", 0.31, 0.55, 0.045, -8), sticker("glowing-star", 0.96, 6.35, 0.04, 15)],
  },
};

await capture({
  work: dirname(fileURLToPath(import.meta.url)),
  steps: async ({ page, act, settle, shot, middleOf, look, gridOf, tall }) => {
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
    // Two other albums read a little way in before the one in the video, for the Home's Continue reading.
    await page.evaluate(async () => {
      const { useStore, albumPages } = await import("/src/store.ts");
      const s = useStore.getState();
      const others = s.albums.filter((a) => !a.name.includes("Pepper and Carrot 06") && a.count > 4).slice(0, 2);
      for (const [n, a] of others.entries()) {
        const pages = await albumPages(s.root, a);
        useStore.getState().recordView(pages[[3, 1][n]] ?? pages[0]);
        await new Promise((r) => setTimeout(r, 20));
      }
    });
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

    console.log("board");
    // A board for the Home to show: pictures pinned up on cork, a note and an arrow; kept as it closes.
    await page.evaluate(async () => {
      const { useStore } = await import("/src/store.ts");
      const { useScrapbook, pictureAspect } = await import("/src/scrapbook/store.ts");
      const items = useStore.getState().allItems.filter((i) => i.kind === "image");
      const picked = [...items.filter((i) => i.dir === "Photos").slice(0, 2), ...items.filter((i) => i.dir === "Artworks").slice(0, 2)];
      await useScrapbook.getState().newBoard("Autumn mood", { w: 1920, h: 1080 });
      const spots = [
        { x: 0.2, y: 0.37, rot: -3 },
        { x: 0.44, y: 0.34, rot: 2 },
        { x: 0.68, y: 0.38, rot: -2 },
        { x: 0.84, y: 0.64, rot: 3 },
      ];
      const layers = [];
      for (const [i, it] of picked.entries()) layers.push({ id: `p${i}`, type: "photo", blob: "", item: it.key, aspect: await pictureAspect(it), frame: i === 3 ? "polaroid" : "none", fix: { kind: i === 1 ? "tape" : "pin", where: i === 1 ? "top" : "one" }, w: 0.19, ...spots[i] });
      layers.push({ id: "note", type: "note", text: "Warm light, long shadows", paper: "#fff3a8", fix: { kind: "pin", where: "one" }, x: 0.34, y: 0.76, w: 0.15, rot: -3 });
      layers.push({ id: "arrow", type: "arrow", color: "#e5484d", thickness: 0.006, heads: "end", x: 0.52, y: 0.72, w: 0.13, rot: -24 });
      useScrapbook.getState().change((d) => ({ ...d, layers }));
      await new Promise((r) => setTimeout(r, 2500));
      await useScrapbook.getState().done();
    });

    console.log("home");
    const layout = (name) =>
      page.evaluate(
        async ([name, { blocks, stickers }]) => {
          const { useHome } = await import("/src/home/store.ts");
          const doc = useHome.getState().doc;
          useHome.setState({ doc: { ...doc, fit: true, blocks: blocks.map((b, i) => ({ id: `${name}-${i}`, ...b })), stickers: stickers.map((st, i) => ({ id: `${name}-s${i}`, ...st })) } });
        },
        [name, LAYOUTS[name]],
      );
    await act("openHome");
    await layout("home");
    await settle(2500);
    await shot("home");

    console.log("looks");
    for (const l of LOOKS) {
      await look(l);
      await settle(900);
      await shot(`look-${l.theme}-${l.mode}`);
    }

    console.log("layouts");
    await look({ theme: "midnight", mode: "dark" });
    for (const name of ["board", "hero", "trio"]) {
      await layout(name);
      await settle(1500);
      await shot(`layout-${name}`);
    }
  },
});
