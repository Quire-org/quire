import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ConnectGate } from "../components/ConnectGate";
import { useMayGoOnline } from "../lib/online";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowSquareOut, Basket, Check, DownloadSimple, FilmStrip, Heart, LinkSimple, MagnifyingGlass, PaintBrush, Plus, PuzzlePiece, SignOut, Sparkle, Stack, Star, UserCircle, X } from "@phosphor-icons/react";
import { useJobs } from "../lib/jobs";
import { useShallow } from "zustand/react/shallow";
import { TopNav } from "../components/TopNav";
import { Select } from "../components/Select";
import { Thumb } from "../components/Thumb";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { Modal } from "../components/Modal";
import { MergePicker } from "../components/TagBits";
import { allTags, nameOf, useTags } from "../tagsStore";
import { useStore } from "../store";
import { SURE_MATCH } from "../lib/findCheck";
import { BASKET, canBrowse, useFind, useFindImage, useHave, type BasketItem, type HaveArtist } from "../findStore";
import { finder as askFinder, useFinders, type FindArtist, type FindItem, type FindOption, type FindTag, type FindWorkView, type TagKind } from "../plugins/find";
import { justify, ratioOf, type JustifiedRow } from "../lib/justify";
import { newer, sameView, saveable } from "../lib/savedSearches";
import { SavedSearches } from "../components/SavedSearches";
import { dialogOpen, isTypingTarget } from "../lib/hotkeys";
import { FollowButton } from "../components/FollowButton";
import { FitImage } from "../components/FitImage";
import { Flag } from "../components/Flag";
import { PlatformIcon } from "../components/PlatformIcon";
import { Leaf } from "../components/PageTurn";
import { bookOf } from "../components/StickerBook";
import { bare, flipped, isLeftOut, queryOf, termsOf, withTerms } from "../lib/queryTerms";
import { countsOf, linkedArtist, useArtists, type LocalArtist } from "../artistsStore";
import { ArtistLinkPicker } from "../components/ArtistLinkPicker";
import { ArtistIcon } from "../components/ArtistIcon";

const GAP = 8;

/** Works looked at closer, one on top of another: a related work opened from a work goes on top, Back returns. */
/** A closer look at a work of a list; `pinned`: asked for from elsewhere, it stays while the view behind it changes. */
type Look = { list: FindItem[]; index: number; pinned?: boolean };
type Menu = { at: { x: number; y: number }; items: MenuItem[] };
type CheckAt = { item: FindItem; x: number; y: number };
type OnContext = (e: React.MouseEvent, item: FindItem, list: FindItem[], index: number) => void;

/**
 * Find: searching and browsing a platform (each one a plugin), keeping works in the basket to look
 * at later, picking what to keep, and bringing the picks into the library through Import. Pictures
 * fill rows at their own shapes; the keyboard moves through them (arrows), picks (Space), keeps for
 * later (S), checks the library (C), looks closer (Enter) and imports the picks (I).
 */
export function Find() {
  const finders = useFinders((s) => s.finders);
  const pluginId = useFind((s) => s.pluginId);
  const finder = pluginId ? finders[pluginId] : undefined;
  const first = Object.keys(finders)[0];
  const root = useStore((s) => s.root);
  // Asking before going online: nothing is asked of the platform until Connect.
  const online = useMayGoOnline(pluginId);

  // The first platform, until one is chosen; the account and the basket again when the library changes.
  useEffect(() => {
    if (!finder && first) useFind.getState().choose(first);
  }, [finder, first]);
  useEffect(() => {
    if (finder && online) void useFind.getState().refreshAccount();
    void useFind.getState().loadBaskets();
  }, [finder, root, online]);
  // A platform opened: its saved searches asked what is new (not again within minutes).
  useEffect(() => {
    if (pluginId && root && online) void useFind.getState().checkSaved(pluginId);
  }, [pluginId, root, online]);

  return (
    <div className="screen find">
      <TopNav current="find" />
      {!finder ? (
        <NoPlatform />
      ) : (
        <ConnectGate pluginId={finder.pluginId} name={finder.name}>
          <FindBody key={finder.pluginId} />
        </ConnectGate>
      )}
    </div>
  );
}

function NoPlatform() {
  const openPlugins = () => useStore.getState().set({ pluginsOpen: true });
  return (
    <div className="find-empty">
      <div className="find-empty-body">
        <h2>
          <PuzzlePiece /> No platform yet
        </h2>
        <p>Find searches platforms through plugins, one for each. Add a platform's plugin in Settings → Plugins with its folder or GitHub link, and what it offers (a feed, bookmarks, rankings, searches) shows here.</p>
        <div>
          <button className="btn primary" onClick={openPlugins}>
            Plugins…
          </button>
        </div>
      </div>
    </div>
  );
}

/** Works that have passed the screen, told the store together (a second at most after). */
const seenQueue = new Map<string, Set<string>>();
let seenTimer: ReturnType<typeof setTimeout> | null = null;
function queueSeen(platform: string, id: string) {
  const q = seenQueue.get(platform) ?? new Set<string>();
  q.add(id);
  seenQueue.set(platform, q);
  seenTimer ??= setTimeout(() => {
    seenTimer = null;
    for (const [p, ids] of seenQueue) useFind.getState().markSeen(p, [...ids]);
    seenQueue.clear();
  }, 1000);
}

/** The works on show: the basket's, or the platform's page (only what is new to the reader, when asked). */
function useShown(): FindItem[] {
  const { section, items, baskets, pluginId, onlyNew, seenBefore } = useFind(useShallow((s) => ({ section: s.view.section, items: s.items, baskets: s.baskets, pluginId: s.pluginId, onlyNew: s.onlyNew, seenBefore: s.seenBefore })));
  return useMemo(() => (section === BASKET ? (baskets[pluginId!] ?? []) : onlyNew ? items.filter((i) => !seenBefore.has(i.id)) : items), [section, baskets, pluginId, onlyNew, items, seenBefore]);
}

