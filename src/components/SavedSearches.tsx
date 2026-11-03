import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { useFind } from "../findStore";
import { useFinders } from "../plugins/find";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { askText } from "./Confirm";
import { PlatformIcon } from "./PlatformIcon";

/**
 * A platform's saved searches, in Find's side panel: each with how many works are new since it was
 * last opened (as last checked), opened with a click; right-click to rename or forget one. Check asks
 * them all again, in Activity.
 */
export function SavedSearches() {
  const f = useFind(useShallow((s) => ({ pluginId: s.pluginId, saved: s.saved, visit: s.visit, checking: s.checking, openSaved: s.openSaved, checkSaved: s.checkSaved, forgetSearch: s.forgetSearch, renameSearch: s.renameSearch })));
  const finder = useFinders((s) => s.finders[f.pluginId!]);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; items: MenuItem[] } | null>(null);
  const mine = f.saved.filter((s) => s.pluginId === f.pluginId);
  if (!finder || !mine.length) return null;
  const iconOf = (site: string | null) => (site ? (finder.sites?.list.find((x) => x.id === site)?.icon ?? null) : null);
  return (
    <>
      <div className="row find-saved-head">
        <span className="label grow">Saved searches</span>
        <button className="btn sm ghost" disabled={f.checking} onClick={() => void f.checkSaved(finder.pluginId, true)} title="Ask each again what is new">
          <ArrowsClockwise className={f.checking ? "spin" : ""} />
        </button>
      </div>
      <div className="side-list">
        {mine.map((s) => (
          <button
            key={s.id}
            className={`btn sm find-saved ${f.visit?.id === s.id ? "active" : ""}`}
            onClick={() => void f.openSaved(s.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                at: { x: e.clientX, y: e.clientY },
                items: [
                  { label: "Open", onClick: () => void f.openSaved(s.id) },
                  {
                    label: "Rename…",
                    onClick: async () => {
                      const name = await askText({ title: "Rename the saved search", message: "What it is called in the list.", confirm: "Rename", initial: s.name });
                      if (name) f.renameSearch(s.id, name);
                    },
                  },
                  { separator: true },
                  { label: "Forget it", danger: true, onClick: () => f.forgetSearch(s.id) },
                ],
              });
            }}
            title={`${s.name}${s.site ? ` on ${s.site}` : ""}${s.checkedAt ? `\nLast checked ${new Date(s.checkedAt).toLocaleString("en-GB")}` : ""}`}
          >
            {s.site && <PlatformIcon pluginId={finder.pluginId} url={iconOf(s.site)} size={14} />}
            <span className="ellipsis grow">{s.name}</span>
            {s.fresh ? (
              <span className="find-new-count" title="New since you last opened it">
                {s.fresh}
                {s.more ? "+" : ""}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <ContextMenu at={menu?.at ?? null} items={menu?.items ?? []} onClose={() => setMenu(null)} />
    </>
  );
}
