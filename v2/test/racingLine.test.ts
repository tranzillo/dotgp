import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { racingLine, RacingLineDriver } from '../src/ai/racingLine';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { ROLLING_START_SPEED } from '../src/sim/grid';
import { bestValidLap } from '../src/sim/limits';
import { Track } from '../src/sim/track';
import { World, type Controller } from '../src/sim/world';
import { generateLayout, hashSeed } from '../src/trackgen';

function lap(track: Track, who: Controller): number {
  const world = new World(track, { collisions: false, drafting: false });
  const car = new Car(0);
  world.addCar(car, who);
  car.placeOnTrack(track, track.length - 20, 0);
  car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
  car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
  for (let i = 0; i < 300 / P.DT && car.lapTimes.length < 2 && !car.retired; i++) world.step();
  return bestValidLap(car);
}

describe('fastest line', () => {
  const track = new Track(generateLayout({ type: 'circuit', seed: hashSeed(4242, 'race-club4'), variant: 'club' }));
  const line = racingLine(track, { refine: 10 });

  it('stays within the track limits', () => {
    for (let k = 0; k < line.d.length; k++) {
      const i = track.indexAt(k * line.step);
      expect(line.d[k]).toBeLessThanOrEqual(track.innerEdge(i) + P.CAR_RADIUS);
      expect(line.d[k]).toBeGreaterThanOrEqual(track.outerEdge(i) - P.CAR_RADIUS);
    }
  });

  it('uses the width: out to the edges, not down the middle', () => {
    // Most of the lap more than halfway from the middle to an edge (a lane down the middle: none of it).
    let wide = 0;
    for (let k = 0; k < line.d.length; k++) {
      const i = track.indexAt(k * line.step);
      if (line.d[k] > track.innerEdge(i) / 2 || line.d[k] < track.outerEdge(i) / 2) wide++;
    }
    expect(wide / line.d.length).toBeGreaterThan(0.5);
  });

  it('drives a valid lap faster than the line follower', () => {
    const racer = lap(track, new RacingLineDriver(0.85, () => line));
    const follower = lap(track, new ScriptedDriver(0, 0.9));
    expect(Number.isFinite(racer)).toBe(true);
    expect(racer).toBeLessThan(follower * 0.95);
    // And no faster than its own profile (at full grip) allows.
    expect(racer).toBeGreaterThan(line.lapTime);
  }, 60_000);
});
