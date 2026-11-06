import { describe, expect, it } from 'vitest';
import { Mlp, randomWeights } from '../src/ai/mlp';
import { Network } from '../src/ai/network';
import { PpoLearner, type Segment } from '../src/ai/ppo';
import { Rng } from '../src/ai/rng';

const LAYERS = [5, 7, 4, 2];

describe('gradient network', () => {
  it('drives as a Network with the same weights (tanh output)', () => {
    const rng = new Rng(3);
    const w = randomWeights(LAYERS, () => rng.gaussian());
    const x = Float32Array.from([0.3, -0.2, 0, 0.9, -1]);
    const a = Array.from(new Mlp(LAYERS, w).forward(x));
    const b = Array.from(new Network(LAYERS, w).forward(x));
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));
  });

  for (const linear of [false, true]) {
    it(`backward matches finite differences (${linear ? 'linear' : 'tanh'} output)`, () => {
      const rng = new Rng(5);
      const w = randomWeights(LAYERS, () => rng.gaussian());
      const net = new Mlp(LAYERS, w, linear);
      const x = Float32Array.from([0.3, -0.2, 0, 0.9, -1]);
      // Loss: 0.5 * |out - y|^2.
      const y = [0.4, -0.7];
      const loss = () => { const o = net.forward(x); return 0.5 * ((o[0] - y[0]) ** 2 + (o[1] - y[1]) ** 2); };
      const o = net.forward(x);
      const grad = new Float32Array(w.length);
      net.backward(Float32Array.from([o[0] - y[0], o[1] - y[1]]), grad);
      const h = 1e-2;
      for (let i = 0; i < w.length; i += 3) {
        const keep = w[i];
        w[i] = keep + h; const up = loss();
        w[i] = keep - h; const down = loss();
        w[i] = keep;
        expect(grad[i]).toBeCloseTo((up - down) / (2 * h), 3);
      }
    });
  }
});

describe('PPO', () => {
  it('learns which request pays in a one-step choice', () => {
    // The input says which way pays: reward is +output 0 when the input is +1, -output 0 when it is -1.
    const rng = new Rng(11);
    const layers = [1, 8, 2], vLayers = [1, 8, 1];
    const learner = new PpoLearner(layers, randomWeights(layers, () => rng.gaussian(), 0.1), vLayers,
      randomWeights(vLayers, () => rng.gaussian(), 0.1), { minibatch: 64, policyLr: 3e-3, valueLr: 3e-3 }, 0.5);
    const a = new Float32Array(2);
    for (let it = 0; it < 60; it++) {
      const segments: Segment[] = [];
      for (let k = 0; k < 256; k++) {
        const x = Float32Array.from([rng.next() < 0.5 ? 1 : -1]);
        const { logp, v } = learner.act(x, rng, a);
        segments.push({ steps: [{ x, a: Float32Array.from(a), logp, v, r: x[0] * a[0] }], bootstrap: 0 });
      }
      learner.update(segments, rng);
    }
    expect(learner.policy.forward(Float32Array.from([1]))[0]).toBeGreaterThan(0.5);
    expect(learner.policy.forward(Float32Array.from([-1]))[0]).toBeLessThan(-0.5);
  });
});
