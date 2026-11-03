import { useId, type ReactNode } from "react";
import { langName } from "../lib/language";

/** A five-pointed star's points around (cx, cy). */
function star(cx: number, cy: number, r: number): string {
  return Array.from({ length: 10 }, (_, i) => {
    const a = (-90 + i * 36) * (Math.PI / 180);
    const rr = i % 2 ? r * 0.382 : r;
    return `${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`;
  }).join(" ");
}

/** Flags are drawn in their own shape, 3:2. */
const W = 45;
const H = 30;

const h3 = (a: string, b: string, c: string) => (
  <>
    <rect width={W} height="10" fill={a} />
    <rect y="10" width={W} height="10" fill={b} />
    <rect y="20" width={W} height="10" fill={c} />
  </>
);
const v3 = (a: string, b: string, c: string) => (
  <>
    <rect width="15" height={H} fill={a} />
    <rect x="15" width="15" height={H} fill={b} />
    <rect x="30" width="15" height={H} fill={c} />
  </>
);
const bars = (x: number, y: number, rot: number) => (
  <g transform={`rotate(${rot} ${x} ${y})`} fill="#000">
    <rect x={x - 3} y={y - 2.6} width="6" height="1.1" />
    <rect x={x - 3} y={y - 0.55} width="6" height="1.1" />
    <rect x={x - 3} y={y + 1.5} width="6" height="1.1" />
  </g>
);

/** Each language's flag, flat, drawn in a 45 × 30 box. */
function body(code?: string | null): ReactNode {
  switch (code) {
    case "ja":
      return (
        <>
          <rect width={W} height={H} fill="#fff" />
          <circle cx="22.5" cy="15" r="9" fill="#bc002d" />
        </>
      );
    case "en":
      return (
        <>
          <rect width={W} height={H} fill="#012169" />
          <path d="M0,0 45,30 M45,0 0,30" stroke="#fff" strokeWidth="6" />
          <path d="M0,0 45,30 M45,0 0,30" stroke="#c8102e" strokeWidth="2" />
          <path d="M22.5,0 V30 M0,15 H45" stroke="#fff" strokeWidth="10" />
          <path d="M22.5,0 V30 M0,15 H45" stroke="#c8102e" strokeWidth="6" />
        </>
      );
    case "zh":
      return (
        <>
          <rect width={W} height={H} fill="#de2910" />
          <polygon points={star(7.5, 7.5, 4.5)} fill="#ffde00" />
          <polygon points={star(15, 3, 1.5)} fill="#ffde00" />
          <polygon points={star(18, 6, 1.5)} fill="#ffde00" />
          <polygon points={star(18, 10.5, 1.5)} fill="#ffde00" />
          <polygon points={star(15, 13.5, 1.5)} fill="#ffde00" />
        </>
      );
    case "ko":
      return (
        <>
          <rect width={W} height={H} fill="#fff" />
          <path d="M15,15 A7.5,7.5 0 0 1 30,15 Z" fill="#cd2e3a" />
          <path d="M15,15 A7.5,7.5 0 0 0 30,15 Z" fill="#0047a0" />
          <circle cx="18.75" cy="15" r="3.75" fill="#cd2e3a" />
          <circle cx="26.25" cy="15" r="3.75" fill="#0047a0" />
          {bars(9, 6, -56)}
          {bars(36, 6, 56)}
          {bars(9, 24, 56)}
          {bars(36, 24, -56)}
        </>
      );
    case "es":
      return (
        <>
          <rect width={W} height={H} fill="#aa151b" />
          <rect y="7.5" width={W} height="15" fill="#f1bf00" />
        </>
      );
    case "fr":
      return v3("#002395", "#fff", "#ed2939");
    case "it":
      return v3("#009246", "#fff", "#ce2b37");
    case "de":
      return h3("#000", "#dd0000", "#ffce00");
    case "ru":
      return h3("#fff", "#0039a6", "#d52b1e");
    case "pt":
      return (
        <>
          <rect width={W} height={H} fill="#009c3b" />
          <polygon points="22.5,3.5 41.5,15 22.5,26.5 3.5,15" fill="#ffdf00" />
          <circle cx="22.5" cy="15" r="7" fill="#002776" />
        </>
      );
    case "vi":
      return (
        <>
          <rect width={W} height={H} fill="#da251d" />
          <polygon points={star(22.5, 15.5, 9)} fill="#ffcd00" />
        </>
      );
    case "th":
      return (
        <>
          <rect width={W} height={H} fill="#a51931" />
          <rect y="5" width={W} height="20" fill="#f4f5f8" />
          <rect y="10" width={W} height="10" fill="#2d2a4a" />
        </>
      );
    case "id":
      return (
        <>
          <rect width={W} height={H} fill="#fff" />
          <rect width={W} height="15" fill="#ce1126" />
        </>
      );
    default:
      return (
        <>
          <rect width={W} height={H} fill="#777" />
          <text x="22.5" y="21" textAnchor="middle" fontSize="17" fontWeight="700" fill="#fff">
            ?
          </text>
        </>
      );
  }
}

/** A language's flag filling what holds it (cut to its shape), with no frame or name: for pictures made of flags. */
export function FlagFace({ code }: { code?: string | null }) {
  return (
    <svg className="flag-face" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {body(code)}
    </svg>
  );
}

/**
 * A language's flag, flat, in its own shape (3:2, `size` tall); with `other`, split corner to corner
 * (the original top left). `corner`: tucked into a card's top left corner, so square there and
 * rounded only at its bottom right.
 */
export function Flag({ code, other, size = 20, corner }: { code?: string | null; other?: string | null; size?: number; corner?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg className="flag" width={(size * W) / H} height={size} viewBox={`0 0 ${W} ${H}`} role="img">
      <title>{other ? `${langName(code)}, translated into ${langName(other)}` : langName(code)}</title>
      <defs>
        <clipPath id={`r${id}`}>{corner ? <path d="M0,0 H45 V25 Q45,30 40,30 H0 Z" /> : <rect width={W} height={H} rx="4" />}</clipPath>
        <clipPath id={`b${id}`}>
          <polygon points="45,0 45,30 0,30" />
        </clipPath>
      </defs>
      <g clipPath={`url(#r${id})`}>
        {body(code)}
        {other && <g clipPath={`url(#b${id})`}>{body(other)}</g>}
        {other && <line x1="45" y1="0" x2="0" y2="30" stroke="#fff" strokeWidth="1.2" />}
      </g>
      {!corner && <rect x="0.5" y="0.5" width={W - 1} height={H - 1} rx="3.5" fill="none" stroke="rgba(0,0,0,0.35)" />}
    </svg>
  );
}
