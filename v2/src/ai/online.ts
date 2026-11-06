import { adamStep, centeredRanks } from './es';
import type { Rng } from './rng';

/**
 * Learning while racing. Practice compares many varied copies of a driver
 * side by side; in a race there is only one car, so the comparison runs over
 * time instead: one lap with a small variation (+), the next with its
 * opposite (-), and the pair says which way is better. After a few pairs the
 * driver steps toward the winning directions (evolution strategies, online).
 * Which of the two runs first is a coin toss: consecutive laps differ anyway
 * (tires wear, fuel burns off), and always running + first would turn that
 * drift into a fake signal.
 *
 * Laps are only compared when they're like for like: the race calls
 * lapDone(null) for a lap spoiled by a caution, a pit stop or a wreck, and
 * the same variation runs again. Variations are small, so the racing isn't
 * visibly erratic; the learning is slow and steady.
 */
export interface OnlineConfig {
  /** Size of each variation (practice uses 0.05). */
  sigma: number;
  /** Lap pairs per step. */
  pairs: number;
  learningRate: number;
  weightDecay: number;
}

export const RACE_LEARNING: OnlineConfig = { sigma: 0.02, pairs: 3, learningRate: 0.004, weightDecay: 0.001 };

export class OnlineLearner {
  /** The driver's own weights (the variations are tried around them). */
  readonly weights: Float32Array;
  readonly m: Float32Array;
  readonly v: Float32Array;
  adamSteps = 0;
  /** Steps taken so far. */
  updates = 0;
  private eps: Float32Array;
  /** The variation running now, and which ran first in this pair. */
  private sign: 1 | -1 = 1;
  private first: 1 | -1 = 1;
  private firstScore: number | null = null;
  private readonly noise: Float32Array[] = [];
  private readonly scores: number[] = [];

  /** live: the array the car drives with (variations are written into it). */
  constructor(private readonly live: Float32Array, private readonly cfg: OnlineConfig, private readonly rng: Rng) {
    this.weights = live.slice();
    this.m = new Float32Array(live.length);
    this.v = new Float32Array(live.length);
    this.eps = this.newNoise();
    this.startPair();
  }

  /**
   * A lap is over: its score (higher is better), or null if it doesn't count.
   * Returns true when the driver took a learning step.
   */
  lapDone(score: number | null): boolean {
    if (score === null) return false; // same variation again next lap
    if (this.firstScore === null) {
      this.firstScore = score;
      this.sign = this.first === 1 ? -1 : 1;
      this.apply();
      return false;
    }
    const plus = this.first === 1 ? this.firstScore : score;
    const minus = this.first === 1 ? score : this.firstScore;
    this.noise.push(this.eps);
    this.scores.push(plus, minus);
    this.eps = this.newNoise();
    let stepped = false;
    if (this.noise.length >= this.cfg.pairs) {
      const ranks = centeredRanks(this.scores);
      const grad = new Float32Array(this.weights.length);
      this.noise.forEach((e, p) => {
        const w = ranks[2 * p] - ranks[2 * p + 1];
        for (let i = 0; i < grad.length; i++) grad[i] += w * e[i];
      });
      adamStep(this, grad, 1 / (2 * this.noise.length * this.cfg.sigma), this.cfg.learningRate, this.cfg.weightDecay);
      this.updates++;
      this.noise.length = 0;
      this.scores.length = 0;
      stepped = true;
    }
    this.startPair();
    return stepped;
  }

  /** Stop exploring: the car drives with the driver's own weights. */
  finish(): void {
    this.live.set(this.weights);
  }

  private startPair(): void {
    this.first = this.rng.next() < 0.5 ? 1 : -1;
    this.sign = this.first;
    this.firstScore = null;
    this.apply();
  }

  private apply(): void {
    const s = this.sign * this.cfg.sigma;
    for (let i = 0; i < this.live.length; i++) this.live[i] = this.weights[i] + s * this.eps[i];
  }

  private newNoise(): Float32Array {
    const e = new Float32Array(this.weights.length);
    for (let i = 0; i < e.length; i++) e[i] = this.rng.gaussian();
    return e;
  }
}
