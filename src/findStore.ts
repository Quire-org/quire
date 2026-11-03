/**
 * Find: a platform's pages through its plugin, picks gathered across them, and the pull that brings
 * picks into the library: each pick's files asked for, downloaded (Activity), then Import with the
 * duplicate review, and where each picture came from kept with it.
 */
import { debounced } from "./lib/pending";
import { mayGoOnline, NOT_CONNECTED, useMayGoOnline, useOnline } from "./lib/online";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, type FindDownload } from "./lib/api";
import { steppedJob } from "./lib/jobs";
import { findInLibrary, SURE_MATCH, type HaveResult } from "./lib/findCheck";
import type { ImageHashResult, ItemSource, MediaItem } from "./lib/types";
import { useStore } from "./store";
import { useDupes } from "./dupesStore";
import { finder, useFinders, type FindAccount, type FindArtist, type FindFiles, type FindItem } from "./plugins/find";
import { freshIn, nameFor, newestOf, sameView, saveable, type SavedSearch } from "./lib/savedSearches";
import { allSources, hasWork } from "./lib/sources";

export interface FindView {
  section: string;
  query: string;
  option: string;
  /** An artist's works, opened from a work. */
  author: { id: string; name: string } | null;
  /** On an artist's page: only their works with this tag. */
  tag: string | null;
}

/** "Do I have this?" for a work: being looked for, found (or not), or couldn't be. */
/** What became of the copies' artist: given now (`given`, to take back), theirs already, or another's (left as it was). */
export interface HaveArtist {
  id: string;
  name: string;
  given: string[];
  already: number;
  others: number;
}
export type HaveCheck = { state: "checking" } | ({ state: "done"; artist?: HaveArtist } & HaveResult) | { state: "failed"; error: string };

/** The basket's own section: works kept to look at later, not one of the platform's. */
export const BASKET = "basket";

/**
 * A work in the basket, with the pages of it to keep when it isn't all of them (by their place, from
 * 0), and what "Do I have this?" last said of it (`seen`: when, and whether the library has it).
 */
/** A work kept in the basket: the pages to import (`only`; all without it), whether its pages come in as an album of their own (else each a single picture), and what "Do I have this?" said. */
export type BasketItem = FindItem & { only?: number[]; album?: boolean; seen?: { at: number; have: boolean } };
const BASKET_MAX = 1000;

interface FindState {
  pluginId: string | null;
  /** The account for this platform with this library (a sign-in is kept per library); null while asked. */
  account: FindAccount | null;
  accountFor: string | null;
  view: FindView;
  items: FindItem[];
  /** A section of artists (the ones followed): them instead of works. */
  artists: FindArtist[];
  /** On an artist's page: who they are. */
  artist: FindArtist | null;
  next: string | null;
  title: string | null;
  /** How many the view has in all, when the platform says. */
  total: number | null;
  /** Works kept to look at later, per platform, with the library. */
  baskets: Record<string, BasketItem[]>;
  /**
   * Platforms' and their sites' icons, by address, kept with the library once fetched (a small
   * `data:` picture each), so they show while Quire waits to go online.
   */
  icons: Record<string, string>;
  /** An icon fetched: kept with the library. */
  keepIcon(url: string, data: string): void;
  /** A plugin removed with its data: its basket, saved searches and (its platform's alone) what was seen. */
  forgetPlugin(pluginId: string, platform: string | null): void;
  basketsFor: string | null;
  /**
   * What each work looks like (its fingerprint, as the duplicate check makes one), by
   * "<platform>:<work id>" (a page of several: ":p<n>" after), kept with the basket: a work is only
   * fetched and fingerprinted once, and compared with pictures added later from what is kept.
   */
  sigs: Record<string, ImageHashResult>;
  /** A work's (or one of its pages') fingerprint: kept, else fetched and kept. */
  workSig(pluginId: string, platform: string, key: string, url: string, headers: Record<string, string>): Promise<ImageHashResult | null>;
  checks: Record<string, HaveCheck>;
  /** A work to look at closer as Find opens (asked for from elsewhere: an artist's page, a picture's Info). */
  lookAt: FindItem | null;
  loading: boolean;
  error: string | null;
  /** In the basket and chosen to import, in the order chosen. */
  picks: FindItem[];
  /** Searches (and artists' works with a tag) kept to look at again, every platform's, with the library. */
  saved: SavedSearch[];
  /** The works that have passed the reader's screen, by platform: their ids, the latest last, with the library. */
  seen: Record<string, string[]>;
  /** What had passed the screen before the list on show was opened: "new to me" leaves it out. */
  seenBefore: Set<string>;
  /** A saved search opened: which, and the newest work it had shown before (newer ones are new). */
  visit: { id: string; since: string | null } | null;
  /** Only what is new to the reader: works that hadn't passed their screen before the list was opened. */
  onlyNew: boolean;
  setOnlyNew(on: boolean): void;
  /** How tall a row of works is, in pixels: the grid's size. */
  tile: number;
  setTile(px: number): void;
  /** The view on show kept to look at again (a search, or an artist's works with a tag); null when it can't be. */
  saveSearch(): SavedSearch | null;
  renameSearch(id: string, name: string): void;
  forgetSearch(id: string): void;
  /** A saved search shown again: what came since it was last opened marked new. */
  openSaved(id: string): Promise<void>;
  /** A platform's saved searches asked for what is new, as a job in Activity (not again within minutes unless `force`). */
  checkSaved(pluginId: string, force?: boolean): Promise<void>;
  checking: boolean;
  /** Works that have passed the screen now. */
  markSeen(platform: string, ids: string[]): void;
  pulling: boolean;
  choose(pluginId: string): void;
  refreshAccount(force?: boolean): Promise<void>;
  /** Signed in by the platform's sign-in page, or with what was typed into its fields: whether it worked. */
  signIn(fields?: Record<string, string>): Promise<boolean>;
  /** Another of the platform's sites shown, from its first section. */
  chooseSite(site: string): Promise<void>;
  /** A site added to the platform by its address, then shown: whether it was. */
  addSite(url: string): Promise<boolean>;
  signOut(): Promise<void>;
  /** Show a section (or a search, or an artist), from its first page. */
  open(view: Partial<FindView>): void;
  more(): Promise<void>;
  togglePick(item: FindItem): void;
  clearPicks(): void;
  pull(): Promise<void>;
  loadBaskets(): Promise<void>;
  /** In the basket, or out of it (and then not chosen to import either). */
  toggleBasket(item: FindItem): void;
  /** The pages of a work to keep (null: all of them); it goes into the basket for it. */
  setPages(item: FindItem, only: number[] | null): void;
  /** A work of several pages comes in as an album of its own, or (the default) each page a single picture; it goes into the basket for it. */
  setAlbum(item: FindItem, on: boolean): void;
  /** Looks for a work in the library (also the result when asked again); kept on it in the basket. */
  check(item: FindItem): Promise<void>;
  /** "Do I have this?" for each work in the basket not asked yet (`again`: each one), in Activity. */
  checkBasket(again?: boolean): Promise<void>;
}

