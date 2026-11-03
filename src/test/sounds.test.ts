import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";

vi.mock("../lib/api", () => ({ api: new Proxy({}, { get: () => async () => null }), fileSrc: (p: string) => p, mediaUrl: () => "", thumbUrl: () => "", canThumb: () => false, setCurrentRoot: () => {}, storedPath: (_r: string, p: string) => p }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn(async () => null) }));

// A stand-in for the webview's audio: what it was asked to play, by the file's name.
const heard: string[] = [];
class FakeAudio {
  // Running unless a test says it waits for a press (as WebKit's does before one).
  static waiting = false;
  static resumed = 0;
  get state() {
    return FakeAudio.waiting ? "suspended" : "running";
  }
  destination = {};
  resume() {
    FakeAudio.resumed++;
    FakeAudio.waiting = false;
  }
  createBuffer() {
    return { name: "silence" };
  }
  decodeAudioData(data: ArrayBuffer) {
    return Promise.resolve({ name: new TextDecoder().decode(data).split("?")[0].split("/").pop()!.replace(".wav", "") });
  }
  currentTime = 0;
  createBufferSource() {
    const src = {
      buffer: null as { name: string } | null,
      playbackRate: { value: 1 },
      connect: (n: unknown) => n,
      start: () => {
        heard.push(src.buffer!.name);
        shaped.push({ pitch: src.playbackRate.value });
      },
    };
    return src;
  }
  createGain() {
    const ramp: number[] = [];
    shaped.push({ ramp });
    return { gain: { value: 0, setValueAtTime: (v: number) => ramp.push(v), linearRampToValueAtTime: (v: number) => ramp.push(v) }, connect: (n: unknown) => n };
  }
  createBiquadFilter() {
    const f = { type: "", frequency: { value: 0 }, Q: { value: 1 }, connect: (n: unknown) => n };
    shaped.push({ filter: f });
    return f;
  }
}
// How each sound was played: its pitch, its softening, its level from start to full.
const shaped: Record<string, unknown>[] = [];
(globalThis as Record<string, unknown>).AudioContext = FakeAudio;
(globalThis as Record<string, unknown>).fetch = async (url: string) => ({ arrayBuffer: async () => new TextEncoder().encode(url).buffer });
let now = 1000;
vi.spyOn(performance, "now").mockImplementation(() => now);

const { CUES, THEME_SOUNDS, listenForSounds, resetHeard, shouldPlay, soundUrl, useSounds } = await import("../lib/sounds");
const { themes } = await import("../themes");
const { Popover } = await import("../components/Popover");
const { Modal } = await import("../components/Modal");
const { useStore } = await import("../store");

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const later = (ms: number) => (now += ms);

beforeEach(() => {
  heard.length = 0;
  resetHeard();
  now += 10_000;
  useSounds.setState({ menus: false, sorting: false, volume: 0.5 });
  document.documentElement.dataset.theme = "midnight";
});

describe("the themes' sounds", () => {
  it("every theme has a sound for every cue, each bundled with the app, with Kenney's CC0 licence beside them", () => {
    for (const t of themes) {
      const s = THEME_SOUNDS[t.id];
      expect(s, t.id).toBeTruthy();
      for (const c of CUES) expect(soundUrl(s.cues[c][0]), `${t.id} ${c}`).toBeTruthy();
    }
    expect(readFileSync("src/assets/sounds/LICENSE.txt", "utf8")).toContain("Creative Commons Zero, CC0");
  });

  it("are low and soft in every theme: played no higher than recorded, the brightness taken off", () => {
    for (const t of themes) {
      const s = THEME_SOUNDS[t.id];
      expect(s.pitch, t.id).toBeLessThanOrEqual(1);
      expect(s.lowpass, t.id).toBeLessThanOrEqual(3500);
      // A press, the most frequent, is never louder than what opens.
      expect(s.cues.select[1] ?? 1, t.id).toBeLessThanOrEqual(1.2);
      expect(s.cues.close[1] ?? 1, t.id).toBeLessThanOrEqual(s.cues.open[1] ?? 1);
    }
  });

  it("each theme sounds like itself: no two share their menus' opening sound", () => {
    const opens = themes.map((t) => THEME_SOUNDS[t.id].cues.open[0]);
    expect(new Set(opens).size).toBe(opens.length);
  });
});

