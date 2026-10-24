/**
 * Road cautions practised by PPO: every decision under the safety car scored by what followed it.
 *
 * Copying the road teacher doesn't make road cautions clean: under the safety car students run off a narrow circuit
 * while catching up to the line, crawl and stop once in it, and race control retires a car stopped on track. Fitting the
 * teacher better (a smoother teacher, bigger networks, more inputs) didn't help; what's left is outcomes. Here the
 * group races on a circuit strung out round the lap, the safety car comes out after a few seconds, and every car
 * drives its own road caution network with variation (its own learner) until the restart; its road racing network
 * drives the green, its human limits carry both. A decision under the safety car earns, in seconds as everywhere:
 * damage taken, damage done by fault, fear by nerve, trauma; time lost to the safety car's speed until the leader is
 * picked up (catching up to the line), its place in the line after (out of place by how far, up to a band's worth;
 * a place gained costs as passing under caution does on ovals); and being retired (a car stopped on track, or
 * wrecked) costs it a car's worth of damage.
 */
import { DRIVER_LAYERS, NeuralDriver, Team, type DriverBrain } from '../ai/drivers';
import { COSTS, referenceLap } from '../ai/costs';
import { danger, fearScale } from '../ai/fear';
import { PaceCarDriver } from '../ai/formation';
import { fastestLine, lineAt } from '../ai/racingLine';
import { randomWeights } from '../ai/mlp';
import { PpoLearner, type Segment, type Step } from '../ai/ppo';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { CIRCUIT_RULES } from '../rules/rulebook';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { Race } from '../sim/race';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { lineOf } from './ovalApprentice';
import type { RoadCautionStudent } from './roadCautions';
import { circuitTrack } from './roadLesson';

const DECISION_SECONDS = P.CONTROL_EVERY * P.DT;
/** Cars in a drill (fewer where the circuit has fewer pit boxes). */
const FIELD = 12;
/** Seconds of green before the safety car, and after the restart before the drill ends. */
const GREEN_BEFORE = 4;
const GREEN_AFTER = 3;
/** The most a drill may take (s): catching up and lining up are what it practises; a GP circuit's restart can be later. */
const DRILL_LIMIT = 300;
/** Share of the reference lap's speed cars are going when the drill begins. */
const SPREAD_PACE = 0.8;
/** Seconds a second of being out of place costs, at the most (a band's worth off: PLACE_BAND m). */
const PLACE_COST = 0.5;
const PLACE_BAND = 30;
/** Laps a place gained under the safety car costs. */
const PASS_LAPS = 0.5;
/** Seconds being retired costs: a car's worth of damage. */
const RETIRE_COST = COSTS.damage;
const VALUE_LAYERS = [DRIVER_LAYERS[0], 64, 64, 1];

/** A student in a drill: its road racing network drives the green, its road caution policy (sampled) the safety car. */
class RoadCautionLearner implements DriverBrain {
  readonly steps: Step[] = [];
  private readonly driver: NeuralDriver;

  constructor(d: RoadCautionStudent, private readonly learner: PpoLearner, private readonly rng: Rng, handsSeed: number) {
    const limits = { ...d.limits, seed: handsSeed };
    this.driver = new NeuralDriver(d.weights, d.road, lineOf(d), { limits, roadCaution: learner.policy.weights });
  }

  decide(car: Car, world: World, radio: Float32Array, pit: Float32Array, caution: Float32Array): void {
    const input = this.driver.inputs(car, world, radio, pit, caution);
    const net = this.driver.netAt(world.track, input);
    if (net !== this.driver.roadCautionNet) { const out = net.forward(input); this.driver.apply(car, out[0], out[1]); return; }
    const x = Float32Array.from(input);
    const a = new Float32Array(2);
    const { logp, v } = this.learner.act(x, this.rng, a);
    this.driver.apply(car, a[0], a[1]);
    this.steps.push({ x, a, logp, v, r: 0 });
  }
}

/** One drill: the field strung out round a circuit at speed, the safety car out after a few seconds, to the restart. */
export class RoadCautionDrill {
  readonly world: World;
  readonly race: Race;
  private greenAt = -Infinity;
  private phase: 'green' | 'caution' | 'restarted' = 'green';

  constructor(readonly track: Track, field: number, controllerFor: (k: number) => Team, seed: number) {
    this.world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
    const rng = new Rng(seed);
    const line = fastestLine(track, 0.9);
    const ref = referenceLap(track).speed;
    const spots: number[] = [];
    while (spots.length < field) {
      const s = rng.next() * track.length;
      if (spots.every((o) => Math.abs(((s - o + 1.5 * track.length) % track.length) - track.length / 2) > 40)) spots.push(s);
    }
    for (let k = 0; k < field; k++) this.world.addCar(new Car(k), controllerFor(k));
    this.race = new Race(this.world, 999, new PaceCarDriver(), { rulebook: CIRCUIT_RULES, seed });
    // Strung out after the race has gridded them, as a caution finds a field in a race.
    this.world.cars.forEach((car, k) => {
      car.placeOnTrack(track, spots[k], lineAt(line, spots[k]).d);
      const v = SPREAD_PACE * ref[car.trackIdx];
      car.vx = track.tx[car.trackIdx] * v;
      car.vy = track.ty[car.trackIdx] * v;
    });
    this.race.startGreen();
  }

  get done(): boolean {
    return (this.phase === 'restarted' && this.world.time - this.greenAt > GREEN_AFTER) || this.world.time > DRILL_LIMIT
      || this.world.cars.every((c) => c.retired);
  }