let serial = 0;
const signedOutError = (e: unknown) => /sign in/i.test(String(e));

/** Whether Find can show the platform: signed in, or it can be browsed without (or has no accounts at all). */
export const canBrowse = (account: FindAccount | null, pluginId: string | null) => {
  const f = pluginId ? useFinders.getState().finders[pluginId] : undefined;
  return account?.signedIn === true || (!!account && !!f && (f.accounts === false || f.signIn?.optional === true));
};

/** How many works a platform remembers having passed the screen (the oldest go). */
const SEEN_MAX = 40_000;
/** A saved search isn't asked again sooner than this when Find opens (Check asks at once). */
const CHECK_AGAIN_MS = 10 * 60_000;
const TILE_MIN = 140;
const TILE_MAX = 440;
const TILE_DEFAULT = 260;

/** What has passed the screen on a platform, as a set (made from the kept list once). */
const seenSets = new Map<string, Set<string>>();

/**
 * A basket entry with the work as best known: what the basket said of it (pages chosen, album or
 * not), and whichever of the two knows more of the work (a list may say little: one page, no tags).
 */
function knownBest(entry: BasketItem | undefined, item: FindItem): BasketItem {
  if (!entry) return { ...item };
  return {
    ...entry,
    ...item,
    pages: Math.max(entry.pages, item.pages),
    tags: item.tags.length ? item.tags : entry.tags,
    author: item.author.id ? item.author : entry.author,
    ...((item.language ?? entry.language) ? { language: item.language ?? entry.language } : {}),
  };
}

/** A platform's site changed (picked, or added): Find starts again there, from its first section. */
function shown(pluginId: string) {
  const f = useFinders.getState().finders[pluginId];
  if (!f || useFind.getState().pluginId !== pluginId) return;
  serial++;
  useFind.setState({ account: null, accountFor: null, items: [], artists: [], artist: null, next: null, title: null, total: null, error: null, loading: false, picks: [], view: { section: f.sections[0].id, query: "", option: f.sections[0].options[0]?.value ?? "", author: null, tag: null } });
  void useFind.getState().refreshAccount(true);
}

