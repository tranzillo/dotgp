import { G, PHYSICS as P } from '../sim/constants';
import type { Car } from '../sim/car';
import type { Track } from '../sim/track';
import type { World } from '../sim/world';
import { fastestLine } from './racingLine';

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

/**
 * Track knowledge: a driver knows the circuit (as racing drivers do: they've
 * walked it, driven it in the simulator, run practice). At points ahead,
 * where its line runs (across the road, relative to the car) and the speed it
 * takes there (against the car's own, on tyres as worn as these). Road
 * courses only (zero on ovals). Its line is its own: the circuit's fastest,
 * kept its margin inside the track limits, at its share of the tyres' grip.
 */
export const KNOWLEDGE_AHEAD = [0, 15, 30, 50, 80, 120] as const;
export const KNOWLEDGE_SIZE = 2 * KNOWLEDGE_AHEAD.length;

/** What a driver knows of a circuit: its line (how far inside the track limits) and the share of grip it takes it at. */
export interface TrackKnowledge { grip: number; margin: number }
export const DEFAULT_KNOWLEDGE: TrackKnowledge = { grip: 0.85, margin: 0.6 };
/**
 * The margins a driver's line can keep (m). Each margin is its own line to
 * work out for a circuit, so they come in steps: a field shares a few.
 */
export const KNOWLEDGE_MARGINS = [0.6, 0.9, 1.2, 1.5] as const;

/**
 * Where the driver's own line runs ahead and the speed it takes there, against the car's: on road circuits and, since
 * 2026-10-22, ovals (the oval teacher drives the same fastest line; copying it, students explained 71% of its throttle
 * with this against 64% without, and more with its labels taken from where the car really is). Drivers from before
 * have zero weights from these inputs, so they drive as they did.
 */
