import { useEffect } from "react";
import { useStore } from "./store";
import { api } from "./lib/api";

let startupHandled = false;
import { Welcome } from "./screens/Welcome";
import { Viewer } from "./screens/Viewer";
import { Browse } from "./screens/Browse";
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
      {settingsOpen && <Settings />}
      {trashOpen && <Trash />}
      {helpOpen && <Help />}
      {loading && screen !== "welcome" && <div className="loading-bar mono">{loading}</div>}
      <Toasts />
    </>
  );
}
