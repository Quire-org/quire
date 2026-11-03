import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Modal } from "../components/Modal";
import { formatBytes } from "../lib/format";
import { useEngine } from "../plugins/engine";
import { usePlugins } from "../plugins/store";
import { api, pickFolder } from "../lib/api";
import { advise, fitOn, translatorNeed, type Fit, type Need } from "../lib/modelFit";
import type { Hardware } from "../lib/types";
import type { EngineModel } from "../plugins/types";
import {
  CheckCircle,
  DownloadSimple,
  FolderOpen,
  PuzzlePiece,
  Trash,
  Warning,
} from "@phosphor-icons/react";

const KIND_LABEL: Record<EngineModel["kind"], string> = {
  reader: "Read text in",
  translator: "Language model",
  plugin: "Its own models",
  base: "Shared parts",
  embedder: "Tag suggestions and search",
  tagger: "Tag suggestions",
  cutout: "Scrapbook stickers",
  faces: "People: faces and characters",
};

/** The models the app itself uses, whatever plugins are installed. */
const APP_MODELS = ["siglip2", "pixai", "cutout", "faces", "characters"];
/** Of those, the ones for art and manga only: used when downloaded, of no use for photos. */
const FOR_ART: Record<string, string> = {
  pixai: "names what it sees in anime, manga and art",
  characters: "finds drawn characters in People",
};

/**
 * Settings → Local models: the models the local engine can run, listed under
 * the plugins that use them (a plugin's manifest names its models). Each
 * downloads once, when the user asks for it here; using them never downloads
 * anything. The models live in the app's data folder unless another folder
 * is chosen.
 */
