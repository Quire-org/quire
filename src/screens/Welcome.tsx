import { useStore } from "../store";
import { pickFolder } from "../lib/api";
import { Deco } from "../components/Deco";

export function Welcome() {
  const openRoot = useStore((s) => s.openRoot);
  const recent = useStore((s) => s.recentRoots);
  const loading = useStore((s) => s.loading);

  const pick = async () => {
    const dir = await pickFolder("Choose a folder with your media");
    if (dir) void openRoot(dir);
  };

  return (
    <div className="welcome">
      <div className="welcome-card panel">
        <Deco kind="plant" className="deco-corner" />
        <div className="label">Quire // v0.1</div>
        <h1 className="brand glitch" data-text="QUIRE">
          QUIRE
        </h1>
        <p className="dim">
          Point it at any folder: an SD card, an external drive or a folder on this machine. Ratings and target
          folders are stored in a single <span className="mono">.quire.json</span> next to your files;
          nothing is kept inside the app.
        </p>
        {loading ? (
          <div className="mono accent-text">{loading}</div>
        ) : (
          <button className="btn primary" onClick={pick}>
            Open folder
          </button>
        )}
        {recent.length > 0 && !loading && (
          <>
            <hr className="rule" />
            <div className="label">Recent</div>
            <ul className="recent">
              {recent.map((r) => (
                <li key={r}>
                  <button className="btn ghost sm mono" onClick={() => void openRoot(r)}>
                    {r}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
