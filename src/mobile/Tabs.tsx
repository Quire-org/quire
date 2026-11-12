import type { ReactNode } from "react";
import { Books, House, MagnifyingGlass, SlidersHorizontal, SquaresFour } from "@phosphor-icons/react";
import { PlatformIcon } from "../components/PlatformIcon";
import { SCREENS } from "../components/TopNav";
import { useFind } from "../findStore";
import { HOME_DEVICE } from "../lib/platform";
import { useFinders } from "../plugins/find";
import { useStore, type Screen } from "../store";
import { COLLECTIONS } from "./TopBar";

/** Which of the collections was last looked at: where a phone's Collections tab goes back to. */
let lastCollection: Screen = "albums";

function Tab({ on, icon, label, go }: { on: boolean; icon: ReactNode; label: string; go: () => void }) {
  return (
    <button className={`m-tab ${on ? "on" : ""}`} aria-current={on ? "page" : undefined} onClick={go}>
      {icon}
      <span className="m-tab-label">{label}</span>
    </button>
  );
}

/** Where to go: along the foot of a phone; down a tablet's side, with each collection and each of Find's platforms listed. */
export function Tabs({ current: screen }: { current: Screen }) {
  const finders = useFinders((f) => f.finders);
  const platformOn = useFind((f) => f.pluginId);
  const st = useStore.getState();
  if (COLLECTIONS.includes(screen)) lastCollection = screen;
  const tabs: { screen: Screen; label: string; icon: ReactNode; go: () => void }[] = [
    { screen: "home", label: "Home", icon: <House />, go: st.openHome },
    { screen: "viewer", label: "Sort", icon: <SlidersHorizontal />, go: st.openSortQueue },
    { screen: "browse", label: "Browse", icon: <SquaresFour />, go: st.openBrowse },
  ];
  const platforms = Object.values(finders);
  return (
    <nav className="m-tabs" aria-label="Screens">
      {tabs.map((t) => (
        <Tab key={t.screen} on={screen === t.screen} icon={t.icon} label={t.label} go={t.go} />
      ))}
      {HOME_DEVICE === "tablet" ? (
        COLLECTIONS.map((c) => <Tab key={c} on={screen === c} icon={SCREENS[c]!.icon} label={SCREENS[c]!.label} go={SCREENS[c]!.go} />)
      ) : (
        <Tab on={COLLECTIONS.includes(screen)} icon={<Books />} label="Collections" go={SCREENS[lastCollection]!.go} />
      )}
      {HOME_DEVICE === "tablet" && platforms.length ? (
        platforms.map((p) => (
          <Tab
            key={p.pluginId}
            on={screen === "find" && platformOn === p.pluginId}
            icon={<PlatformIcon pluginId={p.pluginId} url={p.icon} />}
            label={p.name}
            go={() => {
              useFind.getState().choose(p.pluginId);
              st.openFind();
            }}
          />
        ))
      ) : (
        <Tab on={screen === "find"} icon={<MagnifyingGlass />} label="Find" go={st.openFind} />
      )}
    </nav>
  );
}
