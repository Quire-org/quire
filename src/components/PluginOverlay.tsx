import { useLayoutEffect, useRef, useState } from "react";
import { usePlugins } from "../plugins/store";
import type { OverlayBox } from "../plugins/types";

/**
 * Text and image boxes plugins placed over an image, positioned in fractions
 * of the image so they follow fit, fill and the loupe. Each text box shrinks
 * its text until it fits; an image box (a cleaned-up page, say) is stretched
 * to its box.
 */
export function PluginOverlay({ itemKey }: { itemKey: string }) {
  const byPlugin = usePlugins((s) => s.overlays[itemKey]);
  const hidden = usePlugins((s) => s.overlaysHidden);
  const ref = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bump = () => setTick((t) => t + 1);
    const ro = new ResizeObserver(bump);
    ro.observe(el);
    // Text is fitted by measuring, so fit again once the overlay font arrives.
    document.fonts?.addEventListener("loadingdone", bump);
    void document.fonts?.ready.then(bump);
    return () => {
      ro.disconnect();
      document.fonts?.removeEventListener("loadingdone", bump);
    };
  }, []);
  const boxes = byPlugin ? Object.values(byPlugin).flat() : [];
  return (
    <div ref={ref} className={`plugin-overlay ${hidden ? "hidden" : ""}`}>
      {!hidden && boxes.map((b, i) => (b.image ? <ImageBox key={i} b={b} /> : b.outline ? <Outline key={i} b={b} /> : <Box key={i} b={b} tick={tick} />))}
    </div>
  );
}

/** A highlight: the box's outline only, such as a bar a plugin found. */
function Outline({ b }: { b: OverlayBox }) {
  return <div className="overlay-outline" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} title={b.text || undefined} />;
}

function ImageBox({ b }: { b: OverlayBox }) {
  return <img className="overlay-image" src={b.image} alt="" draggable={false} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} />;
}

function Box({ b, tick }: { b: OverlayBox; tick: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let size = Math.max(9, Math.min(36, el.clientHeight * 0.45, el.clientWidth * 0.3));
    el.style.fontSize = `${size}px`;
    for (let i = 0; i < 40 && size > 7 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1); i++) {
      size -= 1;
      el.style.fontSize = `${size}px`;
    }
  }, [b.text, b.w, b.h, tick]);
  return (
    <div ref={ref} className={`overlay-box ${b.vertical ? "vertical" : ""}`} style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} title={b.text}>
      {b.text}
    </div>
  );
}
