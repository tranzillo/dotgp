import { Car, SIGNATURE_BINS } from '../sim/car';
import { PHYSICS as P } from '../sim/constants';
import type { Track } from '../sim/track';
import { placeOnGrid, ROLLING_START_SPEED } from '../sim/grid';
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
  /** Laps of progress a fully wrecked car gives up (default DAMAGE_PENALTY_LAPS). */
  damagePenaltyLaps?: number;
  /**
   * Per-heat seeds for starting conditions (tire wear, fuel load). Heats with
   * the same seed start every grid slot in the same state, so antithetic twins
   * stay comparable. Omit for fresh tires and a full tank.
   */
  conditionSeeds?: number[];
}

/** Worn-tire and fuel-load range drivers practise with, so stints don't surprise them. */
const TIRE_RANGE: [number, number] = [0.15, 1];
const FUEL_RANGE: [number, number] = [8, P.FUEL_CAPACITY];

export interface TrialResult {
  fitness: number;
  distance: number;
  laps: number;
  bestLap: number;
  wallHits: number;
  health: number;
  tireLife: number;
  retired: boolean;
  /** Normalised share of tire work by direction relative to travel. */
  signature: number[];
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
  private readonly damagePenaltyLaps: number | undefined;
  private stepIndex = 0;
  private allStalled = false;

  constructor(track: Track, genomes: Float32Array[], opts: TrialOptions) {
    this.track = track;
    this.world = new World(track, { collisions: false, drafting: false, damageScale: opts.damageScale ?? 1 });
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
    this.damagePenaltyLaps = opts.damagePenaltyLaps;
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

  results(): TrialResult[] {
    return this.world.cars.map((car) => scoreCar(car, this.track, 0, this.damagePenaltyLaps));
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

/** Laps of progress a fully wrecked car gives up. Stands in for the long-race cost of damage. */
const DAMAGE_PENALTY_LAPS = 3;

export function scoreCar(car: Car, track: Track, startDist = 0, damagePenaltyLaps = DAMAGE_PENALTY_LAPS): TrialResult {
  const distance = car.dist - startDist;
  // Progress in laps, so tracks of different length weigh the same.
  const fitness = distance / track.length - (1 - car.health) * damagePenaltyLaps;
  const total = car.signature.reduce((a, b) => a + b, 0) || 1;
  return {
    fitness,
    distance,
    laps: car.lapsCompleted,
    bestLap: car.lapTimes.length ? Math.min(...car.lapTimes) : Infinity,
    wallHits: car.wallHits,
    health: car.health,
    tireLife: car.tireLife,
    retired: car.retired && car.health <= 0,
    signature: Array.from({ length: SIGNATURE_BINS }, (_, b) => car.signature[b] / total),
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
