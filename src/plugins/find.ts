/**
 * Find's side of the plugin bridge. A plugin with the `find` permission provides a platform (its
 * sections, and the headers its images want); Find asks it for pages, works and files by event and
 * waits for its answer. Everything an answer holds is cleaned here before Find uses it: nothing a
 * plugin sends is trusted.
 */
import { create } from "zustand";
import { api } from "../lib/api";
import type { ItemSource } from "../lib/types";
import { useStore } from "../store";
import { can, canFetch } from "./permissions";
import { usePlugins } from "./store";
import type { PluginInfo } from "./types";

export interface FindOption {
  value: string;
  label: string;
}
export interface FindSection {
  id: string;
  label: string;
  /** Takes what is typed (search). */
  query: boolean;
  options: FindOption[];
  /** What it lists: works, or artists (the ones followed). */
  kind: "works" | "artists";
}
export interface Finder {
  pluginId: string;
  name: string;
  /** What its pictures' sources say they came from: the platform's id, as the plugin names it. */
  platform: string;
  site: string | null;
  imageHeaders: Record<string, string>;
  sections: FindSection[];
  /** An artist's works, opened from a work's author: their options (drawings, comics…). */
  artistOptions: FindOption[];
  /** Artists can be followed and unfollowed from here (its `follow` handler). */
  follows: boolean;
  /** An artist's page lists their tags, and shows their works with one (its `artistTags` handler, `tag` in `list`). */
  artistTags: boolean;
  /** Signed in with what the reader types (a username and key, say) instead of a sign-in page; with `optional`, it can be browsed signed out. */
  signIn: FindSignIn | null;
  /** Its tags are the anime tagger's own words: a tagger word linked to a tag of yours brings it in too. */
  taggerWords: boolean;
  /** It can look a picture up by how it looks (its `lookup` handler): Find source. */
  lookup: boolean;
  /** It has accounts to sign in to (false: browsed as it is, no sign-in at all). */
  accounts: boolean;
  /** A work of several pages comes in as an album unless the basket says otherwise (else page by page). */
  albums: boolean;
  /** Several sites, the reader's own, one shown at a time: picked (its `site` handler) or added (`addSite`). */
  sites: FindSites | null;
  /** Its icon (the site's own), shown with its name; of the site shown, for one of several. */
  icon: string | null;
}

export interface FindSites {
  list: { id: string; name: string; icon: string | null }[];
  current: string | null;
  /** What a site to add must be, said when adding one. */
  help: string;
}

export interface FindSignIn {
  fields: { id: string; label: string; secret: boolean }[];
  help: string;
  link: { label: string; url: string } | null;
  optional: boolean;
}

/** What a tag is, where the platform says: who drew it, what it is from, who is in it, what is in it, or about the file. */
export type TagKind = "artist" | "series" | "character" | "general" | "meta";
export interface FindTagOf {
  name: string;
  translated: string | null;
  kind?: TagKind;
}

/** One of an artist's tags, and how many of their works carry it. */
export interface FindTag {
  name: string;
  translated: string | null;
  count: number;
}
export interface FindItem {
  id: string;
  title: string;
  /** Who made it; on another platform than the work's, that platform and their page there (see ItemSource). */
  author: { id: string; name: string; account: string; platform?: string; url?: string };
  url: string | null;
  thumb: string;
  width: number;
  height: number;
  pages: number;
  kind: "image" | "pages" | "animation";
  tags: FindTagOf[];
  date: string | null;
  adult: boolean;
  ai: boolean;
  likes: number;
  views: number;
  /** Its language (ISO 639-1), where the platform says. */
  language?: string;
}
/** A work like a picture of yours, and how alike (0 to 1), from Find source. */
export interface FindMatch {
  item: FindItem;
  similarity: number;
}
export interface FindAccount {
  signedIn: boolean;
  name?: string;
  account?: string;
  avatar?: string | null;
  premium?: boolean;
}
export interface FindArtist {
  id: string;
  name: string;
  account: string;
  avatar: string | null;
  followed: boolean;
  /** How many works they have, when known. */
  works: number | null;
  /** Their page on the platform. */
  url: string | null;
  /** A few recent works (in a list of artists). */
  recent: FindItem[];
  /** What they say about themselves, where they are, and their other pages (an artist in full). */
  bio: string;
  region: string;
  links: { label: string; url: string }[];
}
export interface FindPage {
  items: FindItem[];
  /** A section of artists lists them instead of works. */
  artists: FindArtist[];
  /** An artist's page says who they are. */
  artist: FindArtist | null;
  next: string | null;
  title: string | null;
  /** How many there are in all, when the platform says (an artist's works of the kind shown). */
  total: number | null;
}
export interface FindWorkView {
  item: FindItem;
  /** Each page large, with its own small picture (`thumb`) to show while the large one comes. */
  pages: { preview: string; thumb: string | null; width?: number; height?: number }[];
  caption: string;
}
export interface FindFiles {
  source: Omit<ItemSource, "added">;
  folder: string;
  files: { url: string; name: string }[];
  animation: { zip: string; name: string; frames: { file: string; delay: number }[] } | null;
}
/** A sign-in page a plugin asked to open, while it is open. */
export interface LoginAsk {
  pluginId: string;
  name: string;
  url: string;
  done: (back: string | null) => void;
}

