import { PHYSICS as P } from '../sim/constants';
import { compromise, type DamageModel } from '../sim/damage';

/**
 * Smoke from a damaged car (the second damage model, src/sim/damage.ts): dark, from the front of the car, thicker
 * the more compromised it is. It's the sign everyone reads: the car has gone from racing to saving itself, it's
 * heading low and coming in. A wreck still on track smokes too, until it's towed.
 *
 * Puffs live in wall-clock time (as the exhaust's do) and stay where they were dropped, swelling, drifting on the
 * breeze and fading, so a moving car strings out a thin plume behind it and a stopped one streams it downwind
 * (dropped in one place without the drift, a wreck's smoke pooled round it like a shadow). Drawn over the cars, faint:
 * a haze the car shows through. Sizes and drift scale with the drawn dot.
 */
export const SMOKE = {
  /** Puffs per second: barely compromised … about to fail. */
  RATE_MIN: 4,
  RATE_MAX: 14,
  /** Lifetime (s, wall clock), randomised ±30%. */
  LIFE: 2.4,
  /** Radius at birth × dot radius: barely compromised … about to fail. */
  SIZE_MIN: 0.2,
  SIZE_MAX: 0.45,
  /** A puff swells to this × its birth size as it fades. */
  GROWTH: 4.5,
  ALPHA_MIN: 0.12,
  ALPHA_MAX: 0.32,
  /** Where on the car a puff comes from, × dot radius: round the nose, along the car and across it. */
  ALONG: 0.35,
  ACROSS: 0.55,
  /** Drift (dot radii per second): the breeze, which swings slowly, and each puff's own, any way. */
  WIND: 3.2,
  WIND_SWING: 0.15,
  STRAY: 0.9,
  MAX_PUFFS: 2000,
  /** Dark grey, a little warm. */
  COLOR: '#2a2522',
};

/** What the smoke needs from a car. */
export interface SmokeCar {
  id: number;
  x: number;
  y: number;
  frameX: number;
  frameY: number;
  health: number;
  damageModel: DamageModel;
}

export interface SmokePuff {
  x: number;
  y: number;
  /** Offset from (x, y) at birth, in dot radii. */
  ox: number;
  oy: number;
  /** Drift, dot radii per second. */
  dx: number;
  dy: number;
  born: number;
  life: number;
  size: number;
  alpha: number;
}

export class Smoke {
  /** Per car: puffs owed but not yet dropped, and where it was last frame. */
  private readonly cars = new Map<number, { owed: number; x: number; y: number }>();
  private puffs: SmokePuff[] = [];
  private lastNow = 0;
  /** The breeze's heading (rad), swinging slowly. */
  private wind = Math.random() * 2 * Math.PI;

  reset(): void {
    this.cars.clear();
    this.puffs = [];
  }

  /** Puffs alive at `now` (s, wall clock), oldest first; the dead are dropped. */
  livePuffs(now: number): SmokePuff[] {
    let keep = 0;
    const shown: SmokePuff[] = [];
    for (const p of this.puffs) {
      const age = (now - p.born) / p.life;
      if (age >= 1) continue;
      this.puffs[keep++] = p;
      if (age >= 0) shown.push(p);
    }
    this.puffs.length = keep;
    return shown;
  }

  /** Drop this frame's puffs from every compromised car (a stopped one too: a wreck smokes where it sits). Returns the wall clock (s). */
  advance(cars: SmokeCar[]): number {
    const now = performance.now() / 1000;
    const dt = this.lastNow ? Math.min(0.1, now - this.lastNow) : 0;
    this.lastNow = now;
    this.wind += (Math.random() * 2 - 1) * SMOKE.WIND_SWING * dt;
    const windX = Math.cos(this.wind) * SMOKE.WIND, windY = Math.sin(this.wind) * SMOKE.WIND;
    const seen = new Set<number>();
    for (const car of cars) {
      const c = compromise(car);
      if (c <= 0) continue;
      seen.add(car.id);
      let state = this.cars.get(car.id);
      if (!state) this.cars.set(car.id, (state = { owed: 0, x: car.x, y: car.y }));
      state.owed = Math.min(4, state.owed + (SMOKE.RATE_MIN + (SMOKE.RATE_MAX - SMOKE.RATE_MIN) * c) * dt);
      const count = Math.floor(state.owed);
      state.owed -= count;
      // From the nose, spread along the path covered since the last frame.
      const noseX = car.x + car.frameX * P.CAR_RADIUS, noseY = car.y + car.frameY * P.CAR_RADIUS;
      const fromX = state.x + car.frameX * P.CAR_RADIUS, fromY = state.y + car.frameY * P.CAR_RADIUS;
      const jumped = Math.hypot(car.x - state.x, car.y - state.y) > 300; // a reset or a new event: no streak across
      for (let k = 0; k < count && this.puffs.length < SMOKE.MAX_PUFFS; k++) {
        const t = jumped ? 1 : (k + Math.random()) / count;
        // Somewhere round the nose: back along the car a little, either side of it.
        const along = (Math.random() * 2 - 1) * SMOKE.ALONG, across = (Math.random() * 2 - 1) * SMOKE.ACROSS;
        const stray = Math.random() * 2 * Math.PI, strayV = Math.random() * SMOKE.STRAY;
        this.puffs.push({
          x: fromX + (noseX - fromX) * t,
          y: fromY + (noseY - fromY) * t,
          ox: car.frameX * along - car.frameY * across,
          oy: car.frameY * along + car.frameX * across,
          dx: windX + Math.cos(stray) * strayV,
          dy: windY + Math.sin(stray) * strayV,
          born: now - (1 - t) * dt,
          life: SMOKE.LIFE * (0.7 + 0.6 * Math.random()),
          size: (SMOKE.SIZE_MIN + (SMOKE.SIZE_MAX - SMOKE.SIZE_MIN) * c) * (0.7 + 0.6 * Math.random()),
          alpha: (SMOKE.ALPHA_MIN + (SMOKE.ALPHA_MAX - SMOKE.ALPHA_MIN) * c) * (0.75 + 0.5 * Math.random()),
        });
      }
      state.x = car.x;
      state.y = car.y;
    }
    for (const id of this.cars.keys()) if (!seen.has(id)) this.cars.delete(id);
    return now;
  }
}