export const useFind = create<FindState>((set, get) => ({
  pluginId: null,
  account: null,
  accountFor: null,
  view: { section: "", query: "", option: "", author: null, tag: null },
  items: [],
  artists: [],
  artist: null,
  next: null,
  title: null,
  total: null,
  loading: false,
  error: null,
  picks: [],
  pulling: false,
  baskets: {},
  basketsFor: null,
  icons: {},
  saved: [],
  seen: {},
  seenBefore: new Set(),
  visit: null,
  onlyNew: readPref("quire.find.onlyNew") === "1",
  tile: Math.min(TILE_MAX, Math.max(TILE_MIN, Number(readPref("quire.find.tile")) || TILE_DEFAULT)),
  checking: false,
  sigs: {},
  checks: {},
  lookAt: null,

  choose(pluginId) {
    if (get().pluginId === pluginId) return;
    const f = useFinders.getState().finders[pluginId];
    if (!f) return;
    serial++;
    set({ pluginId, account: null, accountFor: null, items: [], artists: [], artist: null, next: null, title: null, total: null, error: null, loading: false, picks: [], view: { section: f.sections[0].id, query: "", option: f.sections[0].options[0]?.value ?? "", author: null, tag: null } });
    void get().refreshAccount();
  },

  async refreshAccount(force) {
    const { pluginId } = get();
    const root = useStore.getState().root;
    if (!pluginId || !root) return;
    // Asked per site, where the platform has several.
    const forWhat = `${pluginId}@${root}#${useFinders.getState().finders[pluginId]?.sites?.current ?? ""}`;
    // Asked already (or being asked) for this platform and library.
    if (!force && get().accountFor === forWhat) return;
    set({ accountFor: forWhat, account: null });
    try {
      const account = await finder.account(pluginId);
      if (get().accountFor !== forWhat) return;
      set({ account });
      if (canBrowse(account, pluginId) && !get().items.length) get().open({});
    } catch (e) {
      if (get().accountFor === forWhat) set({ account: { signedIn: false }, error: String(e) });
    }
  },

  async signIn(fields) {
    const { pluginId } = get();
    if (!pluginId) return false;
    try {
      const account = await finder.signIn(pluginId, fields);
      set({ account, error: null });
      if (account.signedIn) get().open({});
      return account.signedIn;
    } catch (e) {
      useStore.getState().toast(String(e).replace(/^Error: /, ""), "error");
      return false;
    }
  },

  async chooseSite(site) {
    const { pluginId } = get();
    if (!pluginId) return;
    try {
      await finder.site(pluginId, site);
      shown(pluginId);
    } catch (e) {
      useStore.getState().toast(String(e).replace(/^Error: /, ""), "error");
    }
  },

  async addSite(url) {
    const { pluginId } = get();
    if (!pluginId) return false;
    try {
      await finder.addSite(pluginId, url);
      shown(pluginId);
      // Its icon kept now, while online, for when it isn't.
      void keepIcons();
      return true;
    } catch (e) {
      useStore.getState().toast(String(e).replace(/^Error: /, ""), "error");
      return false;
    }
  },

  async signOut() {
    const { pluginId } = get();
    if (!pluginId) return;
    serial++;
    const account = await finder.signOut(pluginId).catch(() => ({ signedIn: false }));
    set({ account, items: [], artists: [], artist: null, next: null, title: null, total: null, loading: false, error: null });
    if (canBrowse(account, pluginId)) get().open({});
  },

  setOnlyNew(on) {
    set({ onlyNew: on });
    writePref("quire.find.onlyNew", on ? "1" : "0");
  },

  setTile(px) {
    const tile = Math.min(TILE_MAX, Math.max(TILE_MIN, Math.round(px)));
    set({ tile });
    writePref("quire.find.tile", String(tile));
  },

  saveSearch() {
    const { pluginId, view, items, saved } = get();
    const f = pluginId ? useFinders.getState().finders[pluginId] : null;
    if (!pluginId || !f || !saveable(view, f.sections.find((s) => s.query)?.id ?? null)) return null;
    const site = f.sites?.current ?? null;
    const have = saved.find((s) => s.pluginId === pluginId && s.site === site && sameView(s.view, view));
    if (have) return have;
    // New from now: what it shows now has been seen.
    const s: SavedSearch = { id: `ss${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, pluginId, platform: f.platform, site, name: nameFor(view), view: { ...view }, mark: newestOf(items.map((i) => i.id), null), openedAt: Date.now(), fresh: 0, more: false, checkedAt: Date.now() };
    set({ saved: [...saved, s], visit: { id: s.id, since: s.mark } });
    saveBaskets();
    return s;
  },

  renameSearch(id, name) {
    const clean = name.trim().slice(0, 120);
    if (!clean) return;
    set({ saved: get().saved.map((s) => (s.id === id ? { ...s, name: clean } : s)) });
    saveBaskets();
  },

  forgetSearch(id) {
    set({ saved: get().saved.filter((s) => s.id !== id), visit: get().visit?.id === id ? null : get().visit });
    saveBaskets();
  },

  async openSaved(id) {
    const { pluginId } = get();
    const s = get().saved.find((x) => x.id === id);
    if (!s || s.pluginId !== pluginId) return;
    const f = useFinders.getState().finders[pluginId];
    // One of a platform's several sites: shown first.
    if (s.site && f?.sites && f.sites.current !== s.site) {
      try {
        await finder.site(pluginId, s.site);
      } catch (e) {
        return void useStore.getState().toast(String(e).replace(/^Error: /, ""), "error");
      }
    }
    set({ visit: { id, since: s.mark } });
    get().open({ ...s.view });
  },

  async checkSaved(pluginId, force) {
    await get().loadBaskets();
    const f = useFinders.getState().finders[pluginId];
    const due = get().saved.filter((s) => s.pluginId === pluginId && (force || !s.checkedAt || Date.now() - s.checkedAt > CHECK_AGAIN_MS));
    if (!f || !due.length || get().checking) return;
    set({ checking: true });
    const { job, gate } = steppedJob({ title: `Checking ${due.length} saved search${due.length === 1 ? "" : "es"} on ${f.name}`, source: "Find", total: due.length });
    try {
      for (const [n, s] of due.entries()) {
        if (!(await gate.pass())) break;
        job.update({ done: n, detail: s.name });
        const page = await finder.list(pluginId, { section: s.view.section, query: s.view.query || undefined, option: s.view.option || undefined, author: s.view.author?.id, tag: s.view.tag || undefined, ...(s.site ? { site: s.site } : {}) }).catch(() => null);
        if (!page) continue;
        const ids = page.items.map((i) => i.id);
        const fresh = freshIn(ids, s.mark, seenSet(s.platform));
        set({ saved: get().saved.map((x) => (x.id === s.id ? { ...x, fresh, more: fresh === ids.length && !!page.next && fresh > 0, checkedAt: Date.now() } : x)) });
      }
    } finally {
      job.finish();
      set({ checking: false });
      saveBaskets();
    }
  },

  markSeen(platform, ids) {
    const have = seenSet(platform);
    const add = ids.filter((id) => !have.has(id));
    if (!add.length || get().basketsFor !== useStore.getState().root) return;
    for (const id of add) have.add(id);
    const list = [...(get().seen[platform] ?? []), ...add].slice(-SEEN_MAX);
    if (list.length < have.size) seenSets.set(platform, new Set(list));
    set({ seen: { ...get().seen, [platform]: list } });
    saveSeen();
  },

  open(patch) {
    const view = { ...get().view, ...patch };
    // A section's options start at its first unless one was given.
    if (patch.section && patch.option === undefined) {
      const f = get().pluginId ? useFinders.getState().finders[get().pluginId!] : null;
      const opts = patch.section === "artist" ? f?.artistOptions : f?.sections.find((s) => s.id === patch.section)?.options;
      view.option = opts?.[0]?.value ?? "";
    }
    if (patch.section && patch.section !== "artist") view.author = null;
    // A tag is the artist's: another artist, or another section, starts without it.
    if (patch.tag === undefined && (patch.section !== undefined || patch.author !== undefined)) view.tag = null;
    // A saved search's visit lasts while its view does; what had passed the screen is taken as it is now.
    const visit = get().visit;
    const visiting = visit && get().saved.some((s) => s.id === visit.id && sameView(s.view, view));
    const f = get().pluginId ? useFinders.getState().finders[get().pluginId!] : null;
    set({ view, items: [], artists: [], artist: null, next: null, title: null, total: null, error: null, visit: visiting ? visit : null, seenBefore: new Set(f ? seenSet(f.platform) : []) });
    // The basket is kept here, not asked of the platform.
    if (view.section === BASKET) return void serial++;
    void load(true);
  },

  async more() {
    if (get().loading || !get().next) return;
    await load(false);
  },

  togglePick(item) {
    const picks = get().picks;
    set({ picks: picks.some((p) => p.id === item.id) ? picks.filter((p) => p.id !== item.id) : [...picks, item] });
  },

  clearPicks() {
    set({ picks: [] });
  },

  async pull() {
    const { pluginId, picks } = get();
    const f = pluginId ? useFinders.getState().finders[pluginId] : null;
    const st = useStore.getState();
    if (!pluginId || !f || !picks.length || !st.root || get().pulling) return;
    set({ pulling: true });
    const done = () => set({ pulling: false });
    // Each pick's files: one question to the platform each, at its pace.
    const { job, gate } = steppedJob({ title: `Getting ${picks.length} ready from ${f.name}`, source: "Find", total: picks.length });
    const ready: { item: FindItem; files: FindFiles; album: boolean }[] = [];
    const failed: string[] = [];
    try {
      for (const [i, item] of picks.entries()) {
        if (!(await gate.pass())) break;
        // Not a library key: Activity shows its name, not a picture of the library's.
        job.update({ done: i, total: picks.length, items: [{ key: `find:${item.id}`, name: item.title || item.id }] });
        try {
          const files = await finder.files(pluginId, item.id);
          // Only the pages kept, of a work of several: one left comes in as a single picture.
          const entry = (get().baskets[pluginId] ?? []).find((b) => b.id === item.id);
          if (entry?.only && files.files.length > 1) files.files = files.files.filter((_, i) => entry.only!.includes(i));
          ready.push({ item, files, album: entry?.album ?? !!useFinders.getState().finders[pluginId]?.albums });
        } catch (e) {
          failed.push(`${item.title || item.id} (${String(e).replace(/^Error: /, "")})`);
        }
      }
    } finally {
      job.finish();
    }
    if (gate.stopped || !ready.length) {
      if (failed.length) st.toast(`Couldn't get ${failed.join(", ")}`, "error");
      return done();
    }
    const works: FindDownload[] = ready.map((r) => ({ key: r.item.id, files: r.files.files, ...(r.files.animation ? { animation: r.files.animation } : {}) }));
    let got: Awaited<ReturnType<typeof api.findDownload>>;
    try {
      got = await api.findDownload(pluginId, f.name, works, f.imageHeaders);
    } catch (e) {
      st.toast(`The download stopped: ${String(e)}`, "error");
      void api.findClear();
      return done();
    }
    const byId = new Map(ready.map((r) => [r.item.id, r]));
    for (const g of got) if (g.error) failed.push(`${byId.get(g.key)?.item.title || g.key} (${g.error})`);
    if (failed.length) st.toast(`Couldn't download ${failed.join(", ")}`, "warn");
    const fetched = got.filter((g) => !g.error && g.files.length);
    if (!fetched.length) {
      void api.findClear();
      return done();
    }
    // Each downloaded file's source, to keep with it wherever Import puts it.
    const sourceOf = new Map<string, ItemSource>();
    const added = Date.now();
    for (const g of fetched) for (const path of g.files) sourceOf.set(path, { ...byId.get(g.key)!.files.source, added });
    const pulled = new Set(fetched.map((g) => g.key));
    useStore.setState({
      importOpen: {
        works: fetched.map((g) => ({ files: g.files, folder: byId.get(g.key)!.files.folder, album: byId.get(g.key)!.album })),
        from: f.name,
        placed: (pairs) => {
          const root = useStore.getState().root;
          if (!root) return;
          const rel = (abs: string) => abs.slice(root.length).replace(/^\/+/, "");
          useStore.getState().addSources(pairs.flatMap(([src, to]) => (sourceOf.has(src) ? [[rel(to), sourceOf.get(src)!] as [string, ItemSource]] : [])));
          // In the library now: out of the picks and the basket.
          const basket = get().baskets[pluginId] ?? [];
          set({ picks: get().picks.filter((p) => !pulled.has(p.id)), baskets: { ...get().baskets, [pluginId]: basket.filter((b) => !pulled.has(b.id)) } });
          saveBaskets();
        },
        closed: () => {
          void api.findClear();
          done();
        },
      },
    });
  },

  async loadBaskets() {
    const root = useStore.getState().root;
    if (!root || get().basketsFor === root) return;
    const data = (await api.findStateLoad(root).catch(() => null)) as { baskets?: Record<string, unknown>; sigs?: Record<string, ImageHashResult>; saved?: unknown; seen?: Record<string, unknown> } | null;
    if (useStore.getState().root !== root) return;
    const baskets: Record<string, BasketItem[]> = {};
    for (const [k, v] of Object.entries(data?.baskets ?? {})) if (Array.isArray(v)) baskets[k] = v.filter((i): i is BasketItem => !!i && typeof i.id === "string" && typeof i.thumb === "string").slice(0, BASKET_MAX);
    const saved = (Array.isArray(data?.saved) ? data.saved : []).filter((s): s is SavedSearch => !!s && typeof s.id === "string" && typeof s.pluginId === "string" && !!s.view && typeof s.view.section === "string");
    const seen: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(data?.seen ?? {})) if (Array.isArray(v)) seen[k] = v.filter((x): x is string => typeof x === "string").slice(-SEEN_MAX);
    seenSets.clear();
    const icons: Record<string, string> = {};
    for (const [k, v] of Object.entries((data as { icons?: Record<string, unknown> } | null)?.icons ?? {})) if (typeof v === "string" && v.startsWith("data:image/") && v.length <= ICON_MAX) icons[k] = v;
    set({ baskets, basketsFor: root, sigs: data?.sigs && typeof data.sigs === "object" ? data.sigs : {}, saved, seen, icons });
    void keepIcons();
  },

  forgetPlugin(pluginId, platform) {
    // Its basket, its saved searches, and (when no other plugin brings the platform) what was seen there.
    const baskets = { ...get().baskets };
    delete baskets[pluginId];
    const saved = get().saved.filter((s) => s.pluginId !== pluginId);
    const seen = { ...get().seen };
    if (platform && !Object.values(useFinders.getState().finders).some((f) => f.pluginId !== pluginId && f.platform === platform)) delete seen[platform];
    set({ baskets, saved, seen });
    saveBaskets();
  },

  keepIcon(url, data) {
    if (get().icons[url] === data || data.length > ICON_MAX || get().basketsFor !== useStore.getState().root) return;
    set({ icons: { ...get().icons, [url]: data } });
    saveBaskets();
  },

  async workSig(pluginId, platform, key, url, headers) {
    await get().loadBaskets();
    const at = `${platform}:${key}`;
    const kept = get().sigs[at];
    if (kept) return kept;
    // A fingerprint not kept yet means fetching the picture: not while asking before going online.
    if (!mayGoOnline(pluginId)) return null;
    const h = await api.findImageHash(pluginId, url, headers).catch(() => null);
    if (h && get().basketsFor === useStore.getState().root) {
      set({ sigs: { ...get().sigs, [at]: h } });
      saveBaskets();
    }
    return h;
  },

  toggleBasket(item: FindItem) {
    const { pluginId, baskets, basketsFor } = get();
    if (!pluginId || basketsFor !== useStore.getState().root) return;
    const list = baskets[pluginId] ?? [];
    const leaving = list.some((b) => b.id === item.id);
    // Looked for in the library already: kept on it in the basket.
    const c = get().checks[item.id];
    const kept: BasketItem = c?.state === "done" ? { ...item, seen: { at: Date.now(), have: c.matches.length > 0 } } : item;
    const next = leaving ? list.filter((b) => b.id !== item.id) : [kept, ...list].slice(0, BASKET_MAX);
    set({ baskets: { ...baskets, [pluginId]: next }, picks: leaving ? get().picks.filter((p) => p.id !== item.id) : get().picks });
    saveBaskets();
  },

  setPages(item: FindItem, only: number[] | null) {
    const { pluginId, baskets, basketsFor } = get();
    if (!pluginId || basketsFor !== useStore.getState().root) return;
    const list = baskets[pluginId] ?? [];
    const entry = knownBest(list.find((b) => b.id === item.id), item);
    const pages = [...new Set(only ?? [])].sort((a, b) => a - b);
    if (useFinders.getState().finders[pluginId]?.albums) {
      // An album platform's work comes in whole, as an album; pages picked from it come in instead, each a single picture.
      if (pages.length) Object.assign(entry, { only: pages, album: false });
      else (delete entry.only, delete entry.album);
    } else if (!only || pages.length >= item.pages) delete entry.only;
    else entry.only = pages;
    const next = list.some((b) => b.id === item.id) ? list.map((b) => (b.id === item.id ? entry : b)) : [entry, ...list].slice(0, BASKET_MAX);
    set({ baskets: { ...baskets, [pluginId]: next } });
    saveBaskets();
  },

  setAlbum(item: FindItem, on: boolean) {
    const { pluginId, baskets, basketsFor } = get();
    if (!pluginId || basketsFor !== useStore.getState().root) return;
    const list = baskets[pluginId] ?? [];
    // Said either way: on a platform whose works are albums, not an album is a choice too.
    const entry: BasketItem = { ...knownBest(list.find((b) => b.id === item.id), item), album: on };
    const next = list.some((b) => b.id === item.id) ? list.map((b) => (b.id === item.id ? entry : b)) : [entry, ...list].slice(0, BASKET_MAX);
    set({ baskets: { ...baskets, [pluginId]: next } });
    saveBaskets();
  },

  async check(item: FindItem) {
    const { pluginId } = get();
    const f = pluginId ? useFinders.getState().finders[pluginId] : null;
    if (!pluginId || !f) return;
    const put = (c: HaveCheck) => set({ checks: { ...get().checks, [item.id]: c } });
    put({ state: "checking" });
    try {
      const st = useStore.getState();
      await Promise.all([st.loadAll(), useDupes.getState().loadCache()]);
      // A work of several pages: each of its pages (up to 12), at preview size; else its picture.
      // Fingerprinted once: kept for the next time.
      const kept = item.pages > 1 ? Array.from({ length: Math.min(12, item.pages) }, (_, i) => get().sigs[`${f.platform}:${item.id}:p${i}`]) : [get().sigs[`${f.platform}:${item.id}`]];
      const hashes = kept.every(Boolean)
        ? (kept as ImageHashResult[])
        : item.pages > 1
          ? (await Promise.all((await finder.work(pluginId, item.id)).pages.slice(0, 12).map((p, i) => get().workSig(pluginId, f.platform, `${item.id}:p${i}`, p.preview, f.imageHeaders)))).filter((h): h is ImageHashResult => !!h)
          : [await get().workSig(pluginId, f.platform, item.id, item.thumb, f.imageHeaders)].filter((h): h is ImageHashResult => !!h);
      const now = useStore.getState();
      const found = findInLibrary({ platform: f.platform, id: item.id }, hashes, now.allItems, now.library?.sources ?? {}, useDupes.getState().cache);
      // Its artist only to copies surely it (a picture less alike is shown, not given one).
      put({ state: "done", ...found, artist: await credit(f.platform, item, found.matches.filter((m) => m.why !== "picture" || (m.score ?? 0) >= SURE_MATCH).map((m) => m.item)) });
      // In the basket: remembered there, so it isn't asked again.
      const basket = get().baskets[pluginId] ?? [];
      if (basket.some((b) => b.id === item.id)) {
        set({ baskets: { ...get().baskets, [pluginId]: basket.map((b) => (b.id === item.id ? { ...b, seen: { at: Date.now(), have: found.matches.length > 0 } } : b)) } });
        saveBaskets();
      }
    } catch (e) {
      put({ state: "failed", error: String(e).replace(/^Error: /, "") });
    }
  },

  async checkBasket(again = false) {
    const { pluginId } = get();
    const f = pluginId ? useFinders.getState().finders[pluginId] : null;
    if (!pluginId || !f) return;
    const list = (get().baskets[pluginId] ?? []).filter((b) => again || !b.seen);
    if (!list.length) return;
    const { job, gate } = steppedJob({ title: `Looking for ${list.length} of the basket in your library`, source: "Find", total: list.length });
    let have = 0;
    let fresh = 0;
    let failed = 0;
    try {
      for (const [i, item] of list.entries()) {
        if (!(await gate.pass())) break;
        // Not a library key: Activity shows its name, not a picture of the library's.
        job.update({ done: i, items: [{ key: `find:${item.id}`, name: item.title || item.id }] });
        await get().check(item);
        const c = get().checks[item.id];
        if (c?.state === "done") {
          if (c.matches.length) have++;
          else fresh++;
        } else failed++;
      }
    } finally {
      job.finish();
    }
    useStore.getState().toast(`${have + fresh} of the basket looked for: ${fresh} not in your library, ${have} in it${failed ? `; ${failed} couldn't be checked` : ""}`, failed ? "warn" : "ok");
  },
}));