export const useFinders = create<{ finders: Record<string, Finder>; login: LoginAsk | null }>(() => ({ finders: {}, login: null }));

/* ---------- cleaning what a plugin says ---------- */

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
// Up to 200: a section's options can be the reader's own (their boards, say).
const options = (v: unknown): FindOption[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, 200)
    .map((o) => ({ value: text(o?.value, 80), label: text(o?.label, 60) }))
    .filter((o) => o.value && o.label);

const KINDS = new Set<TagKind>(["artist", "series", "character", "general", "meta"]);
/** A work's tags as the plugin says them, with their kind when it gives one. */
const cleanTags = (v: unknown): FindTagOf[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, 120)
    .map((t: Record<string, unknown>) => ({ name: text(t?.name, 120), translated: text(t?.translated, 120) || null, ...(KINDS.has(t?.kind as TagKind) ? { kind: t.kind as TagKind } : {}) }))
    .filter((t) => t.name);

/** A language code (ISO 639-1, as "en"), or nothing. */
const language = (v: unknown) => (typeof v === "string" && /^[a-z]{2,3}$/.test(v) ? { language: v } : {});

/** An https address the plugin may fetch, or nothing. */
function fetchable(p: PluginInfo, v: unknown): string | null {
  const u = text(v, 4096);
  return u && canFetch(p, u) ? u : null;
}

/** A platform's (or site's) icon: one to fetch from its hosts, or one it brings along, a small `data:` picture. */
function iconOf(p: PluginInfo, v: unknown): string | null {
  const u = text(v, 32_768);
  if (/^data:image\/(png|svg\+xml|x-icon|vnd\.microsoft\.icon|jpeg|webp|gif)[;,]/.test(u)) return u;
  return fetchable(p, v);
}

