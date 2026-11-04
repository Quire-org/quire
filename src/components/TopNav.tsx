import { useEffect, useRef, useState } from "react";
import { Books, CaretDown, Tag as TagIcon, CaretLeft, CaretRight, CaretUp, Copy, FolderOpen, GearSix, LockKey, Question, SquaresFour, SlidersHorizontal, BookOpen, UsersThree, MagnifyingGlass, PaintBrush } from "@phosphor-icons/react";
import { useShallow } from "zustand/react/shallow";
import { useStore, type Screen } from "../store";
import { ActivityButton } from "./Activity";
import { CastButton } from "./Cast";
import { useFinders } from "../plugins/find";
import { useFind } from "../findStore";
import { PlatformIcon } from "./PlatformIcon";
import { useUpdateCount } from "../lib/updates";
import { QuireMark } from "./QuireMark";

export const LABEL: Record<string, string> = { viewer: "Sort", browse: "Browse", albums: "Albums", dupes: "Duplicates", files: "Files", tags: "Tags", people: "People", artists: "Artists", find: "Find", activity: "Activity", scrapbook: "Scrapbook" };

/** The screens in three groups: the bar shows the open group as a menu, and that group's screens beside it. */
const GROUPS: { name: string; screens: Screen[] }[] = [
  { name: "Library", screens: ["viewer", "browse", "files", "dupes"] },
  { name: "Collections", screens: ["albums", "tags", "people", "artists", "scrapbook"] },
  { name: "Find", screens: ["find"] },
];
/** Each screen as the bar shows it: its name, key and icon, and how to get there. */
export const SCREENS: Partial<Record<Screen, ScreenInfo>> = {
  viewer: { label: "Sort", key: "Esc", icon: <SlidersHorizontal />, go: () => useStore.getState().openSortQueue() },
  browse: { label: "Browse", key: "B", icon: <SquaresFour />, go: () => useStore.getState().openBrowse() },
  files: { label: "Files", key: "E", icon: <FolderOpen />, go: () => useStore.getState().openFiles() },
  dupes: { label: "Duplicates", key: "D", icon: <Copy />, go: () => useStore.getState().openDupes() },
  albums: { label: "Albums", key: "A", icon: <Books />, go: () => useStore.getState().openAlbums() },
  tags: { label: "Tags", key: "L", icon: <TagIcon />, go: () => useStore.getState().openTags() },
  people: { label: "People", key: "P", icon: <UsersThree />, go: () => useStore.getState().openPeople() },
  artists: { label: "Artists", key: "W", icon: <PaintBrush />, go: () => useStore.getState().openArtists() },
  scrapbook: { label: "Scrapbook", key: "K", icon: <BookOpen />, go: () => useStore.getState().openScrapbook() },
  find: { label: "Find", icon: <MagnifyingGlass />, go: () => useStore.getState().openFind() },
};

/** Each group's screen last open in it: a group opens where you left it. */
const lastIn = new Map<string, Screen>();

