import { Car } from '../sim/car';
import { ROLLING_START_SPEED } from '../sim/grid';
import type { Track } from '../sim/track';
import { World } from '../sim/world';
import { NeuralDriver, Team } from './drivers';
import { adamStep, centeredRanks, type AdamState } from './es';
import { genomeSize } from './network';
import { CHIEF_LAYERS, initialChiefWeights, NeuralCrewChief } from './neuralChief';
import type { CrewChief } from './pitting';
import { Rng } from './rng';
import { TowerSpotter } from './spotter';

/**
 * Crew chiefs learn strategy in full "strategy races": ghost races (no
 * contact) where every car runs a trained driver and a different variation
 * of a crew chief, over a random track, distance and race pace. Fitness is
 * total race time, so running dry, stopping too often or nursing worn tires
 * all show up directly. Each lineage is one persistent chief (ES).
 */
export interface ChiefTrainingConfig {
  seed: number;
  lineages: number;
  pairs: number;
  sigma: number;
  learningRate: number;
  weightDecay: number;
  laps: [number, number];
  pace: [number, number];
  /** Share of cars that start a race carrying damage, so repairs are worth learning. */
  damagedShare: number;
  /** Chiefs that practise each round (rotating through the field). */
  activePerRound: number;
}

export const DEFAULT_CHIEF_TRAINING: ChiefTrainingConfig = {
  seed: 1,
  lineages: 4,
  pairs: 8,
  sigma: 0.1,
  learningRate: 0.03,
  weightDecay: 0.002,
  laps: [15, 45],
  pace: [3, 8],
  damagedShare: 0.25,
  activePerRound: 4,
};

export interface ChiefState extends AdamState {
  lineage: number;
  rounds: number;
}

export interface StrategyRaceConditions {
  track: Track;
  laps: number;
  pace: number;
}

export interface ChiefRoundReport {
  round: number;
  conditions: { trackLength: number; laps: number; pace: number };
  /** Each lineage's current chief: race time relative to the field's best, and stops made. */
  lineages: Array<{ lineage: number; relativeTime: number; stops: number; finished: boolean }>;
  elapsedMs: number;
}

export class ChiefTrainer {
  readonly config: ChiefTrainingConfig;
  readonly chiefs: ChiefState[];
  round = 0;
  private readonly rng: Rng;
  private readonly size = genomeSize(CHIEF_LAYERS);

  constructor(
    readonly tracks: Track[],
    readonly drivers: Float32Array[],
    config: Partial<ChiefTrainingConfig> = {},
  ) {
    this.config = { ...DEFAULT_CHIEF_TRAINING, ...config };
    this.rng = new Rng(this.config.seed);
    this.chiefs = Array.from({ length: this.config.lineages }, (_, lineage) => ({
      lineage,
      weights: initialChiefWeights(this.rng),
      m: new Float32Array(this.size),
      v: new Float32Array(this.size),
      adamSteps: 0,
      rounds: 0,
    }));
  }

  loadChiefs(saved: Array<{ weights: Float32Array; rounds: number }>): void {
    saved.slice(0, this.chiefs.length).forEach((s, l) => {
      const c = this.chiefs[l];
      c.weights.set(s.weights);
      c.m.fill(0);
      c.v.fill(0);
      c.adamSteps = 0;
      c.rounds = s.rounds;
    });
  }

