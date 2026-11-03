import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "../components/Popover";

export interface FitItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** A small count beside it (new works). */
  badge?: string;
  keycap?: string;
  go: () => void;
}

/** How a row of buttons gives way: whole names, then shortened ones, then icons alone. */
type Stage = "full" | "short" | "icons";

/**
 * Buttons that fit their block whatever it holds: whole names while they fit, then shortened names,
 * then (where `icons` tell them apart) icons alone, then as many as fit and "+N" with the rest in a
 * list. Measured again as the block is resized or what it holds changes.
 */
export function FitButtons({ items, icons = true }: { items: FitItem[]; icons?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stages: Stage[] = icons ? ["full", "short", "icons"] : ["full", "short"];
  const [stage, setStage] = useState(0);
  const [shown, setShown] = useState(items.length);
  const [more, setMore] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const sig = items.map((i) => i.id).join("|");

  // The block resized: its size, to start the fitting over.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    setStage(0);
    setShown(items.length);
  }, [sig, size.w, size.h, items.length]);
  // After each render: still spilling, the next way of giving way.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !el.clientHeight) return;
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return;
    if (stage < stages.length - 1) setStage(stage + 1);
    else if (shown > 1) setShown(shown - 1);
  });

  const mode = stages[stage];
  const cut = shown < items.length;
  const visible = cut ? items.slice(0, Math.max(0, shown - 1)) : items;
  const rest = cut ? items.slice(visible.length) : [];
  return (
    <div ref={ref} className={`home-fit ${mode}`}>
      {visible.map((i) => (
        <button key={i.id} className="btn sm home-fit-btn" onClick={i.go} title={i.badge ? `${i.label} (${i.badge})` : i.label}>
          {i.icon}
          {mode !== "icons" && <span className="ellipsis">{i.label}</span>}
          {i.badge && mode !== "icons" && <span className="mono small accent-text">{i.badge}</span>}
          {i.keycap && mode === "full" && <kbd className="kbd">{i.keycap}</kbd>}
        </button>
      ))}
      {cut && (
        <Popover
          open={more}
          onClose={() => setMore(false)}
          width={260}
          trigger={
            <button className={`btn sm home-fit-btn ${more ? "active" : ""}`} onClick={() => setMore(!more)} title={`${rest.length} more`}>
              +{rest.length}
            </button>
          }
        >
          <div className="pop-list">
            {rest.map((i) => (
              <button key={i.id} className="btn sm ghost" onClick={() => (setMore(false), i.go())}>
                {i.icon} <span className="ellipsis">{i.label}</span> {i.badge && <span className="mono small accent-text">{i.badge}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
