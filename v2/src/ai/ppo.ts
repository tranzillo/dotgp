import { Adam, Mlp } from './mlp';
import type { Rng } from './rng';

/**
 * Proximal policy optimisation: a gradient learner that scores every moment,
 * not whole drives. ES compares drives and nudges the weights towards the
 * better ones, so a skill whose first attempts only look worse (braking hard
 * now so the corner goes well a second later) never gets started. Here each
 * request is credited with what followed it (the value estimate carries the
 * rest), so braking can earn its corner.
 *
 * The policy is a driver network as it is: its output is the mean request,
 * and practice adds Gaussian variation around it (one learned spread per
 * output). Racing uses the mean, so a trained policy drives as a genome.
 */
export interface PpoOptions {
  /** Discount per decision (30 a second: 0.999 looks about 30 s ahead, so stopping costs what it would in a drive). */
  gamma: number;
  /** GAE's blend of measured and estimated returns (higher: credit from further ahead, noisier). */
  lambda: number;
  clip: number;
  epochs: number;
  minibatch: number;
  policyLr: number;
  valueLr: number;
  /** Entropy bonus (in normalised advantage units): keeps the variation from collapsing early. */
  entropy: number;
  /** An update stops early once the policy has moved this far (mean KL). */
  targetKl: number;
  maxGradNorm: number;
}

export const DEFAULT_PPO: PpoOptions = {
  gamma: 0.999, lambda: 0.98, clip: 0.2, epochs: 6, minibatch: 512,
  policyLr: 3e-4, valueLr: 1e-3, entropy: 0.001, targetKl: 0.02, maxGradNorm: 0.5,
};

/** One decision: what the driver saw and requested (in its own frame), how likely that was, and what it earned. */
export interface Step {
  x: Float32Array;
  a: Float32Array;
  logp: number;
  v: number;
  /** Reward until the next decision. */
  r: number;
}

/** A run of decisions by one car: to its end (terminal: nothing more to earn) or cut short (the value of where it got to). */
export interface Segment {
  steps: Step[];
  /** Value estimate after the last step: 0 if the drive ended there (a crash, a stall). */
  bootstrap: number;
}

export interface UpdateStats {
  samples: number;
  epochs: number;
  policyLoss: number;
  valueLoss: number;
  kl: number;
  clipFraction: number;
  /** The variation's spread per output. */
  std: number[];
  explainedVariance: number;
}

const LOG_2PI = Math.log(2 * Math.PI);

export class PpoLearner {
  readonly policy: Mlp;
  readonly value: Mlp;
  readonly logStd: Float32Array;
  readonly opts: PpoOptions;
  private readonly policyAdam: Adam;
  private readonly stdAdam: Adam;
  private readonly valueAdam: Adam;
  private readonly trainable?: Float32Array;
  private readonly nOut: number;

  constructor(
    policyLayers: readonly number[], policyWeights: Float32Array, valueLayers: readonly number[], valueWeights: Float32Array,
    opts: Partial<PpoOptions> = {}, initialStd = 0.3,
    /** Policy weights practice may change (1); the rest stay. Default: all. */
    trainable?: Float32Array,
  ) {
    this.policy = new Mlp(policyLayers, policyWeights);
    this.value = new Mlp(valueLayers, valueWeights, true);
    this.nOut = policyLayers[policyLayers.length - 1];
    this.logStd = new Float32Array(this.nOut).fill(Math.log(initialStd));
    this.opts = { ...DEFAULT_PPO, ...opts };
    this.policyAdam = new Adam(policyWeights);
    this.stdAdam = new Adam(this.logStd);
    this.valueAdam = new Adam(valueWeights);
    this.trainable = trainable;
  }

  /** Draw a request for an input: writes it to `a`, returns its log-likelihood and the value estimate. */
  act(x: Float32Array, rng: Rng, a: Float32Array): { logp: number; v: number } {
    const mean = this.policy.forward(x);
    let logp = 0;
    for (let i = 0; i < this.nOut; i++) {
      const std = Math.exp(this.logStd[i]);
      const e = rng.gaussian();
      a[i] = mean[i] + std * e;
      logp += -0.5 * e * e - this.logStd[i] - 0.5 * LOG_2PI;
    }
    return { logp, v: this.value.forward(x)[0] };
  }

  /** The value estimate of an input. */
  estimate(x: Float32Array): number {
    return this.value.forward(x)[0];
  }

