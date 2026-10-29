import type { Car } from './car';
import { PHYSICS as P } from './constants';
import type { Marking } from './layout';
import type { Track } from './track';

/** Rolling-start speed behind the (imaginary) pace car. */
export const ROLLING_START_SPEED = 35;
const ROW_SPACING = 10;
const LANE_OFFSET = 3;

/**
 * Two-wide grid behind the start line. With a rolling start the field is
 * released at pace speed, as on real ovals; otherwise cars start stationary.
 */
export function placeOnGrid(car: Car, track: Track, slot: number, rolling: boolean): void {
  const row = Math.floor(slot / 2);
  car.placeOnTrack(track, track.length - 15 - row * ROW_SPACING, slot % 2 === 0 ? -LANE_OFFSET : LANE_OFFSET);
  if (rolling) {
    const i = car.trackIdx;
    car.vx = track.tx[i] * ROLLING_START_SPEED;
    car.vy = track.ty[i] * ROLLING_START_SPEED;
  }
}

/** A standing start's grid: metres from the start line back to the pole car, and between boxes (each its own row). */
export const POLE_BOX = 12;
export const GRID_PITCH = 8;
/** How far either side of the racing surface's middle the boxes stand (m), at most, and at most this share of the half width. */
const GRID_STAGGER = 3;
const GRID_STAGGER_SHARE = 0.45;
/** Painted box: its sides run this far back from the line across its front (m). */
const BOX_DEPTH = 3;

/**
 * Grid box k of a standing start (0 is pole): where the car stands, its
 * centre, behind the line, staggered either side of the racing surface's
 * middle (pole on the inside). Race control lines the field up in these and
 * the track's paint marks them, so the two always agree.
 */
export function gridBox(track: Track, k: number, pitch = GRID_PITCH): { s: number; d: number } {
  const s = track.wrapS(-POLE_BOX - k * pitch);
  const inner = track.innerEdgeAt(s), outer = track.outerEdgeAt(s);
  const stagger = Math.min(GRID_STAGGER, GRID_STAGGER_SHARE * (inner - outer) / 2);
  return { s, d: (inner + outer) / 2 + (k % 2 === 0 ? stagger : -stagger) };
}

/**
 * Paint for the first `count` grid boxes: a line across in front of where
 * each car stands and its sides back along it, a car's width and a little
 * apart. Marked as the grid's (the track paints it on whatever layout it's
 * given, and drops any it was given).
 */
export function gridMarkings(track: Track, count: number, pitch = GRID_PITCH): Marking[] {
  const out: Marking[] = [];
  const half = P.CAR_RADIUS + 0.4;
  for (let k = 0; k < count; k++) {
    const box = gridBox(track, k, pitch);
    const front = track.signedS(box.s) + P.CAR_RADIUS + 0.5;
    out.push({ kind: 'ticks', s: [front], d0: box.d - half, d1: box.d + half, style: 'stall', grid: true });
    for (const d of [box.d - half, box.d + half]) out.push({ kind: 'line', range: [front - BOX_DEPTH, front], d, style: 'stall', grid: true });
  }
  return out;
}
