import { useMemo, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { create } from "zustand";
import { Folder, FolderSimplePlus, Plus, RadioButton, Warning } from "@phosphor-icons/react";
import { Thumb } from "./Thumb";
import { Select } from "./Select";
import { useCoverUrl } from "../scrapbook/pictures";
import { ask } from "./Confirm";
import { useStore } from "../store";
import { allTags, conflictsOf, descendantsOf, nameOf, treeOfType, typeOf, useTags, type Suggestion } from "../tagsStore";
import type { MediaItem } from "../lib/types";

/** Pieces of the Tags screen used in more than one of its views: covers, pickers, folders, dragging tags. */

export function Covers({ covers }: { covers: MediaItem[] }) {
  return (
    <div className={`tag-card-covers n${Math.min(4, covers.length)}`}>
      {covers.map((it) => (
        <Thumb key={it.key} item={it} aspect={1} onClick={() => {}} />
      ))}
      {!covers.length && <span className="dim small">empty</span>}
    </div>
  );
}

/** A tag as a card: a few of the things that carry it, its name and count. Right-click for more. */
export function TagCard({ id, name, count, covers, onOpen, onMenu }: { id: string; name: string; count: number; covers: MediaItem[]; onOpen: () => void; onMenu: (e: MouseEvent) => void }) {
  const dragging = useTagDrag((s) => s.id === id);
  // Its Scrapbook banner, when it has one, in place of the previews.
  const banner = useCoverUrl(useTags((s) => s.data?.covers?.[id]));
  return (
    <div className={`tag-card panel ${dragging ? "dragging" : ""}`} onClick={onOpen} onContextMenu={onMenu} title="Click to open; drag into another folder; right-click for rename, merge, delete" {...dragTag(id)}>
      {banner ? <img className="tag-banner" src={banner} alt="" draggable={false} /> : <Covers covers={covers} />}
      <div className="tag-card-foot">
        <span className="ellipsis">{name}</span>
        <span className="mono dim small">{count}</span>
      </div>
    </div>
  );
}

/** Pick one of the known tags, with a filter; for merging, bundling and rules. */
export function MergePicker({ label, tags, onPick, onNew }: { label: string; tags: string[]; onPick: (id: string) => void; onNew?: (name: string) => void }) {
  const [q, setQ] = useState("");
  const matches = tags.filter((id) => id.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const typed = q.trim().replace(/\//g, " ");
  const exact = matches.some((id) => id.toLowerCase() === q.trim().toLowerCase() || id.toLowerCase().endsWith(`/${q.trim().toLowerCase()}`));
  const canNew = !!onNew && !!typed && !exact;
  return (
    <>
      <span className="label">{label}</span>
      <input
        className="input"
        placeholder={onNew ? "a tag, or a new name" : "type to find a tag"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (matches[0] && (!canNew || exact)) onPick(matches[0]);
          else if (canNew) onNew!(typed);
        }}
      />
      <div className="chips">
        {canNew && (
          <button type="button" className="chip suggest" onClick={() => onNew!(typed)} title="Make this tag now and bundle it">
            <Plus /> new “{typed}”
          </button>
        )}
        {matches.map((id) => (
          <button key={id} type="button" className="chip" onClick={() => onPick(id)} title={id}>
            <span className="ellipsis">{id}</span>
          </button>
        ))}
        {!matches.length && !canNew && <span className="dim small">no such tag</span>}
      </div>
    </>
  );
}

export function whyText(why: Suggestion["why"]): string {
  return why === "neighbours" ? "learned from what you tagged and turned down" : why === "words" ? "from the tag's name" : "the tagger saw it";
}

/* ---- dragging tags between folders ---- */

const TAG_DRAG = "application/x-quire-tag";
/** The tag being dragged: folders light up as places it can go. */
export const useTagDrag = create<{ id: string | null }>(() => ({ id: null }));

export function dragTag(id: string) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.stopPropagation();
      e.dataTransfer?.setData(TAG_DRAG, id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      useTagDrag.setState({ id });
    },
    onDragEnd: () => useTagDrag.setState({ id: null }),
  };
}

