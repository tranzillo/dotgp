import { COSTS } from './costs';
import type { Track } from '../sim/track';
import { adaptWeights, DRIVER_LAYERS } from './drivers';
import { runHeats, runTrial, type TrialResult } from './evaluate';
import { genomeSize } from './network';
import { OBS_SIZE } from './observe';
import { Rng } from './rng';

/**
 * Evolution strategies (OpenAI-ES style). Each lineage is ONE driver whose
 * weights improve through practice: every round we try small antithetic
 * perturbations, rank their results, and step the driver's weights toward
 * the variations that went faster. The driver persists; only it changes.
 *
 * Rookie school: drivers without a license (they can't drive yet) practise
 * alone, as ghosts, with soft walls that harden over their own first lessons
 * and settings suited to learning from scratch. A rookie earns its license by
 * completing a clean lap on every track at full damage, and from then on
 * practises in traffic (if enabled). Rookies get first call on practice slots.
 */
export interface EsConfig {
  seed: number;
  lineages: number;
  /** Antithetic pairs per lineage per round (2x evaluations), licensed drivers. */
  pairs: number;
  sigma: number;
  /** Learning rate for licensed drivers. */
  learningRate: number;
  weightDecay: number;
  /** Trial length (s) for licensed drivers. */
  trialSeconds: number;
  /** A rookie's lessons over which wall damage ramps from soft to full. */
  curriculumRounds: number;
  /** Licensed drivers practise in race heats with contact (true) or as solo ghosts (false). */
  traffic: boolean;
  /** Drivers that practise each round (rotating through the field); the rest are opponents. */
  activePerRound: number;
  /** Cars per traffic heat: one candidate plus fixed opponents. */
  heatSize: number;
  /** Start traffic heats with random tire wear and fuel loads. */
  varyConditions: boolean;
  /** Rookie school settings. */
  rookiePairs: number;
  rookieSeconds: number;
  rookieLearningRate: number;
}

export const DEFAULT_ES: EsConfig = {
  seed: 1,
  lineages: 4,
  pairs: 16,
  sigma: 0.05,
  learningRate: 0.03,
  weightDecay: 0.005,
  trialSeconds: 80,
  curriculumRounds: 60,
  traffic: false,
  activePerRound: 4,
  heatSize: 6,
  varyConditions: true,
  rookiePairs: 16,
  rookieSeconds: 80,
  rookieLearningRate: 0.03,
};

export interface EsDriverState {
  lineage: number;
  weights: Float32Array;
  /** Adam moments. */
  m: Float32Array;
  v: Float32Array;
  /** Practice rounds this driver has completed (its experience). */
  rounds: number;
  /** Optimiser steps since its moments were last reset (for Adam bias correction). */
  adamSteps: number;
  /** Can drive: has completed a clean lap on every track at full damage. */
  licensed: boolean;
}

export interface EsLineageReport {
  lineage: number;
  fitness: number;
  results: TrialResult[];
  weights: Float32Array;
  licensed: boolean;
  /** This round was rookie school (solo, curriculum). */
  rookie: boolean;
  /** Earned the license this round. */
  graduated: boolean;
}

export interface EsRoundReport {
  round: number;
  /** Wall damage used for rookies this round (1 = full; also 1 if no rookies practised). */
  damageScale: number;
  lineages: EsLineageReport[];
  elapsedMs: number;
}

const MIN_DAMAGE_SCALE = 0.02;
const FORWARD_INSTINCT = 0.5;
const ADAM_B1 = 0.9;
const ADAM_B2 = 0.999;
/** License test: health kept on every track while lapping at full damage. */
const LICENSE_HEALTH = 0.9;
/**
 * Rookie school's damage cost, as a share of the full price (COSTS.damage). It
 * starts low, so driving and sometimes crashing always beats sitting still
 * (otherwise the safest thing for a driver that can't avoid walls yet), and
 * once the walls are fully hard it ramps up to the full price, teaching
 * drivers who can already lap to lap clean.
 */
