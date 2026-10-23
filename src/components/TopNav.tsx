import { useStore, type Screen } from "../store";

/** The same navigation bar on every list screen (Browse, Albums, Duplicates). */
export function TopNav({ current, children }: { current: Screen; children?: React.ReactNode }) {
  const s = useStore();
  const tab = (id: Screen, label: string, key: string, go: () => void) => (
    <button className={`btn sm ${current === id ? "active" : ""}`} onClick={go} title={`${label} (${key})`}>
      {label} <kbd className="kbd">{key}</kbd>
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
        {tab("viewer", "Sort", "Esc", s.openSortQueue)}
        {tab("browse", "Browse", "B", s.openBrowse)}
        {tab("albums", "Albums", "A", s.openAlbums)}
        {tab("dupes", "Duplicates", "D", s.openDupes)}
      </div>
      <div className="hud-right">
        {children}
        <button className="btn sm ghost" onClick={() => void s.surprise()} title="Surprise me (R)">
          ✦ <kbd className="kbd">R</kbd>
        </button>
        <button className="btn sm ghost" onClick={() => s.set({ backupOpen: true })} title="Back this folder up">
          Backup
        </button>
        <button className="btn sm" onClick={() => s.set({ settingsOpen: true })} title="Settings (G)">
          Settings <kbd className="kbd">G</kbd>
        </button>
        <button className="btn sm ghost" onClick={() => s.set({ helpOpen: true })} title="Keys (?)">
          ?
        </button>
      </div>
    </div>
  );
}
