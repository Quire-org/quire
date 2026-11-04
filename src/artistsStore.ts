/**
 * The library's artists: who made its pictures. Kept with the library (in its vault when it has one):
 * each artist, the platform accounts they're linked to and what those say (an icon, a description,
 * their other pages), and the pictures given them, by key, following moves. Pictures brought in
 * through Find suggest their artist; none is given one without the user saying so.
 */
import { debounced } from "./lib/pending";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api } from "./lib/api";
import { base64 } from "./lib/base64";
import { rekeyRecord } from "./lib/moves";
import { cacheValid, type ImageSig } from "./lib/dupes";
import { likeness, LIKE_MATCH, sigOf } from "./lib/findCheck";
import { steppedJob } from "./lib/jobs";
import type { ItemSource, MediaItem } from "./lib/types";
import { originalOf, useStore } from "./store";
import { finder, useFinders } from "./plugins/find";
import { hasWork } from "./lib/sources";

export interface ArtistLink {
  /** The platform as Find knows it (its plugin's `platform` id) and the artist's id there. */
  platform: string;
  id: string;
  account: string;
  url: string | null;
}

export interface LocalArtist {
  id: string;
  name: string;
  /** Named by the user: a refresh from the platform leaves the name alone. */
  renamed: boolean;
  links: ArtistLink[];
  /** Their icon, kept with the library (`artist-<id>.jpg`), and when it was saved (to show the new one). */
  avatar: string | null;
  avatarAt: number;
  /** The icon was cut from their art here: a refresh from the platform leaves it alone. */
  avatarChosen?: boolean;
  bio: string;
  region: string;
  /** The stickers on their banner (Scrapbook's, by id). */
  banner?: string;
  /** Their other pages, as their platform profile lists them. */
  pages: { label: string; url: string }[];
  /** When the platform was last asked about them. */
  fetched: number | null;
  added: number;
}

export interface ArtistsDoc {
  version: 1;
  artists: Record<string, LocalArtist>;
  /** Item key → its artist (one: a list for older docs); `album:<album key>` → an album's (`albumArtistKey`). */
  items: Record<string, string[]>;
  /** Suggestions turned down: "platform:id" of the platform account. */
  dismissed: string[];
  /** Their works on platforms looked for in the library, by artist: when, and which (a later look only does new ones). */
  looked?: Record<string, { at: number; works: string[] }>;
  /** Pictures found to be one of an artist's works, waiting for a yes. */
  found?: FoundWork[];
  /** Found ones turned down: "<artist>|<key>". */
  notTheirs?: string[];
  /** Artists said not to be the same, though they share a page: "<id>|<id>", in order. */
  notSame?: string[];
}

/** A picture in the library found to be one of an artist's works on their platform (the same picture). */
export interface FoundWork {
  artist: string;
  /** What would be theirs: the picture, or its album (`artistKeyOf`). */
  key: string;
  /** The picture that is the work. */
  item: string;
  platform: string;
  work: string;
  title: string;
  url: string | null;
  /** How alike (`likeness`): `SURE_MATCH` and more, surely it. */
  score: number;
  at: number;
  /** How many of their works look like it (one work in several languages, say): this, the likeliest, stands for them. */
  matches?: number;
}

/**
 * Found pictures, one each (a picture or album several of their works look like is one picture of
 * theirs, not several): the likeliest work stands for the others, which it counts.
 */
export function foundOnce(found: FoundWork[]): FoundWork[] {
  const by = new Map<string, FoundWork>();
  for (const f of found) {
    const k = `${f.artist}|${f.key}`;
    const was = by.get(k);
    const matches = (was?.matches ?? (was ? 1 : 0)) + (f.matches ?? 1);
    by.set(k, { ...(was && was.score >= f.score ? was : f), matches });
  }
  return [...by.values()];
}

/** Pictures brought in from one platform account, with no artist yet: who to make (or give them to). */
export interface ArtistSuggestion {
  key: string;
  platform: string;
  authorId: string;
  name: string;
  account: string;
  /** Their page there, when the platform is another than the work's (see ItemSource's author). */
  url: string | null;
  items: string[];
  /** The library's artist linked to that account already, if one is. */
  artist: LocalArtist | null;
}

const empty = (): ArtistsDoc => ({ version: 1, artists: {}, items: {}, dismissed: [] });

/** Where an album's artists are kept (a translated version's are its original's), beside the pictures' (as the tags keep an album's). */
export const albumArtistKey = (albumKey: string) => `album:${originalOf(albumKey)}`;
export const isAlbumArtistKey = (key: string) => key.startsWith("album:");
const keptKey = (key: string) => (isAlbumArtistKey(key) ? albumArtistKey(key.slice("album:".length)) : key);

