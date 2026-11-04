import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../store";
import { api } from "../lib/api";
import { notForAlbums, notForTarget, pickLibraryFolder } from "../components/FolderBrowser";
import { AsPage } from "../components/Modal";
import { OptionRow } from "../components/OptionRow";
import { themes } from "../themes";
import { ModePicker, ThemeSwatch } from "../components/ThemeSwatch";
import { Select } from "../components/Select";
import { useHome } from "../home/store";
import type { HomeDoc } from "../home/board";
import { RESERVED_KEYS } from "../lib/hotkeys";
import { bucketOf } from "../lib/filing";
import { CUES, cue, useSounds } from "../lib/sounds";
import { formatBytes, tailPath } from "../lib/format";
import { ArrowCircleUp, ArrowsClockwise, Plugs, SpeakerHigh, BookOpen, CloudArrowUp, Cpu, Eye, FolderMinus, FolderOpen, FolderPlus, Folders, HardDrive, LockKey, MagnifyingGlass, PuzzlePiece, Smiley, Tray, Trash as TrashIcon, X } from "@phosphor-icons/react";
import { usePeople } from "../peopleStore";
import { useOnline } from "../lib/online";
import { useFinders } from "../plugins/find";
import type { TrashInfo } from "../lib/types";
import { Trash } from "./Trash";
import { Drive } from "./Drive";
import { Backup } from "./Backup";
import { VaultDialog } from "./VaultDialog";
import { FIX_PLACES, type Fix } from "../scrapbook/model";
import { PluginsDialog } from "./PluginsDialog";
import { LocalModels } from "./LocalModels";
import { Updates } from "./Updates";
import { useUpdateCount } from "../lib/updates";

type Page = "folders" | "import" | "trash" | "viewing" | "faces" | "plugins" | "online" | "models" | "backup" | "drive" | "vault" | "updates";
type Flag = "trashOpen" | "pluginsOpen" | "modelsOpen" | "backupOpen" | "driveOpen" | "vaultOpen" | "updatesOpen";

/** Pages that were dialogs of their own: still opened by their flag (from anywhere in the app), shown here. */
const FLAGS: [Page, Flag][] = [
  ["trash", "trashOpen"],
  ["plugins", "pluginsOpen"],
  ["models", "modelsOpen"],
  ["backup", "backupOpen"],
  ["drive", "driveOpen"],
  ["vault", "vaultOpen"],
  ["updates", "updatesOpen"],
];
const NONE = Object.fromEntries(FLAGS.map(([, f]) => [f, false])) as Record<Flag, false>;

/** The pages, in their groups, with the words that find each one. */
const GROUPS: { label: string; pages: { id: Page; label: string; icon: ReactNode; words: string }[] }[] = [
  {
    label: "Library",
    pages: [
      { id: "folders", label: "Folders", icon: <Folders />, words: "target folders hotkeys album folders sort" },
      { id: "import", label: "Bringing in", icon: <Tray />, words: "import organise card phone buckets duplicates" },
      { id: "trash", label: "Trash", icon: <TrashIcon />, words: "deleted restore empty" },
    ],
  },
  { label: "Viewing", pages: [{ id: "viewing", label: "Look and reading", icon: <Eye />, words: "theme image fit fill crop page turns albums animation series together burst opens on home sort where you were start sound sounds audio volume click menu" }] },
  { label: "People", pages: [{ id: "faces", label: "Faces", icon: <Smiley />, words: "people face scan leave out folders" }] },
  {
    label: "Add-ons",
    pages: [
      { id: "plugins", label: "Plugins", icon: <PuzzlePiece />, words: "install extensions github" },
      { id: "online", label: "Going online", icon: <Plugs />, words: "internet network offline mobile data wifi connect ask find platforms" },
      { id: "models", label: "Local models", icon: <Cpu />, words: "download models engine tagger" },
    ],
  },
  {
    label: "Safety",
    pages: [
      { id: "backup", label: "Backup", icon: <CloudArrowUp />, words: "copy drive" },
      { id: "drive", label: "Drive health", icon: <HardDrive />, words: "disk smart check" },
      { id: "vault", label: "Vault", icon: <LockKey />, words: "encrypt passphrase lock" },
    ],
  },
  { label: "App", pages: [{ id: "updates", label: "Updates", icon: <ArrowCircleUp />, words: "update version new release download restart check plugins extensions github" }] },
];

