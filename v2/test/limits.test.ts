import { describe, expect, it } from 'vitest';
import { DRIVER_LAYERS, NeuralDriver } from '../src/ai/drivers';
import { genomeSize } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { World } from '../src/sim/world';
import { ovalTrack, SPEEDWAY } from '../src/trackgen';

const zeros = new Float32Array(16);
/** A random driver that doesn't look at its own last input (inputs 9 and 10), so what it decides doesn't depend on what the car got. */
const weights = () => {
  const rng = new Rng(5);
  const w = Float32Array.from({ length: genomeSize(DRIVER_LAYERS) }, () => rng.gaussian() * 0.3);
  for (let o = 0; o < DRIVER_LAYERS[1]; o++) for (const k of [9, 10]) w[o * (DRIVER_LAYERS[0] + 1) + 1 + k] = 0;
  return w;
};

/** The inputs a driver gives a car over n decisions, the car standing still on the speedway. */
function drive(driver: NeuralDriver, n: number): Array<[number, number]> {
  const track = ovalTrack(SPEEDWAY);
  const world = new World(track, { collisions: false });
  const car = new Car(0);
  car.placeOnTrack(track, 100, 0);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    driver.decide(car, world, new Float32Array(16), zeros, zeros);
    out.push([car.inputX, car.inputY]);
  }
  return out;
}

describe('human limits', () => {
  it('without them, the car gets exactly what the network decides', () => {
    const w = weights();
    expect(drive(new NeuralDriver(w), 20)).toEqual(drive(new NeuralDriver(w, undefined, undefined, { limits: { latency: 0, noise: 0, seed: 1 } }), 20));
  });

  it('latency: the car answers what the driver decided a reaction time ago', () => {
    const w = weights();
    const plain = drive(new NeuralDriver(w), 20);
    const ticks = 3;
    const late = drive(new NeuralDriver(w, undefined, undefined, { limits: { latency: ticks * P.CONTROL_EVERY * P.DT, noise: 0, seed: 1 } }), 20);
    // The same stationary car decides the same each time, so after the delay the inputs match.
    expect(late.slice(ticks)).toEqual(plain.slice(0, 20 - ticks));
    expect(late[0]).toEqual([0, 0]); // the car keeps what it had until the first decision comes through
  });

  it('motor noise strays from what was meant in proportion to its size, smoothly, and replays exactly', () => {
    const w = weights();
    const meant = drive(new NeuralDriver(w), 400);
    const a = drive(new NeuralDriver(w, undefined, undefined, { limits: { latency: 0, noise: 0.05, seed: 9 } }), 400);
    const b = drive(new NeuralDriver(w, undefined, undefined, { limits: { latency: 0, noise: 0.05, seed: 9 } }), 400);
    expect(a).toEqual(b);
    const rel = a.map(([x], k) => (x - meant[k][0]) / Math.abs(meant[k][0]));
    const sd = Math.sqrt(rel.reduce((s, r) => s + r * r, 0) / rel.length);
    expect(sd).toBeGreaterThan(0.025);
    expect(sd).toBeLessThan(0.1);
    // Smooth (drifting over ~0.25 s, not jitter): from one decision to the next the error moves about half its size, white noise ~1.4x.
    const step = Math.sqrt(rel.slice(1).reduce((s, r, k) => s + (r - rel[k]) ** 2, 0) / (rel.length - 1));
    expect(step).toBeLessThan(0.75 * sd);
  });
});
