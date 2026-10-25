import { PHYSICS as P } from '../sim/constants';
import { compromise } from '../sim/damage';

/**
 * Smoke from a damaged car (the second damage model, src/sim/damage.ts): black, from the front of the car, thicker
 * the more compromised it is. It's the sign everyone reads: the car has gone from racing to saving itself, it's
 * heading low and coming in. A wreck still on track smokes too, until it's towed.
 *
 * Puffs live in wall-clock time (as the exhaust's do) and stay where they were dropped, swelling and fading, so a
 * moving car strings out a plume behind it. Sizes scale with the drawn dot.
 */
export const SMOKE = {
  /** Puffs per second: barely compromised … about to fail. */
  RATE_MIN: 8,
  RATE_MAX: 34,
  /** Lifetime (s, wall clock), randomised ±30%. */
  LIFE: 1.8,
  /** Radius at birth × dot radius: barely compromised … about to fail. */
  SIZE_MIN: 0.45,
  SIZE_MAX: 1.25,
  /** A puff swells to this × its birth size as it fades. */
  GROWTH: 3.2,
  ALPHA_MIN: 0.35,
  ALPHA_MAX: 0.8,
  /** Sideways scatter, × dot radius; drifts further out as the puff ages. */
  SCATTER: 0.6,
  MAX_PUFFS: 3000,
  /** Near-black, a little warm. */
  COLOR: '#1a1714',
};

/** What the smoke needs from a car. */
export interface SmokeCar {
  id: number;
  x: number;
  y: number;
  frameX: number;
  frameY: number;
  health: number;
}

export interface SmokePuff {
  x: number;
  y: number;
  /** Sideways offset, in dot radii at birth. */
  ox: number;
  oy: number;
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
    const seen = new Set<number>();
    for (const car of cars) {
      const c = compromise(car.health);
      if (c <= 0) continue;
      seen.add(car.id);
      let state = this.cars.get(car.id);
      if (!state) this.cars.set(car.id, (state = { owed: 0, x: car.x, y: car.y }));
      state.owed = Math.min(6, state.owed + (SMOKE.RATE_MIN + (SMOKE.RATE_MAX - SMOKE.RATE_MIN) * c) * dt);
      const count = Math.floor(state.owed);
      state.owed -= count;
      // From the nose, spread along the path covered since the last frame.
      const noseX = car.x + car.frameX * P.CAR_RADIUS, noseY = car.y + car.frameY * P.CAR_RADIUS;
      const fromX = state.x + car.frameX * P.CAR_RADIUS, fromY = state.y + car.frameY * P.CAR_RADIUS;
      const jumped = Math.hypot(car.x - state.x, car.y - state.y) > 300; // a reset or a new event: no streak across
      for (let k = 0; k < count && this.puffs.length < SMOKE.MAX_PUFFS; k++) {
        const t = jumped ? 1 : (k + Math.random()) / count;
        const side = (Math.random() * 2 - 1) * SMOKE.SCATTER;
        this.puffs.push({
          x: fromX + (noseX - fromX) * t,
          y: fromY + (noseY - fromY) * t,
          ox: -car.frameY * side,
          oy: car.frameX * side,
          born: now - (1 - t) * dt,
          life: SMOKE.LIFE * (0.7 + 0.6 * Math.random()),
          size: (SMOKE.SIZE_MIN + (SMOKE.SIZE_MAX - SMOKE.SIZE_MIN) * c) * (0.8 + 0.4 * Math.random()),
          alpha: SMOKE.ALPHA_MIN + (SMOKE.ALPHA_MAX - SMOKE.ALPHA_MIN) * c,
        });
      }
      state.x = car.x;
      state.y = car.y;
    }
    for (const id of this.cars.keys()) if (!seen.has(id)) this.cars.delete(id);
    return now;
  }
}
