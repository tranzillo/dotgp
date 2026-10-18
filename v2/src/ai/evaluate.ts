import { Car, SIGNATURE_BINS, type TrainingWheels } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import type { Track } from '../sim/track';
import { placeOnGrid, ROLLING_START_SPEED } from '../sim/grid';
import { bestValidLap, ValidProgress } from '../sim/limits';
import { COSTS, trackPace } from './costs';
import { World } from '../sim/world';
import { neuralTeam } from './drivers';
import { Rng } from './rng';

export interface TrialOptions {
  /** Simulated seconds per trial. */
  seconds: number;
  /** Where every car starts (all cars share the spot: they are ghosts). */
  startS?: number;
  /** Damage multiplier for curriculum training. */
  damageScale?: number;
  /** Seconds of race time each unit of health lost costs (default COSTS.damage; less only in curricula). */
  damageSeconds?: number;
  /** Training wheels for learners (curricula: forgiving ground, a speed limit). */
  wheels?: TrainingWheels;
  /** The track's own pace (m/s) progress converts at (default trackPace(track); pass it to save working it out). */
  pace?: number;
  /**
   * Per-heat seeds for starting conditions (tire wear, fuel load). Heats with
   * the same seed start every grid slot in the same state, so antithetic twins
   * stay comparable. Omit for fresh tires and a full tank.
   */
  conditionSeeds?: number[];
  /**
   * Score progress on valid laps only: a lap that goes past the track limits
   * is thrown away (from the line, or the trial's start, to the line), as its
   * lap time would be. Default: all progress counts.
   */
  validLaps?: boolean;
}

/** Worn-tire and fuel-load range drivers practise with, so stints don't surprise them. */
const TIRE_RANGE: [number, number] = [0.15, 1];
const FUEL_RANGE: [number, number] = [8, P.FUEL_CAPACITY];

export interface TrialResult {
  /** Seconds of race time: progress at the track's pace, less what damage (and spoilt laps) cost. */
  fitness: number;
  distance: number;
  laps: number;
  /** Fastest valid lap (laps past the track limits don't count). */
  bestLap: number;
  wallHits: number;
  health: number;
  tireLife: number;
  retired: boolean;
  /** Normalised share of tire work by direction relative to travel. */
  signature: number[];
  /** Excursions past the track limits (ghost trials count them; races leave them to race control). */
  trackLimits: number;
}


const STALL_WINDOW = 8; // seconds
const STALL_DISTANCE = 10; // metres

/**
 * A ghost trial you can step: every genome as a ghost car on the same track
 * at once (ghost trials are independent, so one world amortises the loop for
 * the whole population). A car that stalls has its trial ended. Watchable
 * (driving school steps it in front of the viewer) or run to the end.
 */
export class Trial {
  readonly world: World;
  readonly track: Track;
  private readonly steps: number;
  private readonly checkEvery: number;
  private readonly lastDist: number[];
  /** Where each car started (its dist begins at its place on the lap): results count progress from there. */
  private readonly startDist: number[];
  private readonly damageSeconds: number;
  private readonly pace: number;
  private readonly validLaps: boolean;
  /** Per car: excursions past the limits, and progress on spoilt laps. */
  private readonly progress: ValidProgress[];
  private stepIndex = 0;
  private allStalled = false;

  constructor(track: Track, genomes: Float32Array[], opts: TrialOptions) {
    this.track = track;
    this.world = new World(track, { collisions: false, drafting: false, damageScale: opts.damageScale ?? 1, wheels: opts.wheels ?? null });
    const startS = opts.startS ?? track.length - 20;
    for (let k = 0; k < genomes.length; k++) {
      const car = new Car(k);
      car.placeOnTrack(track, startS, 0);
      // Rolling start, as in races: pulling away from a standstill is the pit crew's job, not a racing skill.
      car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
      car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
      this.world.addCar(car, neuralTeam(genomes[k]));
    }
    this.steps = Math.round(opts.seconds / P.DT);
    this.checkEvery = Math.round(STALL_WINDOW / P.DT);
    this.lastDist = this.world.cars.map((c) => c.dist);
    this.startDist = this.world.cars.map((c) => c.dist);
    this.damageSeconds = opts.damageSeconds ?? COSTS.damage;
    this.pace = opts.pace ?? trackPace(track);
    this.validLaps = opts.validLaps ?? false;
    this.progress = this.world.cars.map((c) => new ValidProgress(c));
  }

  get done(): boolean {
    return this.allStalled || this.stepIndex >= this.steps;
  }

  /** Seconds of the trial left to run. */
  get remaining(): number {
    return Math.max(0, (this.steps - this.stepIndex) * P.DT);
  }

