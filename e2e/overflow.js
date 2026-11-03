// What spills where it shouldn't, run in the page: text running past its own box, anything past the
// window's edge with nothing to scroll it into view, and anything past the nearest box around it
// that shows an edge (a border, a fill, a panel): spilling out of it, or cut off by it if it's
// words. However it's placed: a badge pushed out of its tile counts as much as a wrapped line.
// Squeezed too, though nothing spills: a short label broken over lines, or a name its ellipsis cuts
// to a few letters. Pictures are left out (cropping them is meant), and so are menus and popovers,
// which stand out of their boxes by design. Each element once, the furthest out first.
export function findOverflow() {
  const found = [];
  const vw = window.innerWidth;
  const styles = new Map();
  const cs = (el) => {
    let s = styles.get(el);
    if (!s) styles.set(el, (s = getComputedStyle(el)));
    return s;
  };
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    const cls = [...el.classList].slice(0, 3).join(".");
    if (cls) s += "." + cls;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 48);
    return text ? `${s} “${text}”` : s;
  };
  const scrollsX = (el) => ["auto", "scroll"].includes(cs(el).overflowX);
  const clips = (el, axis) => ["auto", "scroll", "hidden", "clip"].includes(cs(el)[axis]);
  const scrolledBy = (el) => {
    for (let a = el.parentElement; a; a = a.parentElement) if (scrollsX(a)) return true;
    return false;
  };
  const edged = (el) => {
    const s = cs(el);
    return (s.borderRightWidth !== "0px" && s.borderRightStyle !== "none") || (s.borderBottomWidth !== "0px" && s.borderBottomStyle !== "none") || s.backgroundColor !== "rgba(0, 0, 0, 0)" || el.classList.contains("panel") || el.classList.contains("btn");
  };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());

  if (document.documentElement.scrollWidth > vw + 1) found.push({ what: "the page scrolls sideways", by: document.documentElement.scrollWidth - vw, el: "html" });
  for (const el of document.querySelectorAll("body *")) {
    if (["IMG", "VIDEO", "CANVAS", "svg", "path", "IFRAME", "OPTION", "BR", "INPUT", "TEXTAREA"].includes(el.tagName)) continue;
    if (el.closest(".plugin-frames, [aria-hidden='true'], svg, .pop, .menu, [role='menu'], [role='listbox'], [role='tooltip']") || el.parentElement?.closest(".face-crop")) continue;
    // What a closed fold holds isn't drawn, though it still has boxes.
    if (el.closest("details:not([open]) > :not(summary)")) continue;
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const text = ownText(el);
    if (text && s.overflowX === "visible" && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2) found.push({ what: "its text runs past its edge", by: el.scrollWidth - el.clientWidth, el: describe(el) });
    if ((r.right > vw + 1 || r.left < -1) && s.position !== "fixed" && !scrolledBy(el)) found.push({ what: "past the window's edge", by: Math.round(Math.max(r.right - vw, -r.left)), el: describe(el) });
    if (s.position === "fixed") continue;
    // The nearest box with an edge, and whether anything on the way (or it) clips or scrolls.
    let box = null;
    let x = "free";
    let y = "free";
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (scrollsX(a)) x = "scrolls";
      else if (x === "free" && clips(a, "overflowX")) x = "clips";
      if (["auto", "scroll"].includes(cs(a).overflowY)) y = "scrolls";
      else if (y === "free" && clips(a, "overflowY")) y = "clips";
      if (edged(a)) {
        box = a;
        break;
      }
    }
    if (!box) continue;
    const b = box.getBoundingClientRect();
    const outX = Math.max(r.right - b.right, b.left - r.left);
    const outY = Math.max(r.bottom - b.bottom, b.top - r.top);
    for (const [out, how] of [
      [outX, x],
      [outY, y],
    ]) {
      if (out <= 2 || how === "scrolls") continue;
      if (how === "free") found.push({ what: "spills out of the box around it", by: Math.round(out), el: describe(el) });
      else if (text) found.push({ what: "cut off by the box around it", by: Math.round(out), el: describe(el) });
    }
  }
  // A box that scrolls up and down (a sidebar, a list) also scrolling sideways: something in it is
  // too wide. One meant to scroll sideways (a strip) doesn't scroll up and down.
  for (const el of document.querySelectorAll("body *")) {
    const s = cs(el);
    if (!["auto", "scroll"].includes(s.overflowY) || !["auto", "scroll"].includes(s.overflowX) || s.display === "none") continue;
    if (el.scrollWidth > el.clientWidth + 2) found.push({ what: "scrolls sideways", by: el.scrollWidth - el.clientWidth, el: describe(el).slice(0, 80) });
  }
  // Tiles placed by hand (absolutely, side by side) laid over each other.
  const placed = new Map();
  for (const el of document.querySelectorAll("body *")) {
    if (cs(el).position !== "absolute" || !el.parentElement || !el.classList.length) continue;
    const key = [el.parentElement, el.classList[0]];
    const k = placed.get(key[0]) ?? new Map();
    placed.set(key[0], k.set(key[1], [...(k.get(key[1]) ?? []), el]));
  }
  for (const byClass of placed.values()) {
    for (const tiles of byClass.values()) {
      if (tiles.length < 2) continue;
      const rects = tiles.map((el) => [el, el.getBoundingClientRect()]).filter(([, r]) => r.width > 4 && r.height > 4);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const [a, ra] = rects[i];
          const [, rb] = rects[j];
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w > 2 && h > 2) found.push({ what: "laid over another like it", by: Math.round(Math.min(w, h)), el: describe(a) });
        }
      }
    }
  }
  // Words drawn over other words, in the same layer (a menu, a dialog, a bar kept in place or a
  // panel floating over the page, stacked high, is above it on purpose).
  const floats = (a) => cs(a).position === "absolute" && (a.classList.contains("panel") || Number(cs(a).zIndex) >= 10);
  const layerOf = (el) => {
    for (let a = el; a; a = a.parentElement) if (["fixed", "sticky"].includes(cs(a).position) || floats(a) || a.matches(".pop, .menu, [role='menu'], [role='dialog'], .modal, .toast, [role='tooltip']")) return a;
    return null;
  };
  const words = [];
  for (const el of document.querySelectorAll("body *")) {
    if (!ownText(el) || el.closest("[aria-hidden='true'], .plugin-frames, details:not([open]) > :not(summary)")) continue;
    const s = cs(el);
    if (s.visibility === "hidden" || Number(s.opacity) < 0.05) continue;
    // Only what shows: cut down to every box on the way that clips or scrolls.
    const b = el.getBoundingClientRect();
    const r = { left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(vw, b.right), bottom: Math.min(window.innerHeight, b.bottom) };
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      if (cs(a).overflowX === "visible" && cs(a).overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      r.left = Math.max(r.left, c.left);
      r.top = Math.max(r.top, c.top);
      r.right = Math.min(r.right, c.right);
      r.bottom = Math.min(r.bottom, c.bottom);
    }
    if (r.right - r.left < 1 || r.bottom - r.top < 1) continue;
    words.push({ el, r, layer: layerOf(el) });
  }
  words.sort((a, b) => a.r.top - b.r.top);
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    for (let j = i + 1; j < words.length && words[j].r.top < a.r.bottom - 2; j++) {
      const b = words[j];
      if (a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 3 && h > 3) found.push({ what: `words over “${(b.el.textContent || "").trim().slice(0, 24)}”`, by: Math.round(Math.min(w, h)), el: describe(a.el) });
    }
  }
  // Squeezed, though nothing spills: a short label (a badge, a count, a button's words) broken over
  // lines, and a name cut down to a few letters by its ellipsis.
  for (const el of document.querySelectorAll("body *")) {
    if (!ownText(el) || el.closest("[aria-hidden='true'], .plugin-frames, details:not([open]) > :not(summary), .pop, .menu, [role='menu'], [role='tooltip']")) continue;
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) continue;
    const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim().replace(/\s+/g, " ");
    if (!text) continue;
    if (s.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const shown = Math.floor((text.length * el.clientWidth) / el.scrollWidth);
      if (shown < 5 && text.length > shown + 1) found.push({ what: `cut to “${text.slice(0, Math.max(1, shown))}…”`, by: text.length - shown, el: describe(el) });
      continue;
    }
    if (text.length > 24 || text.split(" ").length > 5 || s.whiteSpace === "pre-wrap") continue;
    const lines = new Set();
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1) lines.add(Math.round(r.top));
    }
    if (lines.size > 1) found.push({ what: `broken over ${lines.size} lines`, by: lines.size, el: describe(el) });
  }
  const once = new Map();
  for (const f of found) if (!once.has(f.el) || once.get(f.el).by < f.by) once.set(f.el, f);
  return [...once.values()].sort((a, b) => b.by - a.by);
}
