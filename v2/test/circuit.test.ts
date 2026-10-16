import { describe, expect, it } from 'vitest';
import { ScriptedDriver } from '../src/ai/drivers';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { Track } from '../src/sim/track';
import { World } from '../src/sim/world';
import { CIRCUIT_CLASSES, generateLayout, type CircuitParams } from '../src/trackgen';

const corners = (p: CircuitParams) => p.elements.flatMap((e) => ('corner' in e ? [e.corner] : []));

describe('road circuits', () => {
  for (const variant of ['club', 'gp']) {
    it(`generates valid ${variant} circuits at the class's length, with right-handers among the corners`, () => {
      const [lo, hi] = CIRCUIT_CLASSES[variant].length;
      for (let seed = 1; seed <= 12; seed++) {
        const layout = generateLayout({ type: 'circuit', seed, variant });
        const track = new Track(layout);
        const p = layout.params as unknown as CircuitParams;
        expect(track.closureError).toBeLessThan(1);
        expect(track.length).toBeGreaterThan(lo * 0.85);
        expect(track.length).toBeLessThan(hi * 1.1);
        expect(corners(p).some((c) => c.angle < 0)).toBe(true);
        expect(Math.min(...corners(p).map((c) => c.radius))).toBeGreaterThanOrEqual(12);
        expect(p.main).toBeGreaterThan(400);
      }
    });
  }

  it('is deterministic: a seed always gives the same circuit', () => {
    const a = generateLayout({ type: 'circuit', seed: 77 });
    const b = generateLayout({ type: 'circuit', seed: 77 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('a scripted car laps circuits cleanly, right-handers and all (no barrier touched)', () => {
    for (const seed of [1, 2, 3]) {
      const track = new Track(generateLayout({ type: 'circuit', seed, variant: 'club' }));
      const world = new World(track, { collisions: false, drafting: false });
      const car = new Car(0);
      car.placeOnTrack(track, track.length - 20, 0);
      world.addCar(car, new ScriptedDriver(0, 0.9));
      for (let k = 0; k < 400 / P.DT && car.lapTimes.length < 2; k++) world.step();
      expect(car.lapTimes.length).toBe(2);
      expect(car.wallHits).toBe(0);
      expect(car.health).toBeGreaterThan(0.99);
    }
  });
});

describe('the road-course skill', () => {
  it('drives road circuits; ovals keep the driver\'s own network', async () => {
    const { NeuralDriver, adaptWeights } = await import('../src/ai/drivers');
    const { presetTrack } = await import('../src/trackgen');
    const { readFileSync } = await import('node:fs');
    const w = adaptWeights(Float32Array.from(JSON.parse(readFileSync('public/drivers/default.json', 'utf8')).drivers[0].weights));
    const road = w.slice().fill(0);
    const driver = new NeuralDriver(w, road);
    const circuit = new Track(generateLayout({ type: 'circuit', seed: 1, variant: 'club' }));
    expect(driver.netFor(circuit)).toBe(driver.roadNet);
    expect(driver.netFor(presetTrack('short'))).toBe(driver.net);
    // Without the skill, a driver takes circuits with its own driving.
    const plain = new NeuralDriver(w);
    expect(plain.netFor(circuit)).toBe(plain.net);
  });
});