/** Linked albums are one: a translated version's artist joins its original (whose own wins). */
function joined(doc: ArtistsDoc): ArtistsDoc {
  const links = Object.entries(useStore.getState().library?.albumTranslations ?? {});
  if (!links.some(([, t]) => doc.items[`album:${t}`])) return doc;
  const items = { ...doc.items };
  for (const [o, t] of links) {
    if (!items[`album:${t}`]) continue;
    items[`album:${o}`] ??= items[`album:${t}`];
    delete items[`album:${t}`];
  }
  return { ...doc, items };
}
/** Whose a picture is said to be: its album's, when it is an album's page; else its own. */
export const artistKeyOf = (item: { key: string; albumKey?: string }) => (item.albumKey ? albumArtistKey(item.albumKey) : item.key);

/** The library's artist linked to a platform account. */
export function linkedArtist(doc: ArtistsDoc | null, platform: string, id: string): LocalArtist | null {
  return Object.values(doc?.artists ?? {}).find((a) => a.links.some((l) => l.platform === platform && l.id === id)) ?? null;
}

/** An address as artists' pages are compared: without its scheme, "www.", trailing slash or #part, in any case. Null for a site's front page. */
function addressKey(url: string | null): string | null {
  try {
    const u = new URL(url ?? "");
    const path = u.pathname.replace(/\/+$/, "");
    return path || u.search ? `${u.hostname.replace(/^www\./, "")}${path}${u.search}`.toLowerCase() : null;
  } catch {
    return null;
  }
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Other artists who share a page with this one (an address one has as an account and the other
 * lists, say): likely the same person, met on two platforms. Only a suggestion: joining them is
 * the reader's yes.
 */
export function sameArtists(doc: ArtistsDoc | null, id: string): { artist: LocalArtist; via: string }[] {
  const me = doc?.artists[id];
  if (!doc || !me) return [];
  const addresses = (a: LocalArtist) => new Set([...a.links.map((l) => l.url), ...a.pages.map((p) => p.url)].map(addressKey).filter((x): x is string => !!x));
  const mine = addresses(me);
  const notSame = new Set(doc.notSame ?? []);
  const out: { artist: LocalArtist; via: string }[] = [];
  for (const other of Object.values(doc.artists)) {
    if (other.id === id || notSame.has(pairKey(id, other.id))) continue;
    const via = [...addresses(other)].find((x) => mine.has(x));
    if (via) out.push({ artist: other, via });
  }
  return out;
}

/** What pictures from platforms suggest: grouped by account, most pictures first. Only pictures that are here. */
export function suggestionsFor(doc: ArtistsDoc, sources: Record<string, ItemSource>, present: Set<string> | null, albumOf: (key: string) => string | undefined = () => undefined): ArtistSuggestion[] {
  const groups = new Map<string, ArtistSuggestion>();
  const dismissed = new Set(doc.dismissed);
  for (const [k, s] of Object.entries(sources)) {
    // A page of an album given an artist (a work of several pages) is theirs already.
    const album = albumOf(k);
    if (!s.author?.id || doc.items[k]?.length || (album && doc.items[albumArtistKey(album)]?.length) || (present && !present.has(k))) continue;
    // On the platform they are on: the work's, or another its maker is known by.
    const platform = s.author.platform ?? s.platform;
    const key = `${platform}:${s.author.id}`;
    if (dismissed.has(key)) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, platform, authorId: s.author.id, name: s.author.name, account: s.author.account ?? "", url: s.author.url ?? null, items: [], artist: linkedArtist(doc, platform, s.author.id) }));
    g.items.push(k);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
}

/** How many of the library's pictures each artist has (`albums`: how many albums). */
export function countsOf(doc: ArtistsDoc | null, albums = false): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, ids] of Object.entries(doc?.items ?? {})) if (isAlbumArtistKey(k) === albums) for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
}

