import type { Track } from './track';

/**
 * A circuit's features read from its geometry alone (the centerline's
 * curvature), whatever made the layout: corners, braking zones into tight
 * corners, chicanes. Positions are distances round the lap (0..L).
 */

export interface Corner {
  /** Where it starts turning and where it ends (s1 may pass L). */
  s0: number;
  s1: number;
  /** Signed turn (rad, + left) and the tightest radius in it (m). */
  turn: number;
  radius: number;
}

/** Curvature below this is straight (1 / 10 km). */
const STRAIGHT = 1e-4;
const STEP = 2;

/** The corners round the lap, in order: runs of curvature one way. */
export function corners(track: Track): Corner[] {
  const L = track.length;
  // Start the scan on a straight so no corner is split by the wrap.
  let start = 0;
  while (start < L && Math.abs(track.curvatureAt(start)) > STRAIGHT) start += STEP;
  const out: Corner[] = [];
  let cur: Corner | null = null;
  for (let x = start; x < start + L; x += STEP) {
    const k = track.curvatureAt(x);
    const sign = Math.abs(k) > STRAIGHT ? Math.sign(k) : 0;
    if (cur && (sign === 0 || sign !== Math.sign(cur.turn))) { out.push(cur); cur = null; }
    if (sign !== 0) {
      if (!cur) cur = { s0: x % L, s1: x % L, turn: 0, radius: Infinity };
      cur.s1 = cur.s0 + (x - (cur.s0 < start ? cur.s0 + L : cur.s0)) + STEP;
      cur.turn += k * STEP;
      cur.radius = Math.min(cur.radius, 1 / Math.abs(k));
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Straight (m) running into a corner: from the previous corner's end. */
function straightBefore(cs: Corner[], i: number, L: number): number {
  const prev = cs[(i - 1 + cs.length) % cs.length];
  return ((cs[i].s0 - prev.s1) % L + L) % L;
}

export interface BrakingSpot {
  /** The tight corner, and the straight leading into it (m). */
  corner: Corner;
  straight: number;
}

/**
 * Braking zones into tight corners: a straight of at least `minStraight`
 * into a corner no wider than `maxRadius` that turns at least `minTurn`
 * (chicanes excluded: they are their own feature).
 */
export function brakingSpots(track: Track, minStraight = 300, maxRadius = 50, minTurn = Math.PI / 3): BrakingSpot[] {
  const cs = corners(track);
  const inChicane = new Set(chicanes(track).flatMap((c) => c.corners));
  return cs.flatMap((corner, i) => {
    const straight = straightBefore(cs, i, track.length);
    return straight >= minStraight && corner.radius <= maxRadius && Math.abs(corner.turn) >= minTurn && !inChicane.has(corner)
      ? [{ corner, straight }] : [];
  });
}

export interface Chicane {
  /** Where its first corner starts and its last ends, and the straight leading in (m). */
  s0: number;
  s1: number;
  straight: number;
  corners: Corner[];
}

/** Links between a chicane's corners are no longer than this (m), its turns cancel to within this (rad), and its corners are tight. */
const CHICANE_LINK = 30;
const CHICANE_NET = (15 * Math.PI) / 180;
const CHICANE_RADIUS = 40;

/**
 * Chicanes: two or more tight corners turning alternate ways, joined by short
 * links, ending on the line they started on (a fast S-bend that happens to
 * come back onto its line is esses, not a chicane).
 */
export function chicanes(track: Track): Chicane[] {
  const cs = corners(track);
  const L = track.length;
  const out: Chicane[] = [];
  for (let i = 0; i < cs.length; i++) {
    let net = cs[i].turn, j = i;
    if (cs[i].radius > CHICANE_RADIUS) continue;
    while (j + 1 < cs.length && straightBefore(cs, j + 1, L) <= CHICANE_LINK && Math.sign(cs[j + 1].turn) !== Math.sign(cs[j].turn)
      && cs[j + 1].radius <= CHICANE_RADIUS) {
      j++;
      net += cs[j].turn;
      if (Math.abs(net) <= CHICANE_NET) {
        out.push({ s0: cs[i].s0, s1: cs[j].s1, straight: straightBefore(cs, i, L), corners: cs.slice(i, j + 1) });
        i = j;
        break;
      }
    }
  }
  return out;
}