/**
 * The library's copies of a work found by "Do I have this?": given the work's artist (the one linked
 * to that account, else one made, linked and filled in) where they have none yet (an album's pages:
 * the album), and noted as from that work, as an import notes it, so they show as had from then on.
 */
async function credit(platform: string, item: FindItem, found: MediaItem[]): Promise<HaveArtist | undefined> {
  if (!found.length) return undefined;
  const lib = useStore.getState().library;
  // Noted on each copy that doesn't know this work yet: beside the work it came in as, for one that did (a crosspost).
  const unnoted = found.filter((it) => !hasWork(lib?.sources?.[it.key], { platform, id: item.id }));
  if (unnoted.length) useStore.getState().addSources(unnoted.map((it) => [it.key, { platform, id: item.id, url: item.url ?? "", title: item.title, author: item.author, tags: item.tags, date: item.date, adult: item.adult, ...(item.language ? { language: item.language } : {}), added: Date.now() }]));
  if (!item.author?.id) return undefined;
  const { useArtists, linkedArtist, artistKeyOf } = await import("./artistsStore");
  const doc = await useArtists.getState().load();
  if (!doc) return undefined;
  const keys = [...new Set(found.map(artistKeyOf))];
  const linked = linkedArtist(doc, platform, item.author.id);
  const already = linked ? keys.filter((k) => doc.items[k]?.includes(linked.id)).length : 0;
  const others = keys.filter((k) => doc.items[k]?.length && !(linked && doc.items[k].includes(linked.id))).length;
  const open = keys.filter((k) => !doc.items[k]?.length);
  if (!open.length) return linked ? { id: linked.id, name: linked.name, given: [], already, others } : undefined;
  const id = await useArtists.getState().accept({ key: `${platform}:${item.author.id}`, platform, authorId: item.author.id, name: item.author.name, account: item.author.account, items: open, artist: linked });
  const artist = id ? useArtists.getState().doc?.artists[id] : null;
  return artist ? { id: artist.id, name: artist.name, given: open, already, others } : undefined;
}

