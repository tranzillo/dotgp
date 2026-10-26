/** A car's look: fill colour, thick border colour, a thin trim ring between them, and its number. */
export interface Livery {
  number: number;
  fill: string;
  border: string;
  /** The thin ring round the fill, inside the border (may match either). None: the border runs to the fill. */
  trim?: string;
  /** Text drawn instead of the number (e.g. "PC" for the pace car; empty, none: the wreckers). */
  label?: string;
}

/** Track asphalt, the colour every dot races over (the renderer paints with this). */
export const RACING_SURFACE = '#4a4a50';

export const PACE_CAR_LIVERY: Livery = { number: 0, fill: '#f4f4f4', border: '#f5c518', label: 'PC' };
export const WRECKER_LIVERY: Livery = { number: 0, fill: '#ff7a1a', border: '#26262a', label: '' };

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

/** Borders must be lighter than the asphalt by at least this contrast ratio. */
const MIN_BORDER_CONTRAST = 2;

/**
 * Whether a border colour stands out on the racing surface. The border is
 * the car's outline and the colour of its trail and exhaust, so it has to be
 * brighter than the asphalt: black, dark greys and deep blues sink into it.
 */
export function borderReads(border: string): boolean {
  return luminance(border) > luminance(RACING_SURFACE) && contrast(border, RACING_SURFACE) >= MIN_BORDER_CONTRAST;
}

const BORDERS = PALETTE.filter(borderReads);

const numberColors = new Map<string, string>();

/** Black or white, whichever reads better on the fill. (Asked for every car every frame: remembered.) */
export function numberColor(fill: string): string {
  let c = numberColors.get(fill);
  if (!c) numberColors.set(fill, (c = contrast(fill, '#111111') >= contrast(fill, '#ffffff') ? '#111111' : '#ffffff'));
  return c;
}

/**
 * A random fill/border pair with enough contrast to read as two colours, a
 * trim, and an unused number. Any palette colour can be the fill or the trim
 * (the trim may match either); the border comes from the ones that read on
 * the asphalt.
 */
export function randomLivery(taken: Iterable<number>, random: () => number = Math.random): Livery {
  const used = new Set(taken);
  const free = Array.from({ length: 99 }, (_, i) => i + 1).filter((n) => !used.has(n));
  const number = free.length ? free[Math.floor(random() * free.length)] : Math.floor(random() * 99) + 1;
  for (;;) {
    const fill = PALETTE[Math.floor(random() * PALETTE.length)];
    const border = BORDERS[Math.floor(random() * BORDERS.length)];
    if (fill !== border && contrast(fill, border) >= 1.8) return { number, fill, border, trim: PALETTE[Math.floor(random() * PALETTE.length)] };
  }
}

/**
 * The livery, with its border swapped for one that reads on the asphalt if it
 * doesn't. Deterministic (picked by car number), so a saved livery always
 * migrates to the same colour.
 */
export function withLegibleBorder(livery: Livery): Livery {
  if (borderReads(livery.border)) return livery;
  const ok = BORDERS.filter((b) => b !== livery.fill && contrast(livery.fill, b) >= 1.8);
  const pool = ok.length ? ok : BORDERS;
  return { ...livery, border: pool[livery.number % pool.length] };
}

/**
 * The livery, given a trim if it was saved before liveries had one.
 * Deterministic (picked by car number), like `withLegibleBorder`.
 */
export function withTrim(livery: Livery): Livery {
  return livery.trim ? livery : { ...livery, trim: PALETTE[(livery.number * 5) % PALETTE.length] };
}
