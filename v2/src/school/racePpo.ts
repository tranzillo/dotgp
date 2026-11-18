/**
 * Race practice for the oval stable: learning in real races by how things
 * turn out, anchored to the teacher.
 *
 * Copying its teacher gets a student most of the way (83-92% of what its
 * teacher does under green, less under caution), but over 150 km in a 40-car
 * field the rest adds up: teachers lose about one car a race, students about
 * thirty. Neither bigger networks nor more to see closed it. So students
 * practise: PPO in 40-car races with debris cautions, every decision scored
 * in seconds by what followed (progress at the track's pace, damage taken,
 * damage done by fault, fear and trauma by nerve; under caution, keeping
 * its place in the line instead of progress). Each skill has its own learner
 * (racing under green, the caution network while pacing), driven through the
 * driver's human limits. The rest of the field is the stable, no script.
 *
 * Anchored: every rollout also records what the student's own teacher would
 * do from where its car is, and after each PPO update both networks take a
 * small supervised step toward those answers, so practice mends mistakes
 * without forgetting how to race (the lesson of every drill lesson so far).
 */
import { COSTS, trackPace } from '../ai/costs';
import { DRIVER_LAYERS, NeuralDriver, Team, type DriverBrain } from '../ai/drivers';
import { danger, fearScale } from '../ai/fear';
import { PaceCarDriver } from '../ai/formation';
import { randomWeights } from '../ai/mlp';
import { type Example, trainSupervised } from '../ai/network';
import { randomTraits, StrategistCrewChief } from '../ai/pitting';
import { PpoLearner, type Segment, type Step } from '../ai/ppo';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { TrafficRacer } from '../ai/trafficRacer';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { placeOnGrid } from '../sim/grid';
import { Race } from '../sim/race';
import { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { apprenticeTrack, lineOf, teacherOf, type StableDriver } from './ovalApprentice';

const DECISION_SECONDS = P.CONTROL_EVERY * P.DT;
const VALUE_LAYERS = [DRIVER_LAYERS[0], 64, 64, 1];
/** Seconds a second out of place in the caution line costs at most (PLACE_BAND m off or more). */
const PLACE_COST = 0.5;
const PLACE_BAND = 30;
/** Share of decisions the teacher's answer is recorded for (the anchor). */
const ANCHOR_SAMPLE = 0.3;

/** A student in a practice race: each skill drives with variation through its own learner; the teacher's answers recorded. */
class RacePractitioner implements DriverBrain {
  readonly steps: { racing: Step[]; caution: Step[] } = { racing: [], caution: [] };
  readonly anchor: { racing: Example[]; caution: Example[] } = { racing: [], caution: [] };
  /** The skill that made the last decision. */
  last: 'racing' | 'caution' | null = null;
  private readonly racingView: NeuralDriver;
  private readonly cautionView: NeuralDriver;
  private readonly teacher: TrafficRacer;

  constructor(
    d: StableDriver, private readonly learners: { racing: PpoLearner; caution: PpoLearner }, private readonly rng: Rng, handsSeed: number,
  ) {
    const limits = { ...d.limits, seed: handsSeed };
    this.racingView = new NeuralDriver(learners.racing.policy.weights, undefined, lineOf(d), { limits });
    this.cautionView = new NeuralDriver(learners.caution.policy.weights, undefined, lineOf(d), { limits });
    const { style, traits } = teacherOf(d);
    this.teacher = new TrafficRacer(style, undefined, { ...traits, reaction: 0 });
  }

  decide(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): void {
    const skill = caution[0] === 0 ? 'racing' : 'caution';
    const view = skill === 'racing' ? this.racingView : this.cautionView;
    // The teacher's answer from where the car is (it keeps its own flag timing and pass, so it decides every time).
    const px = car.inputX, py = car.inputY;
    this.teacher.takeOver(car, world);
    this.teacher.decide(car, world);
    const label = Float32Array.of(Math.max(-0.95, Math.min(0.95, car.inputX)), Math.max(-0.95, Math.min(0.95, car.inputY)));
    car.inputX = px; car.inputY = py;
    const x = Float32Array.from(view.inputs(car, world, radio, pit, caution));
    if (this.rng.next() < ANCHOR_SAMPLE) this.anchor[skill].push({ x, y: label, mask: Float32Array.of(1, 1) });
    const a = new Float32Array(2);
    const { logp, v } = this.learners[skill].act(x, this.rng, a);
    view.apply(car, a[0], a[1]);
    this.steps[skill].push({ x, a, logp, v, r: 0 });
    this.last = skill;
  }
}

export interface RacePracticeOptions {
  iterations?: number;
  /** Cars in each practice race, and its laps. */
  field?: number;
  laps?: number;
  /** Debris cautions per lap. */
  debris?: number;
  /** Iterations at the start in which only the value estimates learn (the policies already drive). */
  warmup?: number;
  /** Learning rate of the anchor's supervised step (per iteration, one pass). */
  anchorLr?: number;
  onIteration?: (it: number, report: { out: number; damage: number; harm: number; laps: number; seconds: number }) => void;
}

/** Practise a group of students (racing and caution networks trained in place) in races among the rest of the stable. */
export function practiseInRaces(students: StableDriver[], stable: StableDriver[], seed: number, options: RacePracticeOptions = {}): void {
  const { iterations = 100, field = 40, laps = 20, debris = 0.05, warmup = 3, anchorLr = 0.002 } = options;
  const rng = new Rng(hashSeed(seed, 'race-ppo'));
  const learners = students.map((d) => {
    d.caution ??= d.weights.slice();
    const value = () => randomWeights(VALUE_LAYERS, () => rng.gaussian(), 0.1);
    return {
      racing: new PpoLearner(DRIVER_LAYERS, d.weights, VALUE_LAYERS, value(), {}, 0.05),
      caution: new PpoLearner(DRIVER_LAYERS, d.caution, VALUE_LAYERS, value(), {}, 0.08),
    };
  });
  const fear = students.map((d) => fearScale(d.nerve));
  const others = stable.filter((o) => !students.includes(o));
  for (let it = 0; it < iterations; it++) {
    const t0 = Date.now();
    const track = apprenticeTrack(it, seed);
    const pace = trackPace(track);
    const world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
    // Students spread through the field, the rest of the stable round them.
    const slots = new Map<number, number>();
    students.map((_, i) => i).sort(() => rng.next() - 0.5)
      .forEach((s, i) => slots.set(Math.floor(((i + rng.next()) * field) / students.length) % field, s));
    const brains: Array<{ s: number; brain: RacePractitioner } | null> = [];
    for (let k = 0; k < field; k++) {
      const car = new Car(k);
      placeOnGrid(car, track, k, true);
      const chief = new StrategistCrewChief(randomTraits(() => rng.next()));
      const s = slots.get(k);
      if (s === undefined) {
        const o = others[rng.int(others.length)];
        const driver = new NeuralDriver(o.weights, undefined, lineOf(o), { limits: { ...o.limits, seed: hashSeed(seed, `o${it}:${k}`) }, caution: o.caution ?? undefined });
        world.addCar(car, new Team(driver, new TowerSpotter(), chief, false, true));
        brains.push(null);
        continue;
      }
      const brain = new RacePractitioner(students[s], learners[s], rng, hashSeed(seed, `hands${it}:${k}`));
      world.addCar(car, new Team(brain, new TowerSpotter(), chief, false, true));
      brains.push({ s, brain });
    }
    const race = new Race(world, laps, new PaceCarDriver());
    const ctl = race.control!;
    const cars = world.cars;
    const segments = students.map(() => ({ racing: [] as Segment[], caution: [] as Segment[] }));
    const seen = cars.map(() => ({ racing: 0, caution: 0 }));
    const lastSkill: Array<'racing' | 'caution' | null> = cars.map(() => null);
    const before = cars.map(() => ({ dist: 0, health: 1, harm: 0, trauma: 0 }));
    const startHealth = cars.map((c) => c.health), startDist = cars.map((c) => c.dist);
    // Close a skill's run of decisions: terminal if the car is out, else its value estimate where it stopped.
    const close = (k: number, skill: 'racing' | 'caution', terminal: boolean) => {
      const b = brains[k]!;
      const steps = b.brain.steps[skill];
      if (!steps.length) return;
      const lastX = steps[steps.length - 1].x;
      segments[b.s][skill].push({ steps: steps.splice(0), bootstrap: terminal ? 0 : learners[b.s][skill].estimate(lastX) });
      seen[k][skill] = 0;
    };
    const debrisPerStep = (debris / 30) * DECISION_SECONDS;
    while (race.state !== 'finished' && world.time < laps * 300) {
      cars.forEach((c, k) => { before[k] = { dist: c.dist, health: c.health, harm: c.harmDone, trauma: Math.max(0, c.selfTrauma - c.selfInflicted) }; });
      for (let p = 0; p < P.CONTROL_EVERY; p++) race.step();
      if (ctl.flag === 'green' && race.started && rng.next() < debrisPerStep) ctl.debrisCaution();
      cars.forEach((car, k) => {
        const b = brains[k];
        if (!b) return;
        const skill = b.brain.last;
        if (!skill) return;
        if (lastSkill[k] && lastSkill[k] !== skill) close(k, lastSkill[k]!, false);
        lastSkill[k] = skill;
        const steps = b.brain.steps[skill];
        if (steps.length === seen[k][skill]) return; // no decision of its own this interval (the pit maneuver drove)
        seen[k][skill] = steps.length;
        const step = steps[steps.length - 1];
        const s = b.s;
        const trauma = Math.max(0, car.selfTrauma - car.selfInflicted);
        let r = -COSTS.damage * (before[k].health - car.health) - COSTS.harm * (car.harmDone - before[k].harm)
          - fear[s] * (COSTS.fear * danger(car, world) * DECISION_SECONDS + COSTS.trauma * (trauma - before[k].trauma));
        if (skill === 'racing') r += (car.dist - before[k].dist) / pace;
        else {
          const slot = ctl.slotFor(car);
          if (slot && ctl.pickedUp) {
            let err = track.distanceFrom(car.s, slot.s);
            if (err > track.length / 2) err -= track.length;
            if (err < -150) err += track.length;
            r -= PLACE_COST * DECISION_SECONDS * Math.min(Math.abs(err), PLACE_BAND) / PLACE_BAND;
          }
        }
        step.r = r;
        if (car.retired) close(k, skill, true);
      });
    }
    // Whatever's still open ends with the race.
    let out = 0, damage = 0, harm = 0, lapsRun = 0, n = 0;
    cars.forEach((car, k) => {
      const b = brains[k];
      if (!b) return;
      for (const skill of ['racing', 'caution'] as const) close(k, skill, car.retired);
      n++; out += car.retired && !race.isFinished(car) ? 1 : 0; damage += startHealth[k] - car.health;
      harm += car.harmDone; lapsRun += (car.dist - startDist[k]) / track.length;
    });
    // PPO on each skill, then the anchor: a small supervised step toward the teacher's answers.
    students.forEach((d, s) => {
      for (const skill of ['racing', 'caution'] as const) {
        if (segments[s][skill].length) learners[s][skill].update(segments[s][skill], rng, it >= warmup);
      }
      brains.forEach((b) => {
        if (!b || b.s !== s) return;
        if (it >= warmup && b.brain.anchor.racing.length) trainSupervised(DRIVER_LAYERS, d.weights, b.brain.anchor.racing, 1, anchorLr, () => rng.next());
        if (it >= warmup && b.brain.anchor.caution.length) trainSupervised(DRIVER_LAYERS, d.caution!, b.brain.anchor.caution, 1, anchorLr, () => rng.next());
      });
    });
    options.onIteration?.(it, { out, damage: damage / n, harm: harm / n, laps: lapsRun / n, seconds: (Date.now() - t0) / 1000 });
  }
}