function FindBody() {
  const f = useFind();
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const shown = useShown();
  const [focus, setFocus] = useState(0);
  // The focused work is marked once the keyboard has been used here (a click puts the mark away again).
  const [keyed, setKeyed] = useState(false);
  const [looks, setLooks] = useState<Look[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [checkAt, setCheckAt] = useState<CheckAt | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const signedIn = canBrowse(f.account, f.pluginId);
  const look = looks[looks.length - 1];

  const open = (list: FindItem[], index: number) => setLooks([{ list, index }]);
  // A work asked for from elsewhere (an artist's page, a picture's Info): looked at closer at once,
  // whatever Find shows behind it (the platform still saying who is signed in, say).
  const lookAt = useFind((s) => s.lookAt);
  useEffect(() => {
    if (!lookAt) return;
    useFind.setState({ lookAt: null });
    setLooks([{ list: [lookAt], index: 0, pinned: true }]);
  }, [lookAt]);
  // In the basket the closer look follows it: a work taken out of it leaves the closer look too (the
  // next one shows in its place; none left, it closes), and one changed (its pages) shows so. A look
  // pinned from elsewhere (a work opened from an artist's page) is not the basket's: it stays, even
  // while the basket is still loading and shows nothing yet.
  useEffect(() => {
    if (f.view.section !== BASKET) return;
    setLooks((l) => {
      if (!l.length || l[0].pinned || l[0].list === shown) return l;
      if (!shown.length) return [];
      const at = shown.findIndex((it) => it.id === l[0].list[l[0].index]?.id);
      return [{ list: shown, index: at >= 0 ? at : Math.min(l[0].index, shown.length - 1) }, ...l.slice(1)];
    });
  }, [shown, f.view.section]);
  const openRelated = (list: FindItem[], index: number) => setLooks((l) => [...l, { list, index }]);
  const moveLook = (index: number) => {
    setLooks((l) => [...l.slice(0, -1), { ...l[l.length - 1], index }]);
    if (looks.length === 1 && looks[0].list === shown) setFocus(index);
  };
  /** XX where it was asked: the menu, or the focused tile. */
  const checkNear = (item: FindItem, x: number, y: number) => {
    setCheckAt({ item, x, y });
    void f.check(item);
  };
  const checkFocused = (item: FindItem, index: number) => {
    const r = document.querySelector(`[data-find="${index}"]`)?.getBoundingClientRect();
    checkNear(item, r ? r.left + r.width / 2 : window.innerWidth / 2, r ? r.top + Math.min(r.height, 120) : 200);
  };

  const onContext: OnContext = (e, item, list, index) => {
    e.preventDefault();
    if (list === shown && !looks.length) setFocus(index);
    const s = useFind.getState();
    const picked = s.picks.some((p) => p.id === item.id);
    const kept = (s.baskets[s.pluginId!] ?? []).some((b) => b.id === item.id);
    const albumOn = (s.baskets[s.pluginId!] ?? []).find((b) => b.id === item.id)?.album ?? !!useFinders.getState().finders[s.pluginId!]?.albums;
    const inBasket = s.view.section === BASKET && !looks.length;
    const at = { x: e.clientX, y: e.clientY };
    const items: MenuItem[] = [
      { label: <MenuLabel text="Look closer" keyName="⏎" />, onClick: () => (looks.length ? openRelated(list, index) : open(list, index)) },
      // Importing is chosen in the basket; anywhere else a work goes into the basket.
      ...(inBasket ? [{ label: <MenuLabel text={picked ? "Not to import" : "Choose to import"} keyName="Space" />, onClick: () => s.togglePick(item) }] : []),
      { label: <MenuLabel text={kept ? "Out of the basket" : "Into the basket"} keyName={inBasket ? "S" : "Space"} />, onClick: () => s.toggleBasket(item) },
      { label: <MenuLabel text="Do I have this?" keyName="C" />, onClick: () => checkNear(item, at.x, at.y) },
      // Its pages each a single picture, unless it is to be an album of its own (and so into the basket).
      ...(item.pages > 1 && item.kind !== "animation" && !useFinders.getState().finders[s.pluginId!]?.albums ? [{ label: albumOn ? "Import page by page" : "Import as an album", onClick: () => s.setAlbum(item, !albumOn) }] : []),
      { separator: true },
      {
        label: `${item.author.name}'s works`,
        disabled: !item.author.id,
        onClick: () => {
          setLooks([]);
          s.open({ section: "artist", author: { id: item.author.id, name: item.author.name } });
        },
      },
    ];
    if (item.url) items.push({ label: <MenuLabel text={`Open on ${finder.name}`} keyName="O" />, onClick: () => void openUrl(item.url!) });
    setMenu({ at, items });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘A in the basket: all of it to import.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && useFind.getState().view.section === BASKET && !look && !isTypingTarget(e.target)) {
        e.preventDefault();
        useFind.setState({ picks: [...shown] });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || menu || dialogOpen()) return;
      const st = useStore.getState();
      if (st.settingsOpen || st.importOpen || st.pluginsOpen || st.helpOpen || useFinders.getState().login) return;
      const key = e.key.toLowerCase();
      const s = useFind.getState();
      if (checkAt && key === "escape") return void (setCheckAt(null), e.preventDefault());
      if (look) {
        const it = look.list[look.index];
        if (key === "escape") setLooks([]);
        else if (key === "backspace" && looks.length > 1) setLooks(looks.slice(0, -1));
        // An album platform's arrows turn its pages (the reader's own): with ⇧, another work.
        else if (key === "arrowright" && look.index < look.list.length - 1 && (e.shiftKey || !finder.albums)) moveLook(look.index + 1);
        else if (key === "arrowleft" && look.index > 0 && (e.shiftKey || !finder.albums)) moveLook(look.index - 1);
        else if ((key === " " || key === "x") && it) (s.view.section === BASKET && looks.length === 1 ? s.togglePick(it) : s.toggleBasket(it));
        else if (key === "s" && it) s.toggleBasket(it);
        else if (key === "c" && it) void s.check(it);
        else if (key === "o" && it?.url) void openUrl(it.url);
        // As everywhere: the bars and panels away (here the work's own too, only its pages left), or back.
        else if (key === "h") st.toggleChrome();
        else return;
        e.preventDefault();
        return;
      }
      const it = shown[focus];
      const basket = s.view.section === BASKET;
      if (it && [" ", "x", "s", "c", "enter", "o"].includes(key)) setKeyed(true);
      if (key === "/") search.current?.focus();
      else if ((key === " " || key === "x") && it) (basket ? s.togglePick(it) : s.toggleBasket(it));
      else if (key === "s" && it) s.toggleBasket(it);
      else if (key === "c" && it) checkFocused(it, focus);
      else if (key === "enter" && it) open(shown, focus);
      else if (key === "o" && it?.url) void openUrl(it.url);
      else if (key === "i" && s.picks.length) void s.pull();
      else if (key === "escape") st.openSortQueue();
      else if (key === "b") st.openBrowse();
      else if (key === "a") st.openAlbums();
      else if (key === "d") st.openDupes();
      else if (key === "e") st.openFiles();
      else if (key === "l") st.openTags();
      else if (key === "k") st.openScrapbook();
      else if (key === "p") st.openPeople();
      else if (key === "w") st.openArtists();
      else if (key === "g") st.set({ settingsOpen: true });
      else if (key === "h") st.toggleChrome();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A new view starts at its first picture (a work asked for from elsewhere stays looked at);
  // works leaving the basket keep the focus in range.
  useEffect(() => {
    setFocus(0);
    setLooks((l) => (l[0]?.pinned ? l : []));
  }, [f.view]);
  useEffect(() => {
    if (focus >= shown.length && shown.length) setFocus(shown.length - 1);
  }, [focus, shown.length]);

  const sideHidden = useStore((s) => s.sideCollapsed);
  return (
    <div className={`find-layout ${sideHidden ? "side-hidden" : ""}`}>
      <FindSide />
      <main className={`find-main ${look ? "previewing" : ""}`}>
        {f.account === null ? (
          <div className="find-note dim">Asking {finder.name}…</div>
        ) : !signedIn ? (
          <SignIn />
        ) : (
          <>
            <Results shown={shown} focus={focus} setFocus={setFocus} keyed={keyed} setKeyed={setKeyed} onOpen={open} onContext={onContext} searchRef={search} />
            {look && look.list[look.index] && (
              <Preview
                key={look.list[look.index].id}
                item={look.list[look.index]}
                index={look.index}
                count={look.list.length}
                depth={looks.length}
                onClose={() => setLooks([])}
                onBack={() => setLooks(looks.slice(0, -1))}
                onMove={moveLook}
                onRelated={openRelated}
                onContext={onContext}
                choosing={f.view.section === BASKET && looks.length === 1}
              />
            )}
          </>
        )}
        {(f.picks.length > 0 || (f.view.section === BASKET && shown.length > 0)) && <PickBar shown={shown} />}
      </main>
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
      {checkAt && <CheckPopover at={checkAt} onClose={() => setCheckAt(null)} />}
    </div>
  );
}

function MenuLabel({ text, keyName }: { text: string; keyName: string }) {
  return (
    <span className="find-menu-label">
      <span className="grow">{text}</span>
      <kbd className="kbd">{keyName}</kbd>
    </span>
  );
}

/* ---------- the side: platform, account, search, sections, basket ---------- */

function FindSide() {
  const f = useFind();
  const finders = useFinders((s) => s.finders);
  const finder = finders[f.pluginId!];
  const signedIn = canBrowse(f.account, f.pluginId);
  const basket = f.baskets[f.pluginId!] ?? [];
  const tile = useFind((s) => s.tile);

  const view = f.view;
  const current = view.section === "artist" ? null : finder.sections.find((s) => s.id === view.section);
  const opts = view.section === "artist" ? finder.artistOptions : (current?.options ?? []);

  return (
    <aside className="browse-side panel find-side">
      {finder.sites && <SitePicker />}
      <Account />
      {signedIn && (
        <>
          <div className="label">{finder.name}</div>
          <div className="side-list">
            {/* A search is made in the bar over the results, not picked here. */}
            {finder.sections
              .filter((s) => !s.query)
              .map((s) => (
                <button key={s.id} className={`btn sm ${view.section === s.id ? "active" : ""}`} onClick={() => f.open({ section: s.id })}>
                  {s.label}
                </button>
              ))}
            {view.section === "artist" && view.author && (
              <button className="btn sm active" title="The artist's works">
                <UserCircle /> <span className="ellipsis">{f.artist?.name ?? f.title ?? view.author.name}</span>
              </button>
            )}
          </div>

          <SavedSearches />

          <div className="label">Kept for later</div>
          <div className="side-list">
            <button className={`btn sm ${view.section === BASKET ? "active" : ""}`} onClick={() => f.open({ section: BASKET })} title="Works you put in the basket to look at later (right-click or S)">
              <span className="find-basket-label">
                <Basket /> Basket
              </span>
              <span className="faint mono">{basket.length}</span>
            </button>
          </div>

          <div className="label">Tile size</div>
          <div className="side-row">
            <input type="range" min={140} max={440} step={20} value={tile} onChange={(e) => f.setTile(Number(e.target.value))} title="How big the works are" />
          </div>

          {opts.length > 0 && view.section !== BASKET && !current?.query && (
            <>
              <div className="label">{view.section === "ranking" ? "Ranking" : view.section === "artist" ? "Works" : "Show"}</div>
              {opts.length > 4 ? (
                <Select value={view.option} options={opts} searchable={opts.length > 12} onChange={(v) => f.open({ option: v })} />
              ) : (
                <div className="chips">
                  {opts.map((o) => (
                    <button key={o.value} className={`btn sm ${view.option === o.value ? "active" : ""}`} onClick={() => f.open({ option: o.value })}>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          <p className="small dim find-side-help">
            {view.section === BASKET ? (
              <>
                <kbd className="kbd">Space</kbd> chooses what to import, <kbd className="kbd">⌘A</kbd> all of it, <kbd className="kbd">I</kbd> imports, <kbd className="kbd">S</kbd> takes a work out of the basket, <kbd className="kbd">⏎</kbd> looks closer, where you can choose its pages.
              </>
            ) : (
              <>
                <kbd className="kbd">Space</kbd> puts a work in the basket, <kbd className="kbd">⏎</kbd> looks closer, <kbd className="kbd">C</kbd> checks your library. Import from the basket. Right-click for all of it.
              </>
            )}
          </p>
        </>
      )}
    </aside>
  );
}

/** A platform of several sites, the reader's own: the one shown, and adding another. */
function SitePicker() {
  const f = useFind();
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const [adding, setAdding] = useState(false);
  const sites = finder.sites!;
  return (
    <div className="find-sites">
      {sites.list.length > 0 ? (
        <Select value={sites.current ?? ""} options={sites.list.map((x) => ({ value: x.id, label: x.name, icon: <PlatformIcon pluginId={finder.pluginId} url={x.icon} /> }))} onChange={(v) => v !== sites.current && void f.chooseSite(v)} title="The site shown" />
      ) : (
        <span className="dim small grow">No sites yet</span>
      )}
      <button className={`btn sm ${sites.list.length ? "" : "primary"}`} onClick={() => setAdding(true)} title="Add a site by its address">
        <Plus /> {sites.list.length ? "" : "Add a site…"}
      </button>
      {adding && (
        <Modal title={`Add a site to ${finder.name}`} onClose={() => setAdding(false)}>
          <AddSite onDone={() => setAdding(false)} />
        </Modal>
      )}
    </div>
  );
}

function AddSite({ onDone }: { onDone: () => void }) {
  const f = useFind();
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="find-sign-in"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!url.trim() || busy) return;
        setBusy(true);
        const ok = await f.addSite(url.trim());
        setBusy(false);
        if (ok) onDone();
      }}
    >
      {finder.sites?.help && <p>{finder.sites.help}</p>}
      <label className="find-sign-in-field">
        <span className="label">Its address</span>
        <input className="input" autoFocus spellCheck={false} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <p className="dim small">You'll be asked to allow it first. Settings → Plugins lists the sites you've allowed, to remove.</p>
      <div>
        <button className="btn primary" type="submit" disabled={!url.trim() || busy}>
          {busy ? "Adding…" : "Add the site"}
        </button>
      </div>
    </form>
  );
}

function Account() {
  const f = useFind();
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const a = f.account;
  const avatar = useFindImage(f.pluginId, a?.avatar ?? null);
  const [signingIn, setSigningIn] = useState(false);
  // Browsed signed out: signing in is a button here.
  if (a && !a.signedIn && finder.signIn?.optional)
    return (
      <div className="find-account">
        <UserCircle size={28} />
        <div className="grow find-account-name">
          <b className="ellipsis">Not signed in</b>
          <span className="small dim ellipsis">{finder.name}</span>
        </div>
        <button className="btn sm" onClick={() => setSigningIn(true)}>
          Sign in…
        </button>
        {signingIn && (
          <Modal title={`Sign in to ${finder.name}`} onClose={() => setSigningIn(false)}>
            <SignInForm onDone={() => setSigningIn(false)} />
          </Modal>
        )}
      </div>
    );
  if (!a?.signedIn) return null;
  return (
    <div className="find-account">
      {avatar.src ? <img src={avatar.src} alt="" /> : <UserCircle size={28} />}
      <div className="grow find-account-name">
        <b className="ellipsis">{a.name || a.account}</b>
        <span className="small dim ellipsis">
          {finder.name}
          {a.premium ? " · Premium" : ""}
        </span>
      </div>
      <button className="btn sm ghost" onClick={() => void f.signOut()} title={`Sign out of ${finder.name}: the sign-in kept with this library is forgotten`}>
        <SignOut />
      </button>
    </div>
  );
}

/** Where a sign-in is kept, said plainly before it is made. */
export function whereKept(vault: { exists: boolean; unlocked: boolean } | null): { text: string; ok: boolean } {
  if (vault?.exists && vault.unlocked) return { text: "It is kept with this library, in its vault (encrypted), not on this computer.", ok: true };
  if (vault?.exists) return { text: "This library's vault is locked: unlock it first, so the sign-in goes into it.", ok: false };
  return { text: "It is kept with this library on its drive, not on this computer, unencrypted: anyone with the drive could use it until you sign out. Encrypt the library to keep it in its vault.", ok: true };
}

function SignIn() {
  const f = useFind();
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  return (
    <div className="find-empty">
      <div className="find-empty-body">
        <h2>Sign in to {finder.name}</h2>
        <p>Find browses {finder.name} as you: your feed, your bookmarks and the artists you follow, besides rankings and searches.</p>
        {f.error && !/sign in/i.test(f.error) && <p className="find-error">{f.error}</p>}
        <SignInForm />
      </div>
    </div>
  );
}

/** Signing in: by the platform's own page, or with what it asks for (a username and key, say), said where it is kept. */
function SignInForm({ onDone }: { onDone?: () => void }) {
  const f = useFind();
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const vault = useStore((s) => s.vault);
  const kept = whereKept(vault);
  const fields = finder.signIn?.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const filled = fields.every((x) => (values[x.id] ?? "").trim());
  const go = async () => {
    setBusy(true);
    const ok = await f.signIn(fields.length ? values : undefined);
    setBusy(false);
    if (ok) onDone?.();
  };
  if (!fields.length)
    return (
      <>
        <p className="dim">{kept.text}</p>
        <div>
          <button className="btn primary" disabled={!kept.ok} onClick={() => void go()}>
            Sign in to {finder.name}…
          </button>
        </div>
      </>
    );
  return (
    <form
      className="find-sign-in"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled && kept.ok && !busy) void go();
      }}
    >
      {finder.signIn?.help && <p>{finder.signIn.help}</p>}
      {finder.signIn?.link && (
        <button type="button" className="btn sm ghost" onClick={() => void openUrl(finder.signIn!.link!.url)}>
          <ArrowSquareOut /> {finder.signIn.link.label}
        </button>
      )}
      {fields.map((x, i) => (
        <label key={x.id} className="find-sign-in-field">
          <span className="label">{x.label}</span>
          <input className="input" type={x.secret ? "password" : "text"} autoComplete="off" spellCheck={false} autoFocus={i === 0} value={values[x.id] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [x.id]: e.target.value }))} />
        </label>
      ))}
      <p className="dim small">{kept.text}</p>
      <div>
        <button className="btn primary" type="submit" disabled={!filled || !kept.ok || busy}>
          {busy ? "Signing in…" : `Sign in to ${finder.name}`}
        </button>
      </div>
    </form>
  );
}