const ROOKIE_DAMAGE_SHARE = 1 / 6;

export class EsTrainer {
  readonly config: EsConfig;
  readonly tracks: Track[];
  readonly drivers: EsDriverState[];
  round = 0;
  private readonly rng: Rng;
  private readonly size: number;

  constructor(tracks: Track[], config: Partial<EsConfig> = {}) {
    this.config = { ...DEFAULT_ES, ...config };
    this.tracks = tracks;
    this.rng = new Rng(this.config.seed);
    this.size = genomeSize(DRIVER_LAYERS);
    this.drivers = Array.from({ length: this.config.lineages }, (_, lineage) => ({
      lineage,
      weights: initialWeights(this.rng),
      m: new Float32Array(this.size),
      v: new Float32Array(this.size),
      rounds: 0,
      adamSteps: 0,
      licensed: false,
    }));
  }

  /**
   * Resume from saved drivers. Each may say whether it holds a license;
   * otherwise `licensed` applies (true: experienced drivers skip rookie school).
   */
  loadDrivers(saved: Array<{ weights: Float32Array; rounds: number; licensed?: boolean }>, licensed = true): void {
    saved.slice(0, this.drivers.length).forEach((s, l) => {
      const d = this.drivers[l];
      d.weights.set(adaptWeights(s.weights));
      d.m.fill(0);
      d.v.fill(0);
      d.adamSteps = 0;
      d.rounds = s.rounds;
      d.licensed = s.licensed ?? licensed;
    });
  }

  rookieDamageSeconds(lessons: number): number {
    return rookieDamageSeconds(lessons, this.config.curriculumRounds);
  }

  rookieDamageScale(lessons: number): number {
    return rookieDamageScale(lessons, this.config.curriculumRounds);
  }

  step(): EsRoundReport {
    const t0 = performance.now();
    const active = this.activeDrivers();
    const rookies = active.filter((d) => !d.licensed);
    const pros = active.filter((d) => d.licensed);
    const lessons = rookies.length ? rookies.reduce((a, d) => a + d.rounds, 0) / rookies.length : 0;
    const rookieScale = rookies.length ? this.rookieDamageScale(lessons) : 1;
    const reports = [
      ...this.trainGroup(rookies, true, rookieScale, this.rookieDamageSeconds(lessons)),
      ...this.trainGroup(pros, false, 1),
    ];
    this.round++;
    return { round: this.round - 1, damageScale: rookieScale, lineages: reports, elapsedMs: performance.now() - t0 };
  }

