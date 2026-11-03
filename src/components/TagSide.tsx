import { useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowElbowDownRight, ArrowLeft, ArrowsMerge, Folder, LinkBreak, LinkSimple, MagnifyingGlass, PaintBrush, PencilSimple, Plus, Prohibit, RadioButton, Sparkle, SquaresFour, Stack, Tag as TagIcon, TreeStructure, Trash, Warning, X } from "@phosphor-icons/react";
import { useScrapbook } from "../scrapbook/store";
import { useCoverUrl } from "../scrapbook/pictures";
import { Thumb } from "./Thumb";
import { Select } from "./Select";
import { ask, askText } from "./Confirm";
import { MergePicker, TagRow, adoptWord, bundleTogether, makeSubtag, moveTagInto, removeFolder, renameTagTo, toggleExclusive } from "./TagBits";
import { allTags, ancestorsOf, apartFrom, conflictsOf, descendantsOf, nameOf, pathOf, tagKeysFor, tagsOfType, treeOfType, typeOf, useTags } from "../tagsStore";
import { useFinders } from "../plugins/find";
import type { MediaItem } from "../lib/types";
import { notForTarget, pickLibraryFolder } from "./FolderBrowser";
import { useStore } from "../store";
import { allSources } from "../lib/sources";

/**
 * The side panel of the tag board: what a clicked folder or tag can do. A folder: rename, "pick
 * one" (at most one of its tags on anything), its tags, delete. A tag: its folder and name, the way
 * into its grid, its opposites (never suggested together), and what often goes with it.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Head({ icon, title, onClose }: { icon: ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="inspector-head">
      {icon}
      <h3 className="ellipsis grow" title={title}>
        {title}
      </h3>
      <button className="btn sm ghost" onClick={onClose} title="Close (Esc)">
        <X />
      </button>
    </div>
  );
}

/** Distinct things carrying any tag of a folder. */
export function carriersOf(tags: Record<string, string[]>, type: string): number {
  let n = 0;
  for (const [k, list] of Object.entries(tags)) if (k && list.some((id) => typeOf(id) === type)) n++;
  return n;
}

export function FolderInspector({ type, onClose, onOpenTag, onPreviews, onConflicts }: { type: string; onClose: () => void; onOpenTag: (id: string) => void; onPreviews: () => void; onConflicts: () => void }) {
  const d = useTags((x) => x.data)!;
  const tags = useMemo(() => treeOfType(d, type), [d, type]);
  const carriers = useMemo(() => carriersOf(d.tags, type), [d, type]);
  const exclusive = !!d.exclusive?.includes(type);
  const place = !!d.places?.includes(type);
  const library = useStore((x) => x.library);
  const unplaced = place ? tags.filter((t) => !t.depth && !library?.targets.some((b) => b.id === d.placeOf?.[t.id])).length : 0;
  const [adding, setAdding] = useState("");
  return (
    <aside className="tags-side right panel inspector">
      <Head icon={<Folder />} title={type} onClose={onClose} />
      <div className="dim small">
        {plural(tags.length, "tag")} in this folder; {plural(carriers, "picture or album", "pictures and albums")} carry at least one.
      </div>
      <div className="row inspector-actions">
        <button className="btn sm" onClick={() => void askText({ title: "Rename tag folder", message: <>New name for <b>{type}</b>:</>, initial: type, confirm: "Rename" }).then((to) => void (to && useTags.getState().renameType(type, to)))}>
          <PencilSimple /> Rename
        </button>
        <button className="btn sm" onClick={onPreviews} title="Its tags as cards with previews">
          <SquaresFour /> Previews
        </button>
        <span className="grow" />
        <button className="btn sm ghost danger" onClick={() => void removeFolder(type, tags.length, carriers)} title="Remove the folder and its tags">
          <Trash />
        </button>
      </div>
      <hr className="rule" />
      <section>
        <label className="check">
          <input type="checkbox" checked={exclusive} disabled={place} onChange={() => void toggleExclusive(type)} /> Pick one
        </label>
        <div className="dim small">At most one of these tags on anything, like day or night. Tagging shows the folder as a dropdown, a new pick replaces the old one, and the others aren't suggested.</div>
        {exclusive && !place && <ConflictActions type={type} onShow={onConflicts} />}
      </section>
      <hr className="rule" />
      <section>
        <label className="check">
          <input type="checkbox" checked={place} onChange={() => useTags.getState().setPlace(type, !place)} /> Bucket folder
        </label>
        <div className="dim small">Each tag is a folder, like Professional or Private: a picture carries the one it's in, and choosing another moves it there, filed under the day it went in. Always pick one.</div>
        {unplaced > 0 && (
          <div className="row small place-missing">
            <Warning /> {unplaced === 1 ? "A tag has" : `${unplaced} tags have`} no folder yet: choose below.
          </div>
        )}
      </section>
      <hr className="rule" />
      <section>
        <div className="label">Tags</div>
        <div className="inspector-list">
          {tags.map((tag) =>
            place && !tag.depth ? (
              <div key={tag.id} className="place-row">
                <TagRow node={tag} active={false} icon={<Folder />} onOpen={() => onOpenTag(tag.id)} />
                <PlaceFolder tag={tag.id} />
              </div>
            ) : (
              <TagRow key={tag.id} node={tag} active={false} icon={tag.depth ? <ArrowElbowDownRight /> : exclusive ? <RadioButton /> : <TagIcon />} onOpen={() => onOpenTag(tag.id)} />
            ),
          )}
          {!tags.length && <span className="dim small">None yet.</span>}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const name = adding.trim().replace(/\//g, " ");
            if (name) useTags.getState().addTag(`${type}/${name}`);
            setAdding("");
          }}
        >
          <input className="input grow" placeholder="New tag" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button className="btn sm ghost" type="submit" disabled={!adding.trim()} title={`Add a tag to ${type}`}>
            <Plus />
          </button>
        </form>
      </section>
    </aside>
  );
}

