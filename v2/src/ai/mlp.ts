import { genomeSize } from './network';

/**
 * A fully-connected network with gradients, for gradient-based learning. Its
 * weights are laid out as Network's (per neuron: bias, then its inputs), so a
 * policy trained here is a driver's genome as it is. Hidden layers are tanh;
 * the output is tanh too (a driver's request) or linear (a value estimate).
 */
export class Mlp {
  readonly layers: readonly number[];
  readonly weights: Float32Array;
  private readonly linearOut: boolean;
  private readonly acts: Float32Array[];
  private readonly deltas: Float32Array[];
  private readonly offsets: number[] = [];

  constructor(layers: readonly number[], weights: Float32Array, linearOut = false) {
    if (weights.length !== genomeSize(layers)) throw new Error(`expected ${genomeSize(layers)} weights, got ${weights.length}`);
    this.layers = layers;
    this.weights = weights;
    this.linearOut = linearOut;
    this.acts = layers.map((n) => new Float32Array(n));
    this.deltas = layers.map((n) => new Float32Array(n));
    let off = 0;
    for (let l = 1; l < layers.length; l++) { this.offsets.push(off); off += layers[l] * (layers[l - 1] + 1); }
  }

  /** The output for an input (a buffer reused between calls); backward() then works from this pass. */
  forward(x: Float32Array): Float32Array {
    const { layers, weights, acts } = this;
    const L = layers.length;
    acts[0].set(x);
    for (let l = 1; l < L; l++) {
      const nIn = layers[l - 1], prev = acts[l - 1], out = acts[l];
      const linear = this.linearOut && l === L - 1;
      let w = this.offsets[l - 1];
      for (let o = 0; o < layers[l]; o++) {
        let sum = weights[w++];
        for (let k = 0; k < nIn; k++) { const p = prev[k]; if (p !== 0) sum += p * weights[w + k]; }
        w += nIn;
        out[o] = linear ? sum : Math.tanh(sum);
      }
    }
    return acts[L - 1];
  }

  /**
   * Add to `grad` the gradient of a loss for the last forward pass, given the
   * loss's gradient with respect to the outputs.
   */
  backward(dOut: Float32Array, grad: Float32Array): void {
    const { layers, weights, acts, deltas } = this;
    const L = layers.length;
    const top = deltas[L - 1], out = acts[L - 1];
    for (let o = 0; o < layers[L - 1]; o++) top[o] = this.linearOut ? dOut[o] : dOut[o] * (1 - out[o] * out[o]);
    for (let l = L - 1; l >= 1; l--) {
      const nIn = layers[l - 1], prev = acts[l - 1], delta = deltas[l];
      const base = this.offsets[l - 1];
      const back = l > 1 ? deltas[l - 1] : null;
      back?.fill(0);
      for (let o = 0; o < layers[l]; o++) {
        const d = delta[o];
        if (d === 0) continue;
        const row = base + o * (nIn + 1);
        grad[row] += d;
        for (let k = 0; k < nIn; k++) {
          grad[row + 1 + k] += d * prev[k];
          if (back) back[k] += d * weights[row + 1 + k];
        }
      }
      if (back) for (let k = 0; k < nIn; k++) back[k] *= 1 - prev[k] * prev[k];
    }
  }
}

/** Small random weights for a new network (scaled to each layer's inputs; zero biases). */
export function randomWeights(layers: readonly number[], gaussian: () => number, outputScale = 1): Float32Array {
  const w = new Float32Array(genomeSize(layers));
  let off = 0;
  for (let l = 1; l < layers.length; l++) {
    const nIn = layers[l - 1];
    const scale = (l === layers.length - 1 ? outputScale : 1) / Math.sqrt(nIn);
    for (let o = 0; o < layers[l]; o++) {
      off++; // bias
      for (let k = 0; k < nIn; k++) w[off++] = gaussian() * scale;
    }
  }
  return w;
}

/** Adam for gradient descent on a loss (the ES optimiser ascends on a score). */
export class Adam {
  private readonly m: Float32Array;
  private readonly v: Float32Array;
  private t = 0;

  constructor(readonly weights: Float32Array, private readonly b1 = 0.9, private readonly b2 = 0.999) {
    this.m = new Float32Array(weights.length);
    this.v = new Float32Array(weights.length);
  }

  /** One step down `grad`, only on the weights `trainable` marks (1), if given. */
  step(grad: Float32Array, learningRate: number, trainable?: Float32Array): void {
    const t = ++this.t;
    const c1 = 1 - this.b1 ** t, c2 = 1 - this.b2 ** t;
    const { weights: w, m, v, b1, b2 } = this;
    for (let i = 0; i < w.length; i++) {
      if (trainable && !trainable[i]) continue;
      const g = grad[i];
      m[i] = b1 * m[i] + (1 - b1) * g;
      v[i] = b2 * v[i] + (1 - b2) * g * g;
      w[i] -= (learningRate * (m[i] / c1)) / (Math.sqrt(v[i] / c2) + 1e-8);
    }
  }
}