export function LocalModels() {
  const s = useStore();
  const e = useEngine();
  const plugins = usePlugins();
  const [confirmAll, setConfirmAll] = useState(false);
  // This computer's memory and chip, to say which language model suits it (none from an older backend).
  const [hw, setHw] = useState<Hardware | null>(null);
  const c = e.catalog;

  useEffect(() => {
    void useEngine.getState().refresh();
    void api.hardware().then(setHw, () => setHw(null));
  }, []);

  const close = () => s.set({ modelsOpen: false });
  if (!c) {
    return (
      <Modal title="Local models" onClose={close} wide>
        <div className="dim small">Loading…</div>
      </Modal>
    );
  }
  if (!c.available) {
    return (
      <Modal title="Local models" onClose={close} wide>
        <p className="dim small">
          This copy of Quire has no local engine. Build it with{" "}
          <span className="mono">npm run engine</span> in Quire's source
          folder.
        </p>
      </Modal>
    );
  }
  const base = c.models.find((m) => m.kind === "base");
  const busy = !!e.download || c.downloading;
  const byId = new Map(c.models.map((m) => [m.id, m]));
  // Each installed plugin's models, in the catalogue's order; what no plugin names shows only while downloaded.
  const owners = plugins.list
    .filter((p) => p.manifest?.models?.length)
    .map((p) => ({
      plugin: p,
      models: c.models.filter((m) => p.manifest!.models!.includes(m.id)),
    }));
  const own = c.models.filter((m) => APP_MODELS.includes(m.id));
  const claimed = new Set([...APP_MODELS, ...owners.flatMap((o) => o.models.map((m) => m.id))]);
  const orphans = c.models.filter(
    (m) => m.kind !== "base" && !claimed.has(m.id) && m.downloaded,
  );
  const here = s.root ? `${s.root}/.quire/models` : null;
  const where = e.store?.path ?? null;
  const mode = where == null ? "app" : where === here ? "here" : "custom";

  return (
    <Modal title="Local models" onClose={close} wide>
      <p className="dim small">
        Quire and its plugins work on this computer, with the models
        you download here. Each downloads once; after that they work offline,
        and your images are never sent anywhere.
      </p>
      {own.length > 0 && (
        <section>
          <h3>Used by Quire</h3>
          <div className="model-list">
            {own.map((m) => (
              <div key={m.id}>
                <div className="label">
                  {KIND_LABEL[m.kind]}
                  {FOR_ART[m.id] && <span className="faint"> · optional: {FOR_ART[m.id]}</span>}
                </div>
                <ModelRow m={m} />
              </div>
            ))}
          </div>
          <hr className="rule" />
        </section>
      )}
      {owners.length === 0 && (
        <p className="dim small">
          No installed plugin uses local models. The models a plugin uses are
          listed under it here once it is installed.
        </p>
      )}
      {owners.map(({ plugin, models }, i) => (
        <section key={plugin.id}>
          {i > 0 && <hr className="rule" />}
          <h3>
            <PuzzlePiece /> {plugin.manifest!.name}
          </h3>
          {(["reader", "translator", "plugin"] as const)
            .filter((kind) => models.some((m) => m.kind === kind))
            .map((kind) => (
              <div key={kind} className="model-kind">
                <div className="label">{KIND_LABEL[kind]}</div>
                {kind === "reader" && (
                  <p className="dim small">
                    One reader for each language the plugin reads.
                  </p>
                )}
                {kind === "translator" && (
                  <>
                    <p className="dim small">
                      Plugins use the one you choose. Larger models write
                      better, but are slower and need more memory.
                    </p>
                    <Advice models={models.filter((m) => m.kind === "translator")} catalog={c.models} hw={hw} />
                  </>
                )}
                <div className="model-list">
                  {models
                    .filter((m) => m.kind === kind)
                    .map((m) => (
                      <ModelRow
                        key={m.id}
                        m={m}
                        choosable={kind === "translator"}
                        weigh={kind === "translator" ? { need: translatorNeed(m, c.models), hw, best: !!hw && advise(models.filter((x) => x.kind === "translator"), c.models, hw)?.id === m.id } : undefined}
                      />
                    ))}
                </div>
              </div>
            ))}
          {models.map((m) => m.id).filter((id) => !byId.has(id)).length > 0 && (
            <p className="dim small">
              This version of the engine doesn't know some models the plugin
              asks for; update Quire.
            </p>
          )}
        </section>
      ))}
      {orphans.length > 0 && (
        <section>
          <hr className="rule" />
          <h3>Not used by an installed plugin</h3>
          <div className="model-list">
            {orphans.map((m) => (
              <ModelRow key={m.id} m={m} />
            ))}
          </div>
        </section>
      )}

      {base && (
        <p className="dim small">
          {base.downloaded
            ? `Also downloaded: the ${base.name.toLowerCase()} (${sizeOf(base)}), which every reader and language model needs.`
            : `The first reader or language model also brings the ${base.name.toLowerCase()} (${sizeOf(base)}), which every one of them needs.`}
        </p>
      )}

      <hr className="rule" />
      <section>
        <h3>Keep models in</h3>
        <div className="model-store">
          <label className="check side-row">
            <input
              type="radio"
              name="store"
              checked={mode === "app"}
              disabled={busy}
              onChange={() => void e.setStore(null)}
            />{" "}
            The app's data folder{" "}
            <span className="mono dim small ellipsis">{e.store?.default}</span>
          </label>
          <label
            className={`check side-row ${here ? "" : "dim"}`}
            title={here ? undefined : "Open a folder first"}
          >
            <input
              type="radio"
              name="store"
              checked={mode === "here"}
              disabled={busy || !here}
              onChange={() => here && void e.setStore(here)}
            />{" "}
            The opened folder{" "}
            <span className="mono dim small ellipsis">
              {here ?? "(none open)"}
            </span>
          </label>
          <label className="check side-row">
            <input
              type="radio"
              name="store"
              checked={mode === "custom"}
              disabled={busy}
              onChange={() =>
                void pickFolder("Choose where to keep the models").then(
                  (dir) => {
                    if (dir) void e.setStore(dir);
                  },
                )
              }
            />{" "}
            A folder of my choice{" "}
            {mode === "custom" ? (
              <span className="mono dim small ellipsis">{where}</span>
            ) : null}
            <button
              className="btn sm ghost"
              disabled={busy}
              onClick={(ev) => (
                ev.preventDefault(),
                void pickFolder("Choose where to keep the models").then(
                  (dir) => {
                    if (dir) void e.setStore(dir);
                  },
                )
              )}
            >
              <FolderOpen /> Browse…
            </button>
          </label>
          <p className="dim small">
            Models already downloaded stay where they are: download them again
            here, or move the folder's contents yourself.
          </p>
        </div>
      </section>

      <hr className="rule" />
      <section className="row">
        <span className="dim small grow">
          {c.used > 0 && `Using ${formatBytes(c.used)}.`}
          {c.downloading && !e.download && " A download is under way."}
        </span>
        {c.downloading && !e.download && (
          <button
            className="btn sm ghost"
            onClick={() => void e.cancel().then(e.refresh)}
          >
            Stop download
          </button>
        )}
        {confirmAll ? (
          <>
            <button
              className="btn sm danger"
              onClick={() => {
                setConfirmAll(false);
                void e.remove("all");
              }}
            >
              Remove all models
            </button>
            <button
              className="btn sm ghost"
              onClick={() => setConfirmAll(false)}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="btn sm ghost"
            disabled={!c.used || busy}
            onClick={() => setConfirmAll(true)}
            title="Delete every downloaded model"
          >
            <Trash /> Remove all…
          </button>
        )}
      </section>
    </Modal>
  );
}

function sizeOf(m: EngineModel): string {
  return m.size == null ? "size depends on this computer" : formatBytes(m.size);
}