const NEW_BUCKET = "\u0000new";
const OTHER_FOLDER = "\u0000other";

/** A bucket folder's tag's folder: one of the buckets, a new one named after the tag, or any folder in the library. */
function PlaceFolder({ tag }: { tag: string }) {
  const library = useStore((x) => x.library);
  const current = useTags((x) => x.data?.placeOf?.[tag] ?? "");
  const buckets = useMemo(() => library?.targets.filter((t) => t.bucket) ?? [], [library]);
  const has = buckets.some((b) => b.id === current);
  const choose = async (v: string) => {
    const s = useStore.getState();
    if (v === NEW_BUCKET) {
      const t = await s.addBucket(nameOf(tag));
      if (t) useTags.getState().setPlaceOf(tag, t.id);
    } else if (v === OTHER_FOLDER) {
      const root = s.root;
      // A target already is fine (it becomes a bucket); the trash and album folders aren't.
      const notTarget = notForTarget(s.library, root ?? "");
      const abs = await pickLibraryFolder({ title: `The folder ${nameOf(tag)} stands for`, start: root, why: (rel) => (s.library?.targets.some((t) => t.path === rel) ? null : notTarget(rel)) });
      if (!abs || !root) return;
      if (!abs.startsWith(`${root}/`)) return s.toast("A bucket is a folder inside the library", "warn");
      const rel = abs.slice(root.length + 1);
      if (!s.library?.targets.some((x) => x.path === rel)) s.addTarget(abs);
      const t = useStore.getState().library?.targets.find((x) => x.path === rel);
      if (!t) return;
      if (!t.bucket) useStore.getState().updateTarget(t.id, { bucket: true });
      useTags.getState().setPlaceOf(tag, t.id);
    } else useTags.getState().setPlaceOf(tag, v || null);
  };
  return (
    <Select
      compact
      value={has ? current : ""}
      options={[{ value: "", label: "Choose its folder" }, ...buckets.map((b) => ({ value: b.id, label: `${b.path}/` })), { value: NEW_BUCKET, label: `New bucket: ${nameOf(tag)}/` }, { value: OTHER_FOLDER, label: "Another folder…" }]}
      onChange={(v) => void choose(v)}
      title="The folder this tag stands for"
    />
  );
}

