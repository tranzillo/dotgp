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
