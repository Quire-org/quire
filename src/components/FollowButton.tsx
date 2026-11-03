import { useEffect, useState } from "react";
import { CaretDown, Check, CircleNotch, Plus } from "@phosphor-icons/react";
import { Popover } from "./Popover";
import { finder, useFinders } from "../plugins/find";
import { useStore } from "../store";

/**
 * Follow an artist on their platform, or stop: Follow follows publicly, its menu privately (only you
 * see it); Following, pointed at, says Unfollow. Shown only where the platform's plugin can follow.
 * Without `followed` known, the platform is asked once. `site`: on that one of a platform's several
 * sites (else the one shown).
 */
export function FollowButton({ pluginId, artistId, name, followed, onChange, site }: { pluginId: string; artistId: string; name: string; followed?: boolean; onChange?: (followed: boolean) => void; site?: string }) {
  const can = useFinders((s) => !!s.finders[pluginId]?.follows);
  const [now, setNow] = useState<boolean | null>(followed ?? null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (followed !== undefined) return setNow(followed);
    if (!can) return;
    let live = true;
    finder.artist(pluginId, { id: artistId, ...(site ? { site } : {}) }).then(
      (a) => live && setNow(a.followed),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [pluginId, artistId, followed, can, site]);
  if (!can || now === null) return null;

  const set = async (follow: boolean, only = false) => {
    setMenu(false);
    setBusy(true);
    try {
      const is = await finder.follow(pluginId, { id: artistId, follow, private: only, ...(site ? { site } : {}) });
      setNow(is);
      onChange?.(is);
      useStore.getState().toast(is ? `Following ${name}${only ? " privately" : ""}` : `Not following ${name} any more`, "ok");
    } catch (e) {
      useStore.getState().toast(String(e).replace(/^Error: /, ""), "error");
    } finally {
      setBusy(false);
    }
  };

  if (now)
    return (
      <button className="btn sm follow-btn following" disabled={busy} onClick={() => void set(false)} title={`Stop following ${name}`}>
        {busy ? <CircleNotch className="spin" /> : <Check />}
        <span className="follow-is">Following</span>
        <span className="follow-stop">Unfollow</span>
      </button>
    );
  return (
    <span className="btn-group follow-btn">
      <button className="btn sm primary" disabled={busy} onClick={() => void set(true)} title={`Follow ${name}`}>
        {busy ? <CircleNotch className="spin" /> : <Plus />} Follow
      </button>
      <Popover
        open={menu}
        onClose={() => setMenu(false)}
        width={220}
        trigger={
          <button className="btn sm primary caret" disabled={busy} onClick={() => setMenu(!menu)} title="Follow privately">
            <CaretDown />
          </button>
        }
      >
        <div className="pop-list">
          <button className="btn sm ghost" onClick={() => void set(true, true)}>
            Follow privately
          </button>
        </div>
        <div className="small dim">Only you see that you follow them.</div>
      </Popover>
    </span>
  );
}
