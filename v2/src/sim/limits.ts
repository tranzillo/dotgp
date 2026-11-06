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

/**
 * Progress on valid laps, for scoring: an excursion spoils the lap in
 * progress, and a spoilt lap's progress (from the line, or wherever the car
 * started, to the line) is thrown away, as its time is. Step it after each
 * world step.
 */
export class ValidProgress {
  /** Excursions past the limits so far (each counted once, as it begins). */
  excursions = 0;
  private off = false;
  private lapFrom: number;
  private spoilt = false;
  private thrown = 0;
  private nextLine: number;

  constructor(private readonly car: Car) {
    this.lapFrom = car.dist;
    this.nextLine = car.nextLineDist;
  }

  step(track: Track): void {
    const car = this.car;
    if (car.nextLineDist !== this.nextLine) {
      // Crossed the line: the lap that just ended is kept or thrown away.
      if (this.spoilt) this.thrown += this.nextLine - this.lapFrom;
      this.lapFrom = this.nextLine;
      this.spoilt = false;
      this.nextLine = car.nextLineDist;
    }
    const off = pastTrackLimits(car, track);
    if (off && !this.off) {
      this.excursions++;
      this.spoilt = true;
    }
    this.off = off;
  }

  /** Metres of progress on spoilt laps (the one in progress included). */
  get thrownAway(): number {
    return this.thrown + (this.spoilt ? Math.max(0, this.car.dist - this.lapFrom) : 0);
  }
}