export function observeKnowledge(car: Car, track: Track, out: Float32Array, knowledge: TrackKnowledge = DEFAULT_KNOWLEDGE): Float32Array {
  const line = fastestLine(track, knowledge.margin);
  const speed = line.at(Math.round(knowledge.grip * car.grip * 50) / 50).speed;
  const n = line.d.length;
  KNOWLEDGE_AHEAD.forEach((a, j) => {
    const f = ((((car.s + a) / line.step) % n) + n) % n, i = Math.floor(f), k = (i + 1) % n, t = f - i;
    out[j] = (line.d[i] + (line.d[k] - line.d[i]) * t - car.d) / 10;
    out[KNOWLEDGE_AHEAD.length + j] = (speed[i] + (speed[k] - speed[i]) * t - car.speed) / 20;
  });
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
  const r = track.pitInR(car);
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

export const CALLS_SIZE = 5;

export const PIT_CALLS_SIZE = 3;

export const CAUTION_RANGE_SIZE = 2;
/** The radio's reach ahead (m) and what counts as in our lane (m): as the spotter calls the cars ahead. */
const PIT_CALL_AHEAD = 120;
const PIT_CALL_LANE = 3.5;

/**
 * What a spotter says about other cars' pit stops: the car ahead in our lane
 * is diving for pit road ("he's pitting": it's about to brake hard, and drops
 * to the apron to show it), so is the next car ahead in any lane, and a car
 * coming out of the pits is merging ahead of us (slow, on the apron, coming
 * up). Each by how near it is (1 touching, 0 out of range). The radio's other
 * channels don't say why a car is slow; the oval teacher gives a car heading
 * in room for full braking, and drivers couldn't see why (stable v9: drivers
 * hitting pitting cars were the speedway's leading cause of retirements).
 */
export function observePitCalls(car: Car, world: World, out: Float32Array): Float32Array {
  out.fill(0);
  if (!world.opts.collisions) return out;
  const L = world.track.length;
  let lane = Infinity, any = Infinity, laneCar: Car | null = null, anyCar: Car | null = null;
  for (const other of world.cars) {
    if (other === car || other.cleared || other.retired) continue;
    if (other.surface === 'pit' && car.surface !== 'pit') continue; // behind the pit wall: not traffic
    let ds = other.s - car.s;
    if (ds > L / 2) ds -= L;
    else if (ds < -L / 2) ds += L;
    if (ds <= 0 || ds > PIT_CALL_AHEAD) continue;
    if (Math.abs(other.d - car.d) < PIT_CALL_LANE && ds < lane) { lane = ds; laneCar = other; }
    else if (ds < any) { any = ds; anyCar = other; }
    if (other.pit.phase === 'out') out[2] = Math.max(out[2], 1 - ds / PIT_CALL_AHEAD);
  }
  if (laneCar?.pit.phase === 'in') out[0] = 1 - lane / PIT_CALL_AHEAD;
  if (anyCar?.pit.phase === 'in') out[1] = 1 - any / PIT_CALL_AHEAD;
  return out;
}

/**
 * What race control and the spotter tell a driver under caution, beyond where
 * its place is: whether the line has formed yet (the pace car has picked up
 * the leader) or the field is still slowing where it is; whether it has been
 * told to line up behind a car, and how far ahead of that car it still is;
 * whether it's being waved around; and whether a car that belongs ahead of it
 * is coming up from behind to its place ("let the 24 by"). A driver can't
 * know these from what it sees on track, and how it should drive turns on
 * them. All zero under green.
 */
export function observeCalls(car: Car, world: World, out: Float32Array): Float32Array {
  out.fill(0);
  const ctl = world.control;
  if (!ctl || !ctl.pacing || car.pit.phase !== 'none' || car.finished) return out;
  const track = world.track;
  out[0] = ctl.flag !== 'caution' || ctl.pickedUp ? 1 : 0;
  const behind = ctl.toLineUpBehind(car);
  if (behind) {
    const past = track.distanceFrom(behind.s, car.s); // how far we're ahead of it
    if (past < track.length / 2) { out[1] = 1; out[2] = Math.min(1, past / 100); }
  }
  out[3] = ctl.wavedAround(car) ? 1 : 0;
  const slot = ctl.slotFor(car);
  if (slot) {
    for (const other of world.cars) {
      const o = ctl.slotFor(other);
      if (!o || o.index >= slot.index || other.retired) continue;
      const gap = track.distanceFrom(other.s, car.s) - 2 * P.CAR_RADIUS; // how far it is behind us
      const closing = other.speed - car.speed;
      if (gap <= 0 || gap > track.length / 2 || closing <= 0) continue;
      // Coming up to its place: within the distance it needs to slow to our speed at the formation's comfortable
      // braking, plus a car and the formation's usual gap (when the formation itself gives way).
      if (gap < (closing * closing) / (2 * 4) + 2 * P.CAR_RADIUS + 6) { out[4] = 1; break; }
    }
  }
  return out;
}

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

/**
 * Under caution, how far the place in line is and the gap to the car ahead in its file, without the caution inputs'
 * clamps (observeCaution's: its place at 120 m, the gap at 50 m). Catching the queue after the safety car comes out
 * both were at their clamps most of the time (audit 2026-10-24: 36-62% and 43-66%): how far there is to go and when
 * to start slowing for the car ahead weren't there to see. The place: asinh of the distance in 40 m (as before near
 * it, 1.8 at 120 m, 3.9 at a kilometre); the gap: the square root of its share of 200 m (0.5 at 50 m, 1 at 200 m or
 * none). Zero under green and without a place.
 */
export function observeCautionRange(car: Car, world: World, out: Float32Array): Float32Array {
  out.fill(0);
  const ctl = world.control;
  if (!ctl || !ctl.pacing || car.pit.phase !== 'none' || car.finished) return out;
  const track = world.track;
  const slot = ctl.slotFor(car);
  if (!slot) return out;
  let err = track.distanceFrom(car.s, slot.s);
  if (err > track.length / 2) err -= track.length;
  if (err < -150) err += track.length;
  out[0] = Math.asinh(err / 40);
  const ahead = ctl.carAheadInFile(car, slot.d);
  out[1] = ahead ? Math.sqrt(Math.max(0, Math.min(1, (track.distanceFrom(car.s, ahead.s) - 2 * P.CAR_RADIUS) / 200))) : 1;
  return out;
}