  step(): void {
    if (this.done) return;
    this.world.step();
    this.stepIndex++;
    this.countExcursions();
    if (this.stepIndex % this.checkEvery === 0) {
      let anyAlive = false;
      this.world.cars.forEach((c, k) => {
        if (!c.retired && c.dist - this.lastDist[k] < STALL_DISTANCE) {
          c.retired = true; // stalled or going nowhere: end its trial
        }
        this.lastDist[k] = c.dist;
        anyAlive ||= !c.retired;
      });
      if (!anyAlive) this.allStalled = true;
    }
  }

  private countExcursions(): void {
    for (const p of this.progress) p.step(this.track);
  }

  /** Physics steps run so far. */
  get stepsRun(): number {
    return this.stepIndex;
  }

  /**
   * Keep stepping a finished trial up to a step count. A round split across
   * threads (ghosts don't interact, so any split drives the same) ends where
   * its longest part did; parts that ended sooner carry on there, their
   * stalled cars still rolling as they would have in one world.
   */
  continueTo(steps: number): void {
    while (this.stepIndex < steps) {
      this.world.step();
      this.stepIndex++;
      this.countExcursions();
    }
  }

  results(): TrialResult[] {
    return this.world.cars.map((car, k) => {
      const r = scoreCar(car, this.track, this.startDist[k], this.damageSeconds, this.pace);
      r.trackLimits = this.progress[k].excursions;
      if (this.validLaps) r.fitness -= this.progress[k].thrownAway / this.pace;
      return r;
    });
  }
}

/** Run every genome as a ghost car on the same track at once, to the end. */
export function runTrial(track: Track, genomes: Float32Array[], opts: TrialOptions): TrialResult[] {
  const trial = new Trial(track, genomes, opts);
  while (!trial.done) trial.step();
  return trial.results();
}

/**
 * Race heats: each heat is a full race with contact and drafting, from a
 * rolling start, with cars gridded in the given order. Returns results per
 * heat, per car, in grid order.
 */
export function runHeats(track: Track, heats: Float32Array[][], opts: TrialOptions): TrialResult[][] {
  return heats.map((genomes, h) => {
    const world = new World(track, { collisions: true, drafting: true, damageScale: opts.damageScale ?? 1 });
    const startDist: number[] = [];
    const seed = opts.conditionSeeds?.[h];
    const rng = seed === undefined ? null : new Rng(seed);
    genomes.forEach((g, k) => {
      const car = new Car(k);
      placeOnGrid(car, track, k, true);
      if (rng) {
        car.tireLife = TIRE_RANGE[0] + rng.next() * (TIRE_RANGE[1] - TIRE_RANGE[0]);
        car.fuel = FUEL_RANGE[0] + rng.next() * (FUEL_RANGE[1] - FUEL_RANGE[0]);
      }
      startDist.push(car.dist);
      world.addCar(car, neuralTeam(g));
    });
    simulate(world, opts.seconds);
    return world.cars.map((car, k) => scoreCar(car, track, startDist[k]));
  });
}

/** Step a world for the given time, ending trials of cars that stall. */
function simulate(world: World, seconds: number): void {
  const steps = Math.round(seconds / P.DT);
  const checkEvery = Math.round(STALL_WINDOW / P.DT);
  const lastDist = world.cars.map((c) => c.dist);
  for (let step = 0; step < steps; step++) {
    world.step();
    if ((step + 1) % checkEvery === 0) {
      let anyAlive = false;
      world.cars.forEach((c, k) => {
        if (!c.retired && c.dist - lastDist[k] < STALL_DISTANCE) {
          c.retired = true; // stalled or going nowhere: end its trial
        }
        lastDist[k] = c.dist;
        anyAlive ||= !c.retired;
      });
      if (!anyAlive) break;
    }
  }
}

/** A car's trial in seconds of race time: progress at the track's own pace, less what its damage costs. */
export function scoreCar(car: Car, track: Track, startDist = 0, damageSeconds: number = COSTS.damage, pace = trackPace(track)): TrialResult {
  const distance = car.dist - startDist;
  const fitness = distance / pace - (1 - car.health) * damageSeconds;
  const total = car.signature.reduce((a, b) => a + b, 0) || 1;
  return {
    fitness,
    distance,
    laps: car.lapsCompleted,
    bestLap: bestValidLap(car),
    wallHits: car.wallHits,
    health: car.health,
    tireLife: car.tireLife,
    retired: car.retired && car.health <= 0,
    signature: Array.from({ length: SIGNATURE_BINS }, (_, b) => car.signature[b] / total),
    trackLimits: 0,
  };
}

/** Collapse a signature into the broad technique buckets used in readouts. */
export function techniqueSummary(signature: number[]): { drive: number; corner: number; brake: number } {
  // Bins span -180..180 deg in 30 deg steps; bin 6 starts at 0 deg (straight ahead).
  let drive = 0, corner = 0, brake = 0;
  signature.forEach((v, b) => {
    const center = -180 + (b + 0.5) * (360 / SIGNATURE_BINS);
    const a = Math.abs(center);
    if (a < 45) drive += v;
    else if (a > 135) brake += v;
    else corner += v;
  });
  return { drive, corner, brake };
}
