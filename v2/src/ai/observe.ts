import { G, PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';

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

/**
 * The preview: the road ahead in windows (m), each the tightest curvature in
 * it with its direction. The lookahead's point samples can fall between the
 * corners of a chicane (10-20 m each, a few metres apart) and see a straight;
 * a window can't miss a corner in it.
 */
export const PREVIEW = [[0, 15], [15, 30], [30, 50], [50, 80], [80, 120], [120, 170], [170, 250]] as const;
export const PREVIEW_SIZE = PREVIEW.length;
const PREVIEW_STEP = 2.5;

export function observePreview(car: Car, track: Track, out: Float32Array): Float32Array {
  for (let w = 0; w < PREVIEW_SIZE; w++) {
    const [from, to] = PREVIEW[w];
    let tightest = 0;
    for (let a = from; a <= to; a += PREVIEW_STEP) {
      const k = track.curvatureAt(car.s + a);
      if (Math.abs(k) > Math.abs(tightest)) tightest = k;
    }
    out[w] = tightest * CURVATURE_SCALE;
  }
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

export const CAUTION_SIZE = 7;

/**
 * What a driver perceives under caution (pace laps, caution laps, the run to
 * a restart): that the field is pacing and whether the restart is coming,
 * where its place in line is (how far ahead or behind, which lane), the speed
 * the line is moving at, and the car ahead in its file. All zero under green,
 * so racing is untouched.
 */
export function observeCaution(car: Car, world: World, out: Float32Array): Float32Array {
  out.fill(0);
  const ctl = world.control;
  if (!ctl || !ctl.pacing || car.pit.phase !== 'none' || car.finished) return out;
  const track = world.track;
  out[0] = 1;
  out[1] = ctl.oneToGo || ctl.flag === 'restart' ? 1 : 0;
  const slot = ctl.slotFor(car);
  if (!slot) return out;
  // Metres the slot is ahead of us (a slot far behind is reached by going round, as the formation script does).
  let err = track.distanceFrom(car.s, slot.s);
  if (err > track.length / 2) err -= track.length;
  if (err < -150) err += track.length;
  out[2] = Math.max(-3, Math.min(3, err / 40));
  out[3] = Math.max(-2, Math.min(2, (slot.d - car.d) / track.halfWidth));
  out[4] = Math.max(-2, Math.min(2, (slot.speed - car.speed) / 20));
  const ahead = ctl.carAheadInFile(car, slot.d);
  if (ahead) {
    const gap = track.distanceFrom(car.s, ahead.s) - 2 * P.CAR_RADIUS;
    out[5] = Math.max(0, Math.min(1, gap / 50));
    out[6] = Math.max(-2, Math.min(2, (car.speed - ahead.speed) / 20));
  } else {
    out[5] = 1;
  }
  return out;
}
