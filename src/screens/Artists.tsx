import { useEffect, useMemo, useRef, useState } from "react";
import { ConnectGate } from "../components/ConnectGate";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowClockwise, ArrowLeft, ArrowSquareOut, Basket, Camera, Check, GitMerge, Link as LinkIcon, MagnifyingGlass, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import { TopNav, SideToggle } from "../components/TopNav";
import { Thumb, ALBUM_RATIO } from "../components/Thumb";
import { ArtistIcon } from "../components/ArtistIcon";
import { ArtistLinkPicker } from "../components/ArtistLinkPicker";
import { PlatformIcon } from "../components/PlatformIcon";
import { ArtistIconChooser } from "../components/ArtistIconChooser";
import { ComparePair } from "../components/ComparePair";
import { Modal } from "../components/Modal";
import { StickerBanner } from "../components/StickerBanner";
import { FollowButton } from "../components/FollowButton";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { ask } from "../components/Confirm";
import { eachOnce, useStore } from "../store";
import { albumArtistKey, countsOf, foundOnce, linkedArtist, sameArtists, suggestionsFor, useArtists, type ArtistLink, type ArtistSuggestion, type FoundWork, type LocalArtist, type StyleLike } from "../artistsStore";
import { SURE_MATCH } from "../lib/findCheck";
import { useFind, useFindImage, useHave } from "../findStore";
import { finder as finders_, useFinders, type Finder, type FindArtist, type FindItem } from "../plugins/find";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import type { MediaItem } from "../lib/types";
import { pageGroups, sameSite, shortUrl } from "../lib/artistPages";


type Order = "pictures" | "name" | "newest";

/**
 * Artists: who made the library's pictures. Each has a page with their pictures, and, when linked
 * to a platform account, their icon, what they say about themselves and their other pages, kept
 * with the library. Pictures brought in through Find suggest their artist at the top; nothing is
 * given an artist until it is accepted. Pictures are given one by hand from a selection in Browse.
 */
export function Artists() {
  const a = useArtists();
  const root = useStore((s) => s.root);
  const sideHidden = useStore((s) => s.sideCollapsed);
  const [q, setQ] = useState("");
  const [order, setOrder] = useState<Order>("pictures");
  const find = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void a.load();
    void useStore.getState().loadAll();
  }, [a, root]);

  const open = a.open && a.doc?.artists[a.open] ? a.doc.artists[a.open] : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || dialogOpen()) return;
      const st = useStore.getState();
      if (st.settingsOpen || st.importOpen || st.pluginsOpen || st.helpOpen) return;
      const key = e.key.toLowerCase();
      if (key === "escape") {
        if (useArtists.getState().open) useArtists.getState().setOpen(null);
        else st.openSortQueue();
      } else if (key === "/") find.current?.focus();
      else if (key === "b") st.openBrowse();
      else if (key === "a") st.openAlbums();
      else if (key === "d") st.openDupes();
      else if (key === "e") st.openFiles();
      else if (key === "l") st.openTags();
      else if (key === "k") st.openScrapbook();
      else if (key === "p") st.openPeople();
      else if (key === "g") st.set({ settingsOpen: true });
      else if (key === "h") st.toggleChrome();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`screen ${sideHidden ? "chrome-hidden" : ""}`}>
      <TopNav current="artists" />
      <SideToggle />
      <div className="browse">
        <ArtistsSide q={q} setQ={setQ} order={order} setOrder={setOrder} findRef={find} />
        <main className="browse-main artists-main">{!a.doc ? <div className="find-note dim">Loading the artists…</div> : open ? <ArtistPage artist={open} /> : <Roster q={q} order={order} />}</main>
      </div>
    </div>
  );
}

function ArtistsSide({ q, setQ, order, setOrder, findRef }: { q: string; setQ: (v: string) => void; order: Order; setOrder: (o: Order) => void; findRef: React.RefObject<HTMLInputElement | null> }) {
  const create = useArtists((s) => s.create);
  const setOpen = useArtists((s) => s.setOpen);
  const [name, setName] = useState("");
  const add = () => {
    const id = create(name);
    if (id) (setName(""), setOpen(id));
  };
  return (
    <aside className="browse-side panel">
      <div className="find-search">
        <MagnifyingGlass />
        <input ref={findRef} className="input" placeholder="Find an artist" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Escape" && (setQ(""), e.currentTarget.blur()))} />
        <kbd className="kbd">/</kbd>
      </div>
      <div className="label">Order</div>
      <div className="chips">
        {(["pictures", "name", "newest"] as const).map((o) => (
          <button key={o} className={`btn sm ${order === o ? "active" : ""}`} onClick={() => setOrder(o)}>
            {{ pictures: "Most pictures", name: "Name", newest: "Newest" }[o]}
          </button>
        ))}
      </div>
      <div className="label">New artist</div>
      <div className="side-row">
        <input className="input" placeholder="Their name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.stopPropagation(), e.key === "Enter" && add())} />
        <button className="btn sm" disabled={!name.trim()} onClick={add}>
          <Plus /> Add
        </button>
      </div>
      <p className="small dim find-side-help">Pictures brought in with Find suggest their artist here. To give pictures an artist yourself, select them in Browse and choose Artist….</p>
    </aside>
  );
}

/* ---------- the roster, with what Find suggests ---------- */

