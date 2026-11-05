import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowCounterClockwise, ArrowSquareOut, CaretRight, MagnifyingGlass, X } from "@phosphor-icons/react";
import { Thumb } from "./Thumb";
import { ArtistIcon } from "./ArtistIcon";
import { api } from "../lib/api";
import { originalOf, selectCurrent, useStore } from "../store";
import { useDupes } from "../dupesStore";
import { useTags, albumKeyOf } from "../tagsStore";
import { faceKind, folderKind, kindFromTags, outOfPlace, usePeople, type Person } from "../peopleStore";
import { DRAWN_MIN, drawnScore } from "../lib/drawn";
import { albumArtistKey, artistKeyOf, useArtists } from "../artistsStore";
import { FaceCrop } from "../screens/People";
import { usePlugins } from "../plugins/store";
import { useVersionInfo } from "../versionsStore";
import { showWork } from "../findStore";
import { useFinders } from "../plugins/find";
import { seriesCount, seriesIndex } from "../lib/series";
import { formatBytes, formatDate } from "../lib/format";
import type { Album, FaceView, ItemSource, MediaInfo, MediaItem, VersionLink } from "../lib/types";

/**
 * Info: everything known about one picture (or album), beside it rather than over it. In the viewer it
 * sits between the bars and follows the picture on show; elsewhere it stands at the right of the
 * screen. Who is in it and who made it first, then where it lives and came from, what it was made
 * from (or what was made from it), its tags, the file and what the camera wrote; the tagger's
 * suggestions and the fingerprints folded away. It shows, it doesn't edit: each thing is changed
 * where it belongs (a person's page, an artist's, Tags). The one thing done here is Revert.
 */
export function InfoPanel() {
  const opened = useStore((s) => s.infoItem);
  const album = useStore((s) => s.infoAlbum);
  const screen = useStore((s) => s.screen);
  const current = useStore(selectCurrent);
  // In the viewer, the picture on show: ← and → still turn pages behind the popup.
  const item = screen === "viewer" && opened ? (current ?? opened) : opened;
  const close = () => useStore.getState().set({ infoItem: null, infoAlbum: null });

  // Going to another screen (a person's page, an artist's) closes it.
  const shownOn = useRef(screen);
  useEffect(() => {
    if (screen === shownOn.current) return;
    shownOn.current = screen;
    close();
  }, [screen]);

  // Esc closes it (before the screen's own Esc), unless a dialog or a field has the key.
  useEffect(() => {
    if (!item && !album) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".modal-backdrop, .context-menu, .pop")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [item, album]);

  useEffect(() => {
    void useTags.getState().load();
    void useTags.getState().loadNames();
    void usePeople.getState().load();
    void useArtists.getState().load();
  }, []);

  if (!item && !album) return null;
  return (
    <div className="info-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <aside className="info-panel panel" role="dialog" aria-label="Info">
        {album && !item ? <AlbumInfo album={album} onClose={close} /> : item ? <ItemInfo key={item.key} item={item} onClose={close} /> : null}
      </aside>
    </div>
  );
}

/* ---------- pieces ---------- */

function Head({ cover, title, line, rating, onClose }: { cover: MediaItem | null; title: string; line: string; rating: number | undefined; onClose: () => void }) {
  return (
    <header className="info-head">
      <span className="info-cover">{cover ? <Thumb item={cover} aspect={1} eager onClick={() => {}} /> : null}</span>
      <div className="info-title">
        <h2 title={title}>{title}</h2>
        <span className="mono small dim">{line}</span>
        <Rating value={rating} />
      </div>
      <button className="btn sm ghost info-close" onClick={onClose} title="Close (Esc)">
        <X />
      </button>
    </header>
  );
}

/** The rating as ten steps: how far along, at a glance. */
function Rating({ value }: { value: number | undefined }) {
  return (
    <span className="info-rating" title={value != null ? `Rated ${value} of 10` : "Not rated"}>
      <span className="info-rating-steps" aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} className={value != null && i < value ? "on" : ""} />
        ))}
      </span>
      <span className="mono small">{value != null ? `${value}/10` : "unrated"}</span>
    </span>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="info-section">
      <h3 className="label">{label}</h3>
      {children}
    </section>
  );
}

