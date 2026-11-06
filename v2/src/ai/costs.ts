import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { ROLLING_START_SPEED } from '../sim/grid';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { ScriptedDriver } from './drivers';

/**
 * Training's one currency: seconds of race time. Every score a driver learns
 * from (practice, drills, race learning) prices progress, damage, fear and
 * trauma in seconds, so the same thing costs the same on every track and in
 * every series. Progress made converts at the track's own pace (trackPace).
 */
export const COSTS = {
  /** Per unit of health the car loses: contact never pays. */
  damage: 120,
  /** Per unit of damage done to others (by the share of the fault). */
  harm: 120,
  /** Per second of full fear (a hit that could hurt the driver imminent), for a driver of middling nerve. */
  fear: 1,
  /** Per unit of trauma beyond the damage itself (big hits), for a driver of middling nerve. */
  trauma: 120,
} as const;

interface ReferenceLap { pace: number; speed: Float32Array }
const laps = new WeakMap<Track, ReferenceLap>();

/**
 * The scripted line follower's lap of a track, at the margin it teaches road
 * courses with: its pace, and its speed at each centerline sample (where it
 * first passed it). It depends on the track alone.
 */
export function referenceLap(track: Track): ReferenceLap {
  const known = laps.get(track);
  if (known) return known;
  const world = new World(track, { collisions: false, drafting: false });
  const car = new Car(0);
  world.addCar(car, new ScriptedDriver(0, 0.9));
  car.placeOnTrack(track, track.length - 20, 0);
  car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
  car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
  const speed = new Float32Array(track.n).fill(NaN);
  const limit = 900 / P.DT;
  for (let i = 0; i < limit && !car.lapTimes.length && !car.retired; i++) {
    world.step();
    if (Number.isNaN(speed[car.trackIdx])) speed[car.trackIdx] = car.speed;
  }
  // Samples the car stepped over: the last speed seen before them.
  let last = speed.find((v) => !Number.isNaN(v)) ?? 0;
  for (let i = 0; i < speed.length; i++) { if (Number.isNaN(speed[i])) speed[i] = last; else last = speed[i]; }
  const pace = car.lapTimes.length ? track.length / car.lapTimes[0] : Math.max(1, car.dist) / Math.max(1, world.time);
  const lap = { pace, speed };
  laps.set(track, lap);
  return lap;
}

/** A track's own pace (m/s): the reference lap's. Progress on a short oval, a club circuit and a GP circuit converts to seconds alike. */
export function trackPace(track: Track): number {
  return referenceLap(track).pace;
}

/** Seconds a track's lap takes at its own pace: what a lap-denominated weight is worth in seconds. */
export function lapSeconds(track: Track): number {
  return track.length / trackPace(track);
}