  /** One ES step for a group: rookies practise solo with their curriculum; licensed drivers as configured. */
  private trainGroup(group: EsDriverState[], rookie: boolean, damageScale: number, damageSeconds?: number): EsLineageReport[] {
    if (!group.length) return [];
    const cfg = this.config;
    const pairs = rookie ? cfg.rookiePairs : cfg.pairs;
    const seconds = rookie ? cfg.rookieSeconds : cfg.trialSeconds;
    const lr = rookie ? cfg.rookieLearningRate : cfg.learningRate;
    const sigma = cfg.sigma;

    // Candidate list per driver: [current, +e1, -e1, +e2, -e2, ...]
    const noise: Float32Array[][] = [];
    const candidates: Float32Array[] = [];
    for (const driver of group) {
      const eps: Float32Array[] = [];
      candidates.push(driver.weights);
      for (let p = 0; p < pairs; p++) {
        const e = new Float32Array(this.size);
        for (let i = 0; i < this.size; i++) e[i] = this.rng.gaussian();
        eps.push(e);
        const plus = new Float32Array(this.size);
        const minus = new Float32Array(this.size);
        for (let i = 0; i < this.size; i++) {
          plus[i] = driver.weights[i] + sigma * e[i];
          minus[i] = driver.weights[i] - sigma * e[i];
        }
        candidates.push(plus, minus);
      }
      noise.push(eps);
    }

    const per = 1 + 2 * pairs;
    const traffic = !rookie && cfg.traffic;
    const perTrack = this.tracks.map((track) => traffic
      ? this.evaluateInTraffic(track, group, candidates, per, damageScale, seconds)
      : runTrial(track, candidates, { seconds, damageScale, damageSeconds }));
    const fitnessOf = (c: number) => perTrack.reduce((sum, r) => sum + r[c].fitness, 0);

    return group.map((driver, l) => {
      const base = l * per;
      const results = perTrack.map((r) => r[base]);
      // License test: the current driver laps every track cleanly at full damage.
      const graduated = rookie && damageScale >= 1
        && results.every((r) => r.laps >= 1 && r.health >= LICENSE_HEALTH);
      const report: EsLineageReport = {
        lineage: driver.lineage,
        fitness: fitnessOf(base),
        results,
        weights: driver.weights.slice(),
        licensed: driver.licensed || graduated,
        rookie,
        graduated,
      };
      const fits = Array.from({ length: 2 * pairs }, (_, k) => fitnessOf(base + 1 + k));
      const ranks = centeredRanks(fits);
      const grad = new Float32Array(this.size);
      for (let p = 0; p < pairs; p++) {
        const w = ranks[2 * p] - ranks[2 * p + 1];
        const e = noise[l][p];
        for (let i = 0; i < this.size; i++) grad[i] += w * e[i];
      }
      driver.rounds++;
      adamStep(driver, grad, 1 / (2 * pairs * sigma), lr, cfg.weightDecay);
      if (graduated) {
        driver.licensed = true;
        // Fresh optimiser state for the gentler licensed phase.
        driver.m.fill(0);
        driver.v.fill(0);
        driver.adamSteps = 0;
      }
      return report;
    });
  }

  /** This round's practising drivers: rookies first, otherwise a window rotating through the field. */
  private activeDrivers(): EsDriverState[] {
    const rookies = this.drivers.filter((d) => !d.licensed);
    const pool = rookies.length ? rookies : this.drivers;
    const k = Math.min(pool.length, this.config.activePerRound);
    const start = (this.round * k) % pool.length;
    return Array.from({ length: k }, (_, i) => pool[(start + i) % pool.length]);
  }

  /**
   * Race heats with clean comparisons: every candidate of a practising driver
   * races in its own heat against HEAT_SIZE - 1 opponents (current drivers,
   * not perturbed). Antithetic twins (+e/-e) get identical opponents and grid
   * slot, so the only difference between them is the driver's own change.
   * Returns results in the candidate layout.
   */
  private evaluateInTraffic(
    track: Track, active: EsDriverState[], candidates: Float32Array[], per: number, damageScale: number, seconds: number,
  ): TrialResult[] {
    const size = this.config.heatSize;
    const heats: Float32Array[][] = [];
    const slots: number[] = [];
    const seeds: number[] = [];
    active.forEach((driver, l) => {
      let opponents: Float32Array[] = [];
      for (let c = 0; c < per; c++) {
        const pair = c === 0 ? 0 : Math.floor((c - 1) / 2) + 1;
        if (c === 0 || c % 2 === 1) opponents = this.pickOpponents(driver, size - 1);
        const slot = pair % size;
        const field = opponents.slice();
        field.splice(slot, 0, candidates[l * per + c]);
        heats.push(field);
        slots.push(slot);
        seeds.push((this.round * 7919 + l * 131 + pair * 17 + this.config.seed) >>> 0);
      }
    });
    const results = runHeats(track, heats, {
      seconds,
      damageScale,
      conditionSeeds: this.config.varyConditions ? seeds : undefined,
    });
    return results.map((heat, h) => heat[slots[h]]);
  }