function Roster({ q, order }: { q: string; order: Order }) {
  const doc = useArtists((s) => s.doc)!;
  const setOpen = useArtists((s) => s.setOpen);
  const sources = useStore((s) => s.library?.sources);
  const all = useStore((s) => s.allItems);
  const present = useMemo(() => (all.length ? new Set(all.map((i) => i.key)) : null), [all]);
  const albumOf = useMemo(() => {
    const m = new Map(all.filter((i) => i.albumKey).map((i) => [i.key, i.albumKey!]));
    return (k: string) => m.get(k);
  }, [all]);
  const suggestions = useMemo(() => suggestionsFor(doc, sources ?? {}, present, albumOf), [doc, sources, present, albumOf]);
  const counts = useMemo(() => countsOf(doc), [doc]);
  const albumCounts = useMemo(() => countsOf(doc, true), [doc]);
  const toCheck = useMemo(() => {
    const out = new Map<string, number>();
    for (const f of doc.found ?? []) if (present?.has(f.item) ?? true) out.set(f.artist, (out.get(f.artist) ?? 0) + 1);
    return out;
  }, [doc, present]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = Object.values(doc.artists).filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.links.some((l) => l.account.toLowerCase().includes(needle)));
    return shown.sort((a, b) => (order === "name" ? a.name.localeCompare(b.name) : order === "newest" ? b.added - a.added : (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || a.name.localeCompare(b.name)));
  }, [doc, q, order, counts]);

  return (
    <div className="artists-body">
      {suggestions.length > 0 && !q && (
        <section className="artist-suggestions">
          <h2>Suggested by what came in from Find</h2>
          {suggestions.slice(0, 12).map((s) => (
            <Suggestion key={s.key} s={s} />
          ))}
          {suggestions.length > 12 && <div className="small dim">And {suggestions.length - 12} more, after these.</div>}
        </section>
      )}
      <section>
        <div className="artists-head">
          <h2>Artists</h2>
          <span className="faint mono small">{list.length}</span>

        </div>
        {list.length ? (
          <div className="artists-grid">
            {list.map((a) => (
              <ArtistCard key={a.id} artist={a} count={counts[a.id] ?? 0} albums={albumCounts[a.id] ?? 0} toCheck={toCheck.get(a.id) ?? 0} onOpen={() => setOpen(a.id)} />
            ))}
          </div>
        ) : (
          <div className="find-note dim">{q ? `No artist called “${q}”.` : "No artists yet. Accept a suggestion above when pictures come in with Find, or add one by name on the left."}</div>
        )}
      </section>
    </div>
  );
}

function Suggestion({ s }: { s: ArtistSuggestion }) {
  const accept = useArtists((st) => st.accept);
  const dismiss = useArtists((st) => st.dismiss);
  const anyArtists = useArtists((st) => Object.keys(st.doc?.artists ?? {}).length > 0);
  const [linking, setLinking] = useState(false);
  const all = useStore((st) => st.allItems);
  const byKey = useMemo(() => new Map(all.map((i) => [i.key, i])), [all]);
  const items = s.items.map((k) => byKey.get(k)).filter((i): i is MediaItem => !!i);
  const platform = useFinders((f) => Object.values(f.finders).find((x) => x.platform === s.platform)?.name ?? s.platform);
  return (
    <div className="artist-suggestion panel">
      <div className="artist-suggestion-pics">
        {items.slice(0, 4).map((it) => (
          <Thumb key={it.key} item={it} aspect={1} onClick={() => useStore.getState().openViewer(items, items.indexOf(it), { kind: "browse" })} />
        ))}
      </div>
      <div className="grow artist-suggestion-text">
        <b>{s.artist ? s.artist.name : s.name}</b>
        <span className="small dim">
          {s.items.length} picture{s.items.length === 1 ? "" : "s"} from {platform}
          {s.account ? ` (@${s.account})` : ""}
          {s.artist ? ", without their artist yet" : ""}
        </span>
      </div>
      <button className="btn primary" onClick={() => void accept(s)}>
        {s.artist ? `Give them to ${s.artist.name}` : "Make them an artist"}
      </button>
      {!s.artist && anyArtists && (
        <button className="btn" onClick={() => setLinking(true)} title="One of your artists already, met on another platform: this account linked to them">
          Link to an existing artist…
        </button>
      )}
      {linking && (
        <ArtistLinkPicker
          name={s.name || s.account}
          title={`${s.name || s.account} on ${platform} is…`}
          onClose={() => setLinking(false)}
          onPick={(a) => {
            setLinking(false);
            accept(s, a.id).then(
              () => useStore.getState().toast(`${s.name || s.account} on ${platform} is ${a.name} now: their pictures are theirs`, "ok"),
              (e) => useStore.getState().toast(String(e).replace(/^Error: /, ""), "error"),
            );
          }}
        />
      )}
      <button className="btn ghost" onClick={() => dismiss(s)} title="Don't suggest these again">
        Not now
      </button>
    </div>
  );
}

function ArtistCard({ artist, count, albums, toCheck, onOpen }: { artist: LocalArtist; count: number; albums: number; toCheck: number; onOpen: () => void }) {
  return (
    <button className="artist-card" onClick={onOpen}>
      <ArtistIcon artist={artist} size={72} />
      <span className="artist-card-text">
        <b className="ellipsis">{artist.name}</b>
        <span className="small dim">
          {count} picture{count === 1 ? "" : "s"}
          {albums ? ` · ${albums} album${albums === 1 ? "" : "s"}` : ""}
          {toCheck > 0 && <span className="artist-to-check"> · {toCheck} of yours to check</span>}
          {artist.links.length ? ` · ${artist.links.map((l) => l.platform).join(", ")}` : ""}
        </span>
      </span>
    </button>
  );
}

