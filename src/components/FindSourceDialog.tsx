import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowSquareOut, Check, X } from "@phosphor-icons/react";
import { Modal } from "./Modal";
import { useStore } from "../store";
import { thumbUrl, canThumb } from "../lib/api";
import { useFindImage } from "../findStore";
import { ComparePair } from "./ComparePair";
import { SURE, acceptMatch, notIt, useSources, type SourceFound, type SourceMatch } from "../findSource";

/**
 * What Find source found, picture by picture: yes makes a work the picture's source, no shows the
 * next. Either picture clicked shows the two large side by side, to see whether they are the same.
 */
export function FindSourceDialog() {
  const open = useSources((s) => s.open);
  const found = useSources((s) => s.found);
  const [comparing, setComparing] = useState<{ key: string; at: number } | null>(null);
  const pair = comparing && found.find((f) => f.key === comparing.key);
  if (!open || !found.length) return null;
  if (pair) {
    const m = pair.matches[Math.min(comparing!.at, pair.matches.length - 1)];
    // Esc (or the backdrop) goes back to the list first.
    return (
      <Modal title="The same picture?" onClose={() => setComparing(null)} wide>
        <SourceCompare found={pair} m={m} onBack={() => setComparing(null)} />
      </Modal>
    );
  }
  const sure = found.filter((f) => f.matches[0].similarity >= SURE);
  return (
    <Modal title={`Sources found for ${found.length} picture${found.length === 1 ? "" : "s"}`} onClose={() => useSources.setState({ open: false })} wide>
      <p className="dim">A source said yes to stays with the picture, as if it had come in through Find: its tags linked to yours come in, its artist is suggested in Artists, and its characters help People.</p>
      {sure.length > 1 && (
        <div>
          <button className="btn" onClick={() => sure.forEach((f) => acceptMatch(f.key, f.matches[0]))}>
            <Check /> Yes to the {sure.length} at {Math.round(SURE * 100)}% or more alike
          </button>
        </div>
      )}
      <div className="source-list">
        {found.map((f) => (
          <SourceRow key={f.key} found={f} onCompare={(at) => setComparing({ key: f.key, at })} />
        ))}
      </div>
    </Modal>
  );
}

/** Your picture and the work found for it, large and side by side; yes or not it from there too. */
function SourceCompare({ found, m, onBack }: { found: SourceFound; m: SourceMatch; onBack: () => void }) {
  const items = useStore((s) => s.allItems);
  const it = useMemo(() => items.find((i) => i.key === found.key), [items, found.key]);
  return (
    <div className="source-compare">
      <ComparePair
        item={it}
        name={found.key.split("/").pop() ?? found.key}
        pluginId={m.pluginId}
        workId={m.item.id}
        thumb={m.item.thumb}
        caption={
          <>
            <b>{m.name}</b> · {m.item.title || "Untitled"}
            {m.item.width > 0 && m.item.height > 0 && <span className="dim mono"> · {m.item.width}×{m.item.height}</span>}
          </>
        }
      />
      <div className="row source-compare-acts">
        <button className="btn sm ghost" onClick={onBack}>
          <ArrowLeft /> Back <kbd className="kbd">Esc</kbd>
        </button>
        <span className={`badge ${m.similarity >= SURE ? "accent2" : ""}`}>{Math.round(m.similarity * 100)}% alike</span>
        <span className="grow" />
        {m.item.url && (
          <button className="btn sm ghost" onClick={() => void openUrl(m.item.url!)} title={`Open it on ${m.name} in your browser`}>
            <ArrowSquareOut />
          </button>
        )}
        <button className="btn sm ghost" onClick={() => (notIt(found.key, m), onBack())} title="Not this one: the next match, or none">
          <X /> Not it
        </button>
        <button className="btn sm primary" onClick={() => (acceptMatch(found.key, m), onBack())} title="Keep it as this picture's source">
          <Check /> Yes
        </button>
      </div>
    </div>
  );
}

function SourceRow({ found, onCompare }: { found: SourceFound; onCompare: (at: number) => void }) {
  const root = useStore((s) => s.root);
  const items = useStore((s) => s.allItems);
  const it = useMemo(() => items.find((i) => i.key === found.key), [items, found.key]);
  const [at, setAt] = useState(0);
  const m = found.matches[Math.min(at, found.matches.length - 1)];
  const img = useFindImage(m.pluginId, m.item.thumb);
  const alike = Math.round(m.similarity * 100);
  const who = m.item.tags.filter((t) => t.kind === "character").map((t) => t.name.replace(/_/g, " "));
  const from = m.item.tags.filter((t) => t.kind === "series").map((t) => t.name.replace(/_/g, " "));
  return (
    <div className="source-row">
      <button className="source-pic" title={`${it?.name ?? found.key}: yours. Click to see the two large`} onClick={() => onCompare(at)}>
        {it && root && canThumb(it) ? <img src={thumbUrl(root, it, 160)} alt="" /> : <span className="dim small">{found.key.split("/").pop()}</span>}
      </button>
      <button className="source-pic" title={`${m.item.title || "Untitled"}: on ${m.name}. Click to see the two large`} onClick={() => onCompare(at)}>
        {img.src ? <img src={img.src} alt="" /> : <span className="dim small">{img.failed ? "No picture" : "…"}</span>}
      </button>
      <div className="source-what">
        <div className="row">
          <b className="ellipsis">{m.item.title || "Untitled"}</b>
          <span className={`badge ${m.similarity >= SURE ? "accent2" : ""}`}>{alike}% alike</span>
        </div>
        <div className="small dim ellipsis">
          {m.item.author.name || "Unknown artist"} · {m.name}
          {m.item.adult ? " · adult" : ""}
        </div>
        {(who.length > 0 || from.length > 0) && <div className="small ellipsis">{[who.join(", "), from.join(", ")].filter(Boolean).join(" · from ")}</div>}
        {found.matches.length > 1 && (
          <button className="btn sm ghost" onClick={() => setAt((at + 1) % found.matches.length)}>
            Another match ({Math.min(at, found.matches.length - 1) + 1} of {found.matches.length})
          </button>
        )}
      </div>
      <div className="source-acts">
        <button className="btn sm primary" onClick={() => acceptMatch(found.key, m)} title="Keep it as this picture's source">
          <Check /> Yes
        </button>
        <button className="btn sm ghost" onClick={() => (setAt(0), notIt(found.key, m))} title="Not this one: the next match, or none">
          <X /> Not it
        </button>
        {m.item.url && (
          <button className="btn sm ghost" onClick={() => void openUrl(m.item.url!)} title={`Open it on ${m.name} in your browser`}>
            <ArrowSquareOut />
          </button>
        )}
      </div>
    </div>
  );
}