/* ---------- the basket, saved searches and what has been seen: kept with the library ---------- */

function seenSet(platform: string): Set<string> {
  let s = seenSets.get(platform);
  if (!s) seenSets.set(platform, (s = new Set(useFind.getState().seen[platform] ?? [])));
  return s;
}

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage */
  }
}

async function writeFind(root: string) {
  const { basketsFor, baskets, sigs, saved, seen, icons } = useFind.getState();
  if (basketsFor === root) await api.findStateSave(root, { version: 1, baskets, sigs, saved, seen, icons }).catch((e) => useStore.getState().toast(`Find's data couldn't be saved: ${String(e)}`, "error"));
}
const findSave = debounced("find", 400, writeFind);
// What has passed the screen is saved more slowly: scrolling marks works seen a few at a time, and
// the list can hold tens of thousands of ids a platform, so saving it at the usual pace rewrote a
// large file every half second. Both saves write the whole state, so one landing after the other
// changes nothing; both are written at once when the library closes.
const seenSave = debounced("find-seen", 5000, writeFind);
function saveBaskets() {
  const { basketsFor } = useFind.getState();
  if (basketsFor) findSave.schedule(basketsFor);
}
function saveSeen() {
  const { basketsFor } = useFind.getState();
  if (basketsFor) seenSave.schedule(basketsFor);
}

