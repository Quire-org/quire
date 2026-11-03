/**
 * The app side of the plugin bridge. Each enabled plugin runs in a
 * sandboxed iframe (opaque origin, scripts only); this module identifies a
 * plugin by the frame a message came from, checks its permissions, and
 * performs the call. Nothing a plugin sends is trusted.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { albumPages, useStore } from "../store";
import { useEngine } from "./engine";
import { can, canFetch, canLogin } from "./permissions";
import { answer as findAnswer, libraryRoot, openLogin, provide as findProvide } from "./find";
import { usePlugins } from "./store";
import { useVersions } from "../versionsStore";
import { mayGoOnline, NOT_CONNECTED } from "../lib/online";
import { BUTTON_LOCATIONS, type ButtonLocation, type OverlayBox, type PanelControl, type PluginButton, type PluginInfo } from "./types";
import { paintMasks } from "./brush";
import { ask } from "../components/Confirm";
import type { MediaItem } from "../lib/types";

const frames = new Map<string, HTMLIFrameElement>();

export function registerFrame(id: string, el: HTMLIFrameElement | null) {
  if (el) frames.set(id, el);
  else frames.delete(id);
}

const loading = new Map<string, () => void>();

/** A plugin's frame has loaded, so its script has run: it gets what it starts with. */
export function frameLoaded(id: string) {
  const done = loading.get(id);
  loading.delete(id);
  void sendInit(id).finally(() => done?.());
}

/** When a plugin's frame next loads and has been started (false: not within 10 s). */
export function nextLoad(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      loading.delete(id);
      resolve(false);
    }, 10_000);
    loading.set(id, () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

export function frameUrl(id: string): string {
  // convertFileSrc gives the right form per platform (msplugin://localhost/ or http://msplugin.localhost/).
  const base = convertFileSrc("_", "msplugin").slice(0, -1);
  return `${base}${encodeURIComponent(id)}/__frame.html`;
}

function post(id: string, msg: unknown, transfer: Transferable[] = []) {
  const w = frames.get(id)?.contentWindow;
  if (w) w.postMessage(msg, "*", transfer);
}

export function sendEvent(id: string, name: string, payload: unknown, transfer: Transferable[] = []) {
  post(id, { type: "event", name, payload }, transfer);
}

/** An event for every plugin running. */
export function broadcast(name: string, payload: unknown) {
  for (const p of usePlugins.getState().list) if (p.state.enabled && p.manifest) sendEvent(p.id, name, payload);
}

export async function sendInit(id: string) {
  const p = usePlugins.getState().byId(id);
  if (!p?.manifest) return;
  post(id, {
    type: "init",
    info: {
      id,
      manifest: p.manifest,
      granted: [...grantedList(p)],
      settings: await settingsFor(p).catch(() => ({})),
      appVersion: "0.1.0",
      theme: useStore.getState().theme,
      mode: useStore.getState().mode,
    },
  });
}

function grantedList(p: PluginInfo): string[] {
  return p.manifest ? p.state.granted.filter((g) => p.manifest!.permissions.includes(g)) : [];
}

async function settingsFor(p: PluginInfo): Promise<Record<string, unknown>> {
  const saved = (await api.pluginSettingsGet(p.id)) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const s of p.manifest?.settings ?? []) out[s.key] = s.key in saved ? saved[s.key] : (s.default ?? (s.type === "boolean" ? false : ""));
  return out;
}

/* ---------- helpers exposed to the rest of the app ---------- */

/** What a plugin may learn about an item: everything but the path with media:read, the key otherwise. */
export function metaFor(p: PluginInfo, it: MediaItem) {
  if (!can(p, "media:read") || vaultBlocked(p)) return { key: it.key };
  return { key: it.key, name: it.name, kind: it.kind, dir: it.dir, albumKey: it.albumKey ?? null, size: it.size, modified: it.modified, hasRaw: it.hasRaw, hasVideo: it.hasVideo, encrypted: !!it.vaultId };
}

function vaultBlocked(p: PluginInfo): boolean {
  return !!useStore.getState().vault?.unlocked && !p.state.allowVault;
}

function requireMedia(p: PluginInfo, perm: "media:read" | "media:write") {
  need(p, perm);
  if (vaultBlocked(p)) throw new Error("this plugin is not allowed on encrypted folders (Settings → Plugins)");
}

function need(p: PluginInfo, perm: string) {
  if (can(p, perm)) return;
  const asked = p.manifest?.permissions.includes(perm);
  throw new Error(`permission "${perm}" was not granted${asked ? " (allow it with Reload in Settings → Plugins)" : ""}`);
}

/** Pages of albums a plugin listed with media.album, which aren't in the queue unless the album is open. */
const albumItems = new Map<string, MediaItem>();

function findItem(key: string): MediaItem {
  const s = useStore.getState();
  const it = s.queue.find((i) => i.key === key) ?? s.allItems.find((i) => i.key === key) ?? s.unsorted.find((i) => i.key === key) ?? albumItems.get(key);
  if (!it) throw new Error("unknown item");
  return it;
}

function mimeOf(it: MediaItem): string {
  if (it.kind === "raw") return "image/jpeg";
  const ext = it.primary.split(".").pop()?.toLowerCase() ?? "";
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif", avif: "image/avif", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp" }[ext] ?? "application/octet-stream";
}

/**
 * The item a plugin's result is for, as it was when the plugin read it (`was`: its size and time):
 * a long run (minutes of cleaning) can end after the picture moved and another took its key, and
 * the result must not land on that other picture.
 */
