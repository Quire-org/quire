/**
 * Pictures in rows that fill the width, each at its own shape: a row takes pictures until, at the
 * target height, they would overflow, then is scaled to fit exactly. The last row stays at the
 * target height (it isn't stretched to fill).
 */
export interface JustifiedRow {
  start: number;
  end: number;
  height: number;
}

export function justify(ratios: number[], width: number, target: number, gap: number): JustifiedRow[] {
  const rows: JustifiedRow[] = [];
  if (width <= 0) return rows;
  let start = 0;
  let sum = 0;
  for (let i = 0; i < ratios.length; i++) {
    sum += ratios[i];
    const n = i - start + 1;
    if (sum * target + gap * (n - 1) >= width) {
      rows.push({ start, end: i + 1, height: Math.max(40, (width - gap * (n - 1)) / sum) });
      start = i + 1;
      sum = 0;
    }
  }
  if (start < ratios.length) rows.push({ start, end: ratios.length, height: target });
  return rows;
}

/** A picture's width to its height, kept within what a row can hold (very tall or wide ones). */
export function ratioOf(width: number, height: number): number {
  return width > 0 && height > 0 ? Math.min(3, Math.max(0.33, width / height)) : 0.75;
}