/** The current view's first page (reset) or its next one; a newer view's load wins. */
async function load(reset: boolean) {
  const s = useFind.getState();
  if (!s.pluginId) return;
  const mine = ++serial;
  const { view } = s;
  useFind.setState({ loading: true, error: null });
  try {
    const page = await finder.list(s.pluginId, { section: view.section, query: view.query || undefined, option: view.option || undefined, author: view.author?.id, tag: view.tag || undefined, cursor: reset ? undefined : (s.next ?? undefined) });
    if (mine !== serial) return;
    const have = new Set(reset ? [] : useFind.getState().items.map((i) => i.id));
    const artistsHave = new Set(reset ? [] : useFind.getState().artists.map((a) => a.id));
    useFind.setState({
      items: [...(reset ? [] : useFind.getState().items), ...page.items.filter((i) => !have.has(i.id))],
      artists: [...(reset ? [] : useFind.getState().artists), ...page.artists.filter((a) => !artistsHave.has(a.id))],
      artist: page.artist ?? useFind.getState().artist,
      next: page.next,
      title: page.title ?? useFind.getState().title,
      total: page.total ?? (reset ? null : useFind.getState().total),
      loading: false,
    });
    // A saved search opened: what it shows now is what it has shown, and nothing is new in it any more.
    const visit = useFind.getState().visit;
    if (reset && visit)
      useFind.setState({
        saved: useFind.getState().saved.map((x) => (x.id === visit.id && sameView(x.view, view) ? { ...x, mark: newestOf(page.items.map((i) => i.id), x.mark), openedAt: Date.now(), fresh: 0, more: false, checkedAt: Date.now() } : x)),
      });
    if (reset && visit) saveBaskets();
  } catch (e) {
    if (mine !== serial) return;
    useFind.setState({ loading: false, error: String(e).replace(/^Error: /, "") });
    if (signedOutError(e)) useFind.setState({ account: { signedIn: false } });
  }
}

