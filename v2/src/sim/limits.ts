import { PHYSICS as P } from './constants';
import type { Car } from './car';
import type { Track } from './track';

/**
 * Track limits: the whole car past the white line (its centre a car's half
 * width beyond the edge), racing, off pit lane. Race control counts these as
 * they begin; any of them invalidates the lap the car is on.
 */
export function pastTrackLimits(car: Car, track: Track): boolean {
  const i = car.trackIdx;
  return (car.d > track.innerEdge(i) + P.CAR_RADIUS || car.d < track.outerEdge(i) - P.CAR_RADIUS)
    && !car.retired && car.pit.phase === 'none' && car.surface !== 'pit' && car.surface !== 'apron';
}

/** A car's fastest valid lap (Infinity if it has none): laps past the track limits don't count. */
export function bestValidLap(car: Car): number {
  let best = Infinity;
  for (let k = 0; k < car.lapTimes.length; k++) if (car.lapValid[k] && car.lapTimes[k] < best) best = car.lapTimes[k];
  return best;
}
