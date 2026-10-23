import { useEffect } from "react";
import { useStore } from "./store";
import { api } from "./lib/api";

let startupHandled = false;
import { Welcome } from "./screens/Welcome";
import { Viewer } from "./screens/Viewer";
import { Browse } from "./screens/Browse";
import { Dupes } from "./screens/Dupes";
import { Albums } from "./screens/Albums";
import { Drive } from "./screens/Drive";
import { Backup } from "./screens/Backup";
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
  const openRoot = useStore((s) => s.openRoot);

  // Open a folder passed on the command line / MEDIA_SORTER_ROOT, if any.
  useEffect(() => {
    if (startupHandled) return;
    startupHandled = true;
    api.initialRoot().then((r) => { if (r) void openRoot(r); }).catch(() => {});
  }, [openRoot]);

  return (
    <>
      {screen === "welcome" && <Welcome />}
      {screen === "viewer" && <Viewer />}
      {screen === "browse" && <Browse />}
      {screen === "dupes" && <Dupes />}
      {screen === "albums" && <Albums />}
      {driveOpen && <Drive />}
      {backupOpen && <Backup />}
      <ScanPill />
      {settingsOpen && <Settings />}
      {trashOpen && <Trash />}
      {helpOpen && <Help />}
      {loading && screen !== "welcome" && <div className="loading-bar mono">{loading}</div>}
      <Toasts />
    </>
  );
}
