/** A car's look: fill colour, thick border colour, and its number. */
export interface Livery {
  number: number;
  fill: string;
  border: string;
  /** Text drawn instead of the number (e.g. "PC" for the pace car). */
  label?: string;
}

export const PACE_CAR_LIVERY: Livery = { number: 0, fill: '#f4f4f4', border: '#f5c518', label: 'PC' };

const PALETTE = [
  '#e63946', // red
  '#f77f00', // orange
  '#ffd60a', // yellow
  '#9ef01a', // lime
  '#2a9d8f', // teal
  '#00b4d8', // sky
  '#1d4ed8', // blue
  '#7b2cbf', // purple
  '#ff4d9d', // pink
  '#f8f9fa', // white
  '#111111', // black
  '#9ca3af', // silver
  '#8d5524', // brown
  '#14532d', // forest
];

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on the fill. */
export function numberColor(fill: string): string {
  return contrast(fill, '#111111') >= contrast(fill, '#ffffff') ? '#111111' : '#ffffff';
}

/** A random fill/border pair with enough contrast to read as two colours, and an unused number. */
export function randomLivery(taken: Iterable<number>, random: () => number = Math.random): Livery {
  const used = new Set(taken);
  const free = Array.from({ length: 99 }, (_, i) => i + 1).filter((n) => !used.has(n));
  const number = free.length ? free[Math.floor(random() * free.length)] : Math.floor(random() * 99) + 1;
  for (;;) {
    const fill = PALETTE[Math.floor(random() * PALETTE.length)];
    const border = PALETTE[Math.floor(random() * PALETTE.length)];
    if (fill !== border && contrast(fill, border) >= 1.8) return { number, fill, border };
  }
}
