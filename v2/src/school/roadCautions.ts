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
 *
 * With `racing`, the same rounds teach road racing too: solo drives each round,
 * and the road skill learns from those and the races' green moments (racing
 * copied in full fields, as the oval stable's is).
 */
import { CAUTION_FROM, DRIVER_LAYERS, NeuralDriver, Team, type DriverLimits } from '../ai/drivers';
import { FUEL_RANGE, TIRE_RANGE } from '../ai/evaluate';
import { type Example, trainSupervised } from '../ai/network';
import { fastestLine, lineAt } from '../ai/racingLine';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { TrafficRacer } from '../ai/trafficRacer';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { ROLLING_START_SPEED } from '../sim/grid';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { hashSeed } from '../trackgen';
import { classroomRace, roadTeacherOf } from './classroomRace';
import { lineOf } from './ovalApprentice';
import { Recorder, type Driving } from './recorder';
import { circuitTrack } from './roadLesson';

export { roadTeacherOf } from './classroomRace';

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
  /**
   * Road racing too (the road skill, trained in place): each round solo drives as well (the student alone, from
   * lanes either side of its line, on worn tyres, knocked), and the road skill learns from those and the races' green
   * moments, half each: racing copied in full fields, not just alone and in small packs.
   */
  racing?: boolean;
  /** Knocks a minute in solo drives while the student drives (its speed cut to a random share of it). */
  knocks?: number;
  onRound?: (round: number, report: {
    track: string; loss: number; pacing: number; out: number; safetyCars: number; seconds: number;
    /** With racing: the road skill's loss, and solo drives that ended in a crash. */
    roadLoss?: number; soloCrashes?: number;
  }) => void;
}

/** Seconds of racing after the lights in a start drill. */
const AFTER_START = 8;

/** Lanes solo drives start in (m from the line), and how long each lasts (s). */
const SOLO_LANES = [-2, 0, 2];
const SOLO_SECONDS = 90;

/**
 * Solo drives on the round's circuit, every student from each lane, somewhere random round the lap, on tyres and fuel
 * anywhere a stint leaves them: the student alone, as it seldom is in a full field (where it would learn to brake for
 * the car ahead and never where to brake for the corner). Returns how many drives ended in a crash.
 */
function soloDrives(track: Track, students: RoadCautionStudent[], driving: Driving, alone: Example[][], rng: Rng, round: number, seed: number, knocks: number): number {
  let crashed = 0;
  students.forEach((d, s) => {
    const line = fastestLine(track, lineOf(d).margin);
    for (const lane of SOLO_LANES) {
      const world = new World(track, { collisions: false, drafting: false, wearScale: 4 });
      const car = new Car(0);
      const at = rng.next() * track.length;
      car.placeOnTrack(track, at, lineAt(line, at).d + lane);
      const speed = Math.min(ROLLING_START_SPEED, lineAt(line, at).speed);
      car.vx = track.tx[car.trackIdx] * speed;
      car.vy = track.ty[car.trackIdx] * speed;
      car.tireLife = TIRE_RANGE[0] + rng.next() * (TIRE_RANGE[1] - TIRE_RANGE[0]);
      car.fuel = FUEL_RANGE[0] + rng.next() * (FUEL_RANGE[1] - FUEL_RANGE[0]);
      const limits: DriverLimits = { ...d.limits, seed: hashSeed(seed, `solo${round}:${d.lineage}:${lane}`) };
      const student = new NeuralDriver(d.weights, d.road, lineOf(d), { limits });
      const { style, traits } = roadTeacherOf(d);
      world.addCar(car, new Recorder(new Team(student, new TowerSpotter(), null), student, new TrafficRacer(style, undefined, { ...traits, reaction: 0 }),
        driving, alone[s], rng, { latency: d.limits.latency, knock: (knocks * P.CONTROL_EVERY * P.DT) / 60 }));
      for (let k = 0; k < SOLO_SECONDS / P.DT && !car.retired; k++) world.step();
      if (car.retired) crashed++;
    }
  });
  return crashed;
}

/**
 * Teach a group of stable drivers road cautions (their road caution networks, trained in place; a network starts
 * as a copy of the road skill): each round a classroom race on a new circuit, then training on a sample of the
 * pacing moments recorded so far and, as many again, racing moments.
 */
export function apprenticeRoadCautions(students: RoadCautionStudent[], seed: number, options: RoadCautionOptions = {}): void {
  const opts = { rounds: 8, field: 20, laps: 6, debris: 0.3, starts: 6, epochs: 4, maxExamples: 40_000, racing: false, knocks: 2, ...options };
  const rng = new Rng(hashSeed(seed, 'road-cautions'));
  const examples: Example[][] = students.map(() => []);
  const alone: Example[][] = students.map(() => []);
  for (const d of students) d.roadCaution ??= d.road.slice();
  for (let round = 0; round < opts.rounds; round++) {
    const t0 = Date.now();
    const track = circuitTrack(hashSeed(seed, `circuit${round}`), round % 2 ? 'gp' : 'club');
    const driving: Driving = round === 0 ? { kind: 'teacher' } : { kind: 'student' };
    const soloCrashes = opts.racing ? soloDrives(track, students, driving, alone, rng, round, seed, opts.knocks) : undefined;
    // At most a car a pit box, as races are run.
    const race = { field: Math.min(opts.field, track.maxField), laps: opts.laps, debris: opts.debris };
    const { out, cautions: safetyCars } = classroomRace(track, students, driving, examples, rng, race, round, seed);
    for (let k = 0; k < opts.starts; k++) {
      const where = circuitTrack(hashSeed(seed, `start${round}:${k}`), k % 2 ? 'gp' : 'club');
      classroomRace(where, students, driving, examples, rng, { ...race, startOnly: AFTER_START }, round * 100 + k + 1, seed);
    }
    const half = Math.floor(opts.maxExamples / 2);
    const pick = (all: Example[], n: number) => (all.length <= n ? all : sample(all, n, rng));
    const epochs = round === 0 ? 3 * opts.epochs : opts.epochs;
    let loss = 0, pacing = 0, roadLoss = 0;
    students.forEach((d, s) => {
      const caution = examples[s].filter((e) => e.x[CAUTION_FROM] !== 0), racing = examples[s].filter((e) => e.x[CAUTION_FROM] === 0);
      pacing += caution.length;
      if (opts.racing) roadLoss += trainSupervised(DRIVER_LAYERS, d.road, [...pick(alone[s], half), ...pick(racing, half)], epochs, 0.01, () => rng.next());
      if (!caution.length) return;
      loss += trainSupervised(DRIVER_LAYERS, d.roadCaution!, [...pick(caution, half), ...pick(racing, half)],
        round === 0 ? 3 * opts.epochs : opts.epochs, 0.01, () => rng.next());
    });
    opts.onRound?.(round, {
      track: `${track.length.toFixed(0)} m`, loss: loss / students.length, pacing, out, safetyCars, seconds: (Date.now() - t0) / 1000,
      ...(opts.racing ? { roadLoss: roadLoss / students.length, soloCrashes } : {}),
    });
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