describe("when a sound is heard", () => {
  const on = { menus: true, sorting: false, volume: 0.5 };

  it("never unless its kind is on and the volume above nothing", () => {
    expect(shouldPlay("open", later(1000), { menus: false, sorting: true, volume: 0.5 })).toBe(false);
    expect(shouldPlay("rate", later(1000), on)).toBe(false);
    expect(shouldPlay("open", later(1000), { ...on, volume: 0 })).toBe(false);
    expect(shouldPlay("open", later(1000), on)).toBe(true);
    expect(shouldPlay("rate", later(1000), { ...on, sorting: true })).toBe(true);
  });

  it("once for the same cue twice at once, and not again as a menu closes for an entry chosen in it", () => {
    expect(shouldPlay("open", later(1000), on)).toBe(true);
    expect(shouldPlay("open", later(50), on)).toBe(false);
    expect(shouldPlay("open", later(200), on)).toBe(true);
    expect(shouldPlay("select", later(1000), on)).toBe(true);
    expect(shouldPlay("close", later(80), on)).toBe(false);
    // Opened and closed in the same moment (React's checks in development): only the opening.
    expect(shouldPlay("open", later(1000), on)).toBe(true);
    expect(shouldPlay("close", later(5), on)).toBe(false);
    expect(shouldPlay("close", later(1000), on)).toBe(true);
  });

  it("is kept on this computer", () => {
    useSounds.getState().set({ menus: true, volume: 0.3 });
    expect(JSON.parse(localStorage.getItem("quire.sounds")!)).toEqual({ menus: true, sorting: false, volume: 0.3 });
  });
});

