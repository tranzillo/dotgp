import type { EntrantResult, EntrantSpec, SessionSpec } from '../events/session';
import type { TrackLayout } from '../sim/layout';
import { adamStep, centeredRanks } from './es';
import { genomeSize } from './network';
import { adaptChiefWeights, CHIEF_LAYERS } from './neuralChief';
import type { CrewChiefTraits } from './pitting';
import { Rng } from './rng';
import { PERFECT_SPOTTER, type SpotterSkill } from './spotter';

/**
 * Crew chiefs learn race strategy in real races: contact, race control,
 * cautions (and on circuits the safety car), scored by where the car
 * finishes. That's where strategy lives: a stop under caution costs places,
 * not a lap; fresh tires against worn ones are an undercut.
 *
 * Races are noisy (a wreck reshuffles everything), so variations are only
 * ever compared inside one race. Each lineage is one persistent chief (ES,
 * as everywhere else); each of its antithetic pairs (+e, -e) races in the
 * same race, with the same driver, so both see the same cautions, and a
 * mirrored race swaps their grid slots. A pair is scored by the places
 * between its two cars; a race where either was wrecked out doesn't count
 * for it (the chief couldn't help that). The rest of the field are
 * opponents: the lineages' current chiefs and scripted veterans of every
 * temperament, so no single habit is the only thing to beat.
 *
 * The same pairing benchmarks two sets of chiefs (A against B, same driver,
 * same race, mirrored grid): see pairedRaces.
 */

export type ChiefBrainSpec = EntrantSpec['chief']['brain'];

export interface StrategyDriver {
  weights: Float32Array;
  roadWeights?: Float32Array;
  nerve?: number;
}

/** Two chiefs compared head to head: same driver, same race (and its mirror). */
export interface ChiefPair {
  x: ChiefBrainSpec;
  y: ChiefBrainSpec;
  driver: number;
}

export interface RaceConditions {
  layout: TrackLayout;
  laps: number;
  pace: number;
  seed: number;
}

/** A pair's two cars in one race: entrant keys, and which race of the mirrored couple. */
interface PairSlot {
  pair: number;
  race: number;
  keyX: number;
  keyY: number;
}

export interface PairedRacePlan {
  races: SessionSpec[];
  slots: PairSlot[];
}

/**
 * Races for comparing pairs of chiefs: as many pairs per race as the field
 * allows (a third of it kept for opponents), each race run twice with the
 * pairs' grid slots swapped. Opponents and the rest of the grid are drawn
 * from the seed; the mirror only swaps the pairs.
 */
export function pairedRaces(
  pairs: ChiefPair[], opponents: ChiefBrainSpec[], drivers: StrategyDriver[], field: number, cond: RaceConditions,
  spotter: SpotterSkill = PERFECT_SPOTTER,
): PairedRacePlan {
  const rng = new Rng(cond.seed);
  const perRace = Math.max(1, Math.floor((field - Math.ceil(field / 3)) / 2));
  const races: SessionSpec[] = [];
  const slots: PairSlot[] = [];
  const entrant = (key: number, brain: ChiefBrainSpec, d: StrategyDriver): EntrantSpec => ({
    key, fill: '#ffffff', number: key,
    driver: { id: `D${key}`, weights: d.weights, roadWeights: d.roadWeights, nerve: d.nerve },
    spotter: { id: `S${key}`, skill: spotter },
    chief: { id: `C${key}`, brain },
  });
  for (let first = 0; first < pairs.length; first += perRace) {
    const group = pairs.slice(first, first + perRace);
    const entrants: EntrantSpec[] = [];
    const twins: Array<[number, number]> = [];
    group.forEach((p, i) => {
      const keyX = 2 * i, keyY = 2 * i + 1;
      entrants.push(entrant(keyX, p.x, drivers[p.driver]), entrant(keyY, p.y, drivers[p.driver]));
      twins.push([keyX, keyY]);
    });
    for (let k = entrants.length; k < field; k++) {
      entrants.push(entrant(k, opponents[rng.int(opponents.length)], drivers[rng.int(drivers.length)]));
    }
    // A random grid; its mirror swaps each pair's slots and nothing else.
    const grid = entrants.map((e) => e.key);
    for (let i = grid.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [grid[i], grid[j]] = [grid[j], grid[i]];
    }
    const mirror = grid.map((key) => {
      const t = twins.find(([a, b]) => a === key || b === key);
      return t ? (t[0] === key ? t[1] : t[0]) : key;
    });
    const seed = (rng.next() * 2 ** 31) >>> 0;
    for (const order of [grid, mirror]) {
      races.push({ kind: 'race', layout: cond.layout, entrants, laps: cond.laps, pace: cond.pace, seed, grid: order, learn: false });
      group.forEach((_, i) => slots.push({ pair: first + i, race: races.length - 1, keyX: twins[i][0], keyY: twins[i][1] }));
    }
  }
  return { races, slots };
}

/** A pair's result: places Y finished behind X, summed over the races where both were still running at the end. */
export interface PairScore {
  /** Positive: X ahead. */
  places: number;
  /** Races that counted (both cars running at the flag). */
  races: number;
}