/* ---------- images: through the platform's plugin grant, a few at a time, kept in memory only ---------- */

// Kept while they are at most this many and, once their bytes are known, take at most this much
// memory: a platform's full-size pictures run to several megabytes each, and 800 of them on a count
// alone could hold gigabytes.
const KEEP = 800;
const BUDGET = 256 * 1024 * 1024;
const images = new Map<string, { p: Promise<string>; bytes: number }>();
let held = 0;

/** The oldest pictures let go (their object URLs revoked) while there are too many or they hold too much. */
function evict() {
  while (images.size > 1 && (images.size > KEEP || held > BUDGET)) {
    const [old, entry] = images.entries().next().value!;
    images.delete(old);
    held -= entry.bytes;
    void entry.p.then(URL.revokeObjectURL, () => {});
  }
}
let running = 0;
const queued: (() => void)[] = [];

function slot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queued.shift()?.();
        });
    };
    if (running < 6) go();
    else queued.push(go);
  });
}

/** An object URL for a platform's image (never written to disk). */
/** An icon kept with the library is at most this long (as a `data:` address): a small picture. */
const ICON_MAX = 96 * 1024;

/** A fetched picture (an object URL) as a `data:` address, to keep. */
async function asData(objectUrl: string): Promise<string | null> {
  const blob = await fetch(objectUrl).then((r) => r.blob());
  if (blob.size > (ICON_MAX * 3) / 4) return null;
  return new Promise((done) => {
    const r = new FileReader();
    r.onload = () => done(typeof r.result === "string" ? r.result : null);
    r.onerror = () => done(null);
    r.readAsDataURL(blob);
  });
}

