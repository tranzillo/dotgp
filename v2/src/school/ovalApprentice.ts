/**
 * The oval stable's apprenticeship: new drivers learn to race ovals, cautions
 * and restarts included, by copying the traffic racer in real races.
 *
 * The classroom is a race: a full field of traffic racers, each an individual
 * (its own nerve and talent, so its own style), with students seated among
 * them. Every student has its own teacher, the traffic racer it would be: the
 * style its own nerve and talent give. The first round the teacher drives the
 * student's car and the student watches (what it saw, what the teacher did);
 * from then on the student drives, under its own human limits, and its teacher
 * says what it would have done at each moment, mistakes and all (DAgger). The
 * pit maneuver still drives the stops (pit stops are a skill of their own, to
 * come); debris cautions are thrown now and then so every student practises
 * cautions and restarts.
 *
 * Drivers start from nothing (a newcomer's wiring), not from the house
 * drivers: forty drivers, forty teachers, no shared ancestry.
 */
import { initialWeights } from '../ai/es';
import { CAUTION_FROM, DRIVER_LAYERS, NeuralDriver, Team, type DriverLimits } from '../ai/drivers';
import type { FormationTraits } from '../ai/formation';
import { type Example, trainSupervised } from '../ai/network';
import type { TrackKnowledge } from '../ai/observe';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { racerStyle, type RacerStyle, TrafficRacer } from '../ai/trafficRacer';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { FUEL_RANGE, TIRE_RANGE } from '../ai/evaluate';
import { ROLLING_START_SPEED } from '../sim/grid';
import { Track } from '../sim/track';
import { classroomRace } from './classroomRace';
import { Recorder, type Driving } from './recorder';
import type { World } from '../sim/world';
import { World as SimWorld } from '../sim/world';
import { FLAT_TRACK, generateLayout, hashSeed, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../trackgen';

/** Who a stable driver is: what it's like, and its human limits. Its weights are what it has learned. */
export interface StableDriver {
  lineage: number;
  nerve: number;
  talent: number;
  limits: { latency: number; noise: number };
  weights: Float32Array;
  /** The caution skill (a network of its own for when the field is pacing), once it has one. */
  caution: Float32Array | null;
}

/**
 * A new driver for the stable. Nerve as rookies draw it; talent anywhere; human limits
 * as people's: 0.1-0.2 s from seeing to the car answering, 2-8% motor noise.
 */
export function newStableDriver(lineage: number, seed: number): StableDriver {
  const rng = new Rng(hashSeed(seed, `stable${lineage}`));
  return {
    lineage,
    nerve: 0.15 + 0.7 * rng.next(),
    talent: rng.next(),
    limits: { latency: 0.1 + 0.1 * rng.next(), noise: 0.02 + 0.06 * rng.next() },
    weights: initialWeights(rng),
    caution: null,
  };
}

/** A driver's own teacher: the traffic racer its nerve and talent make (the same every time). */
export function teacherOf(d: { lineage: number; nerve: number; talent: number }): { style: RacerStyle; traits: FormationTraits } {
  const rng = new Rng(hashSeed(91, `teacher${d.lineage}`));
  return racerStyle(d.nerve, d.talent, () => rng.next());
}

/** The line a student knows: its teacher's (the fastest line at its teacher's margin, at its teacher's share of grip). */
export function lineOf(d: { lineage: number; nerve: number; talent: number }): TrackKnowledge {
  const { style } = teacherOf(d);
  return { grip: style.grip, margin: style.margin };
}

/**
 * More to record with what a student saw (experiments: what else would it need to see?): appended to each recorded
 * moment's inputs; the students themselves never see it. Unset in training.
 */
let recordExtra: ((car: Car, world: World) => Float32Array) | null = null;
export function setRecordExtra(f: ((car: Car, world: World) => Float32Array) | null): void { recordExtra = f; }

/** The ovals a round is raced on: the presets in turn, and generated ovals of every size and shape between. */
export function apprenticeTrack(round: number, seed: number): Track {
  const presets = [SHORT_TRACK, SPEEDWAY, FLAT_TRACK];
  if (round % 2 === 0) return ovalTrack(presets[(round / 2) % presets.length]);
  for (let k = 0; ; k++) {
    try {
      return new Track(generateLayout({ type: 'oval', seed: hashSeed(seed, `apprentice${round}:${k}`) }));
    } catch (e) {
      if (k >= 5) throw e;
    }
  }
}

export interface OvalApprenticeOptions {
  rounds?: number;
  /** Cars in each classroom race (students and teachers). */
  field?: number;
  /** Laps of each classroom race. */
  laps?: number;
  /** Debris cautions per lap (so every race has a few). */
  debris?: number;
  /** Passes over the recorded moments each round (the first: more). */
  epochs?: number;
  /** Moments trained on per student per round: a fresh sample of everything recorded so far. */
  maxExamples?: number;
  /**
   * After the first round: 0, the students drive (DAgger); above 0, their teachers drive through shaken hands
   * (noise injection), the drifting error this share of the inputs' range at full strength (reached by round 3).
   */
  shake?: number;
  /** Told after each round. */
  onRound?: (round: number, report: { track: string; losses: number[]; cautionLoss: number; examples: number; out: number; soloCrashes: number; seconds: number }) => void;
}

/**
 * The teacher that says what a student should do: its own traffic racer, reacting to flags at once. The student's
 * own latency is its delay; a teacher that also waited its personal reaction time would answer the same moment
 * (the flag just out) differently from one time to the next, and the student couldn't tell why.
 */
function labellingTeacher(d: StableDriver): TrafficRacer {
  const { style, traits } = teacherOf(d);
  return new TrafficRacer(style, undefined, { ...traits, reaction: 0 });
}

/** Lanes solo drives start in (m from the middle), so the student sees its way back to the line from either side. */
const SOLO_LANES = [-5, 0, 5];
/** Seconds of each solo drive. */
const SOLO_SECONDS = 60;

/**
 * Solo drives on the round's track, every student from each lane on tyres and fuel anywhere a stint leaves them:
 * the student alone, the way it is only a few percent of the time in a 40-car race, where it would learn to brake
 * for the car ahead and never where to brake for the corner. Returns how many drives the student crashed.
 */
function soloDrives(track: Track, students: StableDriver[], driving: Driving, examples: Example[][], rng: Rng, round: number, seed: number): number {
  let crashed = 0;
  students.forEach((d, s) => {
    for (const lane of SOLO_LANES) {
      const world = new SimWorld(track, { collisions: false, drafting: false, wearScale: 4 });
      const car = new Car(0);
      car.placeOnTrack(track, rng.next() * track.length, lane);
      car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
      car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
      car.tireLife = TIRE_RANGE[0] + rng.next() * (TIRE_RANGE[1] - TIRE_RANGE[0]);
      car.fuel = FUEL_RANGE[0] + rng.next() * (FUEL_RANGE[1] - FUEL_RANGE[0]);
      const limits: DriverLimits = { ...d.limits, seed: hashSeed(seed, `solo${round}:${d.lineage}:${lane}`) };
      const student = new NeuralDriver(d.weights, undefined, lineOf(d), { limits, caution: d.caution ?? undefined });
      world.addCar(car, new Recorder(new Team(student, new TowerSpotter(), null), student, labellingTeacher(d), driving, examples[s], rng, { latency: d.limits.latency, extra: recordExtra ?? undefined }));
      for (let k = 0; k < SOLO_SECONDS / P.DT && !car.retired; k++) world.step();
      if (car.retired) crashed++;
    }
  });
  return crashed;
}

/**
 * Teach a group of stable drivers (weights trained in place) by apprenticeship: each round solo drives and a
 * classroom race on that round's oval, then training on a sample of everything recorded so far, half of it alone.
 */
export function apprenticeStable(students: StableDriver[], seed: number, options: OvalApprenticeOptions = {}): void {
  const opts = {
    rounds: 10, field: 40, laps: 30, debris: 0.05, epochs: 4, maxExamples: 60_000, shake: 0, ...options,
  };
  const rng = new Rng(hashSeed(seed, 'apprentice'));
  const examples: Example[][] = students.map(() => []);
  const alone: Example[][] = students.map(() => []);
  for (let round = 0; round < opts.rounds; round++) {
    const t0 = Date.now();
    const track = apprenticeTrack(round, seed);
    // Round 0 the students watch; then, noise injection (the teacher shaken, harder as the rounds go on) or DAgger.
    const driving: Driving = round === 0 ? { kind: 'teacher' }
      : opts.shake > 0 ? { kind: 'shaken', sigma: opts.shake * Math.min(1, round / 3) } : { kind: 'student' };
    const soloCrashes = soloDrives(track, students, driving, alone, rng, round, seed);
    const { out } = classroomRace(track, students, driving, examples, rng, { field: opts.field, laps: opts.laps, debris: opts.debris, extra: recordExtra ?? undefined }, round, seed);
    const cautionLosses: number[] = [];
    // Two skills, trained apart: racing (alone and in traffic under green) and cautions (the field pacing), the
    // caution network starting as a copy of the racing one. Neither's examples crowd out the other's.
    const half = Math.floor(opts.maxExamples / 2);
    const epochs = round === 0 ? 3 * opts.epochs : opts.epochs;
    const losses = students.map((d, s) => {
      const pick = (all: Example[], n: number) => (all.length <= n ? all : sampleOf(all, n, rng));
      const green = examples[s].filter((e) => e.x[CAUTION_FROM] === 0), pacing = examples[s].filter((e) => e.x[CAUTION_FROM] !== 0);
      const loss = trainSupervised(DRIVER_LAYERS, d.weights, [...pick(alone[s], half), ...pick(green, half)], epochs, 0.01, () => rng.next());
      if (pacing.length) {
        // The caution network takes the wheel the moment the flag flies, often mid-corner at racing speed, and
        // caution moments are nearly all at caution pace: trained on those alone it forgot how to corner fast
        // and put cars in the wall as cautions began (stable v8: most damage under caution was the outside wall,
        // over 25 m/s; the teacher none). So it keeps racing too: half its examples are racing moments.
        d.caution ??= d.weights.slice();
        const keep = [...pick(alone[s], Math.floor(half / 2)), ...pick(green, Math.floor(half / 2))];
        cautionLosses.push(trainSupervised(DRIVER_LAYERS, d.caution, [...pick(pacing, half), ...keep], epochs, 0.01, () => rng.next()));
      }
      return loss;
    });
    opts.onRound?.(round, {
      track: `${track.length.toFixed(0)} m`, losses, examples: examples.reduce((a, e) => a + e.length, 0) + alone.reduce((a, e) => a + e.length, 0),
      out, soloCrashes, seconds: (Date.now() - t0) / 1000,
      cautionLoss: cautionLosses.length ? cautionLosses.reduce((a, b) => a + b, 0) / cautionLosses.length : NaN,
    });
  }
}

/** n of the items, drawn at random without replacement. */
function sampleOf<T>(items: T[], n: number, rng: Rng): T[] {
  const pool = items.slice();
  for (let i = 0; i < n; i++) {
    const j = i + rng.int(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