export function scorePairs(plan: PairedRacePlan, results: EntrantResult[][], pairs: number): PairScore[] {
  const out: PairScore[] = Array.from({ length: pairs }, () => ({ places: 0, races: 0 }));
  for (const s of plan.slots) {
    const res = results[s.race];
    const x = res.find((r) => r.key === s.keyX)!, y = res.find((r) => r.key === s.keyY)!;
    if (x.status === 'out' || y.status === 'out' || x.disqualified || y.disqualified) continue;
    out[s.pair].places += y.position - x.position;
    out[s.pair].races++;
  }
  return out;
}

export interface StrategyTrainingConfig {
  seed: number;
  /** Antithetic pairs per lineage each step. */
  pairs: number;
  sigma: number;
  learningRate: number;
  weightDecay: number;
  field: number;
  laps: [number, number];
  pace: [number, number];
}

export const DEFAULT_STRATEGY_TRAINING: StrategyTrainingConfig = {
  seed: 1,
  pairs: 6,
  sigma: 0.05,
  learningRate: 0.01,
  weightDecay: 0.001,
  field: 24,
  laps: [30, 60],
  pace: [4, 8],
};

export interface StrategyChief {
  weights: Float32Array;
  m: Float32Array;
  v: Float32Array;
  adamSteps: number;
  rounds: number;
}

export interface StrategyStepReport {
  round: number;
  track: string;
  laps: number;
  pace: number;
  races: number;
  /** Per lineage: pairs that counted, and how far apart the twins finished on average (places). */
  lineages: Array<{ pairs: number; spread: number }>;
}

/**
 * The trainer: plan() gives this step's races (run them anywhere, in any
 * order), learn() takes their results and moves every lineage.
 */
export class StrategyTrainer {
  readonly config: StrategyTrainingConfig;
  readonly chiefs: StrategyChief[];
  round = 0;
  private readonly rng: Rng;
  private readonly size = genomeSize(CHIEF_LAYERS);
  private pending: { plan: PairedRacePlan; noise: Float32Array[][]; cond: RaceConditions } | null = null;

  constructor(
    start: Float32Array[],
    readonly layouts: TrackLayout[],
    readonly drivers: StrategyDriver[],
    /** Scripted veterans in the field alongside the lineages' current chiefs. */
    readonly veterans: CrewChiefTraits[],
    config: Partial<StrategyTrainingConfig> = {},
  ) {
    this.config = { ...DEFAULT_STRATEGY_TRAINING, ...config };
    this.rng = new Rng(this.config.seed);
    this.chiefs = start.map((w) => ({
      weights: adaptChiefWeights(w).slice(), m: new Float32Array(this.size), v: new Float32Array(this.size), adamSteps: 0, rounds: 0,
    }));
  }

  plan(): SessionSpec[] {
    const { pairs, sigma, laps, pace, field } = this.config;
    const rng = this.rng;
    const cond: RaceConditions = {
      layout: this.layouts[rng.int(this.layouts.length)],
      laps: laps[0] + rng.int(laps[1] - laps[0] + 1),
      pace: pace[0] + rng.next() * (pace[1] - pace[0]),
      seed: (rng.next() * 2 ** 31) >>> 0,
    };
    const noise: Float32Array[][] = [];
    const all: ChiefPair[] = [];
    for (const chief of this.chiefs) {
      const eps: Float32Array[] = [];
      for (let p = 0; p < pairs; p++) {
        const e = new Float32Array(this.size);
        for (let i = 0; i < this.size; i++) e[i] = rng.gaussian();
        const plus = chief.weights.slice(), minus = chief.weights.slice();
        for (let i = 0; i < this.size; i++) { plus[i] += sigma * e[i]; minus[i] -= sigma * e[i]; }
        eps.push(e);
        all.push({ x: { kind: 'neural', weights: plus }, y: { kind: 'neural', weights: minus }, driver: rng.int(this.drivers.length) });
      }
      noise.push(eps);
    }
    const opponents: ChiefBrainSpec[] = [
      ...this.chiefs.map((c) => ({ kind: 'neural' as const, weights: c.weights.slice() })),
      ...this.veterans.map((traits) => ({ kind: 'scripted' as const, traits })),
    ];
    const plan = pairedRaces(all, opponents, this.drivers, field, cond);
    this.pending = { plan, noise, cond };
    return plan.races;
  }

  learn(results: EntrantResult[][]): StrategyStepReport {
    const { plan, noise, cond } = this.pending!;
    this.pending = null;
    const { pairs, sigma, learningRate, weightDecay } = this.config;
    const scores = scorePairs(plan, results, this.chiefs.length * pairs);
    const lineages = this.chiefs.map((chief, l) => {
      const mine = scores.slice(l * pairs, (l + 1) * pairs);
      const counted = mine.map((s, p) => ({ s, p })).filter(({ s }) => s.races > 0);
      const spread = counted.length ? counted.reduce((a, { s }) => a + Math.abs(s.places / s.races), 0) / counted.length : 0;
      chief.rounds++;
      if (counted.length >= 2) {
        // Ranks of the per-race place difference: one wild race can't swing the step.
        const ranks = centeredRanks(counted.map(({ s }) => s.places / s.races));
        const grad = new Float32Array(this.size);
        counted.forEach(({ p }, k) => {
          const e = noise[l][p];
          for (let i = 0; i < this.size; i++) grad[i] += ranks[k] * e[i];
        });
        adamStep(chief, grad, 1 / (counted.length * sigma), learningRate, weightDecay);
      }
      return { pairs: counted.length, spread };
    });
    return { round: this.round++, track: cond.layout.name, laps: cond.laps, pace: cond.pace, races: plan.races.length, lineages };
  }
}