  step(): void {
    this.race.step();
    const ctl = this.race.control!;
    if (this.phase === 'green' && this.world.time > GREEN_BEFORE) {
      ctl.debrisCaution(1);
      if (ctl.flag !== 'green') this.phase = 'caution';
    } else if (this.phase === 'caution' && ctl.flag === 'green') { this.phase = 'restarted'; this.greenAt = this.world.time; }
  }
}

export interface RoadCautionPpoReport {
  clean: number; damage: number; harm: number; out: number; placeError: number; lost: number; samples: number; kl: number; seconds: number;
}

export interface RoadCautionPpoOptions {
  iterations?: number;
  /** Drills per iteration (each with every student in it). */
  worlds?: number;
  /** Iterations at the start in which only the value estimate learns (the policy already drives). */
  warmup?: number;
  onIteration?: (it: number, report: RoadCautionPpoReport) => void;
}

/** Practise a group of students' road caution skills by PPO (their road caution networks trained in place). */
export function practiseRoadCautionsPpo(students: RoadCautionStudent[], seed: number, options: RoadCautionPpoOptions = {}): void {
  const { iterations = 100, worlds = 2, warmup = 5 } = options;
  const rng = new Rng(hashSeed(seed, 'road-caution-ppo'));
  const learners = students.map((d) => {
    d.roadCaution ??= d.road.slice();
    return new PpoLearner(DRIVER_LAYERS, d.roadCaution, VALUE_LAYERS, randomWeights(VALUE_LAYERS, () => rng.gaussian(), 0.1), {}, 0.1);
  });
  const fear = students.map((d) => fearScale(d.nerve));
  for (let it = 0; it < iterations; it++) {
    const t0 = Date.now();
    const segments: Segment[][] = students.map(() => []);
    let clean = 0, damage = 0, harm = 0, out = 0, placeSum = 0, placeN = 0, lost = 0, drives = 0;
    for (let w = 0; w < worlds; w++) {
      const n = it * worlds + w;
      const track = circuitTrack(hashSeed(seed, `ppo-circuit${n}`), n % 2 ? 'gp' : 'club');
      const field = Math.min(FIELD, track.maxField);
      const lap = track.length / referenceLap(track).pace;
      // Students in shuffled seats; seats beyond the group are students again.
      const order = Array.from({ length: field }, (_, k) => k % students.length).sort(() => rng.next() - 0.5);
      const drivers: RoadCautionLearner[] = [];
      const drill = new RoadCautionDrill(track, field, (k) => {
        drivers[k] = new RoadCautionLearner(students[order[k]], learners[order[k]], rng, hashSeed(seed, `hands${it}:${w}:${k}`));
        return new Team(drivers[k], new TowerSpotter(), null, false, true);
      }, hashSeed(seed, `drill${it}:${w}`));
      const cars = drill.world.cars;
      const ctl = drill.race.control!;
      const before = cars.map((c) => ({ health: c.health, harm: c.harmDone, trauma: 0, index: Infinity, retired: false }));
      const seen = cars.map(() => 0);
      const startHealth = cars.map((c) => c.health), startHarm = cars.map((c) => c.harmDone);
      while (!drill.done) {
        cars.forEach((c, k) => {
          before[k].health = c.health; before[k].harm = c.harmDone; before[k].retired = c.retired;
          before[k].trauma = Math.max(0, c.selfTrauma - c.selfInflicted);
        });
        for (let p = 0; p < P.CONTROL_EVERY && !drill.done; p++) drill.step();
        cars.forEach((car, k) => {
          const brain = drivers[k];
          if (brain.steps.length === seen[k]) return; // no safety car decision this interval
          seen[k] = brain.steps.length;
          const step = brain.steps[seen[k] - 1];
          const s = order[k];
          const trauma = Math.max(0, car.selfTrauma - car.selfInflicted);
          let r = -COSTS.damage * (before[k].health - car.health) - COSTS.harm * (car.harmDone - before[k].harm)
            - fear[s] * (COSTS.fear * danger(car, drill.world) * DECISION_SECONDS + COSTS.trauma * (trauma - before[k].trauma));
          if (car.retired && !before[k].retired) r -= RETIRE_COST;
          const slot = ctl.slotFor(car);
          if (!car.retired && ctl.pickedUp && slot) {
            let err = track.distanceFrom(car.s, slot.s);
            if (err > track.length / 2) err -= track.length;
            if (err < -150) err += track.length;
            r -= PLACE_COST * DECISION_SECONDS * Math.min(Math.abs(err), PLACE_BAND) / PLACE_BAND;
            placeSum += Math.abs(err); placeN++;
          } else if (!car.retired && ctl.flag === 'caution') {
            // Catching up to the line: time lost to the safety car's speed here.
            const behind = DECISION_SECONDS * Math.max(0, 1 - car.speed / Math.max(1, ctl.paceSpeedAt(car.s)));
            r -= behind; lost += behind;
          }
          if (slot && !car.retired) {
            if (slot.index < before[k].index && Number.isFinite(before[k].index)) r -= PASS_LAPS * lap * (before[k].index - slot.index);
            before[k].index = Math.min(before[k].index, slot.index);
          }
          step.r = r;
        });
      }
      // Every safety car a student drove is a segment of its own, ended (the restart, the drill's end, or out).
      cars.forEach((car, k) => {
        const brain = drivers[k];
        if (brain.steps.length) segments[order[k]].push({ steps: brain.steps.splice(0), bootstrap: 0 });
        const dmg = startHealth[k] - car.health, h = car.harmDone - startHarm[k];
        damage += dmg; harm += h; drives++;
        if (car.retired) out++;
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
      clean: clean / drives, damage: damage / drives, harm: harm / drives, out: out / drives,
      placeError: placeN ? placeSum / placeN : NaN, lost: lost / drives, samples, kl: kl / learners.length, seconds: (Date.now() - t0) / 1000,
    });
  }
}