  step(): ChiefRoundReport {
    const t0 = performance.now();
    const { pairs, sigma, laps, pace } = this.config;
    const rng = this.rng;
    const conditions: StrategyRaceConditions = {
      track: this.tracks[rng.int(this.tracks.length)],
      laps: laps[0] + rng.int(laps[1] - laps[0] + 1),
      pace: pace[0] + rng.next() * (pace[1] - pace[0]),
    };

    // Candidates: per lineage [current, +e1, -e1, ...]. Twins share driver and damage.
    const per = 1 + 2 * pairs;
    const noise: Float32Array[][] = [];
    const entries: Array<{ chief: Float32Array; driver: number; damage: number }> = [];
    const pairDriver = Array.from({ length: pairs + 1 }, () => rng.int(this.drivers.length));
    const pairDamage = Array.from({ length: pairs + 1 }, () =>
      (rng.next() < this.config.damagedShare ? 0.2 + rng.next() * 0.4 : 0));
    const n = this.chiefs.length;
    const a = Math.min(n, this.config.activePerRound);
    const start = (this.round * a) % n;
    const active = Array.from({ length: a }, (_, k) => this.chiefs[(start + k) % n]);
    for (const chief of active) {
      const eps: Float32Array[] = [];
      entries.push({ chief: chief.weights, driver: pairDriver[0], damage: pairDamage[0] });
      for (let p = 0; p < pairs; p++) {
        const e = new Float32Array(this.size);
        for (let i = 0; i < this.size; i++) e[i] = rng.gaussian();
        eps.push(e);
        const plus = chief.weights.slice(), minus = chief.weights.slice();
        for (let i = 0; i < this.size; i++) { plus[i] += sigma * e[i]; minus[i] -= sigma * e[i]; }
        entries.push({ chief: plus, driver: pairDriver[p + 1], damage: pairDamage[p + 1] });
        entries.push({ chief: minus, driver: pairDriver[p + 1], damage: pairDamage[p + 1] });
      }
      noise.push(eps);
    }

    const results = runStrategyRace(conditions, entries.map((e) => ({
      driver: this.drivers[e.driver],
      chief: new NeuralCrewChief(e.chief),
      damage: e.damage,
    })));
    const best = Math.min(...results.filter((r) => r.finished).map((r) => r.time), Infinity);
    const fitness = results.map((r) => -r.time / (Number.isFinite(best) ? best : 1));

    const lineages = active.map((chief, l) => {
      const base = l * per;
      const ranks = centeredRanks(Array.from({ length: 2 * pairs }, (_, k) => fitness[base + 1 + k]));
      const grad = new Float32Array(this.size);
      for (let p = 0; p < pairs; p++) {
        const w = ranks[2 * p] - ranks[2 * p + 1];
        const e = noise[l][p];
        for (let i = 0; i < this.size; i++) grad[i] += w * e[i];
      }
      chief.rounds++;
      adamStep(chief, grad, 1 / (2 * pairs * sigma), this.config.learningRate, this.config.weightDecay);
      const r = results[base];
      return { lineage: chief.lineage, relativeTime: r.time / best, stops: r.stops, finished: r.finished };
    });

    this.round++;
    return {
      round: this.round - 1,
      conditions: { trackLength: conditions.track.length, laps: conditions.laps, pace: conditions.pace },
      lineages,
      elapsedMs: performance.now() - t0,
    };
  }
}

export interface StrategyEntry {
  driver: Float32Array;
  chief: CrewChief;
  /** Starting damage (0 = healthy), split between aero and handling. */
  damage: number;
}

export interface StrategyResult {
  time: number;
  stops: number;
  finished: boolean;
}

/**
 * One ghost race over the full distance. A car that can't finish (ran dry,
 * stalled) is charged the time limit plus a heavy per-lap penalty.
 */
export function runStrategyRace(cond: StrategyRaceConditions, entries: StrategyEntry[]): StrategyResult[] {
  const { track, laps, pace } = cond;
  const world = new World(track, { collisions: false, drafting: false, wearScale: pace });
  world.raceLaps = laps;
  const cars = entries.map((e, k) => {
    const car = new Car(k);
    car.placeOnTrack(track, track.length - 20, 0);
    car.vx = track.tx[car.trackIdx] * ROLLING_START_SPEED;
    car.vy = track.ty[car.trackIdx] * ROLLING_START_SPEED;
    if (e.damage > 0) {
      car.damageAero = e.damage * 0.6;
      car.damageHandling = e.damage * 0.6;
      car.health = 1 - e.damage;
    }
    world.addCar(car, new Team(new NeuralDriver(e.driver), new TowerSpotter(), e.chief));
    return car;
  });

  // Generous limit: a slow lap is ~1.5 min even on the biggest track.
  const limit = laps * 90 + 120;
  const done = () => cars.every((c) => c.retired || c.lapTimes.length >= laps);
  const crawlingSince = cars.map(() => 0);
  while (world.time < limit && !done()) {
    world.step();
    if (world.tick % 120 !== 0) continue;
    // A car crawling outside the pits (out of fuel) is out: stop simulating it.
    cars.forEach((c, k) => {
      if (c.retired || c.pit.phase !== 'none' || c.speed > 5) { crawlingSince[k] = world.time; return; }
      if (world.time - crawlingSince[k] > 15) c.retired = true;
    });
  }

  return cars.map((car) => {
    const finished = car.lapTimes.length >= laps;
    const time = finished
      ? car.lapTimes.slice(0, laps).reduce((a, b) => a + b, 0)
      : limit + (laps - car.lapTimes.length) * 60;
    return { time, stops: car.pit.stops, finished };
  });
}
