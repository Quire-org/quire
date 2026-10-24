import { useEffect } from "react";
import { IconContext } from "@phosphor-icons/react";
import { themes } from "./themes";
import { useStore } from "./store";
import { api } from "./lib/api";
import { syncAppIcon } from "./lib/appIcon";

let startupHandled = false;
import { Welcome } from "./screens/Welcome";
import { Viewer } from "./screens/Viewer";
import { Browse } from "./screens/Browse";
import { Dupes } from "./screens/Dupes";
import { Albums } from "./screens/Albums";
import { Drive } from "./screens/Drive";
import { Backup } from "./screens/Backup";
import { VaultDialog } from "./screens/VaultDialog";
import { VaultUnlock } from "./screens/VaultUnlock";
import { Files } from "./screens/Files";
import { ScanPill } from "./components/ScanPill";
import { Settings } from "./screens/Settings";
import { Trash } from "./screens/Trash";
import { Help } from "./screens/Help";
import { Toasts } from "./components/Toasts";

export default function App() {
  const screen = useStore((s) => s.screen);
  const loading = useStore((s) => s.loading);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const trashOpen = useStore((s) => s.trashOpen);
  const helpOpen = useStore((s) => s.helpOpen);
  const driveOpen = useStore((s) => s.driveOpen);
  const backupOpen = useStore((s) => s.backupOpen);
  const vaultOpen = useStore((s) => s.vaultOpen);
  const pendingRoot = useStore((s) => s.pendingRoot);
  const theme = useStore((s) => s.theme);
  const iconWeight = themes.find((t) => t.id === theme)?.iconWeight ?? "regular";
  const openRoot = useStore((s) => s.openRoot);

  // The Dock / taskbar icon follows the theme while the app runs.
  useEffect(() => {
    void syncAppIcon();
  }, [theme]);

  // Key hints on buttons are hidden; holding ⌘ (or Ctrl) reveals them.
  useEffect(() => {
    const root = document.documentElement;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") root.classList.add("show-keys");
    };
    const off = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") root.classList.remove("show-keys");
    };
    const clear = () => root.classList.remove("show-keys");
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", off);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", off);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // Open a folder passed on the command line / MEDIA_SORTER_ROOT, if any.
  useEffect(() => {
    if (startupHandled) return;
    startupHandled = true;
    api.initialRoot().then((r) => { if (r) void openRoot(r); }).catch(() => {});
  }, [openRoot]);

  return (
    <IconContext.Provider value={{ weight: iconWeight, size: 16, className: "ico" }}>
      {screen === "welcome" && <Welcome />}
      {screen === "viewer" && <Viewer />}
      {screen === "browse" && <Browse />}
      {screen === "dupes" && <Dupes />}
      {screen === "albums" && <Albums />}
      {screen === "files" && <Files />}
      {driveOpen && <Drive />}
      {backupOpen && <Backup />}
      {vaultOpen && <VaultDialog />}
      {pendingRoot && <VaultUnlock />}
      <ScanPill />
      {settingsOpen && <Settings />}
      {trashOpen && <Trash />}
      {helpOpen && <Help />}
      {loading && screen !== "welcome" && <div className="loading-bar mono">{loading}</div>}
      <Toasts />
    </IconContext.Provider>
  );
}
