import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { mirrorLayout, presetLayout } from '../src/trackgen';

/** One scripted car driving solo for a while: where it got to, and its lateral position along the way. */
function drive(track: Track, lane: number, seconds: number): { dist: number; laps: number[]; d: number[] } {
  const world = new World(track, { collisions: false, drafting: false });
  const car = new Car(0);
  car.placeOnTrack(track, track.length - 20, lane);
  world.addCar(car, new ScriptedDriver(lane));
  const d: number[] = [];
  const steps = Math.round(seconds / P.DT);
  for (let k = 0; k < steps; k++) {
    world.step();
    if (k % 120 === 0) d.push(car.d);
  }
  return { dist: car.dist, laps: [...car.lapTimes], d };
}

describe('driving the other way round', () => {
  for (const id of ['short', 'speedway']) {
    it(`a mirrored ${id} is the same track reflected`, () => {
      const a = new Track(presetLayout(id)), b = new Track(mirrorLayout(presetLayout(id)));
      expect(b.length).toBeCloseTo(a.length, 6);
      for (let i = 0; i < a.n; i += 97) {
        expect(b.x[i]).toBeCloseTo(a.x[i], 6);
        expect(b.y[i]).toBeCloseTo(-a.y[i], 6);
        expect(b.kappa[i]).toBeCloseTo(-a.kappa[i], 9);
        expect(b.innerEdge(i)).toBeCloseTo(-a.outerEdge(i), 9);
        expect(b.bankAt(i, 3)).toBeCloseTo(-a.bankAt(i, -3), 9);
      }
      expect(b.surfaceAt(100, -a.innerEdgeAt(100) - 1)).toBe(a.surfaceAt(100, a.innerEdgeAt(100) + 1));
    });

    it(`a car laps the mirrored ${id} exactly as it laps the original (right turns as fast as left)`, () => {
      const a = drive(new Track(presetLayout(id)), 2, 90);
      const b = drive(new Track(mirrorLayout(presetLayout(id))), -2, 90);
      expect(a.laps.length).toBeGreaterThan(0);
      expect(b.laps.length).toBe(a.laps.length);
      a.laps.forEach((t, i) => expect(b.laps[i]).toBeCloseTo(t, 3));
      expect(b.dist).toBeCloseTo(a.dist, 2);
      a.d.forEach((d, i) => expect(b.d[i]).toBeCloseTo(-d, 3));
    });
  }
});
