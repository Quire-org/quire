import type { ReactNode } from "react";
import { GearSix, List } from "@phosphor-icons/react";
import { ActivityButton } from "../components/Activity";
import { LABEL, SCREENS } from "../components/TopNav";
import { PlatformIcon } from "../components/PlatformIcon";
import { Select } from "../components/Select";
import { useFind } from "../findStore";
import { HOME_DEVICE } from "../lib/platform";
import { useFinders } from "../plugins/find";
import { useStore, type Screen } from "../store";

/** The screens the phone's Collections tab holds (a tablet lists them in its rail). */
export const COLLECTIONS: Screen[] = ["albums", "tags", "artists", "scrapbook"];

function CollectionsSwitch({ current }: { current: Screen }) {
  return (
    <div className="m-collections">
      {COLLECTIONS.map((c) => (
        <button key={c} className={`btn sm ${c === current ? "active" : ""}`} aria-current={c === current ? "page" : undefined} onClick={SCREENS[c]!.go}>
          {SCREENS[c]!.label}
        </button>
      ))}
    </div>
  );
}

/** On a phone, the platform Find shows, chosen here (a tablet lists them in its rail). */
function PlatformSwitch() {
  const finders = useFinders((f) => f.finders);
  const on = useFind((f) => f.pluginId);
  const all = Object.values(finders);
  if (all.length < 2) return <h1 className="m-title">{all[0]?.name ?? LABEL.find}</h1>;
  return <Select value={on ?? ""} title="The platform shown" options={all.map((p) => ({ value: p.pluginId, label: p.name, icon: <PlatformIcon pluginId={p.pluginId} url={p.icon} /> }))} onChange={(id) => useFind.getState().choose(id)} />;
}

/** A screen's head on a phone or tablet: where you are, what it offers, Activity and Settings. */
export function MobileTop({ current, children, bar }: { current: Screen; children?: ReactNode; bar?: ReactNode }) {
  const set = useStore((s) => s.set);
  const onFind = current === "find";
  const inCollections = HOME_DEVICE === "phone" && COLLECTIONS.includes(current);
  return (
    <header className="m-top">
      <div className="m-top-row">
        {onFind && (
          <button className="m-icon" aria-label="Find's sections" onClick={() => useStore.setState((s) => ({ sideCollapsed: !s.sideCollapsed }))}>
            <List />
          </button>
        )}
        {onFind && HOME_DEVICE === "phone" ? <PlatformSwitch /> : <h1 className="m-title">{current === "home" ? "Home" : inCollections ? "Collections" : (LABEL[current] ?? "")}</h1>}
        <span className="grow" />
        {children}
        <ActivityButton />
        <button className="m-icon" aria-label="Settings" onClick={() => set({ settingsOpen: true })}>
          <GearSix />
        </button>
      </div>
      {inCollections && <CollectionsSwitch current={current} />}
      {bar && <div className="m-top-bar">{bar}</div>}
    </header>
  );
}
