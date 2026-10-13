import type { Car } from './car';
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