/** Rows of what and value; an empty value leaves its row out. */
function Rows({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v != null && v !== "" && v !== false);
  if (!shown.length) return null;
  return (
    <dl className="info-rows">
      {shown.map(([k, v]) => (
        <div key={k} className="info-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Folded away: open when wanted. */
function More({ label, count, children, onOpen }: { label: string; count?: number; children: ReactNode; onOpen?: () => void }) {
  return (
    <details className="info-more" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && onOpen?.()}>
      <summary>
        <CaretRight className="info-more-caret" />
        <span className="label">{label}</span>
        {count != null && <span className="mono small faint">{count}</span>}
      </summary>
      <div className="info-more-body">{children}</div>
    </details>
  );
}

function PersonChip({ person, face, count }: { person: Person; face: FaceView | undefined; count?: number }) {
  return (
    <button className="chip link info-person" onClick={() => (useStore.getState().openPeople(), usePeople.getState().setOpen(person.id))} title={`${person.name}: their page in People`}>
      {face ? <FaceCrop face={face} size={22} className="round" /> : null}
      <span className="ellipsis">{person.name}</span>
      {count != null && count > 1 && <span className="mono small faint">{count}</span>}
    </button>
  );
}

function ArtistLine({ artistKey }: { artistKey: string }) {
  const artist = useArtists((s) => s.doc?.artists[s.doc?.items[artistKey]?.[0] ?? ""]);
  if (!artist) return null;
  return (
    <button className="info-artist" onClick={() => useStore.getState().openArtists(artist.id)} title={`${artist.name}: their page in Artists`}>
      <ArtistIcon artist={artist} size={28} />
      <span className="info-artist-name">
        <span className="ellipsis">{artist.name}</span>
        {artist.links[0]?.account && <span className="mono small faint ellipsis">@{artist.links[0].account}</span>}
      </span>
    </button>
  );
}

function TagChips({ tags }: { tags: string[] }) {
  if (!tags.length) return <div className="small faint">None yet.</div>;
  return (
    <div className="chips">
      {tags.map((t) => {
        const cut = t.indexOf("/");
        return (
          <span key={t} className="chip" title={t}>
            {cut > 0 && <span className="faint">{t.slice(0, cut)}/</span>}
            <span className="ellipsis">{t.slice(cut + 1)}</span>
          </span>
        );
      })}
    </div>
  );
}

/** The tagger's suggestions: your tags it may carry (learned from your yeses and noes), and the anime tagger's words, surest first. */
function Suggestions({ keyOf, autoKey, have }: { keyOf: string; autoKey: string | null; have: string[] }) {
  const root = useStore((s) => s.root);
  const tags = useTags((t) => t.data);
  const names = useTags((t) => t.names);
  const [mine, setMine] = useState<{ tag: string; p: number }[] | null>(null);
  const ask = () => {
    if (mine || !root) return;
    api
      .tagsPredict(root, [keyOf])
      .then((r) => setMine(r.filter((x) => !have.includes(x.tag) && x.p >= 0.3).slice(0, 16)))
      .catch(() => setMine([]));
  };
  const words = autoKey && tags && names ? (tags.auto[autoKey] ?? []).slice(0, 24).map(([i, p]) => [names[i]?.name.replace(/_/g, " ") ?? String(i), p] as const) : [];
  return (
    <More label="Tag suggestions" count={words.length || undefined} onOpen={ask}>
      <div className="info-sub">Your tags it may carry</div>
      {mine === null ? (
        <div className="small faint">Asking the tag index…</div>
      ) : mine.length ? (
        <Scores rows={mine.map((m) => [m.tag, m.p])} />
      ) : (
        <div className="small faint">None it's sure enough of.</div>
      )}
      {words.length > 0 && (
        <>
          <div className="info-sub">The tagger sees</div>
          <Scores rows={words} />
        </>
      )}
    </More>
  );
}

function Scores({ rows }: { rows: readonly (readonly [string, number])[] }) {
  return (
    <ul className="info-scores">
      {rows.map(([name, p]) => (
        <li key={name}>
          <span className="ellipsis">{name}</span>
          <span className="info-score-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(p * 100)}%` }} />
          </span>
          <span className="mono small faint">{Math.round(p * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

/** Who is in these pictures: each named person once (with how many of the pictures they are in, for an album), surest face first. */
function usePeopleIn(keys: Set<string>): { person: Person; face: FaceView | undefined; count: number }[] {
  const faces = usePeople((s) => s.faces);
  const doc = usePeople((s) => s.doc);
  return useMemo(() => {
    const out = new Map<string, { person: Person; face: FaceView | undefined; keys: Set<string> }>();
    for (const f of faces) {
      if (!keys.has(f.key)) continue;
      const a = doc?.faces[String(f.id)];
      const person = a && !a.auto ? doc?.people[a.p] : undefined;
      if (!person) continue;
      const was = out.get(person.id);
      if (!was) out.set(person.id, { person, face: f, keys: new Set([f.key]) });
      else {
        was.keys.add(f.key);
        if (!was.face || f.size * f.score > was.face.size * was.face.score) was.face = f;
      }
    }
    // Those in it with no face to show it.
    for (const k of keys)
      for (const id of doc?.present?.[k] ?? []) {
        const person = doc?.people[id];
        if (!person) continue;
        const was = out.get(id);
        if (was) was.keys.add(k);
        else out.set(id, { person, face: undefined, keys: new Set([k]) });
      }
    return [...out.values()].map((x) => ({ person: x.person, face: x.face, count: x.keys.size })).sort((a, b) => b.count - a.count || a.person.name.localeCompare(b.person.name));
  }, [faces, doc, keys]);
}

/* ---------- a picture ---------- */

function ItemInfo({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const root = useStore((s) => s.root);
  const library = useStore((s) => s.library);
  const viewed = useStore((s) => s.viewed[item.key]);
  const albums = useStore((s) => s.albums);
  const sig = useDupes((d) => d.cache[item.key]);
  const tags = useTags((t) => t.data);
  // Faces: the drawn score is worked out once that part is opened.
  const [scoring, setScoring] = useState(false);
  const [info, setInfo] = useState<MediaInfo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setInfo(undefined);
    if (!root) return;
    api
      .mediaInfo(root, item.primary)
      .then((i) => live && setInfo(i))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [item.primary, root]);

  const keys = useMemo(() => new Set([item.key]), [item.key]);
  const people = usePeopleIn(keys);
  const hasArtist = useArtists((s) => !!s.doc?.items[artistKeyOf(item)]?.length);
  const rating = library?.ratings[item.key];
  const series = useMemo(() => seriesIndex(library?.series).get(item.key), [library?.series, item.key]);
  const target = item.targetId ? library?.targets.find((t) => t.id === item.targetId)?.name : null;
  const album = item.albumKey ? albums.find((a) => a.key === item.albumKey) : undefined;
  const source = library?.sources?.[item.key];
  const itemTags = tags?.tags[item.key] ?? [];
  const exif = info?.exif;
  const camera: [string, ReactNode][] = exif
    ? [
        ["Taken", exif.dateTaken],
        ["Camera", [exif.make, exif.model].filter(Boolean).join(" ")],
        ["Lens", exif.lens],
        ["Exposure", [exif.exposure, exif.fNumber, exif.iso ? `ISO ${exif.iso}` : null, exif.focal].filter(Boolean).join(" · ")],
        ["Software", exif.software],
        ["Place", exif.gps],
        ["Turned", exif.orientation],
      ]
    : [];
  const kind = item.kind + (item.hasRaw ? " + RAW" : "") + (item.hasVideo ? " + video" : "");
  const pixels = info?.width && info.height ? `${info.width} × ${info.height}` : null;
  return (
    <>
      <Head cover={item} title={item.name} line={[kind, pixels, formatBytes(item.size)].filter(Boolean).join(" · ")} rating={rating} onClose={onClose} />
      <div className="info-scroll">
        {(people.length > 0 || hasArtist) && (
          <Section label="Who">
            {people.length > 0 && (
              <div className="chips">
                {people.map((x) => (
                  <PersonChip key={x.person.id} person={x.person} face={x.face} />
                ))}
              </div>
            )}
            <ArtistLine artistKey={artistKeyOf(item)} />
          </Section>
        )}
        <Section label="Where">
          <Rows
            rows={[
              ["Folder", <span className="mono">{item.dir || "/"}</span>],
              ["Album", album?.name ?? item.albumKey],
              ["Sorted to", target],
              ["From", source && <SourceLink source={source} />],
              [
                "Also on",
                source?.also?.length ? (
                  <span className="info-sources">
                    {source.also.map((s) => (
                      <SourceLink key={`${s.platform}:${s.id}`} source={s} />
                    ))}
                  </span>
                ) : null,
              ],
              ["Last seen", viewed ? formatDate(viewed) : "never"],
              ["Series", series && <SeriesLine item={item} count={seriesCount(series, library?.trashDir)} />],
            ]}
          />
        </Section>
        <Versions item={item} />
        <Section label="Tags">
          <TagChips tags={itemTags} />
        </Section>
        <Section label="File">
          <Rows
            rows={[
              ["Format", info?.format],
              ["Modified", formatDate(item.modified)],
              ["Files", item.files.length > 1 ? <span className="mono">{item.files.map((f) => f.split("/").pop()).join(", ")}</span> : null],
            ]}
          />
          {info === undefined && <div className="small faint">Reading the file…</div>}
        </Section>
        {camera.some(([, v]) => v) && (
          <Section label="Camera">
            <Rows rows={camera} />
          </Section>
        )}
        <Suggestions keyOf={item.key} autoKey={item.key} have={itemTags} />
        {(item.kind === "image" || item.kind === "raw" || item.kind === "video") && (
          <More label="Faces" onOpen={() => setScoring(true)}>
            <FaceFinders item={item} scoring={scoring} />
          </More>
        )}
        <More label="Fingerprints">
          <Rows
            rows={[
              ["Tag index", tags?.indexed[item.key] ? "indexed" : "not yet"],
              ["Content", <span className="mono">{sig?.fp ?? "not fingerprinted"}</span>],
              ["pHash", sig?.image && <span className="mono">{sig.image.phash}</span>],
              ["dHash", sig?.image && <span className="mono">{sig.image.dhash}</span>],
              ["Quarters", sig?.image?.quads && <span className="mono">{sig.image.quads.join(" ")}</span>],
              ["Video", sig?.video && `${sig.video.frames.length} frames, ${Math.round(sig.video.duration)} s`],
              ["Error", sig?.error],
            ]}
          />
        </More>
      </div>
    </>
  );
}

const fileName = (key: string) => key.split("/").pop() ?? key;

/**
 * How the picture's faces were looked for: what the tag index takes it for (and its drawn score,
 * once `scoring`), which finders that gives it (the Face finder for photos, the Character finder for
 * drawings, both while it isn't known), and what each of them found. To see why a face was missed or
 * went the wrong way.
 */
function FaceFinders({ item, scoring }: { item: MediaItem; scoring: boolean }) {
  const root = useStore((s) => s.root);
  const tags = useTags((t) => t.data);
  const faces = usePeople((s) => s.faces);
  const doc = usePeople((s) => s.doc);
  const scanned = usePeople((s) => s.scanned[item.key]);
  const without = usePeople((s) => s.noCharacters.has(item.key));
  const characters = usePeople((s) => s.characters);
  const [score, setScore] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (!scoring || !root) return;
    let alive = true;
    setScore(undefined);
    drawnScore(root, item.key).then(
      (n) => alive && setScore(n),
      () => alive && setScore(null),
    );
    return () => {
      alive = false;
    };
  }, [scoring, root, item.key]);
  const tagged = kindFromTags(tags, item.key);
  const said = folderKind(doc?.kinds, item.key);
  const kind = faceKind(doc, tags, item.key);
  const as = said
    ? `${said === "drawn" ? "a drawing" : "a photo"}, as its folder says (Settings, Faces)${tagged && tagged !== said ? `: the tag index took it for ${tagged === "drawn" ? "a drawing" : "a photo"}` : ""}`
    : kind === "drawn"
      ? "a drawing"
      : kind === "photo"
        ? score != null && score >= DRAWN_MIN
          ? "a photo: the anime tagger looked, as at a drawing, but named nothing"
          : "a photo"
        : tags?.indexed[item.key]
          ? "not known: the anime tagger hasn't looked at it"
          : "not known yet: the tag index hasn't looked at it";
  const finders = without
    ? "Face finder only: the Character finder wasn't downloaded then"
    : kind === "photo"
      ? "Face finder"
      : kind === "drawn"
        ? characters
          ? "Character finder"
          : "Face finder for now: the Character finder isn't downloaded"
        : characters
          ? "Face finder and Character finder"
          : "Face finder: the Character finder isn't downloaded";
  const here = faces.filter((f) => f.key === item.key);
  const byFace = here.filter((f) => f.kind === "photo").length;
  const byCharacter = here.filter((f) => f.kind === "drawn").length;
  const marked = here.filter((f) => f.marked).length;
  // Faces left from when it was taken for something else, or its folder's say changed: looked at again.
  const relook = doc?.relook?.includes(item.key) || here.some((f) => !f.marked && outOfPlace(f, kind, characters) && !(doc?.faces[String(f.id)] && !doc.faces[String(f.id)].auto));
  const found = !scanned
    ? "not looked at yet"
    : [!here.length ? "no faces" : [byFace && `${byFace} by the Face finder`, byCharacter && `${byCharacter} by the Character finder`, marked && `${marked} marked by hand`].filter(Boolean).join(" · "), relook && "looked at again with the finder it gets now, on the next face scan"].filter(Boolean).join(" · ");
  return (
    <Rows
      rows={[
        ["Taken for", as],
        [
          "Drawn score",
          !scoring ? null : score === undefined ? "working it out…" : score === null ? "none yet" : (
            <span title={`Drawings score about 2 to 4, photos about −3 to −11; from ${DRAWN_MIN} up, a picture is taken for a drawing`}>
              <span className="mono">{`${score < 0 ? "−" : "+"}${Math.abs(score).toFixed(1)}`}</span> <span className="faint">({DRAWN_MIN} and up: drawn)</span>
            </span>
          ),
        ],
        // What the rule gives the picture as it is taken for now (which finder found each face is in "Faces found").
        ["Finders for it", finders],
        ["Faces found", found],
      ]}
    />
  );
}

/** A work a picture came from (or is crossposted as): in Find, on a platform Find has; else in the browser. */
function SourceLink({ source }: { source: ItemSource }) {
  const inFind = useFinders((f) => Object.values(f.finders).find((x) => x.platform === source.platform));
  return (
    <button className="info-link" onClick={() => void showWork(source.platform, source.id, source.url || null)} title={inFind ? `In Find, on ${inFind.name}` : source.url || undefined}>
      <span className="ellipsis">
        {inFind?.name ?? source.platform} · {source.title || source.id}
      </span>
      {inFind ? <MagnifyingGlass /> : source.url && <ArrowSquareOut />}
    </button>
  );
}

/** One of a series: how many, and out of it again. */
function SeriesLine({ item, count }: { item: MediaItem; count: number }) {
  return (
    <span className="info-kept">
      <span>One of {count} alike, kept as a series</span>
      <button className="btn sm" onClick={() => useStore.getState().leaveSeries([item.key])} title="This picture on its own again; the rest stay a series">
        Take it out
      </button>
    </span>
  );
}

/** A picture of the viewer's queue, by path or by fingerprint (it may have moved): a link to it there. */
function ItemLink({ path, fp, name }: { path: string | null; fp: string; name: string }) {
  const queue = useStore((s) => s.queue);
  const cache = useDupes((d) => d.cache);
  const at = useMemo(() => {
    const byPath = path ? queue.findIndex((q) => q.primary === path) : -1;
    if (byPath >= 0) return byPath;
    const key = Object.entries(cache).find(([, v]) => v.fp === fp)?.[0];
    return key ? queue.findIndex((q) => q.key === key) : -1;
  }, [path, fp, queue, cache]);
  if (at < 0) return <span className="mono">{name}</span>;
  return (
    <button className="info-link" onClick={() => useStore.getState().setIndex(at)} title="Show it">
      <span className="ellipsis mono">{name}</span>
    </button>
  );
}

/** How a version was made: "Cleaned by …" or "Edited in the editor", and when. */
function madeHow(link: VersionLink, pluginName: (id: string) => string): string {
  const note = link.note.charAt(0).toUpperCase() + link.note.slice(1);
  return `${note} ${link.by === "edit" ? "in the editor" : `by ${pluginName(link.by)}`}, ${formatDate(link.at)}`;
}

/** What it was made from (and whether that is kept, to go back to), or the versions made from it. */
function Versions({ item }: { item: MediaItem }) {
  const info = useVersionInfo(item);
  const plugins = usePlugins((p) => p.list);
  const [busy, setBusy] = useState(false);
  if (!info || (!info.link && !info.versions.length)) return null;
  const pluginName = (id: string) => plugins.find((p) => p.id === id)?.manifest?.name ?? id;
  const link = info.link;
  const revert = async () => {
    setBusy(true);
    await useStore.getState().revertItem(item);
    setBusy(false);
  };
  return (
    <Section label="Versions">
      {link && (
        <Rows
          rows={[
            ["Made from", <ItemLink path={info.original} fp={link.from} name={link.fromName} />],
            ["How", madeHow(link, pluginName)],
            [
              "Original",
              info.kept ? (
                <span className="info-kept">
                  <span>
                    Kept out of sight; <kbd className="kbd">O</kbd> shows it
                  </span>
                  <button className="btn sm" disabled={busy} onClick={() => void revert()} title={`${link.fromName} back in its place; this version goes to the trash (⌘Z undoes it)`}>
                    <ArrowCounterClockwise /> Revert
                  </button>
                </span>
              ) : info.original ? (
                <span>
                  In the library; <kbd className="kbd">O</kbd> shows it
                </span>
              ) : (
                <span className="dim">No longer in the library</span>
              ),
            ],
          ]}
        />
      )}
      {info.versions.length > 0 && (
        <Rows
          rows={[
            [
              "Made from it",
              <span className="info-versions">
                {info.versions.map((v) => (
                  <span key={v.made} title={madeHow(v.link, pluginName)}>
                    <ItemLink path={v.path} fp={v.made} name={fileName(v.link.madeAt)} />
                  </span>
                ))}
              </span>,
            ],
          ]}
        />
      )}
    </Section>
  );
}

/* ---------- an album ---------- */

function AlbumInfo({ album, onClose }: { album: Album; onClose: () => void }) {
  const library = useStore((s) => s.library);
  const albums = useStore((s) => s.albums);
  const all = useStore((s) => s.allItems);
  const tags = useTags((t) => t.data);
  useEffect(() => {
    if (!useStore.getState().allItems.length) void useStore.getState().loadAll();
  }, []);
  const key = albumKeyOf(album.key);
  const pages = useMemo(() => new Set(all.filter((i) => i.albumKey === album.key).map((i) => i.key)), [all, album.key]);
  const people = usePeopleIn(pages);
  const translation = library?.albumTranslations?.[album.key];
  const other = translation ? albums.find((a) => a.key === translation) : null;
  const albumTags = tags?.tags[key] ?? [];
  const hasArtist = useArtists((s) => !!s.doc?.items[albumArtistKey(album.key)]?.length);
  return (
    <>
      <Head cover={album.cover} title={album.name} line={[`${album.count} pages`, formatBytes(album.bytes)].join(" · ")} rating={library?.albumRatings[originalOf(album.key)]} onClose={onClose} />
      <div className="info-scroll">
        {(people.length > 0 || hasArtist) && (
          <Section label="Who">
            {people.length > 0 && (
              <div className="chips">
                {people.map((x) => (
                  <PersonChip key={x.person.id} person={x.person} face={x.face} count={x.count} />
                ))}
              </div>
            )}
            <ArtistLine artistKey={albumArtistKey(album.key)} />
          </Section>
        )}
        <Section label="Where">
          <Rows
            rows={[
              ["Folder", <span className="mono">{album.path}</span>],
              ["Album folder", <span className="mono">{album.albumRoot}</span>],
              ["Translated", translation ? (other?.name ?? translation) : null],
            ]}
          />
        </Section>
        <Section label="Tags">
          <TagChips tags={albumTags} />
        </Section>
        <Section label="Album">
          <Rows
            rows={[
              ["Pages", `${album.images} pictures${album.videos ? `, ${album.videos} videos` : ""}`],
              ["Modified", formatDate(album.modified)],
            ]}
          />
        </Section>
        <Suggestions keyOf={key} autoKey={null} have={albumTags} />
      </div>
    </>
  );
}
