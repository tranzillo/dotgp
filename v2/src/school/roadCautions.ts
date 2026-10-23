/**
 * Road circuits' cautions for the stable: formation laps and safety cars,
 * learned by each driver's own road caution network (a network of its own,
 * so cautions on circuits can't cost it its oval ones), in classroom races
 * on circuits: the students seated among their personalities' road teachers,
 * under the circuit rules (formation lap, standing start, the safety car),
 * with debris safety cars so every race has a few. As on ovals: the teacher
 * drives the first round (the students watch), then the students drive
 * (DAgger) through their human limits, their teachers saying what they'd do
 * from where the car is; and the caution network keeps racing too (half its
 * examples are racing moments: it takes the wheel the moment the safety car
 * is called, often mid-corner at racing speed).
 */
import { CAUTION_FROM, DRIVER_LAYERS, NeuralDriver, Team, type DriverLimits } from '../ai/drivers';
import { PaceCarDriver } from '../ai/formation';
import { type Example, trainSupervised } from '../ai/network';
import { randomTraits, StrategistCrewChief } from '../ai/pitting';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { racerStyle, TrafficRacer, type RacerStyle } from '../ai/trafficRacer';
import type { FormationTraits } from '../ai/formation';
import { CIRCUIT_RULES } from '../rules/rulebook';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { placeOnGrid } from '../sim/grid';
import { Race } from '../sim/race';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { lineOf, OvalApprentice, teacherOf, type Driving } from './ovalApprentice';
import { circuitTrack } from './roadLesson';

/** A stable driver as far as road cautions go: who it is, its road skill, and its road caution skill (once it has one). */
export interface RoadCautionStudent {
  lineage: number;
  nerve: number;
  talent: number;
  limits: { latency: number; noise: number };
  /** Its oval skill (the driver's main network) and its road skill. */
  weights: Float32Array;
  road: Float32Array;
  roadCaution: Float32Array | null;
}

/**
 * A driver's own road teacher: the traffic racer its personality makes, as on ovals (its grip, line, room, caution
 * manners), less what's for ovals only (smooth racing throttle, draft insurance) and passing (on circuits a
 * scripted pass cost more than it gained: practice finds passing).
 */
export function roadTeacherOf(d: { lineage: number; nerve: number; talent: number }): { style: RacerStyle; traits: FormationTraits } {
  const { style, traits } = teacherOf(d);
  return { style: { ...style, driveGain: undefined, insure: undefined, pass: Infinity }, traits };
}

export interface RoadCautionOptions {
  rounds?: number;
  /** Cars in each classroom race (students and teachers). */
  field?: number;
  laps?: number;
  /** Debris safety cars per lap (so every race has a few). */
  debris?: number;
  /**
   * Start drills per round: the end of the formation lap, the grid and the lights, then a few seconds of racing.
   * A race has one formation lap, and stopping in the grid box takes precision (overshoot it and the car can't
   * back into it): students given one grid stop a round overshot and parked, or crawled round again.
   */
  starts?: number;
  epochs?: number;
  /** Moments trained on per student per round (a fresh sample of everything recorded so far). */
  maxExamples?: number;
  onRound?: (round: number, report: { track: string; loss: number; pacing: number; out: number; safetyCars: number; seconds: number }) => void;
}

/** Seconds of racing after the lights in a start drill. */
const AFTER_START = 8;

/**
 * One classroom race on a circuit (or, startOnly, its start: until a few seconds after the lights). Returns how many
 * cars went out and how many safety cars there were.
 */