/** An https link to show (a work's page on its site), or nothing. */
function link(v: unknown): string | null {
  const u = text(v, 2048);
  try {
    return new URL(u).protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** An author's platform and page, when they are on another platform than the work: both, or neither. */
function elsewhere(author: Record<string, unknown>): { platform?: string; url?: string } {
  const platform = text(author.platform, 40).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const url = link(author.url);
  return platform && url ? { platform, url } : {};
}

function cleanItem(p: PluginInfo, v: Record<string, unknown>): FindItem | null {
  const thumb = fetchable(p, v?.thumb);
  const id = text(v?.id, 80);
  if (!thumb || !id) return null;
  const author = (v.author ?? {}) as Record<string, unknown>;
  const kind = v.kind === "animation" || v.kind === "pages" ? v.kind : "image";
  return {
    id,
    title: text(v.title, 300),
    author: { id: text(author.id, 80), name: text(author.name, 120), account: text(author.account, 120), ...elsewhere(author) },
    url: link(v.url),
    thumb,
    width: num(v.width),
    height: num(v.height),
    pages: Math.max(1, Math.round(num(v.pages))),
    kind,
    tags: cleanTags(v.tags),
    date: text(v.date, 40) || null,
    adult: v.adult === true,
    ai: v.ai === true,
    likes: num(v.likes),
    views: num(v.views),
    ...language(v.language),
  };
}

function cleanItems(p: PluginInfo, v: unknown, max: number): FindItem[] {
  return (Array.isArray(v) ? v : []).slice(0, max).map((i: Record<string, unknown>) => cleanItem(p, i)).filter((i): i is FindItem => !!i);
}

function cleanArtist(p: PluginInfo, v: Record<string, unknown> | undefined): FindArtist | null {
  const id = text(v?.id, 80);
  if (!v || !id) return null;
  const links = (Array.isArray(v.links) ? v.links : []).slice(0, 8).map((l: Record<string, unknown>) => ({ label: text(l?.label, 40), url: link(l?.url) })).filter((l): l is { label: string; url: string } => !!l.label && !!l.url);
  return { id, name: text(v.name, 120), account: text(v.account, 120), avatar: fetchable(p, v.avatar), followed: v.followed === true, works: num(v.works) || null, url: link(v.url), recent: cleanItems(p, v.recent, 6), bio: text(v.bio, 4000), region: text(v.region, 80), links };
}

function cleanPage(p: PluginInfo, v: Record<string, unknown>): FindPage {
  const artists = (Array.isArray(v?.artists) ? v.artists : []).slice(0, 200).map((a: Record<string, unknown>) => cleanArtist(p, a)).filter((a): a is FindArtist => !!a);
  return { items: cleanItems(p, v?.items, 500), artists, artist: cleanArtist(p, v?.artist as Record<string, unknown> | undefined), next: text(v?.next, 4096) || null, title: text(v?.title, 120) || null, total: num(v?.total) || null };
}

function cleanFiles(p: PluginInfo, v: Record<string, unknown>): FindFiles {
  const s = (v?.source ?? {}) as Record<string, unknown>;
  const author = (s.author ?? {}) as Record<string, unknown>;
  const files = (Array.isArray(v?.files) ? v.files : []).slice(0, 1000).map((f: Record<string, unknown>) => ({ url: fetchable(p, f?.url), name: text(f?.name, 160) })).filter((f): f is { url: string; name: string } => !!f.url && !!f.name);
  const a = v?.animation as Record<string, unknown> | undefined;
  const zip = a ? fetchable(p, a.zip) : null;
  const frames = a && Array.isArray(a.frames) ? a.frames.slice(0, 5000).map((f: Record<string, unknown>) => ({ file: text(f?.file, 160), delay: Math.min(60_000, Math.round(num(f?.delay))) })).filter((f) => f.file) : [];
  return {
    source: {
      // Said by the platform as Find knows it, not per file: what was brought in is matched by it.
      platform: useFinders.getState().finders[p.id]?.platform ?? p.id,
      id: text(s.id, 80),
      url: link(s.url) ?? "",
      title: text(s.title, 300),
      author: { id: text(author.id, 80), name: text(author.name, 120), account: text(author.account, 120) || undefined, ...elsewhere(author) },
      tags: cleanTags(s.tags),
      date: text(s.date, 40) || null,
      adult: s.adult === true,
      ...language(s.language),
    },
    folder: text(v?.folder, 160),
    files,
    animation: zip && frames.length ? { zip, name: text(a!.name, 160) || "animation.mp4", frames } : null,
  };
}

/* ---------- provided by plugins ---------- */

/** `ms.find.provide`: the plugin's platform, as Find shows it. */
export function provide(p: PluginInfo, a: Record<string, unknown>) {
  const name = text(a.name, 40);
  if (!name) throw new Error("find.provide needs a name");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((a.imageHeaders ?? {}) as Record<string, unknown>).slice(0, 8)) if (typeof v === "string" && /^[A-Za-z-]{1,40}$/.test(k)) headers[k] = v.slice(0, 400);
  const sections = (Array.isArray(a.sections) ? a.sections : [])
    .slice(0, 12)
    .map((s: Record<string, unknown>) => ({ id: text(s?.id, 40), label: text(s?.label, 40), query: s?.query === true, options: options(s?.options), kind: s?.kind === "artists" ? ("artists" as const) : ("works" as const) }))
    .filter((s) => s.id && s.label);
  if (!sections.length) throw new Error("find.provide needs at least one section");
  const platform = text(a.platform, 40).toLowerCase().replace(/[^a-z0-9-]/g, "") || p.id;
  const finder: Finder = {
    pluginId: p.id,
    name,
    platform,
    site: link(a.site),
    imageHeaders: headers,
    sections,
    artistOptions: options((a.artist as Record<string, unknown> | undefined)?.options),
    follows: a.follow === true,
    artistTags: (a.artist as Record<string, unknown> | undefined)?.tags === true,
    signIn: cleanSignIn(a.signIn),
    taggerWords: a.taggerWords === true,
    lookup: a.lookup === true,
    accounts: a.accounts !== false,
    albums: a.albums === true,
    sites: cleanSites(p, a.sites),
    // The site's own icon, else the plugin's logo.
    icon: iconOf(p, a.icon) ?? p.icon ?? null,
  };
  useFinders.setState((s) => ({ finders: { ...s.finders, [p.id]: finder } }));
}

/** A sign-in by what the reader types: up to four fields, said plainly; or none (a sign-in page, or none at all). */
function cleanSignIn(v: unknown): FindSignIn | null {
  const s = v as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return null;
  const fields = (Array.isArray(s.fields) ? s.fields : [])
    .slice(0, 4)
    .map((f: Record<string, unknown>) => ({ id: text(f?.id, 40), label: text(f?.label, 40), secret: f?.secret === true }))
    .filter((f) => /^[a-z][a-z0-9_]*$/i.test(f.id) && f.label);
  const l = s.link as Record<string, unknown> | undefined;
  const url = link(l?.url);
  return { fields, help: text(s.help, 400), link: url && text(l?.label, 60) ? { label: text(l?.label, 60), url } : null, optional: s.optional === true };
}

/** The sites a platform has, the reader's own: up to the most a plugin may be allowed. */
function cleanSites(p: PluginInfo, v: unknown): FindSites | null {
  const s = v as Record<string, unknown> | undefined;
  if (!s || typeof s !== "object") return null;
  const list = (Array.isArray(s.list) ? s.list : [])
    .slice(0, 24)
    .map((x: Record<string, unknown>) => ({ id: text(x?.id, 253), name: text(x?.name, 60) || text(x?.id, 60), icon: iconOf(p, x?.icon) }))
    .filter((x) => x.id);
  const current = text(s.current, 253);
  const add = s.add as Record<string, unknown> | undefined;
  return { list, current: list.some((x) => x.id === current) ? current : (list[0]?.id ?? null), help: text(add?.help, 400) };
}

/** A plugin gone (disabled, removed, updated): its platform leaves Find until it provides it again. */
export function dropFinder(id: string) {
  if (!useFinders.getState().finders[id]) return;
  useFinders.setState((s) => ({ finders: Object.fromEntries(Object.entries(s.finders).filter(([k]) => k !== id)) }));
  for (const [ask, w] of waiting) if (w.pluginId === id) (waiting.delete(ask), w.reject(new Error("the plugin stopped")));
}

/* ---------- asking a plugin ---------- */

const waiting = new Map<number, { pluginId: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextAsk = 1;

/** Ask a plugin's platform something (`op`) and wait for its answer: a sign-in waits for the user. */
function ask(pluginId: string, op: string, args: Record<string, unknown>, ms: number | null): Promise<Record<string, unknown>> {
  const id = nextAsk++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { pluginId, resolve: resolve as (v: unknown) => void, reject });
    if (ms) setTimeout(() => waiting.delete(id) && reject(new Error("the plugin didn't answer in time")), ms);
    // Sent as an event: the plugin's SDK runs its handler for `op` and answers with find.answer.
    import("./host").then((h) => h.sendEvent(pluginId, "find.ask", { ask: id, op, args }));
  });
}

