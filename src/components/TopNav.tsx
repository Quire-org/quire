import { Books, CaretDown, CaretLeft, CaretRight, CaretUp, Copy, FolderOpen, GearSix, LockKey, Question, SquaresFour, SlidersHorizontal } from "@phosphor-icons/react";
import { useStore, type Screen } from "../store";

const LABEL: Record<string, string> = { viewer: "Sort", browse: "Browse", albums: "Albums", dupes: "Duplicates", files: "Files" };

/** The same navigation bar on every list screen. H collapses it and the sidebar to a thin strip. */
export function TopNav({ current, children }: { current: Screen; children?: React.ReactNode }) {
  const s = useStore();
  if (s.navCollapsed) {
    return (
      <div className="topnav collapsed">
        <span className="label">{LABEL[current]}</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={s.toggleNav} title="Show the top bar">
          <CaretDown />
        </button>
      </div>
    );
  }
  const tab = (id: Screen, label: string, key: string, icon: React.ReactNode, go: () => void) => (
    <button className={`btn sm ${current === id ? "active" : ""}`} onClick={go} title={`${label} (${key})`}>
      {icon} {label} <kbd className="kbd">{key}</kbd>
    </button>
  );
  return (
    <div className="topnav">
      <div className="hud-left">
        <span className="brand">MEDIA SORTER</span>
        <span className="faint mono hud-root" title={s.root ?? ""}>
          {s.root ? s.root.split("/").filter(Boolean).slice(-2).join("/") : ""}
        </span>
      </div>
      <div className="topnav-tabs">
        {tab("viewer", "Sort", "Esc", <SlidersHorizontal />, s.openSortQueue)}
        {tab("browse", "Browse", "B", <SquaresFour />, s.openBrowse)}
        {tab("albums", "Albums", "A", <Books />, s.openAlbums)}
        {tab("dupes", "Duplicates", "D", <Copy />, s.openDupes)}
        {tab("files", "Files", "E", <FolderOpen />, s.openFiles)}
      </div>
      <div className="hud-right">
        {children}
        {s.vault?.unlocked && (
          <button className="btn sm ghost accent2" onClick={() => void s.lockVault()} title="Vault unlocked. Click to lock and close">
            <LockKey />
          </button>
        )}
        <button className="btn sm ghost" onClick={() => s.set({ settingsOpen: true })} title="Settings (G)">
          <GearSix /> <kbd className="kbd">G</kbd>
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