/** A folder tags can be dropped into (as a top tag there): `over` while one is held above it. */
export function useFolderDrop(type: string) {
  const dragging = useTagDrag((s) => s.id);
  const subtag = useTags((s) => !!dragging && !!s.data?.parents?.[dragging]);
  const [over, setOver] = useState(false);
  const can = !!dragging && (typeOf(dragging) !== type || subtag);
  return {
    over: can && over,
    can,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!can) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer?.getData(TAG_DRAG) || dragging;
        useTagDrag.setState({ id: null });
        if (id && can) void moveTagInto(id, type);
      },
    },
  };
}

/** A tag another can be dropped on, to become its subtag: not itself, not one of its own subtags, not its parent already. */
export function useTagDrop(target: string) {
  const dragging = useTagDrag((s) => s.id);
  const can = useTags((s) => !!dragging && !!s.data && dragging !== target && s.data.parents?.[dragging] !== target && !descendantsOf(s.data, dragging).has(target));
  const [over, setOver] = useState(false);
  return {
    over: can && over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!can) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        if (!can) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const id = e.dataTransfer?.getData(TAG_DRAG) || dragging;
        useTagDrag.setState({ id: null });
        if (id) void makeSubtag(id, target);
      },
    },
  };
}

/** Names a tag and its subtags would take in another folder that are taken there already. */
function clashes(id: string, type: string): string[] {
  const d = useTags.getState().data;
  if (!d || typeOf(id) === type) return [];
  const have = new Set(allTags(d));
  return [id, ...descendantsOf(d, id)].map((x) => `${type}/${nameOf(x)}`).filter((x) => have.has(x));
}

const mergeQuestion = (type: string, taken: string[]) =>
  ask({ title: "Merge tags", message: <><b>{type}</b> has {taken.map(nameOf).join(", ")} already. Merge {taken.length === 1 ? "the two" : "them"}? Everything carrying either carries the one in <b>{type}</b>.</>, confirm: "Merge" });

/** Makes a tag a subtag of another, moving it (with its own subtags) into that one's folder; a name taken there is merged, once that is confirmed. */
export async function makeSubtag(id: string, parent: string): Promise<void> {
  const taken = clashes(id, typeOf(parent));
  if (taken.length && !(await mergeQuestion(typeOf(parent), taken))) return;
  useTags.getState().setParent(id, parent);
  warnConflicts(typeOf(parent));
}

/** Moves a tag (with its subtags) into a folder as a top tag there; names taken there are merged, once that is confirmed. */
export async function moveTagInto(id: string, type: string): Promise<void> {
  const t = useTags.getState();
  if (!t.data || (typeOf(id) === type && !t.data.parents?.[id])) return;
  const taken = clashes(id, type);
  if (taken.length && !(await mergeQuestion(type, taken))) return;
  t.moveTag(id, type);
  warnConflicts(type);
}

