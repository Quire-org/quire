import { useEffect } from "react";
import { IconContext } from "@phosphor-icons/react";
import { themes } from "./themes";
import { useStore } from "./store";
import { isTypingTarget, dialogOpen } from "./lib/hotkeys";
import { flushAll } from "./lib/pending";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./lib/api";
import { syncAppIcon } from "./lib/appIcon";

let startupHandled = false;
import { Welcome } from "./screens/Welcome";
import { Home } from "./screens/Home";
import { Viewer } from "./screens/Viewer";
import { Browse } from "./screens/Browse";
import { Dupes } from "./screens/Dupes";
import { Albums } from "./screens/Albums";
import { ScreenGuard } from "./components/ScreenGuard";
import { VaultUnlock } from "./screens/VaultUnlock";
import { Files } from "./screens/Files";
import { PluginHost } from "./components/PluginHost";
import { Tags } from "./screens/Tags";
import { Scrapbook } from "./screens/Scrapbook";
import { CoverEditor } from "./screens/CoverEditor";
import { StickerStudio } from "./components/StickerStudio";
import { ImportDialog } from "./components/ImportDialog";
import { CastHost } from "./components/Cast";
import { OrganiseDialog } from "./components/OrganiseDialog";
import { useScrapbook } from "./scrapbook/store";
import { KeepDialog } from "./components/KeepDialog";
import { FindSourceDialog } from "./components/FindSourceDialog";
import { SeriesAddDialog } from "./components/SeriesAdd";
import { InfoPanel } from "./components/InfoPanel";
import { ActivityScreen } from "./components/Activity";
import { Settings } from "./screens/Settings";
import { Help } from "./screens/Help";
import { People } from "./screens/People";
import { Find } from "./screens/Find";
import { Artists } from "./screens/Artists";
import { FindLogin } from "./components/FindLogin";
import { Toasts } from "./components/Toasts";
import { ConfirmHost } from "./components/Confirm";
import { FolderBrowserHost } from "./components/FolderBrowser";
import { listenForSounds } from "./lib/sounds";
import { listen } from "@tauri-apps/api/event";
import { useUpdates } from "./lib/updates";

export default function App() {
  const screen = useStore((s) => s.screen);
  const studio = useScrapbook((s) => s.studio);
  const loading = useStore((s) => s.loading);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const trashOpen = useStore((s) => s.trashOpen);
  const helpOpen = useStore((s) => s.helpOpen);
  const importOpen = useStore((s) => s.importOpen);
  const organiseOpen = useStore((s) => s.organiseOpen);
  const driveOpen = useStore((s) => s.driveOpen);
  const backupOpen = useStore((s) => s.backupOpen);
  const vaultOpen = useStore((s) => s.vaultOpen);
  const pluginsOpen = useStore((s) => s.pluginsOpen);
  const modelsOpen = useStore((s) => s.modelsOpen);
  const updatesOpen = useStore((s) => s.updatesOpen);
  const pendingRoot = useStore((s) => s.pendingRoot);
  const theme = useStore((s) => s.theme);
  const mode = useStore((s) => s.mode);
  const iconWeight = themes.find((t) => t.id === theme)?.iconWeight ?? "regular";
  const openRoot = useStore((s) => s.openRoot);

  // Faces looked for by themselves, after the tag index (People).
  useEffect(() => {
    void import("./peopleStore").then(({ watchForFaces }) => watchForFaces());
  }, []);

  // Menu entries chosen and switches flipped anywhere, heard when sounds are on.
  useEffect(() => listenForSounds(), []);

  // The Dock / taskbar icon follows the theme, in its light or dark, while the app runs.
  useEffect(() => {
    void syncAppIcon();
  }, [theme, mode]);

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

  // The window closing: what the stores still have to write (a rating a moment ago) is written first,
  // then the boards' windows and the window go (destroyed: closing it again would only ask this again).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let closing = false;
    void getCurrentWindow()
      .onCloseRequested(async (e) => {
        e.preventDefault();
        if (closing) return;
        closing = true;
        await flushAll().catch(() => {});
        await import("@tauri-apps/api/webviewWindow")
          .then(async ({ getAllWebviewWindows }) => Promise.all((await getAllWebviewWindows()).filter((w) => w.label.startsWith("board-")).map((w) => w.destroy())))
          .catch(() => {});
        await getCurrentWindow()
          .destroy()
          .catch((err) => {
            closing = false;
            useStore.getState().toast(`The window couldn't close: ${String(err)}`, "error");
          });
      })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, []);

  // ⇧H: the library's Home, from any screen (ahead of each screen's own H).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "h" || isTypingTarget(e.target)) return;
      const st = useStore.getState();
      if (!st.root || st.screen === "welcome" || dialogOpen()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      st.openHome();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // This build's version, for Settings › Updates. Updates are looked for when a library that asks for
  // it opens (see lib/librarySettings).
  useEffect(() => void useUpdates.getState().loadBuild(), []);

  // A change in an open vault went through, but the vault's list of its files couldn't be written
  // (the backend tries again with the next change): said, not kept quiet.
  useEffect(() => {
    const off = listen<string>("vault-unsaved", (e) => useStore.getState().toast(`The vault's list of files couldn't be saved (${e.payload}). It is tried again with your next change.`, "error"));
    return () => void off.then((f) => f());
  }, []);

  // Open a folder passed on the command line / QUIRE_ROOT, else the library open last time
  // when its drive is there; else the Welcome card stays.
  useEffect(() => {
    if (startupHandled) return;
    startupHandled = true;
    api.initialRoot(useStore.getState().recentRoots[0]).then((r) => { if (r) void openRoot(r); }).catch(() => {});
  }, [openRoot]);

  return (
    <IconContext.Provider value={{ weight: iconWeight, size: 16, className: "ico" }}>
      <ScreenGuard key={screen} screen={screen}>
        {screen === "welcome" && <Welcome />}
        {screen === "home" && <Home />}
        {screen === "viewer" && <Viewer />}
        {screen === "browse" && <Browse />}
        {screen === "dupes" && <Dupes />}
        {screen === "albums" && <Albums />}
        {screen === "files" && <Files />}
        {screen === "tags" && <Tags />}
        {screen === "people" && <People />}
        {screen === "artists" && <Artists />}
        {screen === "find" && <Find />}
        {screen === "activity" && <ActivityScreen />}
        {screen === "scrapbook" && <Scrapbook />}
        {screen === "cover" && <CoverEditor />}
      </ScreenGuard>
      {studio && <StickerStudio key={studio.sticker?.id ?? studio.item?.key ?? "pick"} />}
      <ConfirmHost />
      <FolderBrowserHost />
      <PluginHost />
      <KeepDialog />
      <FindSourceDialog />
      <SeriesAddDialog />
      {/* The viewer has its own, docked between its bars. */}
      <InfoPanel />
      {pendingRoot && <VaultUnlock />}
      {/* Trash, Drive health, Backup, Vault, Plugins, Local models and Updates are pages of Settings. */}
      {(settingsOpen || trashOpen || driveOpen || backupOpen || vaultOpen || pluginsOpen || modelsOpen || updatesOpen) && <Settings />}
      {helpOpen && <Help />}
      {organiseOpen && <OrganiseDialog />}
      {importOpen && <ImportDialog />}
      <FindLogin />
      <CastHost />
      {loading && screen !== "welcome" && <div className="loading-bar mono">{loading}</div>}
      <Toasts />
    </IconContext.Provider>
  );
}