function classroomRace(
  track: Track, students: RoadCautionStudent[], driving: Driving, examples: Example[][], rng: Rng, opts: Required<Omit<RoadCautionOptions, 'onRound'>>,
  round: number, seed: number, startOnly = false,
): { out: number; safetyCars: number } {
  const world = new World(track, { collisions: true, drafting: true, wearScale: 4 });
  const slots = new Map<number, number>();
  const order = students.map((_, i) => i).sort(() => rng.next() - 0.5);
  order.forEach((s, i) => slots.set(Math.floor(((i + rng.next()) * opts.field) / students.length) % opts.field, s));
  for (let k = 0; k < opts.field; k++) {
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const chief = new StrategistCrewChief(randomTraits(() => rng.next()));
    const s = slots.get(k);
    if (s === undefined) {
      // An individual road racer of its own (a personality drawn for the seat).
      const who = new Rng(hashSeed(seed, `racer${round}:${k}`));
      const { style, traits } = racerStyle(0.15 + 0.7 * who.next(), who.next(), () => who.next());
      world.addCar(car, new Team(new TrafficRacer({ ...style, driveGain: undefined, insure: undefined, pass: Infinity }, undefined, traits),
        new TowerSpotter(), chief, false, true));
      continue;
    }
    const d = students[s];
    const limits: DriverLimits = { ...d.limits, seed: hashSeed(seed, `hands${round}:${d.lineage}`) };
    const student = new NeuralDriver(d.weights, d.road, lineOf(d), { limits, roadCaution: d.roadCaution ?? undefined });
    const team = new Team(student, new TowerSpotter(), chief, false, true);
    // The labelling teacher reacts to flags at once (the student's latency is its delay).
    const { style, traits } = roadTeacherOf(d);
    world.addCar(car, new OvalApprentice(team, student, new TrafficRacer(style, undefined, { ...traits, reaction: 0 }), driving, examples[s], rng, d.limits.latency));
  }
  const race = new Race(world, opts.laps, new PaceCarDriver(), { rulebook: CIRCUIT_RULES, seed: hashSeed(seed, `race${round}`) });
  const debrisPerSecond = opts.debris / 90; // a circuit lap's roughly a minute and a half
  let lightsAt = -1;
  while (race.state !== 'finished' && world.time < opts.laps * 600) {
    race.step();
    const ctl = race.control!;
    if (startOnly) {
      if (lightsAt < 0 && race.started && ctl.flag === 'green') lightsAt = world.time;
      if (lightsAt >= 0 && world.time - lightsAt > AFTER_START) break;
      if (world.time > 300) break; // a start that never comes
      continue;
    }
    if (ctl.flag === 'green' && race.started && rng.next() < debrisPerSecond * P.DT) ctl.debrisCaution();
  }
  return { out: world.cars.filter((c) => c.retired && !race.isFinished(c)).length, safetyCars: race.control!.cautions };
}

/**
 * Teach a group of stable drivers road cautions (their road caution networks, trained in place; a network starts
 * as a copy of the road skill): each round a classroom race on a new circuit, then training on a sample of the
 * pacing moments recorded so far and, as many again, racing moments.
 */
export function apprenticeRoadCautions(students: RoadCautionStudent[], seed: number, options: RoadCautionOptions = {}): void {
  const opts = { rounds: 8, field: 20, laps: 6, debris: 0.3, starts: 6, epochs: 4, maxExamples: 40_000, ...options };
  const rng = new Rng(hashSeed(seed, 'road-cautions'));
  const examples: Example[][] = students.map(() => []);
  for (const d of students) d.roadCaution ??= d.road.slice();
  for (let round = 0; round < opts.rounds; round++) {
    const t0 = Date.now();
    const track = circuitTrack(hashSeed(seed, `circuit${round}`), round % 2 ? 'gp' : 'club');
    const driving: Driving = round === 0 ? { kind: 'teacher' } : { kind: 'student' };
    const { out, safetyCars } = classroomRace(track, students, driving, examples, rng, opts, round, seed);
    for (let k = 0; k < opts.starts; k++) {
      const where = circuitTrack(hashSeed(seed, `start${round}:${k}`), k % 2 ? 'gp' : 'club');
      classroomRace(where, students, driving, examples, rng, opts, round * 100 + k + 1, seed, true);
    }
    const half = Math.floor(opts.maxExamples / 2);
    const pick = (all: Example[], n: number) => (all.length <= n ? all : sample(all, n, rng));
    let loss = 0, pacing = 0;
    students.forEach((d, s) => {
      const caution = examples[s].filter((e) => e.x[CAUTION_FROM] !== 0), racing = examples[s].filter((e) => e.x[CAUTION_FROM] === 0);
      pacing += caution.length;
      if (!caution.length) return;
      loss += trainSupervised(DRIVER_LAYERS, d.roadCaution!, [...pick(caution, half), ...pick(racing, half)],
        round === 0 ? 3 * opts.epochs : opts.epochs, 0.01, () => rng.next());
    });
    opts.onRound?.(round, { track: `${track.length.toFixed(0)} m`, loss: loss / students.length, pacing, out, safetyCars, seconds: (Date.now() - t0) / 1000 });
  }
}

/** n of the items, drawn at random without replacement. */
function sample<T>(items: T[], n: number, rng: Rng): T[] {
  const pool = items.slice();
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
