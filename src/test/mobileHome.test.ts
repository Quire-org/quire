import { beforeEach, describe, expect, it, vi } from "vitest";

// Each device's Home as the backend keeps it: "computer", "phone", "tablet".
const be = vi.hoisted(() => ({ docs: {} as Record<string, unknown> }));
vi.mock("../lib/platform", () => ({ IS_MOBILE: true, HOME_DEVICE: "phone", IS_MAC: false, thisComputer: "this computer" }));
vi.mock("../lib/api", () => ({
  api: {
    homeLoad: vi.fn(async (_root: string, device?: string) => be.docs[device ?? "computer"] ?? null),
    homeSave: vi.fn(async (_root: string, doc: unknown, device?: string) => {
      be.docs[device ?? "computer"] = doc;
    }),
  },
  storedPath: (r: string, p: string) => p.slice(r.length + 1),
  setCurrentRoot: () => {},
  fileSrc: (p: string) => p,
  mediaUrl: () => "",
  thumbUrl: () => "",
  canThumb: () => false,
}));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => p, invoke: vi.fn() }));

import { MOBILE_KINDS, emptyDoc, type Block, type HomeDoc } from "../home/board";
import { homeCols, useHome } from "../home/store";
import { useStore } from "../store";

const overlap = (a: Block, b: Block) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("a phone's Home", () => {
  beforeEach(() => {
    be.docs = {};
    useStore.setState({ root: "/r" });
    useHome.setState({ doc: emptyDoc(), docRoot: "/r", arranging: false, history: [] });
  });

  it("starts from a preset with only what a phone can show, packed into its columns", () => {
    useHome.getState().start("everything");
    const { blocks } = useHome.getState().doc!;
    expect(homeCols).toBe(6);
    expect(blocks.length).toBeGreaterThan(5);
    for (const b of blocks) {
      expect(MOBILE_KINDS).toContain(b.type);
      expect(b.x + b.w).toBeLessThanOrEqual(homeCols);
    }
    blocks.forEach((a, i) => blocks.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)));
  });

  it("keeps the other devices' Homes following what moved, and leaves their layout alone", async () => {
    const computer: HomeDoc = { ...emptyDoc(), blocks: [{ id: "a", type: "picture", x: 8, y: 3, w: 4, h: 4, pinned: "Old/pic.jpg" }] };
    be.docs.computer = computer;
    be.docs.tablet = { ...emptyDoc(), blocks: [], folders: { mode: "only", list: ["Old"] } };
    useHome.getState().follow([["Old", "New"]]);
    await tick();
    const after = be.docs.computer as HomeDoc;
    expect(after.blocks[0].pinned).toBe("New/pic.jpg");
    expect(after.blocks[0].x).toBe(8);
    expect((be.docs.tablet as HomeDoc).folders.list).toEqual(["New"]);
    expect(be.docs.phone).toBeUndefined();
  });

  it("takes what is gone off the other devices' Homes too", async () => {
    be.docs.computer = { ...emptyDoc(), blocks: [{ id: "a", type: "picture", x: 0, y: 0, w: 4, h: 4, pinned: "gone.jpg" }] };
    useHome.getState().forget((k) => k === "gone.jpg");
    await tick();
    expect((be.docs.computer as HomeDoc).blocks[0].pinned).toBeUndefined();
  });
});