describe("sounds in the app", () => {
  function Menu() {
    const [open, setOpen] = useState(false);
    return createElement(Popover, {
      open,
      onClose: () => setOpen(false),
      trigger: createElement("button", { id: "trigger", onClick: () => setOpen(!open) }, "Menu"),
      children: createElement("div", { className: "pop-list" }, createElement("button", { id: "entry", onClick: () => setOpen(false) }, "An entry")),
    });
  }
  function Opens() {
    const [open, setOpen] = useState(false);
    return createElement("div", null, createElement("button", { id: "opens", onClick: () => setOpen(true) }, "Settings…"), open ? createElement(Modal, { title: "A dialog", onClose: () => setOpen(false), children: "In it" }) : null);
  }
  async function mount(node: ReturnType<typeof createElement>) {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(node));
    return root;
  }
  /** As a pointer does it: down (heard then), and the click on letting go. */
  const press = async (id: string, gap = 1000) => {
    later(gap);
    const el = document.getElementById(id)!;
    el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    // Its sound starts as soon as the audio has it (read ahead in the app), before any click.
    await act(async () => settle());
    const heardAtDown = heard.length;
    later(120);
    await act(async () => el.click());
    await act(async () => settle());
    return heardAtDown;
  };

  it("a press heard the instant it goes down: a menu's button opening it, an entry chosen; what follows not again", async () => {
    const stop = listenForSounds();
    const root = await mount(createElement(Menu));
    await press("trigger");
    await press("trigger");
    expect(heard).toEqual([]);
    useSounds.setState({ menus: true });
    // Heard before the click (on letting go) opened anything.
    expect(await press("trigger")).toBe(1);
    expect(heard).toEqual(["maximize_006"]);
    await press("entry");
    expect(heard).toEqual(["maximize_006", "click_001"]);
    // Another theme, another sound; the menu's button closing it, closing.
    document.documentElement.dataset.theme = "cp2077";
    await press("trigger");
    await press("trigger");
    expect(heard.slice(2)).toEqual(["maximize_008", "minimize_008"]);
    root.unmount();
    stop();
  });

  it("presses in quick succession each heard; a dialog a press opens, heard in the press", async () => {
    useSounds.setState({ menus: true });
    const stop = listenForSounds();
    const root = await mount(createElement("div", null, createElement("button", { id: "a" }, "A"), createElement("button", { id: "b" }, "B"), createElement(Opens)));
    await press("a");
    await press("b", 200);
    expect(heard).toEqual(["click_001", "click_001"]);
    await press("opens");
    expect(document.querySelector(".modal")).toBeTruthy();
    expect(heard).toEqual(["click_001", "click_001", "click_001"]);
    root.unmount();
    stop();
  });

  it("any button a click; one of sorting's (a folder's), none; one that can't be pressed, none", async () => {
    useSounds.setState({ menus: true, sorting: true });
    const stop = listenForSounds();
    const root = await mount(createElement("div", null, createElement("button", { id: "plain" }, "Plain"), createElement("button", { id: "filed", className: "target-btn" }, "Into a folder"), createElement("button", { id: "off", disabled: true }, "Off")));
    await press("plain");
    await press("filed");
    await press("off");
    expect(heard).toEqual(["click_001"]);
    root.unmount();
    stop();
  });

  it("each played deeper, softened, and faded in from nothing (no snap at its start)", async () => {
    useSounds.setState({ menus: true, volume: 0.5 });
    shaped.length = 0;
    const { cue } = await import("../lib/sounds");
    cue("open");
    await act(async () => settle());
    const pitch = shaped.find((x) => "pitch" in x)?.pitch;
    const filter = shaped.find((x) => "filter" in x)?.filter as { type: string; frequency: { value: number } };
    const ramp = shaped.find((x) => "ramp" in x)?.ramp as number[];
    expect(heard).toEqual(["maximize_006"]);
    expect(pitch).toBe(0.8);
    expect(filter.type).toBe("lowpass");
    expect(filter.frequency.value).toBe(2600);
    expect(ramp[0]).toBe(0);
    expect(ramp[1]).toBeCloseTo(0.5 * 0.5);
  });

  it("a press readies audio that waits for one, with a silent sample from the press itself", async () => {
    useSounds.setState({ menus: true });
    const stop = listenForSounds();
    FakeAudio.waiting = true;
    const before = FakeAudio.resumed;
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(FakeAudio.resumed).toBe(before + 1);
    expect(heard).toEqual(["silence"]);
    // Sounds off: a press leaves the audio alone.
    useSounds.setState({ menus: false });
    FakeAudio.waiting = true;
    document.body.dispatchEvent(new Event("keydown", { bubbles: true }));
    expect(FakeAudio.resumed).toBe(before + 1);
    FakeAudio.waiting = false;
    stop();
  });

  it("a dialog opening and closing by itself (keys, say), and a switch pressed (heard once)", async () => {
    useSounds.setState({ menus: true });
    const stop = listenForSounds();
    const root = await mount(createElement(Modal, { title: "A dialog", onClose: () => {}, children: createElement("input", { type: "checkbox", id: "box" }) }));
    await act(async () => settle());
    expect(heard).toEqual(["maximize_006"]);
    await press("box");
    later(1000);
    root.unmount();
    await act(async () => settle());
    expect(heard).toEqual(["maximize_006", "select_007", "minimize_006"]);
    stop();
  });

  it("sorting's: a rating, only with sorting sounds on; something going wrong, with the menus'", async () => {
    const item = { key: "a.jpg", primary: "/vol/a.jpg", files: ["/vol/a.jpg"], kind: "image", name: "a", dir: "", size: 1, modified: 0, hasRaw: false, hasVideo: false };
    useStore.setState({ root: "/vol", library: { version: 1, targets: [], ratings: {}, ids: {}, trashDir: "_deleted", albumRoots: [], albumRatings: {} }, toasts: [] } as never);
    useSounds.setState({ menus: true });
    useStore.getState().setRating(item as never, 7);
    await act(async () => settle());
    expect(heard).toEqual([]);
    useSounds.setState({ sorting: true });
    later(1000);
    useStore.getState().setRating(item as never, 8);
    later(1000);
    useStore.getState().toast("Couldn't move it", "error");
    await act(async () => settle());
    expect(heard).toEqual(["select_007", "error_008"]);
  });
});