function sameItem(it: MediaItem, was: unknown): MediaItem {
  if (was && typeof was === "object") {
    const w = was as { size?: unknown; modified?: unknown };
    if ((typeof w.size === "number" && w.size !== it.size) || (typeof w.modified === "number" && w.modified !== it.modified)) throw new Error(`${it.key} isn't the picture this was made from any more`);
  }
  return it;
}

function str(v: unknown, max: number, field: string): string {
  if (typeof v !== "string" || !v.length || v.length > max) throw new Error(`${field} must be a string of 1-${max} characters`);
  return v;
}

function clamp01(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function cleanIcon(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== "string" || v.length > 10_000 || !/^\s*<svg[\s>]/i.test(v)) throw new Error("icon must be SVG markup under 10 kB");
  return v;
}

/* ---------- dispatch ---------- */

export async function dispatch(p: PluginInfo, method: string, args: Record<string, unknown> | null): Promise<unknown> {
  const a = args ?? {};
  const st = useStore.getState();
  const ps = usePlugins.getState();
  switch (method) {
    case "log":
      ps.log(p.id, String(a.level ?? "info"), String(a.message ?? ""));
      void api.pluginLog(p.id, String(a.level ?? "info"), String(a.message ?? "")).catch(() => {});
      return null;

    case "ui.toast":
      st.toast(`${p.manifest!.name}: ${String(a.text ?? "").slice(0, 300)}`, (["info", "ok", "warn", "error"].includes(String(a.tone)) ? a.tone : "info") as "info");
      return null;

    case "ui.addButton": {
      const location = a.location as ButtonLocation;
      if (!BUTTON_LOCATIONS.includes(location)) throw new Error(`location must be one of ${BUTTON_LOCATIONS.join(", ")}`);
      const btn: PluginButton = { pluginId: p.id, id: str(a.id, 40, "id"), location, label: str(a.label, 40, "label"), tooltip: typeof a.tooltip === "string" ? a.tooltip.slice(0, 160) : undefined, icon: cleanIcon(a.icon) };
      if (ps.buttons.filter((b) => b.pluginId === p.id).length >= 12) throw new Error("a plugin may add at most 12 buttons");
      ps.setButtons((list) => [...list.filter((b) => !(b.pluginId === p.id && b.id === btn.id)), btn]);
      return null;
    }
    case "ui.updateButton": {
      const id = str(a.id, 40, "id");
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      ps.setButtons((list) =>
        list.map((b) =>
          b.pluginId === p.id && b.id === id
            ? {
                ...b,
                ...(patch.label !== undefined ? { label: str(patch.label, 40, "label") } : {}),
                ...(patch.tooltip !== undefined ? { tooltip: String(patch.tooltip).slice(0, 160) } : {}),
                ...(patch.icon !== undefined ? { icon: cleanIcon(patch.icon) } : {}),
                ...(patch.active !== undefined ? { active: !!patch.active } : {}),
                ...(patch.busy !== undefined ? { busy: !!patch.busy } : {}),
              }
            : b,
        ),
      );
      return null;
    }
    case "ui.removeButton": {
      const id = String(a.id);
      ps.setButtons((list) => list.filter((b) => !(b.pluginId === p.id && b.id === id)));
      return null;
    }
    case "ui.progress": {
      const id = str(a.id, 40, "id");
      if (a.task == null) {
        ps.setTask(p.id, id, null);
        return null;
      }
      const t = a.task as Record<string, unknown>;
      if (!ps.tasks.some((x) => x.pluginId === p.id && x.id === id) && ps.tasks.filter((x) => x.pluginId === p.id).length >= 3) throw new Error("a plugin may show at most 3 tasks");
      const count = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
      const itemKey = typeof t.item === "string" && t.item.length <= 4096 ? t.item : undefined;
      ps.setTask(p.id, id, { label: str(t.label, 80, "label"), done: count(t.done), total: count(t.total), detail: typeof t.detail === "string" ? t.detail.slice(0, 160) : "", pausable: t.pausable === true, ...(itemKey ? { itemKey } : {}) });
      return null;
    }

    case "overlay.set": {
      need(p, "overlay");
      const itemKey = str(a.itemKey, 4096, "itemKey");
      const raw = Array.isArray(a.boxes) ? a.boxes : [];
      if (raw.length > 400) throw new Error("at most 400 boxes");
      // Images are checked before any becomes a URL, so a bad box leaves nothing behind.
      const images = raw.map((b: Record<string, unknown>) => (b.image == null ? null : overlayImage(b.image, b.mime)));
      if (images.filter(Boolean).length > 4) throw new Error("at most 4 image boxes");
      const boxes: OverlayBox[] = raw.map((b: Record<string, unknown>, i) => {
        const box: OverlayBox = { x: clamp01(b.x), y: clamp01(b.y), w: clamp01(b.w), h: clamp01(b.h), text: String(b.text ?? "").slice(0, 2000), vertical: !!b.vertical, ...(b.outline ? { outline: true } : {}) };
        const img = images[i];
        return img ? { ...box, text: "", image: URL.createObjectURL(img) } : box;
      });
      ps.setOverlay(itemKey, p.id, boxes);
      return null;
    }
    case "overlay.clear":
      need(p, "overlay");
      ps.clearOverlays(p.id, typeof a.itemKey === "string" ? a.itemKey : null);
      return null;

    case "viewer.current": {
      requireMedia(p, "media:read");
      const cur = st.screen === "viewer" ? st.queue[st.index] : undefined;
      return cur ? metaFor(p, cur) : null;
    }
    case "viewer.next":
      need(p, "viewer");
      st.next();
      return null;
    case "viewer.prev":
      need(p, "viewer");
      st.prev();
      return null;
    case "ui.panel": {
      // The plugin's panel at the right of the viewer: replaced whole each time.
      const raw = Array.isArray(a.controls) ? a.controls : [];
      if (raw.length > 24) throw new Error("a panel may have at most 24 controls");
      const options = (v: unknown, what: string) =>
        Array.isArray(v)
          ? v.slice(0, 8).map((c) => {
              const o = (c ?? {}) as Record<string, unknown>;
              return { id: str(o.id, 20, `${what} id`), label: str(o.label, 24, `${what} label`) };
            })
          : [];
      const controls: PanelControl[] = raw.map((c: Record<string, unknown>) => {
        const id = () => str(c.id, 40, "control id");
        switch (c.type) {
          case "heading":
            return { type: "heading", label: str(c.label, 60, "heading") };
          case "text":
            return { type: "text", text: String(c.text ?? "").slice(0, 400) };
          case "button":
            return { type: "button", id: id(), label: str(c.label, 40, "label"), tooltip: typeof c.tooltip === "string" ? c.tooltip.slice(0, 160) : undefined, primary: !!c.primary, active: !!c.active, busy: !!c.busy, disabled: !!c.disabled };
          case "toggle":
            return { type: "toggle", id: id(), label: str(c.label, 60, "label"), value: !!c.value, disabled: !!c.disabled };
          case "choice": {
            const opts = options(c.options, "option");
            return { type: "choice", id: id(), label: String(c.label ?? "").slice(0, 40), options: opts, value: typeof c.value === "string" && opts.some((o) => o.id === c.value) ? c.value : (opts[0]?.id ?? null), disabled: !!c.disabled };
          }
          case "input":
            return { type: "input", id: id(), label: String(c.label ?? "").slice(0, 40), value: String(c.value ?? "").slice(0, 200), placeholder: typeof c.placeholder === "string" ? c.placeholder.slice(0, 60) : undefined };
          case "colour":
            need(p, "viewer");
            return { type: "colour", id: id(), label: String(c.label ?? "").slice(0, 40), value: typeof c.value === "string" && HEX.test(c.value) ? c.value.toLowerCase() : null };
          case "brush": {
            need(p, "viewer");
            const modes = options(c.modes, "mode");
            return { type: "brush", id: id(), modes, mode: typeof c.mode === "string" && modes.some((m) => m.id === c.mode) ? c.mode : (modes[0]?.id ?? null), hint: typeof c.hint === "string" ? c.hint.slice(0, 300) : undefined };
          }
          default:
            throw new Error(`unknown control type ${String(c.type)}`);
        }
      });
      if (controls.filter((c) => c.type === "brush").length > 1) throw new Error("a panel may have one brush");
      ps.setPanel(p.id, { pluginId: p.id, title: String(a.title ?? "").slice(0, 60), icon: cleanIcon(a.icon), controls });
      return null;
    }
    case "ui.panelPatch": {
      const id = str(a.id, 40, "id");
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      const allowed: Record<string, unknown> = {};
      for (const k of ["label", "tooltip", "hint", "text"]) if (typeof patch[k] === "string") allowed[k] = (patch[k] as string).slice(0, k === "text" ? 400 : 160);
      for (const k of ["primary", "active", "busy", "disabled"]) if (patch[k] !== undefined) allowed[k] = !!patch[k];
      if (patch.value !== undefined) allowed.value = typeof patch.value === "boolean" ? patch.value : String(patch.value);
      if (typeof patch.mode === "string") allowed.mode = patch.mode;
      ps.patchControl(p.id, id, allowed as Partial<PanelControl>);
      return null;
    }
    case "ui.panelOpen":
      if (a.open && !ps.panels[p.id]) throw new Error("the plugin has no panel");
      ps.setPanelOpen(a.open ? p.id : ps.panelOpen === p.id ? null : ps.panelOpen);
      return null;
    case "ui.brushClear":
      if (ps.panelOpen === p.id) ps.setBrush((b) => ({ ...b, strokes: [] }));
      return null;
    case "viewer.setDirection": {
      need(p, "viewer");
      const dir = a.dir === "rtl" ? "rtl" : "ltr";
      ps.setDirection(p.id, dir, typeof a.albumKey === "string" ? a.albumKey : null);
      return null;
    }

    case "media.list":
      requireMedia(p, "media:read");
      return st.queue.slice(0, 5000).map((it) => metaFor(p, it));
    case "media.albums": {
      // Every album in the opened folder, so a plugin can offer them (another version of this one, say).
      requireMedia(p, "media:read");
      if (vaultBlocked(p)) return [];
      const albums = st.albumsLoaded ? st.albums : await st.loadAlbums();
      const links = st.library?.albumTranslations ?? {};
      const langs = st.library?.albumLanguages ?? {};
      return albums.slice(0, 5000).map((al) => ({ key: al.key, name: al.name, count: al.count, modified: al.modified, translation: links[al.key] ?? null, language: langs[al.key] ?? null }));
    }
    case "media.album": {
      requireMedia(p, "media:read");
      const key = str(a.albumKey, 4096, "albumKey");
      const album = st.albums.find((x) => x.key === key);
      if (!album) throw new Error("unknown album");
      if (!st.root) throw new Error("no folder is open");
      const items = await albumPages(st.root, album);
      for (const it of items) albumItems.set(it.key, it);
      return items.slice(0, 5000).map((it) => metaFor(p, it));
    }
    case "media.readImage": {
      requireMedia(p, "media:read");
      const it = findItem(str(a.itemKey, 4096, "itemKey"));
      if (it.kind === "video") throw new Error("videos are not supported by readImage");
      if (!st.root) throw new Error("no folder is open");
      const bytes = await api.readMediaImage(st.root, it.primary);
      return { bytes, mime: mimeOf(it) };
    }
    case "engine.languageModel": {
      need(p, "engine");
      return chosenModel();
    }
    case "engine.run": {
      // The plugin's own pipeline (its manifest's "engine": a WebAssembly module) on a picture.
      requireMedia(p, "media:read");
      need(p, "engine");
      const it = findItem(str(a.itemKey, 4096, "itemKey"));
      if (it.kind === "video") throw new Error("the engine works on pictures, not videos");
      if (!st.root) throw new Error("no folder is open");
      const options = plainOptions(a.options ?? {});
      if (JSON.stringify(options).length > 32 << 20) throw new Error("the options are too large (32 MB at most)");
      const r = await api.pluginEngineRun(p.id, st.root, it.primary, options).catch(needModels);
      return { bytes: r.pngBase64 ? fromBase64(r.pngBase64).buffer : null, mime: r.pngBase64 ? "image/png" : null, width: r.width, height: r.height, result: r.result, seconds: r.seconds };
    }
    case "media.save": {
      requireMedia(p, "media:write");
      const it = sameItem(findItem(str(a.itemKey, 4096, "itemKey")), a.was);
      return saveNextTo(it, str(a.name, 200, "name"), String(a.base64 ?? ""), madeBy(p.id, a.note));
    }
    case "media.keep": {
      // The reader decides in the app's own dialog: a new file, or in place of the original (which is kept, for Revert).
      requireMedia(p, "media:write");
      const it = sameItem(findItem(str(a.itemKey, 4096, "itemKey")), a.was);
      const name = str(a.name, 200, "name");
      const base64 = String(a.base64 ?? "");
      if (!base64) throw new Error("nothing to save");
      const by = madeBy(p.id, a.note);
      // A plugin whose own panel offers the two may say which; otherwise the app asks.
      if (a.choice === "copy") return saveNextTo(it, name, base64, by);
      if (a.choice === "replace") return replaceWith(it, name, base64, by);
      if (ps.keeping) throw new Error("the reader is already deciding about a result");
      return new Promise((resolve, reject) => {
        keepWaiting = { item: it, name, base64, by, resolve, reject };
        ps.setKeeping({ pluginId: p.id, itemKey: it.key, name, busy: false });
      });
    }

    case "media.revert": {
      // A version this plugin made, its original kept: the original back in its place, as Revert in
      // Info does. Only its own: a plugin never reverts what the reader or another plugin made.
      requireMedia(p, "media:write");
      const it = findItem(str(a.itemKey, 4096, "itemKey"));
      const root = useStore.getState().root;
      if (!root) throw new Error("no folder is open");
      const v = await api.versionInfo(root, it.primary);
      if (!v.link || v.link.by !== p.id) throw new Error("this picture isn't a version the plugin made");
      if (!v.kept) throw new Error("its original isn't kept, so there is nothing to put back");
      return { reverted: await useStore.getState().revertItem(it) };
    }

    case "media.versions": {
      // What the app knows of an item as a version: what it was made from, and what was made from it
      // (still in the library); `mine` when the asking plugin made it.
      requireMedia(p, "media:read");
      const it = findItem(str(a.itemKey, 4096, "itemKey"));
      const root = useStore.getState().root;
      if (!root) throw new Error("no folder is open");
      const v = await api.versionInfo(root, it.primary);
      return {
        madeFrom: v.link ? { name: v.link.fromName, note: v.link.note, mine: v.link.by === p.id, kept: !!v.kept } : null,
        made: v.versions.filter((m) => m.path).map((m) => ({ name: m.link.madeAt.split("/").pop(), note: m.link.note, mine: m.link.by === p.id })),
      };
    }

    case "home.share": {
      // Its part of a panel plugins fill together on the Home; null takes it away.
      const panel = str(a.panel, 40, "panel");
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(panel)) throw new Error("a shared panel's name is lowercase words with dashes, like new-from-followed");
      if (a.spec == null) {
        ps.setShared(panel, p.id, null);
        return null;
      }
      const spec = a.spec as Record<string, unknown>;
      const raw = (Array.isArray(spec.items) ? spec.items : []) as Record<string, unknown>[];
      if (raw.length > 60) throw new Error("a part of a shared panel holds at most 60 things");
      // Images are checked before any becomes a URL, so a bad one leaves nothing behind.
      const images = raw.map((it) => (it.image == null ? null : sharedImage(it.image, it.mime)));
      const items = raw.map((it, i) => {
        const img = images[i];
        return {
          id: str(it.id, 80, "id"),
          title: typeof it.title === "string" ? it.title.slice(0, 120) : "",
          ...(typeof it.thumb === "string" && it.thumb.startsWith("https://") ? { thumb: it.thumb.slice(0, 2048) } : {}),
          ...(img ? { image: URL.createObjectURL(img) } : {}),
          ...(typeof it.work === "string" && it.work ? { work: it.work.slice(0, 120) } : {}),
        };
      });
      ps.setShared(panel, p.id, { title: typeof spec.title === "string" && spec.title.trim() ? spec.title.slice(0, 60) : panel, items });
      return null;
    }

    case "dupes.versions": {
      // Versions of pictures it writes: what it saved is what it may vouch for.
      need(p, "media:write");
      if (a.spec == null) {
        ps.setDupeVersions(p.id, null);
        return null;
      }
      const v = a.spec as Record<string, unknown>;
      const keys = Array.isArray(v.keys) ? v.keys.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 4096).slice(0, 50_000) : [];
      const prefix = typeof v.prefix === "string" && v.prefix.trim() ? v.prefix.slice(0, 40) : undefined;
      if (!prefix && !keys.length && !Array.isArray(v.keys)) throw new Error("dupes.versions needs a prefix or keys");
      ps.setDupeVersions(p.id, { pluginId: p.id, id: str(v.id, 40, "id"), label: str(v.label, 60, "label"), tooltip: typeof v.tooltip === "string" ? v.tooltip.slice(0, 240) : undefined, prefix, keys, note: typeof v.note === "string" && v.note.trim() ? v.note.slice(0, 24) : "edited" });
      return null;
    }

    case "storage.all":
      need(p, "storage");
      return api.pluginStorageGet(p.id);
    case "storage.set":
      need(p, "storage");
      await api.pluginStorageSet(p.id, str(a.key, 200, "key"), a.value ?? null);
      return null;

    case "settings.get":
      return settingsFor(p);

    case "library.get":
      need(p, "library:storage");
      return api.pluginLibraryGet(p.id, libraryRoot(), ownKey(str(a.key, 200, "key")));
    case "library.set":
      need(p, "library:storage");
      await api.pluginLibrarySet(p.id, libraryRoot(), ownKey(str(a.key, 200, "key")), a.value ?? null);
      return null;

    case "find.provide":
      need(p, "find");
      findProvide(p, a);
      return null;
    case "find.answer":
      need(p, "find");
      findAnswer(p, a);
      return null;

    case "login.open": {
      if (!mayGoOnline(p.id)) throw new Error(NOT_CONNECTED);
      const url = str(a.url, 4096, "url");
      if (!canLogin(p, url)) throw new Error(`not allowed to open a sign-in page on ${(() => { try { return new URL(url).hostname; } catch { return url; } })()}`);
      const until = (Array.isArray(a.until) ? a.until : []).filter((u): u is string => typeof u === "string" && u.length >= 8 && u.length <= 400).slice(0, 4);
      if (!until.length) throw new Error("login.open needs `until`: where the sign-in sends you back");
      // Cookies only for addresses the plugin may contact anyway: then the answer is { url, cookies }.
      const cookies = (Array.isArray(a.cookies) ? a.cookies : []).filter((u): u is string => typeof u === "string").slice(0, 4);
      for (const c of cookies) if (!canFetch(p, c)) throw new Error(`not allowed to keep cookies for ${c}`);
      const back = await openLogin(p, url, until, typeof a.name === "string" && a.name.trim() ? a.name.slice(0, 40) : (p.manifest?.name ?? p.id), cookies);
      return cookies.length ? back : (back?.url ?? null);
    }

    case "login.check": {
      if (!mayGoOnline(p.id)) throw new Error(NOT_CONNECTED);
      const url = str(a.url, 4096, "url");
      if (!canLogin(p, url)) throw new Error(`not allowed to open ${hostOf(url)}`);
      const name = typeof a.name === "string" && a.name.trim() ? a.name.slice(0, 60) : hostOf(url);
      st.toast(`${name} asks something first: answer it in its window, then press Done there`, "ok");
      return api.pluginCheck(p.id, url, name);
    }

    case "sites.list":
      need(p, "sites");
      return usePlugins.getState().sites[p.id] ?? [];
    case "sites.add": {
      need(p, "sites");
      const domain = siteDomain(str(a.url, 2048, "url"));
      if (!domain) throw new Error("that isn't a site's address: a site is named by its domain (like example.net), not by an IP address or a port. An address like 192.168.1.5 could reach devices on your own network, and says nothing when you look over what a plugin may contact.");
      const have = usePlugins.getState().sites[p.id] ?? [];
      if (have.includes(domain)) return domain;
      const name = p.manifest?.name ?? p.id;
      const yes = await ask({
        title: `Let ${name} use ${domain}?`,
        message: `${name} may then contact ${domain} and its subdomains (where its pictures are), and open it in a window of its own to pass its browser check. Allowed for this library, and kept with it (in its vault when it has one); Settings → Plugins lists the sites, to remove.`,
        confirm: `Allow ${domain}`,
      });
      if (!yes) return null;
      await usePlugins.getState().setSites(p.id, [...have, domain]);
      return domain;
    }
    case "sites.remove": {
      need(p, "sites");
      const domain = str(a.domain, 253, "domain").toLowerCase();
      await usePlugins.getState().setSites(p.id, (usePlugins.getState().sites[p.id] ?? []).filter((d) => d !== domain));
      return null;
    }

    case "net.browse": {
      if (!mayGoOnline(p.id)) throw new Error(NOT_CONNECTED);
      const url = str(a.url, 8192, "url");
      if (!canLogin(p, url)) throw new Error(`not allowed to open ${hostOf(url)}`);
      return api.pluginBrowse(p.id, url, typeof a.cookies === "string" ? a.cookies.slice(0, 16384) : null);
    }

    case "net.fetch": {
      // Asking before going online: nothing leaves until the reader said Connect.
      if (!mayGoOnline(p.id)) throw new Error(NOT_CONNECTED);
      const url = str(a.url, 8192, "url");
      if (!canFetch(p, url)) throw new Error(`not allowed to contact ${(() => { try { return new URL(url).hostname; } catch { return url; } })()}`);
      const method = String(a.method ?? "GET").toUpperCase();
      if (!/^[A-Z]{1,16}$/.test(method)) throw new Error("not a request method");
      const headers = fetchHeaders(a.headers);
      const bodyBase64 = typeof a.bodyBase64 === "string" ? a.bodyBase64 : null;
      if (bodyBase64 && bodyBase64.length > 22 << 20) throw new Error("the body is too large (16 MB at most)");
      const body = bodyBase64 || a.body == null ? null : String(a.body);
      if (body && body.length > 16 << 20) throw new Error("the body is too large (16 MB at most)");
      return api.pluginFetch(p.id, { url, method, headers, body, bodyBase64 });
    }

    default:
      throw new Error(`unknown method ${method}`);
  }
}