export function TagInspector({ id, itemFor, onClose, onSee, onOpenTag, onFilter }: { id: string; itemFor: (key: string) => MediaItem | null; onClose: () => void; onSee: (which: "verified" | "suggested") => void; onOpenTag: (id: string) => void; onFilter: (filter: string) => void }) {
  const t = useTags(useShallow((x) => ({ data: x.data, names: x.names, mode: x.mode })));
  const d = t.data!;
  const type = typeOf(id);
  const name = nameOf(id);
  const store = useTags.getState();
  const related = useMemo(() => store.related(id), [d, t.names, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const covers = useMemo(() => store.coversFor(id, t.mode, 6).map(itemFor).filter((x): x is MediaItem => !!x), [d, t.mode, id, itemFor]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = useMemo(() => Object.entries(d.tags).filter(([k, list]) => k && list.includes(id)).length, [d, id]);
  const exclusive = !!d.exclusive?.includes(type);
  const siblings = exclusive ? tagsOfType(d, type).filter((x) => x.id !== id) : [];
  const apart = apartFrom(d, id);
  const linked = Object.entries(d.autoMap ?? {}).filter(([, to]) => to === id).map(([n]) => n);
  const bundles = Object.entries(d.bundles ?? {}).filter(([, m]) => m.includes(id));
  const others = allTags(d).filter((x) => x !== id && !apart.includes(x) && !siblings.some((s) => s.id === x));
  const parent = d.parents?.[id];
  const below = useMemo(() => descendantsOf(d, id), [d, id]);
  const banner = useCoverUrl(d.covers?.[id]);
  const scrap = { kind: "tag" as const, id, name };
  const subtags = useMemo(() => treeOfType(d, type).filter((x) => below.has(x.id)), [d, type, below]);
  const [placing, setPlacing] = useState(false);
  const tagChip = (other: string, onX?: () => void, title?: string) => (
    <span key={other} className="chip link" title={title ?? `Open ${other}`} onClick={() => onOpenTag(other)}>
      <span className="ellipsis">{nameOf(other)}</span> <span className="dim small">{typeOf(other)}</span>
      {onX && (
        <button className="chip-x" onClick={(e) => (e.stopPropagation(), onX())}>
          <X />
        </button>
      )}
    </span>
  );

  return (
    <aside className="tags-side right panel inspector">
      <Head icon={<TagIcon />} title={name} onClose={onClose} />
      {banner && <img className="tag-banner" src={banner} alt="" draggable={false} onClick={() => void useScrapbook.getState().open(scrap)} title="Edit the banner in Scrapbook" />}
      {parent && (
        <div className="row inspector-parent small">
          <span className="dim">Subtag of</span> {tagChip(parent)}
          <span className="grow" />
          <button className="btn sm ghost" onClick={() => void moveTagInto(id, type)} title={`A top tag of ${type} again (what carries it keeps ${nameOf(parent)})`}>
            <ArrowLeft /> Top tag
          </button>
        </div>
      )}
      <div className="row inspector-actions">
        <Select compact value={type} options={d.types.map((x) => ({ value: x, label: x }))} onChange={(to) => void moveTagInto(id, to)} title="Its folder: pick another to move it there" />
        <button className="btn sm" title="Rename" onClick={() => void askText({ title: "Rename tag", message: <>New name for <b>{name}</b>:</>, initial: name, confirm: "Rename" }).then((to) => void (to && renameTagTo(id, to)))}>
          <PencilSimple /> Rename
        </button>
        <button className={`btn sm ${placing ? "active" : ""}`} title="Make it a subtag of another tag" onClick={() => setPlacing(!placing)}>
          <TreeStructure /> Under…
        </button>
        <button className="btn sm" title={banner ? "Edit its banner in Scrapbook" : "Make it a banner in Scrapbook"} onClick={() => void useScrapbook.getState().open(scrap)}>
          <PaintBrush /> Banner
        </button>
        {d.covers?.[id] && (
          <button className="btn sm ghost" title="Remove the banner" onClick={() => void useScrapbook.getState().removeCover(scrap)}>
            <X />
          </button>
        )}
        <span className="grow" />
        <button
          className="btn sm ghost danger"
          title="Delete the tag everywhere"
          onClick={() => void ask({ title: "Delete tag", message: <>Delete <b>{id}</b>? It comes off the {plural(count, "thing")} carrying it.{below.size ? " Its subtags stay, one level up." : ""}</>, confirm: "Delete", danger: true, safeDefault: !!count }).then((ok) => ok && store.removeTag(id))}
        >
          <Trash />
        </button>
      </div>
      {placing && (
        <div className="inspector-pick">
          <MergePicker
            label={`Put ${name} under…`}
            tags={allTags(d).filter((x) => x !== id && x !== parent && !below.has(x))}
            onPick={(to) => {
              setPlacing(false);
              void makeSubtag(id, to);
            }}
          />
        </div>
      )}
      <div className="inspector-strip" onClick={() => onSee("verified")} title="See everything carrying it">
        {covers.map((it) => (
          <Thumb key={it.key} item={it} aspect={1} onClick={() => {}} />
        ))}
      </div>
      <div className="dim small">{count ? `On ${plural(count, "picture or album", "pictures and albums")}.` : "Nothing carries it yet."}</div>
      <div className="row">
        <button className="btn sm primary" onClick={() => onSee("verified")}>
          <SquaresFour /> See tagged
        </button>
        <button className="btn sm" onClick={() => onSee("suggested")} title="What might carry it, to confirm or turn down">
          <Sparkle /> Check suggestions
        </button>
      </div>
      <hr className="rule" />

      <section>
        <div className="label">
          <TreeStructure /> Subtags
        </div>
        <div className="dim small">Whatever gets a subtag also carries {name}; not the other way round.</div>
        <div className="chips">
          {subtags.map((x) => (
            <span key={x.id} className="chip link" style={{ marginLeft: (x.depth - ancestorsOf(d, id).length - 1) * 12 }} title={`${pathOf(d, x.id)}: open it`} onClick={() => onOpenTag(x.id)}>
              {x.name} <span className="dim mono small">{x.count}</span>
              <button className="chip-x" title={`Make it a top tag of ${type}`} onClick={(e) => (e.stopPropagation(), void moveTagInto(x.id, type))}>
                <X />
              </button>
            </span>
          ))}
          {!subtags.length && <span className="dim small">None yet.</span>}
        </div>
        <SubtagAdder id={id} />
      </section>
      <hr className="rule" />

      <section>
        <div className="label">
          <Prohibit /> Opposites
        </div>
        <div className="dim small">Never suggested together: a picture with one of these doesn't get {name} suggested, and the other way round. Any folder.</div>
        <div className="chips">
          {apart.map((other) => tagChip(other, () => store.setApart(id, other, false), `${other} is an opposite; × takes that back`))}
          {!apart.length && !siblings.length && <span className="dim small">None yet.</span>}
        </div>
        {siblings.length > 0 && (
          <div className="dim small">
            <RadioButton /> {type} is “pick one”, so these are opposites too: {siblings.map((s) => s.name).join(", ")}
          </div>
        )}
        <div className="inspector-pick">
          <MergePicker label="Add an opposite" tags={others} onPick={(other) => store.setApart(id, other, true)} />
        </div>
      </section>
      <hr className="rule" />

      <section>
        <div className="label">
          <ArrowsMerge /> Often together
        </div>
        {related.tags.map((r) => (
          <div key={r.id} className="related">
            <div className="row">
              {tagChip(r.id)}
              <span className="grow" />
              <button
                className="btn sm ghost"
                title={`Merge ${nameOf(r.id)} into ${name}: what carries it carries ${name} instead`}
                onClick={() => void ask({ title: "Merge tags", message: <>Merge <b>{r.id}</b> into <b>{id}</b>? Everything carrying it carries <b>{name}</b> instead, and <b>{nameOf(r.id)}</b> goes.</>, confirm: "Merge" }).then((ok) => ok && store.mergeTags(r.id, id))}
              >
                <ArrowsMerge />
              </button>
              <button className="btn sm ghost" title="Bundle them: both stay, and filter as one" onClick={() => bundleTogether(id, r.id)}>
                <Stack />
              </button>
              <button className="btn sm ghost" title="Not related: don't offer it here again" onClick={() => store.dismissRelated(id, r.id)}>
                <X />
              </button>
            </div>
            <div className="dim small">
              {pct(r.share)} of {name} also have {nameOf(r.id)}; {pct(r.theirs)} of {nameOf(r.id)} have {name}.
            </div>
          </div>
        ))}
        {related.words.map((w) => (
          <div key={w.name} className="related">
            <div className="row">
              <span className="chip auto" title="A word of the tagger's">
                {w.name.replace(/_/g, " ")}
              </span>
              <span className="grow" />
              <button className="btn sm ghost" title={`Link it: wherever the tagger sees “${w.name.replace(/_/g, " ")}”, ${name} is suggested`} onClick={() => store.mapAuto(w.name, id)}>
                <LinkSimple /> {w.linkedTo ? "Link here" : "Link"}
              </button>
              <button className="btn sm ghost" title="Not related: don't offer it here again" onClick={() => store.dismissRelated(id, `auto:${w.name}`)}>
                <X />
              </button>
            </div>
            <div className="dim small">
              The tagger sees it in {pct(w.share)} of {name}, {w.lift >= 10 ? "over 10" : w.lift.toFixed(1)} times as often as elsewhere.
              {w.linkedTo && <> It suggests {nameOf(w.linkedTo)} now.</>}
            </div>
          </div>
        ))}
        {!related.tags.length && !related.words.length && <div className="dim small">Nothing stands out yet. Tags you use alongside {name}, and words the tagger sees mostly here, show up as more things carry it.</div>}
        {(related.tags.length > 0 || related.words.length > 0) && <div className="dim small">The same thing under two names: merge them, or bundle them to keep both. A linked tagger word suggests {name} wherever the tagger sees it.</div>}
      </section>

      <hr className="rule" />
      <section>
        <div className="label">
          <LinkSimple /> Synonyms from the tagger
        </div>
        <div className="dim small">Where the tagger sees one of these words, {name} is suggested.</div>
        <div className="chips">
          {linked.map((n) => (
            <span key={n} className="chip auto mapped" title={`Where the tagger sees this, ${name} is suggested`}>
              {n.replace(/_/g, " ")}
              <button className="chip-x" title="Unlink" onClick={() => store.unmapAuto(n)}>
                <LinkBreak />
              </button>
            </span>
          ))}
          {!linked.length && <span className="dim small">None yet.</span>}
        </div>
        <WordLinker id={id} />
      </section>
      <SourceLinks id={id} />

      {bundles.length > 0 && (
        <>
          <hr className="rule" />
          <section>
            <div className="label">
              <Stack /> In bundles
            </div>
            {bundles.map(([n, members]) => (
              <div key={n} className="row related">
                <button className="btn sm ghost" onClick={() => onFilter(`bundle:${n}`)} title="Everything carrying any of its tags">
                  {n}
                </button>
                <span className="chips grow">{members.filter((m) => m !== id).map((m) => tagChip(m))}</span>
              </div>
            ))}
          </section>
        </>
      )}
    </aside>
  );
}

/** Searches the tagger's words: the ones seen most here first, and how often. */
function useWords(q: string, limit: number) {
  const d = useTags((x) => x.data);
  const names = useTags((x) => x.names);
  return useMemo(() => (q.trim() ? useTags.getState().findWords(q, limit) : []), [q, limit, d, names]); // eslint-disable-line react-hooks/exhaustive-deps
}

const seen = (count: number) => (count ? `in ${count}` : "not seen here yet");

/** A subtag added by typing: a new name, one of your tags (moved under it), or a tagger word (made a tag, and linked). */
function SubtagAdder({ id }: { id: string }) {
  const d = useTags((x) => x.data)!;
  const hasNames = useTags((x) => !!x.names);
  const [q, setQ] = useState("");
  const typed = q.trim().replace(/\//g, " ");
  const type = typeOf(id);
  const words = useWords(typed, 6);
  const no = useMemo(() => new Set([id, ...ancestorsOf(d, id), ...descendantsOf(d, id)]), [d, id]);
  const tags = typed ? allTags(d).filter((x) => !no.has(x) && nameOf(x).toLowerCase().includes(typed.toLowerCase())).slice(0, 5) : [];
  const exists = allTags(d).includes(`${type}/${typed}`);
  const done = () => setQ("");
  return (
    <div className="inspector-pick">
      <div className="row search-field">
        <MagnifyingGlass className="dim" />
        <input className="input grow" placeholder={hasNames ? "Add a subtag: a new name, a tag, or a tagger word" : "Add a subtag: a new name or a tag"} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), done())} />
      </div>
      {typed && (
        <div className="chips">
          {!exists && (
            <button
              className="chip suggest"
              onClick={() => {
                const sub = `${type}/${typed}`;
                const t = useTags.getState();
                t.addTag(sub);
                t.setParent(sub, id);
                done();
              }}
            >
              <Plus /> new “{typed}”
            </button>
          )}
          {tags.map((x) => (
            <button key={x} className="chip" title={`Move ${x} under ${nameOf(id)}`} onClick={() => (void makeSubtag(x, id), done())}>
              {nameOf(x)} <span className="dim small">{typeOf(x)}</span>
            </button>
          ))}
          {words.map((w) => (
            <button key={w.name} className="chip auto" title={`Make the tagger's “${w.name.replace(/_/g, " ")}” a subtag, linked so the tagger suggests it${w.linkedTo ? ` (linked to ${w.linkedTo} now)` : ""}`} onClick={() => (adoptWord(w.name, w.name.replace(/_/g, " "), `under:${id}`), done())}>
              {w.name.replace(/_/g, " ")} <span className="dim small">{seen(w.count)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Finds a tagger word, however rare, to link to a tag as a synonym. */
function WordLinker({ id }: { id: string }) {
  const hasNames = useTags((x) => !!x.names);
  const [q, setQ] = useState("");
  const words = useWords(q, 8);
  if (!hasNames) return <div className="dim small">The tagger's words show once its model is downloaded.</div>;
  return (
    <div className="inspector-pick">
      <div className="row search-field">
        <MagnifyingGlass className="dim" />
        <input className="input grow" placeholder="Find a tagger word to link" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setQ(""))} />
      </div>
      {words.map((w) => (
        <div key={w.name} className="row word-row">
          <span className="chip auto">{w.name.replace(/_/g, " ")}</span>
          <span className="dim small grow">
            {seen(w.count)}
            {w.linkedTo && w.linkedTo !== id ? ` · suggests ${nameOf(w.linkedTo)} now` : ""}
          </span>
          {w.linkedTo === id ? (
            <span className="dim small">linked</span>
          ) : (
            <button className="btn sm ghost" onClick={() => (useTags.getState().mapAuto(w.name, id), setQ(""))} title={`Wherever the tagger sees it, ${nameOf(id)} is suggested`}>
              <LinkSimple /> Link
            </button>
          )}
        </div>
      ))}
      {q.trim() && !words.length && <span className="dim small">No tagger word has that in it.</span>}
    </div>
  );
}

/**
 * A platform's tags linked to this tag (from Find's platforms): what comes in from there carrying one
 * gets it. Found among the tags of what came in already, or typed; what came in before the link
 * can be given it here.
 */
function SourceLinks({ id }: { id: string }) {
  const d = useTags((x) => x.data)!;
  const finders = useFinders((x) => x.finders);
  const sources = useStore((x) => x.library?.sources);
  const platforms = useMemo(() => {
    const out = new Map(Object.values(finders).map((f) => [f.platform, f.name]));
    for (const k of Object.keys(d.sourceMap ?? {})) if (!out.has(k.slice(0, k.indexOf(":")))) out.set(k.slice(0, k.indexOf(":")), k.slice(0, k.indexOf(":")));
    return [...out];
  }, [finders, d.sourceMap]);
  const [platform, setPlatform] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const at = platform ?? platforms[0]?.[0] ?? "";
  const linked = Object.entries(d.sourceMap ?? {})
    .filter(([, to]) => to === id)
    .map(([k]) => ({ platform: k.slice(0, k.indexOf(":")), name: k.slice(k.indexOf(":") + 1) }));
  // The platform's tags on what came in already, most common first.
  const seen = useMemo(() => {
    const count = new Map<string, { name: string; translated: string | null; n: number }>();
    for (const src of Object.values(sources ?? {}).flatMap(allSources)) {
      if (src.platform !== at) continue;
      for (const t of src.tags ?? []) {
        const c = count.get(t.name) ?? { name: t.name, translated: t.translated, n: 0 };
        c.n++;
        count.set(t.name, c);
      }
    }
    return [...count.values()].sort((a, b) => b.n - a.n);
  }, [sources, at]);
  // What came in carrying a linked tag but not this one (before the link was made).
  const missing = useMemo(() => {
    const links = new Set(linked.map((l) => `${l.platform}:${l.name}`));
    if (!links.size) return [];
    const keys = Object.entries(sources ?? {})
      .filter(([, src]) => allSources(src).some((s) => (s.tags ?? []).some((t) => links.has(`${s.platform}:${t.name}`))))
      .map(([k]) => k);
    return [...new Set(tagKeysFor(keys))].filter((k) => !d.tags[k]?.includes(id));
  }, [sources, d, id, linked.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!platforms.length) return null;
  const store = useTags.getState();
  const needle = q.trim().replace(/^#/, "").toLowerCase();
  const matches = needle ? seen.filter((t) => `${t.name} ${t.translated ?? ""}`.toLowerCase().includes(needle)).slice(0, 8) : [];
  const link = (name: string) => (store.linkSource(at, name, id), setQ(""));
  const platformName = (p: string) => platforms.find(([x]) => x === p)?.[1] ?? p;

  return (
    <>
      <hr className="rule" />
      <section>
        <div className="label">
          <LinkSimple /> Also from {platforms.length === 1 ? platforms[0][1] : "platforms"}
        </div>
        <div className="dim small">What comes in carrying one of these gets {nameOf(id)}.</div>
        <div className="chips">
          {linked.map((l) => (
            <span key={`${l.platform}:${l.name}`} className="chip auto mapped" title={`What comes in from ${platformName(l.platform)} carrying it gets ${nameOf(id)}`}>
              #{l.name}
              {platforms.length > 1 && <span className="dim small">{platformName(l.platform)}</span>}
              <button className="chip-x" title="Unlink" onClick={() => store.linkSource(l.platform, l.name, null)}>
                <LinkBreak />
              </button>
            </span>
          ))}
          {!linked.length && <span className="dim small">None yet.</span>}
        </div>
        {missing.length > 0 && (
          <div className="row small source-missing">
            <span className="dim grow">
              {missing.length} brought in earlier carr{missing.length === 1 ? "ies" : "y"} one without {nameOf(id)}.
            </span>
            <button className="btn sm" onClick={() => store.setTag(missing, id, true)}>
              Tag {missing.length === 1 ? "it" : "them"}
            </button>
          </div>
        )}
        <div className="inspector-pick">
          <div className="row search-field">
            <MagnifyingGlass className="dim" />
            <input
              className="input grow"
              placeholder={`A ${platformName(at)} tag to link`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") (e.stopPropagation(), setQ(""));
                if (e.key === "Enter" && needle) link(matches[0]?.name ?? q.trim().replace(/^#/, ""));
              }}
            />
            {platforms.length > 1 && <Select compact value={at} options={platforms.map(([value, label]) => ({ value, label }))} onChange={setPlatform} title="Which platform's tag" />}
          </div>
          {matches.map((t) => {
            const now = d.sourceMap?.[`${at}:${t.name}`];
            return (
              <div key={t.name} className="row word-row">
                <span className="chip">#{t.name}</span>
                <span className="dim small grow">
                  {t.translated ? `${t.translated} · ` : ""}
                  {t.n} brought in{now && now !== id ? ` · gives ${nameOf(now)} now` : ""}
                </span>
                {now === id ? (
                  <span className="dim small">linked</span>
                ) : (
                  <button className="btn sm ghost" onClick={() => link(t.name)} title={`What comes in carrying it gets ${nameOf(id)}`}>
                    <LinkSimple /> Link
                  </button>
                )}
              </div>
            );
          })}
          {needle && !matches.some((t) => t.name.toLowerCase() === needle) && (
            <button className="btn sm ghost" onClick={() => link(q.trim().replace(/^#/, ""))}>
              <Plus /> Link “#{q.trim().replace(/^#/, "")}”
            </button>
          )}
        </div>
      </section>
    </>
  );
}

/**
 * For what carries more than one tag of a "pick one" folder: settle them all at once. Every one
 * keeps one tag; or one tag comes off them all; or every tag of the folder does.
 */
export function ConflictActions({ type, onShow }: { type: string; onShow?: () => void }) {
  const d = useTags((x) => x.data)!;
  const keys = useMemo(() => conflictsOf(d, type), [d, type]);
  // The folder's tags found on them, in tree order, with how many of them carry each.
  const involved = useMemo(() => {
    const count = new Map<string, number>();
    for (const k of keys) for (const id of d.tags[k] ?? []) if (typeOf(id) === type) count.set(id, (count.get(id) ?? 0) + 1);
    return treeOfType(d, type)
      .filter((x) => count.has(x.id))
      .map((x) => ({ value: x.id, label: `${x.name} (${count.get(x.id)})`, indent: x.depth }));
  }, [d, type, keys]);
  const [keep, setKeep] = useState("");
  const [drop, setDrop] = useState("");
  if (!keys.length) return null;
  const pick = (v: string) => (involved.some((x) => x.value === v) ? v : involved[0].value);
  const keepId = pick(keep);
  const dropId = pick(drop);
  const n = plural(keys.length, "thing");
  const store = useTags.getState();
  const takeOff = (ids: string[]) => {
    for (const id of ids) store.setTag(keys, id, false);
  };
  return (
    <div className="conflict-actions">
      <div className="row">
        <span className="tag-folder-warn small">
          <Warning /> {n} carr{keys.length === 1 ? "ies" : "y"} more than one
        </span>
        <span className="grow" />
        {onShow && (
          <button className="btn sm ghost" onClick={onShow} title="See them, to pick one each">
            Show
          </button>
        )}
      </div>
      <div className="conflict-field">
        <span className="small dim">Assign all to</span>
        <div className="row">
          <Select compact value={keepId} options={involved} onChange={setKeep} title="The tag every one of them keeps" />
          <button className="btn sm" onClick={() => void ask({ title: "Assign all", message: <>Give all {n} just <b>{pathOf(d, keepId)}</b>? Their other {type} tags come off.</>, confirm: "Assign" }).then((ok) => ok && store.setTag(keys, keepId, true))}>
            Apply
          </button>
        </div>
      </div>
      <div className="conflict-field">
        <span className="small dim">Remove from all</span>
        <div className="row">
          <Select compact value={dropId} options={involved} onChange={setDrop} title="The tag that comes off every one of them" />
          <button className="btn sm" onClick={() => void ask({ title: "Remove from all", message: <>Take <b>{pathOf(d, dropId)}</b>{descendantsOf(d, dropId).size ? " and its subtags" : ""} off the {n}?</>, confirm: "Remove", danger: true }).then((ok) => ok && takeOff([dropId]))}>
            Remove
          </button>
        </div>
      </div>
      <button className="btn sm danger conflict-all" title={`Take every ${type} tag off them`} onClick={() => void ask({ title: "Remove all", message: <>Take every <b>{type}</b> tag off the {n}? They keep their other tags.</>, confirm: "Remove all", danger: true }).then((ok) => ok && takeOff(involved.map((x) => x.value)))}>
        <Trash /> Remove all
      </button>
    </div>
  );
}