/** Renames a tag; a name taken in its folder is a merge, once that is confirmed. */
export async function renameTagTo(id: string, name: string): Promise<void> {
  const t = useTags.getState();
  const d = t.data;
  const clean = name.trim().replace(/\//g, " ");
  if (!d || !clean || clean === nameOf(id)) return;
  const to = `${typeOf(id)}/${clean}`;
  if (allTags(d).includes(to) && !(await ask({ title: "Merge tags", message: <><b>{typeOf(id)}</b> has a <b>{clean}</b> already. Merge <b>{nameOf(id)}</b> into it?</>, confirm: "Merge" }))) return;
  t.renameTag(id, to);
}

/** Two tags as one in filters: into a bundle either is in already, else a new one under the first's name. */
export function bundleTogether(id: string, other: string) {
  const t = useTags.getState();
  const bundles = t.data?.bundles ?? {};
  const existing = Object.entries(bundles).find(([, m]) => m.includes(id) || m.includes(other))?.[0];
  if (existing) return t.setBundle(existing, [...bundles[existing], id, other]);
  let name = nameOf(id);
  for (let n = 2; bundles[name]; n++) name = `${nameOf(id)} ${n}`;
  t.setBundle(name, [id, other]);
}

function warnConflicts(type: string) {
  const d = useTags.getState().data;
  if (!d?.exclusive?.includes(type)) return;
  const n = conflictsOf(d, type).length;
  if (n) useStore.getState().toast(`${n} now carr${n === 1 ? "ies" : "y"} two tags of ${type}, a “one of” folder: its panel shows them to pick one`, "warn");
}

/** Makes a folder "one of", or not; turning it on with things carrying several of its tags asks first. */
export async function toggleExclusive(type: string) {
  const t = useTags.getState();
  const d = t.data;
  if (!d) return;
  const on = !d.exclusive?.includes(type);
  const n = on ? conflictsOf(d, type).length : 0;
  if (n && !(await ask({ title: `Make ${type} “one of”`, message: <>{n} thing{n === 1 ? "" : "s"} carr{n === 1 ? "ies" : "y"} more than one tag of <b>{type}</b>. They keep them until you pick one; the folder shows them.</>, confirm: "Make it one of" }))) return;
  t.setExclusive(type, on);
}

export async function removeFolder(type: string, tags: number, uses: number) {
  if (tags && !(await ask({ title: "Remove tag folder", message: <>Remove <b>{type}</b> and its {tags} tag{tags === 1 ? "" : "s"}? They come off the {uses} thing{uses === 1 ? "" : "s"} carrying them.</>, confirm: "Remove", danger: true, safeDefault: true }))) return;
  useTags.getState().removeType(type);
}

/* ---- the folders on the main view ---- */

/**
 * A tag folder as a box with all its tags as chips. Clicking the box opens its settings in the
 * side panel, a chip opens the tag's; a chip drags into another folder. A "pick one" folder shows
 * its tags as choices (a radio dot each) and what carries two of them.
 */
export interface TagNode {
  id: string;
  name: string;
  count: number;
  depth: number;
}

/** A tag chip that drags, and takes another dropped on it as its subtag; its subtags grouped after it. */
function TagChip({ node, kids, exclusive, selectedTag, onOpenTag, onMenu }: { node: TagNode; kids: Map<string, TagNode[]>; exclusive: boolean; selectedTag: string | null; onOpenTag: (id: string) => void; onMenu: (e: MouseEvent, id: string) => void }) {
  const dragging = useTagDrag((s) => s.id);
  const drop = useTagDrop(node.id);
  const subs = kids.get(node.id) ?? [];
  const chip = (
    <button
      className={`chip tag-chip ${node.depth ? "sub" : ""} ${dragging === node.id ? "dragging" : ""} ${selectedTag === node.id ? "active" : ""} ${drop.over ? "drop-over" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpenTag(node.id);
      }}
      onContextMenu={(e) => onMenu(e, node.id)}
      title={`${node.name}: ${node.count} carry it. Click for its settings; drag into another folder, or onto a tag to make it a subtag`}
      {...dragTag(node.id)}
      {...drop.props}
    >
      {exclusive && !node.depth && <RadioButton className="dim" />}
      <span className="ellipsis">{node.name}</span>
      <span className="dim mono small">{node.count}</span>
    </button>
  );
  if (!subs.length) return chip;
  return (
    <span className="chip-tree">
      {chip}
      {subs.map((k) => (
        <TagChip key={k.id} node={k} kids={kids} exclusive={exclusive} selectedTag={selectedTag} onOpenTag={onOpenTag} onMenu={onMenu} />
      ))}
    </span>
  );
}

/** A tag's row in a list (beside a grid, in a folder's panel): indented under its parent, draggable, a drop target for subtags. */
export function TagRow({ node, active, icon, onOpen, onMenu, extra }: { node: TagNode; active: boolean; icon: ReactNode; onOpen: () => void; onMenu?: (e: MouseEvent) => void; extra?: ReactNode }) {
  const dragging = useTagDrag((s) => s.id);
  const drop = useTagDrop(node.id);
  return (
    <div className={`tags-row tag ${active ? "active" : ""} ${dragging === node.id ? "dragging" : ""} ${drop.over ? "drop-over" : ""}`} style={{ paddingLeft: 16 + node.depth * 14 }} onClick={onOpen} onContextMenu={onMenu} title="Click for its settings; drag into another folder, or onto a tag to make it a subtag" {...dragTag(node.id)} {...drop.props}>
      {icon} <span className="ellipsis">{node.name}</span>
      <span className="count">{node.count}</span>
      {extra}
    </div>
  );
}

/** Subtags under their parents: parent id -> its subtags, from a folder's tags in tree order. */
function kidsOf(tags: TagNode[]): { roots: TagNode[]; kids: Map<string, TagNode[]> } {
  const roots: TagNode[] = [];
  const kids = new Map<string, TagNode[]>();
  const stack: TagNode[] = [];
  for (const x of tags) {
    stack.length = Math.min(stack.length, x.depth);
    const p = stack[stack.length - 1];
    if (p) kids.set(p.id, [...(kids.get(p.id) ?? []), x]);
    else roots.push(x);
    stack.push(x);
  }
  return { roots, kids };
}

export function FolderPanel({ type, tags, carriers, exclusive, conflicts, selected, selectedTag, onSelect, onOpenTag, onMenu }: { type: string; tags: TagNode[]; carriers: number; exclusive: boolean; conflicts: number; selected: boolean; selectedTag: string | null; onSelect: () => void; onOpenTag: (id: string) => void; onMenu: (e: MouseEvent, id: string) => void }) {
  const drop = useFolderDrop(type);
  const tree = useMemo(() => kidsOf(tags), [tags]);
  return (
    <div className={`tag-folder panel ${exclusive ? "exclusive" : ""} ${selected ? "selected" : ""} ${drop.over ? "drop-over" : ""} ${drop.can ? "drop-can" : ""}`} onClick={onSelect} title={`${type}: click for its settings`} {...drop.props}>
      <div className="tag-folder-head">
        <Folder /> <strong className="ellipsis">{type}</strong>
        {exclusive && (
          <span className="badge" title="Pick one: at most one of these tags on anything">
            pick one
          </span>
        )}
        <span className="grow" />
        <span className="dim small" title={`${tags.length} tags in this folder; ${carriers} pictures or albums carry at least one`}>
          {tags.length} tag{tags.length === 1 ? "" : "s"} · {carriers} tagged
        </span>
      </div>
      {conflicts > 0 && (
        <span className="tag-folder-warn small">
          <Warning /> {conflicts} carr{conflicts === 1 ? "ies" : "y"} more than one
        </span>
      )}
      <div className="chips">
        {tree.roots.map((tag) => (
          <TagChip key={tag.id} node={tag} kids={tree.kids} exclusive={exclusive} selectedTag={selectedTag} onOpenTag={onOpenTag} onMenu={onMenu} />
        ))}
        {!tags.length && <span className="dim small">{drop.can ? "Drop a tag here" : "No tags yet: click to add one, or drag one in."}</span>}
        {tags.length > 0 && drop.can && <span className="dim small">Drop here: a top tag of {type}</span>}
      </div>
    </div>
  );
}

export function NewFolderPanel() {
  const [name, setName] = useState("");
  return (
    <form
      className="tag-folder panel new"
      onSubmit={(e) => {
        e.preventDefault();
        useTags.getState().addType(name);
        setName("");
      }}
    >
      <div className="row">
        <FolderSimplePlus />
        <input className="input grow" placeholder="New folder (month, motives, time of day…)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn sm ghost" type="submit" title="Add a tag folder" disabled={!name.trim()}>
          <Plus />
        </button>
      </div>
    </form>
  );
}


/* ---- making a tagger word one of your tags ---- */

/**
 * Where a new tag goes: into a folder ("in:<folder>"), or under a tag as its subtag ("under:<id>").
 * Its list has a filter field, so a long list of tags stays quick.
 */
export function PlaceSelect({ value, onChange }: { value: string; onChange: (place: string) => void }) {
  const d = useTags((s) => s.data);
  const options = useMemo(
    () =>
      d
        ? [
            ...d.types.map((ty) => ({ value: `in:${ty}`, label: ty, group: "In a folder" })),
            ...d.types.flatMap((ty) => treeOfType(d, ty).map((x) => ({ value: `under:${x.id}`, label: x.depth ? x.name : `${ty} / ${x.name}`, group: "As a subtag of", indent: x.depth }))),
          ]
        : [],
    [d],
  );
  if (!d) return null;
  return <Select compact searchable value={value} options={options} onChange={onChange} title="A folder, or a tag to put it under as a subtag" />;
}

/** A tagger word made a tag of yours, in a folder or under a tag (see PlaceSelect): linked, so the tagger suggests it. The new tag's id. */
export function adoptWord(word: string, name: string, place: string): string | null {
  const t = useTags.getState();
  const clean = name.trim().replace(/\//g, " ");
  if (!clean || !t.data) return null;
  const parent = place.startsWith("under:") ? place.slice(6) : null;
  const id = `${parent ? typeOf(parent) : place.slice(3)}/${clean}`;
  t.adoptAuto(word, id);
  if (parent && parent !== id) t.setParent(id, parent);
  return id;
}
