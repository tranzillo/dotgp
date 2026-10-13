import type { Track } from '../sim/track';
import { DRIVER_LAYERS } from './drivers';
import { runTrial, type TrialResult } from './evaluate';
import { genomeSize } from './network';
import { Rng } from './rng';

const SIGMA_GROWTH = 1.1;
const SIGMA_MAX = 1.2;
const MIN_DAMAGE_SCALE = 0.02;

export interface Genome {
  id: number;
  weights: Float32Array;
  lineage: number;
  generation: number;
  parentId: number | null;
}

export interface EvolutionConfig {
  seed: number;
  /** Independent lineages. No genes cross between them (one per future team). */
  islands: number;
  populationPerIsland: number;
  elites: number;
  tournament: number;
  crossoverRate: number;
  mutationRate: number;
  mutationSigma: number;
  trialSeconds: number;
  /** Generations over which wall damage ramps from soft to full. 0 = full damage from the start. */
  curriculumGenerations: number;
}

export const DEFAULT_EVOLUTION: EvolutionConfig = {
  seed: 1,
  islands: 4,
  populationPerIsland: 32,
  elites: 3,
  tournament: 3,
  crossoverRate: 0.25,
  mutationRate: 0.1,
  mutationSigma: 0.3,
  trialSeconds: 80,
  curriculumGenerations: 60,
};

export interface Scored {
  genome: Genome;
  /** Sum of per-track fitness. */
  fitness: number;
  /** One result per training track, in the order of Evolution.tracks. */
  results: TrialResult[];
}

export interface IslandReport {
  lineage: number;
  best: Scored;
  meanFitness: number;
}

export interface GenerationReport {
  generation: number;
  damageScale: number;
  islands: IslandReport[];
  elapsedMs: number;
}

export class Evolution {
  readonly config: EvolutionConfig;
  readonly tracks: Track[];
  generation = 0;
  islands: Genome[][];
  /** Per-island mutation strength; grows while a lineage stagnates. */
  private readonly sigma: number[];
  private readonly bestEver: number[];
  private readonly rng: Rng;
  private nextId = 0;

  constructor(tracks: Track[], config: Partial<EvolutionConfig> = {}) {
    this.config = { ...DEFAULT_EVOLUTION, ...config };
    this.tracks = tracks;
    this.rng = new Rng(this.config.seed);
    this.sigma = Array(this.config.islands).fill(this.config.mutationSigma);
    this.bestEver = Array(this.config.islands).fill(-Infinity);
    const size = genomeSize(DRIVER_LAYERS);
    this.islands = Array.from({ length: this.config.islands }, (_, lineage) =>
      Array.from({ length: this.config.populationPerIsland }, () =>
        this.makeGenome(randomWeights(size, this.rng), lineage, null),
      ),
    );
  }

  get damageScale(): number {
    const n = this.config.curriculumGenerations;
    return n > 0 ? Math.min(1, MIN_DAMAGE_SCALE + (1 - MIN_DAMAGE_SCALE) * (this.generation / n)) : 1;
  }

  /** Evaluate the current generation, then breed the next one. */
  step(): GenerationReport {
    const t0 = performance.now();
    const all = this.islands.flat();
    const weights = all.map((g) => g.weights);
    const damageScale = this.damageScale;
    const perTrack = this.tracks.map((track) =>
      runTrial(track, weights, { seconds: this.config.trialSeconds, damageScale }));

    const reports: IslandReport[] = [];
    let offset = 0;
    this.islands = this.islands.map((pop, lineage) => {
      const scored: Scored[] = pop.map((genome, k) => {
        const results = perTrack.map((r) => r[offset + k]);
        return { genome, results, fitness: results.reduce((sum, r) => sum + r.fitness, 0) };
      });
      offset += pop.length;
      scored.sort((a, b) => b.fitness - a.fitness);
      // Fitness is not comparable across curriculum stages, so stagnation is only tracked at full damage.
      if (damageScale < 1 || scored[0].fitness > this.bestEver[lineage] + 1e-3) {
        this.bestEver[lineage] = scored[0].fitness;
        this.sigma[lineage] = this.config.mutationSigma;
      } else {
        this.sigma[lineage] = Math.min(SIGMA_MAX, this.sigma[lineage] * SIGMA_GROWTH);
      }
      reports.push({
        lineage,
        best: scored[0],
        meanFitness: scored.reduce((sum, s) => sum + s.fitness, 0) / scored.length,
      });
      return this.breed(scored, lineage);
    });

    const report = { generation: this.generation, damageScale, islands: reports, elapsedMs: performance.now() - t0 };
    this.generation++;
    return report;
  }

  private breed(scored: Scored[], lineage: number): Genome[] {
    const { elites, populationPerIsland, crossoverRate } = this.config;
    const next: Genome[] = scored.slice(0, elites).map((s) => s.genome);
    while (next.length < populationPerIsland) {
      const a = this.select(scored);
      let weights: Float32Array = a.weights.slice();
      if (this.rng.next() < crossoverRate) {
        const b = this.select(scored);
        for (let i = 0; i < weights.length; i++) if (this.rng.next() < 0.5) weights[i] = b.weights[i];
      }
      weights = this.mutate(weights, this.sigma[lineage]);
      next.push(this.makeGenome(weights, lineage, a.id));
    }
    return next;
  }

  private select(scored: Scored[]): Genome {
    let best = scored[this.rng.int(scored.length)];
    for (let k = 1; k < this.config.tournament; k++) {
      const c = scored[this.rng.int(scored.length)];
      if (c.fitness > best.fitness) best = c;
    }
    return best.genome;
  }

  private mutate(w: Float32Array, sigma: number): Float32Array {
    const { mutationRate } = this.config;
    for (let i = 0; i < w.length; i++) {
      if (this.rng.next() < mutationRate) w[i] += this.rng.gaussian() * sigma;
    }
    return w;
  }

  private makeGenome(weights: Float32Array, lineage: number, parentId: number | null): Genome {
    return { id: this.nextId++, weights, lineage, generation: this.generation, parentId };
  }
}

function randomWeights(size: number, rng: Rng): Float32Array {
  const w = new Float32Array(size);
  let i = 0;
  for (let l = 1; l < DRIVER_LAYERS.length; l++) {
    const fanIn = DRIVER_LAYERS[l - 1];
    const scale = 1 / Math.sqrt(fanIn);
    for (let o = 0; o < DRIVER_LAYERS[l]; o++) {
      w[i++] = 0; // bias
      for (let k = 0; k < fanIn; k++) w[i++] = rng.gaussian() * scale;
    }
  }
  return w;
}