/** An icon fetched as it shows (connected): kept with the library for when it can't be fetched. */
export function keepFetchedIcon(url: string, objectUrl: string) {
  if (useFind.getState().icons[url]) return;
  void asData(objectUrl)
    .then((d) => d && useFind.getState().keepIcon(url, d))
    .catch(() => {});
}

/** Every platform's and site's icon not kept yet, fetched and kept, where going online is allowed. */
export async function keepIcons() {
  const { icons, basketsFor } = useFind.getState();
  if (!basketsFor) return;
  for (const f of Object.values(useFinders.getState().finders)) {
    if (!mayGoOnline(f.pluginId)) continue;
    for (const url of [f.icon, ...(f.sites?.list.map((s) => s.icon) ?? [])]) {
      if (!url || url.startsWith("data:") || icons[url]) continue;
      await findImage(f.pluginId, url)
        .then((o) => keepFetchedIcon(url, o))
        .catch(() => {});
    }
  }
}

export function findImage(pluginId: string, url: string): Promise<string> {
  if (!mayGoOnline(pluginId)) return Promise.reject(new Error(NOT_CONNECTED));
  const k = `${pluginId} ${url}`;
  const have = images.get(k);
  if (have) {
    // Used again: to the back of the line for eviction.
    images.delete(k);
    images.set(k, have);
    return have.p;
  }
  const headers = useFinders.getState().finders[pluginId]?.imageHeaders ?? {};
  const entry = { p: null as unknown as Promise<string>, bytes: 0 };
  entry.p = slot(() => api.findImage(pluginId, url, headers)).then((buf) => {
    // Its size counts from when the bytes arrive (it is 0 while loading); not if it was let go meanwhile.
    if (images.get(k) === entry) {
      entry.bytes = buf.byteLength;
      held += entry.bytes;
      evict();
    }
    return URL.createObjectURL(new Blob([buf]));
  });
  entry.p.catch(() => {
    if (images.get(k) === entry) images.delete(k);
  });
  images.set(k, entry);
  evict();
  return entry.p;
}

/** A platform's image once `show` (in view): its object URL, or null while it loads or if it can't. */
export function useFindImage(pluginId: string | null, url: string | null, show = true): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ for: string | null; src: string | null; failed: boolean }>({ for: null, src: null, failed: false });
  // Not asked for while it may not go online (rather than failing for good): asked for once it may.
  const allowed = useMayGoOnline(pluginId);
  const key = pluginId && url && allowed ? `${pluginId} ${url}` : null;
  useEffect(() => {
    if (!key || !show || state.for === key) return;
    let live = true;
    findImage(pluginId!, url!).then(
      (src) => live && setState({ for: key, src, failed: false }),
      () => live && setState({ for: key, src: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [key, show, pluginId, url, state.for]);
  return state.for === key ? state : { src: null, failed: false };
}

/** The library's pictures from this platform, by the work's id there: what was brought in already. */
export function useHave(platform: string | null): Set<string> {
  const sources = useStore((s) => s.library?.sources);
  const [have, setHave] = useState<Set<string>>(new Set());
  useEffect(() => {
    setHave(new Set(Object.values(sources ?? {}).flatMap((s) => allSources(s).filter((x) => x.platform === platform).map((x) => x.id))));
  }, [sources, platform]);
  return have;
}

/**
 * A work on a platform shown in Find, looked at closer: from what its plugin says of it. In the
 * browser when no plugin has the platform or it can't say (`url`, where there is one).
 */
export async function showWork(platform: string, id: string, url: string | null): Promise<void> {
  const f = Object.values(useFinders.getState().finders).find((x) => x.platform === platform);
  const inBrowser = () => {
    if (url) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url));
  };
  if (!f) return inBrowser();
  try {
    const { item } = await finder.work(f.pluginId, id);
    useFind.getState().choose(f.pluginId);
    useStore.getState().openFind();
    useFind.setState({ lookAt: item });
  } catch {
    useStore.getState().toast(`${f.name} couldn't show that work${url ? "; it opened in your browser" : ""}`, "info");
    inBrowser();
  }
}

// A connection made: the icons not kept yet fetched and kept, for the next time it isn't.
useOnline.subscribe((s, prev) => {
  if (s.connected !== prev.connected || s.settings.ask !== prev.settings.ask) void keepIcons();
});

// Another library (or none): what Find holds of the last one goes, so nothing of it shows or is acted
// on in this one: its "in your library" checks, the works and artist being looked at, the picks, the
// account (kept with the library); a request still on its way is dropped when it comes.
useStore.subscribe((s, p) => {
  if (s.root === p.root) return;
  serial++;
  useFind.setState({ account: null, accountFor: null, items: [], artists: [], artist: null, next: null, title: null, total: null, error: null, loading: false, picks: [], checks: {}, sigs: {}, lookAt: null, visit: null });
});