  /** Opponents for a driver's heats: licensed drivers from the rest of the field (with repeats if few). */
  private pickOpponents(driver: EsDriverState, count: number): Float32Array[] {
    const licensed = this.drivers.filter((d) => d !== driver && d.licensed);
    const pool = licensed.length ? licensed : this.drivers.filter((d) => d !== driver);
    if (!pool.length) pool.push(driver);
    const out: Float32Array[] = [];
    const bag = pool.slice();
    for (let k = 0; k < count; k++) {
      if (!bag.length) bag.push(...pool);
      out.push(bag.splice(this.rng.int(bag.length), 1)[0].weights);
    }
    return out;
  }
}

/** Rookie damage cost (seconds per unit of health): gentle while walls are soft, ramping to full over the next curriculum span. */
export function rookieDamageSeconds(lessons: number, curriculumRounds: number): number {
  const n = curriculumRounds;
  const t = n > 0 ? Math.min(1, Math.max(0, (lessons - n) / n)) : 1;
  return COSTS.damage * (ROOKIE_DAMAGE_SHARE + (1 - ROOKIE_DAMAGE_SHARE) * t);
}

/** Soft walls for a rookie, hardening over its own first lessons. */
export function rookieDamageScale(lessons: number, curriculumRounds: number): number {
  const n = curriculumRounds;
  return n > 0 ? Math.min(1, MIN_DAMAGE_SCALE + (1 - MIN_DAMAGE_SCALE) * (lessons / n)) : 1;
}

/** The license test: health a rookie must keep while lapping at full damage. */
export { LICENSE_HEALTH, ROOKIE_DAMAGE_SHARE };

/** Weights plus Adam state: anything ES can improve. */
export interface AdamState {
  weights: Float32Array;
  m: Float32Array;
  v: Float32Array;
  /** Optimiser steps since the moments were last reset (for bias correction). */
  adamSteps: number;
}

/** One Adam ascent step on an ES gradient estimate (grad * scale). */
export function adamStep(
  st: AdamState, grad: Float32Array, scale: number, learningRate: number, weightDecay: number,
  /** Only these weights (1) change, weight decay included. Default: all. */
  trainable?: Float32Array,
): void {
  const t = ++st.adamSteps;
  const c1 = 1 - Math.pow(ADAM_B1, t);
  const c2 = 1 - Math.pow(ADAM_B2, t);
  const w = st.weights;
  for (let i = 0; i < w.length; i++) {
    if (trainable && !trainable[i]) continue;
    const g = grad[i] * scale - weightDecay * w[i];
    st.m[i] = ADAM_B1 * st.m[i] + (1 - ADAM_B1) * g;
    st.v[i] = ADAM_B2 * st.v[i] + (1 - ADAM_B2) * g * g;
    w[i] += (learningRate * (st.m[i] / c1)) / (Math.sqrt(st.v[i] / c2) + 1e-8);
  }
}

/** Rank-transform to [-0.5, 0.5]: robust to fitness scale and outliers. */
export function centeredRanks(x: number[]): number[] {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const out = new Array<number>(x.length);
  idx.forEach((i, r) => { out[i] = r / (x.length - 1) - 0.5; });
  return out;
}

/**
 * A brand-new driver. Random wiring, with two exceptions: one instinct (press
 * the gas) and no attention to the radio yet; it learns to listen once it
 * races in traffic.
 */
export function initialWeights(rng: Rng): Float32Array {
  const w = new Float32Array(genomeSize(DRIVER_LAYERS));
  let i = 0;
  for (let l = 1; l < DRIVER_LAYERS.length; l++) {
    const fanIn = DRIVER_LAYERS[l - 1];
    const scale = 1 / Math.sqrt(l === 1 ? OBS_SIZE : fanIn);
    for (let o = 0; o < DRIVER_LAYERS[l]; o++) {
      // Output 0 is the forward request.
      const isForwardOutput = l === DRIVER_LAYERS.length - 1 && o === 0;
      w[i++] = isForwardOutput ? FORWARD_INSTINCT : 0;
      for (let k = 0; k < fanIn; k++) w[i++] = l === 1 && k >= OBS_SIZE ? 0 : rng.gaussian() * scale;
    }
  }
  return w;
}
