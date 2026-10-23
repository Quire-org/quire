import { Books, CaretUp, Copy, GearSix, List, Question, SquaresFour, SlidersHorizontal } from "@phosphor-icons/react";
import { useStore, type Screen } from "../store";

const LABEL: Record<string, string> = { viewer: "Sort", browse: "Browse", albums: "Albums", dupes: "Duplicates" };

/** The same navigation bar on every list screen. H collapses it and the sidebar to a thin strip. */
export function TopNav({ current, children }: { current: Screen; children?: React.ReactNode }) {
  const s = useStore();
  if (s.navCollapsed) {
    return (
      <div className="topnav collapsed">
        <button className="btn sm ghost" onClick={s.toggleNav} title="Show the top bar and sidebar (H)">
          <List /> <span className="label">{LABEL[current]}</span> <kbd className="kbd">H</kbd>
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
      </div>
      <div className="hud-right">
        {children}
        <button className="btn sm ghost" onClick={() => s.set({ settingsOpen: true })} title="Settings (G)">
          <GearSix /> <kbd className="kbd">G</kbd>
        </button>
        <button className="btn sm ghost" onClick={() => s.set({ helpOpen: true })} title="Keys (?)">
          <Question />
        </button>
        <button className="btn sm ghost" onClick={s.toggleNav} title="Hide the top bar and sidebar (H)">
          <CaretUp /> <kbd className="kbd">H</kbd>
        </button>
      </div>
    </div>
  );
}
