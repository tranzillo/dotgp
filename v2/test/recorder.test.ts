import { describe, expect, it } from 'vitest';
import { NeuralDriver, Team } from '../src/ai/drivers';
import type { Example } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { TowerSpotter } from '../src/ai/spotter';
import { DEFAULT_STYLE, TrafficRacer } from '../src/ai/trafficRacer';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { World, type Controller } from '../src/sim/world';
import { initialRoadWeights, circuitTrack } from '../src/school/roadLesson';
import { startInLap } from '../src/school/pitLesson';
import { Recorder, type Driving } from '../src/school/recorder';
import { presetTrack } from '../src/trackgen';

const track = circuitTrack(7, 'club');
const student = () => {
  const w = initialRoadWeights(new Rng(3));
  return new NeuralDriver(w, w);
};

/** Ten seconds round a club circuit from a standing start in lane 0; where the car got to. */
function drive(controller: (car: Car) => Controller, steps = 10 / P.DT): Car {
  const world = new World(track, { collisions: false, drafting: false });
  const car = new Car(0);
  world.addCar(car, controller(car));
  car.placeOnTrack(track, 0, 0);
  for (let k = 0; k < steps; k++) world.step();
  return car;
}

describe('the apprenticeship recorder', () => {
  it('watching, the teacher drives exactly as it would alone, and about the sampled share of moments is recorded', () => {
    const alone = drive(() => new TrafficRacer({ ...DEFAULT_STYLE, pass: Infinity }));
    const examples: Example[] = [];
    const s = student();
    const watched = drive(() => new Recorder(new Team(s, new TowerSpotter(), null), s, new TrafficRacer({ ...DEFAULT_STYLE, pass: Infinity }),
      { kind: 'teacher' }, examples, new Rng(1)));
    expect(watched.s).toBeCloseTo(alone.s, 6);
    expect(watched.d).toBeCloseTo(alone.d, 6);
    const decisions = 10 / P.DT / P.CONTROL_EVERY;
    expect(examples.length).toBeGreaterThan(0.2 * decisions);
    expect(examples.length).toBeLessThan(0.4 * decisions);
    for (const e of examples) for (const v of e.y) expect(Math.abs(v)).toBeLessThanOrEqual(0.95);
  });

  it('driving, the student drives (not the teacher) and every moment recorded has its teacher\'s answer', () => {
    const alone = drive(() => new TrafficRacer({ ...DEFAULT_STYLE, pass: Infinity }));
    const examples: Example[] = [];
    const s = student();
    const driving: Driving = { kind: 'student' };
    const own = drive(() => new Recorder(new Team(s, new TowerSpotter(), null), s, new TrafficRacer({ ...DEFAULT_STYLE, pass: Infinity }),
      driving, examples, new Rng(1), { sample: 1 }));
    expect(Math.abs(own.s - alone.s) + Math.abs(own.d - alone.d)).toBeGreaterThan(1); // a newcomer doesn't drive like its teacher
    expect(examples.length).toBe(Math.floor(10 / P.DT / P.CONTROL_EVERY));
  });

  it('teaching stops, it records only while the stop is under way', () => {
    const oval = presetTrack('short');
    const world = new World(oval, { collisions: false, drafting: false });
    const car = new Car(0);
    const s = new NeuralDriver(initialRoadWeights(new Rng(3)));
    const team = new Team(s, new TowerSpotter(), null, false);
    const examples: Example[] = [];
    world.addCar(car, new Recorder(team, s, null, { kind: 'teacher' }, examples, new Rng(1), { skill: 'stops', sample: 1 }));
    startInLap(car, team, oval);
    car.pit.phase = 'in';
    car.pit.call = { tires: true, fuel: 15, repair: false };
    team.autopilot.begin(car);
    let stopping = 0, after = 0;
    for (let k = 0; k < 200 / P.DT; k++) {
      const before = examples.length;
      const was = car.pit.phase;
      world.step();
      if (was !== 'none') stopping += examples.length - before;
      else after += examples.length - before;
    }
    expect(stopping).toBeGreaterThan(100);
    expect(after).toBe(0);
  });
});
