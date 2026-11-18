/**
 * The stable's caution practice by PPO: every decision under caution scored
 * by what followed it.
 *
 * Copying the teacher gets a student's caution skill most of the way, but
 * not to where a full race needs it: eight cautions a race, forty cars, and
 * students still run into the car ahead in the line. Evolution strategies on
 * whole drills couldn't improve it (a drill's score is too blunt and too
 * noisy to compare a few variations by). PPO credits each request with what
 * came of it, so braking now earns the collision it avoided a few seconds
 * later; on circuits it beat ES once students had copied their teacher.
 *
 * The drill is the Cautions lesson's (a short green, a debris caution, the
 * line forming, the restart), every car a student of the group in a shuffled
 * slot: each drives its own caution network with variation (its own
 * learner), its racing network drives the green, and its human limits carry
 * both. A decision under caution earns, in seconds as everywhere: damage
 * taken, damage done by fault, fear by nerve (a hit about to happen), trauma,
 * and keeping its place in the line (out of place costs by how far, up to a
 * car-length band's worth; passing under caution costs as in the lesson).
 */
import { DRIVER_LAYERS, NeuralDriver, Team, type DriverBrain } from '../ai/drivers';
import { COSTS, lapSeconds } from '../ai/costs';
import { danger, fearScale } from '../ai/fear';
import { randomWeights } from '../ai/mlp';
import { PpoLearner, type Segment, type Step } from '../ai/ppo';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import type { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import type { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { CautionDrill, DRILL_FIELD } from './cautionLesson';
import { apprenticeTrack, lineOf, type StableDriver } from './ovalApprentice';

const DECISION_SECONDS = P.CONTROL_EVERY * P.DT;
/** Seconds a second of being out of place costs, at the most (a band's worth off: PLACE_BAND m). */
const PLACE_COST = 0.5;
const PLACE_BAND = 30;
/** Laps a place gained under caution costs (as the Cautions lesson). */
const PASS_LAPS = 0.5;
const VALUE_LAYERS = [DRIVER_LAYERS[0], 64, 64, 1];

/** A student in a drill: its racing network drives the green, its caution policy (sampled) the caution. */
class CautionLearner implements DriverBrain {
  readonly steps: Step[] = [];
  private readonly racing: NeuralDriver;
  private readonly view: NeuralDriver;

  constructor(d: StableDriver, private readonly learner: PpoLearner, private readonly rng: Rng, handsSeed: number) {
    const limits = { ...d.limits, seed: handsSeed };
    this.racing = new NeuralDriver(d.weights, undefined, lineOf(d), { limits });
    this.view = new NeuralDriver(learner.policy.weights, undefined, lineOf(d), { limits });
  }

  decide(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): void {
    if (caution[0] === 0) { this.racing.decide(car, world, radio, pit, caution); return; }
    const x = Float32Array.from(this.view.inputs(car, world, radio, pit, caution));
    const a = new Float32Array(2);
    const { logp, v } = this.learner.act(x, this.rng, a);
    this.view.apply(car, a[0], a[1]);
    this.steps.push({ x, a, logp, v, r: 0 });
  }
}

export interface CautionPpoOptions {
  iterations?: number;
  /** Drills per iteration (each with every student in it). */
  worlds?: number;
  /** Iterations at the start in which only the value estimate learns (the policy already drives). */
  warmup?: number;
  /** Share of drills that begin with the field strung out round the lap. */
  spread?: number;
  onIteration?: (it: number, report: { clean: number; damage: number; harm: number; placeError: number; samples: number; kl: number; seconds: number }) => void;
}

/** Practise a group of students' caution skills by PPO (their caution networks trained in place). */
export function practiseCautionsPpo(students: StableDriver[], seed: number, options: CautionPpoOptions = {}): void {
  const { iterations = 100, worlds = 2, warmup = 5, spread = 0.5 } = options;
  const rng = new Rng(hashSeed(seed, 'caution-ppo'));
  const learners = students.map((d) => {
    d.caution ??= d.weights.slice();
    return new PpoLearner(DRIVER_LAYERS, d.caution, VALUE_LAYERS, randomWeights(VALUE_LAYERS, () => rng.gaussian(), 0.1), {}, 0.1);
  });
  const fear = students.map((d) => fearScale(d.nerve));
  for (let it = 0; it < iterations; it++) {
    const t0 = Date.now();
    const segments: Segment[][] = students.map(() => []);
    let clean = 0, damage = 0, harm = 0, placeSum = 0, placeN = 0, drives = 0;
    for (let w = 0; w < worlds; w++) {
      const track = apprenticeTrack(it * worlds + w, seed);
      const lap = lapSeconds(track);
      // Students in shuffled slots; slots beyond the group (a drill's field is DRILL_FIELD) are students again.
      const order = Array.from({ length: DRILL_FIELD }, (_, k) => k % students.length).sort(() => rng.next() - 0.5);
      const drivers: Array<CautionLearner | null> = [];
      const drill = new CautionDrill(track, 0, (k) => {
        const s = order[k];
        const brain = new CautionLearner(students[s], learners[s], rng, hashSeed(seed, `hands${it}:${w}:${k}`));
        drivers[k] = brain;
        return new Team(brain, new TowerSpotter(), null, false, true);
      }, rng.next() < spread ? hashSeed(seed, `spread${it}:${w}`) : undefined);
      const cars = drill.world.cars;
      const ctl = drill.control;
      const before = cars.map((c) => ({ health: c.health, harm: c.harmDone, trauma: 0, index: Infinity }));
      const seen = cars.map(() => 0);
      const startHealth = cars.map((c) => c.health), startHarm = cars.map((c) => c.harmDone);
      while (!drill.done) {
        cars.forEach((c, k) => { before[k].health = c.health; before[k].harm = c.harmDone; before[k].trauma = Math.max(0, c.selfTrauma - c.selfInflicted); });
        for (let p = 0; p < P.CONTROL_EVERY && !drill.done; p++) drill.step();
        cars.forEach((car, k) => {
          const brain = drivers[k]!;
          if (brain.steps.length === seen[k]) return; // no caution decision this interval
          seen[k] = brain.steps.length;
          const step = brain.steps[seen[k] - 1];
          const s = order[k];
          const trauma = Math.max(0, car.selfTrauma - car.selfInflicted);
          let r = -COSTS.damage * (before[k].health - car.health) - COSTS.harm * (car.harmDone - before[k].harm)
            - fear[s] * (COSTS.fear * danger(car, drill.world) * DECISION_SECONDS + COSTS.trauma * (trauma - before[k].trauma));
          const slot = ctl.slotFor(car);
          if (slot && ctl.pickedUp && !car.retired) {
            let err = drill.world.track.distanceFrom(car.s, slot.s);
            if (err > drill.world.track.length / 2) err -= drill.world.track.length;
            if (err < -150) err += drill.world.track.length;
            r -= PLACE_COST * DECISION_SECONDS * Math.min(Math.abs(err), PLACE_BAND) / PLACE_BAND;
            placeSum += Math.abs(err); placeN++;
            if (slot.index < before[k].index && Number.isFinite(before[k].index)) r -= PASS_LAPS * lap * (before[k].index - slot.index);
            before[k].index = Math.min(before[k].index, slot.index);
          }
          step.r = r;
        });
      }
      // Every caution a student drove is a segment of its own, ended (the green, or the end of the drive).
      cars.forEach((car, k) => {
        const brain = drivers[k]!;
        if (brain.steps.length) segments[order[k]].push({ steps: brain.steps.splice(0), bootstrap: 0 });
        const dmg = startHealth[k] - car.health, h = car.harmDone - startHarm[k];
        damage += dmg; harm += h; drives++;
        if (dmg < 0.05 && h < 0.05 && !car.retired) clean++;
      });
    }
    let samples = 0, kl = 0;
    learners.forEach((l, s) => {
      if (!segments[s].length) return;
      const stats = l.update(segments[s], rng, it >= warmup);
      samples += stats.samples; kl += stats.kl;
    });
    options.onIteration?.(it, {
      clean: clean / drives, damage: damage / drives, harm: harm / drives, placeError: placeN ? placeSum / placeN : NaN,
      samples, kl: kl / learners.length, seconds: (Date.now() - t0) / 1000,
    });
  }
}