/* ---------- an artist's page ---------- */

type Tab = "theirs" | "found" | "style" | "more";
const TABS: { id: Tab; label: string }[] = [
  { id: "theirs", label: "Theirs" },
  { id: "found", label: "From {platform}, in your library" },
  { id: "style", label: "Like their style" },
  { id: "more", label: "More on {platform}" },
];
let lastTab: Tab = "theirs";

/** Platforms named as a sentence does: "Gallery", "Gallery and Posts", "their 3 platforms". */
const platformList = (names: string[]) => (names.length === 0 ? "their platform" : names.length <= 2 ? names.join(" and ") : `their ${names.length} platforms`);

function ArtistPage({ artist }: { artist: LocalArtist }) {
  const a = useArtists();
  const all = useStore((s) => s.allItems);
  const finders = useFinders((f) => f.finders);
  const [renaming, setRenaming] = useState(false);
  const [linking, setLinking] = useState(false);
  const [address, setAddress] = useState("");
  const [merging, setMerging] = useState(false);
  const [sure, setSure] = useState(false);
  const [choosingIcon, setChoosingIcon] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const busy = a.busy[artist.id];
  const items = useMemo(() => all.filter((i) => a.doc?.items[i.key]?.includes(artist.id)), [all, a.doc, artist.id]);
  const allAlbums = useStore((s) => s.albums);
  const links = useStore((s) => s.library?.albumTranslations);
  useEffect(() => void useStore.getState().loadAlbums(), []);
  const albums = useMemo(() => eachOnce(allAlbums).filter((al) => a.doc?.items[albumArtistKey(al.key)]?.includes(artist.id)), [allAlbums, links, a.doc, artist.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const others = Object.values(a.doc?.artists ?? {}).filter((x) => x.id !== artist.id).sort((x, y) => x.name.localeCompare(y.name));
  const say = (e: unknown) => useStore.getState().toast(String(e).replace(/^Error: /, ""), "error");
  const finderFor = (platform: string) => Object.values(finders).find((f) => f.platform === platform);
  const linkedTo = artist.links.map((l) => finderFor(l.platform)).find(Boolean);
  // "More on …": one of the platforms they are linked on at a time.
  const moreLinks = artist.links.filter((l) => finderFor(l.platform));
  const [moreOn, setMoreOn] = useState<string | null>(null);
  const moreLink = moreLinks.find((l) => `${l.platform}:${l.id}` === moreOn) ?? moreLinks[0];
  // Every platform Find has that they are linked on: the tabs look on all of them.
  const platformNames = [...new Set(artist.links.map((l) => finderFor(l.platform)?.name).filter((n): n is string => !!n))];
  // The tab last open (on any artist's page), kept for coming back.
  const [tab, setTabNow] = useState<Tab>(() => lastTab);
  const setTab = (t: Tab) => ((lastTab = t), setTabNow(t));
  const toCheck = (a.doc?.found ?? []).filter((f) => f.artist === artist.id).length;
  // Met on another platform too: an artist with a page in common.
  const same = useMemo(() => sameArtists(a.doc, artist.id), [a.doc, artist.id]);
  const join = (other: LocalArtist) => {
    // The one with an icon is kept (its name and icon stay), else the one with more pictures.
    const n = countsOf(a.doc);
    const keepOther = !!other.avatar !== !!artist.avatar ? !!other.avatar : (n[other.id] ?? 0) > (n[artist.id] ?? 0);
    a.merge(keepOther ? artist.id : other.id, keepOther ? other.id : artist.id);
  };

  /**
   * Linked to their account on a platform from their pages there: the one the platform's plugin
   * takes for an account (the others, a shop or a sketchbook, are left alone). An account linked to
   * another of your artists already: offered to join the two.
   */
  const linkFromPage = async (f: Finder, pages: { url: string }[]) => {
    const tries = await Promise.allSettled(pages.map((p) => finders_.artist(f.pluginId, { url: p.url })));
    const hit = tries.find((t): t is PromiseFulfilledResult<FindArtist> => t.status === "fulfilled");
    if (!hit) {
      const why = [...new Set(tries.map((t) => String((t as PromiseRejectedResult).reason).replace(/^Error: /, "")))];
      return say(`No account on ${f.name} among these pages: ${why.join("; ")}`);
    }
    const prof = hit.value;
    const other = linkedArtist(a.doc, f.platform, prof.id);
    if (other && other.id !== artist.id) {
      const sure = await ask({
        title: `${other.name} on ${f.name} already`,
        message: `${prof.name || prof.account} on ${f.name} is linked to ${other.name}. If ${artist.name} is the same artist, join the two: one artist, with the pictures, platforms and pages of both.`,
        confirm: "Join them",
      });
      if (sure) join(other);
      return;
    }
    await a.linkTo(artist.id, { platform: f.platform, id: prof.id, account: prof.account, url: prof.url }).catch(say);
  };

  /** One of their pages on a platform Find has, shown there: whose it is, asked of the platform's plugin; in the browser when it can't say. */
  const openPageInFind = async (f: Finder, url: string) => {
    let prof;
    try {
      prof = await finders_.artist(f.pluginId, { url });
    } catch {
      useStore.getState().toast(`${f.name} can't show that page in Find; it opened in your browser`, "info");
      return void openUrl(url);
    }
    useFind.getState().choose(f.pluginId);
    useStore.getState().openFind();
    useFind.getState().open({ section: "artist", author: { id: prof.id, name: prof.name || artist.name } });
  };

  const openInFind = async (platform: string, id: string, site?: string) => {
    const f = finderFor(platform);
    if (!f) return;
    useFind.getState().choose(f.pluginId);
    useStore.getState().openFind();
    // One of the platform's sites: shown first.
    if (site && f.sites?.current !== site) await useFind.getState().chooseSite(site);
    useFind.getState().open({ section: "artist", author: { id, name: artist.name } });
  };

  return (
    <div className="artist-page">
      <div className="artist-head">
        <button className="btn sm ghost" onClick={() => a.setOpen(null)} title="All the artists (Esc)">
          <ArrowLeft /> Artists
        </button>
        {renaming && (
          <input
            className="input artist-rename"
            autoFocus
            defaultValue={artist.name}
            onBlur={() => setRenaming(false)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") (a.rename(artist.id, e.currentTarget.value), setRenaming(false));
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        )}
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => setRenaming(true)}>
          <PencilSimple /> Rename
        </button>
        <span className="merge">
          <button className="btn sm ghost" disabled={!others.length} onClick={() => setMerging(!merging)}>
            <GitMerge /> Same as…
          </button>
          {merging && (
            <div className="merge-menu panel">
              {others.map((x) => (
                <button key={x.id} className="btn sm ghost" onClick={() => (setMerging(false), a.merge(artist.id, x.id))} title={`${artist.name}'s pictures and links go to ${x.name}`}>
                  {x.name}
                </button>
              ))}
            </div>
          )}
        </span>
        {sure ? (
          <>
            <span className="small">Remove {artist.name}? Their pictures stay.</span>
            <button className="btn sm danger" onClick={() => a.remove(artist.id)}>
              Remove
            </button>
            <button className="btn sm ghost" onClick={() => setSure(false)}>
              Keep
            </button>
          </>
        ) : (
          <button className="btn sm ghost" onClick={() => setSure(true)}>
            <Trash /> Remove
          </button>
        )}
      </div>

      {same.map(({ artist: o, via }) => (
        <div key={o.id} className="artist-same">
          <GitMerge />
          <span className="grow">
            The same artist as <b>{o.name}</b>? Both have <span className="mono">{via}</span>.
          </span>
          <button className="btn sm" onClick={() => join(o)} title="One artist: the pictures, platforms and pages of both">
            Join them
          </button>
          <button className="btn sm ghost" onClick={() => a.notSame(artist.id, o.id)}>
            Not the same
          </button>
        </div>
      ))}

      {/* The same keepsake as a person's: a page from the theme's own sticker book. */}
      <StickerBanner
        key={artist.id}
        target={{ kind: "artist", id: artist.id }}
        banner={artist.banner}
        tape="Artists"
        photo={
          <button className="banner-photo" onClick={() => setChoosingIcon(true)} title="Cut an icon from their art">
            <ArtistIcon artist={artist} size={150} />
            <span className="banner-photo-edit">
              <Camera />
            </span>
          </button>
        }
        name={artist.name}
        line={
          <>
            {items.length.toLocaleString("en-GB")} picture{items.length === 1 ? "" : "s"}
            {albums.length ? ` · ${albums.length} album${albums.length === 1 ? "" : "s"}` : ""}
            {artist.region ? ` · ${artist.region}` : ""}
          </>
        }
      />
      {choosingIcon && <ArtistIconChooser artist={artist} pictures={[...items, ...albums.flatMap((al) => (al.cover ? [al.cover] : []))]} onClose={() => setChoosingIcon(false)} />}
      <section className="artist-about">
        {artist.fetched ? (
          <div className="small dim">
            Filled in from {artist.links[0]?.platform ?? "their platform"} on {new Date(artist.fetched).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          </div>
        ) : null}
        {/* Each platform they are on, a line of its own: who they are there, and following them there. */}
        {artist.links.length > 0 && (
          <div className="artist-platforms">
            {artist.links.map((l) => {
              const f = finderFor(l.platform);
              // A platform of several sites: the same account on each, followed (and looked at) site by site.
              const sites = f?.sites?.list ?? [];
              return (
                <div key={`${l.platform}:${l.id}`} className="artist-platform-group">
                  <div className="artist-platform">
                    {f ? <PlatformIcon pluginId={f.pluginId} url={sites.length ? null : f.icon} size={18} /> : <LinkIcon />}
                    <b>{f?.name ?? l.platform}</b>
                    {l.account && <span className="dim mono small ellipsis">@{l.account}</span>}
                    <span className="grow" />
                    {f && !sites.length && <FollowButton pluginId={f.pluginId} artistId={l.id} name={`${artist.name} on ${f.name}`} />}
                    {f && !sites.length && (
                      <button className="btn sm ghost" onClick={() => void openInFind(l.platform, l.id)} title={`Their works on ${f.name}, in Find`}>
                        <MagnifyingGlass /> In Find
                      </button>
                    )}
                    {l.url && (
                      <button className="btn sm ghost" onClick={() => void openUrl(l.url!)} title={`Their page on ${f?.name ?? l.platform}, in your browser`}>
                        <ArrowSquareOut />
                      </button>
                    )}
                    <button className="btn sm ghost" onClick={() => a.unlink(artist.id, l)} title={`Unlink them from ${f?.name ?? l.platform}`}>
                      <X />
                    </button>
                  </div>
                  {f &&
                    sites.map((site) => (
                      <div key={site.id} className="artist-platform artist-platform-site">
                        <PlatformIcon pluginId={f.pluginId} url={site.icon} size={16} />
                        <span className="ellipsis">{site.name}</span>
                        <span className="grow" />
                        <FollowButton pluginId={f.pluginId} artistId={l.id} site={site.id} name={`${artist.name} on ${site.name}`} />
                        <button className="btn sm ghost" onClick={() => void openInFind(l.platform, l.id, site.id)} title={`Their works on ${site.name}, in Find`}>
                          <MagnifyingGlass /> In Find
                        </button>
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        )}
        {artist.pages.length > 0 && (
          <div className="artist-pages">
            {pageGroups(artist.pages).map((g) => {
              // A site Find has a plugin for: its own icon, and linking them there in one press.
              const f = Object.values(finders).find((x) => (x.site && sameSite(x.site, g.pages[0].url)) || x.name.toLowerCase() === g.label.toLowerCase());
              const linked = !!f && artist.links.some((l) => l.platform === f.platform);
              return (
                <div key={g.label} className={`artist-pages-site ${f ? "integrated" : ""}`}>
                  <span className="artist-pages-name">
                    {f ? <PlatformIcon pluginId={f.pluginId} url={f.sites?.list.length ? null : f.icon} size={16} /> : <ArrowSquareOut />}
                    <b>{g.label}</b>
                  </span>
                  <span className="artist-pages-links">
                    {g.pages.map((p) => (
                      <button key={p.url} className="btn sm ghost mono" onClick={() => void (f ? openPageInFind(f, p.url) : openUrl(p.url))} title={f ? `${p.url}: their works on ${f.name}, in Find` : `${p.url}, in your browser`}>
                        {shortUrl(p.url)}
                      </button>
                    ))}
                  </span>
                  {f && !linked && (
                    <button className="btn sm" disabled={!!busy} onClick={() => void linkFromPage(f, g.pages)} title={`Link them to this account on ${f.name}: their works there in Find, and following them`}>
                      <LinkIcon /> Link
                    </button>
                  )}
                  {f && linked && <span className="dim small">linked above</span>}
                </div>
              );
            })}
          </div>
        )}
        <div className="row artist-actions">
          {artist.links.length > 0 && (
            <button className="btn sm" disabled={!!busy} onClick={() => void a.refresh(artist.id).catch(say)} title="Their icon, description and pages again, from where they're linked">
              <ArrowClockwise /> {busy ?? `Fill in from ${finderFor(artist.links[0].platform)?.name ?? artist.links[0].platform}`}
            </button>
          )}
          {linking ? (
            <span className="row artist-link-field">
              <input
                className="input"
                autoFocus
                placeholder="A link to their page on the platform"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && address.trim()) void a.linkByAddress(artist.id, address).then(() => (setLinking(false), setAddress("")), say);
                  if (e.key === "Escape") setLinking(false);
                }}
              />
              <button className="btn sm" disabled={!address.trim() || !!busy} onClick={() => void a.linkByAddress(artist.id, address).then(() => (setLinking(false), setAddress("")), say)}>
                Link
              </button>
            </span>
          ) : (
            <button className="btn sm ghost" onClick={() => setLinking(true)} title="Link them to their account on a platform: their icon, description and pages come from there">
              <LinkIcon /> Link to a platform…
            </button>
          )}
        </div>
      </section>

      {artist.bio && <p className="artist-bio">{artist.bio}</p>}

      <div className="page-tabs artist-tabs" role="tablist">
        {TABS.filter((t) => (t.id !== "found" && t.id !== "more") || linkedTo).map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`page-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label.replace("{platform}", platformList(platformNames))}
            {t.id === "theirs" && <span className="faint mono small">{items.length + albums.length}</span>}
            {t.id === "found" && toCheck > 0 && <span className="mono small artist-to-check">{toCheck}</span>}
          </button>
        ))}
      </div>

      {tab === "theirs" && (
        <>
      {albums.length > 0 && (
        <section>
          <div className="artists-head">
            <h2>Albums</h2>
            <span className="faint mono small">{albums.length}</span>
          </div>
          <div className="artist-pics">
            {albums.map((al) => (
              <div
                key={al.key}
                className="artist-album"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ at: { x: e.clientX, y: e.clientY }, items: [{ label: `Not by ${artist.name}`, onClick: () => a.unassign([albumArtistKey(al.key)], artist.id) }] });
                }}
              >
                {al.cover ? <Thumb item={al.cover} aspect={1} album name={al.name} onClick={() => void useStore.getState().openAlbum(al)} /> : <button className="artist-album-empty" onClick={() => void useStore.getState().openAlbum(al)}>{al.name}</button>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="artists-head">
          <h2>Pictures</h2>
          <span className="faint mono small">{items.length}</span>
        </div>
        {items.length ? (
          <div className="artist-pics">
            {items.map((it, i) => (
              <div
                key={it.key}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ at: { x: e.clientX, y: e.clientY }, items: [{ label: `Not by ${artist.name}`, onClick: () => a.unassign([it.key], artist.id) }] });
                }}
              >
                <Thumb item={it} aspect={1} onClick={() => useStore.getState().openViewer(items, i, { kind: "browse" })} />
              </div>
            ))}
          </div>
        ) : (
          <div className="find-note dim">No pictures of theirs yet. Select pictures in Browse and choose Artist… to give them {artist.name}.</div>
        )}
      </section>
        </>
      )}
      {tab === "found" && linkedTo && <FoundWorks artist={artist} />}
      {tab === "style" && <LikeTheirStyle artist={artist} />}
      {tab === "more" && moreLink && (
        <>
          {/* On several platforms: one at a time. */}
          {moreLinks.length > 1 && (
            <div className="chips artist-more-platforms" role="tablist" aria-label="Platform">
              {moreLinks.map((l) => {
                const f = finderFor(l.platform)!;
                const on = l === moreLink;
                return (
                  <button key={`${l.platform}:${l.id}`} role="tab" aria-selected={on} className={`btn sm ${on ? "active" : "ghost"}`} onClick={() => setMoreOn(`${l.platform}:${l.id}`)}>
                    <PlatformIcon pluginId={f.pluginId} url={f.sites?.list.length ? null : f.icon} size={14} /> {f.name}
                  </button>
                );
              })}
            </div>
          )}
          <ConnectGate pluginId={finderFor(moreLink.platform)!.pluginId} name={finderFor(moreLink.platform)!.name}>
            <MoreWork key={`${moreLink.platform}:${moreLink.id}`} artist={artist} link={moreLink} finder={finderFor(moreLink.platform)!} />
          </ConnectGate>
        </>
      )}
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </div>
  );
}

/**
 * Their works in your library: what a look through their works on their platform found (the same
 * picture as one of them, by the duplicate check's fingerprints, lenient on a part painted again),
 * surest first, to say yes to (theirs, and noted as from that work) or no (not suggested again).
 */
function FoundWorks({ artist }: { artist: LocalArtist }) {
  const doc = useArtists((s) => s.doc);
  const looking = useArtists((s) => s.looking);
  const all = useStore((s) => s.allItems);
  const byKey = useMemo(() => new Map(all.map((i) => [i.key, i])), [all]);
  // One a picture or album, however many of their works look like it (as kept before, several).
  const found = useMemo(() => foundOnce((doc?.found ?? []).filter((f) => f.artist === artist.id && byKey.has(f.item))).sort((x, y) => y.score - x.score), [doc, artist.id, byKey]);
  const looked = doc?.looked?.[artist.id];
  const sure = found.filter((f) => f.score >= SURE_MATCH);
  const a = useArtists.getState();
  const finders = useFinders((s) => s.finders);
  // One clicked: yours and their work side by side, to see they are the same.
  const [comparing, setComparing] = useState<FoundWork | null>(null);
  const comparedOn = comparing ? Object.values(finders).find((f) => f.platform === comparing.platform) : undefined;
  const inViewer = (f: FoundWork) => {
    const list = found.map((x) => byKey.get(x.item)).filter((i): i is MediaItem => !!i);
    useStore.getState().openViewer(list, Math.max(0, list.findIndex((i) => i.key === f.item)), { kind: "browse" });
  };
  return (
    <section className="artist-found">
      <div className="artists-head">
        <h2>Their works in your library</h2>
        {found.length > 0 && <span className="faint mono small">{found.length}</span>}
        <span className="grow" />
        {sure.length > 0 && (
          <button className="btn sm primary" onClick={() => a.acceptFound(sure)} title={`The ${sure.length} surely their works: ${artist.name}'s`}>
            <Check /> Yes to the {sure.length} sure one{sure.length === 1 ? "" : "s"}
          </button>
        )}
        <button className={`btn sm ${looked ? "ghost" : ""}`} disabled={looking} onClick={() => void a.lookForWorks([artist.id])} title="Their works on each platform they are linked on, looked for in your library by the duplicate check's fingerprints, in Activity">
          <MagnifyingGlass /> {looked ? "Look again" : "Look for their works in your library"}
        </button>
      </div>
      <div className="small dim">
        {looked ? `${looked.works.length.toLocaleString("en-GB")} of their works looked for, last on ${new Date(looked.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}; looked again, only new works are fetched, and all are compared with your pictures as they are then. ` : "Their works are each compared with your pictures' fingerprints from the duplicate check: the same picture, even resized, saved again or with a part painted over. Each work is fetched once and its fingerprint kept. "}
        {found.length ? "Yes gives them the picture (an album's page: the album); no keeps it from being suggested for them again." : looked ? "None of the pictures fingerprinted so far is one of them." : ""}
      </div>
      {found.length > 0 && (
        <div className="artist-found-grid">
          {found.map((f) => {
            const it = byKey.get(f.item)!;
            return (
              <div key={`${f.key}|${f.work}`} className={`artist-found-tile ${f.score < SURE_MATCH ? "unsure" : ""}`}>
                <Thumb item={it} aspect={1} onClick={() => (Object.values(finders).some((x) => x.platform === f.platform) ? setComparing(f) : inViewer(f))} />
                <span className="artist-found-score mono" title={f.score < SURE_MATCH ? "Less sure: look closer" : "Surely the same picture"}>
                  {Math.round(f.score * 100)}%
                </span>
                <span className="artist-found-work small ellipsis" title={`${f.title} on ${f.platform}${(f.matches ?? 1) > 1 ? `, and ${(f.matches ?? 1) - 1} more of their works that look like it (the same work in other languages, say)` : ""}`}>
                  {f.title || f.work}
                  {(f.matches ?? 1) > 1 && <span className="faint"> · {f.matches} works</span>}
                </span>
                <span className="artist-found-actions">
                  <button className="btn sm" onClick={() => a.acceptFound([f])} title={`Yes, ${artist.name}'s`}>
                    <Check />
                  </button>
                  <button className="btn sm" onClick={() => a.rejectFound([f])} title={`Not ${artist.name}'s`}>
                    <X />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {comparing && comparedOn && (
        <Modal title="The same picture?" onClose={() => setComparing(null)} wide>
          <div className="source-compare">
            <ComparePair
              item={byKey.get(comparing.item)}
              name={comparing.item.split("/").pop() ?? comparing.item}
              pluginId={comparedOn.pluginId}
              workId={comparing.work}
              caption={
                <>
                  <b>{comparedOn.name}</b> · {comparing.title || comparing.work}
                </>
              }
            />
            <div className="row source-compare-acts">
              <button className="btn sm ghost" onClick={() => setComparing(null)}>
                <ArrowLeft /> Back <kbd className="kbd">Esc</kbd>
              </button>
              <span className={`badge ${comparing.score >= SURE_MATCH ? "accent2" : ""}`}>{Math.round(comparing.score * 100)}% alike</span>
              <span className="grow" />
              <button className="btn sm ghost" onClick={() => (inViewer(comparing), setComparing(null))} title="Yours in the viewer, with the others found">
                Open in the viewer
              </button>
              <button className="btn sm ghost" onClick={() => (a.rejectFound([comparing]), setComparing(null))} title={`Not ${artist.name}'s`}>
                <X /> Not theirs
              </button>
              <button className="btn sm primary" onClick={() => (a.acceptFound([comparing]), setComparing(null))} title={`Yes, ${artist.name}'s`}>
                <Check /> Yes, theirs
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

/**
 * Pictures in the library that look like theirs, perhaps theirs though not on any platform: by how
 * pictures look (the tag index), nearer one of theirs than any of other artists' or those turned
 * down, best first. Pick some (click; shift-click for a run) and say yes or no to them together; a
 * double click opens one. Asked for on demand: their pictures change what is suggested.
 */
function LikeTheirStyle({ artist }: { artist: LocalArtist }) {
  const all = useStore((s) => s.allItems);
  const byKey = useMemo(() => new Map(all.map((i) => [i.key, i])), [all]);
  const [got, setGot] = useState<StyleLike[] | string | null>(() => styleCache.get(artist.id) ?? null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [last, setLast] = useState<number | null>(null);
  const ask = async () => {
    setBusy(true);
    const r = await useArtists.getState().likeTheirs(artist.id);
    styleCache.set(artist.id, r);
    setGot(r);
    setPicked(new Set());
    setBusy(false);
  };
  const list = Array.isArray(got) ? got.filter((g) => byKey.has(g.item)) : [];
  const drop = (keys: string[]) => {
    const left = list.filter((g) => !keys.includes(g.key));
    styleCache.set(artist.id, left);
    setGot(left);
    setPicked(new Set());
  };
  const yes = (keys: string[]) => (useArtists.getState().assign(keys, artist.id), drop(keys));
  const no = (keys: string[]) => (useArtists.getState().notTheirs(artist.id, keys), drop(keys));
  const pick = (i: number, e: React.MouseEvent) => {
    const k = list[i].key;
    setPicked((s) => {
      const n = new Set(s);
      if (e.shiftKey && last !== null) for (let j = Math.min(last, i); j <= Math.max(last, i); j++) n.add(list[j].key);
      else if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
    setLast(i);
  };
  const open = (i: number) => {
    const items = list.map((g) => byKey.get(g.item)).filter((x): x is MediaItem => !!x);
    useStore.getState().openViewer(items, i, { kind: "browse" });
  };
  return (
    <section className="artist-style">
      <div className="artists-head">
        <h2>Like their style</h2>
        {list.length > 0 && <span className="faint mono small">{list.length}</span>}
        <span className="grow" />
        {picked.size > 0 && (
          <>
            <button className="btn sm primary" onClick={() => yes([...picked])}>
              <Check /> {artist.name}'s: the {picked.size} picked
            </button>
            <button className="btn sm" onClick={() => no([...picked])}>
              <X /> Not theirs
            </button>
          </>
        )}
        {list.length > 0 && picked.size < list.length && (
          <button className="btn sm ghost" onClick={() => setPicked(new Set(list.map((g) => g.key)))}>
            Pick all
          </button>
        )}
        <button className={`btn sm ${got ? "ghost" : ""}`} disabled={busy} onClick={() => void ask()}>
          <MagnifyingGlass /> {busy ? "Looking…" : got ? "Look again" : "Find pictures like theirs"}
        </button>
      </div>
      <div className="small dim">
        Pictures of yours that look like theirs, by how pictures look (the tag index): what they draw counts as much as how they draw it, so these are guesses to look over. Nearer one of theirs than any other artist's pictures or ones you said no to; the more of theirs and the more noes, the better it gets. Click to pick (shift for a run), double-click to look closer.
      </div>
      {typeof got === "string" && <div className="find-note dim">{got}</div>}
      {list.length > 0 && (
        <div className="artist-found-grid">
          {list.map((g, i) => {
            const it = byKey.get(g.item)!;
            return (
              <div key={g.key} className={`artist-style-tile ${picked.has(g.key) ? "picked" : ""}`} onDoubleClick={() => open(i)}>
                <Thumb item={it} aspect={g.key.startsWith("album:") ? ALBUM_RATIO : 1} selected={picked.has(g.key)} onClick={(e) => pick(i, e)} album={g.key.startsWith("album:")} />
                <span className="artist-found-score mono">{Math.round(g.score * 100)}%</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
/** What "Like their style" last found for each artist, while the app runs. */
const styleCache = new Map<string, StyleLike[] | string>();

/**
 * More of their work: their newest works on the platform they're linked to, the ones not in the
 * library (as far as it knows: brought in through Find, or found by "Do I have this?"). A click looks
 * closer in Find; the corner puts one in the basket.
 */
/**
 * Their works on a platform: page after page until a screenful isn't in the library (at most a few
 * pages at a time, for someone with hundreds you have), more on asking.
 */
const MORE_SCREEN = 24;
const MORE_PAGES = 8;

function MoreWork({ artist, link, finder }: { artist: LocalArtist; link: ArtistLink; finder: Finder }) {
  const [got, setGot] = useState<{ items: FindItem[]; next: string | null; total: number | null; error: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [want, setWant] = useState(MORE_SCREEN);
  const [pagesLeft, setPagesLeft] = useState(MORE_PAGES);
  const have = useHave(finder.platform);
  const basket = useFind((s) => s.baskets[finder.pluginId]);
  const pending = useArtists((s) => s.doc?.found);
  const isFresh = (it: FindItem) => !have.has(it.id) && !pending?.some((f) => f.work === it.id && f.artist === artist.id);
  const fresh = (got?.items ?? []).filter(isFresh);
  // Which artist's works are asked for: an answer for another (the page moved on) is dropped.
  const asking = useRef("");
  useEffect(() => {
    asking.current = `${finder.pluginId}:${link.id}`;
    setGot(null);
    setLoading(false);
    setWant(MORE_SCREEN);
    setPagesLeft(MORE_PAGES);
    void useFind.getState().loadBaskets();
  }, [finder.pluginId, link.id]);
  // Page after page until there are as many not in the library as wanted, or no more pages.
  useEffect(() => {
    if (loading || got?.error || (got && (!got.next || fresh.length >= want || pagesLeft <= 0))) return;
    const whose = asking.current;
    const had = got?.items ?? [];
    setLoading(true);
    setPagesLeft((n) => n - 1);
    finders_
      .list(finder.pluginId, { section: "artist", author: link.id, ...(got?.next ? { cursor: got.next } : {}) })
      .then(
        (page) => {
          if (asking.current !== whose) return;
          const seen = new Set(had.map((i) => i.id));
          setGot({ items: [...had, ...page.items.filter((i) => !seen.has(i.id))], next: page.items.length ? page.next : null, total: page.total, error: null });
        },
        (e) => asking.current === whose && setGot({ items: had, next: null, total: null, error: String(e).replace(/^Error: /, "") }),
      )
      .finally(() => asking.current === whose && setLoading(false));
  }, [got, want, pagesLeft, loading, fresh.length, finder.pluginId, link.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = () => {
    setWant(Math.max(want, fresh.length) + MORE_SCREEN);
    setPagesLeft(MORE_PAGES);
  };
  /** Their works in Find; or one of them, looked at closer there. */
  const inFind = (look?: FindItem) => {
    useFind.getState().choose(finder.pluginId);
    useStore.getState().openFind();
    if (look) useFind.setState({ lookAt: look });
    else useFind.getState().open({ section: "artist", author: { id: link.id, name: artist.name } });
  };
  const kept = (id: string) => (basket ?? []).some((b) => b.id === id);
  const keep = (it: FindItem) => {
    useFind.getState().choose(finder.pluginId);
    useFind.getState().toggleBasket(it);
  };
  return (
    <section className="artist-more">
      <div className="artists-head">
        <h2>
          More by {artist.name} on {finder.name}
        </h2>
        {got && !got.error && (
          <span className="faint small">
            {fresh.length} of {got.next ? `their newest ${got.items.length}` : `their ${got.total ?? got.items.length}`} not in your library
          </span>
        )}
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => inFind()}>
          All their works in Find
        </button>
      </div>
      {!got ? (
        <div className="small dim">Asking {finder.name}…</div>
      ) : got.error && !got.items.length ? (
        <div className="small dim">{/sign in/i.test(got.error) ? `Sign in to ${finder.name} in Find to see their other works here.` : `Couldn't ask ${finder.name}: ${got.error}`}</div>
      ) : fresh.length ? (
        <>
          <div className="artist-more-grid">
            {fresh.slice(0, want).map((it) => (
              <MoreTile key={it.id} item={it} pluginId={finder.pluginId} kept={kept(it.id)} onOpen={() => inFind(it)} onKeep={() => keep(it)} />
            ))}
          </div>
          {(fresh.length > want || got.next) && (
            <button className="btn sm ghost artist-more-next" disabled={loading} onClick={more}>
              {loading ? "Asking…" : "Show more"}
            </button>
          )}
        </>
      ) : loading ? (
        <div className="small dim">Asking {finder.name}…</div>
      ) : got.next ? (
        <div className="row small dim">
          You have all of their newest {got.items.length}.
          <button className="btn sm ghost" onClick={more}>
            Look further back
          </button>
        </div>
      ) : (
        <div className="small dim">You have all of their works.</div>
      )}
    </section>
  );
}

function MoreTile({ item, pluginId, kept, onOpen, onKeep }: { item: FindItem; pluginId: string; kept: boolean; onOpen: () => void; onKeep: () => void }) {
  const img = useFindImage(pluginId, item.thumb);
  return (
    <div className="artist-more-tile" title={item.title}>
      <button className="artist-more-open" onClick={onOpen}>
        {img.src ? <img src={img.src} alt="" draggable={false} /> : <span className="find-ph" />}
        {item.pages > 1 && <span className="artist-more-pages mono">{item.pages}</span>}
      </button>
      <button className={`find-corner basket ${kept ? "on" : ""}`} onClick={onKeep} title={kept ? "Out of the basket" : "Into the basket, to look at later"}>
        <Basket weight={kept ? "fill" : "regular"} />
      </button>
    </div>
  );
}
