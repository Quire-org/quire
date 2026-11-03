// Made-up pictures for the browser preview and the end-to-end tests: each path of the mock volume
// stands for a drawing of a face (a photo's person or a drawing's character), the same every time.
// The mock's face finder (mock.ts) and the test file server (e2e/server.mjs) both use this, so a
// face's box is where the picture shows the face. Nothing here is anyone real.

/** Who can turn up: six people (photos) and three characters (drawings). */
export const MOCK_WHO = [
  { label: "p0", kind: "photo", skin: "#e0b08a", hair: "#3b2a1e", bg: ["#4b6a88", "#a7c2d8"] },
  { label: "p1", kind: "photo", skin: "#c68a62", hair: "#151515", bg: ["#5d7c4a", "#b9d39c"] },
  { label: "p2", kind: "photo", skin: "#f1c9a5", hair: "#b8862f", bg: ["#7a4b5c", "#d9a9b7"] },
  { label: "p3", kind: "photo", skin: "#8d5a3b", hair: "#2b1a12", bg: ["#3e3e5c", "#9a9ac8"] },
  { label: "p4", kind: "photo", skin: "#e8bfa0", hair: "#9a9a9a", bg: ["#6a5a3a", "#d8c49a"] },
  { label: "p5", kind: "photo", skin: "#d9a07c", hair: "#6b2f1a", bg: ["#2f5f5f", "#8fd0c8"] },
  { label: "c0", kind: "drawn", skin: "#fde3d0", hair: "#e83e8c", bg: ["#ffe9a8", "#ffd1e8"] },
  { label: "c1", kind: "drawn", skin: "#fbe0cc", hair: "#3e7bfa", bg: ["#d8f3ff", "#c9d6ff"] },
  { label: "c2", kind: "drawn", skin: "#fde6d4", hair: "#38c172", bg: ["#e6ffe0", "#fff3c4"] },
];

/** FNV-1a, mixed at the end so that every bit (and so who it is, by remainder) varies. */
function hash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The picture a path stands for: its size, who is in it, and where their face is (fractions). */
export function mockPicture(rel) {
  const h = hash(rel);
  const who = MOCK_WHO[h % MOCK_WHO.length];
  const tall = (h >>> 4) % 3 === 0;
  const w = tall ? 900 : 1200;
  const ht = tall ? 1200 : 900;
  // The face somewhere in the middle third, a fifth to a third of the picture wide.
  const fw = 0.2 + ((h >>> 8) % 13) / 100;
  const fh = (fw * w * 1.25) / ht;
  const x0 = 0.25 + ((h >>> 12) % 30) / 100;
  const y0 = 0.15 + ((h >>> 16) % 20) / 100;
  const bbox = [x0, y0, Math.min(0.98, x0 + fw), Math.min(0.98, y0 + fh)];
  return { who, width: w, height: ht, bbox, score: 0.75 + ((h >>> 20) % 20) / 100, size: Math.round(fw * w) };
}

/**
 * The picture itself, as SVG: a background, shoulders, and a face drawn in its box. With `face` (a box
 * and how much around it), only that square of it, as the backend cuts faces out (thumbs.rs).
 */
export function mockSvg(rel, face) {
  const { who, width: W, height: H, bbox } = mockPicture(rel);
  let view = `0 0 ${W} ${H}`;
  let size = `width="${W}" height="${H}"`;
  if (face) {
    const [a, b, c, d] = face.bbox;
    const side = Math.max(1, Math.min(Math.max((c - a) * W, (d - b) * H) * face.around, W, H));
    const place = (centre, extent) => Math.min(extent - side, Math.max(0, centre * extent - side / 2));
    view = `${place((a + c) / 2, W)} ${place((b + d) / 2, H)} ${side} ${side}`;
    size = `width="256" height="256"`;
  }
  const [x0, y0, x1, y1] = [bbox[0] * W, bbox[1] * H, bbox[2] * W, bbox[3] * H];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  const drawn = who.kind === "drawn";
  const eye = drawn ? `<ellipse cx="${cx - rx * 0.38}" cy="${cy}" rx="${rx * 0.16}" ry="${ry * 0.2}" fill="${who.hair}"/><ellipse cx="${cx + rx * 0.38}" cy="${cy}" rx="${rx * 0.16}" ry="${ry * 0.2}" fill="${who.hair}"/>` : `<circle cx="${cx - rx * 0.35}" cy="${cy - ry * 0.05}" r="${rx * 0.08}" fill="#222"/><circle cx="${cx + rx * 0.35}" cy="${cy - ry * 0.05}" r="${rx * 0.08}" fill="#222"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="${view}" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${who.bg[0]}"/><stop offset="1" stop-color="${who.bg[1]}"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
<ellipse cx="${cx}" cy="${y1 + ry * 2.2}" rx="${rx * 2.2}" ry="${ry * 1.6}" fill="${who.hair}" opacity="0.85"/>
<ellipse cx="${cx}" cy="${cy - ry * 0.25}" rx="${rx * 1.12}" ry="${ry * 1.1}" fill="${who.hair}"/>
<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${who.skin}"/>
${eye}
<path d="M ${cx - rx * 0.3} ${cy + ry * 0.45} Q ${cx} ${cy + ry * 0.62} ${cx + rx * 0.3} ${cy + ry * 0.45}" stroke="#7a3b3b" stroke-width="${Math.max(2, rx * 0.06)}" fill="none"/>
</svg>`;
}
