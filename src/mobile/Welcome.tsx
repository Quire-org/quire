import { pickFolder } from "../lib/api";
import { useStore } from "../store";

/** Before a library is open: choosing its folder on the drive plugged in. */
export function MobileWelcome() {
  const openRoot = useStore((s) => s.openRoot);
  const loading = useStore((s) => s.loading);
  const pick = async () => {
    const dir = await pickFolder("Choose your library").catch((e) => {
      useStore.getState().toast(String(e), "error");
      return null;
    });
    if (dir) void openRoot(dir);
  };
  return (
    <div className="m-welcome">
      <h1 className="brand">QUIRE</h1>
      <p className="dim">Plug in your library's drive, then choose its folder. Your ratings, tags and vault stay on the drive.</p>
      {loading ? <div className="mono accent-text">{loading}</div> : <button className="btn primary" onClick={() => void pick()}>Choose library folder</button>}
    </div>
  );
}
