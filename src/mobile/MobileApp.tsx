import { useEffect, useRef } from "react";
import { IconContext } from "@phosphor-icons/react";
import { ActivityScreen } from "../components/Activity";
import { ConfirmHost } from "../components/Confirm";
import { FindLogin } from "../components/FindLogin";
import { FindSourceDialog } from "../components/FindSourceDialog";
import { FolderBrowserHost } from "../components/FolderBrowser";
import { ImportDialog } from "../components/ImportDialog";
import { InfoPanel } from "../components/InfoPanel";
import { KeepDialog } from "../components/KeepDialog";
import { PluginHost } from "../components/PluginHost";
import { ScreenGuard } from "../components/ScreenGuard";
import { SeriesAddDialog } from "../components/SeriesAdd";
import { Toasts } from "../components/Toasts";
import { useFind } from "../findStore";
import { api } from "../lib/api";
import { HOME_DEVICE } from "../lib/platform";
import { Find } from "../screens/Find";
import { Home } from "../screens/Home";
import { Settings } from "../screens/Settings";
import { VaultUnlock } from "../screens/VaultUnlock";
import { useStore, type Screen } from "../store";
import { themes } from "../themes";
import { MobileAlbums } from "./Albums";
import { MobileArtists } from "./Artists";
import { MobileBrowse } from "./Browse";
import { useLock, watchApp } from "./lifecycle";
import { MobileLock } from "./Lock";
import { MobileScrapbook } from "./Scrapbook";
import { Tabs } from "./Tabs";
import { MobileTags } from "./Tags";
import { MobileViewer } from "./Viewer";
import { MobileWelcome } from "./Welcome";

let startupHandled = false;

/** The screens a phone or tablet has; a way to any other (a person's name in Info, say) stays where it is. */
const HERE = new Set<Screen>(["welcome", "home", "viewer", "browse", "albums", "tags", "artists", "scrapbook", "find", "activity"]);
/** The screens a picture opened from one lies over: still there, as they were, behind it. */
const UNDER = new Set<Screen>(["browse", "albums", "tags", "artists"]);

/** The library last open, its folder opened again (or, on the simulator, the one given by QUIRE_ROOT). */
async function reopen() {
  const restored = await api.iosRestoreFolder().catch(() => null);
  const root = restored ?? (await api.initialRoot(useStore.getState().recentRoots[0]).catch(() => null));
  if (root) void useStore.getState().openRoot(root);
}

/** The app on a phone or tablet: the same library and stores, its screens made for touch. */
export default function MobileApp() {
  const screen = useStore((s) => s.screen);
  const source = useStore((s) => s.source);
  const hudHidden = useStore((s) => s.hudHidden);
  const viewerBack = useStore((s) => s.viewerBack);
  const pendingRoot = useStore((s) => s.pendingRoot);
  const importOpen = useStore((s) => s.importOpen);
  const settings = useStore((s) => s.settingsOpen || s.trashOpen || s.vaultOpen || s.pluginsOpen);
  const theme = useStore((s) => s.theme);
  const locked = useLock((l) => l.locked);
  const iconWeight = themes.find((t) => t.id === theme)?.iconWeight ?? "regular";

  useEffect(() => watchApp(), []);
  useEffect(() => {
    if (startupHandled) return;
    startupHandled = true;
    void reopen();
  }, []);
  const lastHere = useRef<Screen>("welcome");
  useEffect(() => {
    if (HERE.has(screen)) lastHere.current = screen;
    else {
      useStore.setState({ screen: lastHere.current });
      useStore.getState().toast("That one is on your computer", "warn");
    }
  }, [screen]);
  // Find's side panel is folded away until asked for, and folds away again as a section is picked.
  useEffect(() => {
    if (HOME_DEVICE !== "phone") return;
    useStore.setState({ sideCollapsed: true });
    return useFind.subscribe((f, prev) => {
      if (f.view !== prev.view) useStore.setState({ sideCollapsed: true });
    });
  }, []);

  // Pictures opened from a list come back to that list; the bars give the picture the screen.
  const viewing = screen === "viewer" && (source.kind !== "unsorted" || hudHidden);
  // A picture opened from a list lies over it: the list is still there, as it was, behind it as it is pulled away.
  const under = screen === "viewer" && source.kind !== "unsorted" && UNDER.has(viewerBack) ? viewerBack : null;
  const shown = under ?? screen;
  const showTabs = screen !== "welcome" && (!viewing || !!under);

  return (
    <IconContext.Provider value={{ weight: iconWeight, size: 20, className: "ico" }}>
      <div className={`m-app ${HOME_DEVICE ?? "phone"}`}>
        {showTabs && <Tabs current={shown} />}
        <main className="m-main">
          <ScreenGuard key={shown} screen={shown}>
            {shown === "welcome" && <MobileWelcome />}
            {shown === "home" && <Home />}
            {shown === "viewer" && <MobileViewer />}
            {shown === "browse" && <MobileBrowse />}
            {shown === "albums" && <MobileAlbums />}
            {shown === "tags" && <MobileTags />}
            {shown === "artists" && <MobileArtists />}
            {shown === "scrapbook" && <MobileScrapbook />}
            {shown === "find" && <Find />}
            {shown === "activity" && <ActivityScreen />}
            {under && <MobileViewer over />}
          </ScreenGuard>
        </main>
      </div>
      <ConfirmHost />
      <FolderBrowserHost />
      <PluginHost />
      <KeepDialog />
      <FindSourceDialog />
      <SeriesAddDialog />
      <InfoPanel />
      {pendingRoot && <VaultUnlock />}
      {settings && <Settings />}
      {importOpen && <ImportDialog />}
      <FindLogin />
      <Toasts />
      {locked && <MobileLock />}
    </IconContext.Provider>
  );
}
