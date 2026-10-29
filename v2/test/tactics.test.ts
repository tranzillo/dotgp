import { describe, expect, it } from 'vitest';
import { INTENT, INTENT_FROM, NeuralDriver, TACTIC, TACTICS_LAYERS, Team } from '../src/ai/drivers';
import { genomeSize, type Example } from '../src/ai/network';
import { Rng } from '../src/ai/rng';
import { TowerSpotter } from '../src/ai/spotter';
import { Car } from '../src/sim/car';
import { PHYSICS as P } from '../src/sim/constants';
import { World } from '../src/sim/world';
import { initialWeights } from '../src/ai/es';
import { Recorder } from '../src/school/recorder';
import { presetTrack } from '../src/trackgen';

const track = presetTrack('speedway');

/** Tactics that score one plan above the others whatever they see (the output layer's biases). */
function tacticsFor(plan: number): Float32Array {
  const w = new Float32Array(genomeSize(TACTICS_LAYERS));
  let at = 0;
  for (let l = 1; l < TACTICS_LAYERS.length - 1; l++) at += TACTICS_LAYERS[l] * (TACTICS_LAYERS[l - 1] + 1);
  const nIn = TACTICS_LAYERS[TACTICS_LAYERS.length - 2] + 1;
  for (let o = 0; o < 3; o++) w[at + o * nIn] = o === plan ? 1 : -1;
  return w;
}

function race(controller: (driver: NeuralDriver) => Team | Recorder, driver: NeuralDriver, seconds = 2) {
  const world = new World(track, { collisions: false, drafting: false });
  const car = new Car(0);
  car.placeOnTrack(track, 0, 0);
  car.vx = track.tx[car.trackIdx] * 40;
  car.vy = track.ty[car.trackIdx] * 40;
  world.addCar(car, controller(driver));
  for (let k = 0; k < seconds / P.DT; k++) world.step();
  return car;
}

describe('a driver\'s tactics', () => {
  it('pick its lane plan, and its driving sees the plan', () => {
    const driver = new NeuralDriver(initialWeights(new Rng(1)), undefined, undefined, { tactics: tacticsFor(TACTIC.LOW) });
    race((d) => new Team(d, new TowerSpotter(), null), driver);
    expect(driver.intent).toBe(1);
    const high = new NeuralDriver(initialWeights(new Rng(1)), undefined, undefined, { tactics: tacticsFor(TACTIC.HIGH) });
    race((d) => new Team(d, new TowerSpotter(), null), high);
    expect(high.intent).toBe(-1);
    const hold = new NeuralDriver(initialWeights(new Rng(1)), undefined, undefined, { tactics: tacticsFor(TACTIC.HOLD) });
    race((d) => new Team(d, new TowerSpotter(), null), hold);
    expect(hold.intent).toBe(0);
  });

  it('a driver without tactics has no plan, and drives as it did before it had the inputs', () => {
    const w = initialWeights(new Rng(2));
    const a = race((d) => new Team(d, new TowerSpotter(), null), new NeuralDriver(w));
    const b = race((d) => new Team(d, new TowerSpotter(), null), new NeuralDriver(w));
    expect(a.s).toBe(b.s);
    expect(a.d).toBe(b.d);
  });

  it('in lessons the driving is shown its teacher\'s plan, and the tactics learn the plan the teacher made', () => {
    const driver = new NeuralDriver(initialWeights(new Rng(3)));
    const teacher = { intent: -1, decide(car: Car) { car.inputX = 1; car.inputY = 0; } };
    const examples: Example[] = [], plans: Example[] = [];
    race((d) => new Recorder(new Team(d, new TowerSpotter(), null), d, teacher, { kind: 'student' }, examples, new Rng(1), { sample: 1, tactics: plans }), driver);
    // With no tactics of its own, it raced to its teacher's plan.
    expect(driver.intent).toBe(-1);
    expect(examples.length).toBeGreaterThan(10);
    for (const e of examples) {
      expect(e.x[INTENT_FROM + INTENT.HIGH]).toBe(1);
      expect(e.x[INTENT_FROM + INTENT.LOW]).toBe(0);
    }
    expect(plans.length).toBe(examples.length);
    for (const e of plans) expect(Array.from(e.y)).toEqual([-0.9, -0.9, 0.9].map(Math.fround));
  });
});
