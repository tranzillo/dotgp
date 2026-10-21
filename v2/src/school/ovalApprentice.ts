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
import { DRIVER_LAYERS, NeuralDriver, Team, type DriverLimits } from '../ai/drivers';
import type { FormationTraits } from '../ai/formation';
import { PaceCarDriver } from '../ai/formation';
import { type Example, trainSupervised } from '../ai/network';
import { observeCaution } from '../ai/observe';
import { randomTraits, StrategistCrewChief } from '../ai/pitting';
import { Rng } from '../ai/rng';
import { TowerSpotter } from '../ai/spotter';
import { racerStyle, type RacerStyle, TrafficRacer } from '../ai/trafficRacer';
import { Car } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import { FUEL_RANGE, TIRE_RANGE } from '../ai/evaluate';
import { placeOnGrid, ROLLING_START_SPEED } from '../sim/grid';
import { Race } from '../sim/race';
import { Track } from '../sim/track';
import type { Controller, World } from '../sim/world';
import { World as SimWorld } from '../sim/world';
import { FLAT_TRACK, generateLayout, hashSeed, ovalTrack, SHORT_TRACK, SPEEDWAY } from '../trackgen';

/** Who a stable driver is: what it's like, and its human limits. Its weights are what it has learned. */
export interface StableDriver {
  lineage: number;
  nerve: number;
  talent: number;
  limits: { latency: number; noise: number };
  weights: Float32Array;
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
  };
}

/** A driver's own teacher: the traffic racer its nerve and talent make (the same every time). */
export function teacherOf(d: { lineage: number; nerve: number; talent: number }): { style: RacerStyle; traits: FormationTraits } {
  const rng = new Rng(hashSeed(91, `teacher${d.lineage}`));
  return racerStyle(d.nerve, d.talent, () => rng.next());
}

/** Share of the students' decisions recorded (moments a few frames apart are nearly the same). */
const SAMPLE = 0.3;

/** Records (what the student saw, what its teacher would do) whoever drives. */
class OvalApprentice implements Controller {
  constructor(
    readonly team: Team,
    private readonly student: NeuralDriver,
    private readonly teacher: TrafficRacer,
    private readonly studentDrives: boolean,
    private readonly examples: Example[],
    private readonly rng: Rng,
  ) {}

  /** The scripted maneuver drives the stops (not taught here); otherwise the student or its teacher. */
  get mode(): string { return this.team.mode; }

  decide(car: Car, world: World): void {
    const px = car.inputX, py = car.inputY;
    // The teacher decides every time (it keeps state: its offset, its pass, when it saw the flag), recorded or not.
    this.teacher.decide(car, world);
    const label = [car.inputX, car.inputY];
    car.inputX = px;
    car.inputY = py;
    // The team always runs (the crew chief calls the stops, the maneuver drives them); watching, the teacher drives.
    this.team.decide(car, world);
    if (!this.studentDrives && car.pit.phase === 'none') { car.inputX = label[0]; car.inputY = label[1]; }
    if (car.pit.phase !== 'none' || this.rng.next() >= SAMPLE) return;
    // What the student saw at this moment (its last command included).
    const ax = car.inputX, ay = car.inputY;
    car.inputX = px;
    car.inputY = py;
    this.team.spotter.call(car, world, this.team.radio);
    this.team.observePit(car, world);
    observeCaution(car, world, this.team.cautionInputs);
    const x = this.student.inputs(car, world, this.team.radio, this.team.pitInputs, this.team.cautionInputs).slice();
    car.inputX = ax;
    car.inputY = ay;
    const clamp = (v: number) => Math.max(-0.95, Math.min(0.95, v));
    this.examples.push({ x, y: Float32Array.of(clamp(label[0]), clamp(label[1])), mask: Float32Array.of(1, 1) });
  }
}

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
  /** Told after each round. */
  onRound?: (round: number, report: { track: string; losses: number[]; examples: number; out: number; soloCrashes: number; seconds: number }) => void;
}