/** This computer, and the language model that suits it. */
function Advice({ models, catalog, hw }: { models: EngineModel[]; catalog: EngineModel[]; hw: Hardware | null }) {
  if (!hw) return null;
  const advice = advise(models, catalog, hw);
  const memory = `${Math.round(hw.memory / 1024 ** 3)} GB of memory`;
  return (
    <p className="small model-advice">
      <strong>{hw.unified ? "This Mac" : "This computer"}:</strong> {hw.chip || "its processor"}, {memory}
      {hw.unified ? " shared with its graphics" : ""}. {advice?.why}
    </p>
  );
}

/** What a language model needs while translating, in memory one buys (or a graphics card's). */
function needText(n: Need, hw: Hardware | null): string {
  const gb = (n.bytes / 1024 ** 3).toFixed(1);
  const memory = n.least === n.comfortable ? `${n.least} GB of memory` : `${n.least} GB of memory, ${n.comfortable} GB to keep other apps open`;
  if (!hw) return `About ${gb} GB while translating: a Mac with Apple silicon and ${memory}, or a graphics card with ${n.card} GB.`;
  if (!hw.unified) return `About ${gb} GB while translating: a graphics card with ${n.card} GB, else the processor, much slower.`;
  return `About ${gb} GB while translating: needs ${memory}.`;
}

const FIT_BADGE: Record<Exclude<Fit, "good">, { cls: string; text: string; title: string }> = {
  tight: { cls: "warn", text: "tight here", title: "It fits with other apps closed; with them open, pages are slow" },
  "too big": { cls: "danger", text: "too big here", title: "It needs more memory than this computer has" },
};

function ModelRow({ m, choosable, weigh }: { m: EngineModel; choosable?: boolean; weigh?: { need: Need; hw: Hardware | null; best: boolean } }) {
  const fit = weigh?.hw ? fitOn(weigh.need, weigh.hw) : null;
  const e = useEngine();
  const c = e.catalog!;
  const [confirm, setConfirm] = useState(false);
  const dl = e.download?.id === m.id ? e.download : null;
  const busy = !!e.download || c.downloading;
  const chosen = !!choosable && c.chosen === m.id;
  const needed = !m.downloaded && e.needed.includes(m.id);
  const pct =
    dl && dl.total
      ? Math.min(100, Math.round((dl.completed / dl.total) * 100))
      : 0;

  return (
    <div
      className={`model-row ${chosen && m.downloaded ? "chosen" : ""} ${needed ? "needed" : ""}`}
    >
      <div className="model-head">
        <label
          className={`model-name grow ${choosable && m.downloaded ? "pick" : ""}`}
          title={
            choosable
              ? m.downloaded
                ? "Use this model"
                : "Download it to use it"
              : undefined
          }
        >
          {choosable && (
            <input
              type="radio"
              name="translator"
              checked={chosen}
              disabled={!m.downloaded}
              onChange={() => void e.choose(m.id)}
            />
          )}
          <span>
            <span>
              <strong>{m.name}</strong>{" "}
              <span className="mono dim small">{sizeOf(m)}</span>
              {chosen && m.downloaded && (
                <span className="badge accent2">in use</span>
              )}
              {needed && (
                <span className="badge accent">
                  <Warning /> needed
                </span>
              )}
              {weigh?.best && (
                <span className="badge accent2" title="The language model that suits this computer best">
                  best here
                </span>
              )}
              {fit && fit !== "good" && (
                <span className={`badge ${FIT_BADGE[fit].cls}`} title={FIT_BADGE[fit].title}>
                  {FIT_BADGE[fit].text}
                </span>
              )}
            </span>
            <span className="dim small model-note">{m.note}</span>
            {weigh && <span className="faint small model-need">{needText(weigh.need, weigh.hw)}</span>}
          </span>
        </label>
        {!dl &&
          (m.downloaded ? (
            confirm ? (
              <>
                <button
                  className="btn sm danger"
                  onClick={() => {
                    setConfirm(false);
                    void e.remove(m.id);
                  }}
                >
                  Remove
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() => setConfirm(false)}
                >
                  Keep
                </button>
              </>
            ) : (
              <>
                <span className="badge ok">
                  <CheckCircle /> downloaded
                </span>
                <button
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={() => setConfirm(true)}
                  title={`Delete ${m.name} from this computer`}
                >
                  <Trash />
                </button>
              </>
            )
          ) : (
            <button
              className="btn sm primary"
              disabled={busy}
              onClick={() => void e.start(m.id)}
              title={busy ? "One download at a time" : undefined}
            >
              <DownloadSimple /> Download
            </button>
          ))}
      </div>
      {dl && (
        <div className="row model-progress">
          <div className="progress grow">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="mono faint small ellipsis">
              {formatBytes(dl.completed)} of {formatBytes(dl.total)}
              {dl.name && ` · ${dl.name}`}
            </div>
          </div>
          <button className="btn sm ghost" onClick={() => void e.cancel()}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