/** A work's tags by kind, in the order shown; tags of no kind are its tags. */
const TAG_GROUPS: [TagKind, string][] = [
  ["artist", "Artist"],
  ["series", "From"],
  ["character", "Characters"],
  ["general", "Tags"],
  ["meta", "About the file"],
];

/* ---------- results ---------- */

type Marks = { picked: Set<string>; kept: Set<string>; album: Set<string>; have: Set<string>; fresh: Set<string>; since: Set<string> };

/** Marks for tiles: picked, in the basket (and to come in as an album), in the library (brought in, or found by a check), and checked and not in it. */
function useMarks(): Marks {
  const f = useFind(useShallow((s) => ({ picks: s.picks, baskets: s.baskets, pluginId: s.pluginId, checks: s.checks, visit: s.visit, items: s.items, seenBefore: s.seenBefore })));
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const imported = useHave(finder.platform);
  return useMemo(() => {
    // A saved search opened: what came since it was last opened, and hadn't passed the screen.
    const since = new Set(f.visit ? f.items.filter((i) => newer(i.id, f.visit!.since) && !f.seenBefore.has(i.id)).map((i) => i.id) : []);
    const have = new Set(imported);
    const fresh = new Set<string>();
    for (const b of (f.baskets[f.pluginId!] ?? []) as BasketItem[]) if (b.seen) (b.seen.have ? have : fresh).add(b.id);
    for (const [id, c] of Object.entries(f.checks)) if (c.state === "done") (c.matches.length ? have : fresh).add(id);
    for (const id of have) fresh.delete(id);
    const basket = (f.baskets[f.pluginId!] ?? []) as BasketItem[];
    return { picked: new Set(f.picks.map((p) => p.id)), kept: new Set(basket.map((b) => b.id)), album: new Set(basket.filter((b) => b.album ?? finder.albums).map((b) => b.id)), have, fresh, since };
  }, [f.picks, f.baskets, f.pluginId, f.checks, imported, f.visit, f.items, f.seenBefore]);
}

/** The width of an element, as it changes. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Results({ shown, focus, setFocus, keyed, setKeyed, onOpen, onContext, searchRef }: { shown: FindItem[]; focus: number; setFocus: (i: number) => void; keyed: boolean; setKeyed: (on: boolean) => void; onOpen: (list: FindItem[], index: number) => void; onContext: OnContext; searchRef: React.RefObject<HTMLInputElement | null> }) {
  const f = useFind(useShallow((s) => ({ next: s.next, loading: s.loading, error: s.error, title: s.title, total: s.total, view: s.view, more: s.more, open: s.open, togglePick: s.togglePick, toggleBasket: s.toggleBasket, pluginId: s.pluginId, artists: s.artists, artist: s.artist, items: s.items, setOnlyNew: s.setOnlyNew })));
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const marks = useMarks();
  const [scroller, width] = useWidth<HTMLDivElement>();
  const end = useRef<HTMLDivElement>(null);
  const basket = f.view.section === BASKET;
  const kind = basket ? "works" : (finder.sections.find((s) => s.id === f.view.section)?.kind ?? "works");

  // The next page as the end comes near.
  useEffect(() => {
    const el = end.current;
    if (!el || !f.next || basket) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void f.more(), { root: scroller.current, rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [f.next, f.more, shown.length, f.items.length, f.artists.length, basket, scroller]);

  const tile = useFind((s) => s.tile);
  const rows = useMemo(() => justify(shown.map((i) => ratioOf(i.width, i.height)), width - 32, tile, GAP), [shown, width, tile]);

  // Arrow keys: along the row, or to the nearest picture in the row above or below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || !shown.length || kind !== "works") return;
      if (useStore.getState().importOpen || document.querySelector(".find-preview, .context-menu")) return;
      const k = e.key;
      let to = focus;
      if (k === "ArrowRight") to = Math.min(shown.length - 1, focus + 1);
      else if (k === "ArrowLeft") to = Math.max(0, focus - 1);
      else if (k === "ArrowDown" || k === "ArrowUp") {
        const r = rows.findIndex((row) => focus >= row.start && focus < row.end);
        const other = rows[r + (k === "ArrowDown" ? 1 : -1)];
        if (r < 0 || !other) return;
        const centre = (i: number) => {
          const b = document.querySelector(`[data-find="${i}"]`)?.getBoundingClientRect();
          return b ? b.left + b.width / 2 : 0;
        };
        const x = centre(focus);
        let best = other.start;
        for (let i = other.start; i < other.end; i++) if (Math.abs(centre(i) - x) < Math.abs(centre(best) - x)) best = i;
        to = best;
      } else return;
      e.preventDefault();
      setKeyed(true);
      setFocus(to);
      document.querySelector(`[data-find="${to}"]`)?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, rows, shown.length, setFocus, setKeyed, kind]);

  const onlyNew = useFind((s) => s.onlyNew);
  const heading = basket ? "Basket" : f.view.section === "artist" ? (f.artist?.name ?? f.title ?? f.view.author?.name ?? "Artist") : (finder.sections.find((s) => s.id === f.view.section)?.label ?? "");
  const count = kind === "artists" ? f.artists.length : shown.length;

  return (
    <div className="find-results">
      <SearchBar searchRef={searchRef} />
      <div className="browse-head find-head">
        {f.view.section === "artist" && (
          <button className="btn sm ghost" onClick={() => f.open({ section: finder.sections[0].id })} title="Back to the sections">
            <ArrowLeft />
          </button>
        )}
        <h2 className="find-title ellipsis">{heading}</h2>
        <SaveStar />
        <span className="faint mono small" title={f.total && !basket ? `${f.total.toLocaleString("en-GB")} in all, ${count} shown so far` : undefined}>
          {f.total && !basket ? f.total.toLocaleString("en-GB") : count ? `${count}${f.next && !basket ? "+" : ""}` : ""}
        </span>
        {marks.since.size > 0 && <span className="find-new-note small">{marks.since.size}{f.next ? "+" : ""} new since you last looked</span>}
        <span className="grow" />
        {f.loading && <span className="dim small">Loading…</span>}
        {basket && <BasketCheck shown={shown} marks={marks} />}
        {!basket && kind === "works" && (
          <button className={`btn sm ${onlyNew ? "active" : "ghost"}`} onClick={() => f.setOnlyNew(!onlyNew)} title={onlyNew ? "Show everything again" : "Only works that hadn't passed your screen before you opened this list"}>
            <Sparkle /> New to me
          </button>
        )}
      </div>
      <div className="find-grid" ref={scroller} onMouseDown={() => setKeyed(false)}>
        {f.view.section === "artist" && f.artist && <ArtistHeader artist={f.artist} />}
        {f.view.section === "artist" && f.view.author && finder.artistTags && <ArtistTags authorId={f.view.author.id} />}
        {kind === "artists" ? (
          <ArtistsGrid artists={f.artists} onOpenWork={onOpen} />
        ) : (
          <WorkGrid items={shown} rows={rows} focus={focus} showFocus={keyed} marks={marks} root={scroller} corner={basket ? "choose" : "basket"} onCorner={(it, i) => (setFocus(i), basket ? f.togglePick(it) : f.toggleBasket(it))} onOpen={(i) => (setFocus(i), onOpen(shown, i))} onContext={(e, it, i) => onContext(e, it, shown, i)} />
        )}
        {f.error && !basket ? (
          <div className="find-note">
            <span className="find-error">{f.error}</span>
            <button className="btn sm" onClick={() => (count ? void f.more() : f.open({}))}>
              Try again
            </button>
          </div>
        ) : !f.loading && !count ? (
          <div className="find-note dim">{onlyNew && f.items.length && !basket ? "Nothing new to you here: everything has passed your screen before. New to me shows everything again." : basket ? "Nothing kept for later yet. Right-click a work and choose Into the basket, or press S on it, to keep it here until you've looked at it." : f.view.section === "search" && !f.view.query ? "Type what to look for, then ⏎. Tags work best." : "Nothing here."}</div>
        ) : null}
        <div ref={end} className="find-end" />
      </div>
    </div>
  );
}

/** The view on show (a search, or an artist's works with a tag) kept to look at again, or forgotten again: ☆. */
function SaveStar() {
  const f = useFind(useShallow((s) => ({ pluginId: s.pluginId, view: s.view, saved: s.saved, saveSearch: s.saveSearch, forgetSearch: s.forgetSearch })));
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  if (!finder || !saveable(f.view, finder.sections.find((s) => s.query)?.id ?? null)) return null;
  const site = finder.sites?.current ?? null;
  const kept = f.saved.find((s) => s.pluginId === f.pluginId && s.site === site && sameView(s.view, f.view));
  return (
    <button
      className={`btn sm ghost find-save ${kept ? "on" : ""}`}
      onClick={() => {
        if (kept) return f.forgetSearch(kept.id);
        const s = f.saveSearch();
        if (s) useStore.getState().toast(`Saved: ${s.name}. It shows in the side panel, with what is new since you last opened it`, "ok");
      }}
      title={kept ? `Saved as “${kept.name}”: click to forget it` : "Save this search, to come back to what is new in it"}
    >
      <Star weight={kept ? "fill" : "regular"} />
    </button>
  );
}

