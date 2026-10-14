import { G } from '../sim/constants';
import type { Car } from '../sim/car';
import type { Track } from '../sim/track';

/** Distances ahead (m) at which the driver samples track curvature. */
export const LOOKAHEAD = [0, 30, 60, 100, 160, 250, 400] as const;
const CURVATURE_SCALE = 200; // kappa x 200 ~ 1 for a 200 m turn

export const OBS_SIZE = 11 + LOOKAHEAD.length;

/**
 * Everything the driver perceives, relative to its own travel direction
 * where possible, so one corner looks like every other corner.
 */
export function observe(car: Car, track: Track, out: Float32Array): Float32Array {
  const i = car.trackIdx;
  const tx = track.tx[i], ty = track.ty[i];
  const fx = car.frameX, fy = car.frameY;
  const speed = car.speed;
  let k = 0;
  out[k++] = speed / 80;
  // Angle from travel direction to the track direction.
  out[k++] = fx * ty - fy * tx;
  out[k++] = fx * tx + fy * ty;
  // Lateral position: -1 at the outside edge, +1 at the inside edge, >1 on the apron (wherever the edges are here).
  out[k++] = Math.min(3, track.lanePosition(i, car.d));
  // Velocity across and along the track.
  out[k++] = (car.vx * -ty + car.vy * tx) / 20;
  out[k++] = (car.vx * tx + car.vy * ty) / 80;
  out[k++] = car.bankAcc / G;
  out[k++] = car.capacity / (2 * G);
  out[k++] = (car.grip - 0.8) / 0.2;
  // Last command, which gives the policy a little memory.
  out[k++] = car.inputX;
  out[k++] = car.inputY;
  for (const ahead of LOOKAHEAD) out[k++] = track.curvatureAt(car.s + ahead) * CURVATURE_SCALE;
  return out;
}

/** Distances ahead (m) at which the driver sees where the pit route runs. */
export const PIT_LOOKAHEAD = [0, 25, 50, 100] as const;
export const PIT_SIZE = 8 + PIT_LOOKAHEAD.length;

/**
 * What a driver perceives about a pit stop in progress: the crew chief's
 * call (in-lap / out-lap), where the painted route runs relative to the car,
 * how far to the box, the pit road speed limit, and the spotter's "clear" to
 * merge. All zero when not pitting, so racing is untouched.
 */
export function observePit(
  car: Car, track: Track, route: ((s: number) => number) | null, mergeClear: boolean, limit: number, out: Float32Array,
): Float32Array {
  out.fill(0);
  if (!route || car.pit.phase === 'none') return out;
  const r = track.signedS(car.s);
  const inLap = car.pit.phase === 'in';
  let k = 0;
  out[k++] = inLap ? 1 : 0;
  out[k++] = inLap ? 0 : 1;
  for (const ahead of PIT_LOOKAHEAD) out[k++] = Math.max(-3, Math.min(3, (route(car.s + ahead) - car.d) / track.halfWidth));
  // Distance to the box (in-lap): +1 = 200 m or more to go, 0 at the box, negative past it.
  out[k++] = inLap ? Math.max(-1, Math.min(1, (car.pit.boxS - r) / 200)) : 0;
  // ...and close up, where stopping on the box takes precision: +1 = 20 m or more.
  out[k++] = inLap ? Math.max(-1, Math.min(1, (car.pit.boxS - r) / 20)) : 0;
  // The speed limit: how far to the limit zone, and over/under it once there.
  const toZone = track.distanceFrom(car.s, track.pit.wallStart);
  const inZone = track.inPitWallZone(car.s);
  out[k++] = inZone ? 0 : Math.min(1, toZone / 300);
  out[k++] = inZone || toZone < 300 ? Math.max(-1, Math.min(1, (car.speed - limit) / limit)) : 0;
  out[k++] = mergeClear && !inLap ? 1 : 0;
  return out;
}
