/** Little decorations for the Cozy theme. Hidden by CSS in other themes. */
export function Deco({ kind, className = "" }: { kind: "plant" | "mug" | "cat" | "sprout"; className?: string }) {
  const common = { className: `deco deco-${kind} ${className}`, "aria-hidden": true, focusable: "false" } as const;
  if (kind === "plant")
    return (
      <svg {...common} viewBox="0 0 120 140" width="96" height="112">
        <path d="M34 98h52l-6 34H40z" fill="#c9907f" />
        <path d="M30 92h60v10H30z" fill="#b07b6c" />
        <path d="M60 96c-2-30-20-40-38-42 2 22 14 36 38 42z" fill="#7fa883" />
        <path d="M60 96c2-34 20-46 40-48-1 24-14 40-40 48z" fill="#6f9a8a" />
        <path d="M60 96c-8-24 0-46 10-56 6 16 4 40-10 56z" fill="#9db9a4" />
        <path d="M60 96c-14-16-32-18-44-14 10 12 26 16 44 14z" fill="#8fb39c" />
        <circle cx="46" cy="118" r="3" fill="#e6b3a6" />
      </svg>
    );
  if (kind === "mug")
    return (
      <svg {...common} viewBox="0 0 120 120" width="72" height="72">
        <path d="M28 48h54v40a12 12 0 0 1-12 12H40a12 12 0 0 1-12-12z" fill="#e8c9bf" />
        <path d="M82 56h10a12 12 0 0 1 0 24H82" fill="none" stroke="#e8c9bf" strokeWidth="8" />
        <path d="M30 48h50v6H30z" fill="#d89a93" />
        <path d="M46 36c0-6 6-6 6-12s-6-6-6-12M60 38c0-6 6-6 6-12s-6-6-6-12" fill="none" stroke="#b4a797" strokeWidth="3" strokeLinecap="round" opacity="0.7" />
      </svg>
    );
  if (kind === "sprout")
    return (
      <svg {...common} viewBox="0 0 60 60" width="40" height="40">
        <path d="M30 56V30" stroke="#7fa883" strokeWidth="3" strokeLinecap="round" />
        <path d="M30 34c-12 2-18-6-18-14 10 0 18 4 18 14z" fill="#9db9a4" />
        <path d="M30 30c2-12 10-16 18-16 0 10-6 18-18 16z" fill="#7fa883" />
      </svg>
    );
  return (
    <svg {...common} viewBox="0 0 140 100" width="112" height="80">
      <ellipse cx="80" cy="78" rx="46" ry="18" fill="#857768" />
      <circle cx="40" cy="60" r="20" fill="#857768" />
      <path d="M24 46l4-16 12 10zM56 46l-4-16-12 10z" fill="#857768" />
      <path d="M120 70c14 0 16-14 8-20" fill="none" stroke="#857768" strokeWidth="8" strokeLinecap="round" />
      <path d="M31 60h6M43 60h6" stroke="#f3ece3" strokeWidth="2" strokeLinecap="round" />
      <circle cx="40" cy="66" r="2" fill="#e6b3a6" />
    </svg>
  );
}