/**
 * The search, over the results: its terms as chips in the box (a click leaves one out or needs it
 * again, × takes it off), what is typed added with ⏎, and its order beside it. On another section
 * the last search's terms wait, dimmed, for ⏎ or another term.
 */
function SearchBar({ searchRef }: { searchRef: React.RefObject<HTMLInputElement | null> }) {
  const f = useFind(useShallow((s) => ({ pluginId: s.pluginId, view: s.view, open: s.open })));
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const searchable = finder.sections.find((s) => s.query);
  const [text, setText] = useState("");
  const [hints, setHints] = useState<FindOption[]>([]);
  const [hint, setHint] = useState(-1);
  const terms = termsOf(f.view.query);
  const on = !!searchable && f.view.section === searchable.id;

  // Tags that start with what is typed, once typing pauses.
  useEffect(() => {
    if (!searchable || text.trim().length < 1 || document.activeElement !== searchRef.current) return setHints([]);
    const t = setTimeout(() => void askFinder.suggest(finder.pluginId, text.trim()).then((h) => (setHints(h), setHint(-1))), 350);
    return () => clearTimeout(t);
  }, [text, searchable, finder.pluginId, searchRef]);

  if (!searchable) return null;
  const runSearch = (next: string[]) => {
    setText("");
    setHints([]);
    f.open({ section: searchable.id, query: queryOf(next), option: on ? f.view.option : undefined });
  };

  return (
    <div className="find-searchbar">
      <div className={`find-query ${on ? "" : "idle"}`} onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), searchRef.current?.focus())}>
        <MagnifyingGlass />
        {terms.map((t, i) => (
          <span key={bare(t)} className={`chip ${isLeftOut(t) ? "danger left-out" : ""}`}>
            <button className="find-term" onClick={() => runSearch(terms.map((x, j) => (j === i ? flipped(x) : x)))} title={isLeftOut(t) ? `Left out: click to need “${bare(t)}” again` : `Needed: click to leave “${t}” out`}>
              {bare(t)}
            </button>
            <button className="chip-x" onClick={() => runSearch(terms.filter((_, j) => j !== i))} title={`Take “${bare(t)}” off the search`}>
              <X />
            </button>
          </span>
        ))}
        <input
          ref={searchRef}
          placeholder={terms.length ? "Narrow it down" : `Search ${finder.name}`}
          title="⏎ adds it to the search; -word leaves a word out; ⌫ in an empty box takes the last one off"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setTimeout(() => setHints([]), 150)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "ArrowDown" && hints.length) (e.preventDefault(), setHint((hint + 1) % hints.length));
            else if (e.key === "ArrowUp" && hints.length) (e.preventDefault(), setHint(hint <= 0 ? hints.length - 1 : hint - 1));
            else if (e.key === "Enter") {
              const typed = hint >= 0 && hints[hint] ? hints[hint].value : text;
              if (typed.trim() || terms.length) runSearch(withTerms(terms, typed));
            } else if (e.key === "Backspace" && !text && terms.length) runSearch(terms.slice(0, -1));
            else if (e.key === "Escape") (setHints([]), e.currentTarget.blur());
          }}
        />
        <kbd className="kbd">/</kbd>
        {hints.length > 0 && (
          <div className="find-hints panel" role="listbox">
            {hints.map((h, i) => (
              <button key={h.value} role="option" aria-selected={i === hint} className={i === hint ? "on" : ""} onMouseDown={(e) => (e.preventDefault(), runSearch(withTerms(terms, h.value)))}>
                {h.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {on && searchable.options.length > 0 && <Select value={f.view.option} options={searchable.options} onChange={(v) => f.open({ option: v })} title="Order" />}
    </div>
  );
}

/** Works in rows at their own shapes: the page's, the basket's, or related ones. */
/** What a tile's corner does: puts the work in the basket (browsing), or chooses it to import (in the basket). */
type Corner = "basket" | "choose";

function WorkGrid({ items, rows, focus, showFocus = false, marks, root, corner, onCorner, onOpen, onContext }: { items: FindItem[]; rows: JustifiedRow[]; focus: number | null; showFocus?: boolean; marks: Marks; root: React.RefObject<HTMLElement | null>; corner: Corner; onCorner: (item: FindItem, index: number) => void; onOpen: (index: number) => void; onContext: (e: React.MouseEvent, item: FindItem, index: number) => void }) {
  return (
    <>
      {rows.map((row) => (
        <div key={row.start} className="find-row" style={{ height: row.height }}>
          {items.slice(row.start, row.end).map((it, j) => {
            const i = row.start + j;
            return <Tile key={it.id} item={it} index={focus === null ? null : i} width={row.height * ratioOf(it.width, it.height)} focused={showFocus && i === focus} marks={marks} corner={corner} onCorner={() => onCorner(it, i)} onOpen={() => onOpen(i)} onContext={(e) => onContext(e, it, i)} root={root} />;
          })}
        </div>
      ))}
    </>
  );
}

function Tile({ item, index, width, focused, marks, corner, onCorner, onOpen, onContext, root }: { item: FindItem; index: number | null; width: number; focused: boolean; marks: Marks; corner: Corner; onCorner: () => void; onOpen: () => void; onContext: (e: React.MouseEvent) => void; root: React.RefObject<HTMLElement | null> }) {
  const pluginId = useFind((s) => s.pluginId);
  const onAlbum = () => useFind.getState().setAlbum(item, !marks.album.has(item.id));
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { root: root.current, rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, root]);
  const img = useFindImage(pluginId, item.thumb, seen);
  // Passed the screen: mostly in view for half a second (not in the basket, which is the reader's own).
  const platform = useFinders((s) => s.finders[pluginId!]?.platform);
  useEffect(() => {
    const el = ref.current;
    if (!el || !platform || corner === "choose" || typeof IntersectionObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      (es) => {
        const on = es.some((e) => e.isIntersecting);
        if (on && !timer) timer = setTimeout(() => queueSeen(platform, item.id), 500);
        if (!on && timer) (clearTimeout(timer), (timer = null));
      },
      { root: root.current, threshold: 0.6 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [platform, item.id, root, corner]);
  const picked = marks.picked.has(item.id);
  const kept = marks.kept.has(item.id);
  const have = marks.have.has(item.id);
  const album = marks.album.has(item.id);
  const on = corner === "choose" ? picked : kept;
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={-1}
      data-find={index ?? undefined}
      className={`find-tile ${corner === "choose" && picked ? "picked" : ""} ${focused ? "focused" : ""}`}
      style={{ width }}
      onClick={onOpen}
      onContextMenu={onContext}
      title={`${item.title}\n${item.author.name}${have ? "\nIn your library already" : ""}`}
    >
      <button
        className={`find-corner ${corner} ${on ? "on" : ""}`}
        onClick={(e) => (e.stopPropagation(), onCorner())}
        title={corner === "choose" ? (picked ? "Not to import (Space)" : "Choose to import (Space)") : kept ? "Out of the basket (Space)" : "Into the basket, to look at later (Space)"}
      >
        {corner === "choose" ? on ? <Check /> : null : <Basket weight={on ? "fill" : "regular"} />}
      </button>
      {img.src ? <img src={img.src} alt="" draggable={false} /> : <span className={`find-ph ${img.failed ? "failed" : ""}`}>{img.failed ? "Couldn't load" : ""}</span>}
      {item.language && (
        // Its language, as an album's card shows it (giving way to the basket's corner).
        <span className="album-flag find-flag">
          <Flag code={item.language} size={22} corner />
        </span>
      )}
      <span className="find-badges">
        {/* With the badges, top right: the caption (shown on hover) has the foot of the tile. */}
        {have ? (
          <span className="find-have" title="In your library already">
            <Check /> In library
          </span>
        ) : (
          marks.fresh.has(item.id) && (
            <span className="find-have fresh" title="Looked for: not in your library">
              <Sparkle /> Not in library
            </span>
          )
        )}
        {marks.since.has(item.id) && (
          <span className="find-badge new" title="New since you last opened this search">
            New
          </span>
        )}
        {item.adult && <span className="find-badge alarm">18+</span>}
        {item.ai && <span className="find-badge">AI</span>}
        {item.kind === "animation" && (
          <span className="find-badge" title="Animation: comes in as a video">
            <FilmStrip />
          </span>
        )}
        {item.pages > 1 &&
          (corner === "choose" ? (
            <button className={`find-badge find-album ${album ? "on" : ""}`} onClick={(e) => (e.stopPropagation(), onAlbum())} title={album ? "Comes in as an album of its own: click for each page a single picture" : "Each page comes in as a single picture: click to import it as an album"}>
              <Stack /> {item.pages}
              {album && " · Album"}
            </button>
          ) : (
            <span className="find-badge" title={album ? `${item.pages} pages, to come in as an album` : `${item.pages} pages`}>
              <Stack /> {item.pages}
              {album && " · Album"}
            </span>
          ))}
      </span>

      <span className="find-caption">
        <span className="ellipsis">{item.title}</span>
        <span className="ellipsis dim">{item.author.name}</span>
      </span>
    </div>
  );
}

/* ---------- artists ---------- */

function ArtistsGrid({ artists, onOpenWork }: { artists: FindArtist[]; onOpenWork: (list: FindItem[], index: number) => void }) {
  const open = useFind((s) => s.open);
  return (
    <div className="find-artists">
      {artists.map((a) => (
        <ArtistCard key={a.id} artist={a} onOpen={() => open({ section: "artist", author: { id: a.id, name: a.name } })} onOpenWork={(i) => onOpenWork(a.recent, i)} />
      ))}
    </div>
  );
}

function ArtistCard({ artist, onOpen, onOpenWork }: { artist: FindArtist; onOpen: () => void; onOpenWork: (i: number) => void }) {
  const pluginId = useFind((s) => s.pluginId);
  const avatar = useFindImage(pluginId, artist.avatar);
  return (
    <div className="find-artist-card panel">
      <button className="find-artist-who" onClick={onOpen} title={`${artist.name}'s works`}>
        {avatar.src ? <img src={avatar.src} alt="" /> : <UserCircle size={40} />}
        <span className="find-artist-names">
          <b className="ellipsis">{artist.name}</b>
          {artist.account && <span className="small dim ellipsis">@{artist.account}</span>}
        </span>
      </button>
      <div className="find-artist-recent">
        {artist.recent.slice(0, 3).map((w, i) => (
          <RecentThumb key={w.id} item={w} onOpen={() => onOpenWork(i)} />
        ))}
      </div>
    </div>
  );
}

function RecentThumb({ item, onOpen }: { item: FindItem; onOpen: () => void }) {
  const pluginId = useFind((s) => s.pluginId);
  const img = useFindImage(pluginId, item.thumb);
  return (
    <button className="find-recent" onClick={onOpen} title={item.title}>
      {img.src ? <img src={img.src} alt="" draggable={false} /> : <span className="find-ph" />}
    </button>
  );
}

/** An artist's tags as the platform lists them, kept for the session. */
const tagsOf = new Map<string, FindTag[]>();
const TAGS_SHOWN = 16;

/** An artist's tags, most used first, with how many works carry each: one picked shows only those works. */
function ArtistTags({ authorId }: { authorId: string }) {
  const f = useFind(useShallow((s) => ({ pluginId: s.pluginId, tag: s.view.tag, open: s.open })));
  const key = `${f.pluginId}:${authorId}`;
  const [tags, setTags] = useState<FindTag[] | null>(() => tagsOf.get(key) ?? null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const kept = tagsOf.get(key);
    if (kept) return setTags(kept);
    let live = true;
    setTags(null);
    askFinder.artistTags(f.pluginId!, authorId).then(
      (t) => (tagsOf.set(key, t), live && setTags(t)),
      () => live && setTags([]),
    );
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!tags?.length) return null;
  // The tag picked stays in view when the list is folded.
  const shown = all ? tags : [...tags.slice(0, TAGS_SHOWN), ...tags.slice(TAGS_SHOWN).filter((t) => t.name === f.tag)];
  return (
    <div className="chips find-artist-tags">
      {shown.map((t) => (
        <button key={t.name} className={`chip ${f.tag === t.name ? "on" : ""}`} onClick={() => f.open({ tag: f.tag === t.name ? null : t.name })} title={f.tag === t.name ? "Show all their works again" : `Only their works tagged ${t.name}`}>
          #{t.name}
          {t.translated && <span className="dim">{t.translated}</span>}
          <span className="faint mono">{t.count.toLocaleString("en-GB")}</span>
        </button>
      ))}
      {tags.length > TAGS_SHOWN && (
        <button className="chip link" onClick={() => setAll(!all)}>
          {all ? "Fewer" : `${tags.length - TAGS_SHOWN} more`}
        </button>
      )}
    </div>
  );
}

function ArtistHeader({ artist }: { artist: FindArtist }) {
  const pluginId = useFind((s) => s.pluginId);
  const finder = useFinders((s) => s.finders[pluginId!]);
  const avatar = useFindImage(pluginId, artist.avatar);
  const artists = useArtists();
  useEffect(() => {
    void artists.load();
  }, [artists]);
  const mine = linkedArtist(artists.doc, finder.platform, artist.id);
  const count = mine ? (countsOf(artists.doc)[mine.id] ?? 0) : 0;
  const [linking, setLinking] = useState(false);
  // One of the library's artists already, met on another platform: this account is theirs too.
  const linkTo = async (to: LocalArtist) => {
    setLinking(false);
    try {
      await artists.linkTo(to.id, { platform: finder.platform, id: artist.id, account: artist.account, url: artist.url });
      useStore.getState().toast(`${artist.name} on ${finder.name} is ${to.name} now`, "ok");
    } catch (e) {
      useStore.getState().toast(String(e).replace(/^Error: /, ""), "error");
    }
  };
  // One of the library's artists from now on, filled in from here; their pictures are only suggested to them.
  const add = async () => {
    const id = artists.create(artist.name, { platform: finder.platform, id: artist.id, account: artist.account, url: artist.url });
    if (!id) return;
    await artists.refresh(id).catch((e) => useStore.getState().toast(String(e).replace(/^Error: /, ""), "warn"));
    useStore.getState().toast(`${artist.name} is one of your artists now`, "ok");
  };
  return (
    <div className="find-artist-head">
      {avatar.src ? <img src={avatar.src} alt="" /> : <UserCircle size={56} />}
      <div className="find-artist-names">
        <h2>{artist.name}</h2>
        <span className="small dim">
          {artist.account && `@${artist.account}`}
          {artist.works ? ` · ${artist.works.toLocaleString("en-GB")} works` : ""}
        </span>
      </div>
      <span className="grow" />
      <FollowButton pluginId={pluginId!} artistId={artist.id} name={artist.name} followed={artist.followed} onChange={(followed) => useFind.setState((s) => ({ artist: s.artist?.id === artist.id ? { ...s.artist, followed } : s.artist }))} />
      {mine ? (
        <button className="btn sm" onClick={() => useStore.getState().openArtists(mine.id)} title="Their page in Artists (W)">
          <Check /> In your artists{count ? `: ${count} picture${count === 1 ? "" : "s"}` : ""}
        </button>
      ) : (
        <>
          <button className="btn sm" disabled={!artists.doc} onClick={() => void add()} title="Keep them in Artists, with their icon and description from here">
            <Plus /> Add to your artists
          </button>
          {Object.keys(artists.doc?.artists ?? {}).length > 0 && (
            <button className="btn sm ghost" onClick={() => setLinking(true)} title="One of your artists already, met on another platform: this account linked to them">
              <LinkSimple /> Link to an existing artist…
            </button>
          )}
          {linking && <ArtistLinkPicker name={artist.name || artist.account} title={`${artist.name} on ${finder.name} is…`} onPick={(a) => void linkTo(a)} onClose={() => setLinking(false)} />}
        </>
      )}
      {artist.url && (
        <button className="btn sm ghost" onClick={() => void openUrl(artist.url!)} title={`Their page on ${finder.name}, in your browser`}>
          <ArrowSquareOut /> {finder.name}
        </button>
      )}
    </div>
  );
}

/* ---------- looking closer ---------- */

/** Looking closer at a work: every page (a tick on each, for the pages to keep), what is known of it, works related to it. `choosing`: opened in the basket, where importing is chosen. */
function Preview({ item: listed, index, count, depth, onClose, onBack, onMove, onRelated, onContext, choosing }: { item: FindItem; index: number; count: number; depth: number; onClose: () => void; onBack: () => void; onMove: (i: number) => void; onRelated: (list: FindItem[], index: number) => void; onContext: OnContext; choosing: boolean }) {
  const f = useFind(useShallow((s) => ({ pluginId: s.pluginId, picks: s.picks, baskets: s.baskets, togglePick: s.togglePick, toggleBasket: s.toggleBasket, setPages: s.setPages, setAlbum: s.setAlbum, check: s.check, open: s.open })));
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const [work, setWork] = useState<{ view: FindWorkView | null; error: string | null }>({ view: null, error: null });
  // The work in full once its own page has come (a list may say little of it: no tags, no artist).
  const item = work.view?.item.id === listed.id ? work.view.item : listed;
  const picked = f.picks.some((p) => p.id === item.id);
  const kept = (f.baskets[f.pluginId!] ?? []).some((b) => b.id === item.id);
  const marks = useMarks();
  const album = marks.album.has(item.id);
  const pagesRef = useRef<HTMLDivElement>(null);
  // Its platform's tags linked to yours (right-click one to link it): what comes in carrying it gets yours.
  const sourceMap = useTags((x) => x.data?.sourceMap);
  const [tagMenu, setTagMenu] = useState<{ at: { x: number; y: number }; name: string } | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  useEffect(() => void useTags.getState().load(), []);
  const autoMap = useTags((t) => t.data?.autoMap);
  // Linked to a tag of yours: itself, or (a platform whose tags are the tagger's words) by the word.
  const linkOf = (name: string) => sourceMap?.[`${finder.platform}:${name}`] ?? (finder.taggerWords ? autoMap?.[name] : undefined);
  const shownName = (name: string) => (finder.taggerWords ? name.replace(/_/g, " ") : name);
  // By kind where the platform says: who is in it and what it is from before what is in it.
  const groups = TAG_GROUPS.map(([kind, label]) => [label, item.tags.filter((t) => (t.kind ?? "general") === kind)] as const).filter(([, list]) => list.length);
  const search = (name: string, add: boolean) => {
    onClose();
    const s = finder.sections.find((x) => x.query);
    // Added: to the search there is, narrowing it.
    if (s) f.open({ section: s.id, query: add ? queryOf(withTerms(termsOf(useFind.getState().view.query), name)) : name });
  };

  useEffect(() => {
    let live = true;
    askFinder.work(f.pluginId!, item.id).then(
      (view) => live && setWork({ view, error: null }),
      (e) => live && setWork({ view: null, error: String(e).replace(/^Error: /, "") }),
    );
    return () => {
      live = false;
    };
  }, [item.id, f.pluginId]);

  const pages = work.view?.pages ?? [{ preview: item.thumb, thumb: item.thumb }];
  const date = item.date ? new Date(item.date) : null;
  // The pages to keep, of a work of several: all unless some were left out.
  const only = ((f.baskets[f.pluginId!] ?? []) as BasketItem[]).find((b) => b.id === item.id)?.only;
  const keeps = (i: number) => !only || only.includes(i);
  const keptCount = only ? only.length : item.pages;
  // An album platform's pages are picked (none: the whole album); another's are kept or left out (all kept to begin with).
  const pagePicked = (i: number) => !!only?.includes(i);
  const togglePick = (i: number) => {
    const st = useFind.getState();
    const now = ((st.baskets[st.pluginId!] ?? []) as BasketItem[]).find((b) => b.id === item.id)?.only ?? [];
    f.setPages(item, now.includes(i) ? now.filter((k) => k !== i) : [...now, i]);
  };
  const togglePage = (i: number) => {
    // As the basket is now, not as it was drawn: two ticks in a row both count.
    const st = useFind.getState();
    const current = ((st.baskets[st.pluginId!] ?? []) as BasketItem[]).find((b) => b.id === item.id)?.only;
    const now = current ?? Array.from({ length: item.pages }, (_, k) => k);
    const next = now.includes(i) ? now.filter((k) => k !== i) : [...now, i];
    // At least one page: leaving every page out is taking the work out of the basket.
    if (next.length) f.setPages(item, next);
  };
  // H: only its pages, everything around them away (as the top bar and side panel).
  const bare = useStore((s) => s.navCollapsed && s.sideCollapsed);
  return (
    <div className={`find-preview ${bare ? "bare" : ""}`} role="dialog" aria-label={item.title}>
      {finder.albums && pages.length > 1 ? (
        // A work of an album platform is read as an album.
        <AlbumPages key={item.id} pages={pages} picked={pagePicked} onToggle={togglePick} error={work.error}>
          <Related item={item} root={pagesRef} marks={marks} onOpen={onRelated} onContext={onContext} />
        </AlbumPages>
      ) : (
        <div className="find-preview-pages" ref={pagesRef}>
          {pages.map((p, i) => (
            <PreviewPage key={`${item.id}-${i}`} url={p.preview} thumb={p.thumb ?? (i === 0 ? item.thumb : null)} page={pages.length > 1 ? { index: i, keep: keeps(i), onToggle: () => togglePage(i) } : null} />
          ))}
          {work.error && <div className="find-note find-error">{work.error}</div>}
          <Related item={item} root={pagesRef} marks={marks} onOpen={onRelated} onContext={onContext} />
        </div>
      )}
      <aside className="find-preview-side panel">
        <div className="row">
          {depth > 1 ? (
            <button className="btn sm ghost" onClick={onBack} title="Back to the work you came from (⌫)">
              <ArrowLeft /> Back
            </button>
          ) : (
            <button className="btn sm ghost" onClick={onClose}>
              <X /> Close <kbd className="kbd">Esc</kbd>
            </button>
          )}
          <span className="grow" />
          <button className="btn sm ghost" disabled={index === 0} onClick={() => onMove(index - 1)} title={finder.albums ? "Previous work (⇧←)" : "Previous (←)"}>
            ←
          </button>
          <span className="mono small faint">
            {index + 1} / {count}
          </span>
          <button className="btn sm ghost" disabled={index >= count - 1} onClick={() => onMove(index + 1)} title={finder.albums ? "Next work (⇧→)" : "Next (→)"}>
            →
          </button>
        </div>
        <h2 className="find-preview-title">{item.title || "Untitled"}</h2>
        <button
          className="btn sm ghost find-artist"
          onClick={() => {
            onClose();
            f.open({ section: "artist", author: { id: item.author.id, name: item.author.name } });
          }}
          title="Their works"
        >
          <UserCircle /> {item.author.name}
        </button>
        <div className="small dim find-facts">
          {date && !Number.isNaN(date.getTime()) && <span>{date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</span>}
          {item.pages > 1 && <span>{item.pages} pages: an album</span>}
          {item.kind === "animation" && <span>Animation: a video</span>}
          <span>
            <Heart /> {item.likes.toLocaleString("en-GB")}
          </span>
          {item.adult && <span className="find-badge alarm">18+</span>}
        </div>
        <div className="row find-preview-actions">
          {choosing ? (
            <>
              <button className={`btn ${picked ? "active" : "primary"}`} onClick={() => f.togglePick(item)}>
                {picked ? <Check /> : <DownloadSimple />} {picked ? "Chosen to import" : "Choose to import"} <kbd className="kbd">Space</kbd>
              </button>
              <button className="btn ghost" onClick={() => f.toggleBasket(item)} title="Out of the basket">
                <Basket /> Out of the basket <kbd className="kbd">S</kbd>
              </button>
            </>
          ) : (
            <button className={`btn ${kept ? "active" : "primary"}`} onClick={() => f.toggleBasket(item)} title={kept ? "Out of the basket" : "Keep it in the basket to look at later; import from there"}>
              <Basket weight={kept ? "fill" : "regular"} /> {kept ? "In the basket" : "Into the basket"} <kbd className="kbd">Space</kbd>
            </button>
          )}
        </div>
        {finder.albums && item.pages > 1 && (
          <div className="find-pages-kept small">
            {only?.length ? (
              <>
                <span>
                  {only.length} page{only.length === 1 ? "" : "s"} picked: only {only.length === 1 ? "it comes" : "they come"} in, {only.length === 1 ? "as a single picture" : "each a single picture"}.
                </span>
                <button className="btn sm ghost" onClick={() => f.setPages(item, null)}>
                  <Stack /> Whole gallery again
                </button>
              </>
            ) : (
              <span className="dim">The whole gallery comes in as an album of {item.pages} pages. Pick pages below to bring in only those, each a single picture.</span>
            )}
          </div>
        )}
        {!finder.albums && item.pages > 1 && (
          <div className="find-pages-kept small">
            <span className={keptCount < item.pages ? "" : "dim"}>
              {keptCount < item.pages ? `Keeping ${keptCount} of ${item.pages} pages` : `All ${item.pages} pages`}
              {keptCount === 1 ? ": it comes in as a single picture" : album ? ": they come in as an album" : ": each comes in as a single picture"}
            </span>
            {keptCount < item.pages ? (
              <button className="btn sm ghost" onClick={() => f.setPages(item, null)}>
                Keep all
              </button>
            ) : (
              <span className="dim">Untick a page to leave it out.</span>
            )}
            {keptCount > 1 && item.kind !== "animation" && (
              <button className={`btn sm ${album ? "active" : "ghost"}`} onClick={() => f.setAlbum(item, !album)} title={album ? "Each page a single picture instead" : "Its pages together, as an album of its own"}>
                <Stack /> {album ? "As an album" : "Import as an album"}
              </button>
            )}
          </div>
        )}
        <div className="row find-preview-actions">
          <button className="btn ghost" onClick={() => void f.check(item)} title="Look for it in your library: by what Find brought in, its id in a name, and the picture itself">
            <MagnifyingGlass /> Do I have this? <kbd className="kbd">C</kbd>
          </button>
          {item.url && (
            <button className="btn ghost" onClick={() => void openUrl(item.url!)} title={`Open on ${finder.name} in your browser`}>
              <ArrowSquareOut /> {finder.name} <kbd className="kbd">O</kbd>
            </button>
          )}
        </div>
        <CheckResult id={item.id} />
        {groups.map(([label, list]) => (
          <div key={label} className="find-tag-group">
            <div className="label">{label}</div>
            <div className="chips find-tags">
              {list.map((t) => (
                <button
                  key={t.name}
                  className={`chip link ${linkOf(t.name) ? "linked" : ""}`}
                  onClick={(e) => search(t.name, e.shiftKey)}
                  onContextMenu={(e) => (e.preventDefault(), setTagMenu({ at: { x: e.clientX, y: e.clientY }, name: t.name }))}
                  title={`Search ${t.name} (⇧: add it to the search; right-click to link it to a tag of yours)`}
                >
                  {shownName(t.name)}
                  {t.translated && <span className="dim"> · {t.translated}</span>}
                  {linkOf(t.name) && (
                    <span className="find-tag-link" title={`What comes in carrying it gets ${linkOf(t.name)}`}>
                      <LinkSimple /> {nameOf(linkOf(t.name)!)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
        <ContextMenu
          at={tagMenu?.at ?? null}
          items={
            tagMenu
              ? [
                  { label: linkOf(tagMenu.name) ? `Link to another tag of yours… (now ${nameOf(linkOf(tagMenu.name)!)})` : "Link to my tag…", onClick: () => setLinking(tagMenu.name) },
                  ...(sourceMap?.[`${finder.platform}:${tagMenu.name}`]
                    ? [{ label: "Unlink", onClick: () => useTags.getState().linkSource(finder.platform, tagMenu.name, null) }]
                    : linkOf(tagMenu.name)
                      ? [{ label: "Linked by the tagger's word: change it in Tags", disabled: true }]
                      : []),
                  { separator: true },
                  { label: `Search ${tagMenu.name}`, onClick: () => search(tagMenu.name, false) },
                  { label: "Add it to the search", onClick: () => search(tagMenu.name, true) },
                ]
              : []
          }
          onClose={() => setTagMenu(null)}
        />
        {linking && <LinkTag platform={finder.platform} name={linking} onClose={() => setLinking(null)} />}
        {work.view?.caption && <p className="small find-caption-text">{work.view.caption}</p>}
      </aside>
    </div>
  );
}

/** A page, large; its own small picture until the large one comes (never another page's). With a tick to keep it, in a work of several. */
/** A platform's tag linked to one of yours: what comes in from there carrying it gets yours. */
function LinkTag({ platform, name, onClose }: { platform: string; name: string; onClose: () => void }) {
  const d = useTags((x) => x.data);
  const tags = d ? allTags(d) : [];
  return (
    <Modal title={`Link #${name} to a tag of yours`} onClose={onClose}>
      <p className="dim small">What comes in carrying #{name} gets your tag from then on. Linked tags are listed on each tag's panel in Tags.</p>
      {tags.length ? (
        <MergePicker label="Your tag" tags={tags} onPick={(id) => (useTags.getState().linkSource(platform, name, id), onClose())} />
      ) : (
        <p className="dim">You have no tags yet: make some in Tags first.</p>
      )}
    </Modal>
  );
}

/** Which way a platform's albums read, as last chosen: right to left (as manga) unless said otherwise. */
const readsRtl = (pluginId: string | null) => {
  try {
    return localStorage.getItem(`quire.find.ltr.${pluginId}`) !== "1";
  } catch {
    return true;
  }
};

/**
 * A work read as an album: a page at a time, turned as the theme's sticker book turns its pages
 * (when page turns are on), the way it reads (right to left unless said otherwise: ← and → go its
 * way, a click on a side too); its pages small below, each kept or left out; after the last, what
 * is related to it.
 */
function AlbumPages({ pages, picked, onToggle, error, children }: { pages: FindWorkView["pages"]; picked: (i: number) => boolean; onToggle: (i: number) => void; error: string | null; children: React.ReactNode }) {
  const pluginId = useFind((s) => s.pluginId);
  const theme = useStore((s) => s.theme);
  const turns = useStore((s) => s.pageTurns);
  const [at, setAt] = useState(0);
  const [rtl, setRtlNow] = useState(() => readsRtl(pluginId));
  const [turn, setTurn] = useState<{ id: number; src: string; forward: boolean; ms: number } | null>(null);
  const lastTurn = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const page = pages[at];
  const big = useFindImage(pluginId, page?.preview ?? null);
  const small = useFindImage(pluginId, page?.thumb ?? null, !big.src);
  const src = big.src ?? small.src;
  // The next two, ready before they are turned to.
  useFindImage(pluginId, pages[at + 1]?.preview ?? null);
  useFindImage(pluginId, pages[at + 2]?.preview ?? null);
  const end = at >= pages.length;
  const setRtl = (v: boolean) => {
    setRtlNow(v);
    try {
      localStorage.setItem(`quire.find.ltr.${pluginId}`, v ? "0" : "1");
    } catch {
      /* no storage */
    }
  };
  const go = (to: number) => {
    const next = Math.max(0, Math.min(pages.length, to));
    if (next === at) return;
    // Quicker when turned again before the last turn ended, as the viewer's.
    const now = performance.now();
    if (turns && src && !end && next < pages.length && !matchMedia("(prefers-reduced-motion: reduce)").matches) setTurn({ id: now, src, forward: next > at, ms: now - lastTurn.current < 650 ? 260 : 650 });
    lastTurn.current = now;
    setAt(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTypingTarget(e.target)) return;
      const k = e.key;
      const forward = rtl ? "ArrowLeft" : "ArrowRight";
      const back = rtl ? "ArrowRight" : "ArrowLeft";
      if (k === forward) go(at + 1);
      else if (k === back) go(at - 1);
      else if (k === "Home") go(0);
      else if (k === "End") go(pages.length - 1);
      else if (k.toLowerCase() === "p" && !end) onToggle(at);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // The page shown in the strip, in view.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => strip.current?.querySelector(".find-strip-page.on")?.scrollIntoView({ block: "nearest", inline: "nearest" }), [at]);
  const away = turn && turn.forward !== rtl ? "to-left" : "to-right";
  return (
    <div className={`find-reader ${rtl ? "rtl" : ""}`}>
      <div
        className="find-reader-stage"
        onClick={(e) => {
          if (end) return;
          const r = e.currentTarget.getBoundingClientRect();
          const left = e.clientX < r.left + r.width / 2;
          go(left === rtl ? at + 1 : at - 1);
        }}
      >
        {end ? (
          <div className="find-reader-end" ref={endRef} onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <span className="label grow">The end</span>
              <button className="btn sm ghost" onClick={() => go(0)}>
                Read it again
              </button>
            </div>
            {children}
          </div>
        ) : src ? (
          <FitImage src={src} mode="fit" />
        ) : (
          <div className="fitbox">
            <span className="find-ph" />
          </div>
        )}
        {turn && <Leaf key={turn.id} src={turn.src} motion={bookOf(theme).motion} away={away} ms={turn.ms} fit="fit" onDone={() => setTurn(null)} />}
      </div>
      {error && <div className="find-note find-error">{error}</div>}
      <div className="find-reader-bar">
        <button className="btn sm ghost" onClick={() => setRtl(!rtl)} title="Which way its pages read">
          {rtl ? "Right to left" : "Left to right"}
        </button>
        <span className="mono small">{end ? "End" : `${at + 1} / ${pages.length}`}</span>
        <span className="faint small">{rtl ? "← next · → back" : "→ next · ← back"} · P picks this page · ⇧ another work · H only the page</span>
      </div>
      <div className="find-strip" ref={strip}>
        {pages.map((p, i) => (
          <StripPage key={i} thumb={p.thumb ?? p.preview} index={i} on={i === at} picked={picked(i)} onOpen={() => go(i)} onToggle={() => onToggle(i)} root={strip} />
        ))}
      </div>
    </div>
  );
}

/** A page small in the reader's strip, loaded once in view: click to turn to it, its tick to pick it (to come in on its own, as a single picture). */
function StripPage({ thumb, index, on, picked, onOpen, onToggle, root }: { thumb: string | null; index: number; on: boolean; picked: boolean; onOpen: () => void; onToggle: () => void; root: React.RefObject<HTMLDivElement | null> }) {
  const pluginId = useFind((s) => s.pluginId);
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !box.current || typeof IntersectionObserver === "undefined") return void (typeof IntersectionObserver === "undefined" && setSeen(true));
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setSeen(true), { root: root.current, rootMargin: "0px 400px" });
    io.observe(box.current);
    return () => io.disconnect();
  }, [seen, root]);
  const img = useFindImage(pluginId, thumb, seen);
  return (
    <div ref={box} className={`find-strip-page ${on ? "on" : ""} ${picked ? "picked" : ""}`}>
      <button className="find-strip-pic" onClick={onOpen} title={`Page ${index + 1}`}>
        {img.src ? <img src={img.src} alt="" draggable={false} /> : <span className="find-ph" />}
      </button>
      <button className={`find-page-keep ${picked ? "on" : ""}`} onClick={onToggle} title={picked ? `Unpick page ${index + 1}` : `Pick page ${index + 1}: it comes in on its own, as a single picture`}>
        {picked ? <Check /> : null}
        <span className="mono">{index + 1}</span>
      </button>
    </div>
  );
}

function PreviewPage({ url, thumb, page }: { url: string; thumb: string | null; page: { index: number; keep: boolean; onToggle: () => void } | null }) {
  const pluginId = useFind((s) => s.pluginId);
  const big = useFindImage(pluginId, url);
  const small = useFindImage(pluginId, thumb, !big.src);
  const src = big.src ?? small.src;
  return (
    <div className={`find-preview-page ${page && !page.keep ? "left-out" : ""}`}>
      {src ? <img src={src} alt="" draggable={false} /> : <span className="find-ph" />}
      {page && (
        <button className={`find-page-keep ${page.keep ? "on" : ""}`} onClick={page.onToggle} title={page.keep ? `Leave page ${page.index + 1} out` : `Keep page ${page.index + 1}`}>
          {page.keep ? <Check /> : null}
          <span className="mono">{page.index + 1}</span>
        </button>
      )}
    </div>
  );
}

/** Works like this one, under its pages, as the platform suggests them; more as the end comes near. */
function Related({ item, root, marks, onOpen, onContext }: { item: FindItem; root: React.RefObject<HTMLDivElement | null>; marks: Marks; onOpen: (list: FindItem[], index: number) => void; onContext: OnContext }) {
  const pluginId = useFind((s) => s.pluginId);
  const toggleBasket = useFind((s) => s.toggleBasket);
  const [state, setState] = useState<{ items: FindItem[]; next: string | null; loading: boolean; error: string | null }>({ items: [], next: null, loading: true, error: null });
  const [box, width] = useWidth<HTMLDivElement>();
  const end = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const load = async (cursor?: string) => {
    if (busy.current) return;
    busy.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await askFinder.related(pluginId!, { id: item.id, cursor });
      setState((s) => {
        const have = new Set(cursor ? s.items.map((i) => i.id) : []);
        return { items: [...(cursor ? s.items : []), ...page.items.filter((i) => !have.has(i.id) && i.id !== item.id)], next: page.next, loading: false, error: null };
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: String(e).replace(/^Error: /, "") }));
    } finally {
      busy.current = false;
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);
  useEffect(() => {
    const el = end.current;
    if (!el || !state.next) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void load(state.next!), { root: root.current, rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.next, state.items.length]);

  const rows = useMemo(() => justify(state.items.map((i) => ratioOf(i.width, i.height)), width, 200, GAP), [state.items, width]);
  return (
    <section className="find-related" ref={box}>
      {(state.items.length > 0 || state.loading || state.error) && <h3>Related</h3>}
      <WorkGrid items={state.items} rows={rows} focus={null} marks={marks} root={root} corner="basket" onCorner={(it) => toggleBasket(it)} onOpen={(i) => onOpen(state.items, i)} onContext={(e, it, i) => onContext(e, it, state.items, i)} />
      {state.error && <div className="find-note find-error">{state.error}</div>}
      {state.loading && <div className="find-note dim">Loading…</div>}
      <div ref={end} className="find-end" />
    </section>
  );
}

/* ---------- do I have this? ---------- */

function CheckResult({ id }: { id: string }) {
  const c = useFind((s) => s.checks[id]);
  if (!c) return null;
  if (c.state === "checking") return <div className="find-check dim small">Looking in your library…</div>;
  if (c.state === "failed") return <div className="find-check find-error small">Couldn't check: {c.error}</div>;
  const why = { imported: "brought in from here", picture: "the same picture", name: "its id in the name" };
  const unchecked = c.pictures - c.fingerprinted;
  return (
    <div className="find-check">
      {c.matches.length ? (
        <>
          <b className="find-check-yes">
            <Check /> In your library{c.matches.length > 1 ? ` (${c.matches.length})` : ""}
          </b>
          <div className="find-check-list">
            {c.matches.slice(0, 8).map((m) => (
              <div key={m.item.key} className="find-check-row">
                <span className="find-check-thumb">
                  <Thumb item={m.item} eager aspect={1} onClick={() => useStore.getState().openViewer([m.item], 0, { kind: "browse" })} />
                </span>
                <span className="grow find-check-where">
                  <span className="small ellipsis" title={m.item.key}>
                    {m.item.key}
                  </span>
                  <span className="small dim">
                    {why[m.why]}
                    {m.score != null && ` · ${Math.round(m.score * 100)}% alike${m.score < SURE_MATCH ? ", less sure" : ""}`}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <b>Not in your library</b>
      )}
      {c.artist && <CheckArtist id={id} artist={c.artist} />}
      <span className="small dim">
        {unchecked > 0 ? (
          <>
            Compared with {c.fingerprinted.toLocaleString("en-GB")} of your {c.pictures.toLocaleString("en-GB")} pictures: the duplicate check hasn't fingerprinted the other {unchecked.toLocaleString("en-GB")} yet.{" "}
            <button className="btn sm ghost" onClick={() => useStore.getState().openDupes()}>
              Fingerprint them in Duplicates
            </button>
          </>
        ) : (
          `Compared with all ${c.pictures.toLocaleString("en-GB")} of your pictures.`
        )}
      </span>
    </div>
  );
}

/** The check's result beside where it was asked for, until Escape or a click elsewhere. */
/** The basket against the library: how much of it is looked for, and looking for the rest (in Activity). */
function BasketCheck({ shown, marks }: { shown: FindItem[]; marks: Marks }) {
  const checkBasket = useFind((s) => s.checkBasket);
  const running = useJobs((s) => s.jobs.some((j) => j.source === "Find" && j.title.startsWith("Looking for")));
  const fresh = shown.filter((it) => marks.fresh.has(it.id)).length;
  const have = shown.filter((it) => marks.have.has(it.id)).length;
  const left = shown.length - fresh - have;
  if (!shown.length) return null;
  return (
    <span className="find-basket-check row">
      <span className="small dim">{left ? `${fresh} not in your library, ${have} in it, ${left} not looked for` : `All looked for: ${fresh} not in your library, ${have} in it`}</span>
      {left > 0 ? (
        <button className="btn sm" disabled={running} onClick={() => void checkBasket()} title="“Do I have this?” for each one not asked yet, in Activity">
          <MagnifyingGlass /> Look for {left === shown.length ? "them all" : `the ${left}`}
        </button>
      ) : (
        <button className="btn sm ghost" disabled={running} onClick={() => void checkBasket(true)} title="Look for each one again (after bringing pictures in another way, say)">
          Look again
        </button>
      )}
    </span>
  );
}

/** The artist the library's copies were given (or had already), to see or take back. */
function CheckArtist({ id, artist }: { id: string; artist: HaveArtist }) {
  const undo = () => {
    useArtists.getState().unassign(artist.given, artist.id);
    const c = useFind.getState().checks[id];
    if (c?.state === "done" && c.artist) useFind.setState({ checks: { ...useFind.getState().checks, [id]: { ...c, artist: { ...c.artist, given: [] } } } });
  };
  const n = (k: number) => (k === 1 ? "it" : `${k} of them`);
  const local = useArtists((s) => s.doc?.artists[artist.id]);
  const others = useArtists((s) => Object.keys(s.doc?.artists ?? {}).length > 1);
  const [joining, setJoining] = useState(false);
  // The artist given is one of the library's already, met on another platform: one artist, theirs the name.
  const sameAs = (into: LocalArtist) => {
    setJoining(false);
    useArtists.getState().merge(artist.id, into.id);
    const c = useFind.getState().checks[id];
    if (c?.state === "done" && c.artist) useFind.setState({ checks: { ...useFind.getState().checks, [id]: { ...c, artist: { ...c.artist, id: into.id, name: into.name } } } });
    useStore.getState().toast(`${artist.name} is ${into.name}: one artist now`, "ok");
  };
  return (
    <div className="find-check-artist row">
      {local ? <ArtistIcon artist={local} size={22} /> : <PaintBrush />}
      <span className="find-check-artist-text small">
        {artist.given.length ? <>Given to <b>{artist.name}</b>{artist.given.length > 1 ? ` (${artist.given.length})` : ""}</> : artist.already ? <><b>{artist.name}</b>'s already</> : null}
        {artist.others > 0 && <span className="dim">{artist.given.length || artist.already ? "; " : ""}another artist's already: {n(artist.others)} left as it is</span>}
      </span>
      {/* Under the line, so a long name keeps the width of the box. */}
      <span className="find-check-artist-acts">
        {artist.given.length > 0 && (
          <button className="btn sm ghost" onClick={undo} title={`Not ${artist.name}'s after all`}>
            Undo
          </button>
        )}
        {artist.given.length > 0 && others && (
          <button className="btn sm ghost" onClick={() => setJoining(true)} title="One of your artists already, met on another platform: the two made one">
            Same as one of yours…
          </button>
        )}
        <button className="btn sm ghost" onClick={() => useStore.getState().openArtists(artist.id)} title="Their page in Artists">
          Their page
        </button>
      </span>
      {joining && <ArtistLinkPicker name={artist.name} title={`${artist.name} is…`} without={artist.id} onPick={sameAs} onClose={() => setJoining(false)} />}
    </div>
  );
}

function CheckPopover({ at, onClose }: { at: CheckAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
  const left = Math.min(Math.max(12, at.x - 170), window.innerWidth - 352);
  const top = Math.min(at.y + 8, window.innerHeight - 260);
  return (
    <div className="find-check-pop panel" ref={ref} style={{ left, top }} role="dialog" aria-label="Do I have this?">
      <div className="row">
        <span className="label grow ellipsis">{at.item.title || "This work"}</span>
        <button className="btn sm ghost" onClick={onClose} title="Close (Esc)">
          <X />
        </button>
      </div>
      <CheckResult id={at.item.id} />
    </div>
  );
}

/* ---------- the picks ---------- */

/** Importing from the basket: what is chosen of it, and bringing that in. */
function PickBar({ shown }: { shown: FindItem[] }) {
  const f = useFind(useShallow((s) => ({ picks: s.picks, pulling: s.pulling, clearPicks: s.clearPicks, pull: s.pull, baskets: s.baskets, pluginId: s.pluginId, inBasket: s.view.section === BASKET })));
  const basket = (f.baskets[f.pluginId!] ?? []) as BasketItem[];
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const onlyOf = (id: string) => basket.find((b) => b.id === id)?.only;
  const files = f.picks.reduce((n, p) => n + (p.kind === "animation" ? 1 : (onlyOf(p.id)?.length ?? p.pages)), 0);
  const albums = f.picks.filter((p) => (basket.find((b) => b.id === p.id)?.album ?? finder.albums) && (onlyOf(p.id)?.length ?? p.pages) > 1).length;
  const all = f.inBasket && shown.length > 0 && shown.every((it) => f.picks.some((p) => p.id === it.id));
  return (
    <div className="find-pickbar panel">
      <b>
        {f.picks.length} of {basket.length} chosen
      </b>
      <span className="dim small">
        {files} file{files === 1 ? "" : "s"}
        {albums ? `, ${albums} as album${albums === 1 ? "" : "s"}` : ""}
      </span>
      <span className="grow" />
      {f.inBasket && !all && (
        <button className="btn ghost" onClick={() => useFind.setState({ picks: [...shown] })} disabled={f.pulling} title="Choose all of the basket (⌘A)">
          Choose all
        </button>
      )}
      {f.picks.length > 0 && (
        <button className="btn ghost" onClick={f.clearPicks} disabled={f.pulling}>
          Choose none
        </button>
      )}
      <button className="btn primary" onClick={() => void f.pull()} disabled={f.pulling || !f.picks.length}>
        <DownloadSimple /> {f.pulling ? "Getting them…" : `Import ${f.picks.length || ""}…`} <kbd className="kbd">I</kbd>
      </button>
    </div>
  );
}