/** A request's headers as a plugin may send them: a few, each a line of text under a plain name. */
function fetchHeaders(v: unknown): Record<string, string> {
  if (v == null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("headers must be an object of strings");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 32) throw new Error("too many headers (32 at most)");
  const out: Record<string, string> = {};
  for (const [k, val] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(k)) throw new Error(`not a header name: ${k.slice(0, 40)}`);
    if (typeof val !== "string" || val.length > 8192 || /[\r\n\0]/.test(val)) throw new Error(`the ${k} header must be one line of text (8 KB at most)`);
    out[k] = val;
  }
  return out;
}

/** A key of a plugin's library store: never one of the app's own there (as `__sites`). */
function ownKey(key: string): string {
  if (key.startsWith("__")) throw new Error("keys starting with __ are the app's");
  return key;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** A site's domain from its address (without "www."), as a plugin is allowed it; null when it isn't one. */
function siteDomain(url: string): string | null {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return (u.protocol === "https:" || u.protocol === "http:") && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !/^[\d.]+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/* ---------- the local engine ---------- */

/**
 * The engine refuses a page whose models aren't downloaded ("not downloaded:
 * base, manga-ocr"). Nothing downloads without the user choosing it, so
 * Local models opens with those marked.
 */
function needModels(err: unknown): never {
  const m = /not downloaded: (.+)/.exec(String(err));
  if (!m) throw err;
  useEngine.getState().open(m[1].split(",").map((s) => s.trim()));
  throw new Error("some models aren't downloaded yet. Download the ones marked “needed” in Local models.");
}

/** A plugin's options as JSON for its pipeline: bytes (a brush's mask, say) become base64 text, functions and the like go. */
function plainOptions(v: unknown, depth = 0): unknown {
  if (depth > 24) throw new Error("the options are nested too deeply");
  if (v instanceof ArrayBuffer) return toBase64(new Uint8Array(v));
  if (ArrayBuffer.isView(v)) return toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  if (Array.isArray(v)) return v.map((x) => plainOptions(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainOptions(x, depth + 1)]));
  return typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v === null ? v : null;
}

const HEX = /^#[0-9a-f]{6}$/i;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Who made a version, and what the plugin calls it ("cleaned"): said with the save, or its duplicate check's word. */
interface MadeBy {
  by: string;
  note: string | null;
}
function madeBy(pluginId: string, note: unknown): MadeBy {
  const said = typeof note === "string" && note.trim() ? note.trim().slice(0, 24) : null;
  return { by: pluginId, note: said ?? usePlugins.getState().dupeVersions[pluginId]?.note ?? null };
}

let keepWaiting: { item: MediaItem; name: string; base64: string; by: MadeBy; resolve: (value: unknown) => void; reject: (e: unknown) => void } | null = null;

/** A plugin's result saved beside the item it was made from, linked to it as its version. */
async function saveNextTo(it: MediaItem, name: string, base64: string, made: MadeBy) {
  const st = useStore.getState();
  if (!st.root) throw new Error("no folder is open");
  const dir = it.primary.slice(0, it.primary.lastIndexOf("/"));
  const path = await api.writeMediaFile(st.root, dir, name, base64, { from: it.primary, ...made });
  st.set({ allStale: true, albumsLoaded: false });
  void st.rescan(true);
  void useVersions.getState().load(true);
  return { name: path.split("/").pop(), key: `${it.key.slice(0, it.key.lastIndexOf("/") + 1)}${path.split("/").pop()}`, replaced: false };
}

/**
 * The item replaced by a plugin's version of it: the original is kept (Revert in Info), the new file
 * takes its place under its name (with the new file's extension), so an album's pages stay in order.
 */
async function replaceWith(it: MediaItem, name: string, base64: string, made: MadeBy) {
  const st = useStore.getState();
  if (!st.root || !st.library) throw new Error("no folder is open");
  const own = (it.primary.split("/").pop() ?? name).replace(/\.[^.]+$/, "") + (/\.[^.]+$/.exec(name)?.[0] ?? "");
  const r = await api.replaceMediaFile(st.root, st.library, it, own, base64, made.by, made.note);
  st.absorbEdit(it, r.item, true);
  void useVersions.getState().load(true);
  return { name: r.item.name, key: r.item.key, replaced: true };
}

/** The reader answered the dialog for `media.keep`: a copy, the original replaced, or neither. */
export async function finishKeep(choice: "copy" | "replace" | null) {
  const w = keepWaiting;
  const ps = usePlugins.getState();
  if (!w) return;
  if (!choice) {
    keepWaiting = null;
    ps.setKeeping(null);
    w.resolve(null);
    return;
  }
  ps.setKeeping(ps.keeping && { ...ps.keeping, busy: true });
  try {
    if (choice === "copy") {
      w.resolve(await saveNextTo(w.item, w.name, w.base64, w.by));
    } else {
      w.resolve(await replaceWith(w.item, w.name, w.base64, w.by));
    }
  } catch (e) {
    w.reject(e);
  } finally {
    keepWaiting = null;
    usePlugins.getState().setKeeping(null);
  }
}

/** A panel control was used: the plugin hears it; toggles and choices show the new value at once. */
export function panelAction(pluginId: string, id: string, value?: unknown) {
  const ps = usePlugins.getState();
  const panel = ps.panels[pluginId];
  const control = panel?.controls.find((c) => "id" in c && c.id === id);
  if (!control) return;
  if (control.type === "toggle" || control.type === "choice") ps.patchControl(pluginId, id, { value } as Partial<PanelControl>);
  if (control.type === "input") ps.patchControl(pluginId, id, { value: String(value ?? "").slice(0, 200) } as Partial<PanelControl>);
  if (control.type === "brush" && typeof value === "string") ps.patchControl(pluginId, id, { mode: value } as Partial<PanelControl>);
  if (control.type === "colour") ps.patchControl(pluginId, id, { value: typeof value === "string" ? value : null } as Partial<PanelControl>);
  sendEvent(pluginId, "panel", { id, value: value ?? null });
}

const bitmaps = new Map<string, Promise<ImageBitmap | null>>();

/** The colour of the image shown at (x, y), fractions of it: "#rrggbb", read from the file itself. */
export async function colourAt(x: number, y: number): Promise<string | null> {
  const st = useStore.getState();
  const cur = st.screen === "viewer" ? st.queue[st.index] : undefined;
  if (!cur || !st.root) return null;
  if (!bitmaps.has(cur.key)) {
    if (bitmaps.size > 3) bitmaps.clear();
    bitmaps.set(
      cur.key,
      api
        .readMediaImage(st.root, cur.primary)
        .then((buf) => createImageBitmap(new Blob([buf])))
        .catch(() => null),
    );
  }
  const bmp = await bitmaps.get(cur.key)!;
  if (!bmp) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // The one pixel under the click, drawn alone so a page-sized canvas is never needed.
  const px = Math.min(bmp.width - 1, Math.max(0, Math.floor(x * bmp.width)));
  const py = Math.min(bmp.height - 1, Math.max(0, Math.floor(y * bmp.height)));
  ctx.drawImage(bmp, px, py, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The brush's strokes changed: the plugin gets what is painted, as PNG masks and shapes per mode. */
let brushSerial = 0;

export async function brushChanged(pluginId: string, id: string) {
  const serial = ++brushSerial;
  const b = usePlugins.getState().brush;
  const masks = await paintMasks(b.strokes, b.aspect);
  const shapes: Record<string, { x: number; y: number }[][]> = {};
  for (const s of b.strokes) (shapes[s.mode ?? ""] ??= []).push(s.points);
  // Strokes changed again while painting: that call tells, this one would be stale.
  if (serial !== brushSerial || usePlugins.getState().brush.strokes !== b.strokes) return;
  sendEvent(pluginId, "stroke", { id, itemKey: b.itemKey, masks, shapes, serial, count: b.strokes.length }, Object.values(masks).map((m) => m.buffer as ArrayBuffer));
}

const OVERLAY_MIME = ["image/png", "image/jpeg", "image/webp"];

/** A plugin's image for an overlay box: bytes of a PNG, JPEG or WebP, up to 64 MB. */
/** A shared thing's own picture: a small image, as bytes. */
function sharedImage(data: unknown, mime: unknown): Blob {
  const type = typeof mime === "string" && OVERLAY_MIME.includes(mime) ? mime : null;
  if (!type) throw new Error(`a shared image's mime must be one of ${OVERLAY_MIME.join(", ")}`);
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!bytes) throw new Error("a shared image must be an ArrayBuffer or Uint8Array");
  if (bytes.byteLength > 300 * 1024) throw new Error("a shared image may be at most 300 KB");
  return new Blob([bytes], { type });
}

function overlayImage(data: unknown, mime: unknown): Blob {
  const type = typeof mime === "string" && OVERLAY_MIME.includes(mime) ? mime : null;
  if (!type) throw new Error(`an overlay image's mime must be one of ${OVERLAY_MIME.join(", ")}`);
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!bytes) throw new Error("an overlay image must be an ArrayBuffer or Uint8Array");
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error("an overlay image may be at most 64 MB");
  return new Blob([bytes], { type });
}

/** The language model the engine's text tools use when a pipeline names none. */
async function chosenModel(): Promise<{ id: string; name: string } | null> {
  if (!useEngine.getState().catalog) await useEngine.getState().refresh();
  const c = useEngine.getState().catalog;
  const m = c?.models.find((x) => x.id === c.chosen);
  return m ? { id: m.id, name: m.name } : null;
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/* ---------- message bus ---------- */

function idOf(source: MessageEventSource | null): string | null {
  for (const [id, f] of frames) if (f.contentWindow === source) return id;
  return null;
}

async function onMessage(e: MessageEvent) {
  const id = idOf(e.source);
  if (!id) return;
  const m = e.data as { type?: string; id?: number; method?: string; args?: Record<string, unknown> | null };
  if (!m || typeof m !== "object") return;
  if (m.type === "hello") return void sendInit(id);
  if (m.type !== "call" || typeof m.id !== "number" || typeof m.method !== "string") return;
  const p = usePlugins.getState().byId(id);
  if (!p?.manifest || !p.state.enabled) return;
  try {
    const value = await dispatch(p, m.method, m.args ?? null);
    const transfer = value && typeof value === "object" && (value as { bytes?: unknown }).bytes instanceof ArrayBuffer ? [(value as { bytes: ArrayBuffer }).bytes] : [];
    post(id, { type: "result", id: m.id, ok: true, value }, transfer);
  } catch (err) {
    post(id, { type: "result", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

let installed = false;
let lastItemKey: string | null = null;

/** Install the message listener and the viewer-item broadcast once. */
export function installHost() {
  if (installed) return;
  installed = true;
  window.addEventListener("message", (e) => void onMessage(e));
  // The engine says which stage a page is in; the plugin that asked can show it.
  void listen<{ plugin: string; task: string; stage: string; state: string; model: string | null; done: number | null; total: number | null }>("engine-progress", (e) => {
    const { plugin, task, ...progress } = e.payload;
    sendEvent(plugin, "engine", progress);
  });
  // Plugins with a pipeline hear when the user chooses another language model.
  let chosen: string | undefined;
  useEngine.subscribe((e) => {
    const next = e.catalog?.chosen;
    if (!next || next === chosen) return;
    const first = chosen === undefined;
    chosen = next;
    if (first) return;
    const name = e.catalog?.models.find((m) => m.id === next)?.name ?? next;
    for (const p of usePlugins.getState().list) {
      if (p.state.enabled && can(p, "engine")) sendEvent(p.id, "model", { id: next, name });
    }
  });
  useStore.subscribe((s) => {
    const cur = s.screen === "viewer" ? s.queue[s.index] : undefined;
    const key = cur?.key ?? null;
    if (key === lastItemKey) return;
    lastItemKey = key;
    // Strokes belong to the image they were painted on.
    usePlugins.getState().setBrush((b) => (b.itemKey === key ? b : { ...b, itemKey: key, strokes: [] }));
    for (const p of usePlugins.getState().list) {
      if (!p.state.enabled || !p.manifest) continue;
      sendEvent(p.id, "item", cur ? { item: metaFor(p, cur) } : { item: null });
    }
  });
}

/** A plugin button was clicked: tell its plugin, with context it is allowed to see. */
export function clickButton(btn: PluginButton, context: { item?: MediaItem; items?: MediaItem[]; album?: { key: string; name: string; count: number } }) {
  const p = usePlugins.getState().byId(btn.pluginId);
  if (!p) return;
  const payload: Record<string, unknown> = { id: btn.id, location: btn.location };
  if (context.item) payload.item = metaFor(p, context.item);
  if (context.items) payload.items = context.items.slice(0, 5000).map((i) => metaFor(p, i));
  if (context.album) payload.album = can(p, "media:read") && !vaultBlocked(p) ? context.album : { key: context.album.key };
  sendEvent(p.id, "button", payload);
}

/** Cancel on a task's pill: the plugin hears it and stops when it can. */
export function cancelTask(pluginId: string, id: string) {
  usePlugins.getState().setTask(pluginId, id, { stopping: true });
  sendEvent(pluginId, "cancel", { id });
}

/** Activity's Pause / Resume on a plugin's job (one it said can pause): the plugin gets "pause". */
export function pauseTask(pluginId: string, id: string, paused: boolean) {
  usePlugins.getState().setTask(pluginId, id, { paused });
  sendEvent(pluginId, "pause", { id, paused });
}

export function notifySettings(id: string, values: Record<string, unknown>) {
  sendEvent(id, "settings", values);
}

// A plugin is told when its panel opens and closes (from the viewer's bar, Esc, its X, or Edit
// opening): it may start the panel afresh each time.
usePlugins.subscribe((s, prev) => {
  if (s.panelOpen === prev.panelOpen) return;
  if (prev.panelOpen) sendEvent(prev.panelOpen, "panelopen", { open: false });
  if (s.panelOpen) sendEvent(s.panelOpen, "panelopen", { open: true });
});

// Another library (or none): what plugins showed of the last one goes (overlays and reading
// directions by its keys, their parts of the Home, a result waiting to be kept, the brush, an open
// panel). Leaving a library for another, plugins start again, so nothing one keeps in memory (a
// platform's sign-in, kept with the library) carries over.
useStore.subscribe((s, prev) => {
  if (s.root === prev.root) return;
  const ps = usePlugins.getState();
  // A result waiting to be kept was of the last library's picture: never kept in this one.
  if (keepWaiting) {
    keepWaiting.reject(new Error("another library was opened"));
    keepWaiting = null;
  }
  usePlugins.setState({ overlays: {}, directions: [], shared: {}, keeping: null, colourPick: null, panelOpen: null, brush: { ...ps.brush, itemKey: null, strokes: [] } });
  if (prev.root) for (const p of ps.list) if (p.state.enabled && p.manifest) ps.reload(p.id);
});
