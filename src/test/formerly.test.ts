import { beforeEach, describe, expect, it } from "vitest";
import { renameSavedSettings } from "../lib/formerly";

describe("saved settings from when the app was Media Sorter", () => {
  beforeEach(() => localStorage.clear());

  it("get Quire's names, values unchanged", () => {
    localStorage.setItem("mediasorter.theme", "cozy");
    localStorage.setItem("mediasorter.mode", "dark");
    localStorage.setItem("mediasorter.find.ltr.site-a", "1");
    localStorage.setItem("other.app", "x");
    expect(renameSavedSettings(localStorage)).toBe(3);
    expect(localStorage.getItem("quire.theme")).toBe("cozy");
    expect(localStorage.getItem("quire.mode")).toBe("dark");
    expect(localStorage.getItem("quire.find.ltr.site-a")).toBe("1");
    expect(localStorage.getItem("mediasorter.theme")).toBeNull();
    expect(localStorage.getItem("other.app")).toBe("x");
  });

  it("never replace one Quire saved itself, and run once", () => {
    localStorage.setItem("mediasorter.theme", "cozy");
    localStorage.setItem("quire.theme", "midnight");
    renameSavedSettings(localStorage);
    expect(localStorage.getItem("quire.theme")).toBe("midnight");
    expect(localStorage.getItem("mediasorter.theme")).toBeNull();
    expect(renameSavedSettings(localStorage)).toBe(0);
    expect(localStorage.getItem("quire.theme")).toBe("midnight");
  });

  it("are read under Quire's names by the screens that saved them", async () => {
    localStorage.setItem("mediasorter.sounds", JSON.stringify({ menus: true, sorting: false, volume: 0.3 }));
    renameSavedSettings(localStorage);
    const { useSounds } = await import("../lib/sounds");
    expect(useSounds.getState()).toMatchObject({ menus: true, volume: 0.3 });
  });
});
