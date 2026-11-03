import { useMemo, useState, type ReactNode } from "react";
import { useTags, tagKeysFor, ancestorsOf, nameOf, pathOf, telling, treeOfType, typeOf, type Suggestion } from "../tagsStore";
import { useAsync } from "../lib/useAsync";
import { moveIntoBucket, useStore } from "../store";
import { inTarget } from "../lib/filing";
import type { Target } from "../lib/types";
import { Plus, RadioButton, X } from "@phosphor-icons/react";
import { PlaceSelect, adoptWord, whyText } from "./TagBits";

const NO_TAGS: Suggestion[] = [];
/**
 * The "pick one" folders of some items, without a dropdown each: a folder with a pick shows it as
 * a chip with a radio dot among the other tags (`children`), the ones without as a single row of
 * "+ folder" buttons. Either opens that folder's choices just below, inline; a choice takes the
 * place of the one there was. "mixed" shows when the items differ, or one carries two.
 */
export function PickOne({ keys, children, empty }: { keys: string[]; children?: ReactNode; empty?: ReactNode }) {
  const d = useTags((s) => s.data);
  const setTag = useTags((s) => s.setTag);
  const [open, setOpen] = useState<string | null>(null);
  const folders = useMemo(() => {
    if (!d?.exclusive?.length || !keys.length) return [];
    return d.exclusive
      .map((type) => {
        const options = treeOfType(d, type);
        // Each item's pick: none (""), the deepest tag of the one branch it carries (midnight, with night
        // above it), or null when it carries two branches.
        const on = new Set(
          keys.map((k) => {
            const mine = (d.tags[k] ?? []).filter((id) => typeOf(id) === type);
            if (!mine.length) return "";
            return mine.find((x) => mine.every((y) => y === x || ancestorsOf(d, x).includes(y))) ?? null;
          }),
        );
        // "" none; a tag id; null mixed (they differ, or one carries two).
        const value = on.size === 1 ? [...on][0] : null;
        return { type, options, value };
      })
      .filter((f) => f.options.length);
  }, [d, keys]);
  const picked = folders.filter((f) => f.value !== "");
  const unset = folders.filter((f) => f.value === "");
  const choosing = folders.find((f) => f.type === open);
  const choose = (type: string, id: string) => {
    if (id) setTag(keys, id, true);
    else for (const o of folders.find((f) => f.type === type)?.options ?? []) setTag(keys, o.id, false);
    setOpen(null);
  };
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <>
      <div className="chips">
        {picked.map((f) => (
          <button key={f.type} type="button" className={`chip pick ${open === f.type ? "active" : ""}`} onClick={() => setOpen(open === f.type ? null : f.type)} title={`${f.type}${f.value ? `: ${pathOf(d!, f.value)}` : ""} (pick one): click to switch`}>
            <RadioButton weight="fill" /> {f.value ? nameOf(f.value) : "mixed"} <span className="dim small">{f.type}</span>
          </button>
        ))}
        {children}
        {!picked.length && !hasChildren && empty}
      </div>
      {unset.length > 0 && (
        <div className="pick-one-add">
          {unset.map((f) => (
            <button key={f.type} type="button" className={`btn sm ${open === f.type ? "active" : "ghost"}`} onClick={() => setOpen(open === f.type ? null : f.type)} title={`Pick one of ${f.type}`}>
              <Plus /> {f.type}
            </button>
          ))}
        </div>
      )}
      {choosing && (
        <div className="pick-one-choices" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(null))}>
          <span className="label">{choosing.type}</span>
          <div className="chips">
            <button type="button" className={`chip ${choosing.value === "" ? "active" : ""}`} onClick={() => choose(choosing.type, "")}>
              none
            </button>
            {choosing.options.map((o) => (
              <button key={o.id} type="button" className={`chip ${choosing.value === o.id ? "active" : ""}`} style={o.depth ? { marginLeft: o.depth * 10 } : undefined} title={pathOf(d!, o.id)} onClick={() => choose(choosing.type, o.id)} autoFocus={choosing.value === o.id}>
                {choosing.value === o.id ? <RadioButton weight="fill" /> : <RadioButton />} {o.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** A tag to put on something: typed as type/name or just a name, with the known tags offered as you type. */
export function TagPicker({ onAdd, placeholder = "Add a tag (type/name or name)…", autoFocus, defaultType }: { onAdd: (id: string) => void; placeholder?: string; autoFocus?: boolean; defaultType?: string }) {
  const d = useTags((s) => s.data);
  const [text, setText] = useState("");
  const known = useMemo(() => (d ? [...new Set(Object.values(d.tags).flat())].sort() : []), [d]);
  const q = text.trim().toLowerCase();
  const matches = q ? known.filter((id) => id.toLowerCase().includes(q)).slice(0, 8) : [];
  const commit = (id: string) => {
    const clean = id.trim().replace(/\s*\/\s*/, "/");
    if (!clean) return;
    const types = d?.types ?? [];
    const full = clean.includes("/") ? clean : `${defaultType || types[0] || "tags"}/${clean}`;
    useTags.getState().addTag(full);
    onAdd(full);
    setText("");
  };
  return (
    <form
      className="tags-add"
      onSubmit={(e) => {
        e.preventDefault();
        const exact = matches.find((id) => id.toLowerCase() === q || id.toLowerCase().endsWith(`/${q}`));
        commit(exact ?? text);
      }}
    >
      <input className="input" placeholder={placeholder} value={text} autoFocus={autoFocus} onChange={(e) => setText(e.target.value)} />
      {matches.length > 0 && (
        <div className="chips">
          {matches.map((id) => (
            <button key={id} type="button" className="chip" onClick={() => commit(id)}>
              {id}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

/** The tags on some items, as chips with a remove, plus the picker. */
/**
 * Which bucket the pictures are in (Professional, Private…), as a "pick one": read from where they
 * are, and setting it moves them there (filed by the day). Only for pictures, not whole albums.
 */
function BucketRow({ keys }: { keys: string[] }) {
  const library = useStore((x) => x.library);
  const buckets = useMemo(() => library?.targets.filter((t) => t.bucket) ?? NO_BUCKETS, [library]);
  const all = useStore((x) => x.allItems);
  const items = useMemo(() => {
    const want = new Set(keys);
    return all.filter((i) => want.has(i.key) && !i.albumKey);
  }, [all, keys]);
  const [moving, setMoving] = useState(false);
  // A bucket folder in Tags shows the same, as its own pick-one row.
  const asTags = useTags((x) => !!x.data?.places?.length);
  if (asTags || !buckets.length || !items.length) return null;
  const into = async (id: string) => {
    setMoving(true);
    try {
      await moveIntoBucket(items, id);
    } finally {
      setMoving(false);
    }
  };
  return (
    <div className="chips bucket-row">
      <span className="label">Bucket</span>
      {buckets.map((b) => {
        const n = items.filter((i) => inTarget(i, b, library!.targets)).length;
        return (
          <button key={b.id} disabled={moving} className={`chip ${n === items.length ? "active" : n ? "partial" : ""}`} onClick={() => void into(b.id)} title={n === items.length ? `In ${b.name}` : `Move ${items.length === 1 ? "it" : `${items.length - n}`} into ${b.name}`}>
            <RadioButton weight={n === items.length ? "fill" : "regular"} /> {b.name}
          </button>
        );
      })}
    </div>
  );
}
const NO_BUCKETS: Target[] = [];

export function TagEditor({ keys: rawKeys }: { keys: string[] }) {
  // A page of an album is tagged as the whole album.
  const joined = rawKeys.join("\n");
  const keys = useMemo(() => tagKeysFor(rawKeys), [joined]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = useTags((s) => s.data);
  const setTag = useTags((s) => s.setTag);
  const models = useTags((s) => s.models);
  const names = useTags((s) => s.names);
  const suggestions = useAsync(keys.join("\n"), () => (d && keys.length ? useTags.getState().suggest(keys) : NO_TAGS), [d, models, names], NO_TAGS);
  // Words the tagger saw that are no tag of yours yet: one click makes the tag.
  const fresh = useMemo(() => {
    if (!d || !names || !keys.length) return [] as { name: string; p: number }[];
    const best = new Map<string, number>();
    for (const k of keys) for (const [name, p] of useTags.getState().autoOf(k).slice(0, 30)) best.set(name, Math.max(best.get(name) ?? 0, p));
    const taken = new Set([...Object.keys(d.autoMap ?? {}), ...(d.ignoredWords ?? [])]);
    const known = new Set([...new Set(Object.values(d.tags).flat())].map((id) => id.slice(id.indexOf("/") + 1).toLowerCase().replace(/ /g, "_")));
    const index = new Map(names.map((x, i) => [x.name, i]));
    // How sure, times how much it says: a word on every manga page ("comic") says nothing.
    return [...best]
      .map(([name, p]) => ({ name, p, score: p * telling(d, index.get(name) ?? -1) }))
      .filter((x) => x.p >= 0.35 && x.score > 0 && !taken.has(x.name) && !known.has(x.name.toLowerCase()))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ name, p }) => ({ name, p }));
  }, [d, keys, names]);
  const [making, setMaking] = useState<{ auto: string; name: string; place: string } | null>(null);
  if (!d) return null;
  const count = new Map<string, number>();
  for (const k of keys) for (const id of d.tags[k] ?? []) count.set(id, (count.get(id) ?? 0) + 1);
  // A "pick one" folder's tag shows as its own chip (PickOne).
  const sole = new Set(d.exclusive ?? []);
  const on = [...count].filter(([id]) => !sole.has(typeOf(id))).map(([id, n]) => ({ id, all: n === keys.length })).sort((a, b) => a.id.localeCompare(b.id));
  return (
    <div className="tag-editor">
      <BucketRow keys={rawKeys} />
      <PickOne keys={keys} empty={<span className="dim small">No tags yet.</span>}>
        {on.map(({ id, all }) => (
          <span key={id} className={`chip ${all ? "" : "partial"}`} title={all ? id : `${id} (on some)`}>
            {id.slice(id.indexOf("/") + 1)}
            <button className="chip-x" title="Take this tag off" onClick={() => setTag(keys, id, false)}>
              <X />
            </button>
          </span>
        ))}
      </PickOne>
      {suggestions.length > 0 && (
        <div className="chips">
          {suggestions.filter((sg) => !d.places?.includes(typeOf(sg.tag))).map((sg) => (
            <button key={sg.tag} className="chip suggest" onClick={() => setTag(keys, sg.tag, true)} title={`${Math.round(sg.score * 100)}%: ${whyText(sg.why)}${sg.note ? `; ${sg.note}` : ""}`}>
              <Plus /> {sg.tag.slice(sg.tag.indexOf("/") + 1)} <span className="dim mono small">{Math.round(sg.score * 100)}</span>
            </button>
          ))}
        </div>
      )}
      {fresh.length > 0 && !making && (
        <div className="chips" title="Seen by the tagger; not a tag of yours yet">
          {fresh.map((f) => (
            <button
              key={f.name}
              className="chip suggest new"
              onClick={() => setMaking({ auto: f.name, name: f.name.replace(/_/g, " "), place: `in:${d.types[0] ?? "tags"}` })}
              onContextMenu={(e) => {
                e.preventDefault();
                useTags.getState().ignoreWord(f.name, true);
                useStore.getState().toast(`“${f.name.replace(/_/g, " ")}” won't be offered as a tag again.`, "ok");
              }}
              title={`${Math.round(f.p * 100)}%: make this a tag (right-click: never offer it)`}
            >
              <Plus /> {f.name.replace(/_/g, " ")} <span className="dim mono small">new</span>
            </button>
          ))}
        </div>
      )}
      {making && (
        <form
          className="tag-make"
          onSubmit={(e) => {
            e.preventDefault();
            const id = adoptWord(making.auto, making.name, making.place);
            if (!id) return;
            setTag(keys, id, true);
            setMaking(null);
          }}
        >
          <div className="label">New tag from “{making.auto.replace(/_/g, " ")}”</div>
          <div className="row">
            <input className="input grow" autoFocus value={making.name} onChange={(e) => setMaking({ ...making, name: e.target.value })} placeholder="Name" />
            <PlaceSelect value={making.place} onChange={(place) => setMaking({ ...making, place })} />
          </div>
          <div className="row">
            <button className="btn sm primary" type="submit">
              Add
            </button>
            <button className="btn sm ghost" type="button" onClick={() => setMaking(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <TagPicker onAdd={(id) => setTag(keys, id, true)} autoFocus />
    </div>
  );
}