/**
 * Settings: a screen of its own, the topics listed on the left (found by typing), one page each on
 * the right. Trash, Plugins, Local models, Backup, Drive health, Vault and Updates are pages here too, opened
 * from anywhere in the app by their own flag. Esc closes it.
 */
export function Settings() {
  const s = useStore();
  const flagged = FLAGS.find(([, f]) => s[f])?.[0];
  const [own, setOwn] = useState<Page>("folders");
  const page = flagged ?? own;
  const [q, setQ] = useState("");
  const updateCount = useUpdateCount();
  const close = () => s.set({ settingsOpen: false, ...NONE });
  const go = (p: Page) => {
    const flag = FLAGS.find(([x]) => x === p)?.[1];
    s.set({ settingsOpen: true, ...NONE, ...(flag ? { [flag]: true } : {}) });
    if (!flag) setOwn(p);
  };

  // Open as Settings whichever way it was opened, so the screens behind leave their keys alone.
  useEffect(() => {
    if (!useStore.getState().settingsOpen) useStore.getState().set({ settingsOpen: true });
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      useStore.getState().set({ settingsOpen: false, ...NONE });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const needle = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({ ...g, pages: g.pages.filter((p) => !needle || `${g.label} ${p.label} ${p.words}`.toLowerCase().includes(needle)) })).filter((g) => g.pages.length);
  const title = GROUPS.flatMap((g) => g.pages).find((p) => p.id === page)?.label ?? "";

  return (
    <div className="settings-screen" role="dialog" aria-label="Settings">
      <aside className="settings-nav">
        <h2 className="settings-nav-head">Settings</h2>
        <label className="settings-find">
          <MagnifyingGlass />
          <input
            className="input"
            placeholder="Find a setting"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && groups[0]) go(groups[0].pages[0].id);
              if (e.key === "Escape") q ? setQ("") : close();
            }}
          />
        </label>
        <nav className="settings-list">
          {groups.map((g) => (
            <div key={g.label} className="settings-group">
              <div className="label">{g.label}</div>
              {g.pages.map((p) => (
                <button key={p.id} className={`btn sm ${page === p.id ? "active" : "ghost"}`} onClick={() => go(p.id)}>
                  {p.icon} {p.label}
                  {p.id === "updates" && updateCount > 0 && <span className="update-dot" aria-label={`${updateCount} waiting`} />}
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <div className="dim small">No setting is called that.</div>}
        </nav>
        <div className="settings-folder">
          <span className="faint mono small ellipsis" title={s.root ?? ""}>
            {s.root ? tailPath(s.root, 2) : ""}
          </span>
          <div className="row">
            <button className="btn sm" onClick={() => void s.rescan()} title="Read the folder again">
              <ArrowsClockwise /> Rescan
            </button>
            <button className="btn sm ghost" onClick={s.closeRoot}>
              Close folder
            </button>
          </div>
        </div>
      </aside>
      <button className="btn sm ghost settings-close" onClick={close} title="Close (Esc)">
        <X /> <kbd className="kbd">Esc</kbd>
      </button>
      <main className="settings-page">
        <h1>{title}</h1>
        <AsPage.Provider value={true}>
          {page === "folders" && <FoldersPage />}
          {page === "import" && <ImportPage />}
          {page === "trash" && <TrashPage />}
          {page === "viewing" && <ViewingPage />}
          {page === "faces" && <FacesPage />}
          {page === "plugins" && <PluginsDialog />}
          {page === "online" && <OnlinePage />}
          {page === "models" && <LocalModels />}
          {page === "backup" && <Backup />}
          {page === "drive" && <Drive />}
          {page === "vault" && <VaultDialog />}
          {page === "updates" && <Updates />}
        </AsPage.Provider>
      </main>
    </div>
  );
}

function FoldersPage() {
  const s = useStore();
  const targets = s.library?.targets ?? [];
  const add = async () => {
    const dir = await pickLibraryFolder({ title: "Choose a target folder", start: s.lastTargetParent ?? s.root, outside: true, why: notForTarget(s.library, s.root ?? "") });
    if (dir) s.addTarget(dir);
  };
  const addAlbumRoot = async () => {
    const dir = await pickLibraryFolder({ title: "Choose a folder whose subfolders are albums", outside: true, why: notForAlbums(s.library, s.root ?? "") });
    if (dir) s.addAlbumRoot(dir);
  };
  const setHotkey = (id: string, raw: string) => {
    const k = raw.trim().toLowerCase().slice(-1);
    if (k && RESERVED_KEYS.has(k)) {
      s.toast(`"${k}" is reserved by the viewer`, "warn");
      return;
    }
    if (k && targets.some((t) => t.id !== id && t.hotkey === k)) {
      s.toast(`"${k}" is already used`, "warn");
      return;
    }
    s.updateTarget(id, { hotkey: k });
  };
  return (
    <>
      <section>
        <div className="sec-head">
          <h3>Target folders</h3>
          <button className="btn primary sm" onClick={() => void add()}>
            <FolderPlus /> Add folder
          </button>
        </div>
        {targets.length === 0 && <p className="dim">Add the folders you want to sort into. Each gets a hotkey.</p>}
        <div className="target-list">
          {targets.map((t) => (
            <div key={t.id} className="target-row">
              <input className="input hot" value={t.hotkey} maxLength={1} onChange={(e) => setHotkey(t.id, e.target.value)} title="Hotkey" />
              <input className="input name" value={t.name} onChange={(e) => s.updateTarget(t.id, { name: e.target.value })} title="Display name" />
              <span className="mono faint path" title={t.path}>
                {tailPath(t.path, 3)}
              </span>
              {RESERVED_KEYS.has(t.hotkey.toLowerCase()) ? (
                <span className="small warn-text" title="The viewer's own key wins, so this one moves nothing">
                  {t.hotkey.toUpperCase()} is the viewer's: choose another key
                </span>
              ) : (
                <span className="small faint" title={bucketOf(t, targets) ? "Filed by the year and day it goes in, in this folder or a folder of yours in it (⇧ and its key)" : undefined}>
                  {bucketOf(t, targets) ? "by the day" : ""}
                </span>
              )}
              <button className="btn sm danger" onClick={() => s.removeTarget(t.id)} title="Remove (files stay where they are)">
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>
      <hr className="rule" />
      <section>
        <div className="sec-head">
          <h3>Album folders</h3>
          <button className="btn sm" onClick={() => void addAlbumRoot()}>
            + Add album folder
          </button>
        </div>
        <p className="dim small">Each subfolder of an album folder is an album: kept out of the grid and the queue, rated and moved as a whole.</p>
        <div className="target-list">
          {(s.library?.albumRoots ?? []).map((r) => (
            <div key={r} className="side-row">
              <span className="mono faint small ellipsis grow" title={r}>
                {r}
              </span>
              <button className="btn sm danger" onClick={() => s.removeAlbumRoot(r)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** A page with only a choice or two: big cards in the middle of the page's room. */
function Cards({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="settings-cards-page">
      <div className="settings-cards">{children}</div>
      {note && <p className="faint small">{note}</p>}
    </div>
  );
}

function Card({ icon, title, text, primary, onClick }: { icon: ReactNode; title: string; text: string; primary?: boolean; onClick: () => void }) {
  return (
    <button className={`settings-card ${primary ? "primary" : ""}`} onClick={onClick}>
      <span className="settings-card-icon">{icon}</span>
      <b>{title}</b>
      <span className="dim small">{text}</span>
    </button>
  );
}

function ImportPage() {
  const s = useStore();
  return (
    <Cards note="Import is in Files too.">
      <Card primary icon={<Tray />} title="Import…" text="From a card, a phone or any folder: into a bucket (an event, or the day's folder) or as an album. Exact duplicates are checked first." onClick={() => s.set({ settingsOpen: false, importOpen: {} })} />
      <Card icon={<FolderOpen />} title="Organise what's here…" text="Your folders as they are now, into buckets: each kept whole, or imported picture by picture." onClick={() => s.set({ settingsOpen: false, organiseOpen: true })} />
    </Cards>
  );
}

function TrashPage() {
  const s = useStore();
  const [trash, setTrash] = useState<TrashInfo | null>(null);
  useEffect(() => {
    if (s.root && s.library) api.trashInfo(s.root, s.library).then(setTrash).catch(() => {});
  }, [s.root, s.library]);
  return (
    <>
      <p className="dim">
        Deleted items go to <span className="mono">{s.library?.trashDir}</span> inside the opened folder.
        {trash && (
          <>
            {" "}
            Now <span className="mono">{trash.files}</span> files, <span className="mono">{formatBytes(trash.bytes)}</span>.
          </>
        )}
      </p>
      <Trash />
    </>
  );
}

/** Asking before going online (lib/online.ts): kept with the library (lib/librarySettings), as the other settings are. */
function OnlinePage() {
  const o = useOnline();
  const finders = useFinders((f) => f.finders);
  const names = o.connected.platforms.map((id) => finders[id]?.name ?? id);
  const status = !o.settings.ask ? "Extensions go online whenever they need to." : o.connected.all ? "Connected: every platform." : names.length ? `Connected: ${names.join(", ")}.` : "Not connected: nothing goes online until you press Connect.";
  return (
    <>
      <p className="dim">{status}</p>
      <section className="settings-options">
        <OptionRow
          title="Ask before going online"
          info="On, nothing an extension fetches goes out until you press Connect: Find's searches, works and pictures, artists' pages on their platforms, the basket's pictures, saved searches checked for what is new, and extensions' own requests in the background. Where those would show, a Connect button stands instead. For mobile data or a public Wi-Fi. Kept with this library."
          toggle={{ on: o.settings.ask, label: o.settings.ask ? "Asks" : "Off", onChange: (on) => o.set({ ask: on }) }}
        />
        {o.settings.ask && (
          <>
            <OptionRow
              title="Each platform on its own"
              info="On, Connect lets one platform go online and the others keep waiting. Off, one Connect is for all of them."
              toggle={{ on: o.settings.each, label: o.settings.each ? "Each" : "All at once", onChange: (on) => o.set({ each: on }) }}
            />
            <OptionRow
              title="Stay connected"
              info="Off, a connection lasts until the app closes, and the next start asks again. On, it lasts until you press Disconnect, across starts."
              toggle={{ on: o.settings.keep, label: o.settings.keep ? "Until Disconnect" : "Until the app closes", onChange: (on) => o.set({ keep: on }) }}
            />
            <OptionRow title="Disconnect now" info="Ends the connection: what goes online waits for Connect again." action={{ label: "Disconnect", onClick: o.disconnect, disabled: !o.connected.all && !o.connected.platforms.length }} />
          </>
        )}
      </section>
    </>
  );
}

function ViewingPage() {
  const s = useStore();
  const opensOn = useHome((h) => h.doc?.opensOn);
  return (
    <>
      <section>
        <h3>Theme</h3>
        <div className="theme-list">
          {themes.map((t) => (
            <ThemeSwatch key={t.id} theme={t} mode={s.mode} active={s.theme === t.id} onPick={s.setTheme} />
          ))}
        </div>
        <div className="theme-mode">
          <span className="dim">Each theme has a light and a dark side.</span>
          <ModePicker mode={s.themeMode} onPick={s.setThemeMode} />
        </div>
      </section>
      <hr className="rule" />
      <section className="settings-options">
        {opensOn && (
          <OptionRow
            title="The library opens on"
            info="Where you land when this library opens: its Home, Sort, or the list screen you last left (Browse, Albums, People and the like). Kept with the library, like its Home."
            control={
              <Select
                compact
                value={opensOn}
                onChange={(v) => useHome.getState().setOpensOn(v as HomeDoc["opensOn"])}
                options={[
                  { value: "home", label: "Home" },
                  { value: "sort", label: "Sort" },
                  { value: "last", label: "Where you were" },
                ]}
              />
            }
          />
        )}
        <OptionRow title="Pictures fill the screen" info="Off, the whole picture shows. On, it covers the screen and may be cropped at its edges. X switches it in the viewer." toggle={{ on: s.fitMode === "fill", label: s.fitMode === "fill" ? "Fill" : "Fit", onChange: () => s.toggleFit() }} />
        <OptionRow
          title="Page turns in albums"
          info={
            <>
              <BookOpen /> An album's pages turn as the theme's sticker book turns its own: a paper leaf, or a swipe in Night City. Forward goes the album's reading way, and turns asked for quickly go quicker.
            </>
          }
          toggle={{ on: s.pageTurns, label: s.pageTurns ? "On" : "Off", onChange: (on) => s.setPageTurns(on) }}
        />
        <SoundRows />
        <OptionRow
          title="Keep series together"
          info="A series is a few pictures alike that you keep all of: a burst, glasses on and off, an artist's variations. Together, it is one tile in Browse, comes up whole in Sort and the viewer, and one target key files all of it. Apart, each picture comes on its own. Sort suggests series as you go, and Duplicates can keep a group as one."
          toggle={{ on: s.seriesTogether, label: s.seriesTogether ? "Together" : "Apart", onChange: (on) => s.setSeriesTogether(on) }}
        />
        <OptionRow
          title="Pictures on boards"
          info="A picture of the library put on a Scrapbook board. A copy stays on the board whatever becomes of the picture, so you can keep only the board; pointing at the picture takes no room, follows it when it moves, and leaves a gap if it goes."
          toggle={{ on: s.boardPictures === "copy", label: s.boardPictures === "copy" ? "Keep a copy" : "Point at it", onChange: (on) => s.setBoardPictures(on ? "copy" : "link") }}
        />
        <OptionRow
          title="Held up on boards"
          info="How a new photo or note on a Scrapbook board is held up: pinned or taped, and where. Each one can be changed on its own afterwards."
          control={
            <Select
              compact
              value={s.boardFix ? `${s.boardFix.kind}:${s.boardFix.where}` : "none"}
              options={[{ value: "none", label: "Neither" }, ...(["pin", "tape"] as const).flatMap((kind) => FIX_PLACES.map((p) => ({ value: `${kind}:${p.id}`, label: `${kind === "pin" ? "Pinned" : "Taped"} · ${p.name.toLowerCase()}` })))]}
              onChange={(v) => s.setBoardFix(v === "none" ? null : { kind: v.split(":")[0] as Fix["kind"], where: v.split(":")[1] as Fix["where"] })}
            />
          }
        />
      </section>
    </>
  );
}

/** The app's sounds: menus' and sorting's, each on by itself, and how loud. */
function SoundRows() {
  const sounds = useSounds();
  const anyOn = sounds.menus || sounds.sorting;
  return (
    <>
      <OptionRow
        title="Menu sounds"
        info="A button pressed, a menu, list or dialog opening and closing, a switch flipped, something going wrong: quiet and low, a touch rather than a sound to notice. Each theme has its own: Night City muted synth, Midnight slow sweeps and a low chime, Cozy drops of water, Sunset rounded tones, Manga paper, Gallery and Ghost almost nothing. The sounds are Kenney's Interface Sounds (CC0), played lower and softened."
        toggle={{ on: sounds.menus, label: sounds.menus ? "On" : "Off", onChange: (on) => sounds.set({ menus: on }) }}
      />
      <OptionRow
        title="Sorting sounds"
        info="A rating given, a picture moved into a folder, one put in the trash, in the theme's sound."
        toggle={{ on: sounds.sorting, label: sounds.sorting ? "On" : "Off", onChange: (on) => sounds.set({ sorting: on }) }}
      />
      {anyOn && (
        <OptionRow
          title="Sound volume"
          control={
            <span className="row sound-volume">
              <input type="range" min={0} max={1} step={0.05} value={sounds.volume} onChange={(e) => sounds.set({ volume: Number(e.target.value) })} onPointerUp={() => cue(sounds.menus ? "select" : "rate", true)} aria-label="Sound volume" />
              <button type="button" className="btn sm ghost" data-own-sound onClick={() => CUES.forEach((c, i) => setTimeout(() => cue(c, true), i * 420))} title="Every sound of this theme, one after another">
                <SpeakerHigh /> Hear them
              </button>
            </span>
          }
        />
      )}
    </>
  );
}

function FacesPage() {
  const s = useStore();
  return (
    <Cards note="Faces are looked for in the whole library, once the tag index has nothing to do, with the face finders in Local models.">
      <Card
        icon={<FolderMinus />}
        title="Leave out folders…"
        text="Folders the face scan doesn't look in: strangers at a paid shoot, say."
        onClick={() => {
          s.set({ settingsOpen: false });
          usePeople.setState({ leaveOutOpen: true, open: null });
          s.openPeople();
        }}
      />
      <Card icon={<Cpu />} title="Face finders…" text="The models that find and tell faces apart, in Local models." onClick={() => s.set({ modelsOpen: true })} />
    </Cards>
  );
}