/** The same navigation bar on every list screen. H collapses it and the sidebar to a thin strip. */
export function TopNav({ current, children, bar }: { current: Screen; children?: React.ReactNode; bar?: React.ReactNode }) {
  const s = useStore(useShallow((x) => ({ lockVault: x.lockVault, navCollapsed: x.navCollapsed, openAlbums: x.openAlbums, openBrowse: x.openBrowse, openDupes: x.openDupes, openFiles: x.openFiles, openFind: x.openFind, openPeople: x.openPeople, openSortQueue: x.openSortQueue, openScrapbook: x.openScrapbook, openTags: x.openTags, root: x.root, set: x.set, toggleNav: x.toggleNav, vault: x.vault })));
  const group = GROUPS.find((g) => g.screens.includes(current)) ?? GROUPS[0];
  const updates = useUpdateCount();
  // Find's platforms (one plugin each) are each a tab of their own; "Find" while there are none.
  const finders = useFinders((f) => f.finders);
  const platforms = Object.values(finders).map((x) => ({ id: x.pluginId, name: x.name, icon: x.icon }));
  const platformOn = useFind((f) => f.pluginId);
  const openPlatform = (id: string) => {
    useFind.getState().choose(id);
    s.openFind();
  };
  if (group.screens.includes(current)) lastIn.set(group.name, current);
  if (s.navCollapsed) {
    return (
      <div className="topnav collapsed">
        <span className="label">{LABEL[current]}</span>
        <span className="grow" />
        <ActivityButton />
        <button className="btn sm ghost" onClick={s.toggleNav} title="Show the top bar">
          <CaretDown />
        </button>
      </div>
    );
  }
  const tab = (id: Screen) => {
    if (id === "find" && platforms.length)
      return platforms.map((p) => {
        const on = current === "find" && platformOn === p.id;
        return (
          <button key={`find:${p.id}`} className={`subtab ${on ? "on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => openPlatform(p.id)} title={`${p.name}, in Find`}>
            <PlatformIcon pluginId={p.id} url={p.icon} /> <span className="subtab-label">{p.name}</span>
          </button>
        );
      });
    const t = SCREENS[id]!;
    return (
      <button key={id} className={`subtab ${current === id ? "on" : ""}`} aria-current={current === id ? "page" : undefined} onClick={t.go} title={t.key ? `${t.label} (${t.key})` : t.label}>
        {t.icon} <span className="subtab-label">{t.label}</span> {t.key && <kbd className="kbd">{t.key}</kbd>}
      </button>
    );
  };
  return (
    <div className="topnav">
      <div className="hud-left">
        <BrandHome current={current} />
        <span className="faint mono hud-root" title={s.root ?? ""}>
          {s.root ? s.root.split("/").filter(Boolean).slice(-2).join("/") : ""}
        </span>
        {import.meta.env.VITE_DEMO && (
          <span className="hud-demo faint mono" title="The web demo: what you do here stays in this tab, and a reload starts it afresh.">
            Demo<span className="hud-demo-more"> · nothing is saved</span>
          </span>
        )}
      </div>
      {/* A screen's own controls in place of the tabs (the Home while it is arranged). */}
      {bar ? (
        <div className="topnav-tabs topnav-own">{bar}</div>
      ) : (
        <nav className="topnav-tabs" aria-label="Screens">
          <GroupMenu group={group} current={current} screens={SCREENS} platforms={platforms} platformOn={platformOn} onPlatform={openPlatform} />
          {group.screens.map(tab)}
        </nav>
      )}
      <div className="hud-right">
        <ActivityButton />
        {s.root && <CastButton />}
        {children}
        {s.vault?.unlocked && (
          <button className="btn sm ghost accent2" onClick={() => void s.lockVault()} title="Vault unlocked. Click to lock and close">
            <LockKey />
          </button>
        )}
        <button className="btn sm ghost settings-btn" onClick={() => s.set({ settingsOpen: true })} title={updates ? `Settings (G): ${updates} update${updates === 1 ? "" : "s"} waiting, in Updates` : "Settings (G)"}>
          <GearSix /> <kbd className="kbd">G</kbd>
          {updates > 0 && <span className="update-dot" aria-hidden />}
        </button>
        <button className="btn sm ghost" onClick={() => s.set({ helpOpen: true })} title="Keys (?)">
          <Question />
        </button>
        <button className="btn sm ghost" onClick={s.toggleNav} title="Hide the top bar (H hides the sidebar too)">
          <CaretUp />
        </button>
      </div>
    </div>
  );
}

type ScreenInfo = { label: string; key?: string; icon: React.ReactNode; go: () => void };

/** The name in the bar: it goes to the library's Home (⇧H). */
export function BrandHome({ current }: { current: Screen }) {
  const root = useStore((x) => x.root);
  const here = current === "home";
  return (
    <button className={`brand brand-home ${here ? "on" : ""}`} aria-current={here ? "page" : undefined} disabled={!root} onClick={() => useStore.getState().openHome()} aria-label="Quire" title="Home (⇧H)">
      <QuireMark className="brand-mark" />
      UIRE
    </button>
  );
}

/** The open group's name; it opens a menu of every group and its screens, so any screen is two clicks away. */
function GroupMenu({ group, current, screens, platforms, platformOn, onPlatform }: { group: (typeof GROUPS)[number]; current: Screen; screens: Partial<Record<Screen, ScreenInfo>>; platforms: { id: string; name: string; icon: string | null }[]; platformOn: string | null; onPlatform: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(box.current?.querySelectorAll<HTMLButtonElement>(".nav-item") ?? []);
    items().find((b) => b.classList.contains("on"))?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        box.current?.querySelector<HTMLButtonElement>(".nav-group")?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const go = (id: Screen) => {
    setOpen(false);
    screens[id]!.go();
  };
  return (
    <div className={`nav-groupbox ${open ? "open" : ""}`} ref={box}>
      <button className="nav-group" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Every screen, by group">
        {group.name} <CaretDown className="nav-caret" />
      </button>
      {open && (
        <div className="nav-menu panel" role="menu">
          {GROUPS.map((g) => (
            <div key={g.name} className={`nav-menu-group ${g === group ? "here" : ""}`}>
              <div className="label">{g.name}</div>
              {g.screens.map((id) => {
                if (id === "find" && platforms.length)
                  return platforms.map((p) => {
                    const on = current === "find" && platformOn === p.id;
                    return (
                      <button key={`find:${p.id}`} role="menuitem" className={`nav-item ${on ? "on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => (setOpen(false), onPlatform(p.id))}>
                        <PlatformIcon pluginId={p.id} url={p.icon} />
                        <span className="grow">{p.name}</span>
                      </button>
                    );
                  });
                const t = screens[id]!;
                return (
                  <button key={id} role="menuitem" className={`nav-item ${id === current ? "on" : ""}`} aria-current={id === current ? "page" : undefined} onClick={() => go(id)}>
                    {t.icon}
                    <span className="grow">{t.label}</span>
                    {t.key && <kbd className="kbd">{t.key}</kbd>}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="faint small nav-menu-foot">Find: each platform is a plugin (Settings → Plugins).</div>
        </div>
      )}
    </div>
  );
}

/** Small tab on the sidebar's edge that collapses or restores it. */
export function SideToggle() {
  const collapsed = useStore((st) => st.sideCollapsed);
  const toggle = useStore((st) => st.toggleSide);
  return (
    <button className={`side-toggle ${collapsed ? "collapsed" : ""}`} onClick={toggle} title={collapsed ? "Show the sidebar" : "Hide the sidebar (H hides the top bar too)"}>
      {collapsed ? <CaretRight /> : <CaretLeft />}
    </button>
  );
}
