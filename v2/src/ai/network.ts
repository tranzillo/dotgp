/** A tiny fully-connected tanh network whose weights are a flat genome. */
export class Network {
  readonly layers: readonly number[];
  readonly weights: Float32Array;
  private readonly acts: Float32Array[];

  constructor(layers: readonly number[], weights: Float32Array) {
    if (weights.length !== genomeSize(layers)) {
      throw new Error(`genome has ${weights.length} weights, expected ${genomeSize(layers)}`);
    }
    this.layers = layers;
    this.weights = weights;
    this.acts = layers.map((n) => new Float32Array(n));
  }

  /** Returns the output activation buffer (reused between calls). */
  forward(input: Float32Array): Float32Array {
    const { layers, weights, acts } = this;
    acts[0].set(input);
    let w = 0;
    for (let l = 1; l < layers.length; l++) {
      const prev = acts[l - 1];
      const out = acts[l];
      const nIn = layers[l - 1];
      for (let o = 0; o < layers[l]; o++) {
        let sum = weights[w++]; // bias
        for (let k = 0; k < nIn; k++) sum += prev[k] * weights[w++];
        out[o] = Math.tanh(sum);
      }
    }
    return acts[layers.length - 1];
  }
}

/**
 * Grow a network without changing what it does. New inputs get zero weights;
 * new hidden neurons get small random incoming weights but zero outgoing
 * weights, so the output is identical until training starts using them.
 * Existing inputs/neurons keep their indices.
 */
export function widenNetwork(
  oldLayers: readonly number[], oldW: Float32Array, newLayers: readonly number[], random: () => number,
): Float32Array {
  if (oldLayers.length !== newLayers.length) throw new Error('depth must match');
  if (oldLayers[oldLayers.length - 1] !== newLayers[newLayers.length - 1]) throw new Error('outputs must match');
  const w = new Float32Array(genomeSize(newLayers));
  let oldOffset = 0, newOffset = 0;
  for (let l = 1; l < newLayers.length; l++) {
    const oIn = oldLayers[l - 1], nIn = newLayers[l - 1];
    for (let o = 0; o < newLayers[l]; o++) {
      const isOld = o < oldLayers[l];
      for (let k = -1; k < nIn; k++) { // k = -1 is the bias
        const dst = newOffset + o * (nIn + 1) + (k + 1);
        if (isOld) {
          w[dst] = k < oIn ? oldW[oldOffset + o * (oIn + 1) + (k + 1)] : 0;
        } else {
          w[dst] = k < 0 ? 0 : (random() * 2 - 1) * 0.1;
        }
      }
    }
    oldOffset += oldLayers[l] * (oIn + 1);
    newOffset += newLayers[l] * (nIn + 1);
  }
  return w;
}

export interface Example {
  x: Float32Array;
  y: Float32Array;
  /** Per-output weight; 0 means "no opinion" for that output. */
  mask: Float32Array;
}

/**
 * Supervised training (backprop, masked MSE, plain SGD) for imitation:
 * e.g. an apprentice crew chief copying a veteran before learning on its own.
 * Trains the weights in place and returns the final mean loss.
 */
export function trainSupervised(
  layers: readonly number[], weights: Float32Array, data: Example[], epochs: number, learningRate: number, random: () => number,
): number {
  const L = layers.length;
  const acts = layers.map((n) => new Float32Array(n));
  const deltas = layers.map((n) => new Float32Array(n));
  const offsets: number[] = [];
  let off = 0;
  for (let l = 1; l < L; l++) { offsets.push(off); off += layers[l] * (layers[l - 1] + 1); }
  const order = data.map((_, i) => i);
  let loss = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    loss = 0;
    for (const idx of order) {
      const ex = data[idx];
      acts[0].set(ex.x);
      // Forward.
      for (let l = 1; l < L; l++) {
        const nIn = layers[l - 1];
        let w = offsets[l - 1];
        for (let o = 0; o < layers[l]; o++) {
          let sum = weights[w++];
          for (let k = 0; k < nIn; k++) sum += acts[l - 1][k] * weights[w++];
          acts[l][o] = Math.tanh(sum);
        }
      }
      // Output error (masked MSE) through tanh'.
      const out = acts[L - 1];
      for (let o = 0; o < layers[L - 1]; o++) {
        const err = (out[o] - ex.y[o]) * ex.mask[o];
        loss += err * err;
        deltas[L - 1][o] = err * (1 - out[o] * out[o]);
      }
      // Backward, updating weights as we go (each layer's deltas use its pre-update weights).
      for (let l = L - 1; l >= 1; l--) {
        const nIn = layers[l - 1];
        const base = offsets[l - 1];
        if (l > 1) {
          deltas[l - 1].fill(0);
          for (let o = 0; o < layers[l]; o++) {
            const row = base + o * (nIn + 1) + 1;
            for (let k = 0; k < nIn; k++) deltas[l - 1][k] += deltas[l][o] * weights[row + k];
          }
          for (let k = 0; k < nIn; k++) deltas[l - 1][k] *= 1 - acts[l - 1][k] * acts[l - 1][k];
        }
        for (let o = 0; o < layers[l]; o++) {
          const row = base + o * (nIn + 1);
          const d = deltas[l][o] * learningRate;
          if (d === 0) continue;
          weights[row] -= d;
          for (let k = 0; k < nIn; k++) weights[row + 1 + k] -= d * acts[l - 1][k];
        }
      }
    }
    loss /= Math.max(1, data.length);
  }
  return loss;
}

export function genomeSize(layers: readonly number[]): number {
  let n = 0;
  for (let l = 1; l < layers.length; l++) n += layers[l] * (layers[l - 1] + 1);
  return n;
}