/** One classroom race: the students seated round a field of individual traffic racers. Returns how many cars went out. */
export function classroomRace(
  track: Track, students: StableDriver[], studentDrives: boolean, examples: Example[][], rng: Rng, opts: Required<Omit<OvalApprenticeOptions, 'onRound'>>,
  round: number, seed: number,
): number {
  const world = new SimWorld(track, { collisions: true, drafting: true, wearScale: 4 });
  // Students spread through the field (a different spread each round), the rest individual racers.
  const slots = new Map<number, number>();
  const order = students.map((_, i) => i).sort(() => rng.next() - 0.5);
  order.forEach((s, i) => slots.set(Math.floor(((i + rng.next()) * opts.field) / students.length) % opts.field, s));
  for (let k = 0; k < opts.field; k++) {
    const car = new Car(k);
    placeOnGrid(car, track, k, true);
    const chief = new StrategistCrewChief(randomTraits(() => rng.next()));
    const s = slots.get(k);
    if (s === undefined) {
      const who = new Rng(hashSeed(seed, `racer${round}:${k}`));
      const { style, traits } = racerStyle(0.15 + 0.7 * who.next(), who.next(), () => who.next());
      world.addCar(car, new Team(new TrafficRacer(style, undefined, traits), new TowerSpotter(), chief, false, true));
      continue;
    }
    const d = students[s];
    const limits: DriverLimits = { ...d.limits, seed: hashSeed(seed, `hands${round}:${d.lineage}`) };
    const student = new NeuralDriver(d.weights, undefined, limits);
    const team = new Team(student, new TowerSpotter(), chief, false, true);
    world.addCar(car, new OvalApprentice(team, student, labellingTeacher(d), studentDrives, examples[s], rng));
  }
  const race = new Race(world, opts.laps, new PaceCarDriver());
  const debrisPerSecond = opts.debris / 30; // a lap's roughly half a minute
  while (race.state !== 'finished' && world.time < opts.laps * 300) {
    race.step();
    const ctl = race.control!;
    if (ctl.flag === 'green' && race.started && rng.next() < debrisPerSecond * P.DT) ctl.debrisCaution();
  }
  return world.cars.filter((c) => c.retired && !race.isFinished(c)).length;
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
function soloDrives(track: Track, students: StableDriver[], studentDrives: boolean, examples: Example[][], rng: Rng, round: number, seed: number): number {
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
      const student = new NeuralDriver(d.weights, undefined, limits);
      world.addCar(car, new OvalApprentice(new Team(student, new TowerSpotter(), null), student, labellingTeacher(d), studentDrives, examples[s], rng));
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
    rounds: 10, field: 40, laps: 30, debris: 0.05, epochs: 4, maxExamples: 60_000, ...options,
  };
  const rng = new Rng(hashSeed(seed, 'apprentice'));
  const examples: Example[][] = students.map(() => []);
  const alone: Example[][] = students.map(() => []);
  for (let round = 0; round < opts.rounds; round++) {
    const t0 = Date.now();
    const track = apprenticeTrack(round, seed);
    const soloCrashes = soloDrives(track, students, round > 0, alone, rng, round, seed);
    const out = classroomRace(track, students, round > 0, examples, rng, opts, round, seed);
    const half = Math.floor(opts.maxExamples / 2);
    const losses = students.map((d, s) => {
      const pick = (all: Example[]) => (all.length <= half ? all : sampleOf(all, half, rng));
      const set = [...pick(alone[s]), ...pick(examples[s])];
      return trainSupervised(DRIVER_LAYERS, d.weights, set, round === 0 ? 3 * opts.epochs : opts.epochs, 0.01, () => rng.next());
    });
    opts.onRound?.(round, {
      track: `${track.length.toFixed(0)} m`, losses, examples: examples.reduce((a, e) => a + e.length, 0) + alone.reduce((a, e) => a + e.length, 0),
      out, soloCrashes, seconds: (Date.now() - t0) / 1000,
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