/** `ms.find.answer`, the plugin's answer to an ask. */
export function answer(p: PluginInfo, a: Record<string, unknown>) {
  const w = waiting.get(Number(a.ask));
  if (!w || w.pluginId !== p.id) return;
  waiting.delete(Number(a.ask));
  if (a.ok === true) w.resolve(a.value ?? null);
  else w.reject(new Error(text(a.error, 400) || "the plugin couldn't do it"));
}

const plugin = (id: string) => {
  const p = usePlugins.getState().byId(id);
  if (!p || !can(p, "find")) throw new Error("this platform's plugin is off");
  return p;
};

export const finder = {
  account: async (id: string): Promise<FindAccount> => {
    const v = await ask(id, "account", {}, 30_000);
    return { signedIn: v?.signedIn === true, name: text(v?.name, 120), account: text(v?.account, 120), avatar: fetchable(plugin(id), v?.avatar), premium: v?.premium === true };
  },
  /** Signed in: by its sign-in page, or with what the reader typed into its fields (`fields`). */
  signIn: async (id: string, fields?: Record<string, string>): Promise<FindAccount> => {
    await ask(id, "signIn", fields ? { fields } : {}, null);
    return finder.account(id);
  },
  signOut: async (id: string): Promise<FindAccount> => {
    await ask(id, "signOut", {}, 30_000);
    return finder.account(id);
  },
  /** A page of a section, a search or an artist's works (`site`: of one of its sites other than the one shown). */
  list: async (id: string, args: { section: string; query?: string; option?: string; author?: string; tag?: string; cursor?: string; site?: string }) => cleanPage(plugin(id), await ask(id, "list", args, 90_000)),
  /** An artist's tags, most used first. */
  artistTags: async (id: string, artistId: string): Promise<FindTag[]> => {
    const v = await ask(id, "artistTags", { id: artistId }, 60_000);
    return (Array.isArray(v) ? v : [])
      .slice(0, 300)
      .map((t: Record<string, unknown>) => ({ name: text(t?.name, 120), translated: text(t?.translated, 120) || null, count: Math.max(0, Math.round(num(t?.count))) }))
      .filter((t) => t.name);
  },
  /** An artist in full (icon, what they say about themselves, their pages): by id, or the address of their page (`site`: on one of its sites other than the one shown). */
  artist: async (id: string, args: { id?: string; url?: string; site?: string }): Promise<FindArtist> => {
    const a = cleanArtist(plugin(id), await ask(id, "artist", args, 60_000));
    if (!a) throw new Error("the platform didn't say who that is");
    return a;
  },
  /** Follow an artist (`private`: so only you see it, where the platform has that), or stop following them; whether they are followed now. */
  follow: async (id: string, args: { id: string; follow: boolean; private?: boolean; site?: string }): Promise<boolean> => {
    const v = await ask(id, "follow", args, 30_000);
    return typeof v?.followed === "boolean" ? v.followed : args.follow;
  },
  /** Works like this one, as the platform suggests them under it (none when it doesn't). */
  related: async (id: string, args: { id: string; cursor?: string }) => cleanPage(plugin(id), await ask(id, "related", args, 90_000)),
  work: async (id: string, workId: string): Promise<FindWorkView> => {
    const p = plugin(id);
    const v = await ask(id, "work", { id: workId }, 60_000);
    const item = cleanItem(p, (v?.item ?? {}) as Record<string, unknown>);
    if (!item) throw new Error("the plugin sent no work");
    const pages: FindWorkView["pages"] = [];
    for (const x of (Array.isArray(v?.pages) ? v.pages : []).slice(0, 500) as Record<string, unknown>[]) {
      const preview = fetchable(p, x?.preview);
      if (preview) pages.push({ preview, thumb: fetchable(p, x?.thumb), width: num(x?.width) || undefined, height: num(x?.height) || undefined });
    }
    return { item, pages, caption: text(v?.caption, 4000) };
  },
  files: async (id: string, workId: string) => cleanFiles(plugin(id), await ask(id, "files", { id: workId }, 120_000)),
  /** Another of its sites shown. */
  site: async (id: string, site: string) => void (await ask(id, "site", { id: site }, 60_000)),
  /** A site added by its address (the reader is asked to allow it, and it may have a check to pass): its id. */
  addSite: async (id: string, url: string): Promise<string> => {
    const v = await ask(id, "addSite", { url }, null);
    const site = text(v?.id, 253);
    if (!site) throw new Error("the site wasn't added");
    return site;
  },
  /** Works that look like a picture (`image`: a small JPEG, base64), best first. */
  lookup: async (id: string, image: string): Promise<FindMatch[]> => {
    const p = plugin(id);
    const v = await ask(id, "lookup", { image, mime: "image/jpeg" }, 90_000);
    return (Array.isArray(v?.matches) ? v.matches : [])
      .slice(0, 20)
      .map((m: Record<string, unknown>) => ({ item: cleanItem(p, (m?.item ?? {}) as Record<string, unknown>), similarity: Math.min(1, num(m?.similarity)) }))
      .filter((m): m is FindMatch => !!m.item)
      .sort((a, b) => b.similarity - a.similarity);
  },
  suggest: async (id: string, query: string): Promise<FindOption[]> => {
    const v = await ask(id, "suggest", { query }, 20_000).catch(() => []);
    return options(v);
  },
};