  update(segments: Segment[], rng: Rng): UpdateStats {
    const { gamma, lambda, clip, epochs, minibatch, policyLr, valueLr, entropy, targetKl, maxGradNorm } = this.opts;
    // Advantages (GAE) and return targets.
    const steps: Step[] = [];
    const adv: number[] = [];
    const ret: number[] = [];
    for (const seg of segments) {
      const n = seg.steps.length;
      const a = new Array<number>(n);
      let next = seg.bootstrap, gae = 0;
      for (let t = n - 1; t >= 0; t--) {
        const s = seg.steps[t];
        const delta = s.r + gamma * next - s.v;
        gae = delta + gamma * lambda * gae;
        a[t] = gae;
        next = s.v;
      }
      for (let t = 0; t < n; t++) { steps.push(seg.steps[t]); adv.push(a[t]); ret.push(a[t] + seg.steps[t].v); }
    }
    const N = steps.length;
    let mean = 0;
    for (const x of adv) mean += x;
    mean /= N;
    let sd = 0;
    for (const x of adv) sd += (x - mean) ** 2;
    sd = Math.sqrt(sd / N) + 1e-8;
    const nadv = adv.map((x) => (x - mean) / sd);
    // Explained variance of the value estimates before this update (how much of the returns they already foresee).
    let retMean = 0;
    for (const r of ret) retMean += r;
    retMean /= N;
    let varRet = 0, varRes = 0;
    for (let i = 0; i < N; i++) { varRet += (ret[i] - retMean) ** 2; varRes += (ret[i] - steps[i].v) ** 2; }

    const pGrad = new Float32Array(this.policy.weights.length);
    const sGrad = new Float32Array(this.nOut);
    const vGrad = new Float32Array(this.value.weights.length);
    const dMean = new Float32Array(this.nOut);
    const dV = new Float32Array(1);
    const order = steps.map((_, i) => i);
    let policyLoss = 0, valueLoss = 0, kl = 0, clipped = 0, epochsRun = 0;
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let i = N - 1; i > 0; i--) { const j = rng.int(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
      policyLoss = 0; valueLoss = 0; kl = 0; clipped = 0;
      for (let start = 0; start < N; start += minibatch) {
        const end = Math.min(N, start + minibatch), m = end - start;
        pGrad.fill(0); sGrad.fill(0); vGrad.fill(0);
        for (let b = start; b < end; b++) {
          const i = order[b], s = steps[i], A = nadv[i];
          const mu = this.policy.forward(s.x);
          let logp = 0;
          for (let o = 0; o < this.nOut; o++) {
            const z = (s.a[o] - mu[o]) / Math.exp(this.logStd[o]);
            logp += -0.5 * z * z - this.logStd[o] - 0.5 * LOG_2PI;
          }
          const ratio = Math.exp(logp - s.logp);
          kl += s.logp - logp;
          const surr = ratio * A, surrClipped = Math.max(1 - clip, Math.min(1 + clip, ratio)) * A;
          policyLoss -= Math.min(surr, surrClipped);
          // Gradient flows only where the unclipped term is the smaller one.
          const live = surr <= surrClipped;
          if (!live) clipped++;
          const g = live ? -ratio * A / m : 0;
          for (let o = 0; o < this.nOut; o++) {
            const std = Math.exp(this.logStd[o]);
            const z = (s.a[o] - mu[o]) / std;
            dMean[o] = g * z / std;
            sGrad[o] += g * (z * z - 1) - entropy / m;
          }
          if (g !== 0) this.policy.backward(dMean, pGrad);
          const v = this.value.forward(s.x)[0];
          const err = v - ret[i];
          valueLoss += 0.5 * err * err;
          dV[0] = err / m;
          this.value.backward(dV, vGrad);
        }
        clipNorm(pGrad, sGrad, maxGradNorm);
        clipNorm(vGrad, null, maxGradNorm * 10);
        this.policyAdam.step(pGrad, policyLr, this.trainable);
        this.stdAdam.step(sGrad, policyLr);
        this.valueAdam.step(vGrad, valueLr);
      }
      epochsRun++;
      kl /= N;
      if (kl > 1.5 * targetKl) break;
    }
    return {
      samples: N, epochs: epochsRun, policyLoss: policyLoss / N, valueLoss: valueLoss / N, kl,
      clipFraction: clipped / N, std: Array.from(this.logStd, Math.exp),
      explainedVariance: varRet > 0 ? 1 - varRes / varRet : 0,
    };
  }
}

function clipNorm(g: Float32Array, h: Float32Array | null, max: number): void {
  let sq = 0;
  for (const x of g) sq += x * x;
  if (h) for (const x of h) sq += x * x;
  const norm = Math.sqrt(sq);
  if (norm <= max) return;
  const k = max / norm;
  for (let i = 0; i < g.length; i++) g[i] *= k;
  if (h) for (let i = 0; i < h.length; i++) h[i] *= k;
}