const newId = () => `ar${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

interface ArtistsState {
  doc: ArtistsDoc | null;
  docRoot: string | null;
  /** The artist whose page is open. */
  open: string | null;
  /** Artists being asked about on their platform, and what is happening. */
  busy: Record<string, string>;
  load(): Promise<ArtistsDoc | null>;
  setOpen(id: string | null): void;
  create(name: string, link?: ArtistLink): string | null;
  rename(id: string, name: string): void;
  setBanner(id: string, banner: string | null): void;
  remove(id: string): void;
  /** `from` is the same artist as `into`: its pictures, links and pages go there. */
  merge(from: string, into: string): void;
  /** Two artists who share a page aren't the same: not suggested as one again. */
  notSame(a: string, b: string): void;
  /** These are this artist's (in place of any other: one artist a picture). */
  assign(keys: string[], id: string): void;
  unassign(keys: string[], id: string): void;
  /** Linked albums are one: a translated version's artist joins its original's. */
  joinVersions(): void;
  /** Unlinked from its original, a translated version keeps a copy of the artist the two had. */
  splitVersion(original: string, translation: string): Promise<void>;
  /** Link an artist to a platform account by its address (asking each platform whose it is), then fill them in. */
  linkByAddress(id: string, url: string): Promise<void>;
  /** Link an artist to a platform account (the same person there too), and fill in from it what they lack. */
  linkTo(id: string, link: ArtistLink): Promise<void>;
  unlink(id: string, link: ArtistLink): void;
  /** Their icon, description and pages again from the platform they're linked to. */
  refresh(id: string): Promise<void>;
  /** Their icon cut from their art (a square picture, shown round); null: their platform's again, or none. */
  setIcon(id: string, picture: Blob | null): Promise<void>;
  /** A suggestion said yes to: its pictures given to its account's artist, made now (or, `into`, linked to one of the library's). */
  accept(s: ArtistSuggestion, into?: string): Promise<string | null>;
  dismiss(s: ArtistSuggestion): void;
  /** Pictures moved: their artists go with them. */
  follow(move: (key: string) => string | null): void;
  /** Pictures gone for good (the trash emptied). */
  /** What is known of pictures and albums gone for good: `gone` says, of an item's or album's key, whether it is one. */
  forget(gone: (key: string) => boolean): void;
  /** A look for works running. */
  looking: boolean;
  /**
   * Their works on the platforms they're linked to, looked for in the library by the duplicate
   * check's fingerprints, in Activity, paced (the platform's limits); what is found waits on their
   * page. A work is fetched and fingerprinted once (kept with Find's data): looked again, only new
   * works are fetched, and every one is compared with the library as it is now.
   */
  lookForWorks(ids: string[]): Promise<void>;
  /** Found pictures are theirs, and noted as from that work. */
  acceptFound(found: FoundWork[]): void;
  /** Found pictures aren't theirs: not suggested for them again. */
  rejectFound(found: FoundWork[]): void;
  /**
   * Pictures in the library that look like theirs (by the tag index: how pictures look, what is in
   * them as much as how it is drawn), best first; ones with an artist, and ones said not to be theirs,
   * left out. Each is nearer one of theirs than any of other artists' or those turned down. A string:
   * why there are none.
   */
  likeTheirs(id: string, limit?: number): Promise<StyleLike[] | string>;
  /** Pictures aren't theirs (a guess turned down): never suggested for them again. */
  notTheirs(id: string, keys: string[]): void;
}

/** A picture that looks like an artist's: what would be theirs (an album's page: the album), the picture, how alike (cosine). */
export interface StyleLike {
  key: string;
  item: string;
  score: number;
}

const artistsSave = debounced("artists", 300, async (root) => {
  const { doc, docRoot } = useArtists.getState();
  if (doc && docRoot === root) await api.artistsSave(root, doc).catch((e) => useStore.getState().toast(`The artists couldn't be saved: ${String(e)}`, "error"));
});
/** Between pages of an artist's works asked of their platform, and between pictures fetched from it (ms). */
export const PACE = { list: 1000, fetch: 200 };
const pace = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const useArtists = create<ArtistsState>((set, get) => {
  /**
   * An artist filled in from another platform they are linked to: only what they lack (an icon, a
   * description, where they are), and that platform's pages beside theirs; never their name.
   */
  const fillFrom = async (id: string, link: ArtistLink) => {
    const root = useStore.getState().root;
    const a = get().doc?.artists[id];
    const f = Object.values(useFinders.getState().finders).find((x) => x.platform === link.platform);
    if (!root || !a || !f) return;
    busy(id, `Asking ${f.name}…`);
    try {
      const prof = await finder.artist(f.pluginId, { id: link.id });
      let avatar = a.avatar;
      let avatarAt = a.avatarAt;
      if (prof.avatar && !a.avatar && !a.avatarChosen) {
        avatar = `artist-${id}.jpg`;
        await api.artistAvatarSave(f.pluginId, root, avatar, prof.avatar, f.imageHeaders);
        avatarAt = Date.now();
      }
      change((d) => {
        const now = d.artists[id];
        if (!now) return d;
        const links = now.links.map((l) => (l.platform === link.platform && l.id === link.id ? { ...l, account: prof.account || l.account, url: prof.url ?? l.url } : l));
        const pages = [...now.pages, ...prof.links.filter((p) => !now.pages.some((q) => addressKey(q.url) === addressKey(p.url)))];
        return { ...d, artists: { ...d.artists, [id]: { ...now, links, avatar, avatarAt, bio: now.bio || prof.bio, region: now.region || prof.region, pages } } };
      });
    } finally {
      busy(id, null);
    }
  };
  const change = (fn: (d: ArtistsDoc) => ArtistsDoc) => {
    const d = get().doc;
    if (!d || get().docRoot !== useStore.getState().root) return;
    set({ doc: fn(d) });
    artistsSave.schedule(get().docRoot!);
  };
  const busy = (id: string, what: string | null) => set({ busy: Object.fromEntries([...Object.entries(get().busy).filter(([k]) => k !== id), ...(what ? [[id, what]] : [])]) });

  return {
    doc: null,
    docRoot: null,
    open: null,
    busy: {},
    looking: false,

    async load() {
      const root = useStore.getState().root;
      if (!root) return null;
      if (get().docRoot === root && get().doc) return get().doc;
      const raw = (await Promise.resolve()
        .then(() => api.artistsLoad(root))
        .catch(() => null)) as Partial<ArtistsDoc> | null;
      if (useStore.getState().root !== root) return null;
      // Read meanwhile (another asked at the same time): that one stands.
      if (get().docRoot === root && get().doc) return get().doc;
      const loaded: ArtistsDoc = { ...empty(), ...(raw && typeof raw === "object" ? raw : {}), version: 1 };
      // One artist a picture: one given more before keeps the first.
      const doc = Object.values(loaded.items).some((ids) => ids.length > 1) ? { ...loaded, items: Object.fromEntries(Object.entries(loaded.items).map(([k, ids]) => [k, ids.slice(0, 1)])) } : loaded;
      set({ doc: joined(doc), docRoot: root, open: get().docRoot === root ? get().open : null });
      return get().doc;
    },

    setOpen(id) {
      set({ open: id });
    },

    create(name, link) {
      const clean = name.trim().slice(0, 120);
      if (!clean) return null;
      const id = newId();
      change((d) => ({ ...d, artists: { ...d.artists, [id]: { id, name: clean, renamed: !link, links: link ? [link] : [], avatar: null, avatarAt: 0, bio: "", region: "", pages: [], fetched: null, added: Date.now() } } }));
      return id;
    },

    rename(id, name) {
      const clean = name.trim().slice(0, 120);
      if (!clean) return;
      change((d) => (d.artists[id] ? { ...d, artists: { ...d.artists, [id]: { ...d.artists[id], name: clean, renamed: true } } } : d));
    },

    setBanner(id, banner) {
      change((d) => {
        const was = d.artists[id];
        if (!was) return d;
        const { banner: _old, ...rest } = was;
        void _old;
        return { ...d, artists: { ...d.artists, [id]: banner ? { ...rest, banner } : rest } };
      });
    },

    remove(id) {
      const a = get().doc?.artists[id];
      const root = useStore.getState().root;
      if (a?.avatar && root) void api.scrapbookBlobDelete(root, a.avatar).catch(() => {});
      change((d) => {
        const { [id]: _gone, ...artists } = d.artists;
        void _gone;
        const items = Object.fromEntries(Object.entries(d.items).map(([k, ids]) => [k, ids.filter((x) => x !== id)] as const).filter(([, ids]) => ids.length));
        const { [id]: _looked, ...looked } = d.looked ?? {};
        void _looked;
        return { ...d, artists, items, looked, found: (d.found ?? []).filter((f) => f.artist !== id) };
      });
      if (get().open === id) set({ open: null });
      // Their banner's stickers, unless the one they were joined to took it.
      const banner = a?.banner;
      if (banner && !Object.values(get().doc?.artists ?? {}).some((x) => x.banner === banner)) void import("./scrapbook/store").then(({ useScrapbook }) => useScrapbook.getState().dropBanner(banner));
    },

    merge(from, into) {
      const d = get().doc;
      if (!d?.artists[from] || !d.artists[into] || from === into) return;
      const links = [...d.artists[into].links, ...d.artists[from].links.filter((l) => !d.artists[into].links.some((m) => m.platform === l.platform && m.id === l.id))];
      const pages = [...d.artists[into].pages, ...d.artists[from].pages.filter((p) => !d.artists[into].pages.some((q) => addressKey(q.url) === addressKey(p.url)))];
      // Their banner goes with them, unless the one they are has their own.
      const banner = d.artists[into].banner ?? d.artists[from].banner;
      change((doc) => ({ ...doc, artists: { ...doc.artists, [into]: { ...doc.artists[into], links, pages, ...(banner ? { banner } : {}) } }, items: Object.fromEntries(Object.entries(doc.items).map(([k, ids]) => [k, [...new Set(ids.map((x) => (x === from ? into : x)))]])), found: (doc.found ?? []).map((f) => (f.artist === from ? { ...f, artist: into } : f)) }));
      get().remove(from);
      if (get().open === from) set({ open: into });
    },

    notSame(a, b) {
      change((d) => ({ ...d, notSame: [...new Set([...(d.notSame ?? []), pairKey(a, b)])] }));
    },

    assign(keys, id) {
      change((d) => {
        if (!d.artists[id]) return d;
        // One artist a picture: this one in place of any other.
        const items = { ...d.items };
        for (const k of keys) items[keptKey(k)] = [id];
        return { ...d, items };
      });
    },

    unassign(keys, id) {
      change((d) => {
        const items = { ...d.items };
        for (const k of keys.map(keptKey)) {
          const left = (items[k] ?? []).filter((x) => x !== id);
          if (left.length) items[k] = left;
          else delete items[k];
        }
        return { ...d, items };
      });
    },

    joinVersions() {
      const d = get().doc;
      if (d && joined(d) !== d) change(joined);
    },

    async splitVersion(original, translation) {
      const d = await get().load();
      const had = d?.items[`album:${original}`];
      if (had && !d.items[`album:${translation}`]) change((doc) => ({ ...doc, items: { ...doc.items, [`album:${translation}`]: [...had] } }));
    },

    async linkByAddress(id, url) {
      const finders = Object.values(useFinders.getState().finders);
      if (!finders.length) throw new Error("Linking needs the platform's plugin (Settings → Plugins).");
      let lastError: unknown = null;
      for (const f of finders) {
        try {
          const prof = await finder.artist(f.pluginId, { url: url.trim() });
          const link: ArtistLink = { platform: f.platform, id: prof.id, account: prof.account, url: prof.url };
          await get().linkTo(id, link);
          return;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },

    async linkTo(id, link) {
      const other = linkedArtist(get().doc, link.platform, link.id);
      if (other && other.id !== id) throw new Error(`That account is ${other.name}'s already.`);
      const first = !get().doc?.artists[id]?.links.length;
      change((d) => (d.artists[id] ? { ...d, artists: { ...d.artists, [id]: { ...d.artists[id], links: [...d.artists[id].links.filter((l) => !(l.platform === link.platform && l.id === link.id)), link] } } } : d));
      // Their only platform: filled in from it in full; another one: only with what they lack.
      if (first) await get().refresh(id);
      else await fillFrom(id, link);
    },

    unlink(id, link) {
      change((d) => (d.artists[id] ? { ...d, artists: { ...d.artists, [id]: { ...d.artists[id], links: d.artists[id].links.filter((l) => !(l.platform === link.platform && l.id === link.id)) } } } : d));
    },

    async refresh(id) {
      const root = useStore.getState().root;
      const a = get().doc?.artists[id];
      const link = a?.links[0];
      if (!root || !a || !link) return;
      const f = Object.values(useFinders.getState().finders).find((x) => x.platform === link.platform);
      if (!f) throw new Error(`Turn on the ${link.platform} plugin to fill in ${a.name} from there.`);
      busy(id, `Asking ${f.name}…`);
      try {
        const prof = await finder.artist(f.pluginId, { id: link.id });
        let avatar = a.avatar;
        let avatarAt = a.avatarAt;
        if (prof.avatar && !a.avatarChosen) {
          avatar = `artist-${id}.jpg`;
          await api.artistAvatarSave(f.pluginId, root, avatar, prof.avatar, f.imageHeaders);
          avatarAt = Date.now();
        }
        change((d) => {
          const now = d.artists[id];
          if (!now) return d;
          const links = now.links.map((l) => (l.platform === link.platform && l.id === link.id ? { ...l, account: prof.account || l.account, url: prof.url ?? l.url } : l));
          return { ...d, artists: { ...d.artists, [id]: { ...now, name: now.renamed || !prof.name ? now.name : prof.name, links, avatar, avatarAt, bio: prof.bio, region: prof.region, pages: prof.links, fetched: Date.now() } } };
        });
      } finally {
        busy(id, null);
      }
    },

    async setIcon(id, picture) {
      const root = useStore.getState().root;
      const a = get().doc?.artists[id];
      if (!root || !a) return;
      const avatar = `artist-${id}.jpg`;
      if (picture) {
        await api.scrapbookBlobPut(root, avatar, await base64(picture));
        change((d) => (d.artists[id] ? { ...d, artists: { ...d.artists, [id]: { ...d.artists[id], avatar, avatarAt: Date.now(), avatarChosen: true } } } : d));
        return;
      }
      change((d) => (d.artists[id] ? { ...d, artists: { ...d.artists, [id]: { ...d.artists[id], avatarChosen: false } } } : d));
      if (a.links.length) return get().refresh(id);
      if (a.avatar) await api.scrapbookBlobDelete(root, a.avatar).catch(() => {});
      change((d) => (d.artists[id] ? { ...d, artists: { ...d.artists, [id]: { ...d.artists[id], avatar: null, avatarAt: Date.now() } } } : d));
    },

    async accept(s, into) {
      await get().load();
      const link = { platform: s.platform, id: s.authorId, account: s.account, url: s.url };
      if (into) await get().linkTo(into, link);
      const id = into ?? s.artist?.id ?? get().create(s.name || s.account || s.authorId, link);
      if (!id) return null;
      // An album's pages (a work of several pages): the album is theirs.
      const byKey = new Map(useStore.getState().allItems.map((i) => [i.key, i]));
      get().assign([...new Set(s.items.map((k) => { const it = byKey.get(k); return it ? artistKeyOf(it) : k; }))], id);
      // A new artist is filled in from the platform, when a plugin offers it: their icon, description
      // and pages; a page in common with an artist from another platform says they may be one.
      if (!s.artist && !into && Object.values(useFinders.getState().finders).some((f) => f.platform === s.platform))
        void get()
          .refresh(id)
          .then(() => {
            const same = sameArtists(get().doc, id)[0];
            if (same) useStore.getState().toast(`${get().doc?.artists[id]?.name} may be ${same.artist.name} too (a page in common): open them in Artists to join them`, "ok");
          })
          .catch((e) => useStore.getState().toast(String(e).replace(/^Error: /, ""), "warn"));
      return id;
    },

    dismiss(s) {
      change((d) => ({ ...d, dismissed: [...new Set([...d.dismissed, s.key])] }));
    },

    follow(move) {
      const d = get().doc;
      if (!d) return;
      // An album's entry moves with its folder.
      const moveKey = (k: string) => {
        if (!isAlbumArtistKey(k)) return move(k);
        const to = move(k.slice("album:".length));
        return to == null ? null : `album:${to}`;
      };
      const items = rekeyRecord(d.items, moveKey, (here, moved) => [...new Set([...moved, ...here])]);
      const foundMoved = (d.found ?? []).some((f) => moveKey(f.key) != null || move(f.item) != null);
      // "Not theirs" ("<artist>|<picture>") goes with the picture, so a match turned down isn't offered again.
      const noMoved = (d.notTheirs ?? []).some((n) => moveKey(n.slice(n.indexOf("|") + 1)) != null);
      if (items || foundMoved || noMoved)
        change((doc) => ({
          ...doc,
          items: items ?? doc.items,
          found: (doc.found ?? []).map((f) => ({ ...f, key: moveKey(f.key) ?? f.key, item: move(f.item) ?? f.item })),
          ...(noMoved ? { notTheirs: (doc.notTheirs ?? []).map((n) => { const at = n.indexOf("|"); const to = moveKey(n.slice(at + 1)); return to == null ? n : `${n.slice(0, at)}|${to}`; }) } : {}),
        }));
    },

    forget(gone) {
      const d = get().doc;
      const key = (k: string) => (isAlbumArtistKey(k) ? k.slice("album:".length) : k);
      const noGone = (n: string) => gone(key(n.slice(n.indexOf("|") + 1)));
      if (!d || (!Object.keys(d.items).some((k) => gone(key(k))) && !(d.found ?? []).some((f) => gone(f.item)) && !(d.notTheirs ?? []).some(noGone))) return;
      change((doc) => ({ ...doc, items: Object.fromEntries(Object.entries(doc.items).filter(([k]) => !gone(key(k)))), found: (doc.found ?? []).filter((f) => !gone(f.item)), notTheirs: (doc.notTheirs ?? []).filter((n) => !noGone(n)) }));
    },

    async lookForWorks(ids) {
      const d = await get().load();
      if (!d || get().looking) return;
      const finders = Object.values(useFinders.getState().finders);
      const targets = ids
        .map((id) => d.artists[id])
        .filter(Boolean)
        .flatMap((a) => a.links.flatMap((l) => finders.filter((f) => f.platform === l.platform).map((f) => ({ a, l, f }))));
      const toast = useStore.getState().toast;
      if (!targets.length) return toast("No artist here is linked to a platform Find has (each comes with its plugin)", "warn");
      set({ looking: true });
      const root = useStore.getState().root;
      const one = new Set(targets.map((t) => t.a.id)).size === 1;
      const { job, gate } = steppedJob({ title: one ? `Looking for ${targets[0].a.name}'s works in your library` : `Looking for ${new Set(targets.map((t) => t.a.id)).size} artists' works in your library`, source: "Artists", total: targets.length });
      let found = 0;
      let theirs = 0;
      let looked = 0;
      let failed = 0;
      try {
        // The library's fingerprinted pictures (the duplicate check's), by shape: a work is only
        // compared with pictures of about its shape.
        await useStore.getState().loadAll();
        const { useDupes } = await import("./dupesStore");
        await useDupes.getState().loadCache();
        const cache = useDupes.getState().cache;
        const shapeOf = (s: { width: number; height: number }) => Math.round(Math.log(s.width / Math.max(1, s.height)) * 50);
        const byShape = new Map<number, { item: MediaItem; sig: ImageSig }[]>();
        let pictures = 0;
        for (const it of useStore.getState().allItems) {
          if (it.kind === "video") continue;
          pictures++;
          const c = cache[it.key];
          if (!cacheValid(c, it) || !c.image) continue;
          const sig = sigOf(c.image);
          const b = shapeOf(sig);
          byShape.set(b, [...(byShape.get(b) ?? []), { item: it, sig }]);
        }
        const fingerprinted = [...byShape.values()].reduce((n, l) => n + l.length, 0);
        if (!fingerprinted) {
          toast(`None of your ${pictures.toLocaleString("en-GB")} pictures is fingerprinted yet: run the duplicate check (Duplicates) first, then look again`, "warn");
          return;
        }
        // Their works: every page of each kind (drawings, comics…), a second apart (the platform's limits).
        const { useFind } = await import("./findStore");
        await useFind.getState().loadBaskets();
        const works: { a: LocalArtist; l: ArtistLink; f: (typeof targets)[number]["f"]; item: Awaited<ReturnType<typeof finder.list>>["items"][number] }[] = [];
        for (const [i, t] of targets.entries()) {
          if (!(await gate.pass())) return;
          job.update({ done: i, detail: `Listing ${t.a.name}'s works on ${t.f.name}` });
          for (const option of t.f.artistOptions.length ? t.f.artistOptions.map((o) => o.value) : [undefined]) {
            let cursor: string | undefined;
            for (let n = 0; n < 100; n++) {
              const page = await finder.list(t.f.pluginId, { section: "artist", author: t.l.id, option, cursor }).catch((e) => (toast(`${t.a.name} on ${t.f.name}: ${String(e).replace(/^Error: /, "")}`, "warn"), null));
              if (!page) break;
              for (const item of page.items) if (!works.some((w) => w.item.id === item.id && w.a.id === t.a.id)) works.push({ ...t, item });
              if (!page.next) break;
              cursor = page.next;
              await pace(PACE.list);
              if (!(await gate.pass())) return;
            }
          }
        }
        job.update({ done: 0, total: works.length, detail: `Comparing with ${fingerprinted.toLocaleString("en-GB")} of your ${pictures.toLocaleString("en-GB")} pictures` });
        const pending: FoundWork[] = [];
        const done: Record<string, string[]> = {};
        const keep = () => {
          if (!pending.length && !Object.keys(done).length) return;
          const add = pending.splice(0);
          const marks = Object.entries(done);
          for (const k of Object.keys(done)) delete done[k];
          change((doc) => {
            const no = new Set(doc.notTheirs ?? []);
            const was = doc.found ?? [];
            const open = add.filter((f) => !no.has(`${f.artist}|${f.key}`));
            const already = open.filter((f) => doc.items[f.key]?.includes(f.artist));
            // One suggestion a picture (or album), however many of their works look like it.
            const all = foundOnce([...was, ...open.filter((f) => !already.includes(f))]);
            found += all.length - foundOnce(was).length;
            theirs += foundOnce(already).length;
            const lookedNow = { ...(doc.looked ?? {}) };
            for (const [id, list] of marks) lookedNow[id] = { at: Date.now(), works: [...new Set([...(lookedNow[id]?.works ?? []), ...list])] };
            return { ...doc, found: all, looked: lookedNow };
          });
        };
        for (const [i, w] of works.entries()) {
          if (!(await gate.pass()) || useStore.getState().root !== root) break;
          job.update({ done: i, items: [{ key: `find:${w.item.id}`, name: w.item.title || w.item.id }] });
          // Its fingerprint as kept, else fetched (a fifth of a second apart) and kept.
          const fetch = !useFind.getState().sigs[`${w.l.platform}:${w.item.id}`];
          const h = await useFind.getState().workSig(w.f.pluginId, w.l.platform, w.item.id, w.item.thumb, w.f.imageHeaders);
          if (fetch) await pace(PACE.fetch);
          looked++;
          if (!h) {
            failed++;
            continue;
          }
          const sig = sigOf(h);
          const b = shapeOf(sig);
          // The best of the library's pictures for it; an album's pages count as their album.
          const best = new Map<string, FoundWork>();
          for (const c of [...(byShape.get(b - 1) ?? []), ...(byShape.get(b) ?? []), ...(byShape.get(b + 1) ?? [])]) {
            const score = likeness(sig, c.sig);
            if (score < LIKE_MATCH) continue;
            const key = artistKeyOf(c.item);
            if ((best.get(key)?.score ?? 0) >= score) continue;
            best.set(key, { artist: w.a.id, key, item: c.item.key, platform: w.l.platform, work: w.item.id, title: w.item.title, url: w.item.url, score: Math.round(score * 1000) / 1000, at: Date.now() });
          }
          pending.push(...best.values());
          (done[w.a.id] ??= []).push(w.item.id);
          if (i % 20 === 19) keep();
        }
        keep();
      } finally {
        job.finish();
        set({ looking: false });
      }
      const already = theirs ? `${found ? "; " : ""}${theirs} already theirs` : "";
      toast(`${looked.toLocaleString("en-GB")} of their works looked for: ${found ? `${found} picture${found === 1 ? "" : "s"} or album${found === 1 ? "" : "s"} of yours to check on their page${found === 1 ? "" : "s"}` : theirs ? "" : "none in your library"}${already}${failed ? `; ${failed} couldn't be fetched` : ""}`, found ? "ok" : "info");
    },

    acceptFound(found) {
      if (!found.length) return;
      for (const artist of new Set(found.map((f) => f.artist))) get().assign([...new Set(found.filter((f) => f.artist === artist).map((f) => f.key))], artist);
      const lib = useStore.getState().library;
      const name = (id: string) => get().doc?.artists[id];
      // Noted as from that work (as an import notes it), where it isn't yet: beside the work one came in as.
      useStore.getState().addSources(found.filter((f) => !hasWork(lib?.sources?.[f.item], { platform: f.platform, id: f.work })).map((f) => [f.item, { platform: f.platform, id: f.work, url: f.url ?? "", title: f.title, author: { id: name(f.artist)?.links.find((l) => l.platform === f.platform)?.id ?? "", name: name(f.artist)?.name ?? "" }, tags: [], date: null, adult: false, added: Date.now() }]));
      const done = new Set(found.map((f) => `${f.artist}|${f.key}`));
      change((d) => ({ ...d, found: (d.found ?? []).filter((f) => !done.has(`${f.artist}|${f.key}`)) }));
    },

    async likeTheirs(id, limit = 120) {
      const d = await get().load();
      const root = useStore.getState().root;
      if (!d?.artists[id] || !root) return "No such artist.";
      await useStore.getState().loadAll();
      const all = useStore.getState().allItems.filter((i) => i.kind !== "video");
      // Pictures as the tag index has them: an album by some of its pages.
      const pagesOf = new Map<string, string[]>();
      for (const it of all) if (it.albumKey) pagesOf.set(it.albumKey, [...(pagesOf.get(it.albumKey) ?? []), it.key]);
      const picturesOf = (keys: string[]) => keys.flatMap((k) => (isAlbumArtistKey(k) ? (pagesOf.get(k.slice("album:".length)) ?? []).slice(0, 6) : [k]));
      const theirs = Object.entries(d.items).filter(([, ids]) => ids.includes(id)).map(([k]) => k);
      const yes = picturesOf(theirs);
      if (yes.length < 2) return "Give them a few pictures first (two at least): what looks like those is suggested.";
      const no = new Set((d.notTheirs ?? []).filter((n) => n.startsWith(`${id}|`)).map((n) => n.slice(id.length + 1)));
      // Others' pictures, and the ones turned down: what is nearer one of those isn't theirs.
      const others = picturesOf(Object.entries(d.items).filter(([, ids]) => ids.length && !ids.includes(id)).map(([k]) => k));
      const against = [...picturesOf([...no]), ...others.filter((_, i) => i % Math.max(1, Math.ceil(others.length / 200)) === 0)].slice(0, 260);
      const byKey = new Map(all.map((i) => [i.key, i]));
      const sample = (keys: string[], n: number) => keys.filter((_, i) => i % Math.max(1, Math.ceil(keys.length / n)) === 0);
      const assigned = new Set(Object.entries(d.items).filter(([, ids]) => ids.length).map(([k]) => k));
      const near = await api.tagsRank(root, { queries: sample(yes, 64).map((k) => ({ keys: [k] })), candidates: null, groups: {}, skip: yes, min: 0, limit: limit * 4 }).catch((e) => String(e));
      if (typeof near === "string") return `The tag index couldn't be asked: ${near}`;
      if (!near.length) return "Nothing indexed looks like theirs: is the tag index made (Tags)?";
      const far = against.length ? await api.tagsRank(root, { queries: against.map((k) => ({ keys: [k] })), candidates: near.map(([k]) => k), groups: {}, skip: [], min: -1, limit: near.length }).catch(() => []) : [];
      const otherScore = new Map(far);
      const out = new Map<string, StyleLike>();
      for (const [item, score] of near) {
        const it = byKey.get(item);
        if (!it) continue;
        const key = artistKeyOf(it);
        if (assigned.has(key) || no.has(key) || out.has(key) || (otherScore.get(item) ?? -1) >= score) continue;
        out.set(key, { key, item, score: Math.round(score * 1000) / 1000 });
        if (out.size >= limit) break;
      }
      return out.size ? [...out.values()] : "Nothing looks more like theirs than like other artists' pictures.";
    },

    notTheirs(id, keys) {
      change((d) => ({ ...d, notTheirs: [...new Set([...(d.notTheirs ?? []), ...keys.map((k) => `${id}|${k}`)])], found: (d.found ?? []).filter((f) => !(f.artist === id && keys.includes(f.key))) }));
    },

    rejectFound(found) {
      const no = new Set(found.map((f) => `${f.artist}|${f.key}`));
      change((d) => ({ ...d, notTheirs: [...new Set([...(d.notTheirs ?? []), ...no])], found: (d.found ?? []).filter((f) => !no.has(`${f.artist}|${f.key}`)) }));
    },
  };
});

// Albums linked as translations (the library read, or a link made): their artists join.
useStore.subscribe((st, prev) => {
  // Another library (or none): nothing of the last one's artists shows here (screens that only read
  // them too); this one's are read.
  if (st.root !== prev.root) {
    useArtists.setState({ doc: null, docRoot: null, open: null });
    if (st.root) void useArtists.getState().load();
    return;
  }
  if (st.library?.albumTranslations !== prev.library?.albumTranslations) useArtists.getState().joinVersions();
});

/* ---------- icons: kept with the library, shown from memory ---------- */

const icons = new Map<string, Promise<string>>();

/** An artist's icon as an object URL, or null while it loads (or when they have none). */
export function useArtistIcon(a: LocalArtist | null | undefined): string | null {
  const root = useStore((s) => s.root);
  const key = a?.avatar && root ? `${root}|${a.avatar}|${a.avatarAt}` : null;
  const [src, setSrc] = useState<{ key: string | null; url: string | null }>({ key: null, url: null });
  useEffect(() => {
    if (!key || !root || !a?.avatar) return;
    let p = icons.get(key);
    if (!p) {
      p = api.scrapbookBlob(root, a.avatar).then((buf) => URL.createObjectURL(new Blob([buf], { type: "image/jpeg" })));
      p.catch(() => icons.delete(key));
      icons.set(key, p);
    }
    let live = true;
    p.then(
      (url) => live && setSrc({ key, url }),
      () => live && setSrc({ key, url: null }),
    );
    return () => {
      live = false;
    };
  }, [key, root, a?.avatar]);
  return src.key === key ? src.url : null;
}