/* ---------- sign-in and the library's store ---------- */

/**
 * `ms.login.open`: the sign-in page in its own window, and this app's dialog beside it (for signing in
 * with a browser instead). Where it ended, with the window's cookies for `cookies` (none when signed in
 * with a browser), or null.
 */
/** A sign-in page in its own window, until it goes to one of `until` (with `load`, once that page has loaded). */
export function openLogin(p: PluginInfo, url: string, until: string[], name: string, cookies: string[], load = false): Promise<{ url: string; cookies: Record<string, string> } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (back: { url: string; cookies: Record<string, string> } | null) => {
      if (settled) return;
      settled = true;
      useFinders.setState({ login: null });
      void api.pluginLoginClose(p.id).catch(() => {});
      resolve(back);
    };
    const done = (back: string | null) => finish(back == null ? null : { url: back, cookies: {} });
    useFinders.getState().login?.done(null);
    useFinders.setState({ login: { pluginId: p.id, name, url, done } });
    api.pluginLogin(p.id, url, until, name, cookies, load).then(finish, (e) => {
      useStore.getState().toast(`Couldn't open the sign-in window: ${String(e)}`, "error");
      done(null);
    });
  });
}

/** The library a plugin's library store is for: the one open. */
export function libraryRoot(): string {
  const root = useStore.getState().root;
  if (!root) throw new Error("no library is open");
  return root;
}
