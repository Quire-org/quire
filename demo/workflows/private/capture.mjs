// The private photos workflow video: faces found on the computer and named once, the library locked
// in a vault, and a picture shown on a phone that was let in (see ../../kit.mjs; script.json puts it
// together). The faces are the ones Quire's face finder found in the example library
// (examples/faces.json). `npm run workflows -- private`.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { capture } from "../../kit.mjs";

const PASSPHRASE = "a quiet harbour at dawn";

await capture({
  work: dirname(fileURLToPath(import.meta.url)),
  steps: async ({ page, act, settle, shot, middleOf }) => {
    const button = (name) => page.getByRole("button", { name }).first();
    const set = (patch) => page.evaluate(async (patch) => (await import("/src/store.ts")).useStore.setState(patch), patch);

    console.log("people");
    await act("openPeople");
    await settle(2500);
    const name = button(/^Name/);
    await shot("people", { click: await middleOf(name) });
    await name.click();
    await settle(400);
    await page.keyboard.type("Victor Glover", { delay: 25 });
    await settle(300);
    await shot("people-naming");
    await page.keyboard.press("Enter");
    await settle(1500);
    const victor = page.locator(".roster").getByText("Victor Glover").first();
    await shot("people-named", { click: await middleOf(victor) });
    await victor.click();
    await settle(2000);
    await shot("person");

    console.log("vault");
    await set({ vaultOpen: true });
    await settle(800);
    await page.locator('input[placeholder^="Passphrase"]').fill(PASSPHRASE);
    await page.locator('input[placeholder="Repeat"]').first().fill(PASSPHRASE);
    await settle(400);
    await shot("vault-new", { click: await middleOf(button(/Create vault/)) });
    await button(/Create vault/).click();
    await settle(900);
    await page.locator("label", { hasText: "I have saved this code" }).locator("input").check();
    await settle(300);
    await shot("vault-code", { click: await middleOf(button(/^Done/)) });
    await button(/^Done/).click();
    await settle(800);
    const all = button(/^Encrypt \d+ new files/);
    if (await all.isVisible().catch(() => false)) {
      await shot("vault-status", { click: await middleOf(all) });
      await all.click();
    }
    await page.waitForTimeout(2500);
    await shot("vault-encrypting");
    await page.waitForFunction(() => !/Encrypting|\d+ of \d+/.test(document.body.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
    await settle(800);
    const remember = button(/Remember with Touch ID/);
    if (await remember.isVisible().catch(() => false)) await remember.click();
    await settle(600);
    await shot("vault-done");
    await button(/Lock and close/).click();
    await settle(1500);
    await act("openRoot", "/Volumes/Pictures");
    await settle(1500);
    await shot("unlock");
    const quick = button(/Touch ID/);
    if (await quick.isVisible().catch(() => false)) await quick.click();
    else {
      await page.locator("input[type=password]").first().fill("mock");
      await page.keyboard.press("Enter");
    }
    await settle(2000);

    console.log("cast");
    await page.evaluate(async () => {
      const { useStore } = await import("/src/store.ts");
      const s = useStore.getState();
      const photos = s.allItems.filter((i) => i.dir === "Photos").sort((a, b) => a.name.localeCompare(b.name));
      s.openViewer(photos, photos.findIndex((i) => i.name === "harbour-at-dawn"), { kind: "browse" });
    });
    await settle(1500);
    const phone = page.locator('button[title^="Show on another device"]').first();
    await shot("cast-0", { click: await middleOf(phone) });
    await phone.click();
    await settle(800);
    await shot("cast-1", { click: await middleOf(button(/Start showing/)) });
    await button(/Start showing/).click();
    await page.waitForTimeout(2600);
    await settle(400);
    await shot("cast-2", { click: await middleOf(button(/^Allow/)) });
    await button(/^Allow/).click();
    await settle(1500);
    await shot("cast-3");
  },
});
